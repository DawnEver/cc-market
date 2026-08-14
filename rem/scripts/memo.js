#!/usr/bin/env node
// memo.js — save a fact together with its INVALIDATION KEY, so re-reading it
// costs one call and can say STALE.
//
//   node memo.js save band --file src/workflow/workflow.py --lines 1180,1240
//   node memo.js save ladder --cmd "python probe.py" --from src/hamilton/accuracy.py
//   node memo.js get band            # value + FRESH, or STALE naming the changed source
//   node memo.js list                # one line each: name, FRESH/STALE, age
//   node memo.js list --hook         # SessionStart/PostCompact form: never exits non-zero
//
// WHY AN INVALIDATION KEY AND NOT A SCRATCHPAD. A written fact does not
// invalidate itself when its source changes, so a note is cheap and silently
// wrong — the "declaration that lies" shape. Git has known the answer the
// whole time: the blob hash. A memo that carries its sources' hashes is the one
// shape that beats both a re-read (expensive, no drift signal) and a note.
//
// A --cmd memo REQUIRES --from. A command's dependencies cannot be inferred,
// and a memo whose sources were guessed would report FRESH on a stale value —
// a lying declaration used to fix lying declarations. Refusing is the only
// honest option, so it refuses.
//
// The store is <scope>/.claude/memo/ (gitignored via migrations/migrate.mjs),
// resolved by findMemoryScope() — a CACHE, not a record: losing it costs one
// re-read. It lives under the scope's own .claude/, so a worktree and its main
// checkout each keep their own store — an absolute or shared path would answer
// FRESH in a tree about a file it never read.

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { atomicWriteFile } from '../shared/stamp.mjs';
import { findMemoryScope, isInsideDir } from './lib.mjs';

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// The operator's git via PATH — resolved by the OS, never a guessed absolute path.
const GIT = 'git';

export function storeDir(scopeRoot = findMemoryScope()) {
  return join(scopeRoot, '.claude', 'memo');
}

/** `git hash-object` of path, or null when it cannot be hashed.
 *  The file's CONTENT hash, not its mtime: a touched-but-unchanged file is not
 *  a change, and a reverted edit is not one either. mtime says "something
 *  happened to this file", which is a different question and the one that
 *  produces false STALEs. */
export function blobHash(path) {
  if (!existsSync(path)) return null;
  const out = spawnSync(GIT, ['hash-object', '--', path], { encoding: 'utf8' });
  if (out.status !== 0) return null;
  return out.stdout.trim() || null;
}

/** The content hash of every named source, keyed by the spelling the caller used. */
export function sourcesState(sources) {
  return Object.fromEntries(sources.map((s) => [s, blobHash(s)]));
}

/** Sources whose content hash no longer matches what was saved. */
export function drift(memo) {
  return Object.entries(memo.sources)
    .filter(([source, was]) => blobHash(source) !== was)
    .map(([source]) => source);
}

function memoPath(store, name) {
  return join(store, `${name}.json`);
}

/** Read a file, or slice `lines` ("START,END", 1-indexed, inclusive) out of it. */
function readLines(file, lines) {
  const [start, end] = lines.split(',');
  const body = readFileSync(file, 'utf8').split('\n');
  return body.slice(Number(start) - 1, Number(end)).join('\n');
}

function usage(msg) {
  if (msg) console.error(`[memo] ${msg}`);
  console.error(
    'Usage:\n' +
      '  node memo.js save <name> (--file <path> [--lines START,END] | --cmd <shell> --from <path>...)\n' +
      '  node memo.js get <name> [--refresh]\n' +
      '  node memo.js list [--hook]',
  );
  process.exit(1);
}

