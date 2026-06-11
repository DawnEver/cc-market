---
name: stamp-memory-truncated-date-bug
description: stamp-memory.js truncated-date bug — root cause, fix, and all side effects resolved 2026-06-08
metadata:
  type: project
---

# stamp-memory.js Truncated-Date Bug — FIXED (2026-06-08)

**Root cause:** `stamp-memory.js` used `relPath.split('/')[0]` to extract the date from a memory file's relative path, which yielded only the year component (`2026`) instead of the full ISO date (`2026-06-08`). This caused all new index entries to be written with truncated labels like `[2026 deepseek-reviewer-added]`.

**Fix:** Changed the call site to `extractDateFromPath(relPath)`, which correctly matches `YYYY/MM/DD` segments and returns `YYYY-MM-DD`.

**Side effects also fixed in the same session:**
- Malformed entries (e.g. `[2026 name]`) were excluded from `existingPaths` (only well-formed entries via `parseIndexEntry` are marked indexed), so they'd be re-added as correct entries — but the old malformed line was never removed, causing duplicates on every run. Fixed: the rebuild block now uses `parseIndexEntry`/`formatIndexEntry` throughout and drops any line not matching the full ENTRY_RE pattern.
- The `headerLines` filter (`!/^-\s+\[/.test(l)`) was stripping ALL `- [` lines including the Active Tasks link. Fixed: now filters only date-structured paths (`!/\.\.\/memory\/\d{4}\/\d{2}\/\d{2}\//.test(l)`).
- `tasks/tasks.md` was being indexed as a regular memory entry. Fixed: added `if (relPath.startsWith('tasks/')) continue`.
- Two separate regex definitions (`entryPattern` + `entryRe`) duplicated the index format. Fixed: consolidated to use `parseIndexEntry`/`formatIndexEntry` from `lib.mjs` throughout.
- Misleading comment "get re-added with correct date format on next run" — actually happens in the same run. Fixed inline.

**Historical note:** The ~20 pre-existing truncated entries in `.claude/rules/MEMORY.md` (dating back to 2026-05-27) were written by the old broken script. Running the fixed `stamp-memory.js` will re-index them with correct labels on the next run that touches new files in those directories.
