import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "native"))
from tracking import CursorTracker


class TrackingTests(unittest.TestCase):
    def test_eye_and_head_have_one_fast_non_overshooting_target(self):
        t = CursorTracker(clock=lambda: 0)
        samples = [t.step(300, 100, 300, 200, now=n / 60)[0] for n in range(1, 7)]
        self.assertGreater(samples[-1], .88)
        self.assertEqual(samples, sorted(samples))
        self.assertLess(samples[-1], 1)

    def test_inside_edge_and_outside_share_timing(self):
        inside, outside = CursorTracker(clock=lambda: 0), CursorTracker(clock=lambda: 0)
        for n in range(1, 20):
            self.assertEqual(inside.step(300, 100, 300, 200, n/60),
                             outside.step(900, 100, 300, 200, n/60))

    def test_following_is_independent_of_frame_rate(self):
        fast, slow = CursorTracker(clock=lambda: 0), CursorTracker(clock=lambda: 0)
        for n in range(1, 13):
            a = fast.step(300, 100, 300, 200, n/120)
        for n in range(1, 4):
            b = slow.step(300, 100, 300, 200, n/30)
        self.assertAlmostEqual(a[0], b[0], places=10)

    def test_direction_reversal_is_continuous_and_immediate(self):
        t = CursorTracker(clock=lambda: 0)
        right, _ = t.step(300, 100, 300, 200, .1)
        first_left, _ = t.step(0, 100, 300, 200, .1+1/60)
        self.assertLess(first_left, right)
        self.assertGreater(first_left, -1)
        for n in range(2, 8):
            left, _ = t.step(0, 100, 300, 200, .1+n/60)
        self.assertLess(left, -.8)
