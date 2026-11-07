"""Voice turn-taking against actual Qt widgets with synthetic recognition/audio events."""
import os
import sys
import queue
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from PySide6.QtCore import Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication
import panel as p
from media import MediaLibrary
from voice_dialogue import VoiceDialogue, RecognitionJob, recognize
from native_panel_test import FakeAvatar, FakeAudio


class VoicePanelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.calls = []
        self.jobs = queue.Queue()
        self.patchers = [patch.object(p, 'Live2DView', FakeAvatar), patch.object(p, 'MciAudio', FakeAudio),
                         patch.object(p, 'MediaLibrary', lambda: MediaLibrary(Path(self.folder.name) / 'media')),
                         patch.object(p.EventReader, 'start', lambda *_: None),
                         patch.object(p.Panel, 'call', lambda _w, *a, **k: self.calls.append((a, k))),
                         patch.object(p, 'recognize', lambda _bridge, job, _lang: self.jobs.put(job)),
                         patch.object(p.Panel, '_prepare_next_speech', lambda *_: None)]
        for item in self.patchers:
            item.start()
        self.window = p.Panel(SimpleNamespace(welcome=False, client='native-test', request=lambda *a, **k: (b'audio', 'audio/wav')))
        self.window.splash.stop()
        self.window._finish_boot()
        self.window.config = {'voice': {'enabled': True, 'provider': 'qwen-local', 'name': 'unchanged-test-clone'},
                              'speechInput': {'provider': 'windows-native', 'lang': 'zh-CN', 'submitMode': 'auto', 'sensitivity': 'high'},
                              'chat': {'oneshot': True}}
        self.calls.clear()

    def tearDown(self):
        self.window.close()
        self.window.deleteLater()
        self.app.processEvents()
        for item in reversed(self.patchers):
            item.stop()
        self.folder.cleanup()

    def listen(self):
        self.window._voice_rearm()
        return self.jobs.get(timeout=1)

    def begin(self):
        self.window.start_mic()
        return self.listen()

    def say(self, job, text='第一句话'):
        self.window._on_speech_done(job, text, None)

    def accept(self, turn='turn-one', session='session-one'):
        payload = self.window.pending_payload
        self.window._on_result('chat', {'mode': 'voice', 'turnId': turn, 'sessionId': session,
                                       'voiceRequestId': payload['voiceRequestId']})

    def clip(self, number, turn='turn-one', session='session-one'):
        return {'id': number, 'kind': 'say', 'text': 'synthetic', 'mode': 'voice', 'targetClient': 'native-test',
                'sessionId': session, 'replyTo': turn, 'voiceRequestId': self.window.voice_dialogue.request_id}

    def done(self, ids, turn='turn-one'):
        self.window._on_event('turn:done', {'turnId': turn, 'zh': '回复', 'emotion': 'soft', 'speechIds': ids})

    def finish_audio(self):
        item = self.window.active_audio_item
        self.window._on_audio_started(item)
        self.window._on_audio_done(item, None)

    def test_two_complete_voice_exchanges_auto_send_speak_and_listen_with_same_context(self):
        w = self.window
        first = self.begin()
        self.assertTrue(w.mic.isChecked())
        self.say(first)
        self.assertTrue(w.pending_turn)
        self.assertEqual(w.pending_payload['mode'], 'voice')
        self.assertEqual(w.input.text(), '')
        self.accept()
        self.done([11, 12])
        w._utterance(self.clip(11))
        w._utterance(self.clip(12))
        self.finish_audio()
        w._voice_rearm()
        self.assertTrue(self.jobs.empty(), 'no mic between reply chunks')
        self.finish_audio()
        second = self.listen()
        self.say(second, '那接下来呢')
        self.assertEqual(w.pending_payload['sessionId'], 'session-one')
        self.assertEqual(w.pending_payload['text'], '那接下来呢')
        self.accept('turn-two')
        self.done([13], 'turn-two')
        w._utterance(self.clip(13, 'turn-two'))
        self.finish_audio()
        self.assertIsNotNone(self.listen())
        self.assertEqual(w.config['voice']['name'], 'unchanged-test-clone')
        self.assertTrue(w.config['chat']['oneshot'])

    def test_audio_finishing_before_reply_event_cannot_open_the_mic_early(self):
        job = self.begin()
        self.say(job)
        w = self.window
        self.accept()
        w._utterance(self.clip(21))
        self.finish_audio()
        w._voice_rearm()
        self.assertTrue(self.jobs.empty())
        self.done([21])
        self.assertIsNotNone(self.listen())

    def test_stop_during_capture_discards_late_words_and_restores_music(self):
        w = self.window
        music = SimpleNamespace(listening=False, speaking=False, update_volume=lambda: None, stop=lambda: None)
        w.background_music = music
        job = self.begin()
        self.assertTrue(music.listening)
        w.start_mic()
        self.assertTrue(job.cancelled.is_set())
        self.say(job, '不应发送')
        self.assertFalse(w.pending_turn)
        self.assertFalse(w.mic.isChecked())
        self.assertFalse(music.listening)
        self.assertFalse(any(call[0][0] == 'chat' for call in self.calls))

    def test_restart_waits_for_cancelled_capture_to_release_and_ignores_duplicate_completion(self):
        w = self.window
        old = self.begin()
        w.stop_voice_dialogue()
        w.start_mic()
        w._voice_rearm()
        self.assertTrue(self.jobs.empty())
        self.say(old, '旧结果')
        current = self.listen()
        self.say(old, '重复旧结果')
        self.assertIs(w.voice_dialogue.capture, current)
        self.assertFalse(w.pending_turn)

    def test_stop_before_http_ack_ends_the_created_server_session(self):
        w = self.window
        self.say(self.begin())
        request_id = w.pending_payload['voiceRequestId']
        w.stop_voice_dialogue()
        w._on_result('chat', {'mode': 'voice', 'turnId': 'late', 'sessionId': 'late-session', 'voiceRequestId': request_id})
        self.assertFalse(w.pending_turn)
        self.assertIsNone(w.session_id)
        self.assertTrue(any(c[0][0] == 'voice_end' and c[0][3]['voiceSessionId'] == 'late-session' for c in self.calls))

    def test_stop_while_waiting_suppresses_the_expected_cancellation_error(self):
        w = self.window
        self.say(self.begin())
        self.accept()
        w.stop_voice_dialogue()
        w._on_event('turn:error', {'turnId': 'turn-one', 'closed': True, 'error': '已取消'})
        self.assertFalse(w.pending_turn)
        self.assertIn('已结束', w.status.text())
        self.assertIsNone(w.session_id)

    def test_normal_text_reply_still_works_after_ending_a_voice_turn(self):
        w = self.window
        self.say(self.begin())
        self.accept()
        w.stop_voice_dialogue()
        w._on_event('turn:error', {'turnId': 'turn-one', 'closed': True, 'error': '已取消'})
        w.input.setText('改为打字')
        w.send()
        w._on_result('chat', {'turnId': 'text-turn', 'sessionId': 'text-session'})
        w._on_event('turn:done', {'turnId': 'text-turn', 'zh': '普通文字回复', 'closed': True})
        self.assertIn('已回复 · 单句会话已结束', w.status.text())

    def test_missing_reply_audio_is_reported_without_an_automatic_recording_loop(self):
        self.say(self.begin())
        self.accept()
        self.done([])
        self.window._voice_rearm()
        self.assertFalse(self.window.voice_dialogue.active)
        self.assertIn('没有可播放的语音', self.window.status.text())
        self.assertTrue(self.jobs.empty())

    def test_interruption_keeps_context_and_rejects_remaining_clips(self):
        w = self.window
        self.say(self.begin())
        self.accept()
        self.done([31, 32])
        w._utterance(self.clip(31))
        old_clip = self.clip(32)
        w.interrupt_voice_reply()
        w._utterance(old_clip)
        self.assertFalse(w.audio_busy)
        self.assertEqual(w.audio_queue, [])
        self.say(self.listen(), '换个说法')
        self.assertEqual(w.pending_payload['sessionId'], 'session-one')

    def test_old_audio_cannot_adopt_a_session_in_a_new_voice_round(self):
        w = self.window
        self.say(self.begin())
        self.accept()
        old_clip = self.clip(41)
        w.stop_voice_dialogue()
        w._finish_turn_wait()
        w.start_mic()
        w._utterance(old_clip)
        self.assertFalse(w.audio_busy)
        self.assertIsNone(w.voice_dialogue.session_id)

    def test_empty_recognition_never_sends_and_eventually_closes_the_mic(self):
        job = self.begin()
        for _ in range(10):
            self.say(job, '')
            if self.window.voice_dialogue.active:
                job = self.listen()
        self.assertFalse(self.window.voice_dialogue.active)
        self.assertFalse(any(c[0][0] == 'chat' for c in self.calls))

    def test_local_end_phrase_closes_without_sending_to_the_model(self):
        self.say(self.begin(), '结束语音对话。')
        self.assertFalse(self.window.voice_dialogue.active)
        self.assertFalse(self.window.pending_turn)

    def test_recognition_failure_and_tts_failure_stop_instead_of_restarting_in_a_loop(self):
        w = self.window
        job = self.begin()
        w._on_speech_done(job, '', 'microphone unavailable')
        self.assertFalse(w.voice_dialogue.active)
        self.say(self.begin())
        self.accept()
        self.done([51])
        w._utterance(self.clip(51))
        w._on_audio_done(w.active_audio_item, 'synthetic failure')
        w._voice_rearm()
        self.assertFalse(w.voice_dialogue.active)
        self.assertTrue(self.jobs.empty())

    def test_user_draft_is_not_overwritten_by_recognition(self):
        w = self.window
        job = self.begin()
        w.input.setText('保留手写草稿')
        self.say(job, '识别文字')
        self.assertEqual(w.input.text(), '保留手写草稿')
        self.assertFalse(w.pending_turn)

    def test_disconnect_shutdown_and_input_switch_cancel_capture_immediately(self):
        for kind, data in [('offline', {}), ('shutdown', {}),
                           ('config', {'config': {'voice': {'enabled': True}, 'speechInput': {'provider': 'none'}}})]:
            with self.subTest(kind=kind):
                self.window.config['speechInput']['provider'] = 'windows-native'
                job = self.begin()
                self.window._on_event(kind, data)
                self.assertTrue(job.cancelled.is_set())
                self.say(job, '迟到的识别')
                self.assertFalse(self.window.voice_dialogue.active)

    def test_incoming_call_stops_recognition_before_changing_to_call_screen(self):
        w = self.window
        job = self.begin()
        w.config['voice']['ringEnabled'] = False
        w._utterance({'id': 99, 'kind': 'call', 'text': 'synthetic'})
        self.assertTrue(job.cancelled.is_set())
        self.assertTrue(w.call_mode)
        self.assertFalse(w.voice_dialogue.active)
        self.say(job, '来电后不能误发送')
        self.assertFalse(w.pending_turn)

    def test_typing_a_correction_pauses_recognition_and_keeps_voice_context(self):
        w = self.window
        self.say(self.begin())
        self.accept()
        self.done([61])
        w._utterance(self.clip(61))
        self.finish_audio()
        job = self.listen()
        w.input.setText('我刚才说的是电池')
        w._on_composing(w.input.text())
        self.assertTrue(job.cancelled.is_set())
        self.say(job, '不应覆盖')
        w.send()
        self.assertEqual(w.pending_payload['mode'], 'voice')
        self.assertEqual(w.pending_payload['sessionId'], 'session-one')
        self.assertEqual(w.pending_payload['text'], '我刚才说的是电池')

    def test_tab_change_pauses_capture_and_return_resumes(self):
        w = self.window
        job = self.begin()
        w.tabs.setCurrentIndex(2)
        self.assertTrue(job.cancelled.is_set())
        self.say(job, '不能误发送')
        self.assertFalse(w.pending_turn)
        w.tabs.setCurrentIndex(0)
        self.assertIsNotNone(self.listen())

    def test_mic_controls_and_escape_work_at_small_phone_size(self):
        w = self.window
        w.resize(270, 468)
        w.show()
        w.activateWindow()
        QTest.qWait(20)
        QTest.mouseClick(w.mic, Qt.MouseButton.LeftButton)
        job = self.listen()
        self.assertTrue(w.voice_bar.isVisible())
        self.assertTrue(w.voice_end.isVisible())
        self.assertLessEqual(w.voice_end.mapTo(w, w.voice_end.rect().bottomRight()).x(), w.width())
        QTest.keyClick(w, Qt.Key.Key_Escape)
        QTest.qWait(5)
        self.assertFalse(w.voice_dialogue.active)
        self.assertTrue(job.cancelled.is_set())

    def manual_begin(self):
        self.window.config['speechInput']['submitMode'] = 'manual'
        job = self.begin()
        self.window._on_recognition_progress(job, {'kind': 'ready'})
        return job

    def test_manual_button_finishes_one_phrase_and_waits_for_final_recognition(self):
        w = self.window
        job = self.manual_begin()
        w._on_recognition_progress(job, {'kind': 'hypothesis', 'text': '今天我想聊'})
        self.assertEqual(w.voice_preview.toPlainText(), '今天我想聊')
        self.assertFalse(w.pending_turn)
        w.voice_done.click()
        self.assertTrue(job.finish_requested.is_set())
        self.assertFalse(job.cancelled.is_set())
        self.assertTrue(w.voice_finishing)
        self.assertFalse(w.voice_done.isEnabled())
        self.say(job, '今天我想聊实验')
        self.assertTrue(w.pending_turn)
        self.assertEqual(w.pending_payload['text'], '今天我想聊实验')
        self.assertFalse(w.voice_preview.isVisible())
        w.finish_voice_phrase()
        self.assertEqual(len([c for c in self.calls if c[0][0] == 'chat']), 1)

    def test_manual_mode_combines_phrases_without_submitting_on_a_pause(self):
        w = self.window
        job = self.manual_begin()
        self.say(job, '第一句话')
        self.assertFalse(w.pending_turn)
        self.assertEqual(w.voice_preview.toPlainText(), '第一句话')
        second = self.listen()
        self.assertEqual(second.prefix, '第一句话')
        w._on_recognition_progress(second, {'kind': 'ready'})
        w.finish_voice_phrase()
        self.say(second, '第一句话 第二句话')
        self.assertEqual(w.pending_payload['text'], '第一句话 第二句话')

    def test_empty_manual_finish_never_sends_a_blank_message(self):
        w = self.window
        job = self.manual_begin()
        w.finish_voice_phrase()
        self.say(job, '')
        self.assertFalse(w.pending_turn)
        self.assertFalse(any(c[0][0] == 'chat' for c in self.calls))
        self.assertIn('未收到有效声音', w.voice_state.text())
        self.assertTrue(w.voice_dialogue.active)

    def test_uncertain_auto_result_is_visible_and_requires_explicit_confirmation(self):
        w = self.window
        job = self.begin()
        job.requires_confirmation = True
        self.say(job, '轻声识别的文字')
        self.assertFalse(w.pending_turn)
        self.assertEqual(w.voice_preview.toPlainText(), '轻声识别的文字')
        self.assertIn('未发送', w.voice_state.text())
        w._voice_rearm()
        self.assertTrue(self.jobs.empty())
        w.voice_done.click()
        self.assertEqual(w.pending_payload['text'], '轻声识别的文字')

    def test_hypothesis_without_a_complete_phrase_is_not_silently_sent(self):
        w = self.window
        job = self.manual_begin()
        w._on_recognition_progress(job, {'kind': 'hypothesis', 'text': '尚未确定的文字'})
        w.finish_voice_phrase()
        self.say(job, '')
        self.assertFalse(w.pending_turn)
        self.assertTrue(w.voice_needs_confirmation)
        self.assertIn('识别未完整', w.voice_state.text())
        w.finish_voice_phrase()
        self.assertEqual(w.pending_payload['text'], '尚未确定的文字')

    def test_editing_preview_cancels_capture_and_sends_only_the_user_correction(self):
        w = self.window
        job = self.manual_begin()
        w._on_recognition_progress(job, {'kind': 'recognized', 'text': '听写错字'})
        w.voice_preview.setPlainText('我修改后的文字')
        self.assertTrue(job.cancelled.is_set())
        w.finish_voice_phrase()
        self.assertEqual(w.pending_payload['text'], '我修改后的文字')
        self.say(job, '迟到的错误结果')
        self.assertEqual(w.pending_payload['text'], '我修改后的文字')

    def test_live_level_and_detection_feedback_are_distinct_from_recognition(self):
        w = self.window
        job = self.begin()
        self.assertIn('准备中', w.status.text())
        self.assertFalse(w.voice_done.isEnabled())
        w._on_recognition_progress(job, {'kind': 'ready'})
        self.assertTrue(w.voice_done.isEnabled())
        w._on_recognition_progress(job, {'kind': 'level', 'level': 43})
        self.assertEqual(w.voice_level.value(), 43)
        self.assertEqual(w.voice_preview.toPlainText(), '')
        w._on_recognition_progress(job, {'kind': 'speech'})
        self.assertIn('听到说话', w.voice_state.text())
        w._on_recognition_progress(job, {'kind': 'recognized', 'text': '已经识别', 'confidence': .8})
        self.assertIn('已识别', w.voice_state.text())
        self.assertEqual(w.voice_preview.toPlainText(), '已经识别')

    def test_music_remains_muted_until_manual_finish_has_released_recognition(self):
        w = self.window
        w.background_music = SimpleNamespace(listening=False, speaking=False, update_volume=lambda: None, stop=lambda: None)
        job = self.manual_begin()
        self.assertTrue(w.background_music.listening)
        w.finish_voice_phrase()
        self.assertTrue(w.background_music.listening)
        self.say(job, '完整的一句话')
        self.assertFalse(w.background_music.listening)

    def test_cancelled_progress_cannot_update_a_stopped_or_restarted_dialogue(self):
        w = self.window
        job = self.manual_begin()
        w.stop_voice_dialogue()
        w._on_recognition_progress(job, {'kind': 'hypothesis', 'text': '过期的识别'})
        self.assertNotIn('过期的识别', w.voice_preview.toPlainText())
        self.say(job, '')
        w.input.clear()
        w.start_mic()
        current = self.listen()
        w._on_recognition_progress(job, {'kind': 'level', 'level': 99})
        self.assertEqual(w.voice_level.value(), 0)
        self.assertIs(w.voice_dialogue.capture, current)

    def test_stopping_preserves_unsent_recognition_in_the_main_input(self):
        w = self.window
        self.manual_begin()
        w.voice_preview.setPlainText('还没确认的文字')
        w.stop_voice_dialogue()
        self.assertEqual(w.input.text(), '还没确认的文字')
        self.assertFalse(w.pending_turn)

    def test_mode_and_sensitivity_are_snapshotted_for_this_voice_call(self):
        w = self.window
        job = self.manual_begin()
        w.config['speechInput'].update({'submitMode': 'auto', 'sensitivity': 'low'})
        self.assertEqual(job.submit_mode, 'manual')
        self.assertEqual(job.min_confidence, .12)
        self.say(job, '等待手动确认')
        self.assertFalse(w.pending_turn)

    def test_confirmation_controls_fit_the_small_phone_and_reply_restores_history_space(self):
        w = self.window
        w.resize(270, 468)
        w.show()
        job = self.manual_begin()
        w._on_recognition_progress(job, {'kind': 'recognized', 'text': '你好，我想和你聊一会儿', 'confidence': .8})
        self.app.processEvents()
        self.assertTrue(w.voice_preview.isVisible())
        self.assertTrue(w.voice_done.isVisible())
        self.assertEqual((w.width(), w.height()), (270, 468))
        preview_bottom = w.voice_preview.mapTo(w.voice_bar, w.voice_preview.rect().bottomRight()).y()
        done_top = w.voice_done.mapTo(w.voice_bar, w.voice_done.rect().topLeft()).y()
        self.assertLess(preview_bottom, done_top, 'confirmation must not overlap recognized text')
        self.assertLessEqual(w.voice_done.mapTo(w, w.voice_done.rect().bottomRight()).x(), w.width())
        self.assertLessEqual(w.voice_done.mapTo(w, w.voice_done.rect().bottomRight()).y(), w.height())
        history_during_capture = w.history.height()
        QTest.mouseClick(w.voice_done, Qt.MouseButton.LeftButton)
        self.say(job, '你好，我想和你聊一会儿')
        self.app.processEvents()
        self.assertFalse(w.voice_preview.isVisible())
        self.assertGreaterEqual(w.history.height(), history_during_capture)

    def test_settings_choices_use_real_keyboard_input_and_patch_only_recognition_options(self):
        w = self.window
        w.show()
        w.tabs.setCurrentIndex(2)
        for combo, key, start, target in [(w.speech_submit_mode, 'submitMode', 1, 'auto'),
                                           (w.speech_sensitivity, 'sensitivity', 2, 'high')]:
            combo.setCurrentIndex(start)
            combo.setFocus()
            QTest.keyClick(combo, Qt.Key.Key_Home)
            self.assertEqual(combo.currentData(), target)
            patches = [c[0][3]['patch'] for c in self.calls if c[0][0] == 'config']
            self.assertIn({'speechInput': {key: target}}, patches)
        self.assertEqual(w.config['voice']['name'], 'unchanged-test-clone')

    def test_direct_voice_remains_automatic_without_opening_the_text_editor(self):
        w = self.window
        w.show()
        job = self.begin()
        w._on_recognition_progress(job, {'kind': 'ready'})
        w._on_recognition_progress(job, {'kind': 'recognized', 'text': '直接语音输入', 'confidence': .8})
        self.assertFalse(w.voice_preview.isVisible())
        self.assertTrue(w.voice_done.isVisible())
        self.assertTrue(w.voice_review.isVisible())
        self.say(job, '直接语音输入')
        self.assertTrue(w.pending_turn)
        self.assertEqual(w.pending_payload['text'], '直接语音输入')
        self.assertFalse(w.voice_review_requested)

    def test_optional_text_review_holds_only_the_current_phrase(self):
        w = self.window
        w.show()
        job = self.begin()
        w.voice_review.click()
        self.assertTrue(w.voice_review_requested)
        self.assertTrue(w.voice_preview.isVisible())
        self.say(job, '想进一步确认的文字')
        self.assertFalse(w.pending_turn)
        w.voice_done.click()
        self.assertEqual(w.pending_payload['text'], '想进一步确认的文字')
        self.assertFalse(w.voice_review_requested)
        self.accept()
        self.done([71])
        w._utterance(self.clip(71))
        self.finish_audio()
        next_job = self.listen()
        self.assertEqual(next_job.submit_mode, 'auto')
        self.assertFalse(w.voice_preview.isVisible())

    def test_user_can_retry_uncertain_speech_without_typing(self):
        w = self.window
        job = self.begin()
        job.requires_confirmation = True
        self.say(job, '不确定的声音')
        self.assertFalse(w.pending_turn)
        self.assertEqual(w.voice_review.text(), '重新说')
        w.voice_review.click()
        next_job = self.listen()
        self.assertEqual(next_job.prefix, '')
        self.say(next_job, '重新说清楚的句子')
        self.assertEqual(w.pending_payload['text'], '重新说清楚的句子')

    def test_done_button_also_works_in_direct_voice_without_text_confirmation(self):
        w = self.window
        job = self.begin()
        w._on_recognition_progress(job, {'kind': 'ready'})
        w.finish_voice_phrase()
        self.assertTrue(job.finish_requested.is_set())
        self.say(job, '主动说完一句')
        self.assertTrue(w.pending_turn)
        self.assertFalse(w.voice_review_requested)


