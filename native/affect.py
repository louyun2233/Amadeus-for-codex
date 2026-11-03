"""Time-based native avatar affect, independent of Qt, models, and voice services.

The renderer adds ``pose`` to the model's freshly evaluated parameters, never
to last frame's output. ``eye_override`` is a brief closure multiplier applied
after normal blinking; it never snaps a half-open eye to a fully open value.
"""

import math
import random
import time


EMOTIONS = (
    "happy", "excited", "elated", "sad", "angry", "furious", "question",
    "soft", "blush", "annoyed", "thinking", "surprised", "disappointed",
    "eyes_closed", "indifferent", "side", "winking", "neutral",
)
POSE_KEYS = (
    "angleX", "angleY", "angleZ", "bodyAngleX", "eyeBallX", "eyeBallY",
    "browLY", "browRY", "browLAngle", "browRAngle", "mouthForm", "mouthOpenY",
    "eyeLOpen", "eyeROpen", "eyeLSmile", "eyeRSmile", "browLForm", "browRForm", "cheek", "breath",
)

# Core cues use channels that move the installed model's mesh. Several Cubism
# models expose smile/brow-form IDs without binding them to visible geometry;
# those remain optional accents, never the only distinction between emotions.
CUES = {
    "neutral": {},
    "happy": {"angleX": 4, "angleY": -2, "angleZ": 13, "bodyAngleX": 1.5,
              "mouthForm": .95, "mouthOpenY": .48, "browLY": .5, "browRY": .5,
              "eyeLOpen": -.08, "eyeROpen": -.08, "eyeLSmile": .6, "eyeRSmile": .6},
    "excited": {"angleX": 4, "angleY": -5, "angleZ": 4, "bodyAngleX": 2,
                "mouthForm": .85, "mouthOpenY": .55, "browLY": .65, "browRY": .65,
                "eyeLOpen": -.06, "eyeROpen": -.06,
                "eyeLSmile": .45, "eyeRSmile": .45},
    "elated": {"angleX": 3, "angleY": -4, "angleZ": -4, "bodyAngleX": 2.2,
               "mouthForm": .98, "mouthOpenY": .65, "browLY": .55, "browRY": .55,
               "eyeLOpen": -.32, "eyeROpen": -.32, "cheek": .15, "eyeLSmile": .7, "eyeRSmile": .7},
    "sad": {"angleX": -4, "angleY": 6, "angleZ": -4, "bodyAngleX": -1,
            "mouthForm": -.65, "browLY": .2, "browRY": .2, "browLAngle": -.35, "browRAngle": -.35,
            "eyeLOpen": -.26, "eyeROpen": -.26, "eyeBallY": -.18},
    "disappointed": {"angleX": -2, "angleY": 4, "angleZ": -2,
                     "mouthForm": -.5, "browLY": -.12, "browRY": -.12,
                     "eyeLOpen": -.28, "eyeROpen": -.28},
    "soft": {"angleX": 3, "angleY": 2, "angleZ": 9, "bodyAngleX": .5,
             "mouthForm": .62, "mouthOpenY": .12, "browLY": .18, "browRY": .18,
             "eyeLOpen": -.09, "eyeROpen": -.09,
             "eyeLSmile": .2, "eyeRSmile": .2, "browLAngle": -.1, "browRAngle": -.1},
    "angry": {"angleX": -5, "angleY": -3, "angleZ": -5, "bodyAngleX": -1.5,
              "mouthForm": -.85, "mouthOpenY": .05, "browLAngle": .45, "browRAngle": .45,
              "browLY": -.65, "browRY": -.65, "eyeLOpen": -.4, "eyeROpen": -.4},
    "furious": {"angleX": -7, "angleY": -3, "angleZ": -4, "bodyAngleX": -2,
                "mouthForm": -.95, "mouthOpenY": .14, "browLAngle": .6, "browRAngle": .6,
                "browLY": -.85, "browRY": -.85, "eyeLOpen": -.48, "eyeROpen": -.48},
    "annoyed": {"angleX": -8, "angleY": 1, "angleZ": -14, "bodyAngleX": -.8,
                "mouthForm": -.45, "mouthOpenY": .02, "browLY": -.45, "browRY": -.18,
                "browLAngle": .3, "browRAngle": .2,
                "eyeLOpen": -.32, "eyeROpen": -.32, "browLForm": -.45, "browRForm": -.45},
    "question": {"angleX": 3, "angleY": -1, "angleZ": 8, "eyeBallY": .08,
                 "browLY": .65, "browRY": .05, "mouthForm": -.12, "mouthOpenY": .08,
                 "eyeLOpen": -.06, "eyeROpen": -.16},
    "thinking": {"angleX": 8, "angleY": 4, "angleZ": -12, "eyeBallX": .3,
                 "eyeBallY": .2, "browLY": .35, "browRY": -.15, "mouthForm": -.15,
                 "eyeLOpen": -.2, "eyeROpen": -.2},
    "surprised": {"angleY": -6, "angleZ": 1, "bodyAngleX": -2,
                  "browLY": .85, "browRY": .85, "mouthOpenY": .8,
                  "mouthForm": -.75, "eyeLOpen": .1, "eyeROpen": .1},
    "blush": {"angleX": 13, "angleY": 4, "angleZ": 12, "bodyAngleX": 1.2,
              "eyeBallX": -.45, "eyeBallY": -.2, "mouthForm": .55, "mouthOpenY": .15,
              "browLY": .2, "browRY": .12, "eyeLOpen": -.28, "eyeROpen": -.28, "cheek": .55},
    "indifferent": {"angleX": -4, "angleY": 1, "angleZ": -3,
                    "eyeLOpen": -.24, "eyeROpen": -.24, "mouthForm": -.15, "browLY": -.15, "browRY": -.15},
    "side": {"angleX": 8, "angleZ": 3, "eyeBallX": .28, "mouthForm": .15,
             "eyeLOpen": -.1, "eyeROpen": -.1},
    "winking": {"angleX": 3, "angleZ": 5, "bodyAngleX": .6, "mouthForm": .75},
    "eyes_closed": {"angleY": 2, "angleZ": 1, "mouthForm": .4},
}


