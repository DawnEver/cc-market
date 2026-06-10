// sharp-review migration: consolidate legacy per-finding review files into the
// current single-file-per-day format. Idempotent — safe to re-run; no-op once
// a project is current.
//
// Old format: .claude/memory/YYYY-MM-DD/SR-*.md (one file per finding) +
//             optional .claude/memory/YYYY-MM-DD/resolved.txt
// New format: .claude/memory/YYYY/MM/DD/sharp-review.md (single file, frontmatter
//             `status: OPEN|FIXED` per finding instead of resolved.txt)

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { reviewFrontmatter, SR_ID_RE, FINDING_HDR_RE } from '../lib.mjs';

const FLAT_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export async function migrate(projectRoot) {
  const memoryDir = join(projectRoot, '.claude', 'memory');
  const summary = [];
  let changed = false;
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
