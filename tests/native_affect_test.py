"""Deterministic affect regressions: no Qt, model, audio, network, or user data."""
import math
import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "native"))
from affect import AffectController, BlinkCycle, EMOTIONS, EyeGesture, FaceSmoother


class BlinkCycleTests(unittest.TestCase):
    def test_blink_finishes_without_a_long_closed_hold_at_each_frame_rate(self):
        for fps in (24, 30, 60, 120):
            with self.subTest(fps=fps):
                blink = BlinkCycle(random.Random(12))
                self.assertEqual(blink.step(0), 1)
                blink.next_at = 1
                samples = [(i / fps, blink.step(i / fps)) for i in range(1, fps * 2)]
                closed = [time for time, value in samples if value < .2]
                affected = [time for time, value in samples if value < .999]
                self.assertTrue(closed)
                self.assertLessEqual(closed[-1] - closed[0], .10)
                self.assertLessEqual(affected[-1] - affected[0], .21)
                self.assertEqual(blink.step(2), 1)
                self.assertGreater(blink.next_at, 5)

    def test_pause_or_backwards_clock_returns_to_rest_without_replaying(self):
        blink = BlinkCycle(random.Random(4))
        blink.step(0)
        blink.next_at = .1
        blink.step(.1)
        self.assertEqual(blink.step(.16), 0)
        self.assertEqual(blink.step(20), 1)
        self.assertGreater(blink.next_at, 23)
        self.assertEqual(blink.step(1), 1)
        self.assertGreater(blink.next_at, 4)

    def test_wink_or_explicit_eye_gesture_defers_the_automatic_blink(self):
        blink = BlinkCycle(random.Random(2))
        blink.step(0)
        blink.next_at = .1
        self.assertEqual(blink.step(.1, suppressed=True), 1)
        self.assertIsNone(blink.started)
        self.assertEqual(blink.step(.4, suppressed=True), 1)
        self.assertEqual(blink.step(.8), 1)
        self.assertGreaterEqual(blink.next_at, 1.2)

    def test_new_gesture_does_not_snap_an_inflight_blink_open(self):
        blink=BlinkCycle(random.Random(2));blink.step(0);blink.next_at=.1
        blink.step(.1)
        self.assertEqual(blink.step(.16),0)
        self.assertEqual(blink.step(.17,suppressed=True),0)
        self.assertEqual(blink.step(.32,suppressed=True),1)