# Authored performances, not random per-frame noise: each tuple is
# (seconds, cue gain, channel overrides). The first glance/raised brow arrives
# before the head follows; the final frame is a comfortable expression that
# can stay during a long reply without holding an open mouth or a hard turn.
# All core distinctions use brow height, eyelids, mouth and head/gaze channels.
PERFORMANCES = {
    "neutral": ((0, 0, {}), (.5, 0, {})),
    "happy": ((0, .18, {"mouthOpenY": 0, "angleZ": 0}),
              (.35, .8, {"angleZ": 3, "mouthOpenY": .20}),
              (.85, 1, {"angleZ": 7, "angleY": 1, "mouthOpenY": .28}),
              (1.45, .95, {"angleZ": 6, "angleY": -1, "mouthOpenY": .12}),
              (2.7, .8, {"angleZ": 3.5, "angleY": 0, "mouthOpenY": .06})),
    "excited": ((0, .2, {"mouthOpenY": .05, "angleY": 0}),
                (.24, 1, {"eyeLOpen": .04, "eyeROpen": .04, "mouthOpenY": .45}),
                (.75, 1, {"angleY": 2, "mouthOpenY": .30}),
                (1.35, .85, {"angleY": -2, "mouthOpenY": .18}),
                (2.6, .75, {"angleY": -.8, "mouthOpenY": .10})),
    "elated": ((0, .2, {"mouthOpenY": 0}),
               (.45, .9, {"angleY": -3, "browLY": .5, "browRY": .3, "mouthOpenY": .24}),
               (1.15, 1, {"angleX": 5, "angleZ": -6, "mouthOpenY": .16}),
               (2.8, .85, {"browLY": .28, "browRY": .12, "mouthOpenY": .04, "angleZ": -3})),
    "soft": ((0, .25, {"mouthOpenY": 0, "angleZ": 0}),
             (.65, .9, {"angleY": 3, "angleZ": 4, "mouthOpenY": .06}),
             (1.5, 1, {"angleY": .8, "angleZ": 5, "mouthOpenY": .04}),
             (3.2, .78, {"angleZ": 3, "mouthOpenY": .02})),
    "sad": ((0, .2, {"eyeBallY": 0, "angleY": 0}),
            (.45, .8, {"eyeBallY": -.2, "angleY": 2}),
            (1.35, 1, {"angleY": 6, "mouthOpenY": .03}),
            (3.5, .7, {"angleY": 3, "eyeBallY": -.08, "mouthOpenY": 0})),
    "disappointed": ((0, .2, {"browLY": .15, "browRY": .15}),
                     (.55, 1, {"angleY": 4, "mouthOpenY": .09}),
                     (1.5, .9, {"eyeBallY": -.12, "mouthOpenY": .02}),
                     (3, .65, {"angleY": 2, "mouthOpenY": 0})),
    "angry": ((0, .22, {"angleX": 0, "angleZ": 0}),
              (.3, .9, {"angleX": -2, "mouthOpenY": .10}),
              (.9, 1, {"angleY": -2, "angleZ": -3, "mouthOpenY": .06}),
              (2.7, .7, {"angleX": -2, "angleY": -.5, "mouthOpenY": .01})),
    "furious": ((0, .25, {"angleX": 0, "mouthOpenY": .04}),
                (.22, 1, {"angleY": -3, "mouthOpenY": .32}),
                (.75, 1, {"angleX": -5, "mouthOpenY": .16}),
                (1.45, .9, {"angleX": -2, "mouthOpenY": .05}),
                (3.1, .72, {"angleX": -1, "angleY": -1, "mouthOpenY": .02})),
    "annoyed": ((0, .22, {"angleX": 0, "angleZ": 0, "eyeBallX": .10}),
                (.28, .9, {"angleX": -3, "angleZ": -3, "eyeBallX": .24}),
                (.85, 1, {"angleX": -8, "angleZ": -8, "eyeBallX": .14}),
                (1.6, .86, {"angleX": -5, "angleZ": -5, "eyeBallX": .02}),
                (3, .65, {"angleX": -2, "angleZ": -2, "eyeBallX": 0, "mouthOpenY": 0})),
    "question": ((0, .2, {"angleZ": 0, "mouthOpenY": 0}),
                 (.25, .85, {"angleZ": 2, "eyeBallY": .10}),
                 (.9, 1, {"angleZ": 7, "mouthOpenY": .12}),
                 (2.6, .68, {"angleZ": 3, "mouthOpenY": .02, "eyeBallY": .02})),
    "thinking": ((0, .2, {"angleX": 0, "angleZ": 0, "eyeBallX": .08}),
                 (.38, .85, {"angleX": 3, "angleZ": -3, "eyeBallX": .34}),
                 (1.05, 1, {"angleX": 7, "angleZ": -6, "eyeBallX": .28}),
                 (2.8, .75, {"angleX": 3, "angleZ": -3, "eyeBallX": .06,
                             "eyeBallY": .04, "mouthOpenY": 0})),
    "surprised": ((0, .25, {"angleY": 0, "mouthOpenY": .1}),
                  (.2, 1, {"mouthOpenY": .65, "angleY": -4}),
                  (.65, .9, {"mouthOpenY": .46, "angleY": -3}),
                  (1.5, .65, {"mouthOpenY": .12, "mouthForm": -.1, "angleY": -1}),
                  (2.8, .45, {"mouthOpenY": .02, "mouthForm": .1, "angleY": 0,
                              "browLY": .32, "browRY": .20})),
    "blush": ((0, .15, {"angleX": 0, "angleZ": 0, "eyeBallX": 0}),
              (.18, .35, {"browLY": .48, "browRY": .38, "eyeLOpen": .03,
                           "eyeROpen": .03, "mouthForm": -.08, "mouthOpenY": .18,
                           "angleX": 1, "eyeBallX": -.08}),
              (.8, 1, {"angleX": 10, "angleZ": 7, "eyeBallX": -.42, "mouthOpenY": .08}),
              (1.65, .9, {"angleX": 7, "angleZ": 5, "eyeBallX": -.18, "mouthOpenY": .04}),
              (2.6, .85, {"angleX": 3, "angleZ": 3, "eyeBallX": .10, "eyeBallY": -.04,
                           "mouthForm": .64, "mouthOpenY": .03}),
              (3.5, .72, {"angleX": 3, "angleZ": 3, "eyeBallX": -.03, "mouthOpenY": .02})),
    "indifferent": ((0, .3, {"angleX": 0}),
                    (.7, .9, {"eyeBallX": -.12, "angleX": -3}),
                    (2.5, .7, {"eyeBallX": 0, "angleX": -1, "mouthOpenY": 0})),
    "side": ((0, .2, {"angleX": 0, "eyeBallX": .08}),
             (.2, .6, {"angleX": 1, "eyeBallX": .38}),
             (.7, 1, {"angleX": 8, "eyeBallX": .25}),
             (1.5, .8, {"angleX": 5, "eyeBallX": .10, "browLY": .15}),
             (2.7, .55, {"angleX": 2, "eyeBallX": 0})),
    "winking": ((0, .25, {"angleZ": 0}),
                (.2, 1, {"angleZ": 5, "browLY": .18, "mouthOpenY": .10}),
                (.8, .9, {"angleZ": 3, "mouthOpenY": .03}),
                (2, .7, {"angleZ": 1, "mouthOpenY": 0})),
    "eyes_closed": ((0, .3, {"angleY": 0}),
                    (.2, .85, {"angleY": 2.5, "mouthOpenY": .05}),
                    (.85, 1, {"angleY": 1, "browLY": .12, "browRY": .12}),
                    (2.5, .65, {"angleY": 0, "mouthOpenY": 0})),
}

