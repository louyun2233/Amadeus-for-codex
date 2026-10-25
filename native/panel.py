"""Browser-free Windows panel. Qt widgets + OpenGL/Cubism 2, no WebEngine."""

import base64
import array
import ctypes
import html
import json
import math
import mimetypes
import os
import random
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from windows_taskbar import set_process_identity, set_window_identity

import live2d
from OpenGL.GL import glViewport
from PySide6.QtCore import QObject, QPointF, QRect, QRectF, QSize, Qt, QTimer, Signal
from PySide6.QtGui import QColor, QIcon, QLinearGradient, QPainter, QPen, QPixmap, QPolygonF
from PySide6.QtOpenGLWidgets import QOpenGLWidget
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QComboBox, QFileDialog, QFrame, QHBoxLayout,
    QGraphicsDropShadowEffect, QInputDialog, QLabel, QLineEdit, QListWidget, QMainWindow, QMenu, QMessageBox,
    QPlainTextEdit, QPushButton, QScrollArea, QStackedLayout, QStackedWidget, QTabWidget, QVBoxLayout, QWidget,
)


MAX_IMAGE = 3 * 1024 * 1024


def playable_wav(data):
    """Fill streaming RIFF/data lengths so Windows MCI accepts Qwen's WAV."""
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        return data
    if int.from_bytes(data[4:8], "little") <= len(data) - 8:
        return data
    fixed = bytearray(data)
    fixed[4:8] = (len(data) - 8).to_bytes(4, "little")
    offset = 12
    while offset + 8 <= len(data):
        chunk = data[offset:offset + 4]
        length = int.from_bytes(data[offset + 4:offset + 8], "little")
        if chunk == b"data":
            if length > len(data) - offset - 8:
                fixed[offset + 4:offset + 8] = (len(data) - offset - 8).to_bytes(4, "little")
            break
        if length > len(data) - offset - 8:
            break
        offset += 8 + length + (length & 1)
    return bytes(fixed)


def scale_wav_pcm16(data, volume):
    """Adjust user WAV ring loudness without changing the Windows master volume."""
    if volume >= 1 or len(data) < 44 or data[:4] != b"RIFF":
        return data
    offset, pcm16, sound = 12, False, None
    while offset + 8 <= len(data):
        chunk = data[offset:offset + 4]
        size = int.from_bytes(data[offset + 4:offset + 8], "little")
        end = offset + 8 + size
        if end > len(data):
            break
        if chunk == b"fmt " and size >= 16:
            fmt = int.from_bytes(data[offset + 8:offset + 10], "little")
            bits = int.from_bytes(data[offset + 22:offset + 24], "little")
            pcm16 = fmt == 1 and bits == 16
        elif chunk == b"data":
            sound = (offset + 8, end)
            break
        offset = end + (size & 1)
    if not pcm16 or not sound:
        return data
    start, end = sound
    samples = array.array("h")
    samples.frombytes(data[start:end - ((end - start) & 1)])
    gain = max(0.0, min(1.0, volume))
    for index, sample in enumerate(samples):
        samples[index] = int(sample * gain)
    return data[:start] + samples.tobytes() + data[start + len(samples) * 2:]


