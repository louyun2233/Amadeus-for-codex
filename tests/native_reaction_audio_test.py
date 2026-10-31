"""Reaction preparation must preserve voice identity without delayed playback."""

import sys
import copy
import io
import struct
import unittest
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "native"))
from reaction_audio import MAX_BYTES, MAX_LINES, ReactionAudioCache, leading_silence_ms


VOICE = {"enabled": True, "provider": "qwen-local", "name": "test-clone"}
LINE = {"text": "test reaction", "emotion": "happy"}


class LeadingSilenceTests(unittest.TestCase):
    @staticmethod
    def wav(signal_at, channels=1, signal_channel=0, amplitude=64, duration=1600):
        # 1 kHz means each frame corresponds to exactly one millisecond.
        samples = [0] * (duration * channels)
        if signal_at is not None:
            samples[signal_at * channels + signal_channel] = amplitude
        stream = io.BytesIO()
        with wave.open(stream, "wb") as out:
            out.setnchannels(channels)
            out.setsampwidth(2)
            out.setframerate(1000)
            out.writeframes(struct.pack("<" + "h" * len(samples), *samples))
        return stream.getvalue()

    def test_preserves_100ms_before_signal_without_modifying_bytes(self):
        audio = self.wav(250)
        original = bytes(bytearray(audio))
        self.assertEqual(leading_silence_ms(audio), 150)
        self.assertEqual(audio, original)
        self.assertEqual(leading_silence_ms(self.wav(199)), 0)
        self.assertEqual(leading_silence_ms(self.wav(200)), 100)
        self.assertEqual(leading_silence_ms(self.wav(1500)), 1000)

    def test_either_stereo_channel_prevents_cutting_early_speech(self):
        self.assertEqual(leading_silence_ms(self.wav(250, channels=2, signal_channel=1)), 150)
        self.assertEqual(leading_silence_ms(self.wav(20, channels=2, signal_channel=1)), 0)
        self.assertEqual(leading_silence_ms(self.wav(20, channels=2, signal_channel=0)), 0)

    def test_soft_early_signal_and_all_silence_are_not_skipped(self):
        self.assertEqual(leading_silence_ms(self.wav(10, amplitude=17)), 0)
        self.assertEqual(leading_silence_ms(self.wav(10, amplitude=-17)), 0)
        self.assertEqual(leading_silence_ms(self.wav(None)), 0)
        self.assertEqual(leading_silence_ms(self.wav(250, amplitude=16)), 0)

    def test_rejects_malformed_streaming_and_unsupported_formats(self):
        valid = self.wav(250)
        invalid = [b"", b"not audio", None, valid[:40], valid[:-1],
                   valid[:4] + b"\xff" * 4 + valid[8:],
                   valid[:40] + b"\xff" * 4 + valid[44:]]
        for position, value, width in ((20, 3, 2), (22, 0, 2), (24, 0, 4),
                                       (28, 1, 4), (32, 4, 2), (34, 8, 2)):
            invalid.append(valid[:position] + value.to_bytes(width, "little") + valid[position + width:])
        for audio in invalid:
            with self.subTest(audio=repr(audio)[:40]):
                self.assertEqual(leading_silence_ms(audio), 0)


