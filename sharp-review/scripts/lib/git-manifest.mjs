// git-manifest.mjs — run git and build the size-bounded review manifest (the I/O half of
// manifest.mjs). maxBuffer is 256 MB on every git call: the 1 MB default explodes on large diffs.
import { execFileSync } from '../../shared/spawn.mjs';
import {
  parseNumstatZ, parseNameStatusZ, buildManifest, decideManifestMode,
  renderManifestText, extractHunkHeaders, filterDiff,
} from './manifest.mjs';

const MAX_BUFFER = 256 * 1024 * 1024;

function excludedSummary(excluded) {
  const byReason = new Map();
  for (const e of excluded) byReason.set(e.reason, (byReason.get(e.reason) || 0) + 1);
  const parts = [...byReason].map(([reason, n]) => `${n} ${reason}`);
  return parts.length ? `${excluded.length} files excluded: ${parts.join(', ')}` : '';
}

// -> { mode: review|agent|empty, range, path?, stats, excludedSummary, diff? | manifest? }
export function collectManifest(root, { range = 'HEAD', path, limit }) {
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: 'pipe' });
    } catch {
      return '';
    }
  };
  const base = ['-M', range, ...(path ? ['--', path] : [])];
  const fullDiff = git(['diff', ...base]);
  const { entries, excluded } = buildManifest(
    parseNumstatZ(git(['diff', '--numstat', '-z', ...base])),
    parseNameStatusZ(git(['diff', '--name-status', '-z', ...base])),
    extractHunkHeaders(fullDiff),
  );
  const filtered = filterDiff(fullDiff, new Set(excluded.map((e) => e.path)));
  const mode = decideManifestMode(entries.length, filtered.length, limit);
  const result = {
    mode,
    range,
    stats: {
      files: entries.length,
      insertions: entries.reduce((s, e) => s + e.added, 0),
      deletions: entries.reduce((s, e) => s + e.deleted, 0),
      excluded: excluded.length,
      diffChars: filtered.length,
    },
    excludedSummary: excludedSummary(excluded),
  };
  if (path) result.path = path;
  if (mode === 'review') result.diff = filtered;
  if (mode === 'agent') result.manifest = renderManifestText(entries, { range, subPath: path });
  return result;
}
