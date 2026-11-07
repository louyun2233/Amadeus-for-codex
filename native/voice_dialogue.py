"""Explicit voice-session state and cancellable Windows dictation; no audio uploads."""
import os
import threading
import time
from pathlib import Path

CONFIDENCE_THRESHOLDS = {'low': .45, 'normal': .25, 'high': .12}


def join_transcript(*parts):
    return ' '.join(str(part).strip() for part in parts if str(part).strip())


class RecognitionJob:
    def __init__(self, generation, *, submit_mode='manual', sensitivity='high', prefix=''):
        self.generation = generation
        self.cancelled = threading.Event()
        self.finish_requested = threading.Event()
        self.submit_mode = submit_mode if submit_mode in ('auto', 'manual') else 'manual'
        self.min_confidence = CONFIDENCE_THRESHOLDS.get(sensitivity, CONFIDENCE_THRESHOLDS['high'])
        self.prefix = str(prefix).strip()
        self.fragments = []
        self.hypothesis = ''
        self.requires_confirmation = False
        self.ready = False
        self.timed_out = False
        self.speech_detected = False
        self.max_audio_level = 0
        self.saw_recognized = False
        self.lock = threading.RLock()

    def cancel(self):
        self.cancelled.set()

    def finish(self):
        self.finish_requested.set()

    def text(self, *, partial=False):
        with self.lock:
            return join_transcript(self.prefix, *self.fragments, self.hypothesis if partial else '')


class VoiceDialogue:
    def __init__(self):
        self.active = False
        self.generation = 0
        self.capture = None
        self.session_id = None
        self.waiting_reply = False
        self.request_id = None
        self.expected_audio = set()
        self.finished_audio = set()
        self.ignored_turns = set()
        self.empty_count = 0
        self.submit_mode = 'auto'
        self.sensitivity = 'high'

    def start(self, *, submit_mode='auto', sensitivity='high'):
        self.generation += 1
        self.active = True
        self.session_id = None
        self.request_id = None
        self.waiting_reply = False
        self.expected_audio.clear()
        self.finished_audio.clear()
        self.ignored_turns.clear()
        self.empty_count = 0
        self.submit_mode = submit_mode if submit_mode in ('auto', 'manual') else 'auto'
        self.sensitivity = sensitivity if sensitivity in CONFIDENCE_THRESHOLDS else 'high'

    def stop(self):
        session = self.session_id
        self.active = False
        self.generation += 1
        self.cancel_capture()
        self.session_id = None
        self.request_id = None
        self.waiting_reply = False
        self.expected_audio.clear()
        self.finished_audio.clear()
        return session

    def cancel_capture(self):
        if self.capture:
            self.capture.cancel()

    def begin_capture(self, prefix=''):
        if not self.active or self.capture or self.waiting_reply or self.expected_audio - self.finished_audio:
            return None
        self.capture = RecognitionJob(self.generation, submit_mode=self.submit_mode, sensitivity=self.sensitivity, prefix=prefix)
        return self.capture

    def finish_capture(self, job):
        if job is not self.capture:
            return False
        self.capture = None
        return self.active and job.generation == self.generation and not job.cancelled.is_set()

    def submitted(self):
        self.waiting_reply = True
        self.expected_audio.clear()
        self.finished_audio.clear()
        self.empty_count = 0

    def replied(self, speech_ids):
        self.waiting_reply = False
        self.expected_audio = set(speech_ids)

    def may_listen(self):
        return self.active and not self.capture and not self.waiting_reply and not (self.expected_audio - self.finished_audio)


def windows_engine(language):
    import clr
    dll = Path(os.environ['WINDIR']) / 'Microsoft.NET/Framework64/v4.0.30319/WPF/System.Speech.dll'
    clr.AddReference(str(dll))
    from System import TimeSpan
    from System.Speech.Recognition import DictationGrammar, SpeechRecognitionEngine
    recognizers = [item for item in SpeechRecognitionEngine.InstalledRecognizers()
                   if str(item.Culture).lower() == language.lower()]
    if not recognizers:
        raise RuntimeError(f'Windows {language} 听写引擎未安装，请在 Windows 设置中安装相应的语音识别包')
    engine = SpeechRecognitionEngine(recognizers[0])
    try:
        engine.LoadGrammar(DictationGrammar())
        engine.InitialSilenceTimeout = TimeSpan.FromSeconds(6)
        engine.BabbleTimeout = TimeSpan.FromSeconds(8)
        engine.EndSilenceTimeout = TimeSpan.FromMilliseconds(700)
        engine.EndSilenceTimeoutAmbiguous = TimeSpan.FromMilliseconds(1000)
        return engine
    except Exception:
        engine.Dispose()
        raise


