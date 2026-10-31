"""Native regressions with synthetic data; no daemon, microphone or audio playback."""
import os
import sys
import time
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "native"))
from PySide6.QtCore import Signal, QPoint, QPointF, Qt
from PySide6.QtGui import QWheelEvent
from PySide6.QtWidgets import QApplication, QWidget
from PySide6.QtTest import QTest
import panel as p


class FakeAvatar(QWidget):
    tapped = Signal(str)
    gl_initialized = Signal()
    affect_changed = Signal(str, str)
    gl_ready = False
    talking = False
    interaction_emotion = "question"

    def emotion(self, value):
        self.last_emotion = value

    def set_activity(self, value):
        self.activity = value

    def set_speaking(self, active):
        self.talking = active

    def reaction(self, value):
        self.last_emotion = value


class FakeAudio:
    def __init__(self, bridge):
        self.played = []
        self.stopped = []

    def stop(self, lane):
        self.stopped.append(lane)

    def play(self, *args, **kwargs):
        self.played.append((args, kwargs))


class NativePanelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.patches = [patch.object(p, "Live2DView", FakeAvatar),
                        patch.object(p, "MciAudio", FakeAudio),
                        patch.object(p.EventReader, "start", lambda self: None),
                        patch.object(p.Panel, "call", self.capture_call)]
        self.calls = []
        for item in self.patches:
            item.start()
        self.window = p.Panel(SimpleNamespace(welcome=True, client="native-test",
                                              request=lambda *a, **kw: (b"audio", "audio/wav")))
        self.window.splash.stop()
        self.window._finish_boot()
        self.calls.clear()

    def capture_call(self, *args, **kwargs):
        self.calls.append((args, kwargs))

    def tearDown(self):
        self.window.close()
        self.window.deleteLater()
        self.app.processEvents()
        for item in reversed(self.patches):
            item.stop()

    def test_long_message_wraps_without_interpreting_html(self):
        raw = "<b>literal markup</b> " + "long_filename_" * 45
        text = p.MessageText(raw)
        text.resize(180, 20)
        text.show()
        QTest.qWait(80)
        self.assertEqual(text.toPlainText(), raw)
        self.assertIn("&lt;b&gt;", text.document().toHtml())
        self.assertEqual(text.horizontalScrollBar().maximum(), 0)
        self.assertGreater(text.height(), 100)
        text.close()

    def test_memory_wraps_and_memory_event_refreshes_visible_list(self):
        self.window.resize(270, 468)
        self.window.tabs.setCurrentIndex(1)
        self.window._on_result("memory", {"entries": [{"content": "长期偏好和持续研究项目" * 24}]})
        self.window.show()
        QTest.qWait(80)
        self.assertEqual(self.window.memory_list.horizontalScrollBar().maximum(), 0)
        self.assertGreater(self.window.memory_list.visualItemRect(self.window.memory_list.item(0)).height(), 30)
        self.calls.clear()
        self.window._on_event("memory", {})
        self.assertEqual([c[0][0] for c in self.calls], ["memory", "status"])

    def test_poll_recovers_lost_completion_once(self):
        self.window.input.setText("测试回复")
        self.window.send()
        self.assertTrue(self.window.welcome_cancelled)
        self.window._on_result("chat", {"turnId": "t1", "sessionId": "s1"})
        self.window.check_turn()
        self.assertTrue(any(c[0][0] == "turn_state" for c in self.calls))
        self.window._on_result("turn_state", {"turn": {
            "id": "t1", "sessionId": "s1", "status": "done", "closed": True,
            "result": {"zh": "已收到测试", "emotion": "neutral"},
        }})
        self.assertFalse(self.window.pending_turn)
        self.assertIsNone(self.window.session_id)
        count = self.window.history.items.count()
        self.window._on_event("turn:done", {"turnId": "t1", "zh": "已收到测试"})
        self.assertEqual(self.window.history.items.count(), count)

    def test_cancel_before_turn_id_is_delivered_after_acceptance(self):
        self.window.input.setText("测试取消")
        self.window.send()
        self.window.send()
        self.window._on_result("chat", {"turnId": "t-cancel", "sessionId": "s1"})
        self.assertTrue(any(c[0][0] == "cancel" and c[0][3]["turnId"] == "t-cancel" for c in self.calls))

    def test_late_startup_sessions_do_not_erase_sent_message(self):
        self.window.input.setText("刚启动时发出的消息")
        self.window.send()
        count = self.window.history.items.count()
        self.window._on_result("sessions", {"sessions": []})
        self.assertEqual(self.window.history.items.count(), count)
        self.assertTrue(self.window.pending_turn)
        self.assertFalse(any(c[0][0] == "new_session" for c in self.calls))

    def test_oneshot_startup_does_not_create_empty_session(self):
        self.window.config = {"chat": {"oneshot": True}}
        self.window._on_result("sessions", {"sessions": [{"id": "older"}]})
        self.assertIsNone(self.window.session_id)
        self.assertFalse(any(c[0][0] in ("history", "new_session") for c in self.calls))

    def test_timeout_releases_send_control(self):
        self.window.input.setText("测试超时")
        self.window.send()
        self.window.turn_started_at = time.monotonic() - 76
        self.window.check_turn()
        self.assertFalse(self.window.pending_turn)
        self.assertFalse(self.window.turn_timer.isActive())
        self.assertEqual(self.window.send_button.accessibleName(), "发送")

    def test_failed_submission_restores_text_and_attachment(self):
        self.window.input.setText("尚未发出的内容")
        self.window.attachment = {"mime": "image/png", "data": "synthetic"}
        self.window.send()
        self.window._on_failed("chat", "HTTP 503")
        self.assertEqual(self.window.input.text(), "尚未发出的内容")
        self.assertEqual(self.window.attachment["data"], "synthetic")
        self.assertFalse(self.window.pending_turn)

    def test_late_welcome_does_not_interrupt_chat(self):
        self.window.welcome_line = {"text": "synthetic greeting"}
        self.window.welcome_cancelled = True
        self.window._on_result("welcome_prepare", {"ready": True})
        self.assertFalse(any(c[0][0] == "welcome_say" for c in self.calls))

    def test_clearing_audio_invalidates_inflight_synthesis(self):
        jobs = []
        self.window.pool.shutdown(wait=False)
        self.window.pool = SimpleNamespace(submit=lambda fn, *a: jobs.append(lambda: fn(*a)),
                                           shutdown=lambda **kw: None)
        self.window.audio_queue.append({"id": 1, "text": "synthetic", "kind": "say"})
        self.window._next_audio()
        self.window._on_event("cleared", {})
        jobs[0]()
        self.assertFalse(self.window.audio_busy)
        self.assertEqual(self.window.audio.played, [])

    def test_status_keeps_unsaved_setting_and_updates_controls(self):
        self.window.voice_name.setText("unsaved")
        self.window.voice_name.setModified(True)
        self.window._on_result("status", {
            "config": {"voice": {"provider": "qwen-local", "name": "saved", "ringVolume": 0.4},
                       "memory": {"enabled": True}, "permissions": {"preauthorizeSay": True}},
        })
        self.assertEqual(self.window.voice_name.text(), "unsaved")
        self.assertEqual(self.window.ring_volume.value(), 40)
        self.assertTrue(self.window.say_permission.isChecked())
        self.assertFalse(self.window.system_tts.isEnabled())

    def test_chat_thinks_then_expresses_reply_without_voice(self):
        self.window.config = {"voice": {"enabled": False}}
        self.window.input.setText("测试情绪")
        self.window.send()
        self.assertEqual(self.window.avatar.activity, "thinking")
        self.window._on_result("chat", {"turnId": "emotion-test", "sessionId": "s1"})
        self.window._on_event("turn:done", {"turnId": "emotion-test", "zh": "测试答复", "emotion": "happy"})
        self.assertEqual(self.window.avatar.last_emotion, "happy")
        self.window._next_audio()
        self.assertEqual(self.window.avatar.last_emotion, "happy", "empty voice queue must not erase the face")

    def test_typing_feedback_expires_and_cannot_replace_pending_thought(self):
        self.window._on_composing("输入中")
        self.assertEqual(self.window.avatar.activity, "listening")
        self.window._finish_composing()
        self.assertEqual(self.window.avatar.activity, "idle")
        self.window.input.setText("开始思考")
        self.window.send()
        self.window._finish_composing()
        self.assertEqual(self.window.avatar.activity, "thinking")

    def test_silent_tap_has_caption_and_scoped_emotion_without_tts(self):
        self.window.config = {"voice": {"enabled": False}}
        self.window.character_content = {"tapReactions": [
            {"text": "synthetic-head", "cn": "头部反应", "emotion": "blush", "gestures": ["head"]},
            {"text": "synthetic-pat", "cn": "轻抚反应", "emotion": "soft", "gestures": ["pat"]},
        ]}
        self.window.avatar.interaction_kind = "pat"
        self.window._on_avatar_tap("head")
        self.assertEqual(self.window.reaction_caption.text(), "轻抚反应")
        self.assertEqual(self.window.avatar.last_emotion, "soft")
        self.assertFalse(any(c[0][0] == "tap_say" for c in self.calls))

    def test_scrolling_closed_voice_selector_cannot_switch_speaker(self):
        combo = self.window.provider
        combo.setCurrentText("qwen-local")
        event = QWheelEvent(QPointF(combo.rect().center()), QPointF(100, 100),
                            QPoint(0, 0), QPoint(0, -120), Qt.MouseButton.NoButton,
                            Qt.KeyboardModifier.NoModifier, Qt.ScrollPhase.NoScrollPhase, False)
        QApplication.sendEvent(combo, event)
        self.assertEqual(combo.currentText(), "qwen-local")
        self.assertFalse(any(c[0][0] == "config" for c in self.calls))

    def test_tap_draws_cover_each_emotion_before_repeating_in_each_gesture(self):
        lines = [{"text": f"{gesture}-{emotion}", "cn": f"{gesture}-{emotion}",
                  "emotion": emotion, "gestures": [gesture]}
                 for gesture in ("head", "body", "swipe", "pat")
                 for emotion in p.EMOTION_LABELS]
        self.window.config = {"voice": {"enabled": False}}
        self.window.character_content = {"tapReactions": lines}
        with patch.object(p.random, "choice", side_effect=lambda choices: choices[-1]):
            for gesture in ("head", "body", "swipe", "pat"):
                self.window.avatar.interaction_kind = gesture
                previous = None
                for _ in range(2):
                    seen = set()
                    for _ in p.EMOTION_LABELS:
                        self.window._on_avatar_tap("head" if gesture == "pat" else gesture)
                        text = self.window.reaction_caption.text()
                        self.assertTrue(text.startswith(gesture + "-"))
                        self.assertNotEqual(text, previous)
                        self.assertNotIn(text, seen)
                        seen.add(text)
                        self.assertEqual(self.window.avatar.last_emotion, text.split("-", 1)[1])
                        previous = text
                    self.assertEqual(len(seen), len(p.EMOTION_LABELS))

    def test_tap_uses_random_draw_instead_of_source_order(self):
        self.window.character_content = {"tapReactions": [
            {"text": value, "emotion": "happy", "gestures": ["head"]}
            for value in ("first", "second", "third")]}
        with patch.object(p.random, "choice", side_effect=lambda choices: choices[-1]) as choice:
            self.assertEqual(self.window._pick_tap_line("head")["text"], "third")
            self.assertEqual(self.window._pick_tap_line("head")["text"], "second")
            self.assertEqual(choice.call_count, 2)

    def test_newly_ready_tap_joins_draw_without_repeating_cached_line(self):
        line = self.prepare_tap()
        other = {**line, "text": "newly-ready", "cn": "新台词", "emotion": "happy"}
        self.window.character_content["tapReactions"].append(other)
        self.window._configure_reaction_audio()
        signature = self.window.reaction_audio.signature
        self.window.reaction_audio.store(signature, line, b"original", "audio/wav")
        self.assertEqual(self.window._pick_tap_line("head")["text"], line["text"])
        self.window.reaction_audio.store(signature, other, b"new-original", "audio/wav")
        self.assertEqual(self.window._pick_tap_line("head")["text"], other["text"])

    def test_unconfigured_gesture_does_not_borrow_another_gestures_words(self):
        self.window.character_content = {"tapReactions": [
            {"text": "head only", "emotion": "soft", "gestures": ["head"]}]}
        self.assertIsNone(self.window._pick_tap_line("pat"))
        self.window.character_content["tapReactions"].append({"text": "legacy", "emotion": "soft"})
        self.assertEqual(self.window._pick_tap_line("pat")["text"], "legacy")

    def test_single_line_and_duplicate_text_do_not_break_draw(self):
        self.window.character_content = {"tapReactions": [
            {"text": "only", "emotion": "soft"}, {"text": "only", "emotion": "happy"}]}
        for _ in range(3):
            self.assertEqual(self.window._pick_tap_line("head")["text"], "only")

    def prepare_tap(self):
        line = {"text": "synthetic-head", "cn": "头部反应", "emotion": "blush", "gestures": ["head"]}
        self.window.config = {"voice": {"enabled": True, "provider": "qwen-local", "name": "original-clone"}}
        self.window.character_content = {"tapReactions": [line]}
        self.window._configure_reaction_audio()
        self.window.avatar.interaction_kind = "head"
        self.window.avatar.interaction_emotion = "blush"
        self.jobs = []
        self.window.pool.shutdown(wait=False)
        self.window.pool = SimpleNamespace(submit=lambda fn, *a: self.jobs.append(lambda: fn(*a)),
                                           shutdown=lambda **kw: None)
        self.window.api.request = lambda *a, **kw: self.fail("ready tap must not call the daemon")
        return line

    def test_ready_tap_plays_original_bytes_without_network_or_say_queue(self):
        line = self.prepare_tap()
        original = b"original-clone-wave" * 30
        self.window.reaction_audio.store(self.window.reaction_audio.signature, line, original, "audio/wav")
        self.window._on_avatar_tap("head")
        self.assertEqual(self.window.reaction_caption.text(), "头部反应")
        self.assertTrue(self.window.audio_busy)
        self.window._on_avatar_tap("head")
        self.assertEqual(len(self.jobs), 1, "repeated clicks must not queue delayed reactions")
        self.assertFalse(any(c[0][0] == "tap_say" for c in self.calls))
        self.jobs[0]()
        self.assertIs(self.window.audio.played[0][0][1], original)

    def test_cold_tap_does_not_schedule_delayed_speech(self):
        line = self.prepare_tap()
        self.window._on_avatar_tap("head")
        self.assertFalse(self.window.audio_busy)
        self.assertEqual(self.jobs, [])
        self.assertFalse(any(c[0][0] == "tap_say" for c in self.calls))
        self.window._on_result("reaction_prepare", {
            "signature": self.window.reaction_audio.signature, "line": line,
            "audio": b"prepared-clone" * 30, "mime": "audio/wav"})
        self.assertEqual(self.jobs, [], "warm completion alone must never play an old click")

    def test_finished_short_clip_does_not_leave_next_click_silent(self):
        line = self.prepare_tap()
        self.window.reaction_audio.store(self.window.reaction_audio.signature, line, b"clone" * 60, "audio/wav")
        now = time.monotonic()
        with patch.object(p.time, "monotonic", return_value=now):
            self.window._on_avatar_tap("head")
            self.jobs[0]()
            self.window._on_audio_done(self.window.active_audio_item, "")
        with patch.object(p.time, "monotonic", return_value=now + 1):
            self.window._on_avatar_tap("head")
            self.assertEqual(len(self.jobs), 2)
            self.jobs[1]()
        self.assertEqual(len(self.window.audio.played), 2)

    def test_uncached_provider_keeps_debounce_before_voice_event_arrives(self):
        self.window.config = {"voice": {"enabled": True, "provider": "system"}}
        self.window.character_content = {"tapReactions": [
            {"text": "first", "cn": "第一句", "emotion": "soft"},
            {"text": "second", "cn": "第二句", "emotion": "happy"}]}
        with patch.object(p.time, "monotonic", return_value=10):
            self.window._on_avatar_tap("head")
            caption = self.window.reaction_caption.text()
        with patch.object(p.time, "monotonic", return_value=11):
            self.window._on_avatar_tap("head")
        self.assertEqual(sum(c[0][0] == "tap_say" for c in self.calls), 1)
        self.assertEqual(self.window.reaction_caption.text(), caption)

    def test_new_chat_cancels_tap_before_worker_can_play(self):
        line = self.prepare_tap()
        self.window.reaction_audio.store(self.window.reaction_audio.signature, line, b"clone" * 60, "audio/wav")
        self.window._on_avatar_tap("head")
        self.window.input.setText("开始新对话")
        self.window.send()
        self.jobs[0]()
        self.assertEqual(self.window.audio.played, [])
        self.assertFalse(self.window.audio_busy)

    def test_voice_change_discards_ready_and_late_old_voice(self):
        line = self.prepare_tap()
        signature = self.window.reaction_audio.signature
        self.window.reaction_audio.store(signature, line, b"clone" * 60, "audio/wav")
        self.window._on_avatar_tap("head")
        self.window._on_event("config", {"config": {"voice": {
            "enabled": True, "provider": "qwen-local", "name": "different-clone"}}})
        self.jobs[0]()
        self.window._on_result("reaction_prepare", {"signature": signature, "line": line,
                                                   "audio": b"old-clone" * 60, "mime": "audio/wav"})
        self.assertIsNone(self.window.reaction_audio.ready(line))
        self.assertEqual(self.window.audio.played, [])

    def test_tap_waiting_in_busy_executor_expires(self):
        line = self.prepare_tap()
        self.window.reaction_audio.store(self.window.reaction_audio.signature, line, b"clone" * 60, "audio/wav")
        self.window._on_avatar_tap("head")
        with patch.object(p.time, "monotonic", return_value=time.monotonic() + 2):
            self.jobs[0]()
        self.assertEqual(self.window.audio.played, [])
        self.assertFalse(self.window.audio_busy)

    def test_background_prepare_is_serial_idle_only_and_never_plays(self):
        line = self.prepare_tap()
        threads = []
        self.window.api.request = lambda *a, **kw: (b"clone" * 60, "audio/wav")
        def thread(**kwargs):
            threads.append(kwargs)
            return SimpleNamespace(start=lambda: None)
        with patch.object(p.threading, "Thread", side_effect=thread), \
                patch.object(self.window, "isVisible", return_value=True):
            self.window.pending_turn = True
            self.window._prepare_reaction_audio()
            self.assertEqual(threads, [])
            self.window.pending_turn = False
            self.window._prepare_reaction_audio()
            self.window._prepare_reaction_audio()
            self.assertEqual(len(threads), 1)
            self.assertTrue(threads[0]["daemon"])
            threads[0]["target"]()
        self.assertIsNotNone(self.window.reaction_audio.ready(line))
        self.assertEqual(self.window.audio.played, [])
        self.assertFalse(self.window.reaction_preparing)

    def test_config_response_mutes_without_waiting_for_event_stream(self):
        line = self.prepare_tap()
        self.window.reaction_audio.store(self.window.reaction_audio.signature, line, b"clone" * 60, "audio/wav")
        self.window._on_avatar_tap("head")
        self.window._on_result("config", {"config": {"voice": {
            "enabled": False, "provider": "qwen-local", "name": "original-clone"}}})
        self.jobs[0]()
        self.assertIsNone(self.window.reaction_audio.ready(line))
        self.assertEqual(self.window.audio.played, [])
        self.assertFalse(self.window.audio_busy)

    def test_late_start_signal_cannot_reopen_mouth_after_cancel(self):
        line = self.prepare_tap()
        self.window.reaction_audio.store(self.window.reaction_audio.signature, line, b"clone" * 60, "audio/wav")
        self.window._on_avatar_tap("head")
        old = self.window.active_audio_item
        self.window._on_audio_started(old)
        self.assertTrue(self.window.avatar.talking)
        self.window._stop_speech()
        self.window._on_audio_started(old)
        self.assertFalse(self.window.avatar.talking)

    def test_greeting_preparation_has_priority_over_reactions(self):
        self.prepare_tap()
        self.window.welcome_started = True
        self.window.welcome_ready = False
        self.window.welcome_deadline = time.monotonic() + 360
        with patch.object(self.window, "isVisible", return_value=True), \
                patch.object(p.threading, "Thread") as thread:
            self.window._prepare_reaction_audio()
            thread.assert_not_called()
            self.window.welcome_cancelled = True
            self.window._prepare_reaction_audio()
            thread.assert_called_once()

    def test_affect_indicator_follows_actual_avatar_state(self):
        self.assertIs(self.window.screen.layout().currentWidget(), self.window.screen_header)
        self.window.avatar.affect_changed.emit("thinking", "thinking")
        self.assertEqual(self.window.affect_label.text(), "思考中")
        self.window.avatar.affect_changed.emit("reply", "blush")
        self.assertEqual(self.window.affect_label.text(), "害羞")
        self.window.avatar.affect_changed.emit("idle", "soft")
        self.assertEqual(self.window.affect_label.text(), "放松")

    def test_reaction_caption_wraps_at_minimum_phone_width(self):
        self.window.resize(270, 468)
        self.window.show()
        self.app.processEvents()
        self.window.reaction_caption.setText("……别把我当小孩。我也没说讨厌。" * 2)
        self.window._fit_reaction_caption()
        self.window.reaction_caption.show()
        self.app.processEvents()
        label = self.window.reaction_caption
        self.assertLessEqual(label.width(), self.window.screen.width() - 24)
        self.assertGreater(label.height(), label.fontMetrics().height() * 2)
        self.assertTrue(self.window.screen_header.rect().contains(label.geometry()))

    def test_finished_external_audio_resumes_pending_chat_expression(self):
        self.window.pending_turn = True
        self.window.avatar.set_activity("reply")
        self.window.active_audio_item = {"_generation": self.window.audio_generation}
        self.window._on_audio_done(self.window.active_audio_item, "")
        self.assertEqual(self.window.avatar.activity, "thinking")

    def test_duplicate_completion_cannot_interrupt_the_next_clip(self):
        self.window.audio_queue = [{"text": "first"}, {"text": "second"}]
        self.window.pool.submit = lambda *a: None
        self.window._next_audio()
        first = self.window.active_audio_item
        self.window._on_audio_done(first, "")
        second = self.window.active_audio_item
        self.window._on_audio_started(second)
        self.window._on_audio_done(first, "late old failure")
        self.assertIs(self.window.active_audio_item, second)
        self.assertTrue(self.window.audio_busy)
        self.assertTrue(self.window.avatar.talking)
        self.assertFalse(any(c[0][0] == "audio_report" for c in self.calls))

    def prepare_say_queue(self):
        self.window.config = {"voice": {"enabled": True, "provider": "qwen-local", "name": "original-clone"}}
        self.window._configure_reaction_audio()
        self.jobs, self.requests, self.prepares = [], [], []
        self.window.pool.shutdown(wait=False)
        self.window.pool = SimpleNamespace(submit=lambda fn, *a: self.jobs.append(lambda: fn(*a)),
                                           shutdown=lambda **kw: None)
        def request(path, **kwargs):
            text = p.urllib.parse.parse_qs(p.urllib.parse.urlparse(path).query)["text"][0]
            self.requests.append((text, kwargs))
            return text.encode() * 60, "audio/wav"
        self.window.api.request = request
        self.window.audio_queue = [{"id": i, "kind": "say", "text": text, "emotion": emotion}
                                   for i, (text, emotion) in enumerate(
                                       (("first", "soft"), ("second", "happy"), ("third", "thinking")), 1)]

    def capture_prefetch_start(self, item):
        def thread(**kwargs):
            self.assertTrue(kwargs["daemon"])
            self.prepares.append(kwargs["target"])
            return SimpleNamespace(start=lambda: None)
        with patch.object(p.threading, "Thread", side_effect=thread):
            self.window._on_audio_started(item)

    def test_speech_prefetch_starts_after_play_and_reuses_one_next_clip(self):
        self.prepare_say_queue()
        self.window._next_audio()
        first = self.window.active_audio_item
        self.jobs[0]()
        self.window._prepare_next_speech()
        self.assertIsNone(self.window.speech_prefetch, "synthesis completion is not actual playback")
        self.capture_prefetch_start(first)
        self.capture_prefetch_start(first)
        self.assertEqual(len(self.prepares), 1)
        self.prepares[0]()
        self.assertEqual([r[0] for r in self.requests], ["first", "second"])
        self.assertEqual(self.requests[0][1]["timeout"], 570)
        self.window._on_audio_done(first, "")
        second = self.window.active_audio_item
        self.jobs[1]()
        self.assertEqual([r[0] for r in self.requests], ["first", "second"], "use prefetch, not a duplicate request")
        self.assertEqual(self.window.avatar.last_emotion, "happy")
        self.assertEqual(self.window.audio.played[1][0][1], b"second" * 60)
        self.capture_prefetch_start(second)
        self.assertEqual(len(self.prepares), 2, "only then prepare third")

    def test_playback_worker_waits_on_same_inflight_prefetch_without_blocking_qt(self):
        self.prepare_say_queue()
        self.window._next_audio()
        self.jobs[0]()
        first = self.window.active_audio_item
        self.capture_prefetch_start(first)
        entered, release, playback_done = threading.Event(), threading.Event(), threading.Event()
        request = self.window.api.request
        def delayed(path, **kwargs):
            entered.set()
            self.assertTrue(release.wait(2))
            return request(path, **kwargs)
        self.window.api.request = delayed
        producer = threading.Thread(target=self.prepares[0])
        producer.start()
        try:
            self.assertTrue(entered.wait(1))
            self.window._on_audio_done(first, "")
            consumer = threading.Thread(target=lambda: (self.jobs[1](), playback_done.set()))
            consumer.start()
            self.assertFalse(playback_done.wait(.05))
            self.assertEqual(len(self.window.audio.played), 1)
            release.set()
            self.assertTrue(playback_done.wait(1))
            consumer.join(1)
        finally:
            release.set()
            producer.join(2)
        self.assertEqual([r[0] for r in self.requests], ["first", "second"])
        self.assertEqual(len(self.window.audio.played), 2)

    def test_speech_prefetch_cancelled_by_new_chat_call_mute_or_changed_voice(self):
        for reason in ("chat", "call", "mute", "voice"):
            with self.subTest(reason=reason):
                self.prepare_say_queue()
                self.window._next_audio()
                self.jobs[0]()
                first = self.window.active_audio_item
                self.capture_prefetch_start(first)
                slot = self.window.speech_prefetch
                if reason == "chat":
                    self.window.input.setText("new question")
                    self.window.send()
                elif reason == "call":
                    self.window.config["voice"]["ringEnabled"] = False
                    self.window._utterance({"id": 200, "kind": "call", "text": "call"})
                else:
                    voice = dict(self.window.config["voice"])
                    voice.update({"enabled": False} if reason == "mute" else {"name": "changed-clone"})
                    self.window._on_event("config", {"config": {"voice": voice}})
                self.prepares[0]()
                self.assertFalse(slot["valid"])
                self.assertEqual([r[0] for r in self.requests], ["first"])
                self.assertFalse(self.window.audio_busy)
                self.assertEqual(self.window.audio_queue, [])
                self.assertFalse(self.window.avatar.talking)
                self.window.pending_turn = False
                self.window.call_item = None
                self.window.seen_utterances.clear()

    def test_prefetch_error_is_reported_in_order_without_duplicate_synthesis(self):
        self.prepare_say_queue()
        self.window._next_audio()
        self.jobs[0]()
        first = self.window.active_audio_item
        self.capture_prefetch_start(first)
        self.window.api.request = lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("synthetic stream error"))
        self.prepares[0]()
        self.assertNotIn("synthetic stream error", self.window.status.text())
        self.window._on_audio_done(first, "")
        self.jobs[1]()
        self.assertIn("语音播放失败", self.window.status.text())
        report = next(c[0][3] for c in self.calls if c[0][0] == "audio_report")
        self.assertEqual(report["detail"], "synthetic stream error")
        self.assertEqual(self.window.active_audio_item["text"], "third")
        self.assertIsNone(self.window.speech_prefetch)
        self.assertEqual(len(self.window.audio.played), 1)

    def test_prefetch_is_only_for_local_chat_and_rejects_oversized_result(self):
        self.prepare_say_queue()
        self.window._next_audio()
        self.jobs[0]()
        first = self.window.active_audio_item
        for kind in ("tap", "broadcast", "call"):
            first["kind"] = kind
            self.capture_prefetch_start(first)
            self.assertIsNone(self.window.speech_prefetch)
        first["kind"] = "say"
        self.window.config["voice"]["provider"] = "system"
        self.capture_prefetch_start(first)
        self.assertIsNone(self.window.speech_prefetch)
        self.window.config["voice"]["provider"] = "qwen-local"
        self.capture_prefetch_start(first)
        self.window.api.request = lambda *a, **kw: (b"x" * (8 * 1024 * 1024 + 1), "audio/wav")
        self.prepares[0]()
        with self.assertRaisesRegex(RuntimeError, "数据过大"):
            self.window.speech_prefetch["future"].result()

    def test_cancel_releases_waiting_worker_and_ignores_late_prefetch_bytes(self):
        self.prepare_say_queue()
        self.window._next_audio()
        self.jobs[0]()
        first = self.window.active_audio_item
        self.capture_prefetch_start(first)
        entered, release, playback_done = threading.Event(), threading.Event(), threading.Event()
        def delayed(*args, **kwargs):
            entered.set()
            self.assertTrue(release.wait(2))
            return b"late original clone", "audio/wav"
        self.window.api.request = delayed
        producer = threading.Thread(target=self.prepares[0])
        producer.start()
        try:
            self.assertTrue(entered.wait(1))
            slot = self.window.speech_prefetch
            self.window._on_audio_done(first, "")
            consumer = threading.Thread(target=lambda: (self.jobs[1](), playback_done.set()))
            consumer.start()
            self.window._stop_speech()
            self.assertTrue(playback_done.wait(.5), "cancellation must not wait for synthesis")
            self.assertIs(self.window.speech_prefetch, slot, "running old request still occupies the one slot")
            release.set()
            producer.join(2)
            consumer.join(1)
            self.app.processEvents()
            self.assertIsNone(slot["future"].result())
            self.assertEqual(len(self.window.audio.played), 1)
        finally:
            release.set()
            producer.join(2)

    def test_prefetch_wait_has_deadline_and_keeps_timed_out_request_bounded(self):
        self.prepare_say_queue()
        self.window._next_audio()
        self.jobs[0]()
        first = self.window.active_audio_item
        self.capture_prefetch_start(first)
        slot = self.window.speech_prefetch
        self.assertTrue(slot["future"].set_running_or_notify_cancel())
        with patch.object(self.window, "_speech_timeout", return_value=.01):
            self.window._on_audio_done(first, "")
        self.jobs[1]()
        self.assertFalse(slot["valid"])
        self.assertIs(self.window.speech_prefetch, slot)
        self.assertEqual(len(self.window.audio.played), 1)
        report = next(c[0][3] for c in self.calls if c[0][0] == "audio_report")
        self.assertIn("准备超时", report["detail"])
        slot["future"].set_result(None)


if __name__ == "__main__":
    unittest.main()
