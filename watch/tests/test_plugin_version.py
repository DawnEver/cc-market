"""Tests for scripts/cli/plugin_version — silent cache-bump drift detection."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))
sys.path.insert(0, str(_HERE.parent / 'scripts'))

from cli.plugin_version import (
    discover_versions,
    highest_version,
    read_last_seen,
    write_last_seen,
)


def _make_cache(root: Path, versions):
    for v in versions:
        (root / v).mkdir(parents=True)
    return root


class TestDiscovery(unittest.TestCase):
    def test_semver_sort_picks_highest(self):
        with tempfile.TemporaryDirectory() as d:
            root = _make_cache(Path(d), ['1.0.7', '1.0.44', '1.0.38'])
            self.assertEqual(discover_versions(root),
                             ['1.0.7', '1.0.38', '1.0.44'])
            self.assertEqual(highest_version(root), '1.0.44')

    def test_double_digit_beats_single(self):
        with tempfile.TemporaryDirectory() as d:
            root = _make_cache(Path(d), ['1.0.9', '1.0.10'])
            self.assertEqual(highest_version(root), '1.0.10')

    def test_missing_root(self):
        self.assertEqual(discover_versions(Path('/nonexistent/xyz')), [])
        self.assertIsNone(highest_version(Path('/nonexistent/xyz')))


class TestBaseline(unittest.TestCase):
    def test_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            sf = Path(d) / 'state' / 'plugin_version.json'
            self.assertIsNone(read_last_seen(sf))
            write_last_seen(sf, '1.0.44')
            self.assertEqual(read_last_seen(sf), '1.0.44')

    def test_corrupt_state_returns_none(self):
        with tempfile.TemporaryDirectory() as d:
            sf = Path(d) / 'plugin_version.json'
            sf.write_text('{not json', encoding='utf-8')
            self.assertIsNone(read_last_seen(sf))


if __name__ == '__main__':
    unittest.main()
