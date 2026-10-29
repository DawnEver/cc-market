// git-manifest.mjs — run git and build the size-bounded review manifest (the I/O half of
// manifest.mjs). maxBuffer is 256 MB on every git call: the 1 MB default explodes on large diffs.
import { execFileSync } from '../../shared/spawn.mjs';
import {
  parseNumstatZ, parseNameStatusZ, buildManifest, decideManifestMode,
  renderManifestText, extractHunkHeaders, filterDiff, applyPolicy, diffBytesByPath,
} from './manifest.mjs';
import { BUILTIN_POLICY } from './ai-lab.mjs';

const MAX_BUFFER = 256 * 1024 * 1024;

function excludedSummary(excluded) {
  const byReason = new Map();
  for (const e of excluded) byReason.set(e.reason, (byReason.get(e.reason) || 0) + 1);
  const parts = [...byReason].map(([reason, n]) => `${n} ${reason}`);
  return parts.length ? `${excluded.length} files excluded: ${parts.join(', ')}` : '';
}

// -> { mode: review|agent|empty, range, path?, stats, excludedSummary, diff? | manifest? }
// *policy* (lib/ai-lab.mjs reviewPolicy) scopes what is reviewed and caps it: a file outside its code
// scope or over max_file_bytes is excluded, and a diff over max_total_bytes is listed, never inlined.
export function collectManifest(root, { range = 'HEAD', path, limit, policy = BUILTIN_POLICY }) {
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: 'pipe' });
    } catch {
      return '';
    }
  };
  const base = ['-M', range, ...(path ? ['--', path] : [])];
  const fullDiff = git(['diff', ...base]);
  const built = buildManifest(
    parseNumstatZ(git(['diff', '--numstat', '-z', ...base])),
    parseNameStatusZ(git(['diff', '--name-status', '-z', ...base])),
    extractHunkHeaders(fullDiff),
  );
  const scoped = applyPolicy(built.entries, policy, diffBytesByPath(fullDiff));
  const { entries } = scoped;
  const excluded = [...built.excluded, ...scoped.excluded];
  const filtered = filterDiff(fullDiff, new Set(excluded.map((e) => e.path)));
  const cap = policy.max_total_bytes ?? Infinity;
  const mode = decideManifestMode(entries.length, Buffer.byteLength(filtered, 'utf8') > cap ? Infinity : filtered.length, limit);
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
