"""Bounded, in-memory audio for fixed reactions; scheduling and IO belong to Qt."""

import hashlib
import json
import struct
from collections import deque


MAX_LINES = 96
MAX_BYTES = 48 * 1024 * 1024
DEFAULT_MODEL = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"


def _balanced_lines(lines):
    """Interleave gestures, then emotions, so every action gets a clip early.

    Only scheduling uses the labels. Synthesis still receives neutral emotion
    and the original text; a shared line is prepared once for all its gestures.
    """
    groups = {}
    seen = set()
    for line in lines if isinstance(lines, (list, tuple)) else []:
        key = ReactionAudioCache._key(line)
        if not key or key in seen:
            continue
        seen.add(key)
        gestures = line.get("gestures")
        gesture = next((g for g in gestures if g in ("head", "body", "swipe", "pat")), "") \
            if isinstance(gestures, (list, tuple)) else ""
        emotion = line.get("emotion")
        emotion = emotion if isinstance(emotion, str) else "neutral"
        groups.setdefault(gesture, {}).setdefault(emotion, deque()).append(key)
    pending = deque(deque(group.values()) for group in groups.values())
    while pending:
        group = pending.popleft()
        emotion_lines = group.popleft()
        yield emotion_lines.popleft()
        if emotion_lines:
            group.append(emotion_lines)
        if group:
            pending.append(group)


def leading_silence_ms(data):
    """Return a conservative PCM16 WAV seek offset, without changing samples.

    Only digital near-silence (all channels at or below 16 / 32768) is skipped.
    Preserve 100 ms before the earliest signal and skip nothing when fewer than
    200 ms are quiet. Unsupported, malformed and entirely silent files use the
    normal playback path. Streaming RIFF lengths must be normalized beforehand.
    """
    if (not isinstance(data, bytes) or len(data) < 44 or data[:4] != b"RIFF"
            or data[8:12] != b"WAVE"):
        return 0
    end = int.from_bytes(data[4:8], "little") + 8
    if end < 44 or end > len(data):
        return 0
    offset, audio_format, samples = 12, None, None
    while offset + 8 <= end:
        chunk = data[offset:offset + 4]
        size = int.from_bytes(data[offset + 4:offset + 8], "little")
        start = offset + 8
        if start + size > end:
            return 0
        if chunk == b"fmt ":
            if size < 16 or audio_format is not None:
                return 0
            audio_format = struct.unpack_from("<HHIIHH", data, start)
        elif chunk == b"data":
            if samples is not None:
                return 0
            samples = memoryview(data)[start:start + size]
        offset = start + size + (size & 1)
    if offset != end or audio_format is None or samples is None:
        return 0
    encoding, channels, rate, byte_rate, alignment, bits = audio_format
    if (encoding != 1 or bits != 16 or not 1 <= channels <= 32
            or not 1 <= rate <= 384000 or alignment != channels * 2
            or byte_rate != rate * alignment or len(samples) % alignment):
        return 0
    for index, (sample,) in enumerate(struct.iter_unpack("<h", samples)):
        if abs(sample) > 16:
            quiet_ms = (index // channels) * 1000 // rate
            return min(1000, quiet_ms - 100) if quiet_ms >= 200 else 0
    return 0


class ReactionAudioCache:
    """Keep the original clone bytes and ignore facial emotion in audio identity.

    Callers serialize warm-up requests and pass ``signature`` back with results.
    Failed requests back off for 30, 60, then at most 120 seconds. A line that
    cannot fit in the fixed memory budget is skipped until reconfiguration,
    rather than endlessly evicting and regenerating other reaction lines.
    """

    def __init__(self, max_bytes=MAX_BYTES, max_lines=MAX_LINES):
        self.max_bytes = max(1, min(MAX_BYTES, int(max_bytes)))
        self.max_lines = max(1, min(MAX_LINES, int(max_lines)))
        self.signature = ""
        self.enabled = False
        self._lines = {}
        self._audio = {}
        self._retry = {}
        self._blocked = set()
        self._bytes = 0

    @staticmethod
    def _key(line):
        if not isinstance(line, dict) or not isinstance(line.get("text"), str):
            return None
        text = line["text"].strip()
        return text if 0 < len(text) <= 300 else None

    def configure(self, voice, lines):
        """Return whether the synthesis identity or fixed text list changed."""
        voice = voice if isinstance(voice, dict) else {}
        selected = {
            "enabled": voice.get("enabled") is True,
            "provider": voice.get("provider"),
            "name": voice.get("name") or "",
            "localModel": voice.get("localModel") or DEFAULT_MODEL,
            "rate": voice.get("rate") or "+0%",
            "pitch": voice.get("pitch") or "+0Hz",
            "stability": voice.get("stability", True),
            "emotionIntensity": voice.get("emotionIntensity", 1),
        }
        valid = {}
        for key in _balanced_lines(lines):
            # The local Base clone ignores emotion; faces may still vary.
            valid[key] = {"text": key, "emotion": "neutral"}
            if len(valid) >= self.max_lines:
                break
        identity = json.dumps([selected, list(valid)], ensure_ascii=False,
                              sort_keys=True, separators=(",", ":"))
        signature = hashlib.sha256(identity.encode("utf-8")).hexdigest()
        if signature == self.signature:
            return False
        self.signature = signature
        self.enabled = selected["enabled"] and selected["provider"] == "qwen-local"
        self._lines = valid
        self._audio.clear()
        self._retry.clear()
        self._blocked.clear()
        self._bytes = 0
        return True

    def ready(self, line):
        """Return the unchanged bytes and MIME, or None if not prepared."""
        return self._audio.get(self._key(line)) if self.enabled else None

    def next_line(self, now):
        """Return one eligible line; the caller owns in-flight serialization."""
        if not self.enabled:
            return None
        for key, line in self._lines.items():
            if key in self._audio or key in self._blocked:
                continue
            if now < self._retry.get(key, (0, 0))[1]:
                continue
            return dict(line)
        return None

    def store(self, signature, line, audio, mime):
        key = self._key(line)
        if (not self.enabled or signature != self.signature or key not in self._lines
                or not isinstance(audio, bytes) or not audio
                or not isinstance(mime, str) or not mime.lower().startswith("audio/")):
            return False
        previous = self._audio.get(key)
        size = self._bytes - (len(previous[0]) if previous else 0) + len(audio)
        if size > self.max_bytes:
            self._blocked.add(key)
            return False
        self._audio[key] = (audio, mime)
        self._bytes = size
        self._retry.pop(key, None)
        self._blocked.discard(key)
        return True

    def failed(self, signature, line, now):
        key = self._key(line)
        if (not self.enabled or signature != self.signature
                or key not in self._lines or key in self._audio):
            return
        attempts = min(3, self._retry.get(key, (0, 0))[0] + 1)
        self._retry[key] = (attempts, now + 30 * 2 ** (attempts - 1))