class Api:
    def __init__(self, url):
        parsed = urllib.parse.urlparse(url)
        if parsed.hostname != "127.0.0.1" or parsed.scheme != "http":
            raise ValueError("Amadeus requires a loopback daemon address")
        token = urllib.parse.parse_qs(parsed.query).get("token", [""])[0]
        if not token:
            raise ValueError("Missing daemon token")
        self.base = f"http://127.0.0.1:{parsed.port}"
        self.token = token
        self.client = "native-" + uuid.uuid4().hex[:20]
        self.welcome = "welcome=1" in parsed.fragment

    def request(self, path, method="GET", payload=None, binary=False, timeout=25):
        body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            self.base + path, data=body, method=method,
            headers={
                "Authorization": "Bearer " + self.token,
                "X-Amadeus-Client": self.client,
                **({"Content-Type": "application/json"} if body is not None else {}),
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                data = response.read()
                return (data, response.headers.get("Content-Type", "")) if binary else json.loads(data)
        except urllib.error.HTTPError as error:
            try:
                message = json.loads(error.read()).get("error", error.reason)
            except Exception:
                message = error.reason
            raise RuntimeError(f"HTTP {error.code}: {message}") from error


class Bridge(QObject):
    result = Signal(str, object)
    failed = Signal(str, str)
    event = Signal(str, object)
    audio_done = Signal(object, object)
    speech_done = Signal(object, object)
    talking = Signal(bool)


class StatusChip(QLabel):
    def __init__(self):
        super().__init__()
        self.setObjectName("statusChip")
        self.setFixedHeight(22)
        self.setMaximumWidth(158)
        self.setAlignment(Qt.AlignRight | Qt.AlignVCenter)

    def setText(self, value):
        full = str(value)
        short = self.fontMetrics().elidedText(full, Qt.TextElideMode.ElideRight, 131)
        dot = "#e0a06a" if "失败" in full or "错误" in full or "中断" in full else "#7fd47f"
        super().setText(f'<span style="color:{dot}">●</span>  {html.escape(short)}')
        self.setToolTip(full)


class HistoryView(QScrollArea):
    def __init__(self):
        super().__init__()
        self.setObjectName("history")
        self.setWidgetResizable(True)
        self.setFrameShape(QFrame.Shape.NoFrame)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.host = QWidget()
        self.host.setObjectName("historyHost")
        self.items = QVBoxLayout(self.host)
        self.items.setContentsMargins(7, 7, 7, 7)
        self.items.setSpacing(8)
        self.items.addStretch(1)
        self.setWidget(self.host)

    def clear(self):
        while self.items.count() > 1:
            child = self.items.takeAt(0)
            if child.widget():
                child.widget().deleteLater()

    def add_entry(self, role, text):
        row = QWidget()
        row.setObjectName("messageRow")
        line = QHBoxLayout(row)
        line.setContentsMargins(0, 0, 0, 0)
        bubble = QFrame()
        bubble.setObjectName("userBubble" if role == "user" else "systemBubble" if role == "system" else "assistantBubble")
        bubble.setMaximumWidth(215)
        inside = QVBoxLayout(bubble)
        inside.setContentsMargins(9, 6, 9, 5)
        inside.setSpacing(2)
        label = QLabel(str(text))
        label.setWordWrap(True)
        label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        label.setStyleSheet("background:transparent;border:none")
        stamp = QLabel(time.strftime("%H:%M"))
        stamp.setObjectName("bubbleTime")
        inside.addWidget(label)
        inside.addWidget(stamp)
        if role == "user":
            line.addStretch(1)
            line.addWidget(bubble)
        elif role == "system":
            line.addStretch(1)
            line.addWidget(bubble)
            line.addStretch(1)
        else:
            line.addWidget(bubble)
            line.addStretch(1)
        self.items.insertWidget(self.items.count() - 1, row)
        QTimer.singleShot(0, self.scrollToBottom)

    def scrollToBottom(self):
        self.verticalScrollBar().setValue(self.verticalScrollBar().maximum())


class DraggableFrame(QFrame):
    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.window().begin_window_drag(event.globalPosition().toPoint())
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        if event.buttons() & Qt.MouseButton.LeftButton:
            self.window().drag_window(event.globalPosition().toPoint())
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        self.window().end_window_drag()
        super().mouseReleaseEvent(event)


class PhoneFrame(DraggableFrame):
    def paintEvent(self, event):
        super().paintEvent(event)
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.setPen(QPen(QColor(228, 116, 67, 90), 1))
        painter.drawRoundedRect(QRectF(3, 3, self.width() - 6, self.height() - 6), 7, 7)
        painter.setPen(QPen(QColor(16, 3, 4, 190), 1))
        painter.drawLine(8, 12, 8, self.height() - 12)
        painter.drawLine(self.width() - 8, 12, self.width() - 8, self.height() - 12)
        painter.setPen(QPen(QColor(242, 143, 80, 75), 1))
        for x, length in ((18, 18), (63, 11), (self.width() - 46, 16)):
            painter.drawLine(x, self.height() - 10, x + length, self.height() - 10)


class ResizeGrip(QWidget):
    """Resize the frameless panel while preserving the phone's 15:26 outline."""

    def __init__(self, parent):
        super().__init__(parent)
        self.start = None
        self.setCursor(Qt.CursorShape.SizeFDiagCursor)
        self.setToolTip("拖动调整面板大小")

    def mousePressEvent(self, event):
        if event.button() != Qt.MouseButton.LeftButton:
            return super().mousePressEvent(event)
        self.start = (event.globalPosition().toPoint(), self.window().width())
        self.grabMouse()
        event.accept()

    def mouseMoveEvent(self, event):
        if self.start is None:
            return super().mouseMoveEvent(event)
        origin, original_width = self.start
        delta = event.globalPosition().toPoint() - origin
        width_delta = (delta.x() if abs(delta.x()) >= abs(delta.y()) * 15 / 26
                       else delta.y() * 15 / 26)
        screen = self.window().windowHandle().screen()
        area = screen.availableGeometry()
        maximum = min(area.width(), round(area.height() * 15 / 26))
        width = max(270, min(maximum, round(original_width + width_delta)))
        self.window().resize(width, round(width * 26 / 15))
        event.accept()

    def mouseReleaseEvent(self, event):
        if self.start is not None:
            self.start = None
            self.releaseMouse()
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setPen(QPen(QColor(242, 143, 80, 190), 1.5))
        for offset in (5, 9, 13):
            painter.drawLine(self.width() - offset, self.height() - 3,
                             self.width() - 3, self.height() - offset)


class GlossCallFrame(DraggableFrame):
    def paintEvent(self, event):
        super().paintEvent(event)
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        width, height = self.width(), self.height()
        sheen = QLinearGradient(0, 0, width, height)
        sheen.setColorAt(0, QColor(236, 224, 171, 46))
        sheen.setColorAt(0.55, QColor(161, 152, 118, 21))
        sheen.setColorAt(1, QColor(10, 10, 10, 8))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(sheen)
        painter.drawPolygon(QPolygonF([
            QPointF(0, 0), QPointF(width * 0.55, 0),
            QPointF(width * 0.83, height), QPointF(width * 0.44, height),
        ]))
        painter.setPen(QPen(QColor(255, 216, 139, 7), 1))
        for y in range(3, height, 5):
            painter.drawLine(0, y, width, y)


class SpriteSplash(QWidget):
    finished = Signal()
    COLUMNS = 7
    FRAME_SIZE = 246
    FRAME_COUNT = 38

    def __init__(self, parent=None):
        super().__init__(parent)
        self.sheet = QPixmap(str(Path(__file__).with_name("sprite_logo.png")))
        self.frame = 0
        self.hold = 0
        self.opacity = 1.0
        self.timer = QTimer(self)
        self.timer.setInterval(55)
        self.timer.timeout.connect(self.advance)

    def start(self):
        self.frame = 0
        self.hold = 0
        self.opacity = 1.0
        if self.sheet.isNull():
            self.finished.emit()
            return
        self.timer.start()
        self.update()

    def stop(self):
        self.timer.stop()

    def advance(self):
        if self.frame < self.FRAME_COUNT - 1:
            self.frame += 1
        elif self.hold < 7:
            self.hold += 1
        else:
            self.opacity = max(0.0, self.opacity - 0.16)
            if self.opacity == 0:
                self.timer.stop()
                self.finished.emit()
        self.update()

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor(0, 0, 0))
        if self.sheet.isNull():
            return
        side = int(min(self.width() * 0.91, self.height() * 1.35))
        target = QRect((self.width() - side) // 2, (self.height() - side) // 2, side, side)
        source = QRect((self.frame % self.COLUMNS) * self.FRAME_SIZE,
                       (self.frame // self.COLUMNS) * self.FRAME_SIZE,
                       self.FRAME_SIZE, self.FRAME_SIZE)
        painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        painter.setOpacity(self.opacity)
        painter.drawPixmap(target, self.sheet, source)


class HingeBar(DraggableFrame):
    pass


class SettingsRows:
    DESCRIPTIONS = {
        "语音朗读": "面板打开时朗读 Amadeus 的回复",
        "来电铃声": "来电时播放单独的提示音",
        "本机语音输入": "本机识别，录音留在电脑上",
        "单句模式": "每轮回答后断开对话上下文",
        "长期记忆": "允许召回和查看长期事实",
        "自动提取事实": "从聊天中识别长期有效的信息",
        "任务播报": "用当前声线播报 Codex 任务",
        "合成服务": "选择已配置的语音来源",
        "音色 ID": "填写已克隆或导入的音色 ID",
    }

    def __init__(self, host):
        self.layout = QVBoxLayout(host)
        self.layout.setContentsMargins(7, 4, 7, 4)
        self.layout.setSpacing(0)
        self.layout.addStretch(1)

    def addRow(self, label, control):
        row = QFrame()
        row.setObjectName("settingsRow")
        line = QHBoxLayout(row)
        line.setContentsMargins(5, 7, 5, 7)
        line.setSpacing(7)
        if label:
            left = QWidget()
            left.setStyleSheet("background:transparent")
            texts = QVBoxLayout(left)
            texts.setContentsMargins(0, 0, 0, 0)
            texts.setSpacing(1)
            title = QLabel(label)
            texts.addWidget(title)
            description = self.DESCRIPTIONS.get(label)
            if description:
                hint = QLabel(description)
                hint.setObjectName("settingsDescription")
                hint.setWordWrap(True)
                texts.addWidget(hint)
            line.addWidget(left, 1)
            if not isinstance(control, QCheckBox):
                control.setMaximumWidth(125)
        line.addWidget(control)
        self.layout.insertWidget(self.layout.count() - 1, row)


class EventReader(threading.Thread):
    def __init__(self, api, bridge, stop):
        super().__init__(daemon=True)
        self.api, self.bridge, self.stop = api, bridge, stop

    def run(self):
        url = self.api.base + "/amadeus/events?client=" + self.api.client
        while not self.stop.is_set():
            req = urllib.request.Request(url, headers={"Authorization": "Bearer " + self.api.token})
            try:
                with urllib.request.urlopen(req, timeout=35) as response:
                    self.bridge.event.emit("connected", {})
                    kind, lines = "", []
                    while not self.stop.is_set():
                        raw = response.readline()
                        if not raw:
                            break
                        line = raw.decode("utf-8", "replace").rstrip("\r\n")
                        if line.startswith("event:"):
                            kind = line[6:].strip()
                        elif line.startswith("data:"):
                            lines.append(line[5:].strip())
                        elif not line:
                            if kind and lines:
                                try:
                                    self.bridge.event.emit(kind, json.loads("\n".join(lines)))
                                except ValueError:
                                    pass
                            kind, lines = "", []
            except Exception:
                self.bridge.event.emit("offline", {})
                self.stop.wait(3)


class Live2DView(QOpenGLWidget):
    tapped = Signal()
    gl_initialized = Signal()

    def __init__(self):
        super().__init__()
        self.model = None
        self.gl_ready = False
        self.motion_map = {}
        self.expression_map = {}
        self.last_click = None
        self.talking = False
        self.talk_start = 0.0
        self.last_motion = {}
        self.model_motions = {}
        self.model_expressions = []
        self.setMinimumHeight(0)
        self.setMouseTracking(True)
        self.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.customContextMenuRequested.connect(self.show_model_menu)

    def initializeGL(self):
        live2d.glInit()
        self.gl_ready = True
        self.startTimer(33)
        self.gl_initialized.emit()

    def load(self, entry, motion_map, expression_map):
        if not self.gl_ready:
            raise RuntimeError("Live2D OpenGL context is not ready")
        if not entry or not Path(entry).is_file():
            raise FileNotFoundError("Live2D model is missing")
        self.makeCurrent()
        try:
            self.model = live2d.Model()
            self.model.LoadModelJson(str(entry))
            self.model.Resize(self.width(), self.height())
            self.model.SetAutoBlink(True)
            self.model.SetAutoBreath(True)
            self.motion_map = motion_map or {}
            self.expression_map = expression_map or {}
            model_data = json.loads(Path(entry).read_text(encoding="utf-8"))
            self.model_motions = model_data.get("motions") or {}
            self.model_expressions = [item.get("name") for item in model_data.get("expressions", []) if item.get("name")]
            self.model.StartRandomMotion(group="idle", priority=live2d.MotionPriority.IDLE)
        finally:
            self.doneCurrent()
        self.update()

    def resizeGL(self, width, height):
        glViewport(0, 0, width, height)
        if self.model:
            self.model.Resize(width, height)

    def paintGL(self):
        live2d.clearBuffer()
        if self.model:
            self.model.Update()
            if self.talking:
                value = 0.25 + 0.35 * abs(math.sin((time.monotonic() - self.talk_start) * 15))
                self.model.SetParamById("PARAM_MOUTH_OPEN_Y", value)
            self.model.Draw()

    def timerEvent(self, event):
        if self.model and self.model.IsMotionFinished():
            self.model.StartRandomMotion(group="idle", priority=live2d.MotionPriority.IDLE)
        self.update()

    def motion(self, name):
        if not self.model:
            return
        spec = self.motion_map.get(name) or {}
        group = spec.get("group") or name
        variants = min(20, max(1, int(spec.get("variants") or len(self.model_motions.get(group, [])) or 1)))
        self.play_group(group, variants)

    def play_group(self, group, variants):
        if not self.model:
            return
        previous = self.last_motion.get(group, -1)
        choices = [i for i in range(variants) if i != previous] or [0]
        index = random.choice(choices)
        self.last_motion[group] = index
        self.model.StartMotion(group, index, live2d.MotionPriority.FORCE)

    def show_model_menu(self, position):
        if not self.model:
            return
        menu = QMenu(self)
        for group, motions in self.model_motions.items():
            action = menu.addAction("动作 · " + group)
            action.triggered.connect(lambda checked=False, g=group, n=len(motions): self.play_group(g, n))
        menu.addSeparator()
        for expression in self.model_expressions:
            action = menu.addAction("表情 · " + expression)
            action.triggered.connect(lambda checked=False, e=expression: self.model.SetExpression(e))
        menu.addAction("表情 · 复位", self.model.ResetExpression)
        menu.exec(self.mapToGlobal(position))

    def emotion(self, name):
        if not self.model:
            return
        for expression, emotions in self.expression_map.items():
            if name in emotions:
                self.model.SetExpression(expression)
                return
        self.model.ResetExpression()

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton and event.position().y() < 28:
            self.window_drag = True
            self.window().begin_window_drag(event.globalPosition().toPoint())
            return
        self.window_drag = False
        self.last_click = event.position()

    def mouseMoveEvent(self, event):
        if getattr(self, "window_drag", False):
            self.window().drag_window(event.globalPosition().toPoint())
            return
        if self.model:
            self.model.Drag(event.position().x(), event.position().y())

    def mouseReleaseEvent(self, event):
        if getattr(self, "window_drag", False):
            self.window_drag = False
            self.window().end_window_drag()
            return
        if event.button() != Qt.MouseButton.LeftButton:
            self.last_click = None
            return
        if not self.last_click:
            return
        delta = event.position() - self.last_click
        if abs(delta.x()) > 55:
            self.motion("head")
        elif abs(delta.y()) > 55:
            self.motion("other")
        elif event.position().y() < self.height() * 0.52:
            self.motion("head")
        else:
            self.motion("body")
        self.last_click = None
        self.tapped.emit()


class MciAudio:
    def __init__(self, bridge):
        self.bridge = bridge
        self.lock = threading.Lock()
        self.active = {}
        self.generation = {}
        self.winmm = ctypes.windll.winmm
        self.winmm.mciSendStringW.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint, ctypes.c_void_p]
        self.winmm.mciSendStringW.restype = ctypes.c_uint

    def _command(self, command):
        output = ctypes.create_unicode_buffer(256)
        code = self.winmm.mciSendStringW(command, output, 255, None)
        if code:
            raise RuntimeError(f"Windows media error {code}")
        return output.value

    def stop(self, lane):
        with self.lock:
            self.generation[lane] = self.generation.get(lane, 0) + 1
            state = self.active.get(lane)
        if state:
            state["stop"].set()
            if state["owner"] != threading.get_ident():
                state["done"].wait(1.5)

    def play(self, lane, data, suffix, loop=False, item=None, volume=1.0, cancel_event=None):
        self.stop(lane)
        with self.lock:
            generation = self.generation.get(lane, 0)
        if suffix.lower() == ".wav":
            data = scale_wav_pcm16(playable_wav(data), volume)
        handle = tempfile.NamedTemporaryFile(prefix="amadeus-native-", suffix=suffix, delete=False)
        path = Path(handle.name)
        state = None
        error = None
        try:
            handle.write(data)
            handle.close()
            alias = "amadeus" + uuid.uuid4().hex[:12]
            with self.lock:
                if self.generation.get(lane, 0) != generation or (cancel_event and cancel_event.is_set()):
                    return
                self._command(f'open "{path}" alias {alias}')
                state = {"alias": alias, "path": path, "stop": threading.Event(),
                         "done": threading.Event(), "owner": threading.get_ident()}
                self.active[lane] = state
                if cancel_event and cancel_event.is_set():
                    return
                try:
                    self._command(f"setaudio {alias} volume to {round(max(0, min(1, volume)) * 1000)}")
                except Exception:
                    pass
                self._command(f"play {alias}")
            while not state["stop"].wait(0.05):
                with self.lock:
                    if self.active.get(lane) is not state:
                        break
                    if self._command(f"status {alias} mode").lower() not in ("playing", "paused"):
                        if not loop:
                            break
                        self._command(f"seek {alias} to start")
                        self._command(f"play {alias}")
        except Exception as exc:
            error = str(exc)
        finally:
            try:
                handle.close()
            except Exception:
                pass
            if state:
                for command in (f"stop {state['alias']}", f"close {state['alias']}"):
                    try:
                        self._command(command)
                    except Exception:
                        pass
                with self.lock:
                    if self.active.get(lane) is state:
                        self.active.pop(lane, None)
                state["done"].set()
            for _ in range(5):
                try:
                    path.unlink(missing_ok=True)
                    break
                except PermissionError:
                    time.sleep(0.05)
            if item and (not loop or error):
                self.bridge.audio_done.emit(item, error)


def recognize_once(bridge):
    try:
        import clr
        dll = Path(os.environ["WINDIR"]) / "Microsoft.NET/Framework64/v4.0.30319/WPF/System.Speech.dll"
        clr.AddReference(str(dll))
        from System import TimeSpan
        from System.Speech.Recognition import DictationGrammar, SpeechRecognitionEngine
        recognizers = [item for item in SpeechRecognitionEngine.InstalledRecognizers()
                       if str(item.Culture).lower() == "zh-cn"]
        if not recognizers:
            raise RuntimeError("Windows 中文听写引擎未安装")
        engine = SpeechRecognitionEngine(recognizers[0])
        try:
            engine.LoadGrammar(DictationGrammar())
            engine.SetInputToDefaultAudioDevice()
            result = engine.Recognize(TimeSpan.FromSeconds(12))
            bridge.speech_done.emit(str(result.Text) if result else "", None)
        finally:
            engine.Dispose()
    except Exception as error:
        bridge.speech_done.emit("", str(error))


class Panel(QMainWindow):
    def __init__(self, api):
        super().__init__()
        self.api = api
        self.bridge = Bridge()
        self.pool = ThreadPoolExecutor(max_workers=5)
        self.stop_event = threading.Event()
        self.audio = MciAudio(self.bridge)
        self.config = {}
        self.session_id = None
        self.turn_id = None
        self.pending_turn = False
        self.pending_events = []
        self.attachment = None
        self.call_item = None
        self.ring_ticket = 0
        self.ring_cancel = threading.Event()
        self.audio_queue = []
        self.audio_busy = False
        self.seen_utterances = set()
        self.welcome_started = False
        self.booting = True
        self.boot_status = None
        self.drag_offset = None
        self.migrated_input = False
        self.last_tap_speech = 0.0
        self.character_content = {}
        self.pending_model = None
        self.setWindowTitle("AMADEUS")
        self.setWindowFlags(Qt.WindowType.Window | Qt.WindowType.FramelessWindowHint)
        self.resize(300, 520)
        self.setMinimumSize(270, 468)
        self._build()
        self.resize_grip = ResizeGrip(self)
        self.resize_grip.setFixedSize(20, 20)
        self.resize_grip.move(self.width() - 20, self.height() - 20)
        self.resize_grip.raise_()
        self.bridge.result.connect(self._on_result)
        self.bridge.failed.connect(self._on_failed)
        self.bridge.event.connect(self._on_event)
        self.bridge.audio_done.connect(self._on_audio_done)
        self.bridge.speech_done.connect(self._on_speech_done)
        self.bridge.talking.connect(self._set_talking)
        self.avatar.gl_initialized.connect(lambda: QTimer.singleShot(0, self._load_pending_model))
        EventReader(api, self.bridge, self.stop_event).start()
        self.call("status", "/amadeus/status")
        self.call("assets", "/amadeus/assets/status")
        self.call("sessions", "/amadeus/sessions")
        QTimer.singleShot(0, self.refresh_clock)
        QTimer.singleShot(100, lambda: self.splash.start() if self.booting else None)

    def begin_window_drag(self, global_point):
        self.drag_offset = global_point - self.frameGeometry().topLeft()

    def drag_window(self, global_point):
        if self.drag_offset is not None:
            self.move(global_point - self.drag_offset)

    def end_window_drag(self):
        self.drag_offset = None

    def resizeEvent(self, event):
        super().resizeEvent(event)
        if hasattr(self, "resize_grip"):
            self.resize_grip.move(self.width() - 20, self.height() - 20)
            self.resize_grip.raise_()
        if hasattr(self, "screen"):
            height = (max(380, self.height() - 55)
                      if getattr(self, "booting", False) or getattr(self, "call_item", None)
                      else round(self.height() * 190 / 520))
            self.screen.setFixedHeight(height)

    def _build(self):
        self.setStyleSheet("""
            QWidget { color:#f4e7e4; font:12px 'Microsoft YaHei UI'; }
            QMainWindow { background:#1b0808; }
            QFrame#phone { background:qlineargradient(x1:0,y1:0,x2:1,y2:0,stop:0 #3a0c0e,stop:.025 #9d4a2d,stop:.055 #4b1816,stop:.095 #250a0c,stop:.905 #270b0c,stop:.945 #71301e,stop:.975 #aa572f,stop:1 #380e11); border:2px solid #854029; border-radius:7px; }
            QFrame#screen { background:#0a0b09; border:2px solid #713824; border-radius:2px; }
            QFrame#hinge { background:qlineargradient(x1:0,y1:0,x2:0,y2:1,stop:0 #130506,stop:.48 #853a26,stop:.55 #2c1010,stop:1 #120607); border-top:1px solid #ad6038; border-bottom:1px solid #100506; }
            QLabel#hingeBar { background:#6b3022; border:0; border-radius:2px; }
            QFrame#keypad { background:#1b0b0d; border:1px solid #693020; border-radius:2px; }
            QLabel#clock { background:transparent; color:#b79b96; font-size:12px; letter-spacing:1px; }
            QLabel#statusChip { background:rgba(0,0,0,155); border:1px solid #342c2d; border-radius:11px; padding:1px 7px; color:#b79b96; font-size:10px; }
            QTabWidget { background:#220e0f; }
            QTabWidget::pane { border:0; background:#1d0f13; }
            QTabBar { background:#200f14; }
            QTabBar::tab { background:#200f14; color:#b79b96; padding:6px 10px; border:0; min-width:31px; }
            QTabBar::tab:selected { background:#452027; color:#f08a70; border-radius:5px; }
            QTabBar::tab:hover { color:#f4e7e4; }
            QScrollArea#history, QWidget#historyHost { background:#1d0f13; border:0; }
            QFrame#userBubble { background:#3a1a20; border:1px solid #5d2b34; border-radius:9px; }
            QFrame#assistantBubble { background:#321a21; border:1px solid #47272f; border-radius:9px; }
            QFrame#systemBubble { background:transparent; border:1px dashed #654a4a; border-radius:9px; }
            QLabel#bubbleTime { color:#b79b96; background:transparent; font-size:10px; }
            QFrame#settingsRow { background:#220f14; border-bottom:1px solid #3a1c23; }
            QLabel#settingsDescription { color:#b79b96; background:transparent; font-size:10px; }
            QScrollBar:vertical { background:#220e0f; width:6px; }
            QScrollBar::handle:vertical { background:#5d333d; border-radius:3px; min-height:25px; }
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height:0; }
            QFrame#chatRow { background:#1d0e12; border-top:1px solid #3a1c23; }
            QFrame#hardware { background:qlineargradient(x1:0,y1:0,x2:0,y2:1,stop:0 #6a261d,stop:.14 #30100e,stop:.39 #170b09,stop:.76 #5a211b,stop:1 #8a3922); border-top:2px solid #a65c31; border-bottom:1px solid #1a0506; }
            QLabel#grille { color:#130908; background:transparent; font-size:16px; }
            QPushButton#hardwareKey { background:qradialgradient(cx:.4,cy:.35,radius:.65,stop:0 #5d2b22,stop:.6 #170a0b,stop:1 #090606); border:2px solid #8a4930; border-radius:11px; padding:0; }
            QPushButton { background:#2c171d; color:#b79b96; border:1px solid #5d333d; border-radius:7px; padding:4px 7px; }
            QPushButton:hover { color:#f4e7e4; border-color:#8d5663; }
            QPushButton#iconButton { min-width:28px; max-width:28px; min-height:28px; max-height:28px; padding:0; background:transparent; font-size:16px; }
            QLineEdit { background:#150a0d; border:1px solid #47272f; border-radius:7px; padding:5px 8px; }
            QLineEdit:focus { border-color:#e0604f; }
            QListWidget, QPlainTextEdit, QComboBox { background:#26141a; border:1px solid #47272f; border-radius:6px; padding:3px; }
            QFrame#callScreen { background:qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 #181910,stop:.5 #11120f,stop:1 #080909); border:0; }
            QLabel#callText { color:#e4c77f; font:16px Consolas; background:transparent; }
            QPushButton#connect { color:#ffdc82; font:bold 18px Georgia; background:qlineargradient(x1:0,y1:0,x2:0,y2:1,stop:0 #35140b,stop:.5 #641c0c,stop:1 #220b08); border:2px solid #ff9d27; border-radius:18px; min-height:38px; }
            QPushButton#decline { color:#b79b7a; font:10px Consolas; background:transparent; border:0; }
        """)
        check_icon = Path(__file__).with_name("check.svg").as_posix()
        self.setStyleSheet(self.styleSheet() +
            'QCheckBox::indicator { width:16px; height:16px; border:1px solid #8b4b55; border-radius:3px; background:#150a0d; }' +
            f'QCheckBox::indicator:checked {{ background:#e0604f; border-color:#e0604f; image:url("{check_icon}"); }}')
        center = PhoneFrame()
        center.setObjectName("phone")
        root = QVBoxLayout(center)
        root.setContentsMargins(7, 7, 7, 7)
        root.setSpacing(5)
        screen = QFrame()
        screen.setObjectName("screen")
        screen.setFixedHeight(190)
        self.screen = screen
        screen_stack = QStackedLayout(screen)
        screen_stack.setContentsMargins(0, 0, 0, 0)
        screen_stack.setStackingMode(QStackedLayout.StackingMode.StackAll)
        self.top = QStackedWidget()
        self.avatar = Live2DView()
        self.avatar.tapped.connect(self._on_avatar_tap)
        self.top.addWidget(self.avatar)
        call = GlossCallFrame()
        call.setObjectName("callScreen")
        self.call_screen = call
        call_layout = QVBoxLayout(call)
        call_layout.setContentsMargins(18, 9, 18, 20)
        call_layout.setSpacing(0)
        call_signal = QHBoxLayout()
        xp = QLabel("Xp")
        xp.setStyleSheet("color:#f1bc68;background:transparent;font:bold 11px Georgia")
        bars = QLabel("▂▄▆█  ▣")
        bars.setStyleSheet("color:#57b4eb;background:transparent;font:10px Consolas")
        xp.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        bars.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        call_signal.addWidget(xp)
        call_signal.addStretch(1)
        call_signal.addWidget(bars)
        call_layout.addLayout(call_signal)
        call_layout.addSpacing(27)
        logo = QLabel()
        source_logo = QPixmap(str(Path(__file__).with_name("amadeus-logo.png")))
        logo.setPixmap(source_logo.scaled(238, 174, Qt.AspectRatioMode.KeepAspectRatio,
                                         Qt.TransformationMode.SmoothTransformation))
        logo.setAlignment(Qt.AlignmentFlag.AlignCenter)
        logo.setFixedHeight(175)
        logo.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        call_layout.addWidget(logo)
        call_layout.addStretch(2)
        self.call_label = QLabel("Call from Kurisu.")
        self.call_label.setObjectName("callText")
        self.call_label.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        call_layout.addWidget(self.call_label)
        call_layout.addSpacing(25)
        accept = QPushButton("CONNECT")
        accept.setObjectName("connect")
        accept.setFixedWidth(175)
        accept.setFixedHeight(41)
        glow = QGraphicsDropShadowEffect(accept)
        glow.setBlurRadius(13)
        glow.setColor(QColor(255, 113, 18, 160))
        glow.setOffset(0)
        accept.setGraphicsEffect(glow)
        accept.clicked.connect(self.accept_call)
        call_layout.addWidget(accept)
        call_layout.setAlignment(accept, Qt.AlignHCenter)
        call_layout.addStretch(3)
        self.top.addWidget(call)
        self.splash = SpriteSplash()
        self.splash.finished.connect(self._finish_boot)
        self.top.addWidget(self.splash)
        self.top.setCurrentWidget(self.splash)
        screen_stack.addWidget(self.top)
        overlay = QWidget()
        overlay.setStyleSheet("background:transparent")
        overlay.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)
        overlay_layout = QVBoxLayout(overlay)
        overlay_layout.setContentsMargins(9, 5, 9, 0)
        header = QHBoxLayout()
        self.clock = QLabel()
        self.clock.setObjectName("clock")
        self.clock.setFixedWidth(58)
        self.status = StatusChip()
        self.status.setText("连接中…")
        header.addWidget(self.clock)
        header.addWidget(self.status, 1)
        overlay_layout.addLayout(header)
        overlay_layout.addStretch(1)
        screen_stack.addWidget(overlay)
        self.screen_header = overlay
        overlay.hide()
        root.addWidget(screen)
        hinge = HingeBar()
        hinge.setObjectName("hinge")
        hinge.setFixedHeight(12)
        self.hinge = hinge
        hinge_layout = QHBoxLayout(hinge)
        hinge_layout.setContentsMargins(55, 2, 55, 2)
        for _ in range(2):
            bar = QLabel()
            bar.setObjectName("hingeBar")
            bar.setFixedSize(45, 3)
            hinge_layout.addWidget(bar)
        hinge_layout.setSpacing(35)
        root.addWidget(hinge)
        keypad = QFrame()
        keypad.setObjectName("keypad")
        self.keypad = keypad
        keypad_layout = QVBoxLayout(keypad)
        keypad_layout.setContentsMargins(0, 0, 0, 0)
        keypad_layout.setSpacing(0)
        self.tabs = QTabWidget()
        self.tabs.currentChanged.connect(self.tab_changed)
        refresh = QPushButton()
        refresh.setObjectName("iconButton")
        refresh.setIcon(QIcon(str(Path(__file__).with_name("refresh.svg"))))
        refresh.setIconSize(QSize(16, 16))
        refresh.setToolTip("刷新状态")
        refresh.clicked.connect(self.refresh_all)
        self.tabs.setCornerWidget(refresh, Qt.Corner.TopRightCorner)
        keypad_layout.addWidget(self.tabs, 1)
        self._build_chat()
        self._build_memory()
        self._build_settings()
        self._build_diag()
        hardware = DraggableFrame()
        hardware.setObjectName("hardware")
        hardware.setFixedHeight(30)
        self.hardware = hardware
        hardware_layout = QHBoxLayout(hardware)
        hardware_layout.setContentsMargins(22, 1, 22, 1)
        left_grille = QLabel("▥▥▥")
        left_grille.setObjectName("grille")
        right_grille = QLabel("▥▥▥")
        right_grille.setObjectName("grille")
        hardware_key = QPushButton("")
        hardware_key.setObjectName("hardwareKey")
        hardware_key.setFixedSize(22, 22)
        hardware_key.setToolTip("关闭 Amadeus")
        hardware_key.clicked.connect(lambda: self.deny_call() if self.call_item else self.close())
        self.hardware_key = hardware_key
        hardware_layout.addWidget(left_grille)
        hardware_layout.addStretch(1)
        hardware_layout.addWidget(hardware_key)
        hardware_layout.addStretch(1)
        hardware_layout.addWidget(right_grille)
        root.addWidget(keypad, 1)
        root.addWidget(hardware)
        self.setCentralWidget(center)
        self.hinge.hide()
        self.keypad.hide()
        self.screen.setFixedHeight(max(380, self.height() - 55))

    def _build_chat(self):
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        self.history = HistoryView()
        layout.addWidget(self.history, 1)
        self.attachment_label = QLabel("")
        layout.addWidget(self.attachment_label)
        input_frame = QFrame()
        input_frame.setObjectName("chatRow")
        row = QHBoxLayout(input_frame)
        row.setContentsMargins(6, 6, 6, 6)
        row.setSpacing(5)
        self.mic = QPushButton()
        self.mic.setObjectName("iconButton")
        self.mic.setIcon(QIcon(str(Path(__file__).with_name("mic.svg"))))
        self.mic.setIconSize(QSize(16, 16))
        self.mic.setToolTip("Windows 本机语音识别")
        self.mic.clicked.connect(self.start_mic)
        picture = QPushButton()
        picture.setObjectName("iconButton")
        picture.setIcon(QIcon(str(Path(__file__).with_name("image.svg"))))
        picture.setIconSize(QSize(16, 16))
        picture.setToolTip("附加图片")
        picture.clicked.connect(self.pick_image)
        self.input = QLineEdit()
        self.input.setPlaceholderText("和 牧濑红莉栖 说话…")
        self.input.returnPressed.connect(self.send)
        self.send_button = QPushButton()
        self.send_button.setObjectName("iconButton")
        self.send_icon = QIcon(str(Path(__file__).with_name("send.svg")))
        self.send_button.setIcon(self.send_icon)
        self.send_button.setIconSize(QSize(16, 16))
        self.send_button.clicked.connect(self.send)
        for widget in (self.mic, picture, self.input, self.send_button):
            row.addWidget(widget)
        layout.addWidget(input_frame)
        self.tabs.addTab(page, "对话")

    def _build_memory(self):
        page = QWidget()
        layout = QVBoxLayout(page)
        self.memory_list = QListWidget()
        layout.addWidget(self.memory_list)
        row = QHBoxLayout()
        for label, callback in (("刷新", self.refresh_memory), ("导出", self.export_memory),
                                ("删除所选", self.delete_memory), ("清空", self.clear_memory)):
            button = QPushButton(label)
            button.clicked.connect(callback)
            row.addWidget(button)
        layout.addLayout(row)
        self.tabs.addTab(page, "记忆")

    def _build_settings(self):
        page = QWidget()
        page_layout = QVBoxLayout(page)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        inner = QWidget()
        form = SettingsRows(inner)
        def toggle(label, section, key):
            checkbox = QCheckBox()
            checkbox.clicked.connect(lambda on: self.patch({section: {key: on}}))
            form.addRow(label, checkbox)
            return checkbox
        self.voice_on = toggle("语音朗读", "voice", "enabled")
        self.ring_on = toggle("来电铃声", "voice", "ringEnabled")
        self.mic_on = QCheckBox()
        self.mic_on.clicked.connect(lambda on: self.patch({"speechInput": {
            "provider": "windows-native" if on else "none"}}))
        form.addRow("本机语音输入", self.mic_on)
        self.oneshot_on = toggle("单句模式", "chat", "oneshot")
        self.memory_on = toggle("长期记忆", "memory", "enabled")
        self.extract_on = toggle("自动提取事实", "memory", "autoExtract")
        self.broadcast_on = toggle("任务播报", "broadcast", "enabled")
        self.task_start_on = toggle("任务开始", "broadcast", "onTaskStart")
        self.task_complete_on = toggle("任务完成", "broadcast", "onTaskComplete")
        self.task_failed_on = toggle("任务失败", "broadcast", "onTaskFailed")
        self.idle_on = toggle("空闲主动说话", "proactive", "idleEnabled")
        self.call_on = toggle("主动来电", "proactive", "callEnabled")
        self.provider = QComboBox()
        for name in ("qwen-local", "dashscope", "edge"):
            self.provider.addItem(name)
        self.provider.activated.connect(lambda _: self.patch({"voice": {"provider": self.provider.currentText()}}))
        form.addRow("合成服务", self.provider)
        self.voice_name = QLineEdit()
        form.addRow("音色 ID", self.voice_name)
        save_voice = QPushButton("保存音色 ID")
        save_voice.clicked.connect(lambda: self.patch({"voice": {"name": self.voice_name.text().strip()}}))
        form.addRow("", save_voice)
        key_button = QPushButton("设置语音 API Key")
        key_button.clicked.connect(self.set_voice_key)
        form.addRow("", key_button)
        refresh_assets = QPushButton("检查 / 安装模型素材")
        refresh_assets.clicked.connect(self.install_assets)
        form.addRow("", refresh_assets)
        scroll.setWidget(inner)
        page_layout.addWidget(scroll)
        self.tabs.addTab(page, "设置")

    def set_voice_key(self):
        value, accepted = QInputDialog.getText(
            self, "语音密钥", "输入语音服务的 API Key（仅保存在本机加密存储）：",
            QLineEdit.EchoMode.Password,
        )
        if accepted and value.strip():
            self.call("voice_key", "/amadeus/secrets", "POST", {
                "name": "ttsApiKey", "value": value.strip(),
            })

    def _build_diag(self):
        page = QWidget()
        layout = QVBoxLayout(page)
        self.diag_text = QPlainTextEdit()
        self.diag_text.setReadOnly(True)
        layout.addWidget(self.diag_text)
        button = QPushButton("重新自检")
        button.clicked.connect(self.refresh_diag)
        layout.addWidget(button)
        self.tabs.addTab(page, "自检")

    def refresh_clock(self):
        self.clock.setText(time.strftime("%H:%M"))
        QTimer.singleShot(10000, self.refresh_clock)

    def refresh_all(self):
        self.call("status", "/amadeus/status")
        self.call("assets", "/amadeus/assets/status")
        if self.session_id:
            self.call("history", f"/amadeus/sessions/{self.session_id}/messages")

    def call(self, name, path, method="GET", payload=None, binary=False):
        future = self.pool.submit(self.api.request, path, method, payload, binary)
        def done(result):
            try:
                self.bridge.result.emit(name, result.result())
            except Exception as error:
                self.bridge.failed.emit(name, str(error))
        future.add_done_callback(done)

    def _on_failed(self, name, error):
        if name == "welcome_prepare":
            if time.monotonic() < self.welcome_deadline and not self.pending_turn and not self.call_item:
                self.status.setText("克隆音色启动中，开场白稍后播放…")
                QTimer.singleShot(5000, self._retry_welcome)
            else:
                self.status.setText("克隆音色未就绪，请检查本地 Qwen 服务")
            return
        self.status.setText(f"{name}: {error[:52]}")
        if name == "chat":
            self.pending_turn = False
            self.turn_id = None
            self.send_button.setText("")
            self.send_button.setIcon(self.send_icon)
            self.history.add_entry("system", "⚠ " + error)
        elif name == "assets":
            self.diag_text.setPlainText("模型加载失败：" + error)

    def _on_result(self, name, result):
        if name == "status":
            self.config = result.get("config") or {}
            self.character_content = result.get("characterContent") or {}
            if not self.migrated_input and self.config.get("speechInput", {}).get("provider") in ("browser", "api"):
                self.migrated_input = True
                self.patch({"speechInput": {"provider": "windows-native"}})
            self.voice_on.setChecked(self.config.get("voice", {}).get("enabled", False))
            self.ring_on.setChecked(self.config.get("voice", {}).get("ringEnabled", True))
            self.memory_on.setChecked(self.config.get("memory", {}).get("enabled", False))
            self.extract_on.setChecked(self.config.get("memory", {}).get("autoExtract", False))
            self.oneshot_on.setChecked(self.config.get("chat", {}).get("oneshot", True))
            self.mic_on.setChecked(self.config.get("speechInput", {}).get("provider") != "none")
            self.broadcast_on.setChecked(self.config.get("broadcast", {}).get("enabled", False))
            self.task_start_on.setChecked(self.config.get("broadcast", {}).get("onTaskStart", False))
            self.task_complete_on.setChecked(self.config.get("broadcast", {}).get("onTaskComplete", False))
            self.task_failed_on.setChecked(self.config.get("broadcast", {}).get("onTaskFailed", False))
            self.idle_on.setChecked(self.config.get("proactive", {}).get("idleEnabled", False))
            self.call_on.setChecked(self.config.get("proactive", {}).get("callEnabled", False))
            voice = self.config.get("voice", {})
            self.provider.setCurrentText(voice.get("provider", "edge"))
            self.voice_name.setText(voice.get("name", ""))
            provider = result.get("voice", {}).get("provider") or "—"
            count = result.get("memory", {}).get("panel", {}).get("total", 0)
            self.status.setText(f"{provider} · 记忆 {count}")
            if self.booting:
                self.boot_status = result
            else:
                self._welcome(result)
        elif name == "assets":
            model = result.get("activeModel") or {}
            if model.get("installed"):
                self.pending_model = model
                self._load_pending_model()
            else:
                self.status.setText("模型未安装")
        elif name == "sessions":
            sessions = [s for s in result.get("sessions", []) if not s.get("endedAt")]
            if sessions:
                self.session_id = sessions[0]["id"]
                self.call("history", f"/amadeus/sessions/{self.session_id}/messages")
            else:
                self.call("new_session", "/amadeus/sessions", "POST", {})
        elif name == "new_session":
            self.session_id = result["session"]["id"]
        elif name == "history":
            self.history.clear()
            for item in result.get("messages", []):
                self.add_message(item.get("role"), item.get("zh") or item.get("ja") or "")
        elif name == "chat":
            self.turn_id = result["turnId"]
            self.session_id = result["sessionId"]
            for kind, data in self.pending_events:
                self._on_event(kind, data)
            self.pending_events.clear()
        elif name == "memory":
            self.memory_list.clear()
            self.memories = result.get("entries", [])
            for item in self.memories:
                self.memory_list.addItem(item.get("content", ""))
        elif name == "memory_export":
            filename, _ = QFileDialog.getSaveFileName(self, "导出记忆", "amadeus-memory.json", "JSON (*.json)")
            if filename:
                Path(filename).write_text(json.dumps(result.get("data"), ensure_ascii=False, indent=2), encoding="utf-8")
        elif name in ("memory_delete", "memory_clear"):
            self.refresh_memory()
        elif name == "diag":
            self.diag_text.setPlainText(json.dumps(result, ensure_ascii=False, indent=2))
        elif name == "config":
            self.config = result.get("config", self.config)
        elif name == "install_assets":
            self.call("assets", "/amadeus/assets/status")
        elif name == "welcome_prepare":
            if result.get("ready"):
                welcome = self.welcome_line
                self.call("welcome_say", "/amadeus/say", "POST", welcome)
        elif name == "ring":
            if self.call_item is None or self.top.currentWidget() != self.call_screen:
                return
            data, mime = result
            suffix = ".wav" if "wav" in mime else ".mp3"
            volume = self.config.get("voice", {}).get("ringVolume", 0.7)
            ticket = self.ring_ticket
            self.pool.submit(self._play_ring_if_current, ticket, self.ring_cancel, data, suffix, volume)

    def _play_ring_if_current(self, ticket, cancel_event, data, suffix, volume):
        if ticket == self.ring_ticket and not cancel_event.is_set():
            self.audio.play("ring", data, suffix, True, {"kind": "ring"}, volume, cancel_event)

    def _welcome(self, result):
        if (self.welcome_started or self.call_item or not self.api.welcome or
                not self.config.get("voice", {}).get("enabled")):
            return
        welcome = (result.get("characterContent") or {}).get("welcome")
        if not isinstance(welcome, dict) or not welcome.get("text"):
            return
        self.welcome_started = True
        self.welcome_deadline = time.monotonic() + 360
        self.welcome_line = welcome
        if self.config.get("voice", {}).get("provider") == "qwen-local":
            self.call("welcome_prepare", "/amadeus/tts/prepare", "POST", welcome)
        else:
            self.call("welcome_say", "/amadeus/say", "POST", welcome)

    def _retry_welcome(self):
        if (self.welcome_started and time.monotonic() < self.welcome_deadline and
                not self.pending_turn and not self.call_item and not self.audio_busy and self.isVisible()):
            self.call("welcome_prepare", "/amadeus/tts/prepare", "POST", self.welcome_line)

    def _finish_boot(self):
        if not self.booting:
            return
        self.booting = False
        if self.top.currentWidget() == self.splash:
            self.top.setCurrentWidget(self.avatar)
            self.screen.setFixedHeight(round(self.height() * 190 / 520))
            self.hinge.show()
            self.keypad.show()
            self.screen_header.show()
            QTimer.singleShot(0, self._load_pending_model)
        if self.boot_status:
            self._welcome(self.boot_status)
            self.boot_status = None

    def _load_pending_model(self):
        if (not self.pending_model or not self.avatar.gl_ready or
                self.top.currentWidget() != self.avatar):
            return
        model = self.pending_model
        self.pending_model = None
        try:
            self.avatar.load(model.get("entry"), model.get("motionMap"), model.get("expressionMap"))
        except Exception as error:
            self.status.setText("模型加载失败：" + str(error)[:45])

    def _set_call_mode(self, active):
        if active:
            self.booting = False
            self.splash.stop()
            self.screen_header.hide()
            self.hinge.hide()
            self.keypad.hide()
            self.screen.setFixedHeight(max(380, self.height() - 55))
            self.top.setCurrentWidget(self.call_screen)
            self.hardware_key.setToolTip("拒接来电")
        else:
            self.screen.setFixedHeight(round(self.height() * 190 / 520))
            self.hinge.show()
            self.keypad.show()
            self.top.setCurrentWidget(self.avatar)
            self.screen_header.show()
            self.hardware_key.setToolTip("关闭 Amadeus")
            QTimer.singleShot(0, self._load_pending_model)

    def tab_changed(self, index):
        if index == 1:
            self.refresh_memory()
        elif index == 3:
            self.refresh_diag()

    def add_message(self, role, text):
        self.history.add_entry(role, text)
        self.history.scrollToBottom()

    def send(self):
        if self.pending_turn:
            if self.turn_id:
                self.call("cancel", "/amadeus/chat/cancel", "POST", {"turnId": self.turn_id})
            return
        text = self.input.text().strip()
        if not text and not self.attachment:
            return
        payload = {"sessionId": self.session_id, "text": text}
        if self.attachment:
            payload["image"] = self.attachment
        self.add_message("user", text + (" [图片]" if self.attachment else ""))
        self.input.clear()
        self.attachment = None
        self.attachment_label.clear()
        self.pending_turn = True
        self.turn_id = None
        self.send_button.setIcon(QIcon())
        self.send_button.setText("×")
        self.call("chat", "/amadeus/chat", "POST", payload)

    def pick_image(self):
        filename, _ = QFileDialog.getOpenFileName(self, "选择图片", "", "Images (*.png *.jpg *.jpeg *.webp)")
        if not filename:
            return
        data = Path(filename).read_bytes()
        mime = mimetypes.guess_type(filename)[0]
        if len(data) > MAX_IMAGE or mime not in ("image/png", "image/jpeg", "image/webp"):
            QMessageBox.warning(self, "图片", "请选择 3 MB 以内的 PNG、JPEG 或 WebP")
            return
        self.attachment = {"mime": mime, "data": base64.b64encode(data).decode("ascii")}
        self.attachment_label.setText("待发送：" + Path(filename).name + "（点击文字可清除）")
        self.attachment_label.mousePressEvent = lambda event: self.clear_image()

    def clear_image(self):
        self.attachment = None
        self.attachment_label.clear()

    def start_mic(self):
        if self.config.get("speechInput", {}).get("provider") == "none":
            self.status.setText("语音输入已关闭")
            return
        if not self.mic.isEnabled():
            return
        self.mic.setEnabled(False)
        self.status.setText("正在听…")
        threading.Thread(target=recognize_once, args=(self.bridge,), daemon=True).start()

    def _on_speech_done(self, text, error):
        self.mic.setEnabled(True)
        if error:
            self.status.setText("语音输入：" + error[:70])
        elif text:
            self.input.setText(text)
            self.status.setText("语音已输入，可编辑后发送")
        else:
            self.status.setText("没有识别到语音")

    def _on_event(self, kind, data):
        if kind == "offline":
            self.status.setText("连接中断，重连中…")
        elif kind == "connected":
            self.status.setText("已连接")
        elif kind == "hello":
            for item in data.get("pending", []):
                self._utterance(item)
        elif kind == "pending":
            for item in data.get("pending", []):
                self._utterance(item)
        elif kind == "utterance":
            self._utterance(data)
        elif kind == "config":
            self.call("status", "/amadeus/status")
        elif kind == "turn:status" and self.pending_turn:
            self.status.setText("正在回答：" + data.get("phase", ""))
        elif kind in ("turn:done", "turn:error"):
            if self.pending_turn and self.turn_id is None:
                self.pending_events.append((kind, data))
                return
            if data.get("turnId") != self.turn_id:
                return
            self.pending_turn = False
            self.turn_id = None
            self.send_button.setText("")
            self.send_button.setIcon(self.send_icon)
            if kind == "turn:done":
                self.add_message("assistant", data.get("zh") or data.get("ja") or "")
                self.avatar.emotion(data.get("emotion", "neutral"))
                if data.get("closed"):
                    self.session_id = None
                self.status.setText("已回复")
            else:
                self.add_message("system", "回复失败：" + data.get("error", "未知错误"))
                self.status.setText("回复失败")
        elif kind == "session:append":
            if data.get("sessionId") == self.session_id and data.get("origin") != self.api.client:
                message = data.get("message") or {}
                self.add_message(message.get("role"), message.get("zh") or message.get("ja") or "")
        elif kind == "shutdown":
            self.status.setText("服务已停止")

    def _utterance(self, item):
        if not isinstance(item, dict):
            return
        item_id = item.get("id")
        if item_id in self.seen_utterances:
            return
        self.seen_utterances.add(item_id)
        if len(self.seen_utterances) > 500:
            self.seen_utterances = set(list(self.seen_utterances)[-250:])
        self.call("audio_accept", "/amadeus/utterance/ack", "POST", {"id": item_id, "status": "accepted"})
        if item.get("kind") == "call":
            self.call_item = item
            self.ring_ticket += 1
            self.ring_cancel = threading.Event()
            self._set_call_mode(True)
            self.call_label.setText("Call from " +
                                    (self.character_content.get("callName") or
                                     self.character_content.get("displayName") or "Unknown") + ".")
            if self.config.get("voice", {}).get("ringEnabled", True):
                ring_root = Path(os.environ.get("AMADEUS_DATA_DIR") or
                                 Path(os.environ.get("LOCALAPPDATA", "")) / "Amadeus") / "sounds"
                local_ring = next((ring_root / ("incoming" + ext)
                                   for ext in (".wav", ".mp3", ".ogg", ".m4a")
                                   if (ring_root / ("incoming" + ext)).is_file()), None)
                if local_ring and 4096 <= local_ring.stat().st_size <= 8 * 1024 * 1024:
                    suffix = local_ring.suffix.lower()
                    volume = self.config.get("voice", {}).get("ringVolume", 0.7)
                    ticket = self.ring_ticket
                    self.pool.submit(self._play_ring_if_current, ticket, self.ring_cancel,
                                     local_ring.read_bytes(), suffix, volume)
                else:
                    self.call("ring", "/amadeus/sound/incoming", binary=True)
            return
        if item.get("kind") == "broadcast" and item.get("cn"):
            self.add_message("assistant", item["cn"])
        self.audio_queue.append(item)
        if not self.audio_busy:
            self._next_audio()

    def _next_audio(self):
        if not self.audio_queue:
            self.audio_busy = False
            self.avatar.talking = False
            self.avatar.emotion("neutral")
            return
        item = self.audio_queue.pop(0)
        self.audio_busy = True
        self.avatar.emotion(item.get("emotion", "neutral"))
        text = item.get("text") or ""
        query = urllib.parse.urlencode({"text": text, "emotion": item.get("emotion") or "neutral"})
        def work():
            try:
                audio, mime = self.api.request("/amadeus/tts?" + query, binary=True, timeout=90)
                suffix = ".wav" if "wav" in mime else ".mp3"
                self.bridge.talking.emit(True)
                self.audio.play("voice", audio, suffix, item=item)
            except Exception as error:
                self.bridge.audio_done.emit(item, str(error))
        self.pool.submit(work)

    def _on_audio_done(self, item, error):
        if item is None:
            return
        if item.get("kind") == "ring":
            if error and self.call_item:
                self.status.setText("来电铃声播放失败：" + str(error)[:55])
            return
        self._set_talking(False)
        if error:
            self.status.setText("语音播放失败：" + str(error)[:58])
            self.call("audio_report", "/amadeus/report", "POST", {
                "level": "warn", "message": "native speech playback failed",
                "detail": str(error)[:500], "where": "native audio",
            })
        self._next_audio()

    def _set_talking(self, active):
        self.avatar.talking = active
        if active:
            self.avatar.talk_start = time.monotonic()

    def accept_call(self):
        self.ring_cancel.set()
        self.ring_ticket += 1
        self.audio.stop("ring")
        self._set_call_mode(False)
        if self.call_item:
            self.audio_queue.append(self.call_item)
            self.call_item = None
            if not self.audio_busy:
                self._next_audio()

    def _on_avatar_tap(self):
        if (not self.config.get("voice", {}).get("enabled") or self.pending_turn or
                self.audio_busy or self.call_item or time.monotonic() - self.last_tap_speech < 2.5):
            return
        lines = self.character_content.get("tapReactions") or []
        if not lines:
            return
        self.last_tap_speech = time.monotonic()
        line = random.choice(lines)
        self.call("tap_say", "/amadeus/say", "POST", {"text": line.get("text"), "emotion": line.get("emotion")})

    def deny_call(self):
        self.ring_cancel.set()
        self.ring_ticket += 1
        self.audio.stop("ring")
        self.call_item = None
        self._set_call_mode(False)

    def patch(self, value):
        self.call("config", "/amadeus/config", "PATCH", {"patch": value})

    def refresh_memory(self):
        self.call("memory", "/amadeus/memory?limit=80")

    def export_memory(self):
        self.call("memory_export", "/amadeus/memory/export")

    def delete_memory(self):
        index = self.memory_list.currentRow()
        if index < 0 or index >= len(getattr(self, "memories", [])):
            return
        item = self.memories[index]
        self.call("memory_delete", "/amadeus/memory?id=" + urllib.parse.quote(item["id"]), "DELETE")

    def clear_memory(self):
        answer = QMessageBox.question(self, "清空记忆", "清空面板长期记忆？此操作不可撤销。")
        if answer == QMessageBox.Yes:
            self.call("memory_clear", "/amadeus/memory/clear", "POST", {"namespace": "panel"})

    def refresh_diag(self):
        self.call("diag", "/amadeus/diag")

    def install_assets(self):
        self.status.setText("正在安装模型素材…")
        self.call("install_assets", "/amadeus/assets/install", "POST", {})

    def focusInEvent(self, event):
        super().focusInEvent(event)
        self.call("claim", "/amadeus/client/active", "POST", {})

    def closeEvent(self, event):
        self.stop_event.set()
        self.ring_cancel.set()
        self.audio.stop("ring")
        self.audio.stop("voice")
        self.pool.shutdown(wait=False, cancel_futures=True)
        super().closeEvent(event)


