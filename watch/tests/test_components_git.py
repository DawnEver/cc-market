"""Tests for GitVersion — one-way deploy to a deploy worktree, failure
counting/escalation, and the recover_service ladder."""
from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))
sys.path.insert(0, str(_HERE.parent / 'scripts'))

from components.git_version import (
    GitVersion,
    deploy_signature,
    load_failures,
    load_known,
    record_failure,
    save_known,
)


def _git(cwd, *args):
    return subprocess.run(['git', *args], cwd=cwd, check=True,
                          capture_output=True, text=True)


def _head(cwd) -> str:
    return subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=cwd, text=True).strip()


class _OneRepoFixture(unittest.TestCase):
    """main working tree on `main` + a sibling deploy worktree on `deploy`."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)

        self.remote = root / 'remote.git'
        self.remote.mkdir()
        _git(self.remote, 'init', '--bare', '-b', 'main')

        self.work = root / 'work'          # main tree (path ".")
        self.work.mkdir()
        _git(self.work, 'init', '-b', 'main')
        _git(self.work, 'config', 'user.email', 't@e.com')
        _git(self.work, 'config', 'user.name', 'T')
        (self.work / 'f.txt').write_text('A\n', encoding='utf-8')
        _git(self.work, 'add', '.'); _git(self.work, 'commit', '-m', 'A')
        _git(self.work, 'remote', 'add', 'origin', str(self.remote))
        _git(self.work, 'push', 'origin', 'main')
        self.commitA = _head(self.work)

        _git(self.work, 'branch', 'deploy')
        self.deploy_wt = root / 'deploy_wt'   # deploy worktree (deploy_path)
        _git(self.work, 'worktree', 'add', str(self.deploy_wt), 'deploy')

        # second main commit B (the new version to deploy)
        (self.work / 'f.txt').write_text('B\n', encoding='utf-8')
        _git(self.work, 'add', '.'); _git(self.work, 'commit', '-m', 'B')
        _git(self.work, 'push', 'origin', 'main')
        self.commitB = _head(self.work)

        self.comp_cfg = {
            'repositories': [{'name': 'repo', 'path': '.',
                              'deploy_path': '../deploy_wt',
                              'remote': 'origin', 'branch': 'main'}],
            'known_good_file': '.claude/watch/known-good.json',
            'deploy': {'deploy_branch': 'deploy', 'staging_dir': '.staging',
                       'test_command': 'exit 0'},
        }
        self.global_cfg = {'_project_dir': str(self.work)}
        save_known(self.comp_cfg, self.work, {'repo': self.commitA})

    def tearDown(self):
        self.tmp.cleanup()


class TestOneWayDeploy(_OneRepoFixture):
    def test_check_detects_new_version(self):
        result = GitVersion().check(self.comp_cfg, self.global_cfg, {})
        self.assertEqual(result.metrics['new_commits'], 1)
        self.assertIn('new_version_available', [a.type for a in result.anomalies])

    def test_deploy_swaps_worktree_and_marks_known_good(self):
        context = {}
        ok = GitVersion().execute_action('deploy', self.comp_cfg, self.global_cfg,
                                         self.work, context)
        self.assertTrue(ok)
        self.assertEqual(_head(self.deploy_wt), self.commitB)   # deploy advanced
        self.assertEqual(_head(self.work), self.commitB)        # main tree untouched by deploy
        self.assertEqual(load_known(self.comp_cfg, self.work)['repo'], self.commitB)
        self.assertEqual(load_failures(self.comp_cfg, self.work), [])

    def test_deploy_failure_keeps_production_and_records(self):
        cfg = dict(self.comp_cfg)
        cfg['deploy'] = {**cfg['deploy'], 'test_command': 'exit 1'}
        context = {}
        ok = GitVersion().execute_action('deploy', cfg, self.global_cfg, self.work, context)
        self.assertFalse(ok)
        self.assertEqual(_head(self.deploy_wt), self.commitA)   # production untouched
        self.assertEqual(load_known(cfg, self.work)['repo'], self.commitA)
        self.assertEqual(len(load_failures(cfg, self.work)), 1)

    def test_new_version_suppressed_when_target_already_failed(self):
        # signature of the would-be deploy {repo: B}
        record_failure(self.comp_cfg, self.work, deploy_signature({'repo': self.commitB}))
        result = GitVersion().check(self.comp_cfg, self.global_cfg, {})
        self.assertNotIn('new_version_available', [a.type for a in result.anomalies])

    def test_three_distinct_failures_escalate(self):
        for s in ('sig1', 'sig2', 'sig3'):
            record_failure(self.comp_cfg, self.work, s)
        result = GitVersion().check(self.comp_cfg, self.global_cfg, {})
        self.assertIn('deploy_failed', [a.type for a in result.anomalies])


class TestRecoverService(_OneRepoFixture):
    def test_recover_rolls_back_then_escalates_when_known_good_unhealthy(self):
        # Simulate a bad deploy: production worktree at B, known-good at A.
        _git(self.deploy_wt, 'reset', '--hard', self.commitB)
        cfg = dict(self.comp_cfg)
        cfg['deploy'] = {**cfg['deploy'],
                         'production_health_url': ['http://127.0.0.1:1/'],  # unreachable
                         'restart_attempts': 1,
                         'test_health_timeout': 1,
                         'test_prestart_sleep': 0}
        context = {}
        ok = GitVersion().execute_action('recover_service', cfg, self.global_cfg,
                                         self.work, context)
        self.assertFalse(ok)                                   # known-good not serving → escalate
        self.assertEqual(_head(self.deploy_wt), self.commitA)  # rolled back to known-good

    def test_health_anomaly_delegates_recovery_to_git_version(self):
        """A non-git_version anomaly source (http_health) must still route the
        recover_service action to git_version via the owner-lookup fallback."""
        from components.registry import create_registry
        from core.actions import _execute_action
        _git(self.deploy_wt, 'reset', '--hard', self.commitB)
        gv = {**self.comp_cfg, 'enabled': True}
        gv['deploy'] = {**gv['deploy'],
                        'production_health_url': ['http://127.0.0.1:1/'],
                        'restart_attempts': 1, 'test_health_timeout': 1,
                        'test_prestart_sleep': 0}
        cfg = {'components': {'git_version': gv}, '_project_dir': str(self.work)}
        reg = create_registry(cfg, self.work)
        action = reg.get_action('recover_service')
        context = {'_registry': reg}
        ok = _execute_action(action, self.work, reg,
                             'http_health.endpoint_unreachable', context)
        self.assertFalse(ok)
        self.assertEqual(_head(self.deploy_wt), self.commitA)  # recovery ran → rolled back


if __name__ == '__main__':
    unittest.main()
