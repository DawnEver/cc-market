// sharp-review migrations (idempotent — safe to re-run; no-op once a project is current):
//   1. consolidate legacy per-finding review files into the single-file-per-day format.
//        Old: .claude/memory/YYYY-MM-DD/SR-*.md (+ optional resolved.txt)
//        New: .claude/memory/YYYY/MM/DD/sharp-review.md (frontmatter status per finding)
//   2. retire the Stop hook's state: relocate static review config still in the gitignored
//        runtime state (.claude/.rem-state.json → reviewGate.{profileWeights,customProfiles,
//        inlineDiffLimit}) into the tracked .claude/sharp-review.json, then drop the whole
//        `reviewGate` slice and the trigger-only config keys (RETIRED_CONFIG_KEYS) -- nothing
//        reads them since the plugin stopped shipping a Stop hook.
//
// Retirement: step 1 targets pre-1.1 project layouts -- safe to delete once no active project
// predates sharp-review 1.2.

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { reviewFrontmatter, SR_ID_RE, FINDING_HDR_RE } from '../scripts/lib.mjs';

const FLAT_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Static, shareable config keys that once lived under reviewGate.
const CONFIG_KEYS = ['profileWeights', 'customProfiles', 'inlineDiffLimit'];
// Config keys only the retired Stop hook read (its switch and its trigger thresholds).
export const RETIRED_CONFIG_KEYS = ['stopHook', 'thresholds', 'docsThreshold', 'codebaseIntervalMin'];

function readJSONFile(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

// Idempotent: a reviewGate config key moves only where the config file lacks it (a hand-written
// config wins); the slice and the retired keys are then deleted, so a second run finds nothing.
function retireStopHookState(projectRoot) {
  const summary = [];
  const stateFile = join(projectRoot, '.claude', '.rem-state.json');
  const configFile = join(projectRoot, '.claude', 'sharp-review.json');
  const state = readJSONFile(stateFile);
  const gate = state?.reviewGate;
  const loaded = readJSONFile(configFile);
  const config = loaded && typeof loaded === 'object' ? loaded : {};

  const present = gate && typeof gate === 'object' ? CONFIG_KEYS.filter(k => gate[k] !== undefined) : [];
  const moved = present.filter(k => config[k] === undefined);
  for (const k of moved) config[k] = gate[k];
  const retired = RETIRED_CONFIG_KEYS.filter(k => config[k] !== undefined);
  for (const k of retired) delete config[k];

  if (moved.length || retired.length) {
    mkdirSync(join(projectRoot, '.claude'), { recursive: true });
    writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', 'utf8');
  }
  if (moved.length) summary.push(`relocated review config ${JSON.stringify(moved)} from .rem-state.json → .claude/sharp-review.json`);
  if (retired.length) summary.push(`dropped retired Stop-hook config ${JSON.stringify(retired)} from .claude/sharp-review.json`);
  if (state && Object.hasOwn(state, 'reviewGate')) {
    delete state.reviewGate;
    writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
    summary.push('dropped the retired Stop hook state (reviewGate) from .claude/.rem-state.json');
  }
  return { changed: summary.length > 0, summary };
}

export async function migrate(projectRoot) {
  const cfg = retireStopHookState(projectRoot);
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
