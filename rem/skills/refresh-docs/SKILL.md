---
name: refresh-docs
description: Refresh stale bound docs whose code has drifted, preserving human annotations. Also creates/binds new docs.
---

# Refresh Docs

Commit-anchored freshness for **living docs** — a collection distinct from dated event memory.
Event memory is immutable/append-only/decaying; living docs are mutable, code-anchored, and
never evicted. Kept out of the memory tree, so refresh-in-place has no append-only invariant to
fight and prune never touches them.

A **bound doc** declares in its frontmatter *only the semantic binding* — what code it documents
(+ optional thresholds). The volatile "last validated at commit X" **anchor is NOT in the doc**:
it lives device-locally in `.claude/.rem-state.json` (gitignored), so the tracked doc stays pure and a
teammate/fresh clone conservatively re-reviews rather than trusting your local anchor.

```yaml
---
name: setup-architecture
description: how the setup pipeline works
metadata:
  type: reference
  doc_source: [scripts/setup/, claude_settings.template.json]  # subtrees this doc covers
  # optional per-doc threshold overrides: stale_commits / stale_days / stale_lines
---
```

## Location & discovery (no config)

A doc's *kind* is decided by its frontmatter, not its path — so bound docs are **discovered**,
not configured. `doc-freshness.js` lists `.md` files via `git ls-files` (honoring `.gitignore`
for free) and keeps those with `doc_source`. So a doc plugs into the project's own doc system
(`docs/` for mkdocs/Sphinx/Jekyll — they already use YAML frontmatter, so our fields coexist)
just by living there with `doc_source` — zero config.

- **Enablement implied by data:** no `doc_source` docs ⇒ nothing found, zero cost. No flag.
- **Thresholds (OR):** a doc is stale if commits ≥ `stale_commits` (default 15) OR churn
  (insertions+deletions) ≥ `stale_lines` (default 200) OR age ≥ `stale_days` (default 30).
  Churn is the most meaningful signal — many tiny commits ≠ real change. Override *per doc* in
  frontmatter, co-located with what it governs; no global config file.
- **Device-local state in `.claude/.rem-state.json`** (gitignored): discovered doc `roots` (a
  cache so the repo isn't re-walked) and per-doc `anchors` (`{git_hash, reviewed_at}`). Both are
  local — the frontmatter signatures stay the source of truth. After adding a bound doc under a
  *new* root (a cached single root won't see it), bust the cache: `doc-freshness.js --rediscover`.
- **Unanchored = stale:** a doc with no local anchor (fresh clone, or newly bound) reads as
  ∞-stale with `git_hash: null` until first reviewed — establish its baseline with `--set-anchor`.
- **Dangling binding:** if a `doc_source` path no longer exists (rename/typo), the doc is flagged
  stale with `dangling: [...]` rather than reading silently fresh — fix the binding.
- **Ambiguous location:** if bound docs are found under multiple roots and none is cached yet,
  `doc-freshness.js` exits 2 with `{ambiguous:true, candidates:[...]}`. **Ask the user** which
  root(s) to track (`AskUserQuestion`), then persist the choice:
  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/scripts/doc-freshness.js --set-roots <a,b>
  ```

## Process

1. **Detect drift:**
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/doc-freshness.js --json
   ```
   Prints `{ "stale": [ { path, doc_source, git_hash, commits, lines, days, dangling? } ] }`.
   Stop when `stale` is `[]`. (Exit 2 with `{ "ambiguous": true, "candidates": [...] }` under
   `--json` means multiple doc roots — resolve that first, see Location above.)

2. **For each stale doc**, gather only the increment — never re-read the whole codebase:
   ```bash
   git diff <git_hash>..HEAD -- <doc_source...>
   ```
   - If `git_hash` is `null` (unanchored / fresh clone) there is no range to diff — instead read
     the `doc_source` files directly to (re)establish what the doc should say.
   - If `dangling` is set, the binding is broken: fix the `doc_source` paths (or the code moved)
     before anchoring.

3. **Incrementally rewrite** the doc file in place (never relocate it — its path is its stable
   identity):
   - Change **only** the sections the diff touches. Leave everything else byte-identical.
   - **Never edit inside `<!-- rem:manual -->` … `<!-- /rem:manual -->` blocks** — these are
     human annotations. Preserve them verbatim, including position.
   - Keep the doc's structure, headings, and voice.

4. **Re-anchor** (device-local, not the frontmatter) to HEAD + today:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/doc-freshness.js --set-anchor <relPath>
   ```

## Binding a new doc

To turn a doc into a bound doc: add `doc_source` (+ optional thresholds) to its frontmatter,
then set its baseline anchor so it doesn't immediately read stale:
`doc-freshness.js --set-anchor <relPath>`.

## Architecture doc-sets (complex projects)

A doc-set = one index doc (`type: reference`) + chapter docs, **each chapter binding a distinct
`doc_source` subtree**. Freshness is per-chapter — only chapters whose subtree changed get
flagged and refreshed. The directory tree is the table of contents; the index doc only changes
when chapters are added or removed.

## Constraints

- **Minimal change** — the diff drives edits; do not rewrite untouched prose.
- **Preserve `<!-- rem:manual -->` blocks** exactly.
- **Refresh in place** — same file path; only touched sections change (the anchor is external).
- Stale docs surface in `/todo` as virtual `DOC-<path>` rows; they clear automatically once the
  anchor advances — there is no mark/remove step.
- Multi-round refresh: if refreshing many docs in one turn without background tasks, set
  `taskActiveUntil` so the Stop hook doesn't fire mid-run.
