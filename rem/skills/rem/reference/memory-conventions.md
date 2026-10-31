# Memory Conventions (global, all projects)

## When memory is written

Two paths:

1. **Immediate (`remember.js`)** — when the user explicitly asks to remember something
   ("remember this", "记住这个"), save it right away instead of waiting for `/rem`:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/remember.js --name <kebab-slug> --type <user|feedback|project|reference> --body "<text>"
   ```
   It writes a NEW dated entry with valid frontmatter and regenerates the index. An entry is
   written once: a different body under an existing name is refused. To correct or restate an
   older entry, write a new one with `--corrects <path>` or `--supersedes <path>`.
   Host-agnostic (plain CLI).
2. **Session consolidation (`/rem`)** — everything learned during a session that the user
   didn't explicitly ask to keep. See `standard-procedure.md`.

## Per-type save constraints

- **`user`** — facts about the user: preferences, role, environment, workflow habits.
- **`feedback`** — ONLY for behaviors the user explicitly corrected or confirmed
  (e.g. "don't do X", "always do Y"). Never infer feedback from silence or from a
  single unconfirmed guess. Record: the rule, **why** the user wants it, and
  **how to apply** it in future sessions.
- **`project`** — project context that is NOT derivable from reading the code:
  deadlines, stakeholder decisions, external constraints, why an approach was chosen.
  Anything a `grep` of the repo would reveal does not belong here.
- **`reference`** — pointers to external systems/entry points: dashboards, issue
  trackers, docs sites, credentials locations — where to look, not what it says.

## Rules and memory: one lifecycle each

| Layer | When read | Content | Changes |
|---|---|---|---|
| `.claude/rules/*.md` | Every turn | Constraints every session must follow. Short; cites the memory entry of its incident. | Revised; the user approves |
| Memory (`.claude/memory/YYYY/MM/DD/*.md`) | On demand: the derived index and prompt-time recall | Why: what happened, was measured, was decided | Written once; never edited, never deleted |

The tree is the only source of truth. Nothing records reads: recall and the index derive
from the files, so reading memory never writes. **No memory entry is ever deleted, and no
entry is ever edited.** All provenance is written by the NEWER entry, and visibility is
DERIVED from it: a hidden entry leaves recall and the index while its file stays forever,
reachable by provenance.

## Memory file format
```yaml
---
name: kebab-case-slug
description: one-line summary
supersedes:            # optional — written by the newer entry only
  - YYYY/MM/DD/old.md
metadata:
  type: user | feedback | project | reference
---
```
`metadata.type` is **nested** YAML — the index and recall.js read it with the
structured parser (`metadata.type`); a flat dotted `metadata.type:` key is invisible
to them and silently drops the recall weighting. `remember.js` emits this nested form and
YAML-quotes the `description` when it contains colons or other metacharacters.

Provenance fields (inline comma list or YAML block list of `YYYY/MM/DD/slug.md` in the same
scope), each written only by the newer entry:

| Field | Meaning | The named entry |
|---|---|---|
| `merged_from:` | its content was folded into this entry | hidden |
| `supersedes:` | this entry restates the current truth | hidden |
| `corrects:` | this entry corrects part of it | stays visible, flagged "corrected by"; recall injects the correction with it |

No other bookkeeping exists — nothing reads an `accessed`, `count`, `tier` or `dropped` field
or a `_meta.json` file.

## Event memory vs. living docs (two sibling collections)

Dated memory files are **event snapshots**: written once, dated by creation, hidden (never
deleted) by a successor that names them — a record of what was learned *then*. **Living docs**
are the opposite lifecycle: mutable, refreshed in place, code-anchored — current truth that
must track HEAD. A memory that describes how something works NOW belongs in a doc. Because
their invariants are inverted, they are separate collections. Living docs live **outside**
the dated memory tree and are managed by `/refresh-docs` — full spec in that skill:

| | Event memory (`.claude/memory/`) | Living docs (`.claude/docs/`, `docs/`, or anywhere with `doc_source`) |
|---|---|---|
| Mutability | written once; a newer entry corrects or supersedes it | rewritten in place |
| Identity | date path `YYYY/MM/DD/` | topic/architecture path |
| Freshness | path date | git drift (commits / churn / age) vs a local anchor |
| Leaves recall | named in a newer `merged_from`/`supersedes` (file kept) | never |
| Frontmatter (tracked) | `name`/`description`/`type` + provenance | + `doc_source` (semantic binding), optional thresholds |
| Volatile home (gitignored) | none | `.claude/.rem-state.json` `docs.anchors` (`git_hash`/`reviewed_at`) + `docs.roots` cache |

Living docs have **no location config**: a doc's kind is its frontmatter, so bound docs are
discovered repo-wide via `git ls-files` (honoring `.gitignore`) by their `doc_source` signature
— they can live in the project's own doc system (`docs/`, etc.). The freshness anchor
(`git_hash`/`reviewed_at`) is **device-local** (`.claude/.rem-state.json`), never in the tracked doc, so
the doc stays pure and a fresh clone conservatively re-reviews. Discovery roots are cached the
same way; multiple roots ⇒ user picks. No `doc_source` docs ⇒ dormant. Staleness is commits ≥ 15
OR churn ≥ 200 lines OR age ≥ 30d (per-doc overridable).

## The derived index

- `<scope>/.claude/memory-index.md` is DERIVED by `rebuildIndex()` (`scripts/lib.mjs`): every
  visible entry, newest first, then by path. It lives outside `.claude/rules/` (nothing
  generated loads as a rule) and is read on demand — `index-memory.js --print` computes it
  without writing.
- Deterministic: POSIX paths, byte-order sorting, no machine path and no read date, CRLF and
  LF checkouts alike — two machines deriving the same tree write the same bytes. It is written
  only when its bytes change, so concurrent sessions never contend on it; it is gitignored
  (every new entry would otherwise be a merge conflict).
- Each line: `- [YYYY-MM-DD name](memory/YYYY/MM/DD/slug.md) — description`, plus
  ` (corrected by memory/…)` for a corrected entry.
- Writers (`remember.js`, `merge-memory.js`, `crystallize.js`, `scope-split.js`) and
  `index-memory.js` regenerate it; no hook does. Recall reads the tree, never the index.

## Scoped memory (monorepo / multi-project)

Any directory containing its own `.claude/memory/` is an independent memory **scope**
with its own derived index — e.g. each `cc-market/<plugin>/` alongside the repo root.

- `findMemoryScope()` walks up from `cwd` to the nearest ancestor (within
  `CLAUDE_PROJECT_DIR`) containing `.claude/memory/` — that's `scopeRoot` /
  `scopeMemoryDir`, the scope `remember.js` and `crystallize.js` operate on by default.
- `findAllScopes()` walks the whole repo tree to find *every* `.claude/memory/`
  directory — `index-memory.js` and `rem-prep.js` cover them all.
- The index's `## Scoped` section links each child scope's index; it is derived from the
  scopes on disk.
- `/rem` always operates on the scope for the **current working directory** — if you
  modified files in another scope this session, run rem-prep for that scope too
  (see "Cross-project check" in SKILL.md).

## Convergence

Nothing ages out on a timer, nothing is deleted, nothing is shrunk, nothing is edited. A
newer entry names the older ones:
- **Correct** — part of an entry turned out wrong: `remember.js --corrects <path>`. The old
  entry stays visible and is flagged; recall injects the correction alongside it.
- **Supersede** — the current truth replaces an entry: `remember.js --supersedes <path>`.
- **Merge** — duplicates on one topic: `merge-memory.js --name <slug> --from <a.md,b.md>`
  writes a new entry with every source line verbatim and names the sources in `merged_from:`.
- **Crystallize** — a fact every session needs becomes a rule:
  `crystallize.js --execute --rule <file> --distilled <paths>` writes a ledger entry that
  points at the rule and names the distilled entries in `supersedes:`.

## Rules vs Memory boundary
- **Rule** = what the model MUST do every session. Short, actionable; it cites the memory
  entry of its incident and never retells it.
- **Memory** = why, what happened, known bugs. Load on demand.
- Pointer pattern: `→ see .claude/memory/YYYY/MM/DD/slug.md`
