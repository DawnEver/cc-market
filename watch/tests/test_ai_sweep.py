"""Tests for the adaptive AI-sweep cadence — ladder rungs + interval→cron."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))
sys.path.insert(0, str(_HERE.parent / 'scripts'))

from core.config import DEFAULTS
from core.report import _ai_sweep_overview, _interval_to_cron

_INSTANCE = {'ai_sweep': {'ladder': [3600, 21600, 86400], 'promote_after': 3}}


class TestDefaults(unittest.TestCase):
    def test_ai_sweep_defaults(self):
        sweep = DEFAULTS['instance']['ai_sweep']
        self.assertEqual(sweep['ladder'], [3600, 21600, 86400])
        self.assertEqual(sweep['promote_after'], 3)


class TestLadder(unittest.TestCase):
    def _rung(self, streak):
        return _ai_sweep_overview(_INSTANCE, {'_healthy_streak': streak})

    def test_anomaly_state_is_shortest_rung(self):
        r = self._rung(0)
        self.assertEqual(r['rung'], 0)
        self.assertEqual(r['next_interval_seconds'], 3600)
        self.assertEqual(r['next_cron_expr'], '7 * * * *')

    def test_climbs_after_promote_after(self):
        self.assertEqual(self._rung(2)['rung'], 0)   # not yet promoted
        self.assertEqual(self._rung(3)['rung'], 1)   # first promotion → 6h
        self.assertEqual(self._rung(3)['next_interval_seconds'], 21600)
        self.assertEqual(self._rung(6)['rung'], 2)   # second promotion → 24h

    def test_caps_at_top_rung(self):
        r = self._rung(999)
        self.assertEqual(r['rung'], 2)
        self.assertEqual(r['next_interval_seconds'], 86400)
        self.assertEqual(r['next_cron_expr'], '7 3 * * *')

    def test_missing_streak_defaults_to_zero(self):
        self.assertEqual(_ai_sweep_overview(_INSTANCE, {})['rung'], 0)

    def test_falls_back_to_default_ladder(self):
        r = _ai_sweep_overview({}, {'_healthy_streak': 0})
        self.assertEqual(r['ladder'], [3600, 21600, 86400])

    def test_promote_after_floored_at_one(self):
        inst = {'ai_sweep': {'ladder': [60, 120], 'promote_after': 0}}
        r = _ai_sweep_overview(inst, {'_healthy_streak': 1})
        self.assertEqual(r['rung'], 1)  # promote_after coerced to 1


class TestIntervalToCron(unittest.TestCase):
    def test_hourly(self):
        self.assertEqual(_interval_to_cron(3600), '7 * * * *')

    def test_sub_daily_divisor(self):
        self.assertEqual(_interval_to_cron(21600), '7 */6 * * *')
        self.assertEqual(_interval_to_cron(7200), '7 */2 * * *')

    def test_daily(self):
        self.assertEqual(_interval_to_cron(86400), '7 3 * * *')

    def test_multi_day_collapses_to_daily(self):
        self.assertEqual(_interval_to_cron(172800), '7 3 * * *')

    def test_minute_divisor(self):
        self.assertEqual(_interval_to_cron(1800), '*/30 * * * *')
        self.assertEqual(_interval_to_cron(300), '*/5 * * * *')

    def test_off_minute_avoids_zero(self):
        # hourly+ rungs never land on minute 0
        for sec in (3600, 21600, 86400):
            self.assertFalse(_interval_to_cron(sec).startswith('0 '))


if __name__ == '__main__':
    unittest.main()