class EyeGestureTests(unittest.TestCase):
    def test_cancelled_wink_reopens_continuously_within_a_tenth_of_a_second(self):
        eye=EyeGesture();eye.step({'eyeLOpen':0},0)
        values=[eye.step({},i/60).get('eyeLOpen',1) for i in range(1,9)]
        self.assertGreater(values[0],0)
        self.assertLess(values[0],.1)
        self.assertEqual(values[-1],1)
        self.assertTrue(all(a<=b for a,b in zip(values,values[1:])))

    def test_hidden_window_does_not_replay_cancelled_closed_eye(self):
        eye=EyeGesture();eye.step({'eyeLOpen':0,'eyeROpen':0},0)
        self.assertEqual(eye.step({},3),{})

    def test_new_wink_during_release_does_not_snap_the_lid_open(self):
        eye=EyeGesture();eye.step({'eyeLOpen':0},0)
        before=eye.step({},.02)['eyeLOpen']
        after=eye.step({'eyeLOpen':1},.04)['eyeLOpen']
        self.assertLessEqual(after-before,.200001)


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
    def test_synthesis_wait_does_not_consume_spoken_emotion_performance(self):
        c = AffectController(clock=lambda: 0)
        c.set_emotion("blush", now=0)
        c.step(now=12)
        c.begin_utterance("blush", now=12)
        self.assertEqual(c.reply_since, 12)
        self.assertEqual(c.step(now=12.1)["activity"], "speaking")
        c.set_speaking(False, now=15)
        c.begin_utterance("blush", now=15.1)
        self.assertEqual(c.reply_since, 12, "adjacent same-emotion chunks must not repeat the startle")
        c.set_speaking(False, now=17)
        c.begin_utterance("annoyed", now=17.1)
        self.assertEqual(c.reply_since, 17.1)
        self.assertEqual(c.step(now=17.2)["emotion"], "annoyed")

    def test_actual_playback_keeps_a_recent_touch_but_not_a_stale_preview(self):
        c = AffectController(clock=lambda: 0)
        c.react("blush", now=0)
        c.begin_utterance("blush", now=.2)
        self.assertEqual(c.reply_since, 0)
        c.set_speaking(False, now=2)
        c.set_activity("thinking", now=2.1)
        c.begin_utterance("blush", now=2.2)
        self.assertEqual(c.reply_since, 2.2)

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

    def test_audio_end_briefly_bridges_chunks_then_returns_to_neutral(self):
        c = self.controller()
        c.set_emotion("blush", now=0, hold=2)
        c.set_speaking(True, now=0)
        self.assertEqual(c.step(now=10)["emotion"], "blush")
        c.set_speaking(False, now=10)
        self.assertEqual(c.step(now=10.2)["emotion"], "blush")
        self.assertEqual(c.step(now=11.5)["emotion"], "neutral")
        self.assertEqual(c.step(now=14)["activity"], "idle")

    def test_every_spoken_emotion_returns_to_initial_face_after_the_clip(self):
        for emotion in EMOTIONS:
            with self.subTest(emotion=emotion):
                c=self.controller()
                c.set_emotion('angry',now=0,hold=8)
                c.react(emotion,now=.1)
                c.begin_utterance(emotion,now=.2)
                c.step(now=.6)
                c.set_speaking(False,now=1.2)
                frame=c.step(now=2.4)
                self.assertEqual(frame['emotion'],'neutral')
                self.assertLess(abs(frame['pose']['mouthForm']),.01)
                self.assertGreater(c.next_idle_at,7)

    def test_plain_text_emotion_finishes_without_a_thirty_second_echo(self):
        c=self.controller();c.set_emotion('happy',now=0)
        self.assertEqual(c.step(now=1)['emotion'],'happy')
        self.assertEqual(c.step(now=3.2)['emotion'],'neutral')
        self.assertLessEqual(c.echo_until,0)

    def test_thinking_and_speaking_take_priority_over_reactions(self):
        c = self.controller()
        c.set_activity("thinking", now=1)
        self.assertFalse(c.react("annoyed", now=2))
        self.assertEqual(c.step(now=2)["activity"], "thinking")
        c.set_emotion("soft", now=3)
        c.set_speaking(True, now=3)
        self.assertFalse(c.react("annoyed", now=4))
        self.assertEqual(c.step(now=4)["emotion"], "soft")

    def test_reaction_returns_to_neutral_without_uncovering_an_old_reply(self):
        c = self.controller()
        c.set_emotion("happy", now=0)
        self.assertTrue(c.react("question", now=1, hold=2))
        self.assertEqual(c.step(now=2)["emotion"], "question")
        self.assertEqual(c.step(now=4)["emotion"], "neutral")

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

    def test_authored_performance_timing_is_consistent_across_frame_rates(self):
        samples = []
        for fps in (30, 60, 120):
            c = self.controller()
            c.set_emotion("angry", now=0)
            for n in range(1, fps * 2 + 1):
                sample = c.step(now=n / fps)
            samples.append(sample["pose"])
        # Moving targets differ slightly with sampling; there must be no
        # frame-count based timing or visible speed change on a 30Hz display.
        for key in ("angleX", "angleZ"):
            values = [sample[key] for sample in samples]
            self.assertLess(max(values) - min(values), .05)
        for key in ("browLAngle", "mouthForm"):
            values = [sample[key] for sample in samples]
            self.assertLess(max(values) - min(values), .005)

    def test_reply_softens_before_returning_to_rest(self):
        c = self.controller()
        c.set_emotion("angry", now=0, hold=8)
        early, late = c.step(now=2), c.step(now=7.5)
        self.assertEqual(late["emotion"], "angry")
        self.assertLess(late["intensity"], early["intensity"])
        rested = c.step(now=8.1)
        self.assertEqual(rested["emotion"], "neutral")
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
        rested = c.step(now=1, reduced_motion=True)
        self.assertEqual(rested["activity"], "reply")
        self.assertEqual(rested["emotion"], "happy")
        self.assertGreater(rested["pose"]["mouthForm"], .25)
        self.assertLess(rested["pose"]["eyeLOpen"], 0)
        for key in ("angleX", "angleY", "angleZ", "bodyAngleX", "breath"):
            self.assertEqual(rested["pose"][key], 0)

    def test_reply_returns_to_initial_face_without_a_long_idle_echo(self):
        c = self.controller()
        c.set_emotion("happy", now=0, hold=2)
        for now in (2.1, 3, 4):
            self.assertEqual(c.step(now=now)["emotion"], "neutral")
        c.set_emotion("angry", now=22, hold=2)
        frame = c.step(now=26)
        self.assertEqual(frame["activity"], "idle")
        self.assertEqual(frame["emotion"], "neutral")
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

    def test_automatic_idle_waits_for_a_neutral_gap_after_reply_after_effect(self):
        c = self.controller()
        c.set_emotion('happy', now=0, hold=1)
        self.assertAlmostEqual(c.echo_until, 0)
        frame = c.step(now=1.01)
        self.assertEqual(frame['activity'], 'idle')
        self.assertEqual(frame['emotion'], 'neutral')
        self.assertGreaterEqual(c.next_idle_at, 5)

    def test_finished_speech_after_effect_also_has_a_neutral_gap(self):
        c = self.controller()
        c.begin_utterance('happy', now=0)
        c.set_speaking(False, now=3)
        frame = c.step(now=c.reply_until+.01)
        self.assertEqual(frame['emotion'], 'neutral')
        self.assertGreaterEqual(c.next_idle_at-c.echo_until, 4)

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

    def sample_phrase(self, emotion, times, activity=None):
        c = self.controller()
        if activity:
            c.set_activity(activity, now=0)
        else:
            c.set_emotion(emotion, now=0)
        result = {}
        requested = {round(t * 60): t for t in times}
        for frame in range(1, max(requested) + 1):
            state = c.step(now=frame / 60)
            if frame in requested:
                result[requested[frame]] = state
        return c, result

    def test_blush_startles_looks_away_then_returns_with_a_smile(self):
        _, phases = self.sample_phrase("blush", (.2, .8, 2.6, 4))
        early, away, returning, settled = [phases[t]["pose"] for t in (.2, .8, 2.6, 4)]
        self.assertGreater(early["browLY"], settled["browLY"])
        self.assertLess(away["eyeBallX"], -.3)
        self.assertGreater(away["angleX"], 7)
        self.assertGreater(returning["eyeBallX"], .05)
        self.assertGreater(returning["mouthForm"], .55)
        self.assertLess(settled["angleX"], away["angleX"] / 2)
        self.assertEqual(phases[4]["phase"], "settled")

    def test_annoyed_side_glance_releases_without_staying_in_a_hard_turn(self):
        _, phases = self.sample_phrase("annoyed", (.2, 1, 4))
        peak, settled = phases[1]["pose"], phases[4]["pose"]
        self.assertLess(peak["angleX"], -6)
        self.assertGreater(peak["eyeBallX"], .1)
        self.assertGreater(settled["browLY"], peak["browLY"])
        self.assertLess(abs(settled["angleX"]), abs(peak["angleX"]) / 2)
        self.assertLess(abs(settled["eyeBallX"]), .02)

    def test_reaction_mouth_peaks_then_closes_during_a_silent_reply(self):
        for emotion in ("happy", "excited", "elated", "surprised"):
            with self.subTest(emotion=emotion):
                _, phases = self.sample_phrase(emotion, (.8, 4))
                peak, settled = phases[.8]["pose"], phases[4]["pose"]
                self.assertLess(settled["mouthOpenY"], .12)
                self.assertGreater(peak["mouthOpenY"], settled["mouthOpenY"] + .1)

    def test_listening_nods_then_returns_attention_without_a_frozen_quizzical_pose(self):
        _, phases = self.sample_phrase("question", (1, 2.5), activity="listening")
        nod, rest = phases[1]["pose"], phases[2.5]["pose"]
        self.assertGreater(nod["angleY"], 1.5)
        self.assertLess(abs(rest["angleY"]), .1)
        self.assertLess(abs(rest["angleX"]), .1)
        self.assertLess(abs(rest["browLY"] - rest["browRY"]), .1)
        self.assertEqual(phases[2.5]["activity"], "listening")

    def test_thinking_returns_from_its_first_glance_and_keeps_a_quiet_focus(self):
        _, phases = self.sample_phrase("thinking", (1, 3.2, 6), activity="thinking")
        first, rest, glance = [phases[t]["pose"] for t in (1, 3.2, 6)]
        self.assertGreater(first["eyeBallX"], rest["eyeBallX"] + .12)
        self.assertLess(abs(rest["angleX"]), abs(first["angleX"]))
        self.assertGreater(glance["eyeBallX"], rest["eyeBallX"] + .10)
        self.assertTrue(all(phases[t]["activity"] == "thinking" for t in phases))

    def test_audio_start_keeps_the_same_interaction_performance(self):
        c = self.controller()
        c.react("blush", now=0)
        c.step(now=.8)
        c.set_emotion("blush", now=.85)
        c.set_speaking(True, now=.85)
        self.assertEqual(c.reply_since, 0)
        continued = c.step(now=1)
        self.assertEqual(continued["activity"], "speaking")
        self.assertLess(continued["pose"]["eyeBallX"], -.3)

    def test_interruption_retains_visible_pose_and_uses_a_short_handover(self):
        c, phases = self.sample_phrase("blush", (1,))
        before = phases[1]["pose"]
        c.set_emotion("angry", now=1)
        self.assertEqual(c.pose, before)
        next_frame = c.step(now=1 + 1/60)["pose"]
        self.assertLess(abs(next_frame["angleX"] - before["angleX"]), 2)
        self.assertLess(abs(next_frame["mouthForm"] - before["mouthForm"]), .2)
        self.assertNotEqual(next_frame, before)

    def test_all_emotions_have_distinct_finite_performances_and_reopen_eyes(self):
        effective = ("eyeLOpen", "eyeROpen", "mouthForm", "mouthOpenY", "browLY", "browRY",
                     "angleX", "angleY", "eyeBallX", "eyeBallY")
        signatures = set()
        for emotion in EMOTIONS:
            with self.subTest(emotion=emotion):
                _, phases = self.sample_phrase(emotion, (.2, .8, 1.8, 4))
                signature = []
                for state in phases.values():
                    self.assertTrue(all(math.isfinite(value) for value in state["pose"].values()))
                    self.assertGreaterEqual(state["attention"], .6)
                    self.assertLessEqual(state["attention"], 1)
                    self.assertGreater(state["pose"]["eyeLOpen"], -.55)
                    self.assertGreater(state["pose"]["eyeROpen"], -.55)
                    signature.extend(round(state["pose"][key], 2) for key in effective)
                self.assertEqual(phases[4]["eye_override"], {})
                signatures.add(tuple(signature))
        self.assertEqual(len(signatures), len(EMOTIONS))


if __name__ == "__main__":
    unittest.main()
