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
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError as FutureTimeout
from pathlib import Path

from windows_taskbar import set_process_identity, set_window_identity
from affect import AffectController, FaceSmoother
from tracking import CursorTracker
from reaction_audio import ReactionAudioCache, leading_silence_ms

import live2d
from OpenGL.GL import glViewport
from PySide6.QtCore import QObject, QPointF, QRect, QRectF, QSize, Qt, QTimer, Signal
from PySide6.QtGui import QColor, QCursor, QFont, QIcon, QLinearGradient, QPainter, QPen, QPixmap, QPolygonF, QTextOption
from PySide6.QtOpenGLWidgets import QOpenGLWidget
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QComboBox, QFileDialog, QFrame, QHBoxLayout,
    QGraphicsDropShadowEffect, QInputDialog, QLabel, QLineEdit, QListView, QListWidget, QListWidgetItem, QMainWindow, QMenu, QMessageBox,
    QPlainTextEdit, QPushButton, QScrollArea, QSizePolicy, QSpinBox, QStackedLayout, QStackedWidget, QTabWidget, QTextEdit, QVBoxLayout, QWidget,
)


MAX_IMAGE = 3 * 1024 * 1024

EMOTION_LABELS = {
    "neutral": "平静", "soft": "放松", "happy": "开心", "excited": "兴奋",
    "elated": "得意", "sad": "低落", "disappointed": "失落", "angry": "生气",
    "furious": "恼火", "annoyed": "有点不满", "question": "好奇", "thinking": "思考",
    "surprised": "惊讶", "blush": "害羞", "indifferent": "淡然", "side": "侧目",
    "winking": "眨眼", "eyes_closed": "稍作休息",
}

AVATAR_MENU_STYLE = """
QMenu#avatarMenu { background:#220f14; color:#f4e7e4; border:1px solid #854029;
    border-radius:7px; padding:6px; font:12px 'Microsoft YaHei UI'; }
QMenu#avatarMenu::item { min-width:150px; padding:9px 13px; border-radius:4px; }
QMenu#avatarMenu::item:selected { background:#452027; color:#ffdc82; }
QMenu#avatarMenu::item:disabled { color:#b79b96; background:transparent; }
QMenu#avatarMenu::separator { height:1px; background:#5d333d; margin:5px 8px; }
"""


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
    audio_started = Signal(object)


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


class SelectionCombo(QComboBox):
    """Scrolling the settings page must not silently switch the speaker."""
    def wheelEvent(self, event):
        if self.view().isVisible():
            super().wheelEvent(event)
        else:
            event.ignore()


class MessageText(QTextEdit):
    """Selectable plain text that wraps long filenames and grows with its bubble."""
    def __init__(self, text):
        super().__init__()
        self.setReadOnly(True)
        self.setFrameShape(QFrame.Shape.NoFrame)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setWordWrapMode(QTextOption.WrapMode.WrapAtWordBoundaryOrAnywhere)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.setMinimumWidth(0)
        self.setStyleSheet("background:transparent;border:none;padding:0")
        self.document().setDocumentMargin(0)
        self.setPlainText(str(text))
        self.setAccessibleName("消息正文")
        self.document().documentLayout().documentSizeChanged.connect(self.fit_height)

    def fit_height(self, *_):
        width = max(1, self.viewport().width())
        if abs(self.document().textWidth() - width) > 0.5:
            self.document().setTextWidth(width)
        height = math.ceil(self.document().size().height()) + 2
        if self.height() != height:
            self.setFixedHeight(height)

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self.fit_height()

    def wheelEvent(self, event):
        event.ignore()


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
        self.bubbles = []

    def clear(self):
        self.bubbles.clear()
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
        bubble.setMaximumWidth(max(140, min(360, round(self.viewport().width() * 0.85))))
        self.bubbles.append(bubble)
        inside = QVBoxLayout(bubble)
        inside.setContentsMargins(9, 6, 9, 5)
        inside.setSpacing(2)
        label = MessageText(text)
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
        QTimer.singleShot(60, self.scrollToBottom)

    def resizeEvent(self, event):
        at_bottom = self.verticalScrollBar().value() >= self.verticalScrollBar().maximum() - 4
        super().resizeEvent(event)
        for bubble in self.bubbles:
            bubble.setMaximumWidth(max(140, min(360, round(self.viewport().width() * 0.85))))
        if at_bottom:
            QTimer.singleShot(60, self.scrollToBottom)

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
    def resizeEvent(self, event):
        super().resizeEvent(event)
        width, height = self.width(), self.height()
        inset = max(14, round(width * 0.065))
        if hasattr(self, "status_bar"):
            self.status_bar.setGeometry(inset, max(10, round(height * 0.022)), max(0, width - inset * 2), 22)
            logo_top = round(height * 0.13)
            logo_height = round(height * 0.33)
            self.call_logo.setGeometry(inset, logo_top, max(0, width - inset * 2), logo_height)
            label_height = min(68, max(36, round(height * 0.095)))
            label_top = round(height * 0.60) - label_height // 2
            self.call_label.setStyleSheet(f"font-size:{max(16, min(22, round(width * 16 / 292)))}px;")
            self.call_label.setGeometry(inset, label_top, max(0, width - inset * 2), label_height)
            button_width = min(280, max(155, round(width * 0.64)))
            button_height = min(62, max(50, round(height * 0.095)))
            self.connect_button.setGeometry((width - button_width) // 2,
                                            label_top + label_height + max(12, round(height * 0.035)),
                                            button_width, button_height)
            self.connect_button.setStyleSheet(
                f"font-size:{max(18, min(24, round(width * 18 / 292)))}px; border-radius:{button_height // 2}px;")

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
        # A quiet glass edge keeps the original screen texture readable.
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.setPen(QPen(QColor(228, 199, 127, 30), 1))
        painter.drawRect(QRectF(1, 1, width - 3, height - 3))


class CallStatusBar(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setPen(QColor("#f1bc68"))
        painter.setFont(QFont("Georgia", 11, QFont.Weight.Bold))
        painter.drawText(QRect(0, 0, 30, self.height()), Qt.AlignmentFlag.AlignVCenter, "Xp")
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor("#57b4eb"))
        right = self.width() - 4
        painter.drawRoundedRect(QRectF(right - 16, 7, 15, 8), 1, 1)
        painter.drawRect(QRectF(right - 1, 9, 2, 4))
        for index, bar_height in enumerate((4, 7, 10, 13)):
            painter.drawRect(QRectF(right - 55 + index * 9, 16 - bar_height, 7, bar_height))


class CallLogo(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.source = QPixmap(str(Path(__file__).with_name("amadeus-logo.png")))
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)

    def paintEvent(self, event):
        if self.source.isNull():
            return
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        size = self.source.size().scaled(self.size(), Qt.AspectRatioMode.KeepAspectRatio)
        painter.drawPixmap((self.width() - size.width()) // 2,
                           (self.height() - size.height()) // 2,
                           size.width(), size.height(), self.source)


