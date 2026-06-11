"""Tests for LogScanner component."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))
sys.path.insert(0, str(_HERE.parent / 'scripts'))

from components.log_scanner import LogScanner


class TestLogScanner(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.log_dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _write_log(self, name, *lines):
        f = self.log_dir / name
        f.write_text('\n'.join(lines), encoding='utf-8')

    def test_name_and_description(self):
        c = LogScanner()
        self.assertEqual(c.name, 'log_scanner')
        self.assertIsInstance(c.description, str)

    def test_no_log_dir_returns_clean(self):
        c = LogScanner()
        result = c.check({}, {}, {})
        self.assertEqual(result.data['status'], 'NO_LOG_DIR')
        self.assertEqual(result.metrics['error_count'], 0)
        self.assertEqual(len(result.anomalies), 0)

    def test_missing_log_dir_returns_clean(self):
        c = LogScanner()
        result = c.check({'log_dir': '/nonexistent/path'}, {}, {})
        self.assertEqual(result.data['status'], 'NO_LOG_DIR')

    def test_clean_logs_no_anomaly(self):
        self._write_log('a.log', 'INFO: starting', 'DEBUG: running', 'INFO: done')
        self._write_log('b.log', 'Processing OK', 'Task complete')
        c = LogScanner()
        result = c.check({'log_dir': str(self.log_dir)}, {}, {})
        self.assertEqual(result.data['status'], 'CLEAN')
        self.assertEqual(result.metrics['error_count'], 0)
        self.assertEqual(len(result.anomalies), 0)

    def test_errors_found_detects_anomaly(self):
        self._write_log('a.log', 'Running', 'ERROR: something broke', 'Exiting')
        c = LogScanner()
        result = c.check({'log_dir': str(self.log_dir)}, {}, {})
        self.assertEqual(result.data['status'], 'ERRORS_FOUND')
        self.assertGreaterEqual(result.metrics['error_count'], 1)
        self.assertEqual(len(result.anomalies), 1)
        self.assertEqual(result.anomalies[0].type, 'errors_detected')

    def test_multiple_error_patterns(self):
        self._write_log('a.log', 'FAIL: init', 'line2', 'line3', 'line4', 'ERROR: mid')
        self._write_log('b.log', 'line1', 'Traceback: boom', 'line3', 'line4', 'line5')
        c = LogScanner()
        result = c.check({'log_dir': str(self.log_dir)}, {}, {})
        self.assertGreaterEqual(result.metrics['error_count'], 2)

    def test_tail_lines_only_scanned(self):
        lines = ['line' + str(i) for i in range(20)]
        lines[-1] = 'ERROR: at the very end'
        self._write_log('a.log', *lines)
        c = LogScanner()
        result = c.check({'log_dir': str(self.log_dir), 'tail_lines': 3}, {}, {})
        self.assertEqual(result.metrics['error_count'], 1)
        error_files = [e['file'] for e in result.data['errors']]
        self.assertIn('a.log', error_files)

    def test_respects_max_files(self):
        for i in range(5):
            self._write_log(f'{i}.log', f'ERROR in file {i}')
        c = LogScanner()
        result = c.check({'log_dir': str(self.log_dir), 'max_files': 2}, {}, {})
        self.assertEqual(result.metrics['files_scanned'], 2)

    def test_custom_error_patterns(self):
        self._write_log('a.log', 'WARNING: disk low', 'INFO: ok')
        c = LogScanner()
        result = c.check({
            'log_dir': str(self.log_dir),
            'error_patterns': ['WARNING'],
        }, {}, {})
        self.assertEqual(result.metrics['error_count'], 1)


if __name__ == '__main__':
    unittest.main()
