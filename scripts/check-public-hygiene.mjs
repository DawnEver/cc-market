#!/usr/bin/env node
// Public-hygiene guard: this repo is published, so no tracked file may carry machine-local
// or personal data. Generic patterns are built in; host-specific names come from the
// optional machine-local denylist ~/.claude/private-markers (one case-insensitive literal
// or /regex/ per line, # comments; silent if absent; never committed).
//
//   node scripts/check-public-hygiene.mjs            # scan every tracked file
//   node scripts/check-public-hygiene.mjs --staged   # scan staged files only (pre-commit)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Neutral fixture domains (RFC 2606/6761) and publisher role mailboxes are not personal data.
const ALLOWED_EMAIL = /@(?:[\w-]+\.)*(?:example\.(?:com|org|net|edu)|users\.noreply\.github\.com|[\w-]+\.(?:example|test|invalid|localhost))$/i;
const ROLE_MAILBOX = /^(?:permissions|journalpermissions|reprints|support|onlinelibrary|no-?reply)@/i;

export const GENERIC_RULES = [
  // Absolute home paths that name a real user (placeholders like <user>, $USER, ~ are fine).
  // Single-letter names (/home/u, C:/Users/x) are fixture placeholders.
  { name: 'windows-home-path', re: /\b[A-Za-z]:[\\/]+Users[\\/]+(?![<$%{*.]|[A-Za-z]\b|USERNAME\b|user\b|you\b|name\b|Public\b|Default\b)[A-Za-z0-9._-]+/g },
  { name: 'unix-home-path', re: /(?<![\w.~])\/(?:Users|home)\/(?![<$%{*.]|[A-Za-z]\b|user\b|you\b|runner\b|name\b|me\b|alice\b|bob\b|USER\b)[A-Za-z0-9._-]+/g },
  { name: 'telegram-chat-id', re: /-100\d{9,}/g },
  { name: 'onedrive-org', re: /OneDrive - (?!<)[A-Za-z]/g },
  { name: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, allow: (m) => ALLOWED_EMAIL.test(m) || ROLE_MAILBOX.test(m) },
];

export function parseMarkers(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^\/(.+)\/([a-z]*)$/.exec(line);
    const re = m
      ? new RegExp(m[1], [...new Set(`${m[2]}gi`)].join(''))
      : new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    rules.push({ name: 'private-marker', re, marker: line });
  }
  return rules;
}

export function loadMarkers(file = join(homedir(), '.claude', 'private-markers')) {
  return existsSync(file) ? parseMarkers(readFileSync(file, 'utf8')) : [];
}

// Manifest author attribution is deliberate public attribution.
// Only the name lines are exempt — a personal email in a manifest is still a hit.
const isManifest = (path) => /(^|\/)(package\.json|pyproject\.toml|\.claude-plugin\/[^/]+\.json|\.codex-plugin\/[^/]+\.json)$/.test(path);
const isAttribution = (line) => /^\s*("(name|developerName)"\s*:|authors\s*=)/.test(line) && !/@/.test(line);

export function scanText(text, path = '', rules = GENERIC_RULES) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (isManifest(path) && isAttribution(line)) return;
    for (const rule of rules) {
      for (const m of line.matchAll(new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g'))) {
        if (rule.allow?.(m[0])) continue;
        hits.push({ path, line: i + 1, rule: rule.marker ? `${rule.name} ${rule.marker}` : rule.name, match: m[0] });
      }
    }
  });
  return hits;
}

export function scanRepo(root, { staged = false, rules = [...GENERIC_RULES, ...loadMarkers()] } = {}) {
  const args = staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'] : ['ls-files', '-z'];
  const files = execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const hits = [];
  for (const f of files) {
    const abs = join(root, f);
    if (!existsSync(abs)) continue;
    const buf = readFileSync(abs);
    if (buf.includes(0)) continue; // binary
    hits.push(...scanText(buf.toString('utf8'), f, rules));
  }
  return hits;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const root = resolve(fileURLToPath(import.meta.url), '..', '..');
  const hits = scanRepo(root, { staged: process.argv.includes('--staged') });
  for (const h of hits) console.log(`${h.path}:${h.line}: [${h.rule}] ${h.match}`);
  if (hits.length) {
    console.error(`public-hygiene: ${hits.length} hit(s) — replace with placeholders (<machine>, <user>, ~/..., user@example.com).`);
    process.exit(1);
  }
}