LISTENING = (
    (0, .2, {"angleX": 0, "angleZ": 0, "browLY": .08, "browRY": .08}),
    (.4, .55, {"angleX": 0, "angleZ": 2, "browLY": .25, "browRY": .18,
               "mouthForm": .15, "mouthOpenY": 0}),
    (.95, .55, {"angleX": 0, "angleY": 2.8, "angleZ": 2,
                "browLY": .20, "browRY": .15, "mouthForm": .18, "mouthOpenY": 0}),
    (1.65, .5, {"angleX": 0, "angleY": 0, "angleZ": 1.5,
                "browLY": .18, "browRY": .14, "mouthForm": .14, "mouthOpenY": 0}),
)


def _emotion(name):
    return name if name in EMOTIONS else "neutral"


def _smoothstep(value):
    value = max(0.0, min(1.0, value))
    return value * value * (3 - 2 * value)


def _performance(emotion, age, frames=None):
    """Sample an authored phrase with zero velocity at each keyframe."""
    frames = frames or PERFORMANCES[emotion]
    def pose(frame):
        return {key: frame[2].get(key, CUES[emotion].get(key, 0) * frame[1]) for key in POSE_KEYS}
    if emotion == "neutral":
        return pose(frames[-1]), "settled"
    if age <= frames[0][0]:
        return pose(frames[0]), "onset"
    for previous, current in zip(frames, frames[1:]):
        if age < current[0]:
            alpha = _smoothstep((age - previous[0]) / (current[0] - previous[0]))
            start, end = pose(previous), pose(current)
            phase = "onset" if age < .35 else "hold" if age < frames[-1][0] * .55 else "release"
            return {key: start[key] + (end[key] - start[key]) * alpha for key in POSE_KEYS}, phase
    return pose(frames[-1]), "settled"


