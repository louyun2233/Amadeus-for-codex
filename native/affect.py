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


def _emotion(name):
    return name if name in EMOTIONS else "neutral"


def _smoothstep(value):
    value = max(0.0, min(1.0, value))
    return value * value * (3 - 2 * value)


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
            self.reaction_until = now
            self.reply_until = now
            self.echo_until = now
        self._reset_idle(now)

    def set_emotion(self, name, now=None, hold=8):
        now = self._now(now)
        name = _emotion(name)
        continuing = (name == self.reply_emotion and self.activity == "reply" and
                      (self.speaking or now < self.reply_until))
        self.reply_emotion = name
        if not continuing:
            self.reply_since = now
        self.reply_until = now + max(.1, min(60.0, float(hold)))
        self.echo_emotion = self.IDLE_ECHO.get(self.reply_emotion, "neutral")
        self.echo_since = self.reply_until
        self.echo_until = self.reply_until + 30 if self.echo_emotion != "neutral" else now
        self.reaction_until = now
        self.activity = "reply"
        self.activity_since = now
        self._reset_idle(self.reply_until, delay=4)

    def react(self, name, now=None, hold=3):
        now = self._now(now)
        if self.speaking or self.activity in ("listening", "thinking"):
            return False
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
            self.reaction_until = now
        else:
            # Finishing one segment or emptying the audio queue must not snap
            # the face back to neutral. A new listening/thinking state can
            # still take precedence immediately.
            self.reply_until = max(self.reply_until, now + 3.0)
            self.echo_since = self.reply_until
            if self.echo_emotion != "neutral":
                self.echo_until = self.reply_until + 30
            self._reset_idle(self.reply_until, delay=4)

    def _select(self, now, reduced_motion):
        if self.speaking:
            return "speaking", self.reply_emotion, 1.0, self.reply_since
        if self.activity in ("listening", "thinking"):
            emotion = "question" if self.activity == "listening" else "thinking"
            return self.activity, emotion, .85, self.activity_since
        if self.activity == "error" and now - self.activity_since < 4:
            return "error", "disappointed", .8, self.activity_since
        if now < self.reaction_until:
            return "reaction", self.reaction_emotion, 1.0, self.reaction_since
        if now < self.reply_until:
            remaining = self.reply_until - now
            intensity = .35 + .65 * _smoothstep(remaining / 2.5)
            return "reply", self.reply_emotion, intensity, self.reply_since
        if now < self.echo_until:
            # Facial after-effects remain meaningful with reduced motion too;
            # step() suppresses movement channels, not semantic expressions.
            intensity = .36 * _smoothstep((self.echo_until - now) / 8)
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
        target = {key: CUES[emotion].get(key, 0.0) * intensity for key in POSE_KEYS}
        motion = 0.0 if reduced_motion else 1.0
        # Low-amplitude life remains during rest; thinking and speech add a
        # slower nod. Cursor tracking itself is left entirely to the renderer.
        target["breath"] += math.sin(now * 1.6) * .035 * motion
        if activity == "idle":
            target["angleZ"] += math.sin(now * .65) * .7 * motion
            target["eyeBallX"] += math.sin(now * .43) * .04 * motion
        elif activity == "speaking":
            target["angleY"] += math.sin((now - since) * 2.1) * 1.1 * motion
            target["bodyAngleX"] += math.sin((now - since) * 1.3) * .4 * motion
        if reduced_motion:
            for key in ("angleX", "angleY", "angleZ", "bodyAngleX", "eyeBallX", "eyeBallY", "breath"):
                target[key] = 0.0
        dt = max(0.0, now - self.last_step)
        self.last_step = now
        # The exponential form is independent of frame rate for a steady cue.
        # Large gaps settle directly rather than replaying unseen animations.
        alpha = 1 - math.exp(-min(dt, 10.0) * 8.0)
        for key in POSE_KEYS:
            self.pose[key] += (target[key] - self.pose[key]) * alpha
        return {"emotion": emotion, "activity": activity, "intensity": intensity,
                "pose": dict(self.pose), "eye_override": self._eye_override(emotion, now - since)}
