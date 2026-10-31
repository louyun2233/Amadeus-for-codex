"""One time-based cursor filter shared by eye, head and torso tracking."""
import math
import time


class CursorTracker:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.last_time = clock()
        self.x = self.y = 0.0

    def step(self, x, y, width, height, now=None):
        now = self.clock() if now is None else float(now)
        target_x = max(-1.0, min(1.0, 2 * x / max(1, width) - 1))
        target_y = max(-1.0, min(1.0, 1 - 2 * y / max(1, height)))
        dt = max(0.0, min(.1, now - self.last_time))
        self.last_time = now
        alpha = 1 - math.exp(-dt / .045)
        self.x += (target_x - self.x) * alpha
        self.y += (target_y - self.y) * alpha
        return self.x, self.y