def _pulse(age, start, duration):
    """One soft finite attention beat, with no hard wrap at its ends."""
    progress = (age - start) / duration
    return math.sin(math.pi * progress) ** 2 if 0 < progress < 1 else 0.0


class BlinkCycle:
    """A short closure multiplier, separate from the resting expression.

    Sampling a lid after an expression has multiplied it cannot tell a blink
    from a half-open pose. Portrait rigs opt into this clock instead of the
    SDK blink and its stuck-eye recovery. A hidden window never replays missed
    blinks, and changing expression never restarts the current cycle.
    """

    CLOSE = .055
    HOLD = .025
    OPEN = .120

    def __init__(self, rng=None):
        self.rng = rng if rng is not None else random.Random()
        self.next_at = None
        self.started = None
        self.last_time = None

    def step(self, now, suppressed=False):
        gap = None if self.last_time is None else now - self.last_time
        self.last_time = now
        if self.next_at is None or gap is not None and (gap < 0 or gap > .75):
            self.started = None
            self.next_at = now + self.rng.uniform(3.5, 6.0)
        if suppressed:
            self.next_at = max(self.next_at, now + .8)
            if self.started is None:
                return 1.0
        if self.started is None and now >= self.next_at:
            self.started = now
        if self.started is None:
            return 1.0
        age = max(0.0, now - self.started)
        if age < self.CLOSE:
            return 1 - _smoothstep(age / self.CLOSE)
        if age < self.CLOSE + self.HOLD:
            return 0.0
        if age < self.CLOSE + self.HOLD + self.OPEN:
            return _smoothstep((age - self.CLOSE - self.HOLD) / self.OPEN)
        self.started = None
        self.next_at = now + self.rng.uniform(3.5, 6.0)
        return 1.0


