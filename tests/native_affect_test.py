"""Deterministic affect regressions: no Qt, model, audio, network, or user data."""
import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "native"))
from affect import AffectController, FaceSmoother


class FaceSmootherTests(unittest.TestCase):
    def test_authored_expression_reset_moves_continuously_and_settles(self):
        face = FaceSmoother()
        face.step({"mouth": -1, "brow": -.5}, 0)
        first = face.step({"mouth": 1, "brow": .5}, 1/60)
        self.assertGreater(first["mouth"], -1)
        self.assertLess(first["mouth"], -.5)
        for frame in range(2, 31):
            last = face.step({"mouth": 1, "brow": .5}, frame/60)
        self.assertGreater(last["mouth"], .99)
        self.assertAlmostEqual(last["brow"], .5, places=2)

    def test_transition_timing_does_not_depend_on_frame_rate(self):
        results = []
        for fps in (30, 60, 120):
            face = FaceSmoother()
            face.step({"mouth": 0}, 0)
            for frame in range(1, fps//2 + 1):
                result = face.step({"mouth": 1}, frame/fps)
            results.append(result["mouth"])
        self.assertAlmostEqual(min(results), max(results), places=10)

    def test_blink_remains_short_and_next_transition_starts_from_rendered_eye(self):
        face = FaceSmoother()
        face.step({"eye": .6}, 0)
        self.assertEqual(face.step({"eye": 0}, .05, immediate={"eye"})["eye"], 0)
        self.assertEqual(face.step({"eye": .6}, .2, immediate={"eye"})["eye"], .6)
        result = face.step({"eye": .9}, .21)
        self.assertGreater(result["eye"], .6)
        self.assertLess(result["eye"], .65)

    def test_hidden_window_gap_does_not_replay_old_expression(self):
        face = FaceSmoother()
        face.step({"mouth": -1}, 0)
        self.assertEqual(face.step({"mouth": 1}, 20)["mouth"], 1)


class AffectTests(unittest.TestCase):
    def controller(self, seed=17):
        return AffectController(clock=lambda: 0, rng=random.Random(seed))

    def test_same_emotion_segments_do_not_restart_closed_eye_animation(self):
        c = self.controller()
        c.set_emotion("eyes_closed", now=0)
        self.assertTrue(c.step(now=.1)["eye_override"])
        c.set_emotion("eyes_closed", now=1)
        self.assertEqual(c.step(now=1.1)["eye_override"], {})
        c.set_activity("thinking", now=2)
        c.set_emotion("eyes_closed", now=3)
        self.assertTrue(c.step(now=3.1)["eye_override"])

    def test_reply_has_a_face_when_voice_is_disabled(self):
        c = self.controller()
        c.set_emotion("happy", now=1)
        snapshot = c.step(now=2)
        self.assertEqual(snapshot["activity"], "reply")
        self.assertEqual(snapshot["emotion"], "happy")
        self.assertGreater(snapshot["pose"]["mouthForm"], .4)

    def test_audio_end_holds_the_current_emotion(self):
        c = self.controller()
        c.set_emotion("blush", now=0, hold=2)
        c.set_speaking(True, now=0)
        self.assertEqual(c.step(now=10)["emotion"], "blush")
        c.set_speaking(False, now=10)
        self.assertEqual(c.step(now=11)["emotion"], "blush")
        self.assertEqual(c.step(now=14)["emotion"], "blush")
        self.assertEqual(c.step(now=14)["activity"], "idle")

    def test_thinking_and_speaking_take_priority_over_reactions(self):
        c = self.controller()
        c.set_activity("thinking", now=1)
        self.assertFalse(c.react("annoyed", now=2))
        self.assertEqual(c.step(now=2)["activity"], "thinking")
        c.set_emotion("soft", now=3)
        c.set_speaking(True, now=3)
        self.assertFalse(c.react("annoyed", now=4))
        self.assertEqual(c.step(now=4)["emotion"], "soft")

    def test_reaction_returns_to_unexpired_reply(self):
        c = self.controller()
        c.set_emotion("happy", now=0)
        self.assertTrue(c.react("question", now=1, hold=2))
        self.assertEqual(c.step(now=2)["emotion"], "question")
        self.assertEqual(c.step(now=4)["emotion"], "happy")

    def test_new_reply_supersedes_a_click(self):
        c = self.controller()
        c.react("annoyed", now=1)
        c.set_emotion("soft", now=2)
        self.assertEqual(c.step(now=2.2)["emotion"], "soft")

    def test_idle_varies_without_repeating_or_intense_random_emotions(self):
        c = self.controller()
        emotions = []
        for _ in range(12):
            now = c.next_idle_at
            c.step(now=now)
            emotions.append(c.step(now=now + 1)["emotion"])
        self.assertGreater(len(set(emotions)), 2)
        self.assertTrue(all(a != b for a, b in zip(emotions, emotions[1:])))
        self.assertTrue(set(emotions).issubset(set(c.IDLE_EMOTIONS)))
        self.assertNotIn("angry", emotions)
        self.assertNotIn("blush", emotions)

    def test_idle_does_not_interrupt_a_long_thought(self):
        c = self.controller()
        c.set_activity("thinking", now=0)
        for now in range(1, 70):
            self.assertEqual(c.step(now=now)["activity"], "thinking")
        c.set_activity("idle", now=70)
        self.assertEqual(c.step(now=70)["emotion"], "neutral")

    def test_repeated_status_does_not_restart_activity(self):
        c = self.controller()
        c.set_activity("listening", now=1)
        c.set_activity("listening", now=4)
        self.assertEqual(c.activity_since, 1)

    def test_steady_pose_is_frame_rate_independent(self):
        fast, slow = self.controller(), self.controller()
        for c in (fast, slow):
            c.set_emotion("angry", now=0)
        for n in range(1, 61):
            a = fast.step(now=n / 60)
        b = slow.step(now=1)
        for key in ("angleX", "angleZ", "browLAngle", "mouthForm"):
            self.assertAlmostEqual(a["pose"][key], b["pose"][key], places=10)

    def test_reply_softens_before_returning_to_rest(self):
        c = self.controller()
        c.set_emotion("angry", now=0, hold=8)
        early, late = c.step(now=2), c.step(now=7.5)
        self.assertEqual(late["emotion"], "angry")
        self.assertLess(late["intensity"], early["intensity"])
        rested = c.step(now=8.1)
        self.assertEqual(rested["emotion"], "indifferent")
        self.assertLess(rested["intensity"], early["intensity"])

    def test_eye_expressions_cannot_hold_eyes_closed_for_entire_reply(self):
        c = self.controller()
        c.set_emotion("eyes_closed", now=1)
        self.assertEqual(c.step(now=1.1)["eye_override"], {"eyeLOpen": 0, "eyeROpen": 0})
        self.assertEqual(c.step(now=1.5)["eye_override"], {})
        c.set_emotion("winking", now=2)
        self.assertEqual(c.step(now=2.1)["eye_override"], {"eyeLOpen": 0})
        self.assertEqual(c.step(now=2.5)["eye_override"], {})

    def test_reduced_motion_keeps_reply_face_but_stops_body_animation(self):
        c = self.controller()
        self.assertEqual(c.step(now=60, reduced_motion=True)["activity"], "idle")
        c.set_emotion("happy", now=60)
        frame = c.step(now=61, reduced_motion=True)
        self.assertGreater(frame["pose"]["mouthForm"], .4)
        for key in ("angleX", "angleY", "angleZ", "bodyAngleX", "eyeBallX", "eyeBallY", "breath"):
            self.assertEqual(frame["pose"][key], 0)

    def test_reduced_motion_keeps_semantic_idle_face(self):
        c = self.controller()
        c.set_emotion("happy", now=0, hold=2)
        rested = c.step(now=10, reduced_motion=True)
        self.assertEqual(rested["activity"], "idle")
        self.assertEqual(rested["emotion"], "happy")
        self.assertGreater(rested["pose"]["mouthForm"], .25)
        self.assertLess(rested["pose"]["eyeLOpen"], 0)
        for key in ("angleX", "angleY", "angleZ", "bodyAngleX", "breath"):
            self.assertEqual(rested["pose"][key], 0)

    def test_idle_echo_tracks_context_and_expires(self):
        c = self.controller()
        c.set_emotion("happy", now=0, hold=2)
        for now in (3, 8, 20):
            self.assertEqual(c.step(now=now)["emotion"], "happy")
        c.set_emotion("angry", now=22, hold=2)
        frame = c.step(now=26)
        self.assertEqual(frame["activity"], "idle")
        self.assertEqual(frame["emotion"], "indifferent")
        self.assertNotEqual(c.step(now=60)["emotion"], "angry")
        self.assertGreaterEqual(60, c.echo_until)

    def test_new_conversation_clears_previous_idle_mood(self):
        c = self.controller()
        c.set_emotion("blush", now=0, hold=2)
        c.set_activity("thinking", now=5)
        self.assertEqual(c.step(now=6)["emotion"], "thinking")
        c.set_activity("idle", now=7)
        self.assertEqual(c.step(now=7)["emotion"], "neutral")

    def test_core_faces_differ_on_channels_the_installed_model_moves(self):
        # Smile/angle/form IDs can exist without changing any model geometry.
        # The supported eyes/mouth/brow-Y cues must carry the distinctions.
        effective = ("eyeLOpen", "eyeROpen", "mouthForm", "mouthOpenY", "browLY", "browRY")
        poses = {}
        for emotion in ("happy", "soft", "thinking", "annoyed", "blush", "surprised"):
            c = self.controller()
            c.set_emotion(emotion, now=0)
            poses[emotion] = c.step(now=1)["pose"]
        signatures = {tuple(round(p[key], 2) for key in effective) for p in poses.values()}
        self.assertEqual(len(signatures), len(poses))
        self.assertGreater(poses["happy"]["mouthForm"], .8)
        self.assertLess(poses["annoyed"]["eyeLOpen"], -.25)
        self.assertGreater(poses["surprised"]["mouthOpenY"], .2)
        self.assertGreater(poses["thinking"]["browLY"] - poses["thinking"]["browRY"], .4)

    def test_reset_clears_context_without_snapping_current_pose(self):
        c = self.controller()
        c.set_emotion("blush", now=0)
        c.react("annoyed", now=1)
        before = c.step(now=2)["pose"]
        c.reset(now=2)
        self.assertEqual(c.pose, before)
        frame = c.step(now=2.1)
        self.assertEqual(frame["activity"], "idle")
        self.assertEqual(frame["emotion"], "neutral")
        self.assertLess(abs(frame["pose"]["mouthForm"]), abs(before["mouthForm"]))
        self.assertEqual(c.echo_until, 2)

    def test_error_is_visible_but_does_not_become_a_permanent_mood(self):
        c = self.controller()
        c.set_activity("error", now=1)
        self.assertEqual(c.step(now=2)["emotion"], "disappointed")
        self.assertEqual(c.step(now=5.1)["emotion"], "neutral")

    def test_unknown_emotion_is_safe_and_snapshots_are_independent(self):
        c = self.controller()
        c.set_emotion("not-an-emotion", now=0)
        first = c.step(now=1)
        first["pose"]["angleX"] = 999
        self.assertEqual(c.step(now=2)["emotion"], "neutral")
        self.assertLess(abs(c.step(now=2)["pose"]["angleX"]), 1)


if __name__ == "__main__":
    unittest.main()
