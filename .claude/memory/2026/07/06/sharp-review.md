---
name: sharp-review-2026-07-06
description: Sharp review findings — 13 total
metadata:
  type: project
---

## Review 2026-07-06 (session) — docs review (文档锐评) + diff review

### Reviewer Status
- Reviewer A (Codex): OK
- Reviewer B (DeepSeek): OK
- Reviewer C (Opus): skipped

### Confirmed findings

---

### [SR-20260706-001] [HIGH] rem/skills/refresh-docs/SKILL.md — Unanchored refresh command is unusable (git_hash null)

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Document the unanchored branch: inspect the current doc_source files directly, then --set-anchor.

JSON output uses git_hash:null for freshly bound/cloned docs, but the workflow tells the user to run `git diff <git_hash>..HEAD -- <doc_source...>`, which fails when git_hash is null.

---

### [SR-20260706-002] [MEDIUM] rem/skills/refresh-docs/SKILL.md — State file path documented inconsistently/wrong

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Use `.claude/.rem-state.json` everywhere (also memory-conventions.md, rem/AGENTS.md).

Code writes anchors/roots to `.claude/.rem-state.json` via join(root,'.claude','.rem-state.json'), but several docs say `.rem-state.json` at repo root.

---

### [SR-20260706-003] [MEDIUM] rem/skills/refresh-docs/SKILL.md — --json result shape is misstated

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** State that CLI prints { "stale": [...] }; stop when stale is an empty array. Entries include path/doc_source, not reviewed_at.

Doc describes an 'empty result' rather than the actual { stale: [...] } payload shape.

---

### [SR-20260706-004] [MEDIUM] rem/skills/refresh-docs/SKILL.md — Ambiguity JSON only emitted under --json

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Tell the user to run detection with --json before expecting the {ambiguous,candidates} payload.

Code exits 2 either way, but {ambiguous:true,candidates:[...]} prints only with --json; otherwise output is prose.

---

### [SR-20260706-005] [LOW] rem/skills/rem/reference/memory-conventions.md — 'configurable' living-docs location contradicts implementation

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Change to 'Living docs (.claude/docs/, docs/, or anywhere with doc_source)'.

There is no location config; roots are a device-local discovery cache, not config.

---

### [SR-20260706-006] [LOW] .claude/docs/rem-scripts.md — Sample doc omits that git_hash is a device-local anchor

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Spell out: drift measured from device-local anchor docs.anchors[<path>].git_hash in .claude/.rem-state.json.

Given the schema confusion the system tries to avoid, the sample says drift is measured 'from git_hash' without noting it is a local anchor.

---

### [SR-20260706-007] [INFO] rem/scripts/doc-freshness.js — Source file header is stale and contradicts the code

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Update the header comment: anchors live in .claude/.rem-state.json, frontmatter carries only doc_source/thresholds.

Header still says bound docs declare git_hash/reviewed_at in tracked frontmatter, but parseDocMeta reads only doc_source/thresholds and anchors are device-local.

---

### [SR-20260706-008] [MEDIUM] rem/scripts/doc-freshness.js — Silent zero-commits fallback masks git errors and missing source paths

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Distinguish empty/NaN git output from a real 0; treat unparseable output as an error (Infinity) rather than fresh.

commitDrift uses `parseInt(out.trim(),10) || 0`; empty output (untracked path, command quirk) collapses to 0, so a doc whose source is unreachable/moved appears perpetually fresh.

---

### [SR-20260706-009] [MEDIUM] rem/scripts/doc-freshness.js — No validation that doc_source paths still exist

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Verify resolved doc_source paths exist in the working tree/history before counting drift; warn/surface when a binding dangles.

commitDrift/lineDrift pass `-- ...paths` from frontmatter with no existence check; a renamed/deleted source yields 0 drift forever, hiding stale docs.

---

### [SR-20260706-010] [MEDIUM] rem/scripts/doc-freshness.js — docs.roots cache persisted but never invalidated; renames orphan anchors

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add cache invalidation (TTL/explicit refresh) and migrate/rekey anchors on rename, or re-derive roots when discovery is cheap.

Cache persists for roots.length<=1 with no update path: new bound doc under a new root stays invisible; loadAnchor keyed by relPath means a rename orphans the anchor, resetting staleness to unanchored/HIGH.

---

### [SR-20260706-011] [MEDIUM] rem/scripts/task-lib.mjs — Ambiguous-root case re-walks whole repo on every task-list invocation

- **Category:** Performance
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Persist or memoize the discovered doc set even in the ambiguous case, or make collection targeted.

When >1 root, docs.roots is not persisted, so scanAllScopes -> scanStaleDocs -> collectBoundDocs re-reads every .md's frontmatter on each `todo`/scan; slow on large repos.

---

### [SR-20260706-012] [MEDIUM] rem/scripts/doc-freshness.js — Possible non-recursive glob for restricted roots misses nested docs

- **Category:** Bug
- **Status:** CLOSED
- **Confidence:** single-reviewer
- **Suggestion:** Confirm git pathspec behavior; if non-recursive use `${r}/**/*.md`. Note git ls-files pathspec `*` matches slashes by default, so verify first.

listMarkdownFiles builds `${r}/*.md` patterns; reviewer flags nested bound docs (e.g. .claude/docs/sub/x.md) may be skipped under a restrict cache.

---

### [SR-20260706-013] [MEDIUM] shared/lib.mjs — Brittle hand-rolled YAML parser rejects valid frontmatter

- **Category:** Bug
- **Status:** CLOSED
- **Confidence:** single-reviewer
- **Suggestion:** Handle colons in values, inline arrays with quoted commas, tab indentation, and inline comments — or document these as unsupported and validate on write.

parseFrontmatter mishandles values containing ':' (URLs), tab vs space indentation (char-count mixing), quoted commas in inline arrays, and inline comments; a valid doc then parses as unbound and is silently skipped.