function cmdSave(name, rest) {
  const fileFlag = flagValue(rest, '--file');
  const lines = flagValue(rest, '--lines');
  const cmd = flagValue(rest, '--cmd');
  const fromIdx = rest.indexOf('--from');
  const from = fromIdx >= 0 ? rest.slice(fromIdx + 1).filter((a) => !a.startsWith('--')) : [];

  let value, sources;
  if (fileFlag) {
    if (!existsSync(fileFlag)) {
      console.error(`[memo] ${fileFlag} does not exist`);
      return 1;
    }
    value = lines ? readLines(fileFlag, lines) : readFileSync(fileFlag, 'utf8');
    sources = [fileFlag];
  } else if (cmd) {
    if (!from.length) {
      // The refusal this tool would be dishonest without. See the header comment.
      console.error(
        '[memo] --cmd needs --from <paths>: a command\'s sources cannot be inferred, and a\n' +
          '[memo] memo with guessed sources would answer FRESH about a value that is stale.',
      );
      return 1;
    }
    // exec with shell IS THE FEATURE: --cmd is a shell command the operator
    // typed, pipes and all, and saving its stdout is the whole point. It is
    // never composed from anything but that argument.
    const out = spawnSync(cmd, { shell: true, encoding: 'utf8' });
    if (out.status !== 0) {
      console.error(`[memo] the command failed (exit ${out.status}); nothing saved:\n${out.stderr || ''}`);
      return 1;
    }
    value = out.stdout;
    sources = from;
  } else {
    usage('save needs --file or --cmd');
  }

  const store = storeDir();
  mkdirSync(store, { recursive: true });
  const target = resolve(memoPath(store, name));
  if (!isInsideDir(store, target)) {
    console.error(`[memo] path traversal denied: ${name}`);
    return 1;
  }
  atomicWriteFile(
    target,
    JSON.stringify(
      { name, value, sources: sourcesState(sources), cmd: cmd || null, saved_at: Date.now() / 1000 },
      null,
      2,
    ),
  );
  console.log(`[memo] saved '${name}' (${value.length} chars, ${sources.length} source(s))`);
  return 0;
}

function cmdGet(name, rest) {
  const refresh = rest.includes('--refresh');
  const store = storeDir();
  const path = memoPath(store, name);
  if (!existsSync(path)) {
    console.error(`[memo] no memo named '${name}' — the \`list\` subcommand shows what there is`);
    return 1;
  }
  const memo = JSON.parse(readFileSync(path, 'utf8'));
  const changed = drift(memo);
  if (changed.length) {
    console.error(`[memo] STALE: ${changed.join(', ')} changed since this was saved.`);
    if (memo.cmd && refresh) {
      const from = Object.keys(memo.sources);
      const rc = cmdSave(name, ['--cmd', memo.cmd, '--from', ...from]);
      if (rc !== 0) return rc;
      return cmdGet(name, []);
    }
    console.error('[memo] the value below is what was saved; re-save (or pass --refresh) before trusting it.');
  } else {
    console.error('[memo] FRESH: every source is byte-identical to when this was saved.');
  }
  process.stdout.write(memo.value);
  return changed.length && !refresh ? 2 : 0;
}

function cmdList() {
  const store = storeDir();
  if (!existsSync(store)) {
    console.log('[memo] nothing saved');
    return 0;
  }
  const files = readdirSync(store).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) {
    console.log('[memo] nothing saved');
    return 0;
  }
  for (const f of files) {
    const memo = JSON.parse(readFileSync(join(store, f), 'utf8'));
    const changed = drift(memo);
    const age = (Date.now() / 1000 - (memo.saved_at || 0)) / 60;
    const state = changed.length ? `STALE (${changed.length} source(s) moved)` : 'FRESH';
    console.log(
      `${memo.name.padEnd(24)} ${state.padEnd(28)} ${String(Math.round(age)).padStart(6)} min  ${memo.value.length} chars`,
    );
  }
  return 0;
}

function flagValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}

function main() {
  const [action, name, ...rest] = process.argv.slice(2);
  const hook = process.argv.includes('--hook');
  try {
    if (action === 'save') {
      if (!name || !NAME_RE.test(name)) usage(`memo name must be a kebab-case slug, got: ${name || '(missing)'}`);
      process.exit(cmdSave(name, rest));
    }
    if (action === 'get') {
      if (!name) usage('get needs a memo name');
      process.exit(cmdGet(name, rest));
    }
    if (action === 'list') process.exit(cmdList());
    usage(`unknown action: ${action || '(missing)'}`);
  } catch (err) {
    if (!hook) throw err;
    // A hook miss must never break the session.
    process.exit(0);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
