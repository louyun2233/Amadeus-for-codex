"""Exercise media cancellation/progress using a fake Windows driver, no sound."""
import itertools
import os
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import Mock, patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "native"))
import panel as p


class NativeAudioTests(unittest.TestCase):
    def setUp(self):
        self.bridge = Mock()
        self.audio = p.MciAudio(self.bridge)
        self.commands = []
        self.position = 0
        self.item = {"kind": "tap"}

    def driver(self, frames):
        frames = iter(frames)
        def command(value):
            self.commands.append(value)
            if value.endswith(" length"):
                return "1000"
            if value.endswith(" mode"):
                mode, self.position = next(frames)
                return mode
            if value.endswith(" position"):
                return str(self.position)
            return ""
        self.audio._command = command

    def test_complete_clip_is_played_once_and_releases_device(self):
        self.driver([("playing", 500), ("stopped", 1000)])
        self.audio.play("voice", b"unchanged payload", ".mp3", item=self.item)
        self.assertEqual(sum(value.startswith("play ") for value in self.commands), 1)
        self.assertTrue(any("time format milliseconds" in value for value in self.commands))
        self.bridge.audio_started.emit.assert_called_once_with(self.item)
        self.bridge.audio_done.emit.assert_called_once_with(self.item, None)
        self.assertEqual(self.audio.active, {})
        self.assertTrue(self.commands[-1].startswith("close "))

    def test_stalled_playing_or_paused_device_finishes_with_error_without_replay(self):
        for mode in ("playing", "paused"):
            with self.subTest(mode=mode):
                self.setUp()
                self.driver(itertools.repeat((mode, 100)))
                clock = itertools.count(0, 1.1)
                with patch.object(p.time, "monotonic", side_effect=lambda: next(clock)):
                    self.audio.play("voice", b"payload", ".mp3", item=self.item)
                error = self.bridge.audio_done.emit.call_args.args[1]
                self.assertIn("播放停滞", error)
                self.assertEqual(sum(value.startswith("play ") for value in self.commands), 1)
                self.assertEqual(self.audio.active, {})
                self.assertTrue(self.commands[-1].startswith("close "))

    def test_early_stop_is_not_reported_as_success(self):
        self.driver([("stopped", 300)])
        self.audio.play("voice", b"payload", ".mp3", item=self.item)
        self.assertIn("播放完毕前中断", self.bridge.audio_done.emit.call_args.args[1])

    def test_gui_stop_only_signals_worker_without_waiting(self):
        state = {"stop": threading.Event(), "done": Mock(), "owner": -1}
        self.audio.active["voice"] = state
        self.audio.stop("voice")
        self.assertTrue(state["stop"].is_set())
        state["done"].wait.assert_not_called()

    def test_unreleased_previous_device_cannot_overlap_with_new_clip(self):
        state = {"stop": threading.Event(), "done": Mock(), "owner": -1}
        state["done"].wait.return_value = False
        self.audio.active["voice"] = state
        self.driver([])
        self.audio.play("voice", b"payload", ".mp3", item=self.item)
        self.assertEqual(self.commands, [])
        self.assertIn("未能释放", self.bridge.audio_done.emit.call_args.args[1])
        self.bridge.audio_started.emit.assert_not_called()

    def test_stop_during_slow_open_is_nonblocking_and_prevents_play(self):
        entered, release = threading.Event(), threading.Event()
        def command(value):
            self.commands.append(value)
            if value.startswith("open "):
                entered.set()
                self.assertTrue(release.wait(2))
            return ""
        self.audio._command = command
        worker = threading.Thread(target=lambda: self.audio.play("voice", b"payload", ".mp3", item=self.item))
        worker.start()
        try:
            self.assertTrue(entered.wait(2))
            stopped = threading.Event()
            stopper = threading.Thread(target=lambda: (self.audio.stop("voice"), stopped.set()))
            stopper.start()
            self.assertTrue(stopped.wait(.5), "stop must not hold the media driver's lock")
        finally:
            release.set()
            worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertFalse(any(value.startswith("play ") for value in self.commands))
        self.assertTrue(self.commands[-1].startswith("close "))

    def test_cancel_signal_stops_ring_without_restarting_it(self):
        cancel = threading.Event()
        self.driver([("stopped", 1000)])
        original = self.audio._command
        def command(value):
            result = original(value)
            if value.startswith("play "):
                cancel.set()
            return result
        self.audio._command = command
        self.audio.play("ring", b"payload", ".mp3", loop=True, cancel_event=cancel)
        self.assertEqual(sum(value.startswith("play ") for value in self.commands), 1)
        self.assertEqual(self.audio.active, {})


if __name__ == "__main__":
    unittest.main()