def main():
    address = sys.stdin.readline().strip()
    api = Api(address)
    set_process_identity()
    live2d.init()
    app = QApplication(sys.argv)
    icon = QIcon(str(Path(__file__).resolve().parents[1] / "scripts" / "Amadeus.ico"))
    app.setWindowIcon(icon)
    window = Panel(api)
    window.setWindowIcon(icon)
    window.show()
    try:
        set_window_identity(int(window.winId()), Path(__file__).resolve().parents[1])
    except OSError as error:
        print(f"Amadeus taskbar identity: {error}", file=sys.stderr)
    if os.environ.get("AMADEUS_NATIVE_PREVIEW") == "chat":
        QTimer.singleShot(1000, lambda: window.add_message("user", "你最近在做什么实验"))
        QTimer.singleShot(1050, lambda: window.add_message("assistant", "还在整理数据。你呢？"))
    if os.environ.get("AMADEUS_NATIVE_PREVIEW") == "call":
        def preview_call():
            window.call_item = {"kind": "call", "id": "preview"}
            window._set_call_mode(True)
        QTimer.singleShot(1000, preview_call)
    if os.environ.get("AMADEUS_NATIVE_PREVIEW") == "settings":
        QTimer.singleShot(1000, lambda: window.tabs.setCurrentIndex(2))
    if os.environ.get("AMADEUS_NATIVE_SCREENSHOT"):
        QTimer.singleShot(int(os.environ.get("AMADEUS_NATIVE_SCREENSHOT_MS", "2000")),
                          lambda: window.grab().save(os.environ["AMADEUS_NATIVE_SCREENSHOT"]))
    if os.environ.get("AMADEUS_NATIVE_TEST_MS"):
        QTimer.singleShot(int(os.environ["AMADEUS_NATIVE_TEST_MS"]), app.quit)
    code = app.exec()
    live2d.dispose()
    return code


if __name__ == "__main__":
    sys.exit(main())
