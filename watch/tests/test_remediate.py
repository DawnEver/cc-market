"""Tests for escalated-alert dedup suppression (alerts.suppress_after_n_identical)."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))
sys.path.insert(0, str(_HERE.parent / 'scripts'))

from components.base import Action, Anomaly, RemedyStep
from components.registry import ComponentRegistry
import core.remediate as remediate
from core.state import register_alert_signature, reset_anomaly


class TestRegisterAlertSignature(unittest.TestCase):
    def test_sends_until_threshold_then_suppresses(self):
        state: dict = {}
        # suppress_after=3 → first 3 identical alerts pass, 4th onward suppressed.
        results = [register_alert_signature(state, 'x', 'sig-A', 3) for _ in range(6)]
        self.assertEqual(results, [False, False, False, True, True, True])

    def test_signature_change_resets_run(self):
        state: dict = {}
        for _ in range(4):
            register_alert_signature(state, 'x', 'sig-A', 2)
        self.assertTrue(register_alert_signature(state, 'x', 'sig-A', 2))
        # A genuinely new situation releases suppression.
        self.assertFalse(register_alert_signature(state, 'x', 'sig-B', 2))

    def test_zero_disables_suppression(self):
        state: dict = {}
        self.assertFalse(any(
            register_alert_signature(state, 'x', 'sig-A', 0) for _ in range(10)))

    def test_reset_anomaly_clears_signature(self):
        state: dict = {}
        for _ in range(5):
            register_alert_signature(state, 'x', 'sig-A', 1)
        self.assertTrue(register_alert_signature(state, 'x', 'sig-A', 1))
        reset_anomaly(state, 'x')
        self.assertNotIn('_alert_sig_x', state)
        self.assertFalse(register_alert_signature(state, 'x', 'sig-A', 1))


class TestApplyRemediesSuppression(unittest.TestCase):
    def setUp(self):
        self.sent: list[int] = []
        self._orig = remediate._escalate
        remediate._escalate = lambda cfg, anomaly, count, report, dry: self.sent.append(count)

        self.reg = ComponentRegistry()
        self.reg._actions['notify'] = Action(command='exit 0', shell=True)
        self.reg._remedies['deploy_worktree_dirty'] = [
            RemedyStep(action='notify', escalate_after=1)]

        self.config = {
            'instance': {'name': 'test'},
            'alerts': {'suppress_after_n_identical': 3},
        }

    def tearDown(self):
        remediate._escalate = self._orig

    def _anomaly(self):
        return Anomaly(type='deploy_worktree_dirty', severity='warning',
                       message='repo: 1 uncommitted change(s)',
                       source='git_version.deploy_worktree_dirty')

    def test_identical_anomaly_stops_alerting_after_n(self):
        state: dict = {}
        for _ in range(6):
            remediate.apply_remedies(self.reg, [self._anomaly()], self.config,
                                     state, Path('.'), 'ts', dry_run=True)
        # Only the first 3 identical escalations send; the rest are suppressed.
        self.assertEqual(len(self.sent), 3)

    def test_changed_signature_resumes_alerting(self):
        state: dict = {}
        for _ in range(4):
            remediate.apply_remedies(self.reg, [self._anomaly()], self.config,
                                     state, Path('.'), 'ts', dry_run=True)
        self.assertEqual(len(self.sent), 3)
        # Dirty commit changes → message changes → suppression releases.
        moved = Anomaly(type='deploy_worktree_dirty', severity='warning',
                        message='repo: 2 uncommitted change(s)',
                        source='git_version.deploy_worktree_dirty')
        remediate.apply_remedies(self.reg, [moved], self.config, state,
                                 Path('.'), 'ts', dry_run=True)
        self.assertEqual(len(self.sent), 4)


if __name__ == '__main__':
    unittest.main()
