"""Tests for GitVersion component — backport & deploy-ahead detection."""
from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))
sys.path.insert(0, str(_HERE.parent / 'scripts'))

from components.git_version import GitVersion


class TestGitVersionBackport(unittest.TestCase):
    def _git(self, cwd, *args):
        subprocess.run(['git', *args], cwd=cwd, check=True, capture_output=True, text=True)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)

        # Bare "remote" repo
        self.remote = root / 'remote.git'
        self.remote.mkdir()
        self._git(self.remote, 'init', '--bare', '-b', 'main')

        # Working clone — seed main + deploy with one commit
        self.work = root / 'work'
        self.work.mkdir()
        self._git(self.work, 'init', '-b', 'main')
        self._git(self.work, 'config', 'user.email', 'test@example.com')
        self._git(self.work, 'config', 'user.name', 'Test')
        (self.work / 'file.txt').write_text('v1\n', encoding='utf-8')
        self._git(self.work, 'add', 'file.txt')
        self._git(self.work, 'commit', '-m', 'initial')
        self._git(self.work, 'remote', 'add', 'origin', str(self.remote))
        self._git(self.work, 'push', 'origin', 'main')
        self._git(self.work, 'branch', 'deploy')
        self._git(self.work, 'push', 'origin', 'deploy')

        # Hotfix landed directly on deploy, not on main
        self._git(self.work, 'checkout', 'deploy')
        (self.work / 'file.txt').write_text('v1-hotfix\n', encoding='utf-8')
        self._git(self.work, 'add', 'file.txt')
        self._git(self.work, 'commit', '-m', 'fix: hotfix on deploy')
        self._git(self.work, 'push', 'origin', 'deploy')
        self._git(self.work, 'checkout', 'main')
        self._git(self.work, 'fetch', 'origin')

        self.comp_cfg = {
            'repositories': [{'name': 'repo', 'path': '.', 'remote': 'origin', 'branch': 'main'}],
            'deploy': {'deploy_branch': 'deploy', 'staging_dir': '.staging',
                       'enable_backport': True, 'test_command': 'exit 0'},
        }
        self.global_cfg = {'_project_dir': str(self.work)}

    def tearDown(self):
        self.tmp.cleanup()

    def test_check_detects_deploy_ahead(self):
        c = GitVersion()
        result = c.check(self.comp_cfg, self.global_cfg, {})
        self.assertEqual(result.metrics['repo_deploy_ahead'], 1)
        self.assertEqual(result.metrics['deploy_ahead_total'], 1)
        types = [a.type for a in result.anomalies]
        self.assertIn('deploy_ahead_of_main', types)

    def test_backport_merges_and_pushes_to_main(self):
        c = GitVersion()
        context = {}
        ok = c.execute_action('backport_deploy', self.comp_cfg, self.global_cfg,
                              self.work, context)
        self.assertTrue(ok)
        self.assertEqual(context['backport_result'], 'passed')

        main_head = subprocess.check_output(
            ['git', 'log', '-1', '--format=%H', 'main'],
            cwd=self.remote, text=True).strip()
        deploy_head = subprocess.check_output(
            ['git', 'log', '-1', '--format=%H', 'deploy'],
            cwd=self.remote, text=True).strip()
        self.assertEqual(main_head, deploy_head)

    def test_backport_disabled_by_default(self):
        cfg = dict(self.comp_cfg)
        cfg['deploy'] = dict(cfg['deploy'])
        cfg['deploy']['enable_backport'] = False
        c = GitVersion()
        context = {}
        ok = c.execute_action('backport_deploy', cfg, self.global_cfg, self.work, context)
        self.assertTrue(ok)
        self.assertNotIn('backport_result', context)

    def test_backport_skips_failing_tests(self):
        cfg = dict(self.comp_cfg)
        cfg['deploy'] = dict(cfg['deploy'])
        cfg['deploy']['test_command'] = 'exit 1'
        c = GitVersion()
        context = {}
        ok = c.execute_action('backport_deploy', cfg, self.global_cfg, self.work, context)
        self.assertFalse(ok)
        self.assertEqual(context['backport_result'], 'failed')

        remote_main = subprocess.check_output(
            ['git', 'log', '-1', '--format=%s', 'main'],
            cwd=self.remote, text=True).strip()
        self.assertEqual(remote_main, 'initial')


if __name__ == '__main__':
    unittest.main()
