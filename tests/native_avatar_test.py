"""Native avatar behavior without a GPU, daemon, or private model assets."""
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "native"))
from PySide6.QtCore import QPointF
from PySide6.QtGui import QColor, QImage
from PySide6.QtWidgets import QApplication
from panel import BlinkShortener, Live2DView


class AvatarTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def test_half_open_expression_is_not_a_blink(self):
        blink = BlinkShortener()
        for i in range(120):
            self.assertEqual(blink.values(0.7, 0.7, i / 60), (None, None))

    def test_long_closure_reopens_to_prior_expression(self):
        blink = BlinkShortener()
        blink.values(0.7, 0.7, 0)
        self.assertEqual(blink.values(0, 0, 1), (0, 0))
        self.assertEqual(blink.values(0, 0, 1.03), (0, 0))
        self.assertEqual(blink.values(0, 0, 1.2), (0.7, 0.7))
        self.assertEqual(blink.values(0, 0, 3), (0.7, 0.7))
        self.assertEqual(blink.values(0.7, 0.7, 4), (None, None))
        self.assertEqual(blink.values(0, 0, 5), (0, 0))

    def test_wink_is_preserved(self):
        blink = BlinkShortener()
        self.assertEqual(blink.values(0, 1, 0), (0, None))
        self.assertEqual(blink.values(0, 1, .03), (0, None))
        self.assertEqual(blink.values(0, .7, .2), (1, None))
        self.assertEqual(blink.values(0, .7, 10), (1, None))

    def test_independent_eyes_recover_without_losing_asymmetric_expression(self):
        blink = BlinkShortener()
        blink.values(.75, 1, 0)
        blink.values(-1, 1, .1)
        self.assertEqual(blink.values(-1, 1, .3), (.75, None))
        self.assertEqual(blink.values(-1, 0, .4), (.75, 0))
        self.assertEqual(blink.values(.75, 0, .6), (None, 1))

    def test_emotion_changes_do_not_restart_stuck_eye_recovery(self):
        blink = self.avatar.blink
        blink.values(0, 0, 0)
        self.avatar._apply_emotion("sad")
        self.avatar._apply_emotion("surprised")
        self.avatar.preview_expression("f02")
        self.assertIs(self.avatar.blink, blink)
        self.assertEqual(blink.values(0, 0, .3), (1, 1))

    def test_repeated_or_shared_expression_does_not_restart_sdk_fade(self):
        self.avatar._apply_emotion("surprised")
        self.avatar._apply_emotion("surprised")
        self.avatar._apply_emotion("blush")
        self.avatar.model.SetExpression.assert_called_once_with("f04")
        self.avatar._apply_emotion("neutral")
        self.avatar._apply_emotion("thinking")
        self.avatar.model.ResetExpression.assert_called_once()

    def test_repeated_speaking_signal_does_not_restart_lip_phase(self):
        with patch("panel.time.monotonic", return_value=10):
            self.avatar.set_speaking(True)
        with patch("panel.time.monotonic", return_value=11):
            self.avatar.set_speaking(True)
        self.assertEqual(self.avatar.talk_start, 10)

    def setUp(self):
        self.avatar = Live2DView()
        self.avatar.resize(200, 200)
        self.avatar.model = Mock()
        self.avatar.model.IsAreaHit.return_value = False
        self.avatar.model_motions = {"flick_head": [{}, {}], "tap_body": [{}, {}], "pinch_in": [{}]}
        self.avatar.expression_map = {"f02": ["soft"], "f04": ["blush", "surprised"]}
        self.avatar.reduced_motion = False

    def tearDown(self):
        self.avatar.close()
        self.avatar.deleteLater()
        self.app.processEvents()

    def test_transparent_background_is_not_a_character_hit_at_high_dpi(self):
        frame = QImage(400, 400, QImage.Format.Format_ARGB32)
        frame.fill(QColor(0, 0, 0, 0))
        frame.setPixelColor(200, 140, QColor(180, 100, 50, 255))
        with patch.object(self.avatar, "grabFramebuffer", return_value=frame):
            self.assertIsNone(self.avatar.hit_region(QPointF(10, 70)))
            self.assertEqual(self.avatar.hit_region(QPointF(100, 70)), "head")

    def test_defined_hit_area_wins(self):
        self.avatar.model.IsAreaHit.side_effect = lambda area, x, y: area == "body"
        self.assertEqual(self.avatar.hit_region(QPointF(100, 70)), "body")

    def test_interactions_have_cooldown_and_do_not_repeat_motion(self):
        events = []
        self.avatar.tapped.connect(events.append)
        with patch("panel.time.monotonic", return_value=10):
            self.avatar.interact("head")
            self.avatar.interact("head")
        first = self.avatar.last_motion["flick_head"]
        with patch("panel.time.monotonic", return_value=11):
            self.avatar.interact("head")
        self.assertEqual(events, ["head", "head"])
        self.assertNotEqual(self.avatar.last_motion["flick_head"], first)
        self.assertEqual(self.avatar.base_emotion, "neutral")
        self.assertEqual(self.avatar.expression_deadline, 14)

    def test_tap_cannot_replace_speaking_expression(self):
        self.avatar.emotion("soft")
        self.avatar.talking = True
        self.avatar.interact("head")
        self.assertEqual(self.avatar.base_emotion, "soft")
        self.avatar.model.StartMotion.assert_not_called()
        self.avatar.model.SetExpression.assert_called_once_with("f02")

    def test_new_chat_emotion_cancels_temporary_expression(self):
        self.avatar.interact("head")
        self.avatar.emotion("soft")
        self.assertEqual(self.avatar.expression_deadline, 0)
        self.avatar.model.SetExpression.assert_called_with("f02")

    def test_reduced_motion_keeps_interaction_without_large_motion(self):
        self.avatar.reduced_motion = True
        events = []
        self.avatar.tapped.connect(events.append)
        self.avatar.interact("head")
        self.assertEqual(events, ["head"])
        self.avatar.model.StartMotion.assert_not_called()

    def test_thinking_blocks_click_motion_and_long_press_is_gentle(self):
        self.avatar.set_activity("thinking")
        self.avatar.interact("head")
        self.avatar.model.StartMotion.assert_not_called()
        self.avatar.set_activity("idle")
        self.avatar.last_interaction = -10
        self.avatar.interact("head", held=True)
        self.assertEqual(self.avatar.interaction_kind, "pat")
        self.assertIn(self.avatar.interaction_emotion, ("soft", "blush"))
        self.avatar.model.StartMotion.assert_not_called()

    def test_menu_uses_meaningful_interactions_and_phone_palette(self):
        self.avatar.model_expressions = ["f01", "f02", "f03", "f04"]
        menu = self.avatar.build_interaction_menu()
        try:
            texts = [action.text() for action in menu.actions() if not action.isSeparator()]
            self.assertEqual(texts, ["和她互动", "轻抚头发", "轻拍肩膀", "逗她一下", "恢复自然"])
            self.assertEqual(menu.objectName(), "avatarMenu")
            self.assertIn("#220f14", menu.styleSheet())
            events = []
            self.avatar.tapped.connect(events.append)
            next(action for action in menu.actions() if action.text() == "轻抚头发").trigger()
            self.assertEqual(self.avatar.interaction_kind, "pat")
            self.assertEqual(events, ["head"])
        finally:
            menu.deleteLater()

    def test_menu_does_not_interrupt_pending_thought_or_speech(self):
        self.avatar.set_activity("thinking")
        menu = self.avatar.build_interaction_menu()
        try:
            self.assertTrue(all(not action.isEnabled() for action in menu.actions() if not action.isSeparator()))
            self.avatar.menu_interact("pat")
            self.avatar.reset_affect()
            self.assertEqual(self.avatar.affect.activity, "thinking")
            self.avatar.model.StartMotion.assert_not_called()
        finally:
            menu.deleteLater()

    def test_reset_releases_reply_and_returns_to_automatic_state(self):
        self.avatar.emotion("annoyed")
        self.avatar.reset_affect()
        self.assertEqual(self.avatar.base_emotion, "neutral")
        self.assertEqual(self.avatar.affect.activity, "idle")
        self.assertEqual(self.avatar.affect.step()["emotion"], "neutral")
        self.avatar.model.StopAllMotions.assert_called_once()

    def test_render_uses_real_face_channels_without_saturating_expression(self):
        values = {"eyeL": 1.5, "eyeR": 1.5, "mouth": -1.0, "open": 0.0, "brow": -.5}
        self.avatar.param_limits = {"eyeL": (0, 1), "eyeR": (0, 1), "mouth": (-1, 1), "open": (0, 1), "brow": (-1, 1)}
        self.avatar.param_defaults = {key: 1.0 if key.startswith("eye") else 0.0 for key in values}
        self.avatar.affect_params = {"eyeLOpen": "eyeL", "eyeROpen": "eyeR", "mouthForm": "mouth", "mouthOpenY": "open", "browLY": "brow"}
        self.avatar.eye_open_ids = ("eyeL", "eyeR")
        self.avatar.model.GetParamValueById.side_effect = values.__getitem__
        self.avatar.model.AddParamById.side_effect = lambda key, delta: values.__setitem__(key, values[key] + delta)
        drawn = []
        self.avatar.model.Draw.side_effect = lambda: drawn.append(dict(values))
        original = dict(values)
        self.avatar.affect.last_step = 0
        self.avatar.affect.set_emotion("happy", now=1)
        with patch("panel.live2d.clearBuffer"), patch("panel.time.monotonic", return_value=2):
            self.avatar.paintGL()
        self.assertGreater(drawn[-1]["mouth"], 0, "old frown must not suppress a new smile")
        self.assertLess(drawn[-1]["eyeL"], .9, "oversized expression eye values must not clamp away the cue")
        self.assertGreater(drawn[-1]["open"], 0)
        self.assertEqual(values, original, "emotion overlays must not accumulate into the animation")
        self.avatar.model.SetParamById.assert_not_called()

    def test_frame_overlay_never_feeds_expression_back_into_saved_parameters(self):
        # Reproduce the actual v2 SDK semantics: SetParamById writes saved state;
        # AddParamById changes only the rendered frame. f02 multiplies by 0.7.
        saved = {"eyeL": 1.0, "eyeR": 1.0}
        values = dict(saved)
        self.avatar.param_limits = {key: (0, 1) for key in values}
        self.avatar.param_defaults = dict(saved)
        self.avatar.affect_params = {"eyeLOpen": "eyeL", "eyeROpen": "eyeR"}
        self.avatar.eye_open_ids = ("eyeL", "eyeR")
        self.avatar.model.Update.side_effect = lambda: values.update({key: value * .7 for key, value in saved.items()})
        self.avatar.model.GetParamValueById.side_effect = values.__getitem__
        self.avatar.model.SetParamById.side_effect = lambda key, value: (values.__setitem__(key, value), saved.__setitem__(key, value))
        self.avatar.model.AddParamById.side_effect = lambda key, delta: values.__setitem__(key, values[key] + delta)
        drawn = []
        self.avatar.model.Draw.side_effect = lambda: drawn.append(dict(values))
        self.avatar.affect.set_emotion("sad", now=0)
        for frame in range(180):
            with patch("panel.live2d.clearBuffer"), patch("panel.time.monotonic", return_value=frame / 60):
                self.avatar.paintGL()
        self.assertEqual(saved, {"eyeL": 1, "eyeR": 1})
        self.assertTrue(all(.4 < frame["eyeL"] < 1 for frame in drawn))


if __name__ == "__main__":
    unittest.main()
