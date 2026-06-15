"""Tests for bootstrap stdio handling."""
from __future__ import annotations

import io
import sys
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))
sys.path.insert(0, str(_HERE.parent / 'scripts'))

import bootstrap


class TestForceUtf8Io(unittest.TestCase):
    """Windows consoles default to cp1252; report glyphs (✓, —) must not raise
    UnicodeEncodeError. _force_utf8_io reconfigures stdio to UTF-8."""

    def setUp(self):
        self._saved = (sys.stdout, sys.stderr)
        sys.stdout = io.TextIOWrapper(io.BytesIO(), encoding='cp1252')
        sys.stderr = io.TextIOWrapper(io.BytesIO(), encoding='cp1252')

    def tearDown(self):
        sys.stdout, sys.stderr = self._saved

    def test_reconfigures_streams_to_utf8(self):
        bootstrap._force_utf8_io()
        self.assertEqual(sys.stdout.encoding.lower(), 'utf-8')
        self.assertEqual(sys.stderr.encoding.lower(), 'utf-8')

    def test_unmappable_glyphs_do_not_raise(self):
        bootstrap._force_utf8_io()
        sys.stdout.write('✓ HEALTHY — all OK')  # would raise under cp1252
        sys.stdout.flush()

    def test_no_op_when_stream_lacks_reconfigure(self):
        sys.stdout = object()  # no reconfigure attribute
        bootstrap._force_utf8_io()  # must swallow AttributeError


if __name__ == '__main__':
    unittest.main()
