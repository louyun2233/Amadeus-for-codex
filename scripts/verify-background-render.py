r"""Windows real-screen check: never use QWidget.grab to validate GL composition.

Requires the installed native runtime/model and an unlocked visible desktop.
Run: .native-venv\Scripts\python.exe scripts/verify-background-render.py
Uses synthetic solid backgrounds, no API calls, music or user conversations.
"""
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from PySide6.QtCore import QPoint, QTimer
from PySide6.QtGui import QColor, QPixmap
from PySide6.QtWidgets import QApplication
import live2d

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'native'))
import panel as p

entry = Path(os.environ.get('AMADEUS_DATA_DIR') or
             Path(os.environ['LOCALAPPDATA']) / 'Amadeus') / 'cache/models/kurisu/versions/1.0.0/kurisu.model.json'
if not entry.is_file():
    raise SystemExit('Install the default model before running this visible-desktop check.')
live2d.init()
app = QApplication([])
window = p.Live2DView()
window.resize(300, 200)
window.show()
window.raise_()
window.activateWindow()
p.QCursor = SimpleNamespace(pos=lambda: window.mapToGlobal(QPoint(150, 100)))
checks, errors = [], []
colors = ['#285c68', '#804828', None]


def select(index):
    image = QPixmap(64, 64) if colors[index] else QPixmap()
    if colors[index]:
        image.fill(QColor(colors[index]))
    window.scene_background = image
    window.update()
    QTimer.singleShot(500, lambda: capture(index))


def capture(index):
    # Capturing the desktop does not force an offscreen Qt widget redraw.
    origin = window.mapToGlobal(QPoint(0, 0))
    frame = window.screen().grabWindow(0, origin.x(), origin.y(), window.width(), window.height()).toImage()
    observed = frame.pixelColor(round(frame.width() * .06), round(frame.height() * .08))
    expected = QColor(colors[index] or '#000000')
    delta = max(abs(a - b) for a, b in zip(observed.getRgb()[:3], expected.getRgb()[:3]))
    checks.append({'expected': expected.name(), 'observed': observed.name(), 'ok': delta <= 5})
    if index + 1 < len(colors):
        select(index + 1)
    else:
        window.close()
        app.quit()


def begin():
    try:
        pack = json.loads((root / 'config/assets.registry.json').read_text(encoding='utf-8'))['packs'][0]
        window.load(entry, pack['motionMap'], pack['expressionMap'], pack['layout'])
        select(0)
    except Exception as error:
        errors.append(type(error).__name__)
        window.close()
        app.quit()


QTimer.singleShot(200, begin)
app.exec()
live2d.dispose()
print(json.dumps({'onscreen': checks, 'errors': errors}))
raise SystemExit(0 if len(checks) == 3 and all(row['ok'] for row in checks) and not errors else 1)