class BlinkShortener:
    """Bound each authored eyelid closure, without flattening half-open poses."""

    def __init__(self):
        self.started = [None, None]
        self.open_values = [1.0, 1.0]

    def values(self, left, right, now):
        result = []
        for index, raw in enumerate((left, right)):
            if raw >= .5:
                self.started[index] = None
            if raw >= .65:
                self.open_values[index] = min(1.0, raw)
            if self.started[index] is None and raw < .25:
                self.started[index] = now
            if self.started[index] is None:
                result.append(None)
                continue
            elapsed = max(0.0, now - self.started[index])
            # A normal blink/wink is still visible. A stuck model eye reopens
            # independently; the other eye can retain its authored expression.
            progress = max(0.0, min(1.0, (elapsed - .045) / .100))
            result.append(self.open_values[index] * progress)
        return tuple(result)


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
        "云端合成模型": "须与阿里云克隆音色对应的模型一致",
        "对话模型": "留空时沿用当前通道的默认模型",
        "允许 Codex 发声": "允许 Codex 主动请求 Amadeus 朗读",
        "允许 Codex 来电": "允许 Codex 请求显示来电",
    }

    def __init__(self, host):
        self.layout = QVBoxLayout(host)
        self.layout.setContentsMargins(7, 4, 7, 4)
        self.layout.setSpacing(0)
        self.layout.addStretch(1)

    def addRow(self, label, control):
        row = QFrame()
        row.setObjectName("settingsRow")
        line = QHBoxLayout(row) if isinstance(control, QCheckBox) else QVBoxLayout(row)
        line.setContentsMargins(5, 7, 5, 7)
        line.setSpacing(7)
        if label:
            left = QWidget()
            left.setStyleSheet("background:transparent")
            texts = QVBoxLayout(left)
            texts.setContentsMargins(0, 0, 0, 0)
            texts.setSpacing(1)
            title = QLabel(label)
            title.setWordWrap(True)
            title.setBuddy(control)
            texts.addWidget(title)
            description = self.DESCRIPTIONS.get(label)
            if description:
                hint = QLabel(description)
                hint.setObjectName("settingsDescription")
                hint.setWordWrap(True)
                texts.addWidget(hint)
            line.addWidget(left, 1)
            control.setAccessibleName(label)
            control.setMinimumWidth(0)
        line.addWidget(control)
        self.layout.insertWidget(self.layout.count() - 1, row)

    def heading(self, text):
        label = QLabel(text)
        label.setObjectName("settingsDescription")
        label.setContentsMargins(5, 12, 5, 5)
        self.layout.insertWidget(self.layout.count() - 1, label)


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
    tapped = Signal(str)
    gl_initialized = Signal()
    affect_changed = Signal(str, str)

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
        self.blink = BlinkShortener()
        self.eye_open_ids = None
        self.eye_gaze_ids = None
        self.mouth_id = None
        self.tracking_params = {}
        self.layout_spec = {}
        self.last_interaction = -10.0
        self.interaction_emotion = "question"
        self.base_emotion = "neutral"
        self.expression_deadline = 0.0
        self.affect = AffectController()
        self.face_smoother = FaceSmoother()
        self.cursor_tracker = CursorTracker()
        self.affect_params = {}
        self.param_limits = {}
        self.param_defaults = {}
        self.displayed_affect = None
        self.interaction_menu = None
        self.visible_emotion = None
        self.active_expression = None
        self.manual_expression_until = 0.0
        self.press_started = 0.0
        self.interaction_kind = "body"
        self.reduced_motion = False
        if sys.platform == "win32":
            animations = ctypes.c_int(1)
            if ctypes.windll.user32.SystemParametersInfoW(0x1042, 0, ctypes.byref(animations), 0):
                self.reduced_motion = not bool(animations.value)
        self.setMinimumHeight(0)
        self.setMouseTracking(True)
        self.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.customContextMenuRequested.connect(self.show_model_menu)
        self.setToolTip("轻点头部或身体互动；按住头部再松开可轻抚。右键可选择轻抚、轻拍或逗她一下；顶部可拖动窗口。")

    def initializeGL(self):
        live2d.glInit()
        self.gl_ready = True
        self.frame_timer = self.startTimer(16, Qt.TimerType.PreciseTimer)
        self.gl_initialized.emit()

    def load(self, entry, motion_map=None, expression_map=None, layout=None, parameter_map=None):
        if not self.gl_ready:
            raise RuntimeError("Live2D OpenGL context is not ready")
        if not entry or not Path(entry).is_file():
            raise FileNotFoundError("Live2D model is missing")
        self.makeCurrent()
        try:
            self.model = live2d.Model()
            self.model.LoadModelJson(str(entry))
            self.model.Resize(self.width(), self.height())
            self.layout_spec = layout or {}
            self.apply_layout()
            self.blink = BlinkShortener()
            param_ids = set(self.model.GetParamIds())
            params = parameter_map or {}
            self.eye_open_ids = next((pair for pair in (
                ("PARAM_EYE_L_OPEN", "PARAM_EYE_R_OPEN"),
                ("ParamEyeLOpen", "ParamEyeROpen"),
            ) if all(param in param_ids for param in pair)), None)
            self.eye_gaze_ids = next((pair for pair in (
                (params.get("eyeBallX", "PARAM_EYE_BALL_X"), params.get("eyeBallY", "PARAM_EYE_BALL_Y")),
                ("PARAM_EYE_BALL_X", "PARAM_EYE_BALL_Y"),
                ("ParamEyeBallX", "ParamEyeBallY"),
            ) if all(param in param_ids for param in pair)), None)
            self.mouth_id = next((param for param in (
                params.get("mouthOpenY"), "PARAM_MOUTH_OPEN_Y", "ParamMouthOpenY"
            ) if param in param_ids), None)
            self.tracking_params = {key: value for key, value in params.items()
                                    if key in ("angleX", "angleY", "angleZ", "bodyAngleX") and value in param_ids}
            aliases = {
                "angleX": ("PARAM_ANGLE_X", "ParamAngleX"), "angleY": ("PARAM_ANGLE_Y", "ParamAngleY"),
                "angleZ": ("PARAM_ANGLE_Z", "ParamAngleZ"), "bodyAngleX": ("PARAM_BODY_ANGLE_X", "ParamBodyAngleX"),
                "browLY": ("PARAM_BROW_L_Y", "ParamBrowLY"), "browRY": ("PARAM_BROW_R_Y", "ParamBrowRY"),
                "browLAngle": ("PARAM_BROW_L_ANGLE", "ParamBrowLAngle"), "browRAngle": ("PARAM_BROW_R_ANGLE", "ParamBrowRAngle"),
                "browLForm": ("PARAM_BROW_L_FORM", "ParamBrowLForm"), "browRForm": ("PARAM_BROW_R_FORM", "ParamBrowRForm"),
                "eyeLSmile": ("PARAM_EYE_L_SMILE", "ParamEyeLSmile"), "eyeRSmile": ("PARAM_EYE_R_SMILE", "ParamEyeRSmile"),
                "mouthForm": ("PARAM_MOUTH_FORM", "ParamMouthForm"), "cheek": ("PARAM_TERE", "ParamCheek"),
                "mouthOpenY": ("PARAM_MOUTH_OPEN_Y", "ParamMouthOpenY"),
                "eyeLOpen": ("PARAM_EYE_L_OPEN", "ParamEyeLOpen"), "eyeROpen": ("PARAM_EYE_R_OPEN", "ParamEyeROpen"),
                "breath": ("PARAM_BREATH", "ParamBreath"),
            }
            self.affect_params = {key: param for key, names in aliases.items()
                                  if (param := next((candidate for candidate in (params.get(key), *names)
                                                     if candidate in param_ids), None))}
            driven = set(self.affect_params.values()) | set(self.eye_gaze_ids or ())
            if self.mouth_id:
                driven.add(self.mouth_id)
            self.param_limits = {param: (self.model.GetParamMinById(param), self.model.GetParamMaxById(param))
                                 for param in driven}
            self.param_defaults = {param: self.model.GetParamDefaultById(param) for param in driven}
            self.visible_emotion = None
            self.active_expression = None
            self.face_smoother = FaceSmoother()
            self.model.SetAutoBlink(True)
            self.model.SetAutoBreath(not self.reduced_motion)
            self.motion_map = motion_map or {}
            self.expression_map = expression_map or {}
            model_data = json.loads(Path(entry).read_text(encoding="utf-8"))
            self.model_motions = model_data.get("motions") or {}
            self.model_expressions = [item.get("name") for item in model_data.get("expressions", []) if item.get("name")]
            self.idle_motion()
        finally:
            self.doneCurrent()
        self.update()

    def resizeGL(self, width, height):
        glViewport(0, 0, width, height)
        if self.model:
            self.model.Resize(width, height)
            self.apply_layout()

    def apply_layout(self):
        cfg = self.layout_spec
        self.model.SetScale(max(0.1, min(4.0, float(cfg.get("scale", 1)))))
        unit = self.width() / 392
        dx = float(cfg.get("x", 0)) * unit
        dy = float(cfg.get("y", 0)) * unit + (float(cfg.get("yRatio", 0.52)) - 0.52) * self.height()
        # SetOffset is in view units; the default remains exactly (0, 0).
        self.model.SetOffset(2 * dx / max(1, self.height()), -2 * dy / max(1, self.height()))

    def idle_motion(self):
        if self.model and not self.reduced_motion and self.model_motions.get("idle"):
            self.model.StartRandomMotion(group="idle", priority=live2d.MotionPriority.IDLE)

    def paintGL(self):
        live2d.clearBuffer()
        if self.model:
            now = time.monotonic()
            state = self.affect.step(now, reduced_motion=self.reduced_motion)
            display = (state["activity"], state["emotion"])
            if display != self.displayed_affect:
                self.displayed_affect = display
                self.affect_changed.emit(*display)
            if now >= self.manual_expression_until and state["emotion"] != self.visible_emotion:
                self._apply_emotion(state["emotion"])
            cursor = self.mapFromGlobal(QCursor.pos())
            width, height = max(1, self.width()), max(1, self.height())
            eye_x, eye_y = self.cursor_tracker.step(cursor.x(), cursor.y(), width, height, now)
            # The SDK's drag manager adds its own slow easing. Keep it at
            # rest and drive every tracking parameter with the same filter.
            self.model.Drag(width / 2, height / 2)
            self.model.Update()
            # SetParamById also writes the SDK's SAVED motion parameters. Using
            # it to restore post-expression values would apply e.g. f02's 0.7
            # eyelid multiplier again next frame, eventually pinning eyes shut.
            # AddParamById only changes the current frame; always use deltas
            # from the actual current value, including when restoring it.
            baseline = {param: self.model.GetParamValueById(param) for param in self.param_limits}
            pose = state["pose"]
            face_weight = min(1.0, max(0.0, state["intensity"] * 1.5)) * .85
            facial_keys = {"browLY", "browRY", "browLAngle", "browRAngle", "browLForm", "browRForm",
                           "eyeLSmile", "eyeRSmile", "mouthForm", "mouthOpenY", "cheek"}
            targets, immediate_eyes = {}, set()
            def put(param, value):
                low, high = self.param_limits.get(param, (-100, 100))
                targets[param] = max(low, min(high, value))
            if self.eye_gaze_ids:
                put(self.eye_gaze_ids[0], eye_x * 0.85 + pose.get("eyeBallX", 0))
                put(self.eye_gaze_ids[1], eye_y * 0.85 + pose.get("eyeBallY", 0))
            for key, param in self.affect_params.items():
                if key not in ("eyeLOpen", "eyeROpen"):
                    base = baseline[param]
                    if key in facial_keys and now >= self.manual_expression_until:
                        # Authored expressions can already be at their limits.
                        # Give the semantic cue room instead of adding into a
                        # saturated frown/smile that makes all emotions alike.
                        low, high = self.param_limits[param]
                        base = max(low, min(high, base)) * (1 - face_weight) + self.param_defaults.get(param, 0) * face_weight
                    put(param, base + pose.get(key, 0))
            for key, value in {"angleX": eye_x * 22, "angleY": eye_y * 16,
                               "angleZ": eye_x * eye_y * -5, "bodyAngleX": eye_x * 4}.items():
                param = self.affect_params.get(key)
                if param:
                    put(param, value + pose.get(key, 0) + baseline[param] * .2)
            if self.eye_open_ids:
                blink_values = self.blink.values(
                    self.model.GetParamValueById(self.eye_open_ids[0]),
                    self.model.GetParamValueById(self.eye_open_ids[1]), now)
                for key, param, blink_value in zip(("eyeLOpen", "eyeROpen"), self.eye_open_ids, blink_values):
                    low, high = self.param_limits.get(param, (0, 1))
                    value = max(low, min(high, baseline.get(param, 1) if blink_value is None else blink_value))
                    # Keep natural blinks closed even with a positive eye cue.
                    if value > 0.2:
                        if now >= self.manual_expression_until:
                            rest = self.param_defaults.get(param, 1)
                            # This model's neutral default is already fully
                            # open. A slight resting lid leaves room for an
                            # actual surprised look without exceeding its rig.
                            if low == 0 and high == 1 and rest >= .95:
                                value = max(0, value - .1)
                                rest = .9
                            value = value * (1 - face_weight) + rest * face_weight
                        value += pose.get(key, 0)
                    override = state.get("eye_override") or {}
                    if key in override or blink_value is not None or baseline.get(param, 1) <= .2:
                        immediate_eyes.add(param)
                    put(param, value * override.get(key, 1.0))
            if self.talking and self.mouth_id:
                value = 0.25 + 0.35 * abs(math.sin((now - self.talk_start) * 15))
                put(self.mouth_id, max(value, pose.get("mouthOpenY", 0)))
            smooth_ids = {param for key, param in self.affect_params.items()
                          if key in facial_keys or key in ("eyeLOpen", "eyeROpen")}
            targets.update(self.face_smoother.step(
                {param: value for param, value in targets.items() if param in smooth_ids}, now,
                immediate=immediate_eyes, speaking_mouth=self.mouth_id if self.talking else None))
            for param, value in targets.items():
                self.model.AddParamById(param, value - self.model.GetParamValueById(param))
            self.model.Draw()
            for param, value in baseline.items():
                self.model.AddParamById(param, value - self.model.GetParamValueById(param))

    def timerEvent(self, event):
        if event.timerId() != self.frame_timer:
            return super().timerEvent(event)
        if not self.isVisible() or self.window().isMinimized():
            return
        if self.expression_deadline and time.monotonic() >= self.expression_deadline:
            self.expression_deadline = 0.0
        if self.model and self.model.IsMotionFinished():
            self.idle_motion()
        self.update()

    def motion(self, name):
        if not self.model:
            return
        spec = self.motion_map.get(name) or {}
        group = spec.get("group") or {"head": "flick_head", "body": "tap_body", "other": "pinch_in"}.get(name, name)
        variants = min(20, max(1, int(spec.get("variants") or len(self.model_motions.get(group, [])) or 1)))
        self.play_group(group, variants)

    def play_group(self, group, variants):
        if not self.model or not self.model_motions.get(group):
            return
        variants = min(max(1, variants), len(self.model_motions[group]))
        previous = self.last_motion.get(group, -1)
        choices = [i for i in range(variants) if i != previous] or [0]
        index = random.choice(choices)
        self.last_motion[group] = index
        self.model.StartMotion(group, index, live2d.MotionPriority.FORCE)

    def build_interaction_menu(self):
        menu = QMenu(self)
        menu.setObjectName("avatarMenu")
        menu.setStyleSheet(AVATAR_MENU_STYLE)
        busy = self.talking or self.affect.activity in ("thinking", "listening")
        title = "正在说话，稍后再互动" if self.talking else "正在思考，稍后再互动" if self.affect.activity == "thinking" else "正在倾听，稍后再互动" if busy else "和她互动"
        if not self.model:
            title = "角色正在载入"
        menu.addAction(title).setEnabled(False)
        menu.addSeparator()
        for label, gesture in (("轻抚头发", "pat"), ("轻拍肩膀", "body"), ("逗她一下", "swipe")):
            action = menu.addAction(label)
            action.setEnabled(bool(self.model) and not busy)
            action.triggered.connect(lambda checked=False, g=gesture: self.menu_interact(g))
        menu.addSeparator()
        reset = menu.addAction("恢复自然")
        reset.setEnabled(bool(self.model) and not busy)
        reset.triggered.connect(self.reset_affect)
        return menu

    def show_model_menu(self, position):
        if self.interaction_menu:
            self.interaction_menu.close()
        self.interaction_menu = self.build_interaction_menu()
        self.interaction_menu.aboutToHide.connect(self._close_interaction_menu)
        self.interaction_menu.popup(self.mapToGlobal(position))

    def _close_interaction_menu(self):
        if self.interaction_menu:
            self.interaction_menu.deleteLater()
            self.interaction_menu = None

    def menu_interact(self, gesture):
        if gesture not in ("pat", "body", "swipe"):
            return
        self.interact("body" if gesture == "body" else "head",
                      held=gesture == "pat", swipe=gesture == "swipe")

    def reset_affect(self):
        if not self.model or self.talking or self.affect.activity in ("thinking", "listening"):
            return
        self.affect.reset()
        self.base_emotion = "neutral"
        self.expression_deadline = self.manual_expression_until = 0.0
        self.model.StopAllMotions()
        self._apply_emotion("neutral")
        self.idle_motion()

    def emotion(self, name):
        self.base_emotion = name
        self.expression_deadline = 0.0
        self.manual_expression_until = 0.0
        self.affect.set_emotion(name)
        self._apply_emotion(name)

    def set_activity(self, activity):
        self.affect.set_activity(activity)
        if activity in ("thinking", "listening", "error"):
            self.manual_expression_until = 0.0
            self.expression_deadline = 0.0

    def reaction(self, name):
        if self.affect.react(name, hold=3):
            self.interaction_emotion = name
            self._apply_emotion(name)
            self.expression_deadline = time.monotonic() + 3

    def set_speaking(self, active):
        was_talking = self.talking
        self.talking = active
        self.affect.set_speaking(active)
        if active and not was_talking:
            self.talk_start = time.monotonic()

    def _apply_emotion(self, name):
        if not self.model:
            return
        if name == self.visible_emotion:
            return
        self.visible_emotion = name
        for expression, emotions in self.expression_map.items():
            if name in emotions:
                if expression != self.active_expression:
                    self.model.SetExpression(expression)
                    self.active_expression = expression
                return
        if self.active_expression is not None:
            self.model.ResetExpression()
            self.active_expression = None

    def preview_expression(self, expression):
        if self.model and not self.talking:
            self.model.SetExpression(expression)
            self.active_expression = expression
            self.expression_deadline = self.manual_expression_until = time.monotonic() + 2.5
            self.visible_emotion = None

    def hit_region(self, position):
        if not self.model or not self.rect().contains(position.toPoint()):
            return None
        for area in ("head", "mouth", "body"):
            if self.model.IsAreaHit(area, position.x(), position.y()):
                return "head" if area == "mouth" else area
        # Some Cubism 2 packs refer to hit-area IDs absent from their moc.
        # Check the rendered alpha instead of reacting to the whole rectangle.
        frame = self.grabFramebuffer()
        if frame.isNull():
            return None
        x = min(frame.width() - 1, int(position.x() * frame.width() / max(1, self.width())))
        y = min(frame.height() - 1, int(position.y() * frame.height() / max(1, self.height())))
        if frame.pixelColor(x, y).alpha() < 32:
            return None
        return "head" if position.y() < self.height() * 0.52 else "body"

    def interact(self, region, swipe=False, held=False):
        now = time.monotonic()
        if not region or self.talking or now - self.last_interaction < 0.7:
            return
        self.last_interaction = now
        self.interaction_kind = "pat" if held and region == "head" else "swipe" if swipe else region
        emotions = ["soft", "blush"] if self.interaction_kind == "pat" else ["annoyed", "surprised"] if swipe else (
            ["blush", "surprised"] if region == "head" else ["question", "indifferent", "annoyed"])
        self.interaction_emotion = random.choice([e for e in emotions if e != self.interaction_emotion] or emotions)
        if not self.affect.react(self.interaction_emotion, now, hold=3):
            return
        if not self.reduced_motion:
            if self.interaction_kind != "pat":
                self.motion("other" if swipe else region)
        self._apply_emotion(self.interaction_emotion)
        self.expression_deadline = now + 3
        self.tapped.emit(region)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton and event.position().y() < 28 and hasattr(self.window(), "begin_window_drag"):
            self.window_drag = True
            self.window().begin_window_drag(event.globalPosition().toPoint())
            return
        self.window_drag = False
        self.last_click = event.position() if event.button() == Qt.MouseButton.LeftButton else None
        self.press_started = time.monotonic()
        self.press_region = self.hit_region(event.position()) if self.last_click is not None else None

    def mouseMoveEvent(self, event):
        if getattr(self, "window_drag", False):
            self.window().drag_window(event.globalPosition().toPoint())
            return
        event.accept()

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
        swipe = max(abs(delta.x()), abs(delta.y())) > max(24, self.width() * 0.12)
        region = self.press_region if swipe else self.hit_region(event.position())
        if self.press_region and region:
            self.interact(region, swipe, held=not swipe and time.monotonic() - self.press_started >= 0.65)
        self.last_click = None


