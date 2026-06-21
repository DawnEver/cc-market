// sharp-review migrations (idempotent — safe to re-run; no-op once a project is current):
//   1. consolidate legacy per-finding review files into the single-file-per-day format.
//        Old: .claude/memory/YYYY-MM-DD/SR-*.md (+ optional resolved.txt)
//        New: .claude/memory/YYYY/MM/DD/sharp-review.md (frontmatter status per finding)
//   2. relocate static review config out of the gitignored runtime state
//        (.claude/.rem-state.json → reviewGate.{profileWeights,customProfiles,thresholds,
//        inlineDiffLimit,docsThreshold,codebaseIntervalMin}) into the tracked, shareable
//        .claude/sharp-review.json so it travels with the repo.

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { reviewFrontmatter, SR_ID_RE, FINDING_HDR_RE } from '../scripts/lib.mjs';

const FLAT_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Config keys that used to live under reviewGate but are static, shareable config.
const CONFIG_KEYS = ['profileWeights', 'customProfiles', 'thresholds', 'inlineDiffLimit', 'docsThreshold', 'codebaseIntervalMin'];

// Move review config from .rem-state.json → .claude/sharp-review.json. Idempotent: only the
// keys still present in reviewGate are moved, and the config file never clobbers a key it
// already has (a hand-written config wins). After moving, the keys are stripped from reviewGate.
function migrateReviewConfig(projectRoot) {
  const summary = [];
  const stateFile = join(projectRoot, '.claude', '.rem-state.json');
  if (!existsSync(stateFile)) return { changed: false, summary };

  let state;
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return { changed: false, summary }; }
  const gate = state?.reviewGate;
  if (!gate || typeof gate !== 'object') return { changed: false, summary };

  const present = CONFIG_KEYS.filter(k => gate[k] !== undefined);
  if (present.length === 0) return { changed: false, summary };

  const configFile = join(projectRoot, '.claude', 'sharp-review.json');
  let config = {};
  if (existsSync(configFile)) {
    try { config = JSON.parse(readFileSync(configFile, 'utf8')) || {}; } catch { config = {}; }
  }

  const moved = [];
  for (const k of present) {
    if (config[k] === undefined) { config[k] = gate[k]; moved.push(k); }
    delete gate[k];
  }

  mkdirSync(join(projectRoot, '.claude'), { recursive: true });
  writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', 'utf8');
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
  summary.push(`relocated review config ${JSON.stringify(present)} from .rem-state.json → .claude/sharp-review.json${moved.length < present.length ? ' (some keys already present in config, kept)' : ''}`);
  return { changed: true, summary };
}

export async function migrate(projectRoot) {
  const cfg = migrateReviewConfig(projectRoot);
  const memoryDir = join(projectRoot, '.claude', 'memory');
  const summary = [...cfg.summary];
  let changed = cfg.changed;
  if (!existsSync(memoryDir)) return { changed, summary };

  for (const entry of readdirSync(memoryDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dateMatch = entry.name.match(FLAT_DATE_RE);
    if (!dateMatch) continue;

    const oldDir = join(memoryDir, entry.name);
    const srFiles = readdirSync(oldDir)
      .filter(f => /^SR-\d{8}-\d{3}.*\.md$/.test(f))
      .sort();
    if (srFiles.length === 0) continue;

    const [, y, m, d] = dateMatch;
    const newDir = join(memoryDir, y, m, d);
    const targetFile = join(newDir, 'sharp-review.md');
    if (existsSync(targetFile)) continue; // already migrated

    let blocks = srFiles
      .map(f => readFileSync(join(oldDir, f), 'utf8').trim())
      .filter(Boolean);

    const resolvedPath = join(oldDir, 'resolved.txt');
    const resolvedIds = existsSync(resolvedPath)
      ? new Set(readFileSync(resolvedPath, 'utf8').match(SR_ID_RE) || [])
      : new Set();
    blocks = blocks.map(block => {
      if (/\*\*Status:\*\*/m.test(block)) return block;
      const hdr = block.match(FINDING_HDR_RE);
      const status = hdr && resolvedIds.has(hdr[1]) ? 'FIXED' : 'OPEN';
      return `${block}\n- **Status:** ${status}`;
    });

    const ids = new Set();
    for (const block of blocks) {
      const hdr = block.match(FINDING_HDR_RE);
      if (hdr) ids.add(hdr[1]);
    }

    const date = `${y}-${m}-${d}`;
    const content = `${reviewFrontmatter([...ids], date)}\n\n${blocks.join('\n\n')}\n`;

    mkdirSync(newDir, { recursive: true });
    writeFileSync(targetFile, content, 'utf8');

    for (const f of srFiles) rmSync(join(oldDir, f));
    if (existsSync(resolvedPath)) rmSync(resolvedPath);
    if (readdirSync(oldDir).length === 0) {
      rmSync(oldDir, { recursive: true });
    } else {
      summary.push(`WARN  .claude/memory/${entry.name}/ not empty after consolidation — review remaining files manually`);
    }

    changed = true;
    summary.push(`consolidated ${srFiles.length} finding file(s) for ${date} into .claude/memory/${y}/${m}/${d}/sharp-review.md`);
  }

  return { changed, summary };
}