class EyeGesture:
    """Finish opening smoothly when a wink is cancelled by a new state."""

    def __init__(self):
        self.values = {}
        self.releases = {}
        self.last_time = None

    def step(self, overrides, now):
        dt = None if self.last_time is None else now - self.last_time
        if dt is not None and (dt < 0 or dt > .75):
            self.values.clear()
            self.releases.clear()
        result = {}
        for key in self.values.keys() | overrides.keys():
            previous = self.values.get(key, 1.)
            if key in overrides:
                self.releases.pop(key, None)
                value = max(0., min(1., overrides[key]))
                if dt is not None and 0 <= dt < .1 and value > previous:
                    value = min(value, previous + dt / .1)
            else:
                since, start = self.releases.setdefault(key, (self.last_time if self.last_time is not None else now, previous))
                value = start + (1-start) * _smoothstep((now-since)/.1)
            if value < 1 or key in overrides:
                result[key] = value
            else:
                self.releases.pop(key, None)
        self.last_time = now
        self.values = result
        return dict(result)


class FaceSmoother:
    """Smooth the composed face, including changes to authored expressions.

    Motion/cursor channels never pass through this filter. Blinks have their
    own short timing envelope and can bypass it without polluting saved SDK
    parameters; the next ordinary frame starts from the last rendered eyelid.
    """

    def __init__(self):
        self.values = {}
        self.last_time = None

    def step(self, targets, now, immediate=(), speaking_mouth=None):
        dt = None if self.last_time is None else max(0.0, now - self.last_time)
        self.last_time = now
        for key, value in targets.items():
            if key not in self.values or dt is None or dt > .75 or key in immediate:
                self.values[key] = value
            else:
                speed = 28.0 if key == speaking_mouth else 14.0
                alpha = 1 - math.exp(-dt * speed)
                self.values[key] += (value - self.values[key]) * alpha
        self.values = {key: self.values[key] for key in targets}
        return dict(self.values)