class CompletionEvent:
    def __init__(self): self.handlers = []
    def __iadd__(self, callback): self.handlers.append(callback); return self
    def __isub__(self, callback): self.handlers.remove(callback); return self
    def emit(self, result=None, cancelled=False, error=None, **fields):
        args = SimpleNamespace(Result=result, Cancelled=cancelled, Error=error, **fields)
        for callback in list(self.handlers): callback(None, args)


class RecognitionWorkerTests(unittest.TestCase):
    def engine(self, *, text='测试语音', confidence=.9, hold=False):
        event = CompletionEvent()
        engine = SimpleNamespace(RecognizeCompleted=event, disposed=False, input_set=False, cancelled=False)
        for name in ['SpeechRecognized', 'SpeechHypothesized', 'SpeechRecognitionRejected', 'SpeechDetected', 'AudioLevelUpdated']:
            setattr(engine, name, CompletionEvent())
        engine.stopped = False
        engine.SetInputToDefaultAudioDevice = lambda: setattr(engine, 'input_set', True)
        engine.Dispose = lambda: setattr(engine, 'disposed', True)
        engine.started = threading.Event()
        def start(_mode):
            engine.started.set()
            if not hold:
                event.emit(SimpleNamespace(Text=text, Confidence=confidence))
        def cancel():
            engine.cancelled = True
            event.emit(cancelled=True)
        def stop():
            engine.stopped = True
            event.emit()
        engine.RecognizeAsync = start
        engine.RecognizeAsyncCancel = cancel
        engine.RecognizeAsyncStop = stop
        return engine

    def run_worker(self, engine, job=None, progress_events=None, **kwargs):
        results = []
        bridge = SimpleNamespace(speech_done=SimpleNamespace(emit=lambda *args: results.append((*args, engine.disposed))))
        if progress_events is not None:
            bridge.recognition_progress = SimpleNamespace(emit=lambda *args: progress_events.append(args))
        recognize(bridge, job or RecognitionJob(1), engine_factory=lambda _: engine, recognize_mode='single', **kwargs)
        return results

    def test_recognition_emits_after_disposal_and_preserves_low_confidence_for_confirmation(self):
        good = self.run_worker(self.engine())
        self.assertEqual(good[0][1:], ('测试语音', None, True))
        job = RecognitionJob(1, submit_mode='auto')
        low = self.run_worker(self.engine(confidence=.1), job)
        self.assertEqual(low[0][1], '测试语音')
        self.assertTrue(job.requires_confirmation)

    def test_cancellation_releases_the_device_and_discards_late_transcript(self):
        engine, job, result = self.engine(hold=True), RecognitionJob(1), []
        thread = threading.Thread(target=lambda: result.extend(self.run_worker(engine, job)))
        thread.start()
        self.assertTrue(engine.started.wait(1))
        job.cancel()
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertTrue(engine.cancelled)
        self.assertTrue(engine.disposed)
        self.assertEqual(result[0][1], '')

    def test_timeout_is_bounded_and_does_not_auto_submit_a_partial_phrase(self):
        result = self.run_worker(self.engine(hold=True), RecognitionJob(1, submit_mode='auto'), timeout=.02)
        self.assertEqual(result[0][1], '')
        self.assertIn('识别时限', result[0][2])

    def test_cancelled_before_start_does_not_open_a_device(self):
        engine, job = self.engine(), RecognitionJob(1)
        job.cancel()
        result = self.run_worker(engine, job)
        self.assertFalse(engine.input_set)
        self.assertEqual(result[0][1], '')

    def test_manual_finish_flushes_confirmed_words_with_stop_instead_of_cancel(self):
        engine, job, result, updates = self.engine(hold=True), RecognitionJob(1), [], []
        thread = threading.Thread(target=lambda: result.extend(self.run_worker(engine, job, progress_events=updates)))
        thread.start()
        self.assertTrue(engine.started.wait(1))
        engine.AudioLevelUpdated.emit(AudioLevel=30)
        engine.SpeechDetected.emit()
        engine.SpeechHypothesized.emit(SimpleNamespace(Text='正在说', Confidence=.3))
        engine.SpeechRecognized.emit(SimpleNamespace(Text='完整句子', Confidence=.7))
        job.finish()
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertTrue(engine.stopped)
        self.assertFalse(engine.cancelled)
        self.assertEqual(result[0][1:], ('完整句子', None, True))
        self.assertTrue({'ready', 'level', 'speech', 'hypothesis', 'recognized', 'finishing'}.issubset({u[1]['kind'] for u in updates}))

    def test_sensitivity_accepts_soft_results_without_discarding_uncertain_text(self):
        for sensitivity, uncertain in [('high', False), ('normal', True), ('low', True)]:
            job = RecognitionJob(1, submit_mode='auto', sensitivity=sensitivity)
            result = self.run_worker(self.engine(confidence=.2), job)
            self.assertEqual(result[0][1], '测试语音')
            self.assertEqual(job.requires_confirmation, uncertain)

    def test_repeated_phrases_are_preserved_and_completed_result_is_not_duplicated(self):
        engine, job, result = self.engine(hold=True), RecognitionJob(1, prefix='已确认'), []
        thread = threading.Thread(target=lambda: result.extend(self.run_worker(engine, job)))
        thread.start()
        self.assertTrue(engine.started.wait(1))
        phrase = SimpleNamespace(Text='是', Confidence=.8)
        engine.SpeechRecognized.emit(phrase)
        engine.SpeechRecognized.emit(phrase)
        engine.RecognizeCompleted.emit(phrase)
        thread.join(timeout=2)
        self.assertEqual(result[0][1], '已确认 是 是')

    def test_rejected_candidates_remain_available_for_manual_confirmation(self):
        engine, job, result, updates = self.engine(hold=True), RecognitionJob(1), [], []
        thread = threading.Thread(target=lambda: result.extend(self.run_worker(engine, job, progress_events=updates)))
        thread.start()
        self.assertTrue(engine.started.wait(1))
        engine.SpeechRecognitionRejected.emit(SimpleNamespace(Text='不太确定的文字', Confidence=.05))
        engine.RecognizeCompleted.emit()
        thread.join(timeout=2)
        self.assertEqual(result[0][1], '')
        self.assertEqual(job.text(partial=True), '不太确定的文字')
        self.assertTrue(job.requires_confirmation)

    def test_manual_deadline_stops_for_confirmation_without_erasing_words(self):
        engine, job = self.engine(hold=True), RecognitionJob(1, prefix='已经听到的文字')
        result = self.run_worker(engine, job, timeout=.02)
        self.assertTrue(engine.stopped)
        self.assertTrue(job.timed_out)
        self.assertEqual(result[0][1:], ('已经听到的文字', None, True))

    def test_audio_level_property_is_polled_when_no_level_event_arrives(self):
        engine, updates = self.engine(hold=True), []
        engine.AudioLevel = 27
        self.run_worker(engine, RecognitionJob(1), timeout=.12, progress_events=updates)
        self.assertTrue(any(u[1].get('level') == 27 for u in updates))


if __name__ == '__main__':
    unittest.main()
