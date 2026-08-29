# Step 04 — PDF decomposition (on-demand, cached)

按需分解 PDF → 结构化 markdown。已分解的论文自动跳过（缓存复用）。

## Core principle

**User picks which papers → Already-decomposed skipped → Rest run in batch.**

## Steps

1. **Check what's pending** (dry run):
   ```bash
   uv run --project "<plugin-root>" lit-review ingest --topic <slug> --dry-run
   ```
   Shows: X pending, Y already cached.

2. **Present choices** to user:
   - Papers not yet decomposed: list with titles
   - Already cached: count only
   - User picks: "all", specific IDs, or "none for now"

3. **Decompose selected**:
   ```bash
   uv run --project "<plugin-root>" lit-review ingest --topic <slug> --paper <id1> --paper <id2> ...
   ```
   Without `--paper`, decomposes all pending. Cache is always respected.

4. **Report**: succeeded, failed, skipped. Enter options menu.

## Resume

Re-running `uv run --project "<plugin-root>" lit-review ingest --topic <slug> --dry-run` always shows current cache status. Already-decomposed papers are never reprocessed.