class MciAudio:
    STALL_SECONDS = 3.0

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

    def _cancel_lane(self, lane):
        with self.lock:
            self.generation[lane] = self.generation.get(lane, 0) + 1
            generation = self.generation[lane]
            state = self.active.get(lane)
        if state:
            state["stop"].set()
        return generation, state

    def stop(self, lane):
        # Called by Qt while switching tasks/calls. Never wait for a media
        # driver here: blocking the GUI also freezes blinks and head tracking.
        self._cancel_lane(lane)

    def play(self, lane, data, suffix, loop=False, item=None, volume=1.0, cancel_event=None, start_ms=0):
        if cancel_event and cancel_event.is_set():
            return
        generation, previous = self._cancel_lane(lane)
        software_volume = False
        if suffix.lower() == ".wav":
            normalized = playable_wav(data)
            data = scale_wav_pcm16(normalized, volume)
            software_volume = data is not normalized
        handle = tempfile.NamedTemporaryFile(prefix="amadeus-native-", suffix=suffix, delete=False)
        path = Path(handle.name)
        state = None
        error = None
        try:
            # Only the playback worker waits for its predecessor. If the old
            # device cannot release, do not layer two voices over one another.
            if previous and previous["owner"] != threading.get_ident() and not previous["done"].wait(2.0):
                raise RuntimeError("上一段音频未能释放，已停止本次播放")
            handle.write(data)
            handle.close()
            alias = "amadeus" + uuid.uuid4().hex[:12]
            with self.lock:
                if self.generation.get(lane, 0) != generation or (cancel_event and cancel_event.is_set()):
                    return
            # Driver calls stay outside the state lock, so stop() remains fast
            # even when a device is slow to open or answer a status query.
            self._command(f'open "{path}" alias {alias}')
            state = {"alias": alias, "path": path, "stop": threading.Event(),
                     "done": threading.Event(), "owner": threading.get_ident()}
            with self.lock:
                if self.generation.get(lane, 0) != generation or (cancel_event and cancel_event.is_set()):
                    return
                self.active[lane] = state
            try:
                gain = 1.0 if software_volume else max(0, min(1, volume))
                self._command(f"setaudio {alias} volume to {round(gain * 1000)}")
            except Exception:
                pass
            self._command(f"set {alias} time format milliseconds")
            length = int(self._command(f"status {alias} length"))
            if length <= 0 or start_ms >= length:
                raise RuntimeError("音频时长无效，已停止播放")
            if state["stop"].is_set() or (cancel_event and cancel_event.is_set()):
                return
            self._command(f"play {alias}" + (f" from {int(start_ms)}" if start_ms > 0 else ""))
            if lane == "voice" and item:
                self.bridge.audio_started.emit(item)
            last_position = int(start_ms)
            last_progress = started = time.monotonic()
            while not state["stop"].wait(0.05):
                if cancel_event and cancel_event.is_set():
                    break
                with self.lock:
                    if self.active.get(lane) is not state:
                        break
                mode = self._command(f"status {alias} mode").lower()
                position = int(self._command(f"status {alias} position"))
                now = time.monotonic()
                if mode not in ("playing", "paused"):
                    if position < length - 150:
                        raise RuntimeError("音频在播放完毕前中断")
                    if not loop:
                        break
                    self._command(f"seek {alias} to start")
                    self._command(f"play {alias}")
                    last_position, last_progress, started, start_ms = 0, now, now, 0
                    continue
                if position > last_position:
                    last_position, last_progress = position, now
                if now - last_progress > self.STALL_SECONDS or now - started > (length - start_ms) / 1000 + self.STALL_SECONDS:
                    raise RuntimeError("音频播放停滞，已停止；可重新点击播放")
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