def recognize(bridge, job, language='zh-CN', *, engine_factory=windows_engine, timeout=None,
              configure_input=None, recognize_mode=None):
    """Stream local feedback; finish flushes speech, cancellation discards it."""
    engine = None
    completed = threading.Event()
    outcome = {'error': None}
    subscriptions = []
    last_level_at = -float('inf')
    timeout = timeout if timeout is not None else (60 if job.submit_mode == 'manual' else 30)

    def progress(kind, **fields):
        if job.cancelled.is_set():
            return
        signal = getattr(bridge, 'recognition_progress', None)
        if signal is not None:
            try:
                signal.emit(job, {'kind': kind, **fields})
            except RuntimeError:
                pass

    def recognized(result):
        if result is None or job.cancelled.is_set():
            return
        text = str(result.Text or '').strip()
        if not text:
            return
        confidence = float(result.Confidence)
        with job.lock:
            job.fragments.append(text)
            job.hypothesis = ''
            job.saw_recognized = True
            job.requires_confirmation |= confidence < job.min_confidence
        progress('recognized', text=job.text(), confidence=confidence, uncertain=job.requires_confirmation)

    def on_recognized(_sender, args):
        recognized(args.Result)

    def on_hypothesis(_sender, args):
        if args.Result is None:
            return
        with job.lock:
            job.hypothesis = str(args.Result.Text or '').strip()
        progress('hypothesis', text=job.text(partial=True))

    def on_rejected(_sender, args):
        if args.Result is not None:
            with job.lock:
                job.hypothesis = str(args.Result.Text or '').strip()
                job.requires_confirmation = True
        progress('unconfirmed', text=job.text(partial=True))

    def on_detected(_sender, _args):
        job.speech_detected = True
        progress('speech')

    def publish_level(value):
        nonlocal last_level_at
        level = max(0, min(100, int(value)))
        job.max_audio_level = max(job.max_audio_level, level)
        now = time.monotonic()
        if now - last_level_at >= .10:
            last_level_at = now
            progress('level', level=level)

    def on_level(_sender, args):
        publish_level(args.AudioLevel)

    def on_completed(_sender, args):
        if not job.cancelled.is_set():
            try:
                if args.Error is not None:
                    outcome['error'] = str(args.Error.Message)
                elif not args.Cancelled and args.Result is not None and not job.saw_recognized:
                    recognized(args.Result)
            except Exception as error:
                outcome['error'] = str(error)
        completed.set()

    try:
        if not job.cancelled.is_set():
            engine = engine_factory(language)
            if not job.cancelled.is_set():
                for name, callback in [('RecognizeCompleted', on_completed), ('SpeechRecognized', on_recognized),
                                       ('SpeechHypothesized', on_hypothesis), ('SpeechRecognitionRejected', on_rejected),
                                       ('SpeechDetected', on_detected), ('AudioLevelUpdated', on_level)]:
                    event = getattr(engine, name, None)
                    if event is not None:
                        event.__iadd__(callback)
                        subscriptions.append((event, callback))
                if configure_input:
                    configure_input(engine)
                else:
                    engine.SetInputToDefaultAudioDevice()
                if recognize_mode is None:
                    from System.Speech.Recognition import RecognizeMode
                    recognize_mode = RecognizeMode.Multiple if job.submit_mode == 'manual' else RecognizeMode.Single
                if not job.cancelled.is_set():
                    engine.RecognizeAsync(recognize_mode)
                    job.ready = True
                    progress('ready')
                    deadline = time.monotonic() + timeout
                    while not completed.wait(.05):
                        if time.monotonic() - last_level_at >= .1:
                            try:
                                level = getattr(engine, 'AudioLevel', None)
                                if level is not None:
                                    publish_level(level)
                            except Exception:
                                pass  # Feedback failure must not discard recognized words.
                        if job.cancelled.is_set():
                            engine.RecognizeAsyncCancel()
                            completed.wait(2)
                            break
                        expired = time.monotonic() >= deadline
                        if job.finish_requested.is_set() or expired:
                            job.timed_out = expired
                            if expired and job.submit_mode == 'auto':
                                outcome['error'] = '这一句超过了识别时限，请分句说；本次未发送'
                            progress('finishing')
                            engine.RecognizeAsyncStop()
                            if not completed.wait(3):
                                engine.RecognizeAsyncCancel()
                                completed.wait(1)
                                outcome['error'] = '暂时无法完成识别，文字已保留，请重试'
                            break
    except Exception as error:
        if not job.cancelled.is_set():
            outcome['error'] = str(error)
    finally:
        if engine is not None:
            for event, callback in subscriptions:
                try:
                    event.__isub__(callback)
                except Exception:
                    pass
            try:
                engine.Dispose()
            except Exception:
                pass
        try:
            bridge.speech_done.emit(job, job.text() if not job.cancelled.is_set() else '', outcome['error'])
        except RuntimeError:
            pass  # The Qt receiver may have been destroyed while cancelling.