class AffectController:
    """A small affect state machine with explicit foreground priorities.

    ``listening`` / ``thinking`` are persistent until the caller changes the
    activity or supplies a reply. A reply is held even when TTS is disabled.
    Repeated status events do not restart its animation or idle timers.
    """

    IDLE_EMOTIONS = ("soft", "thinking", "question", "indifferent", "neutral")
    # A conversation leaves a mild, finite after-effect, not an unrelated dice
    # roll. Strong negative states soften rather than remaining hostile at rest.
    IDLE_ECHO = {"happy": "happy", "excited": "happy", "elated": "happy", "soft": "soft",
                 "blush": "blush", "angry": "indifferent", "furious": "indifferent",
                 "annoyed": "indifferent", "sad": "disappointed", "disappointed": "disappointed",
                 "thinking": "thinking", "question": "question", "surprised": "question",
                 "side": "thinking", "winking": "soft", "eyes_closed": "soft"}
    ACTIVITIES = ("idle", "listening", "thinking", "reply", "speaking", "reaction", "error")

    def __init__(self, clock=time.monotonic, rng=None):
        self.clock = clock
        self.rng = rng if rng is not None else random.Random()
        now = self.clock()
        self.activity = "idle"
        self.activity_since = now
        self.speaking = False
        self.speaking_since = now
        self.speech_ended_at = None
        self.reply_emotion = "neutral"
        self.reply_since = now
        self.reply_until = now
        self.reaction_emotion = "neutral"
        self.reaction_since = now
        self.reaction_until = now
        self.idle_emotion = "neutral"
        self.idle_since = now
        self.idle_until = now
        self.next_idle_at = now + 6.0
        self.last_idle_emotion = "neutral"
        self.echo_emotion = "neutral"
        self.echo_since = now
        self.echo_until = now
        self.last_step = now
        self.pose = {key: 0.0 for key in POSE_KEYS}

    def _now(self, now):
        return self.clock() if now is None else float(now)

    def _reset_idle(self, now, delay=6.0):
        self.idle_until = now
        self.next_idle_at = now + delay

    def reset(self, now=None):
        """Return to natural rest without snapping the interpolated pose."""
        now = self._now(now)
        self.activity = "idle"
        self.activity_since = now
        self.speaking = False
        self.speech_ended_at = None
        self.reply_emotion = self.reaction_emotion = self.echo_emotion = "neutral"
        self.reply_until = self.reaction_until = self.echo_until = now
        self.reply_since = self.reaction_since = self.echo_since = now
        self.idle_emotion = self.last_idle_emotion = "neutral"
        self._reset_idle(now)

    def set_activity(self, activity, now=None):
        now = self._now(now)
        activity = activity if activity in self.ACTIVITIES else "idle"
        if activity == "speaking":
            self.set_speaking(True, now)
            return
        if activity == self.activity:
            return
        self.activity = activity
        self.activity_since = now
        if activity in ("listening", "thinking", "error"):
            self.speech_ended_at = None
            self.reaction_until = now
            self.reply_until = now
            self.echo_until = now
        self._reset_idle(now)

    def set_emotion(self, name, now=None, hold=3):
        now = self._now(now)
        name = _emotion(name)
        continuing = (name == self.reply_emotion and self.activity == "reply" and
                      (self.speaking or now < self.reply_until))
        self.reply_emotion = name
        if not continuing:
            self.speech_ended_at = None
            # A prepared interaction begins visually before its audio starts.
            # Promoting that same line to speech must not replay the startle.
            self.reply_since = (self.reaction_since if name == self.reaction_emotion
                                and now < self.reaction_until else now)
        self.reply_until = now + max(.1, min(60.0, float(hold)))
        self.echo_emotion = "neutral"
        self.echo_since = self.reply_until
        self.echo_until = now
        self.reaction_until = now
        self.activity = "reply"
        self.activity_since = now
        self._reset_idle(max(self.reply_until, self.echo_until), delay=4)

    def react(self, name, now=None, hold=3):
        now = self._now(now)
        if self.speaking or self.activity in ("listening", "thinking"):
            return False
        # A finished touch returns to the initial face, rather than uncovering
        # an older reply/after-effect that was hidden underneath the reaction.
        self.reply_until = self.echo_until = now
        self.echo_emotion = "neutral"
        self.activity = "idle"
        self.speech_ended_at = None
        self.reaction_emotion = _emotion(name)
        self.reaction_since = now
        self.reaction_until = now + max(.1, min(8.0, float(hold)))
        self._reset_idle(self.reaction_until)
        return True

    def set_speaking(self, active, now=None):
        now = self._now(now)
        active = bool(active)
        if self.speaking == active:
            return
        self.speaking = active
        if active:
            self.speaking_since = now
            self.speech_ended_at = None
            self.reaction_until = now
        else:
            self.speech_ended_at = now
            # A small grace period bridges adjacent audio chunks. The end of
            # the final clip must not inherit an eight-second visual hold or
            # a thirty-second mouth pose from the preceding reply.
            self.reply_until = now + .65
            self.echo_since = self.reply_until
            self.echo_until = now
            self.echo_emotion = "neutral"
            self._reset_idle(self.reply_until, delay=6)

    def begin_utterance(self, name, now=None):
        """Anchor a performance to actual playback, not synthesis wait time."""
        now = self._now(now)
        name = _emotion(name)
        continuation = (name == self.reply_emotion and self.speech_ended_at is not None
                        and 0 <= now - self.speech_ended_at < 1.0)
        recent_touch = name == self.reaction_emotion and now < self.reaction_until
        self.set_emotion(name, now)
        if not continuation and not recent_touch:
            self.reply_since = now
        self.set_speaking(True, now)

    def _select(self, now, reduced_motion):
        if self.speaking:
            return "speaking", self.reply_emotion, 1.0, self.reply_since
        if self.activity in ("listening", "thinking"):
            emotion = "question" if self.activity == "listening" else "thinking"
            return self.activity, emotion, .85, self.activity_since
        if self.activity == "error" and now - self.activity_since < 4:
            return "error", "disappointed", .8, self.activity_since
        if now < self.reaction_until:
            intensity = _smoothstep((self.reaction_until-now)/.6)
            return "reaction", self.reaction_emotion, intensity, self.reaction_since
        if now < self.reply_until:
            remaining = self.reply_until - now
            intensity = _smoothstep(remaining / .6)
            return "reply", self.reply_emotion, intensity, self.reply_since
        if now < self.echo_until:
            # Facial after-effects remain meaningful with reduced motion too;
            # step() suppresses movement channels, not semantic expressions.
            intensity = .36 * _smoothstep((self.echo_until - now) / .8)
            return "idle", self.echo_emotion, intensity, self.echo_since
        if now >= self.next_idle_at:
            choices = [emotion for emotion in self.IDLE_EMOTIONS if emotion != self.last_idle_emotion]
            self.idle_emotion = self.rng.choice(choices)
            self.last_idle_emotion = self.idle_emotion
            self.idle_since = now
            self.idle_until = now + self.rng.uniform(3.5, 5.0)
            self.next_idle_at = self.idle_until + self.rng.uniform(5.0, 9.0)
        if now < self.idle_until:
            envelope = min(_smoothstep((now - self.idle_since) / .8),
                           _smoothstep((self.idle_until - now) / 1.0))
            return "idle", self.idle_emotion, .55 * envelope, self.idle_since
        return "idle", "neutral", 0.0, now

    @staticmethod
    def _eye_override(emotion, age):
        duration = .36 if emotion == "winking" else .42
        if emotion not in ("winking", "eyes_closed") or age < 0 or age >= duration:
            return {}
        if age < .07:
            openness = 1 - _smoothstep(age / .07)
        elif age < .15:
            openness = 0.0
        else:
            openness = _smoothstep((age - .15) / (duration - .15))
        return {"eyeLOpen": openness} if emotion == "winking" else {
            "eyeLOpen": openness, "eyeROpen": openness,
        }

    def step(self, now=None, reduced_motion=False):
        now = self._now(now)
        activity, emotion, intensity, since = self._select(now, reduced_motion)
        age = max(0.0, now - since)
        # An after-effect is a quiet settled expression, not a second replay
        # of the reply's surprise/look-away when the voice finishes.
        echo = activity == "idle" and now < self.echo_until
        target, phase = _performance(emotion, float("inf") if echo else age,
                                     LISTENING if activity == "listening" else None)
        target = {key: value * intensity for key, value in target.items()}
        motion = 0.0 if reduced_motion else 1.0
        # Context-bound attention beats: brows lead, eyes glance, then the head
        # follows and returns. None of these channels filters the user's cursor.
        if activity == "thinking" and age > 3.4:
            glance = _pulse((age - 3.4) % 7.6, 1.3, 2.4)
            target["eyeBallX"] += .16 * glance
            target["eyeBallY"] += .09 * glance
            target["angleX"] += 1.5 * glance
            target["browLY"] += .07 * glance
        elif activity == "listening" and age > 2.5:
            acknowledge = _pulse((age - 2.5) % 7.2, 2.0, 1.3)
            target["angleY"] += 1.8 * acknowledge
            target["browLY"] += .035 * acknowledge
            target["browRY"] += .035 * acknowledge
        elif activity == "speaking":
            phrase_age = max(0.0, now - self.speaking_since)
            emphasis = _pulse(phrase_age % 5.8, .35, 1.05)
            target["angleY"] += 1.1 * emphasis
            target["bodyAngleX"] += .28 * emphasis
        # Low amplitude rest remains; no angry/blushing random idle states,
        # repeated head shakes, continuous eyelid flutters, or added voice cues.
        target["breath"] += math.sin(now * 1.6) * .035 * motion
        if activity == "idle":
            target["angleZ"] += _pulse(now % 9.2, 5.25, 1.7) * .25 * motion
            target["eyeBallX"] += _pulse(now % 9.2, 5.0, 1.7) * .035 * motion
        if reduced_motion:
            for key in ("angleX", "angleY", "angleZ", "bodyAngleX", "eyeBallX", "eyeBallY", "breath"):
                target[key] = 0.0
        dt = max(0.0, now - self.last_step)
        self.last_step = now
        # A short, time-based handover starts from the previous visible pose.
        # Large gaps settle directly rather than replaying unseen performances.
        alpha = 1 - math.exp(-min(dt, 10.0) * 8.0)
        for key in POSE_KEYS:
            self.pose[key] += (target[key] - self.pose[key]) * alpha
        return {"emotion": emotion, "activity": activity, "intensity": intensity,
                "phase": phase, "attention": max(.6, 1 - abs(self.pose["eyeBallX"]) * .7),
                "pose": dict(self.pose), "eye_override": self._eye_override(emotion, age)}