def recognize_once(bridge, language="zh-CN"):
    try:
        import clr
        dll = Path(os.environ["WINDIR"]) / "Microsoft.NET/Framework64/v4.0.30319/WPF/System.Speech.dll"
        clr.AddReference(str(dll))
        from System import TimeSpan
        from System.Speech.Recognition import DictationGrammar, SpeechRecognitionEngine
        recognizers = [item for item in SpeechRecognitionEngine.InstalledRecognizers()
                       if str(item.Culture).lower() == language.lower()]
        if not recognizers:
            raise RuntimeError(f"Windows {language} 听写引擎未安装")
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
        self.reaction_audio = ReactionAudioCache()
        self.reaction_preparing = False
        self.tap_draws = {}
        self.last_tap_text = None
        self.last_uncached_tap_speech = -float("inf")
        self.stop_event = threading.Event()
        self.audio = MciAudio(self.bridge)
        self.config = {}
        self.session_id = None
        self.sessions_requested = False
        self.user_started_chat = False
        self.turn_id = None
        self.pending_turn = False
        self.pending_events = []
        self.pending_payload = None
        self.turn_started_at = 0.0
        self.poll_inflight = False
        self.audio_generation = 0
        self.speech_cancel = threading.Event()
        self.active_audio_item = None
        self.speech_prefetch = None
        self.speech_voice_signature = None
        self.attachment = None
        self.call_item = None
        self.call_mode = False
        self.ring_ticket = 0
        self.ring_cancel = threading.Event()
        self.audio_queue = []
        self.audio_busy = False
        self.seen_utterances = set()
        self.welcome_started = False
        self.welcome_ready = False
        self.welcome_cancelled = False
        self.booting = True
        self.boot_status = None
        self.drag_offset = None
        self.migrated_input = False
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
        self.bridge.audio_started.connect(self._on_audio_started)
        self.turn_timer = QTimer(self)
        self.turn_timer.setInterval(3000)
        self.turn_timer.timeout.connect(self.check_turn)
        self.reaction_prepare_timer = QTimer(self)
        self.reaction_prepare_timer.setInterval(1000)
        self.reaction_prepare_timer.timeout.connect(self._prepare_reaction_audio)
        self.reaction_prepare_timer.start()
        self.avatar.gl_initialized.connect(lambda: QTimer.singleShot(0, self._load_pending_model))
        EventReader(api, self.bridge, self.stop_event).start()
        self.call("status", "/amadeus/status")
        self.call("assets", "/amadeus/assets/status")
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
        self._fit_screen()

    def _fit_screen(self):
        if not hasattr(self, "screen") or not hasattr(self, "hardware"):
            return
        full_screen = self.booting or self.call_mode
        if full_screen:
            self.phone_layout.setContentsMargins(1, 1, 1, 0)
            self.phone_layout.setSpacing(0)
            height = self.height() - 4 - 1 - self.hardware.height()
        else:
            self.phone_layout.setContentsMargins(7, 7, 7, 7)
            self.phone_layout.setSpacing(5)
            height = round(self.height() * 190 / 520)
        if self.screen.height() != height:
            self.screen.setFixedHeight(height)
        if hasattr(self, "reaction_caption") and not self.reaction_caption.isHidden():
            self._fit_reaction_caption()

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
            QPushButton:focus { border-color:#e0604f; }
            QPushButton:disabled { color:#745960; border-color:#3a252c; }
            QPushButton#iconButton { min-width:28px; max-width:28px; min-height:28px; max-height:28px; padding:0; background:transparent; font-size:16px; }
            QLineEdit { background:#150a0d; border:1px solid #47272f; border-radius:7px; padding:5px 8px; }
            QLineEdit:focus { border-color:#e0604f; }
            QListWidget, QPlainTextEdit, QComboBox { background:#26141a; border:1px solid #47272f; border-radius:6px; padding:3px; }
            QFrame#callScreen { background:qlineargradient(x1:0,y1:0,x2:1,y2:1,stop:0 #181910,stop:.5 #11120f,stop:1 #080909); border:0; }
            QLabel#callText { color:#e4c77f; font:16px Consolas; background:transparent; }
            QPushButton#connect { color:#ffdc82; font:bold 18px Georgia; background:qlineargradient(x1:0,y1:0,x2:0,y2:1,stop:0 #35140b,stop:.5 #641c0c,stop:1 #220b08); border:2px solid #ff9d27; border-radius:18px; min-height:38px; }
            QPushButton#connect:hover, QPushButton#connect:focus { color:#fff0bc; border-color:#ffdc82; }
            QPushButton#connect:pressed { background:qlineargradient(x1:0,y1:0,x2:0,y2:1,stop:0 #220b08,stop:.7 #35140b,stop:1 #641c0c); }
            QPushButton#decline { color:#b79b7a; font:10px Consolas; background:transparent; border:0; }
        """)
        check_icon = Path(__file__).with_name("check.svg").as_posix()
        self.setStyleSheet(self.styleSheet() +
            'QCheckBox::indicator { width:16px; height:16px; border:1px solid #8b4b55; border-radius:3px; background:#150a0d; }' +
            f'QCheckBox::indicator:checked {{ background:#e0604f; border-color:#e0604f; image:url("{check_icon}"); }}')
        center = PhoneFrame()
        center.setObjectName("phone")
        root = QVBoxLayout(center)
        self.phone_layout = root
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
        self.avatar.affect_changed.connect(self._on_avatar_affect)
        self.top.addWidget(self.avatar)
        call = GlossCallFrame()
        call.setObjectName("callScreen")
        self.call_screen = call
        call.status_bar = CallStatusBar(call)
        call.call_logo = CallLogo(call)
        self.call_label = QLabel("Call from Kurisu.", call)
        self.call_label.setObjectName("callText")
        self.call_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.call_label.setTextFormat(Qt.TextFormat.PlainText)
        self.call_label.setWordWrap(True)
        self.call_label.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        call.call_label = self.call_label
        accept = QPushButton("CONNECT", call)
        accept.setObjectName("connect")
        accept.setAccessibleName("接听来电")
        accept.setToolTip("接听来电")
        call.connect_button = accept
        glow = QGraphicsDropShadowEffect(accept)
        glow.setBlurRadius(13)
        glow.setColor(QColor(255, 113, 18, 160))
        glow.setOffset(0)
        accept.setGraphicsEffect(glow)
        accept.clicked.connect(self.accept_call)
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
        self.affect_label = QLabel("平静")
        self.affect_label.setObjectName("affectLabel")
        self.affect_label.setTextFormat(Qt.TextFormat.PlainText)
        self.affect_label.setStyleSheet("background:rgba(27,8,8,190);color:#d8b58b;border:1px solid #5d333d;"
                                       "border-radius:7px;padding:2px 7px;font-size:10px;")
        self.affect_label.setSizePolicy(QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Fixed)
        overlay_layout.addWidget(self.affect_label, 0, Qt.AlignmentFlag.AlignLeft)
        self.reaction_caption = QLabel()
        self.reaction_caption.setTextFormat(Qt.TextFormat.PlainText)
        self.reaction_caption.setWordWrap(True)
        self.reaction_caption.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.reaction_caption.setStyleSheet(
            "background:rgba(27,8,8,210);color:#e4c77f;border:1px solid #713824;"
            "border-radius:6px;padding:4px 6px;font-size:11px;")
        self.reaction_caption.setMinimumWidth(0)
        self.reaction_caption.hide()
        overlay_layout.addWidget(self.reaction_caption)
        self.reaction_timer = QTimer(self)
        self.reaction_timer.setSingleShot(True)
        self.reaction_timer.timeout.connect(self.reaction_caption.hide)
        self.typing_timer = QTimer(self)
        self.typing_timer.setSingleShot(True)
        self.typing_timer.timeout.connect(self._finish_composing)
        screen_stack.addWidget(overlay)
        # StackAll keeps the current widget on top. Adding the overlay alone
        # left the OpenGL model above captions, cutting text across its body.
        screen_stack.setCurrentWidget(overlay)
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
        self._fit_screen()

    def _build_chat(self):
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        self.history = HistoryView()
        layout.addWidget(self.history, 1)
        self.attachment_row = QWidget()
        attachment_layout = QHBoxLayout(self.attachment_row)
        attachment_layout.setContentsMargins(8, 3, 8, 3)
        self.attachment_label = QLabel("")
        self.attachment_label.setMinimumWidth(0)
        self.attachment_label.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Preferred)
        self.attachment_label.setTextFormat(Qt.TextFormat.PlainText)
        self.remove_image = QPushButton("移除")
        self.remove_image.setToolTip("移除待发送图片")
        self.remove_image.clicked.connect(self.clear_image)
        attachment_layout.addWidget(self.attachment_label, 1)
        attachment_layout.addWidget(self.remove_image)
        layout.addWidget(self.attachment_row)
        self.attachment_row.hide()
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
        self.mic.setAccessibleName("语音输入")
        self.mic.clicked.connect(self.start_mic)
        picture = QPushButton()
        picture.setObjectName("iconButton")
        picture.setIcon(QIcon(str(Path(__file__).with_name("image.svg"))))
        picture.setIconSize(QSize(16, 16))
        picture.setToolTip("附加图片")
        picture.setAccessibleName("附加图片")
        picture.clicked.connect(self.pick_image)
        self.input = QLineEdit()
        self.input.setPlaceholderText("和 牧濑红莉栖 说话…")
        self.input.setAccessibleName("聊天内容")
        self.input.setMinimumWidth(0)
        self.input.returnPressed.connect(self.send)
        self.input.textEdited.connect(self._on_composing)
        self.send_button = QPushButton()
        self.send_button.setObjectName("iconButton")
        self.send_icon = QIcon(str(Path(__file__).with_name("send.svg")))
        self.send_button.setIcon(self.send_icon)
        self.send_button.setIconSize(QSize(16, 16))
        self.send_button.setToolTip("发送")
        self.send_button.setAccessibleName("发送")
        self.send_button.clicked.connect(self.send)
        for widget in (self.mic, picture, self.input, self.send_button):
            row.addWidget(widget)
        layout.addWidget(input_frame)
        self.tabs.addTab(page, "对话")

    def _build_memory(self):
        page = QWidget()
        layout = QVBoxLayout(page)
        self.memory_list = QListWidget()
        self.memory_list.setWordWrap(True)
        self.memory_list.setResizeMode(QListView.ResizeMode.Adjust)
        self.memory_list.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.memory_list.setTextElideMode(Qt.TextElideMode.ElideNone)
        self.memory_list.setAccessibleName("记忆条目")
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
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        inner = QWidget()
        form = SettingsRows(inner)
        def toggle(label, section, key):
            checkbox = QCheckBox()
            checkbox.clicked.connect(lambda on: self.patch({section: {key: on}}))
            form.addRow(label, checkbox)
            return checkbox
        form.heading("对话与记忆")
        self.chat_provider = SelectionCombo()
        self.chat_provider.addItem("本机 Codex", "codex-exec")
        self.chat_provider.addItem("独立 API", "openai-compat")
        self.chat_provider.activated.connect(lambda _: self.patch({"chat": {"provider": self.chat_provider.currentData()}}))
        form.addRow("对话通道", self.chat_provider)
        self.chat_model = QLineEdit()
        self.chat_model.setPlaceholderText("沿用默认模型")
        self.chat_model.setMaxLength(120)
        form.addRow("对话模型", self.chat_model)
        save_chat = QPushButton("保存对话模型")
        save_chat.clicked.connect(self.save_chat_model)
        form.addRow("", save_chat)
        self.chat_key_button = QPushButton("设置对话 API Key")
        self.chat_key_button.clicked.connect(lambda: self.set_secret("chatApiKey", "对话 API Key"))
        form.addRow("", self.chat_key_button)
        self.api_address_button = QPushButton("设置独立 API 地址")
        self.api_address_button.clicked.connect(self.set_api_address)
        form.addRow("", self.api_address_button)
        self.mic_on = QCheckBox()
        self.mic_on.clicked.connect(lambda on: self.patch({"speechInput": {
            "provider": "windows-native" if on else "none"}}))
        form.addRow("本机语音输入", self.mic_on)
        self.oneshot_on = toggle("单句模式", "chat", "oneshot")
        self.memory_on = toggle("长期记忆", "memory", "enabled")
        self.extract_on = toggle("自动提取事实", "memory", "autoExtract")
        form.heading("语音与来电")
        self.voice_on = toggle("语音朗读", "voice", "enabled")
        self.ring_on = toggle("来电铃声", "voice", "ringEnabled")
        self.ring_volume = QSpinBox()
        self.ring_volume.setRange(0, 100)
        self.ring_volume.setSuffix(" %")
        self.ring_volume.editingFinished.connect(lambda: self.patch({"voice": {"ringVolume": self.ring_volume.value() / 100}}))
        form.addRow("铃声音量", self.ring_volume)
        self.provider = SelectionCombo()
        for name in ("qwen-local", "dashscope", "edge", "none"):
            self.provider.addItem(name)
        self.provider.activated.connect(lambda _: self.patch({"voice": {"provider": self.provider.currentText()}}))
        form.addRow("合成服务", self.provider)
        self.voice_name = QLineEdit()
        self.voice_name.setMaxLength(80)
        form.addRow("音色 ID", self.voice_name)
        self.cloud_model = QLineEdit()
        self.cloud_model.setMaxLength(60)
        self.cloud_model.setPlaceholderText("填写克隆时使用的目标模型")
        form.addRow("云端合成模型", self.cloud_model)
        save_voice = QPushButton("保存音色配置")
        save_voice.clicked.connect(self.save_voice)
        form.addRow("", save_voice)
        self.voice_key_button = QPushButton("设置语音 API Key")
        self.voice_key_button.clicked.connect(self.set_voice_key)
        form.addRow("", self.voice_key_button)
        clear_audio = QPushButton("停止播放 / 清空语音队列")
        clear_audio.clicked.connect(self.clear_audio)
        form.addRow("", clear_audio)
        form.heading("Codex 连携")
        self.say_permission = toggle("允许 Codex 发声", "permissions", "preauthorizeSay")
        self.call_permission = toggle("允许 Codex 来电", "permissions", "preauthorizeCall")
        self.broadcast_on = toggle("任务播报", "broadcast", "enabled")
        self.task_start_on = toggle("任务开始", "broadcast", "onTaskStart")
        self.task_complete_on = toggle("任务完成", "broadcast", "onTaskComplete")
        self.task_failed_on = toggle("任务失败", "broadcast", "onTaskFailed")
        self.system_tts = toggle("系统播报", "broadcast", "systemTts")
        self.system_tts.setToolTip("使用本地克隆时禁用，保证角色声线一致")
        form.heading("主动互动")
        self.idle_on = toggle("空闲主动说话", "proactive", "idleEnabled")
        self.call_on = toggle("主动来电", "proactive", "callEnabled")
        self.idle_minutes = QSpinBox()
        self.idle_minutes.setRange(1, 1440)
        self.idle_minutes.setSuffix(" 分钟")
        self.idle_minutes.editingFinished.connect(lambda: self.patch({"proactive": {"idleMs": self.idle_minutes.value() * 60000}}))
        form.addRow("空闲多久开口", self.idle_minutes)
        self.call_minutes = QSpinBox()
        self.call_minutes.setRange(10, 1440)
        self.call_minutes.setSuffix(" 分钟")
        self.call_minutes.editingFinished.connect(lambda: self.patch({"proactive": {"callIntervalMs": self.call_minutes.value() * 60000}}))
        form.addRow("来电间隔", self.call_minutes)
        form.heading("角色素材")
        refresh_assets = QPushButton("检查 / 安装模型素材")
        refresh_assets.clicked.connect(self.install_assets)
        form.addRow("", refresh_assets)
        scroll.setWidget(inner)
        page_layout.addWidget(scroll)
        self.tabs.addTab(page, "设置")

    def set_voice_key(self):
        self.set_secret("ttsApiKey", "语音 API Key")

    def set_secret(self, name, label):
        value, accepted = QInputDialog.getText(
            self, label, f"输入{label}（仅保存在本机加密存储）：",
            QLineEdit.EchoMode.Password,
        )
        if accepted and value.strip():
            self.call("secret", "/amadeus/secrets", "POST", {
                "name": name, "value": value.strip(),
            })

    def set_api_address(self):
        value, accepted = QInputDialog.getText(self, "独立 API 地址", "输入接口根地址，例如 https://api.example.com/v1：")
        if not accepted or not value.strip():
            return
        parsed = urllib.parse.urlparse(value.strip())
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            QMessageBox.warning(self, "API 地址", "请输入完整的 HTTP 或 HTTPS 地址；凭据请通过 API Key 设置。")
            return
        self.call("secret", "/amadeus/secrets", "POST", {"name": "openaiBaseUrl", "value": value.strip().rstrip("/")})

    def save_chat_model(self):
        self.chat_model.setModified(False)
        self.patch({"chat": {"model": self.chat_model.text().strip()}})

    def save_voice(self):
        self.voice_name.setModified(False)
        self.cloud_model.setModified(False)
        self.patch({"voice": {"name": self.voice_name.text().strip(), "dashscopeModel": self.cloud_model.text().strip()}})

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
        if name == "turn_state":
            self.poll_inflight = False
            return
        if name == "welcome_prepare":
            if self.welcome_cancelled:
                return
            if time.monotonic() < self.welcome_deadline and not self.pending_turn and not self.call_item:
                self.status.setText("克隆音色启动中，开场白稍后播放…")
                QTimer.singleShot(5000, self._retry_welcome)
            else:
                self.status.setText("克隆音色未就绪，请检查本地 Qwen 服务")
            return
        self.status.setText(f"{name}: {error[:52]}")
        if name == "chat":
            if self.pending_payload:
                if not self.input.text():
                    self.input.setText(self.pending_payload.get("text", ""))
                if not self.attachment and self.pending_payload.get("image"):
                    self.attachment = self.pending_payload["image"]
                    self.attachment_label.setText("待发送：上次未发出的图片")
                    self.attachment_row.show()
            self._finish_turn_wait()
            self.history.add_entry("system", "⚠ " + error)
            self.avatar.set_activity("error")
        elif name == "assets":
            self.diag_text.setPlainText("模型加载失败：" + error)

    def _on_result(self, name, result):
        if name == "speech_prefetch":
            if self.speech_prefetch is result and (
                    not result["valid"] or result["generation"] != self.audio_generation or
                    result["signature"] != self._speech_voice_identity()):
                self.speech_prefetch = None
                self._prepare_next_speech()
            return
        if name == "reaction_prepare":
            self.reaction_preparing = False
            if self.stop_event.is_set():
                return
            if result.get("error"):
                self.reaction_audio.failed(result["signature"], result["line"], time.monotonic())
            else:
                if not self.reaction_audio.store(result["signature"], result["line"], result["audio"], result["mime"]):
                    self.reaction_audio.failed(result["signature"], result["line"], time.monotonic())
            QTimer.singleShot(0, self._prepare_reaction_audio)
            return
        if name == "status":
            self.config = result.get("config") or {}
            self.character_content = result.get("characterContent") or {}
            self._configure_reaction_audio()
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
            self.say_permission.setChecked(self.config.get("permissions", {}).get("preauthorizeSay", False))
            self.call_permission.setChecked(self.config.get("permissions", {}).get("preauthorizeCall", False))
            self.system_tts.setChecked(self.config.get("broadcast", {}).get("systemTts", False))
            self.system_tts.setEnabled(voice.get("provider") != "qwen-local")
            self.chat_provider.setCurrentIndex(max(0, self.chat_provider.findData(self.config.get("chat", {}).get("provider"))))
            for widget, value in ((self.voice_name, voice.get("name", "")),
                                  (self.cloud_model, voice.get("dashscopeModel", "")),
                                  (self.chat_model, self.config.get("chat", {}).get("model", ""))):
                if not widget.hasFocus() and not widget.isModified():
                    widget.setText(value)
            for widget, value in ((self.ring_volume, round(voice.get("ringVolume", 0.7) * 100)),
                                  (self.idle_minutes, self.config.get("proactive", {}).get("idleMs", 1200000) // 60000),
                                  (self.call_minutes, self.config.get("proactive", {}).get("callIntervalMs", 36000000) // 60000)):
                if not widget.hasFocus():
                    widget.setValue(value)
            self.extract_on.setEnabled(self.memory_on.isChecked())
            self.cloud_model.setEnabled(voice.get("provider") == "dashscope")
            self.input.setPlaceholderText("和 " + (self.character_content.get("displayName") or "Amadeus") + " 说话…")
            for button, key, label in ((self.chat_key_button, "chatApiKey", "对话 API Key"),
                                       (self.voice_key_button, "ttsApiKey", "语音 API Key"),
                                       (self.api_address_button, "openaiBaseUrl", "独立 API 地址")):
                configured = result.get("secrets", {}).get(key, {}).get("configured", False)
                button.setText(("修改" if configured else "设置") + label)
                button.setToolTip("已保存在本机" if configured else "尚未设置")
            self.provider.setCurrentText(voice.get("provider", "edge"))
            provider = result.get("voice", {}).get("provider") or "—"
            memory = result.get("memory", {}).get("panel", {})
            if not self.pending_turn:
                self.status.setText(f"{provider} · 长期 {memory.get('durable', 0)} / 提要 {memory.get('recaps', 0)}")
            if not self.sessions_requested:
                self.sessions_requested = True
                self.call("sessions", "/amadeus/sessions")
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
            # Startup discovery must never erase a message already submitted.
            if self.user_started_chat:
                return
            sessions = ([s for s in result.get("sessions", []) if not s.get("endedAt")]
                        if not self.config.get("chat", {}).get("oneshot", True) else [])
            if sessions:
                self.session_id = sessions[0]["id"]
                self.call("history", f"/amadeus/sessions/{self.session_id}/messages")
            else:
                self.session_id = None
                self.history.clear()
        elif name == "history":
            if result.get("session", {}).get("id") != self.session_id:
                return
            self.history.clear()
            for item in result.get("messages", []):
                self.add_message(item.get("role"), item.get("zh") or item.get("ja") or "")
        elif name == "chat":
            if not self.pending_turn:
                self.call("cancel", "/amadeus/chat/cancel", "POST", {"turnId": result["turnId"]})
                return
            self.turn_id = result["turnId"]
            self.session_id = result["sessionId"]
            if getattr(self, "cancel_requested", False):
                self.call("cancel", "/amadeus/chat/cancel", "POST", {"turnId": self.turn_id})
            for kind, data in self.pending_events:
                self._on_event(kind, data)
            self.pending_events.clear()
        elif name == "turn_state":
            self.poll_inflight = False
            turn = result.get("turn", {})
            if not self.pending_turn or turn.get("id") != self.turn_id:
                return
            payload = {"turnId": turn["id"], "sessionId": turn.get("sessionId"),
                       "closed": turn.get("closed", False)}
            if turn.get("status") == "done":
                self._on_event("turn:done", {**payload, **(turn.get("result") or {})})
            elif turn.get("status") == "error":
                self._on_event("turn:error", {**payload, "error": turn.get("error")})
            else:
                self._on_event("turn:status", {**payload, "phase": turn.get("phase", "generating")})
        elif name == "memory":
            self.memory_list.clear()
            self.memories = result.get("entries", [])
            for item in self.memories:
                kind = "对话提要" if item.get("source") == "conversation" or item.get("type") == "recap" else "长期记忆"
                entry = QListWidgetItem(f"[{kind}] {item.get('content', '')}")
                sources = {"auto-extract": "从用户发言提取", "conversation": "聊天提要", "mcp": "Codex 记录", "api": "手动记录"}
                entry.setToolTip(f"{sources.get(item.get('source'), '本机记忆')}\n{item.get('content', '')}")
                self.memory_list.addItem(entry)
        elif name == "memory_export":
            filename, _ = QFileDialog.getSaveFileName(self, "导出记忆", "amadeus-memory.json", "JSON (*.json)")
            if filename:
                try:
                    Path(filename).write_text(json.dumps(result.get("data"), ensure_ascii=False, indent=2), encoding="utf-8")
                    self.status.setText("记忆已导出")
                except OSError as error:
                    QMessageBox.warning(self, "导出记忆", "文件无法保存：" + str(error))
        elif name in ("memory_delete", "memory_clear"):
            self.refresh_memory()
        elif name == "diag":
            self.diag_text.setPlainText(json.dumps(result, ensure_ascii=False, indent=2))
        elif name == "config":
            self.config = result.get("config", self.config)
            self._configure_reaction_audio()
            if self.config.get("voice", {}).get("enabled") is False:
                self._stop_speech()
            if result.get("rejected"):
                self.status.setText("设置未保存：" + "、".join(result["rejected"]))
            else:
                self.status.setText("设置已保存")
        elif name == "secret":
            self.status.setText("设置已保存到本机")
            self.call("status", "/amadeus/status")
        elif name == "install_assets":
            self.call("assets", "/amadeus/assets/status")
        elif name == "welcome_prepare":
            self.welcome_ready = bool(result.get("ready"))
            if (result.get("ready") and not self.welcome_cancelled and not self.pending_turn
                    and not self.call_item and not self.audio_busy):
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
        if (self.welcome_started or self.welcome_cancelled or self.call_item or not self.api.welcome or
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
        if (self.welcome_started and not self.welcome_cancelled and time.monotonic() < self.welcome_deadline and
                not self.pending_turn and not self.call_item and not self.audio_busy and self.isVisible()):
            self.call("welcome_prepare", "/amadeus/tts/prepare", "POST", self.welcome_line)

    def _finish_boot(self):
        if not self.booting:
            return
        self.booting = False
        if self.top.currentWidget() == self.splash:
            self.top.setCurrentWidget(self.avatar)
            self.hinge.show()
            self.keypad.show()
            self.screen_header.show()
            self._fit_screen()
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
            self.avatar.load(model.get("entry"), model.get("motionMap"), model.get("expressionMap"),
                             model.get("layout"), model.get("parameterMap"))
        except Exception as error:
            self.status.setText("模型加载失败：" + str(error)[:45])

    def _set_call_mode(self, active):
        self.call_mode = active
        if active:
            self.booting = False
            self.splash.stop()
            self.screen_header.hide()
            self.hinge.hide()
            self.keypad.hide()
            self._fit_screen()
            self.top.setCurrentWidget(self.call_screen)
            self.hardware_key.setToolTip("拒接来电")
        else:
            self.hinge.show()
            self.keypad.show()
            self.top.setCurrentWidget(self.avatar)
            self.screen_header.show()
            self._fit_screen()
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
            self._stop_speech()
            self.cancel_requested = True
            self.status.setText("正在取消…")
            if self.turn_id:
                self.call("cancel", "/amadeus/chat/cancel", "POST", {"turnId": self.turn_id})
            return
        text = self.input.text().strip()
        if not text and not self.attachment:
            return
        self.user_started_chat = True
        self.welcome_cancelled = True
        self._stop_speech()
        self.typing_timer.stop()
        self.reaction_caption.hide()
        self.avatar.set_activity("thinking")
        payload = {"sessionId": self.session_id, "text": text}
        if self.attachment:
            payload["image"] = self.attachment
        self.add_message("user", text + (" [图片]" if self.attachment else ""))
        self.input.clear()
        self.clear_image()
        self.pending_turn = True
        self.pending_payload = payload
        self.pending_events.clear()
        self.cancel_requested = False
        self.turn_started_at = time.monotonic()
        self.turn_id = None
        self.send_button.setIcon(QIcon())
        self.send_button.setText("×")
        self.send_button.setToolTip("取消回复")
        self.send_button.setAccessibleName("取消回复")
        self.status.setText("正在连接模型…")
        self.turn_timer.start()
        self.call("chat", "/amadeus/chat", "POST", payload)

    def check_turn(self):
        if not self.pending_turn:
            self.turn_timer.stop()
            return
        if time.monotonic() - self.turn_started_at >= 75:
            if self.turn_id:
                self.call("cancel", "/amadeus/chat/cancel", "POST", {"turnId": self.turn_id})
            self._finish_turn_wait()
            self.session_id = None
            self.add_message("system", "回复连接超时，请检查模型服务或网络后重试。")
            self.status.setText("回复连接超时")
            self.avatar.set_activity("error")
            return
        if self.turn_id and not self.poll_inflight:
            self.poll_inflight = True
            self.call("turn_state", "/amadeus/chat?" + urllib.parse.urlencode({"turnId": self.turn_id}))

    def _finish_turn_wait(self):
        self.pending_turn = False
        self.turn_id = None
        self.pending_payload = None
        self.poll_inflight = False
        self.turn_timer.stop()
        self.avatar.set_activity("idle")
        self.send_button.setText("")
        self.send_button.setIcon(self.send_icon)
        self.send_button.setToolTip("发送")
        self.send_button.setAccessibleName("发送")

    def pick_image(self):
        filename, _ = QFileDialog.getOpenFileName(self, "选择图片", "", "Images (*.png *.jpg *.jpeg *.webp)")
        if not filename:
            return
        try:
            if Path(filename).stat().st_size > MAX_IMAGE:
                raise ValueError("请选择 3 MB 以内的图片")
            data = Path(filename).read_bytes()
        except (OSError, ValueError) as error:
            QMessageBox.warning(self, "图片", str(error))
            return
        mime = mimetypes.guess_type(filename)[0]
        if len(data) > MAX_IMAGE or mime not in ("image/png", "image/jpeg", "image/webp"):
            QMessageBox.warning(self, "图片", "请选择 3 MB 以内的 PNG、JPEG 或 WebP")
            return
        self.attachment = {"mime": mime, "data": base64.b64encode(data).decode("ascii")}
        name = Path(filename).name
        self.attachment_label.setText("待发送：" + (name if len(name) <= 20 else name[:17] + "…"))
        self.attachment_label.setToolTip(name)
        self.attachment_row.show()

    def clear_image(self):
        self.attachment = None
        self.attachment_label.clear()
        self.attachment_row.hide()

    def start_mic(self):
        if self.config.get("speechInput", {}).get("provider") == "none":
            self.status.setText("语音输入已关闭")
            return
        if not self.mic.isEnabled():
            return
        self.mic.setEnabled(False)
        self.status.setText("正在听…")
        if not self.pending_turn:
            self.avatar.set_activity("listening")
        language = self.config.get("speechInput", {}).get("lang") or "zh-CN"
        threading.Thread(target=recognize_once, args=(self.bridge, language), daemon=True).start()

    def _on_speech_done(self, text, error):
        self.mic.setEnabled(True)
        self.avatar.set_activity("thinking" if self.pending_turn else "error" if error else "idle")
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
            self.check_turn()
        elif kind == "hello":
            for item in data.get("pending", []):
                self._utterance(item)
        elif kind == "pending":
            for item in data.get("pending", []):
                self._utterance(item)
        elif kind == "utterance":
            self._utterance(data)
        elif kind == "config":
            if data.get("config"):
                self.config = data["config"]
                self._configure_reaction_audio()
            if data.get("config", {}).get("voice", {}).get("enabled") is False:
                self._stop_speech()
            self.call("status", "/amadeus/status")
        elif kind == "memory":
            if self.tabs.currentIndex() == 1:
                self.refresh_memory()
            self.call("status", "/amadeus/status")
        elif kind == "cleared":
            self._stop_speech()
            if self.call_item:
                self.deny_call()
        elif kind == "audio-owner" and data.get("owner") != self.api.client:
            self._stop_speech()
            if self.call_item:
                self.deny_call()
        elif kind == "turn:status" and self.pending_turn:
            if self.turn_id and data.get("turnId") != self.turn_id:
                return
            phases = {"queued": "等待处理", "preparing": "准备对话", "connecting": "连接模型",
                      "generating": "等待回答", "retrying": "服务重试", "reply": "接收回答"}
            self.status.setText("正在回答：" + phases.get(data.get("phase"), "处理中"))
            self.avatar.set_activity("thinking")
        elif kind in ("turn:done", "turn:error"):
            if self.pending_turn and self.turn_id is None:
                self.pending_events.append((kind, data))
                return
            if data.get("turnId") != self.turn_id:
                return
            self._finish_turn_wait()
            if kind == "turn:done":
                self.add_message("assistant", data.get("zh") or data.get("ja") or "")
                self.avatar.emotion(data.get("emotion", "neutral"))
                if data.get("closed"):
                    self.session_id = None
                self.status.setText("已回复 · 单句会话已结束" if data.get("closed") else "已回复")
            else:
                self.add_message("system", "回复失败：" + data.get("error", "未知错误"))
                self.avatar.set_activity("error")
                if data.get("closed"):
                    self.session_id = None
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
        if self._old_task_announcement(item):
            return
        self._stop_tap_audio()
        if item.get("kind") == "call":
            self._stop_speech()
            self.welcome_cancelled = True
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
        else:
            self._prepare_next_speech()

    def _speech_voice_identity(self):
        voice = self.config.get("voice", {})
        return json.dumps({key: voice.get(key) for key in (
            "enabled", "provider", "name", "localModel", "rate", "pitch", "stability", "emotionIntensity")},
            sort_keys=True, ensure_ascii=False)

    def _invalidate_speech_prefetch(self):
        if self.speech_prefetch:
            self.speech_prefetch["valid"] = False
            self.speech_prefetch["future"].cancel()
            # An in-flight local request cannot be interrupted through urllib.
            # Keep its slot occupied until completion instead of spawning more.
            if self.speech_prefetch["future"].done():
                self.speech_prefetch = None

    def _speech_timeout(self):
        # Local cold start may wait 360s, then synthesis has its own 180s bound.
        return 570 if self.config.get("voice", {}).get("provider") == "qwen-local" else 90

    def _prepare_next_speech(self):
        voice = self.config.get("voice", {})
        if (self.stop_event.is_set() or self.pending_turn or self.call_item or
                not self.avatar.talking or not self.active_audio_item or
                self.active_audio_item.get("kind") != "say" or
                voice.get("provider") != "qwen-local" or not voice.get("enabled") or
                not self.audio_queue or self.audio_queue[0].get("kind") != "say"):
            return
        if self.speech_prefetch:
            if self.speech_prefetch["valid"] or not self.speech_prefetch["future"].done():
                return
            self.speech_prefetch = None
        item = self.audio_queue[0]
        future = Future()
        slot = {"item": item, "future": future, "valid": True,
                "generation": self.audio_generation, "signature": self._speech_voice_identity()}
        self.speech_prefetch = slot
        query = urllib.parse.urlencode({"text": item.get("text") or "",
                                        "emotion": item.get("emotion") or "neutral"})
        def prepare():
            if not future.set_running_or_notify_cancel():
                return
            try:
                audio, mime = self.api.request("/amadeus/tts?" + query, binary=True, timeout=570)
                if not isinstance(audio, bytes) or len(audio) > 8 * 1024 * 1024:
                    raise RuntimeError("下一段语音数据过大，已停止预取")
                future.set_result((audio, mime) if slot["valid"] and not self.stop_event.is_set() else None)
            except Exception as error:
                future.set_exception(error)
            if not self.stop_event.is_set():
                self.bridge.result.emit("speech_prefetch", slot)
        threading.Thread(target=prepare, name="speech-prefetch", daemon=True).start()

    def _next_audio(self):
        while self.audio_queue and self._old_task_announcement(self.audio_queue[0]):
            self.audio_queue.pop(0)
        if not self.audio_queue:
            self.audio_busy = False
            self.active_audio_item = None
            self._set_talking(False)
            return
        queued_item = self.audio_queue.pop(0)
        prefetch = self.speech_prefetch
        if not (prefetch and prefetch["valid"] and prefetch["item"] is queued_item and
                prefetch["generation"] == self.audio_generation and
                prefetch["signature"] == self._speech_voice_identity()):
            prefetch = None
        item = {**queued_item, "_generation": self.audio_generation}
        if prefetch:
            item["_speech_prefetch"] = prefetch
        self.audio_busy = True
        self.active_audio_item = item
        cancel_event = self.speech_cancel
        self.avatar.emotion(item.get("emotion", "neutral"))
        text = item.get("text") or ""
        query = urllib.parse.urlencode({"text": text, "emotion": item.get("emotion") or "neutral"})
        timeout = self._speech_timeout()
        def work():
            try:
                if item["_generation"] != self.audio_generation or cancel_event.is_set() or self.stop_event.is_set():
                    return
                prepared = item.get("_prepared_audio")
                if prepared is None and prefetch:
                    # Wait in the playback worker, never in Qt or with a second
                    # request. Cancellation releases this waiter immediately.
                    deadline = time.monotonic() + timeout
                    while not cancel_event.is_set() and not self.stop_event.is_set():
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise RuntimeError("下一段语音准备超时，已停止等待")
                        try:
                            prepared = prefetch["future"].result(timeout=min(.1, remaining))
                            break
                        except FutureTimeout:
                            continue
                    if cancel_event.is_set() or self.stop_event.is_set() or prepared is None:
                        return
                audio, mime = prepared if prepared is not None else self.api.request("/amadeus/tts?" + query, binary=True, timeout=timeout)
                if item["_generation"] != self.audio_generation or self.stop_event.is_set():
                    return
                if item.get("kind") == "tap" and time.monotonic() > item["_expires"]:
                    self.bridge.audio_done.emit(item, "")
                    return
                if self._old_task_announcement(item):
                    self.bridge.audio_done.emit(item, "")
                    return
                suffix = ".wav" if "wav" in mime else ".mp3"
                start_ms = leading_silence_ms(playable_wav(audio)) if item.get("kind") == "tap" else 0
                self.audio.play("voice", audio, suffix, item=item, cancel_event=cancel_event, start_ms=start_ms)
            except Exception as error:
                self.bridge.audio_done.emit(item, str(error))
        self.pool.submit(work)

    @staticmethod
    def _old_task_announcement(item):
        if item.get("kind") != "broadcast":
            return False
        try:
            return time.time() * 1000 - float(item.get("ts", 0)) > 60_000
        except (TypeError, ValueError):
            return False

    def _on_audio_done(self, item, error):
        if item is None:
            return
        if item.get("kind") == "ring":
            if error and self.call_item:
                self.status.setText("来电铃声播放失败：" + str(error)[:55])
            return
        if item.get("_generation", self.audio_generation) != self.audio_generation:
            return
        if item is not self.active_audio_item:
            return
        if self.speech_prefetch is item.get("_speech_prefetch"):
            self._invalidate_speech_prefetch()
        self._set_talking(False)
        if error:
            self.status.setText("语音播放失败：" + str(error)[:58])
            self.call("audio_report", "/amadeus/report", "POST", {
                "level": "warn", "message": "native speech playback failed",
                "detail": str(error)[:500], "where": "native audio",
            })
        self._next_audio()
        if self.pending_turn and not self.audio_busy:
            self.avatar.set_activity("thinking")

    def _set_talking(self, active):
        self.avatar.set_speaking(active)

    def _on_audio_started(self, item):
        if (not self.stop_event.is_set() and self.active_audio_item is item and
                item.get("_generation") == self.audio_generation):
            if self.speech_prefetch is item.get("_speech_prefetch"):
                self.speech_prefetch = None
            self._set_talking(True)
            self._prepare_next_speech()

    def _stop_speech(self):
        self.audio_generation += 1
        self.speech_cancel.set()
        self.speech_cancel = threading.Event()
        self._invalidate_speech_prefetch()
        self.audio_queue.clear()
        self.audio_busy = False
        self.active_audio_item = None
        self.welcome_cancelled = True
        self.audio.stop("voice")
        self._set_talking(False)

    def _stop_tap_audio(self):
        if self.active_audio_item and self.active_audio_item.get("kind") == "tap":
            self._stop_speech()

    def _configure_reaction_audio(self):
        signature = self._speech_voice_identity()
        if self.speech_voice_signature is not None and signature != self.speech_voice_signature:
            self._stop_speech()
        self.speech_voice_signature = signature
        if self.reaction_audio.configure(self.config.get("voice", {}),
                                         self.character_content.get("tapReactions") or []):
            self._stop_tap_audio()
            self.tap_draws.clear()
            self.last_tap_text = None

    def _prepare_reaction_audio(self):
        # One background request at a time. Ordinary conversation and greetings
        # get priority; preparing a fixed reaction never queues speech for later.
        if (self.stop_event.is_set() or self.reaction_preparing or self.booting or
                self.pending_turn or self.audio_busy or self.call_item or
                not self.isVisible()):
            return
        if (self.welcome_started and not self.welcome_ready and not self.welcome_cancelled and
                time.monotonic() < self.welcome_deadline):
            return
        line = self.reaction_audio.next_line(time.monotonic())
        if not line:
            return
        self.reaction_preparing = True
        signature = self.reaction_audio.signature
        def work():
            result = {"signature": signature, "line": line}
            try:
                query = urllib.parse.urlencode({"text": line["text"], "emotion": "neutral"})
                audio, mime = self.api.request("/amadeus/tts?" + query, binary=True, timeout=240)
                result.update(audio=audio, mime=mime)
            except Exception as error:
                result["error"] = str(error)
            if not self.stop_event.is_set():
                self.bridge.result.emit("reaction_prepare", result)
        # A cold local service may take minutes. Closing the panel must not wait
        # for this optional preparation request to finish.
        threading.Thread(target=work, name="reaction-prepare", daemon=True).start()

    def clear_audio(self):
        self._stop_speech()
        if self.call_item:
            self.deny_call()
        self.call("clear_audio", "/amadeus/action", "POST", {"cmd": "clear"})

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

    def _pick_tap_line(self, gesture):
        """Draw a random unused line for this gesture; newly warmed lines join in.

        The selected words own the face. Filtering by the avatar's provisional
        reaction would permanently hide most emotions and their lines.
        """
        lines = self.character_content.get("tapReactions") or []
        scoped = [line for line in lines if gesture in line.get("gestures", [])]
        candidates = scoped or [line for line in lines if not line.get("gestures")]
        candidates = list({line["text"]: line for line in candidates
                           if isinstance(line.get("text"), str) and line["text"].strip()}.values())
        if not candidates:
            return None
        # Choose within the requested gesture. Do not substitute another action's
        # words just because its audio is ready, and never switch the speaker.
        ready = [line for line in candidates if self.reaction_audio.ready(line)]
        candidates = ready or candidates
        drawn = self.tap_draws.setdefault(gesture, set())
        drawn.intersection_update(line["text"] for line in candidates)
        unused = [line for line in candidates if line["text"] not in drawn]
        if not unused:
            drawn.clear()
            unused = candidates
        # Also avoid repeating the last phrase at a round/gesture boundary when
        # an alternative exists. Single-line custom characters remain supported.
        alternatives = [line for line in unused if line["text"] != self.last_tap_text]
        line = random.choice(alternatives or unused)
        drawn.add(line["text"])
        self.last_tap_text = line.get("text")
        return line

    def _on_avatar_tap(self, region="body"):
        if self.pending_turn or self.audio_busy or self.call_item:
            return
        voice = self.config.get("voice", {})
        # Cached clone playback marks itself busy immediately. Other providers
        # still need a network event, so retain their submission debounce.
        if (voice.get("enabled") and voice.get("provider") != "qwen-local" and
                time.monotonic() - self.last_uncached_tap_speech < 3.5):
            return
        gesture = getattr(self.avatar, "interaction_kind", region)
        line = self._pick_tap_line(gesture)
        if not line:
            return
        self.avatar.reaction(line.get("emotion", "neutral"))
        self.reaction_caption.setText(line.get("cn") or line.get("text", ""))
        self._fit_reaction_caption()
        self.reaction_caption.show()
        self.reaction_timer.start(3500)
        # This touch is asynchronous and never queues audio. It keeps the idle
        # scheduler aware of activity even when the clip is played locally.
        self.call("claim", "/amadeus/client/active", "POST", {})
        if not self.config.get("voice", {}).get("enabled"):
            return
        prepared = self.reaction_audio.ready(line)
        if self.config.get("voice", {}).get("provider") == "qwen-local":
            if prepared is None:
                self.status.setText("互动语音准备中，表情与字幕可用")
                self._prepare_reaction_audio()
                return
            self.audio_queue.append({**line, "kind": "tap", "_prepared_audio": prepared,
                                     "_expires": time.monotonic() + 1.0})
            self._next_audio()
            return
        self.last_uncached_tap_speech = time.monotonic()
        self.call("tap_say", "/amadeus/say", "POST", {"text": line.get("text"), "emotion": line.get("emotion")})

    def _on_avatar_affect(self, activity, emotion):
        label = EMOTION_LABELS.get(emotion, "平静")
        text = "在听" if activity == "listening" else "思考中" if activity == "thinking" else label
        self.affect_label.setText(text)
        self.affect_label.setAccessibleName("当前情绪：" + text)

    def _fit_reaction_caption(self):
        self.reaction_caption.ensurePolished()
        width = max(80, self.screen.width() - 24)
        self.reaction_caption.setMaximumWidth(width)
        bounds = self.reaction_caption.fontMetrics().boundingRect(
            QRect(0, 0, width - 14, 1000), Qt.TextFlag.TextWordWrap, self.reaction_caption.text())
        self.reaction_caption.setFixedHeight(max(22, bounds.height() + 12))

    def _on_composing(self, text):
        if not self.pending_turn and not self.audio_busy:
            self.avatar.set_activity("listening" if text else "idle")
            self.typing_timer.start(4000)

    def _finish_composing(self):
        if not self.pending_turn and self.mic.isEnabled():
            self.avatar.set_activity("idle")

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
        self.speech_cancel.set()
        self._invalidate_speech_prefetch()
        self.reaction_prepare_timer.stop()
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
