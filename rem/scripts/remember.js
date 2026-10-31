#!/usr/bin/env node
// Immediate-save CLI for explicit "remember this" requests — host-agnostic
// (works on Claude Code and Codex alike, since it's just a CLI the agent runs).
//
//   node remember.js --name <kebab-slug> --type <user|feedback|project|reference>
//                    --body <text> [--scope <dir|auto>] [--description <text>]
//                    [--corrects <paths>] [--supersedes <paths>]
//   (body may also be piped on stdin instead of --body; <paths> is a comma list of
//    YYYY/MM/DD/<slug>.md entries of the same scope)
//
// Writes a NEW .claude/memory/YYYY/MM/DD/<slug>.md and regenerates the derived index.
// An entry is written once and never edited: a correction or a restatement is a new
// entry that names the old one (`corrects:` keeps it visible and flags it,
// `supersedes:` hides it). An identical re-run is a no-op; a different body under an
// existing name is refused. Prints the created file path.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import {
  findMemoryScope, rebuildIndex, isInsideDir, dateToPath, listEntries, formatRefs,
} from './lib.mjs';

const TYPES = new Set(['user', 'feedback', 'project', 'reference']);
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const VOLATILE_RE = /^(accessed|count|tier|dropped)\s*:/m;

// YAML-safe scalar for frontmatter values that come from free text: emit plain
// only for a conservative safe alphabet, otherwise double-quote via
// JSON.stringify (a JSON string is a valid YAML double-quoted scalar).
const PLAIN_SAFE_RE = /^[\w][\w ./()+-]*$/u;
function yamlScalar(s) {
  return PLAIN_SAFE_RE.test(s) ? s : JSON.stringify(s);
}

function usage(msg) {
  if (msg) console.error(`[remember] ${msg}`);
  console.error('Usage: node remember.js --name <kebab-slug> --type <user|feedback|project|reference> --body <text> [--scope <dir|auto>] [--description <text>] [--corrects <paths>] [--supersedes <paths>]');
  process.exit(1);
}

// ── Args ──
const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}
const list = flag => (argValue(flag) || '').split(',').map(s => s.trim()).filter(Boolean);
const name = argValue('--name');
const type = argValue('--type');
const scopeArg = argValue('--scope') || 'auto';
const description = argValue('--description');
const refs = { corrects: list('--corrects'), supersedes: list('--supersedes') };
let body = argValue('--body');

if (args.includes('--update')) usage('--update is gone: an entry is never edited — write a new entry with --corrects or --supersedes');
if (!name || !NAME_RE.test(name)) usage(`--name must be a kebab-case slug, got: ${name || '(missing)'}`);
if (!type || !TYPES.has(type)) usage(`--type must be one of ${[...TYPES].join('|')}, got: ${type || '(missing)'}`);

if (body === null && !process.stdin.isTTY) {
  body = readFileSync(0, 'utf8');
}
if (!body || !body.trim()) usage('--body is required (or pipe body on stdin)');
body = body.trim() + '\n';

// Access bookkeeping never belongs in an entry: reading leaves no trace.
if (VOLATILE_RE.test(body)) {
  usage('body contains a volatile metadata field (accessed|count|tier|dropped) — an entry carries no access bookkeeping');
}

// ── Scope & path security ──
const scopeRoot = scopeArg === 'auto' ? findMemoryScope() : resolve(scopeArg);
const memDir = join(scopeRoot, '.claude', 'memory');
const relPath = `${dateToPath()}/${name}.md`;
const file = resolve(memDir, relPath);
if (!isInsideDir(memDir, file)) {
  console.error(`[remember] path traversal denied: ${relPath}`);
  process.exit(1);
}

// ── Provenance targets must be entries of this scope ──
const known = new Set(listEntries(scopeRoot).map(e => e.path));
for (const p of [...refs.corrects, ...refs.supersedes]) {
  if (!known.has(p)) usage(`${p} is not an entry of ${memDir}`);
}

// ── Content ──
if (description && /[\r\n]/.test(description)) {
  usage('--description must be a single line (no newlines)');
}
const desc = description
  || body.split('\n').map(l => l.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim())
    .find(l => l.length > 0)?.slice(0, 80)
  || name;
// metadata.type is nested YAML — recall and the index read it as metadata.type;
// a flat dotted key would be invisible to them (feedback would lose its weight).
const content = `---\nname: ${name}\ndescription: ${yamlScalar(desc)}\n`
  + formatRefs(refs)
  + `metadata:\n  type: ${type}\n---\n\n${body}`;

// ── Written once ──
if (existsSync(file)) {
  if (readFileSync(file, 'utf8') === content) { console.log(file); process.exit(0); }
  console.error(`[remember] ${relPath} exists with different content — an entry is never edited.`);
  console.error('[remember] write a new entry under another --name, with --corrects or --supersedes naming this one');
  process.exit(1);
}

mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, content, 'utf8');
rebuildIndex(scopeRoot);
console.log(file);