class ReactionAudioTests(unittest.TestCase):
    def cache(self, **kwargs):
        cache = ReactionAudioCache(**kwargs)
        cache.configure(VOICE, [LINE])
        return cache

    def test_prepared_audio_is_byte_identical_and_shared_across_expressions(self):
        cache = self.cache()
        audio = b"original WAV samples"
        self.assertTrue(cache.store(cache.signature, LINE, audio, "audio/wav"))
        ready = cache.ready({**LINE, "emotion": "annoyed"})
        self.assertIs(ready[0], audio)
        self.assertEqual(ready[1], "audio/wav")
        self.assertIsNone(cache.next_line(100))
        self.assertFalse(cache.configure(dict(VOICE), [LINE]))
        self.assertIs(cache.ready(LINE)[0], audio)

    def test_changed_voice_or_text_rejects_old_inflight_result(self):
        for change in ({"name": "other-clone"}, {"localModel": "other-model"},
                       {"rate": "+5%"}, {"pitch": "+1Hz"}, {"enabled": False},
                       {"provider": "edge"}):
            with self.subTest(change=change):
                cache = self.cache()
                old = cache.signature
                cache.store(old, LINE, b"old", "audio/wav")
                self.assertTrue(cache.configure({**VOICE, **change}, [LINE]))
                self.assertIsNone(cache.ready(LINE))
                self.assertFalse(cache.store(old, LINE, b"late", "audio/wav"))
        cache = self.cache()
        old = cache.signature
        self.assertTrue(cache.configure(VOICE, [{"text": "new reaction"}]))
        self.assertFalse(cache.store(old, LINE, b"late", "audio/wav"))

    def test_nonlocal_or_muted_voice_never_requests_warmup(self):
        for voice in ({**VOICE, "enabled": False}, {**VOICE, "provider": "edge"},
                      {**VOICE, "provider": "none"}, {}):
            cache = ReactionAudioCache()
            cache.configure(voice, [LINE])
            self.assertFalse(cache.enabled)
            self.assertIsNone(cache.next_line(0))
            self.assertFalse(cache.store(cache.signature, LINE, b"data", "audio/wav"))

    def test_retry_backoff_allows_other_lines_and_is_bounded(self):
        cache = self.cache()
        other = {"text": "another reaction"}
        cache.configure(VOICE, [LINE, other])
        cache.failed(cache.signature, LINE, 10)
        self.assertEqual(cache.next_line(39)["text"], other["text"])
        self.assertEqual(cache.next_line(40)["text"], LINE["text"])
        cache.failed(cache.signature, LINE, 40)
        self.assertEqual(cache.next_line(99)["text"], other["text"])
        self.assertEqual(cache.next_line(100)["text"], LINE["text"])
        cache.failed(cache.signature, LINE, 100)
        cache.failed(cache.signature, LINE, 220)
        self.assertEqual(cache.next_line(339)["text"], other["text"])
        self.assertEqual(cache.next_line(340)["text"], LINE["text"])
        cache.store(cache.signature, LINE, b"ready", "audio/wav")
        cache.failed(cache.signature, LINE, 350)
        self.assertEqual(cache.ready(LINE)[0], b"ready")

    def test_stale_failure_cannot_delay_new_configuration(self):
        cache = self.cache()
        old = cache.signature
        cache.configure({**VOICE, "name": "new-clone"}, [LINE])
        cache.failed(old, LINE, 100)
        self.assertEqual(cache.next_line(0)["text"], LINE["text"])

    def test_duplicate_emotions_and_invalid_lines_do_not_expand_warmup(self):
        cache = ReactionAudioCache()
        cache.configure(VOICE, [None, {}, {"text": " "}, {"text": 4},
                                {"text": "a" * 301}, LINE,
                                {**LINE, "text": " test reaction ", "emotion": "sad"}])
        prepared = cache.next_line(0)
        self.assertEqual(prepared, {"text": LINE["text"], "emotion": "neutral"})
        prepared["text"] = "must not mutate cache"
        self.assertEqual(cache.next_line(0)["text"], LINE["text"])
        cache.store(cache.signature, LINE, b"unchanged", "audio/wav")
        self.assertIsNone(cache.next_line(0))

    def test_memory_budget_skips_oversized_lines_without_eviction_loop(self):
        cache = ReactionAudioCache(max_bytes=6)
        first, second, third = [{"text": text} for text in ("one", "two", "three")]
        cache.configure(VOICE, [first, second, third])
        self.assertTrue(cache.store(cache.signature, first, b"1234", "audio/wav"))
        self.assertFalse(cache.store(cache.signature, second, b"567", "audio/wav"))
        self.assertEqual(cache.next_line(0)["text"], third["text"])
        self.assertTrue(cache.store(cache.signature, third, b"56", "audio/wav"))
        self.assertIsNone(cache.next_line(0))
        self.assertEqual(cache.ready(first)[0], b"1234")
        self.assertIsNone(cache.ready(second))

    def test_line_budget_and_invalid_results_are_bounded(self):
        cache = ReactionAudioCache(max_lines=32)
        lines = [{"text": str(n)} for n in range(40)]
        cache.configure(VOICE, lines)
        for line in lines[:32]:
            self.assertTrue(cache.store(cache.signature, line, b"data", "audio/wav"))
        self.assertFalse(cache.store(cache.signature, lines[32], b"data", "audio/wav"))
        self.assertIsNone(cache.next_line(0))
        self.assertFalse(cache.store(cache.signature, lines[0], b"", "audio/wav"))
        self.assertFalse(cache.store(cache.signature, lines[0], b"{}", "application/json"))
        self.assertFalse(cache.store(cache.signature, lines[0], bytearray(b"mutable"), "audio/wav"))

    @staticmethod
    def expanded_lines():
        # Deliberately group the source by gesture and by emotion. Loading it
        # in source order would leave three gestures without sound for ages.
        return [{"text": f"{gesture}-{emotion}-{index}", "emotion": emotion,
                 "gestures": [gesture]}
                for gesture in ("head", "body", "swipe", "pat")
                for emotion in ("soft", "blush", "question")
                for index in range(6)]

    def test_all_72_reactions_fit_without_changing_voice_or_audio(self):
        voice = {**VOICE, "rate": "+0%", "pitch": "+0Hz", "stability": True}
        lines = self.expanded_lines()
        before = copy.deepcopy((voice, lines))
        cache = ReactionAudioCache()
        cache.configure(voice, lines)
        stream = io.BytesIO()
        with wave.open(stream, "wb") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(24000)
            # Eight seconds per clip exceeds the former 16 MiB budget at 72.
            out.writeframes(b"\x40\x00" * (24000 * 8))
        audio = stream.getvalue()
        texts = set()
        while (line := cache.next_line(0)) is not None:
            self.assertEqual(line["emotion"], "neutral")
            self.assertNotIn(line["text"], texts)
            texts.add(line["text"])
            self.assertTrue(cache.store(cache.signature, line, audio, "audio/wav"))
        self.assertEqual(len(texts), 72)
        for line in lines:
            self.assertIs(cache.ready(line)[0], audio)
        self.assertEqual((voice, lines), before)
        self.assertLessEqual(cache._bytes, MAX_BYTES)

    def test_warmup_covers_gestures_then_emotions_before_duplicate_variants(self):
        cache = ReactionAudioCache()
        lines = self.expanded_lines()
        lookup = {line["text"]: line for line in lines}
        cache.configure(VOICE, lines)
        early = []
        for _ in range(12):
            line = cache.next_line(0)
            early.append(lookup[line["text"]])
            cache.store(cache.signature, line, b"original", "audio/wav")
        self.assertEqual({line["gestures"][0] for line in early[:4]},
                         {"head", "body", "swipe", "pat"})
        for gesture in ("head", "body", "swipe", "pat"):
            self.assertEqual({line["emotion"] for line in early if gesture in line["gestures"]},
                             {"soft", "blush", "question"})

    def test_default_capacity_is_bounded_and_smaller_limits_keep_coverage(self):
        cache = ReactionAudioCache(max_lines=10000, max_bytes=10 ** 12)
        self.assertEqual(cache.max_lines, MAX_LINES)
        self.assertEqual(cache.max_bytes, MAX_BYTES)
        lines = [{"text": str(index)} for index in range(MAX_LINES + 1)]
        cache.configure(VOICE, lines)
        for line in lines[:MAX_LINES]:
            self.assertTrue(cache.store(cache.signature, line, b"original", "audio/wav"))
        self.assertFalse(cache.store(cache.signature, lines[-1], b"original", "audio/wav"))
        self.assertIsNone(cache.next_line(0))
        cache = ReactionAudioCache(max_lines=4)
        cache.configure(VOICE, self.expanded_lines())
        prepared = []
        while (line := cache.next_line(0)) is not None:
            prepared.append(line["text"].split("-", 1)[0])
            cache.store(cache.signature, line, b"original", "audio/wav")
        self.assertEqual(set(prepared), {"head", "body", "swipe", "pat"})


if __name__ == "__main__":
    unittest.main()
