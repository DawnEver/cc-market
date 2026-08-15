# evolve Architecture — deep detail (progressive disclosure from AGENTS.md)

## File Structure

```
evolve/
├── .claude-plugin/plugin.json       Plugin manifest
├── .claude/rules/invariants.md      Dev-only constraints
├── docs/architecture.md             This file — deep detail (File Structure, helper)
├── skills/evolve/
│   ├── SKILL.md                     /evolve entry: usage, setup, per-round overview, cleanup
│   └── reference/
│       ├── round-protocol.md        Full ordered per-round protocol + failure handling
│       ├── termination.md           clean/resolved/ask + safety caps
│       └── state-schema.md          evolveState JSON schema (debug-only; delegate to evolve.mjs)
├── scripts/evolve.mjs               State/grouping/termination helper (importable + CLI)
├── tests/evolve.test.mjs            node:test (13 tests)
├── CLAUDE.md / AGENTS.md / README.md
```

## Helper — `scripts/evolve.mjs`

Dependency-free Node ESM (importable + CLI). Centralizes the error-prone mechanics so the
loop never hand-edits JSON: `loadState`/`saveState` (atomic, rem state file, Windows-retry),
`initState`, `recordRound`, `groupFindings` (connected components), `prioritize`,
`checkTermination`, `confirmedByQuorum` (a unit helper; quorum is done upstream by
sharp-review's merge, not called in the live flow). Pure logic functions take timestamps as
params (no internal clock) for deterministic tests.
