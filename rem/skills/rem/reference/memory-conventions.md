# Memory Conventions (global, all projects)

## When memory is written

Two paths:

1. **Immediate (`remember.js`)** — when the user explicitly asks to remember something
   ("remember this", "记住这个"), save it right away instead of waiting for `/rem`:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/remember.js --name <kebab-slug> --type <user|feedback|project|reference> --body "<text>"
   ```
   It writes the dated memory file with valid frontmatter, creates the `_meta.json`
   entry, and upserts the index in one step. Refuses to overwrite a different-bodied
   file without `--update`. Host-agnostic (plain CLI — works on Claude Code and Codex).
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


## Three-tier loading
| Tier | When | Content | Eviction |
|---|---|---|---|
| `.claude/rules/*.md` | Always injected | Core behavioral constraints ALL agents must follow. Keep under ~10 lines. | Never (hand-curated) |
| Long-term memory (`tier: long`) | On-demand, progressive disclosure via MEMORY.md | Frequently accessed/updated memories. Promoted from short-term. | Protected while long-term; may be demoted |
| Short-term memory (`tier: short`) | On-demand, progressive disclosure via MEMORY.md | Session notes, one-off fixes, historical reference. | 90d stale eviction; feedback exempt |

**Promotion:** Each memory file tracks `count` — incremented whenever `bumpAccessed`
advances `accessed` to a new date (same-day re-touches don't count). Once `count >= 3`,
`rem-prep.js --promote` automatically sets `tier: long`. To promote manually:
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/touch-memory.js <path> --promote
```
This sets `tier: long`, protecting it from stale eviction while it remains long-term.

## Memory file format
```yaml
---
name: kebab-case-slug
description: one-line summary
metadata:
  type: user | feedback | project | reference
---
```
`metadata.type` is **nested** YAML — prune-memory.js and recall.js read it with the
structured parser (`metadata.type`); a flat dotted `metadata.type:` key is invisible
to them and silently drops the feedback exemption / recall weighting. `remember.js`
emits this nested form and YAML-quotes the `description` when it contains colons or
other metacharacters (hand-written files should do the same).
Volatile metadata (`accessed`, `count`, `tier`, `dropped`) lives in gitignored
`_meta.json` per date directory — never in frontmatter.
- `count` — number of distinct days this file was referenced; defaults to 1, auto-managed
- `tier` — `short` by default; promoted to `long` automatically once `count >= 3`, or manually via `touch-memory.js --promote`

## Event memory vs. living docs (two sibling collections)

Dated memory files are **event snapshots**: immutable, append-only, dated by creation,
decaying (90d eviction) — a record of what was learned *then*. **Living docs** are the
opposite lifecycle: mutable, refreshed in place, code-anchored, never evicted — current truth
that must track HEAD. Because their invariants are inverted (append-only is *required* for
events and *forbidden* for docs), they are separate collections, not one kind with a special
case. Living docs live **outside** the dated memory tree and are managed by `/refresh-docs` —
full spec in that skill. Summary of the split:

| | Event memory (`.claude/memory/`) | Living docs (`.claude/docs/`, `docs/`, or anywhere with `doc_source`) |
|---|---|---|
| Mutability | immutable, append-only | rewritten in place |
| Identity | date path `YYYY/MM/DD/` | topic/architecture path |
| Freshness | `accessed` recency | git drift (commits / churn / age) vs a local anchor |
| Eviction | 90d window | never (not in the pruned tree) |
| Frontmatter (tracked) | `name`/`description`/`type` | + `doc_source` (semantic binding), optional thresholds |
| Volatile home (gitignored) | `_meta.json` (`accessed`/`count`/`tier`) | `.claude/.rem-state.json` `docs.anchors` (`git_hash`/`reviewed_at`) + `docs.roots` cache |

Living docs have **no location config**: a doc's kind is its frontmatter, so bound docs are
discovered repo-wide via `git ls-files` (honoring `.gitignore`) by their `doc_source` signature
— they can live in the project's own doc system (`docs/`, etc.). The freshness anchor
(`git_hash`/`reviewed_at`) is **device-local** (`.claude/.rem-state.json`), never in the tracked doc, so
the doc stays pure and a fresh clone conservatively re-reviews. Discovery roots are cached the
same way; multiple roots ⇒ user picks. No `doc_source` docs ⇒ dormant. Staleness is commits ≥ 15
OR churn ≥ 200 lines OR age ≥ 30d (per-doc overridable).

## Full catalog and injected index
- `.claude/meta/MEMORY.full.md` is the unbounded full catalog of every non-dropped entry.
- `.claude/rules/MEMORY.md` is the injected hot view: all long-term entries plus the newest
  short-term entries up to `HOT_SHORT_MAX`, defined in `scripts/lib.mjs`. This bounds
  injection only; older active entries remain in the full catalog and available to recall.
- Both views are sorted by `accessed` newest-first, then creation date newest-first.
- Each line: `[date title](../memory/YYYY/MM/DD/slug.md) — created: ..., accessed: ...`

## Scoped memory (monorepo / multi-project)

Any directory containing its own `.claude/memory/` is an independent memory **scope**
with its own full catalog, bounded injected index, and time-based prune cycle —
e.g. each `cc-market/<plugin>/` alongside the repo root.

- `findMemoryScope()` walks up from `cwd` to the nearest ancestor (within
  `CLAUDE_PROJECT_DIR`) containing `.claude/memory/` — that's `scopeRoot` /
  `scopeMemoryDir` / `scopeIndexFile`, the scope `touch-memory.js`,
  `prune-memory.js`, and `crystallize.js` operate on by default.
- `findAllScopes()` walks the whole repo tree to find *every* `.claude/memory/`
  directory — used by `rem-prep.js` to locate a touched file regardless of which
  scope it lives in.
- The root `MEMORY.md` `## Scoped` section is auto-generated by `rebuildIndex()` from
  child scopes discovered on disk — do not hand-edit.
- When adding a new sub-project with its own `.claude/memory/`, it will be picked up
  automatically on the next index rebuild.
- `/rem` always operates on the scope for the **current working directory** — if you
  modified files in another scope this session, run prune/rem-prep/stamp for that
  scope too (see "Cross-project check" in SKILL.md).

## Eviction

**Short-term (`tier: short`):**
- With `--evict-stale`, entries last accessed more than 90 days ago are tombstoned
  out of the catalog/index; `feedback`-type entries are exempt.
- There is no count-based eviction. Falling outside the injected hot view does not
  drop an entry from the full catalog or make it unavailable to recall.
- **Never delete `.claude/memory/` files** — stale eviction changes metadata and indexes only

**Long-term (`tier: long`):**
- Entries inactive since the previous prune day may be demoted to `tier: short`.
- Demotion resets `count`, not `accessed`: an already-stale demoted entry can be
  evicted in the same cycle unless exempt. There is no extra grace period on demotion.
- Promoted back via `touch-memory.js --promote` when accessed again

**Never shrink, only merge** (user ruling 2026-09-27: memory keeps everything):
- Duplicates on one topic → `merge-memory.js --into <live> --from <dups>`: the live entry gains every
  source line verbatim plus a `merged_from:` list; sources leave the index only as `merged→<live>`.
- A correction is APPENDED under a dated heading; the original text, numbers and quotes stay.
- Content distilled into `.claude/rules/` leaves the index, but its memory file is kept unchanged.

## Rules vs Memory boundary
- **Rule** = what the model MUST do every session. Short, actionable.
- **Memory** = why, what happened, known bugs. Load on demand.
- Pointer pattern: `→ see .claude/memory/YYYY/MM/DD/slug.md`
