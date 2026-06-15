# evolve

> *Join the glorious evolution — 加入光荣的进化吧！*

An iterative, test-driven **review→fix loop** skill. Each round drives the codebase closer
to a clean state:

1. **Critique (锐评)** the architecture and diff → an OPEN findings list.
2. **Fan out subagents** to fix findings in parallel over disjoint file sets.
3. **Review the un-fixed** and judge *why* each was left (false-positive / intentional /
   out-of-scope / needs-architecture-decision).
4. **Gate hard calls to the human** — architectural changes, won't-fix decisions, or tests
   that can't be made to pass.
5. **Keep tests green** before committing.
6. **Commit** (scoped to only the files this round changed) once every task in the round is
   resolved, then start the next round.

## Usage

```
/evolve [--until=clean|resolved|ask]
```

- `ask` (**default**) — ask before each next round.
- `clean` — loop until ≥2 consecutive rounds surface no new HIGH/MEDIUM findings.
- `resolved` — loop until all OPEN findings are resolved.

Extra flags: `--path`, `--min-severity`, `--dry-run`, `--seed`, `--commit=round|group`.

Claude-driven (not a background workflow) so human gates and commits work; portable and
self-contained (runs in any git repo), and integrates with cc-market's `sharp-review` / `todo`
/ rem state when present, with built-in fallbacks otherwise.

A real `scripts/evolve.mjs` helper now backs state, finding-grouping, and termination — no
hand-edited JSON. Convergence is **severity-based** (`checkTermination`): only HIGH/MEDIUM
findings, quorum-filtered across reviewers (`confirmedByQuorum`), block convergence — so the
loop settles instead of churning on minor nits. Safety caps bound runaway loops.

**Full spec lives in the skill files** (single source of truth — this README is just the
pitch): `SKILL.md` (entry flow, setup, cleanup), `reference/round-protocol.md` (the per-round
protocol, grouping, commit rules, state shape), `reference/termination.md` (stop conditions and
caps).
