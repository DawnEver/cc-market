#!/usr/bin/env node
// One-time migration: re-path existing remote snapshots in the traceme sync repo to the
// current `YYYY/MM/DD/cc.enc` layout. Handles both prior formats:
//   - flat `YYYY-MM-DD.enc` (device branches) / `merged/YYYY-MM-DD.enc` (main)
//   - date-nested `YYYY/MM/DD.enc`
// Idempotent — branches with no legacy files are left untouched. Not part of the
// traceme CLI; run manually after upgrading:
//
//   node scripts/migrate-legacy-paths.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TRACEME_DIR } from './lib.mjs';

const SYNC_DIR = join(TRACEME_DIR, 'sync-repo');

function git(args, opts = {}) {
  const r = spawnSync('git', args, {
    cwd: SYNC_DIR,
    timeout: opts.timeout || 30000,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'traceme', GIT_AUTHOR_EMAIL: 'traceme@local', GIT_COMMITTER_NAME: 'traceme', GIT_COMMITTER_EMAIL: 'traceme@local' }
  });
  if (r.status !== 0 && !opts.ignoreError) {
    throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  }
  return r;
}

function getRemote() {
  if (process.env.TRACEME_SYNC_REMOTE) return process.env.TRACEME_SYNC_REMOTE;
  const r = git(['remote', 'get-url', 'origin'], { ignoreError: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

function migrateLegacyPaths() {
  if (!existsSync(SYNC_DIR) || !existsSync(join(SYNC_DIR, '.git'))) {
    throw new Error(`Sync repo not found at ${SYNC_DIR} — run 'traceme sync setup' first`);
  }
  if (!getRemote()) throw new Error('TRACEME_SYNC_REMOTE not set — cannot migrate');

  git(['fetch', '--all']);

  const refs = git(['ls-remote', '--heads', 'origin']).stdout;
  const branches = refs.split('\n')
    .map(l => l.trim())
    .filter(l => l.includes('refs/heads/'))
    .map(l => l.split('refs/heads/')[1])
    .filter(b => b === 'main' || b.startsWith('device/'));

  const results = [];
  for (const branch of branches) {
    git(['fetch', 'origin', branch]);

    const local = git(['branch', '--list', branch]).stdout;
    if (!local.includes(branch)) {
      git(['checkout', '-b', branch, `origin/${branch}`]);
    } else {
      git(['checkout', branch]);
      git(['reset', '--hard', `origin/${branch}`]);
    }

    const fileList = git(['ls-tree', '-r', '--name-only', 'HEAD']).stdout;
    const files = new Set(fileList.split('\n').map(f => f.trim()).filter(Boolean));

    const legacyPatterns = branch === 'main'
      ? [/^merged\/(\d{4})-(\d{2})-(\d{2})\.enc$/, /^(\d{4})\/(\d{2})\/(\d{2})\.enc$/]
      : [/^(\d{4})-(\d{2})-(\d{2})\.enc$/, /^(\d{4})\/(\d{2})\/(\d{2})\.enc$/];

    let moved = 0;
    for (const f of files) {
      const m = legacyPatterns.map(re => f.match(re)).find(Boolean);
      if (!m) continue;
      const [, y, mo, d] = m;
      const newPath = `${y}/${mo}/${d}/cc.enc`;

      if (!files.has(newPath)) {
        mkdirSync(join(SYNC_DIR, y, mo, d), { recursive: true });
        writeFileSync(join(SYNC_DIR, y, mo, d, 'cc.enc'), readFileSync(join(SYNC_DIR, f), 'utf8'), 'utf8');
        git(['add', newPath]);
      }
      git(['rm', '-q', '-f', f]);
      moved++;
    }

    if (moved > 0) {
      git(['commit', '-m', `traceme: migrate legacy snapshot paths to YYYY/MM/DD.enc [${branch}]`]);
      git(['push', 'origin', branch]);
      results.push({ branch, moved });
    }
  }

  return results;
}

const results = migrateLegacyPaths();
if (results.length === 0) {
  console.log('No legacy YYYY-MM-DD.enc paths found — nothing to migrate.');
} else {
  for (const r of results) console.log(`${r.branch}: migrated ${r.moved} snapshot(s)`);
}
