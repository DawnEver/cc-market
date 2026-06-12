"""Tests for core.anomalies — AI-only anomaly classification, the single source
of truth shared by watchd, trigger-watch, and trigger-emit."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))

from core.anomalies import AI_ONLY_ANOMALY_TYPES, is_ai_only


class TestIsAiOnly(unittest.TestCase):
    def test_empty_is_not_ai_only(self):
        # No anomalies → nothing to suppress.
        self.assertFalse(is_ai_only([]))

    def test_all_ai_only(self):
        self.assertTrue(is_ai_only(['cron_stale']))
        self.assertTrue(is_ai_only(['cron_stale', 'cron_marker_missing']))

    def test_mixed_is_not_ai_only(self):
        # An actionable anomaly alongside an AI-only one must still wake the loop.
        self.assertFalse(is_ai_only(['cron_stale', 'endpoint_unreachable']))

    def test_actionable_only_is_not_ai_only(self):
        self.assertFalse(is_ai_only(['endpoint_unreachable', 'disk_usage_high']))

    def test_constant_membership(self):
        self.assertIn('cron_stale', AI_ONLY_ANOMALY_TYPES)
        self.assertIn('cron_marker_missing', AI_ONLY_ANOMALY_TYPES)


if __name__ == '__main__':
    unittest.main()
