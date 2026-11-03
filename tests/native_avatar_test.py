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

    def test_hover_has_no_instruction_popup_over_the_character(self):
        self.assertEqual(self.avatar.toolTip(), "")
        self.assertTrue(self.avatar.accessibleName())

    def test_high_emotion_mouth_can_still_close_during_speech(self):
        values = {"mouth": 0.0}
        self.avatar.param_limits = {"mouth": (0, 1)}
        self.avatar.param_defaults = dict(values)
        self.avatar.affect_params = {"mouthOpenY": "mouth"}
        self.avatar.mouth_id = "mouth"
        self.avatar.model.GetParamValueById.side_effect = values.__getitem__
        self.avatar.model.AddParamById.side_effect = lambda key, delta: values.__setitem__(key, values[key] + delta)
        drawn = []
        self.avatar.model.Draw.side_effect = lambda: drawn.append(values["mouth"])
        # A valid custom high-mouth pose must not flatten speech articulation.
        self.avatar.affect.step = Mock(return_value={"activity": "speaking", "emotion": "surprised",
                                                      "intensity": 1.0, "pose": {"mouthOpenY": .9}, "eye_override": {}})
        with patch("panel.time.monotonic", return_value=0):
            self.avatar.set_speaking(True)
        for frame in range(180):
            with patch("panel.live2d.clearBuffer"), patch("panel.time.monotonic", return_value=frame / 60):
                self.avatar.paintGL()
        self.assertLess(min(drawn[30:]), .1)
        self.assertGreater(max(drawn[30:]) - min(drawn[30:]), .3)
        self.assertLess(max(drawn), .7)
        self.assertEqual(values["mouth"], 0.0, "speech must not write into saved model parameters")

    def test_eyes_only_model_ignores_cursor_and_motion_turns_but_keeps_gaze(self):
        values = {'turnX': 8., 'turnY': -4., 'turnZ': 3., 'bodyX': 2., 'gazeX': 0., 'gazeY': 0.}
        self.avatar.param_limits = {key: (-45, 45) if not key.startswith('gaze') else (-1, 1) for key in values}
        self.avatar.param_defaults = {key: 0. for key in values}
        self.avatar.affect_params = {'angleX': 'turnX', 'angleY': 'turnY', 'angleZ': 'turnZ', 'bodyAngleX': 'bodyX'}
        self.avatar.fixed_turn_ids = {'turnX', 'turnY', 'turnZ', 'bodyX'}
        self.avatar.eye_gaze_ids = ('gazeX', 'gazeY')
        self.avatar.cursor_tracker.step = Mock(return_value=(.8, -.3))
        self.avatar.affect.step = Mock(return_value={'activity': 'idle', 'emotion': 'neutral',
            'intensity': .5, 'pose': {'angleX': 12., 'angleZ': -5.}, 'eye_override': {}})
        self.avatar.model.GetParamValueById.side_effect = values.__getitem__
        self.avatar.model.AddParamById.side_effect = lambda key, delta: values.__setitem__(key, values[key] + delta)
        drawn = []
        self.avatar.model.Draw.side_effect = lambda: drawn.append(dict(values))
        baseline = dict(values)
        with patch('panel.live2d.clearBuffer'):
            self.avatar.paintGL()
        self.assertTrue(all(drawn[0][key] == 0 for key in self.avatar.fixed_turn_ids))
        self.assertAlmostEqual(drawn[0]['gazeX'], .68)
        self.assertAlmostEqual(drawn[0]['gazeY'], -.255)
        self.assertEqual(values, baseline, 'freezing must not overwrite the SDK saved motion baseline')

    def test_zero_turn_limit_is_honored(self):
        values = {'turn': 2.}
        self.avatar.param_limits = {'turn': (-30, 30)}
        self.avatar.param_defaults = {'turn': 0.}
        self.avatar.affect_params = {'angleX': 'turn'}
        self.avatar.layout_spec = {'headTurnLimit': 0}
        self.avatar.cursor_tracker.step = Mock(return_value=(1., 0.))
        self.avatar.model.GetParamValueById.side_effect = values.__getitem__
        self.avatar.model.AddParamById.side_effect = lambda key, delta: values.__setitem__(key, values[key] + delta)
        drawn = []
        self.avatar.model.Draw.side_effect = lambda: drawn.append(values['turn'])
        with patch('panel.live2d.clearBuffer'):
            self.avatar.paintGL()
        self.assertEqual(drawn, [0.])

    def test_embedded_eyes_policy_is_cleared_when_loading_default_model(self):
        import tempfile
        import json
        ids = ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBodyAngleX',
               'ParamBodyAngleY', 'ParamBodyAngleZ', 'ParamEyeBallX', 'ParamEyeBallY']
        model = Mock()
        model.GetParamIds.return_value = ids
        model.GetParamDefaultById.return_value = 0.
        model.GetParamMinById.return_value = -30.
        model.GetParamMaxById.return_value = 30.
        self.avatar.gl_ready = True
        layout = {'scale': 1.}
        with tempfile.TemporaryDirectory() as folder, patch('panel.live2d.Model', return_value=model), \
             patch.object(self.avatar, 'makeCurrent'), patch.object(self.avatar, 'doneCurrent'):
            entry = Path(folder) / 'model.model3.json'
            entry.write_text(json.dumps({'Amadeus': {'TrackingMode': 'eyes'}}), encoding='utf-8')
            self.avatar.load(entry, layout=layout)
            self.assertEqual(self.avatar.layout_spec['trackingMode'], 'eyes')
            self.assertEqual(len(self.avatar.fixed_turn_ids), 6)
            self.assertNotIn('trackingMode', layout, 'model policy must not mutate caller defaults')
            entry.write_text('{}', encoding='utf-8')
            self.avatar.load(entry, layout=layout)
            self.assertEqual(self.avatar.fixed_turn_ids, set())
            self.assertNotIn('trackingMode', self.avatar.layout_spec)

    def test_authored_model_keeps_expression_and_uses_its_framing(self):
        import tempfile
        import json
        model = Mock()
        model.GetParamIds.return_value = ['ParamEyeLOpen', 'ParamEyeROpen', 'ParamBrowLAngle']
        model.GetParamDefaultById.return_value = 1.
        model.GetParamMinById.return_value = -1.
        model.GetParamMaxById.return_value = 2.
        self.avatar.gl_ready = True
        caller_layout = {'framing': 'closeup', 'scale': 1.65, 'yRatio': .52}
        with tempfile.TemporaryDirectory() as folder, patch('panel.live2d.Model', return_value=model), \
             patch.object(self.avatar, 'makeCurrent'), patch.object(self.avatar, 'doneCurrent'):
            entry = Path(folder) / 'model.model3.json'
            entry.write_text(json.dumps({'Amadeus': {
                'AffectStyle': 'authored', 'EyeBlink': 'independent',
                'AffectGains': {'browLAngle': -.25, 'bad': 'invalid'},
                'ExpressionMap': {'担心': ['sad'], 'bad': 'invalid'},
                'Layouts': {'closeup': {'scale': 2.4, 'yRatio': .87}},
            }}), encoding='utf-8')
            self.avatar.load(entry, expression_map={'legacy': ['sad']}, layout=caller_layout)
            self.assertTrue(self.avatar.authored_affect)
            self.assertTrue(self.avatar.independent_blink)
            model.SetAutoBlink.assert_called_with(False)
            self.assertEqual(self.avatar.affect_gains, {'browLAngle': -.25})
            self.assertEqual(self.avatar.expression_map, {'担心': ['sad']})
            self.assertEqual(self.avatar.layout_spec['scale'], 2.4)
            self.assertEqual(self.avatar.layout_spec['yRatio'], .87)
            self.assertEqual(caller_layout['scale'], 1.65)
            self.avatar._apply_emotion('sad')
            model.SetExpression.assert_called_with('担心')
            entry.write_text('{}', encoding='utf-8')
            self.avatar.load(entry, expression_map={'legacy': ['sad']}, layout=caller_layout)
            self.assertFalse(self.avatar.authored_affect)
            self.assertFalse(self.avatar.independent_blink)
            model.SetAutoBlink.assert_called_with(True)
            self.assertEqual(self.avatar.affect_gains, {})
            self.assertEqual(self.avatar.expression_map, {'legacy': ['sad']})
            self.assertEqual(self.avatar.layout_spec['scale'], 1.65)

    def test_legacy_saved_face_seed_is_cleared_when_switching_to_cubism_three(self):
        import json
        import tempfile
        model=Mock()
        model.GetParamIds.return_value=['ParamMouthForm','ParamAngleX']
        model.GetParamDefaultById.return_value=0.
        model.GetParamMinById.return_value=-30.
        model.GetParamMaxById.return_value=30.
        self.avatar.gl_ready=True
        with tempfile.TemporaryDirectory() as folder,patch('panel.live2d.Model',return_value=model), \
             patch.object(self.avatar,'makeCurrent'),patch.object(self.avatar,'doneCurrent'):
            entry=Path(folder)/'model.model3.json';entry.write_text('{}',encoding='utf8')
            model.IsV2.return_value=True
            self.avatar.load(entry)
            self.assertEqual(self.avatar.legacy_face_defaults,{'ParamMouthForm':0.})
            model.IsV2.return_value=False
            self.avatar.load(entry)
            self.assertEqual(self.avatar.legacy_face_defaults,{})

    def test_authored_expression_is_not_neutralized_or_given_inverted_brows(self):
        values = {'eyeL': .55, 'eyeR': .55, 'mouth': .65, 'brow': -.6}
        self.avatar.param_limits = {key: (0, 2) if key.startswith('eye') else (-1, 1) for key in values}
        self.avatar.param_defaults = {key: 1. if key.startswith('eye') else 0. for key in values}
        self.avatar.affect_params = {'eyeLOpen': 'eyeL', 'eyeROpen': 'eyeR',
                                     'mouthForm': 'mouth', 'browLAngle': 'brow'}
        self.avatar.eye_open_ids = ('eyeL', 'eyeR')
        self.avatar.authored_affect = True
        self.avatar.affect_gains = {'browLAngle': -.25}
        self.avatar.affect.step = Mock(return_value={'activity': 'idle', 'emotion': 'angry',
            'intensity': 1., 'pose': {'browLAngle': .5}, 'eye_override': {}})
        self.avatar.model.GetParamValueById.side_effect = values.__getitem__
        self.avatar.model.AddParamById.side_effect = lambda key, delta: values.__setitem__(key, values[key] + delta)
        drawn = []
        self.avatar.model.Draw.side_effect = lambda: drawn.append(dict(values))
        with patch('panel.live2d.clearBuffer'):
            self.avatar.paintGL()
        self.assertAlmostEqual(drawn[0]['mouth'], .65)
        self.assertAlmostEqual(drawn[0]['eyeL'], .55)
        self.assertLess(drawn[0]['brow'], -.6)
        self.assertEqual(values, {'eyeL': .55, 'eyeR': .55, 'mouth': .65, 'brow': -.6})

    def test_portrait_blink_preserves_unequal_resting_lids_and_sdk_baseline(self):
        values = {'eyeL': .65, 'eyeR': .85}
        baseline = dict(values)
        self.avatar.param_limits = {key: (0, 2) for key in values}
        self.avatar.param_defaults = {key: 1. for key in values}
        self.avatar.affect_params = {'eyeLOpen': 'eyeL', 'eyeROpen': 'eyeR'}
        self.avatar.eye_open_ids = ('eyeL', 'eyeR')
        self.avatar.independent_blink = True
        self.avatar.authored_affect = True
        self.avatar.affect.step = Mock(return_value={'activity': 'idle', 'emotion': 'soft',
            'intensity': 1., 'pose': {}, 'eye_override': {}})
        self.avatar.model.GetParamValueById.side_effect = values.__getitem__
        self.avatar.model.AddParamById.side_effect = lambda key, delta: values.__setitem__(key, values[key] + delta)
        drawn = []
        self.avatar.model.Draw.side_effect = lambda: drawn.append(dict(values))
        self.avatar.blink_cycle.step(0)
        self.avatar.blink_cycle.next_at = 1
        for frame in range(181):
            with patch('panel.live2d.clearBuffer'), patch('panel.time.monotonic', return_value=frame / 60):
                self.avatar.paintGL()
            self.assertEqual(values, baseline)
        self.assertLess(min(row['eyeL'] for row in drawn), .01)
        self.assertAlmostEqual(drawn[75]['eyeL'], .65)
        self.assertAlmostEqual(drawn[75]['eyeR'], .85)
        for row in drawn:
            self.assertAlmostEqual(row['eyeL'] / .65, row['eyeR'] / .85)
        self.assertEqual(self.avatar.face_smoother.values, baseline,
                         'blink frames must not contaminate the resting expression filter')

    def test_portrait_explicit_wink_stays_asymmetric_and_bypasses_lid_smoothing(self):
        values = {'eyeL': .7, 'eyeR': .9}
        self.avatar.param_limits = {key: (0, 2) for key in values}
        self.avatar.param_defaults = {key: 1. for key in values}
        self.avatar.affect_params = {'eyeLOpen': 'eyeL', 'eyeROpen': 'eyeR'}
        self.avatar.eye_open_ids = ('eyeL', 'eyeR')
        self.avatar.independent_blink = True
        self.avatar.authored_affect = True
        state = {'activity': 'reaction', 'emotion': 'winking', 'intensity': 1., 'pose': {}, 'eye_override': {}}
        self.avatar.affect.step = Mock(side_effect=lambda *args, **kwargs: state)
        self.avatar.model.GetParamValueById.side_effect = values.__getitem__
        self.avatar.model.AddParamById.side_effect = lambda key, delta: values.__setitem__(key, values[key] + delta)
        drawn = []
        self.avatar.model.Draw.side_effect = lambda: drawn.append(dict(values))
        for now, override in [(0, {}), (.05, {'eyeLOpen': 0}), (.10, {'eyeLOpen': .5}), (.42, {})]:
            state['eye_override'] = override
            with patch('panel.live2d.clearBuffer'), patch('panel.time.monotonic', return_value=now):
                self.avatar.paintGL()
        self.assertAlmostEqual(drawn[1]['eyeL'], 0)
        self.assertAlmostEqual(drawn[1]['eyeR'], .9)
        self.assertAlmostEqual(drawn[2]['eyeL'], .35)
        self.assertAlmostEqual(drawn[-1]['eyeL'], .7)

    def test_portrait_emotion_switch_does_not_restart_a_blink(self):
        blink = self.avatar.blink_cycle
        blink.step(0)
        blink.next_at = .1
        blink.step(.1)
        self.avatar._apply_emotion('sad')
        self.avatar._apply_emotion('surprised')
        self.assertIs(blink, self.avatar.blink_cycle)
        self.assertEqual(blink.step(.16), 0)
        self.assertEqual(blink.step(.32), 1)

    def test_authored_idle_after_effect_fades_the_sdk_face_and_lids_to_rest(self):
        values = {'eyeL': .8, 'eyeR': .9, 'mouth': .7, 'cheek': .6}
        saved = dict(values)
        defaults = {'eyeL': 1., 'eyeR': 1., 'mouth': 0., 'cheek': 0.}
        self.avatar.param_limits = {key: (0, 2) if key.startswith('eye') else (-1, 1) for key in values}
        self.avatar.param_defaults = defaults
        self.avatar.affect_params = {'eyeLOpen': 'eyeL', 'eyeROpen': 'eyeR',
                                     'mouthForm': 'mouth', 'cheek': 'cheek'}
        self.avatar.eye_open_ids = ('eyeL', 'eyeR')
        self.avatar.independent_blink = self.avatar.authored_affect = True
        state = {'activity': 'idle', 'emotion': 'happy', 'intensity': 1., 'pose': {}, 'eye_override': {}}
        self.avatar.affect.step = Mock(side_effect=lambda *args, **kwargs: state)
        self.avatar.model.GetParamValueById.side_effect = values.__getitem__
        self.avatar.model.AddParamById.side_effect = lambda key, delta: values.__setitem__(key, values[key] + delta)
        drawn = []
        self.avatar.model.Draw.side_effect = lambda: drawn.append(dict(values))
        for frame in range(91):
            state['intensity'] = max(0., 1-frame/30)
            with patch('panel.live2d.clearBuffer'), patch('panel.time.monotonic', return_value=frame/60):
                self.avatar.paintGL()
        self.assertEqual(drawn[0], saved)
        self.assertGreater(drawn[15]['eyeL'], saved['eyeL'])
        self.assertLess(drawn[15]['mouth'], saved['mouth'])
        for key, rest in defaults.items():
            self.assertAlmostEqual(drawn[-1][key], rest, places=4)
        self.assertEqual(values, saved, 'neutral blending must leave SDK saved parameters untouched')

    def test_manual_authored_preview_keeps_its_full_expression_until_released(self):
        values = {'mouth': .7}
        self.avatar.param_limits = {'mouth': (-1, 1)}
        self.avatar.param_defaults = {'mouth': 0}
        self.avatar.affect_params = {'mouthForm': 'mouth'}
        self.avatar.authored_affect = True
        self.avatar.manual_expression_until = 2.5
        self.avatar.affect.step = Mock(return_value={'activity': 'idle', 'emotion': 'neutral',
            'intensity': 0., 'pose': {}, 'eye_override': {}})
        self.avatar.model.GetParamValueById.side_effect = values.__getitem__
        self.avatar.model.AddParamById.side_effect = lambda key, delta: values.__setitem__(key, values[key] + delta)
        drawn = []
        self.avatar.model.Draw.side_effect = lambda: drawn.append(values['mouth'])
        with patch('panel.live2d.clearBuffer'), patch('panel.time.monotonic', return_value=1):
            self.avatar.paintGL()
        self.assertAlmostEqual(drawn[-1], .7)

    def test_legacy_sdk_facial_overwrite_does_not_survive_neutral_recovery(self):
        saved = {'mouth': 0., 'brow': 0., 'turn': 6.}
        values = dict(saved)
        self.avatar.legacy_face_defaults = {'mouth': 0., 'brow': 0.}
        self.avatar.param_limits = {'mouth': (-1, 1), 'brow': (-1, 1)}
        self.avatar.param_defaults = {'mouth': 0., 'brow': 0.}
        self.avatar.affect_params = {'mouthForm': 'mouth', 'browLY': 'brow'}
        expression = [True]
        sdk_frames = []
        def update():
            # The actual v2 SDK retains these overwrites after stopping f04.
            if expression[0]:saved.update(mouth=-1., brow=-.7)
            values.update(saved)
            sdk_frames.append(dict(values))
        self.avatar.model.Update.side_effect = update
        self.avatar.model.SetSaveParamById.side_effect = saved.__setitem__
        self.avatar.model.GetParamValueById.side_effect = values.__getitem__
        self.avatar.model.AddParamById.side_effect = lambda key, delta: values.__setitem__(key, values[key]+delta)
        drawn = []
        self.avatar.model.Draw.side_effect = lambda: drawn.append(dict(values))
        self.avatar.affect.step = Mock(return_value={'activity': 'idle', 'emotion': 'neutral',
            'intensity': 0., 'pose': {}, 'eye_override': {}})
        for frame in range(61):
            expression[0] = frame == 0
            with patch('panel.live2d.clearBuffer'), patch('panel.time.monotonic',return_value=frame/60):
                self.avatar.paintGL()
        self.assertLess(sdk_frames[0]['mouth'], -.9)
        self.assertEqual(sdk_frames[-1]['mouth'], 0)
        self.assertAlmostEqual(drawn[-1]['mouth'], 0, places=5)
        self.assertAlmostEqual(drawn[-1]['brow'], 0, places=5)
        self.assertEqual(saved['turn'], 6., 'facial recovery must not rewrite head motion or cursor baselines')
        self.assertEqual(set(call.args[0] for call in self.avatar.model.SetSaveParamById.call_args_list), {'mouth','brow'})

    def test_actual_audio_end_closes_articulation_even_while_the_smile_releases(self):
        values={'mouth':.35}
        self.avatar.param_limits={'mouth':(0,1)}
        self.avatar.param_defaults={'mouth':0.}
        self.avatar.affect_params={'mouthOpenY':'mouth'}
        self.avatar.mouth_id='mouth'
        self.avatar.authored_affect=True
        self.avatar.affect.speech_ended_at=1.
        self.avatar.affect.step=Mock(return_value={'activity':'reply','emotion':'happy','intensity':1.,'pose':{'mouthOpenY':.3},'eye_override':{}})
        self.avatar.face_smoother.values={'mouth':.5};self.avatar.face_smoother.last_time=1.
        self.avatar.model.GetParamValueById.side_effect=values.__getitem__
        self.avatar.model.AddParamById.side_effect=lambda key,delta:values.__setitem__(key,values[key]+delta)
        drawn=[];self.avatar.model.Draw.side_effect=lambda:drawn.append(values['mouth'])
        for frame in range(1,16):
            with patch('panel.live2d.clearBuffer'),patch('panel.time.monotonic',return_value=1+frame/60):
                self.avatar.paintGL()
        self.assertLess(drawn[-1],.001)
        self.assertAlmostEqual(values['mouth'],.35,'closing the rendered lips must not modify the saved expression')

    def test_legacy_eyelid_expression_multiplies_a_clean_baseline_each_frame(self):
        saved={'eyeL':1., 'eyeR':1.};values=dict(saved);raw=[]
        self.avatar.legacy_face_defaults = dict(saved)
        self.avatar.param_limits={key:(0,1) for key in saved}
        self.avatar.param_defaults=dict(saved)
        self.avatar.affect_params={'eyeLOpen':'eyeL','eyeROpen':'eyeR'}
        self.avatar.eye_open_ids=('eyeL','eyeR')
        def update():
            saved.update({key:value*.7 for key,value in saved.items()})
            values.update(saved);raw.append(values['eyeL'])
        self.avatar.model.Update.side_effect=update
        self.avatar.model.SetSaveParamById.side_effect=saved.__setitem__
        self.avatar.model.GetParamValueById.side_effect=values.__getitem__
        self.avatar.model.AddParamById.side_effect=lambda key,delta:values.__setitem__(key,values[key]+delta)
        self.avatar.affect.step=Mock(return_value={'activity':'idle','emotion':'soft','intensity':.5,'pose':{},'eye_override':{}})
        for frame in range(180):
            with patch('panel.live2d.clearBuffer'),patch('panel.time.monotonic',return_value=frame/60):
                self.avatar.paintGL()
        self.assertTrue(all(abs(value-.7)<1e-7 for value in raw))

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
        self.avatar.model.ResetExpressions.assert_called_once()

    def test_reset_clears_queued_sdk_expression_even_when_neutral_is_cached(self):
        self.avatar.expression_map = {'natural': ['neutral']}
        self.avatar.visible_emotion = 'neutral'
        self.avatar.active_expression = 'natural'
        self.avatar.manual_expression_until = 5
        self.avatar.reset_affect()
        self.avatar.model.ResetExpressions.assert_called_once()
        self.avatar.model.SetExpression.assert_called_once_with('natural')
        self.assertEqual(self.avatar.manual_expression_until, 0)

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
