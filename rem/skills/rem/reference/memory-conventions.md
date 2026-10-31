# Memory Conventions (global, all projects)

## When memory is written

Two paths:

1. **Immediate (`remember.js`)** — when the user explicitly asks to remember something
   ("remember this", "记住这个"), save it right away instead of waiting for `/rem`:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/remember.js --name <kebab-slug> --type <user|feedback|project|reference> --body "<text>"
   ```
   It writes the dated memory file with valid frontmatter and regenerates the index.
   A same-day file with a different body is refused without `--update`, which appends the
   revision under a dated heading (never drops text). Host-agnostic (plain CLI).
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


## Two tiers and one lifecycle
| Tier | When | Content | Leaves when |
|---|---|---|---|
| `.claude/rules/*.md` | Always injected | Constraints every session must follow. Short. | Hand-curated |
| Memory (`.claude/memory/YYYY/MM/DD/*.md`) | Index (newest + user/feedback) and prompt-time recall over every visible entry | Why, what happened, measurements | Never deleted; hidden once a newer entry names it in `merged_from:` |

The tree is the only source of truth. Nothing records reads: recall and the index derive
from the files, so reading memory never writes. **No memory entry is ever deleted.** A
memory converges by one move — a newer entry (or a crystallize ledger) names older ones in
`merged_from:` — and visibility is DERIVED from that: a named entry leaves recall and the
index while its file stays forever, reachable by provenance.

## Memory file format
```yaml
---
name: kebab-case-slug
description: one-line summary
metadata:
  type: user | feedback | project | reference
---
```
`metadata.type` is **nested** YAML — the index and recall.js read it with the
structured parser (`metadata.type`); a flat dotted `metadata.type:` key is invisible
to them and silently drops the always-indexed status / recall weighting. `remember.js`
emits this nested form and YAML-quotes the `description` when it contains colons or
other metacharacters (hand-written files should do the same).
Optional `merged_from:` (inline comma list or YAML block list of `YYYY/MM/DD/slug.md`) names the
entries this one carries forward; they become hidden. No other bookkeeping exists — nothing
reads an `accessed`, `count`, `tier` or `dropped` field or a `_meta.json` file.

## Event memory vs. living docs (two sibling collections)

Dated memory files are **event snapshots**: written once, dated by creation, hidden (never
deleted) by a successor that names them — a record of what was learned *then*. **Living docs** are the
opposite lifecycle: mutable, refreshed in place, code-anchored, never evicted — current truth
that must track HEAD. Because their invariants are inverted (append-only is *required* for
events and *forbidden* for docs), they are separate collections, not one kind with a special
case. Living docs live **outside** the dated memory tree and are managed by `/refresh-docs` —
full spec in that skill. Summary of the split:

| | Event memory (`.claude/memory/`) | Living docs (`.claude/docs/`, `docs/`, or anywhere with `doc_source`) |
|---|---|---|
| Mutability | written once; superseded by a newer entry | rewritten in place |
| Identity | date path `YYYY/MM/DD/` | topic/architecture path |
| Freshness | path date | git drift (commits / churn / age) vs a local anchor |
| Leaves recall | named in a newer `merged_from` (file kept) | never |
| Frontmatter (tracked) | `name`/`description`/`type` | + `doc_source` (semantic binding), optional thresholds |
| Volatile home (gitignored) | none | `.claude/.rem-state.json` `docs.anchors` (`git_hash`/`reviewed_at`) + `docs.roots` cache |

Living docs have **no location config**: a doc's kind is its frontmatter, so bound docs are
discovered repo-wide via `git ls-files` (honoring `.gitignore`) by their `doc_source` signature
— they can live in the project's own doc system (`docs/`, etc.). The freshness anchor
(`git_hash`/`reviewed_at`) is **device-local** (`.claude/.rem-state.json`), never in the tracked doc, so
the doc stays pure and a fresh clone conservatively re-reviews. Discovery roots are cached the
same way; multiple roots ⇒ user picks. No `doc_source` docs ⇒ dormant. Staleness is commits ≥ 15
OR churn ≥ 200 lines OR age ≥ 30d (per-doc overridable).

## The derived index
- `.claude/rules/MEMORY.md` is generated by `rebuildIndex()` (`scripts/lib.mjs`) from the tree:
  every live `user`/`feedback` entry plus the newest `HOT_MAX` live entries, newest first.
  Gitignored, never hand-edited, never committed.
- It is a pure function of the tree and written only when its bytes change, so concurrent
  sessions and worktrees never contend on it. Writers (`remember.js`, `merge-memory.js`,
  `crystallize.js`, `scope-split.js`) and `index-memory.js` regenerate it; no session-start
  hook touches it.
- Each line: `- [YYYY-MM-DD name](../memory/YYYY/MM/DD/slug.md) — description`.
- Recall searches every live entry, so the index bounds injection, not findability.

## Scoped memory (monorepo / multi-project)

Any directory containing its own `.claude/memory/` is an independent memory **scope**
with its own derived index —
e.g. each `cc-market/<plugin>/` alongside the repo root.

- `findMemoryScope()` walks up from `cwd` to the nearest ancestor (within
  `CLAUDE_PROJECT_DIR`) containing `.claude/memory/` — that's `scopeRoot` /
  `scopeMemoryDir` / `scopeIndexFile`, the scope `remember.js` and `crystallize.js`
  operate on by default.
- `findAllScopes()` walks the whole repo tree to find *every* `.claude/memory/`
  directory — `index-memory.js` and `rem-prep.js` cover them all.
- The root `MEMORY.md` `## Scoped` section is auto-generated by `rebuildIndex()` from
  child scopes discovered on disk — do not hand-edit.
- When adding a new sub-project with its own `.claude/memory/`, it will be picked up
  automatically on the next index rebuild.
- `/rem` always operates on the scope for the **current working directory** — if you
  modified files in another scope this session, run rem-prep for that scope too
  (see "Cross-project check" in SKILL.md).

## Convergence

Nothing ages out on a timer, nothing is deleted, and nothing is shrunk. An entry leaves
recall and the index only when its content has a newer home that names it in `merged_from:`:
- **Merge** — duplicates on one topic: `merge-memory.js --into <live> --from <dups>` copies
  every source line verbatim into the live entry and names the sources; the source files stay.
- **Crystallize** — a fact every session needs becomes a rule:
  `crystallize.js --execute --rule <file> --distilled <paths>` writes a ledger entry that
  points at the rule and names the distilled entries; their files stay.

## Rules vs Memory boundary
- **Rule** = what the model MUST do every session. Short, actionable.
- **Memory** = why, what happened, known bugs. Load on demand.
- Pointer pattern: `→ see .claude/memory/YYYY/MM/DD/slug.md`
