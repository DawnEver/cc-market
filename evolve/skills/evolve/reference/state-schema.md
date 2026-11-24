# evolve — state schema (`<git dir>/evolve/state.json`)

evolve persists its loop state in the checkout's git dir, at the path
`git rev-parse --git-path evolve/state.json` names: per-worktree, device-local, never tracked,
and owned by evolve alone. **Never hand-edit this** — go through `scripts/evolve.mjs`
(`statePath`/`loadState`/`saveState`/`initState`/`recordRound`), which writes atomically. Outside a
git checkout the helper refuses by name. This schema is here for debugging / inspection only.

```jsonc
{
  "round": 0,
  "until": "ask",                       // ask | clean | resolved
  "maxRounds": 10,                       // hard backstop (all modes)
  "maxAgents": 8,                        // max concurrent fix agents per batch
  "lastRoundAt": null,
  "emptyRounds": 0,                      // consecutive rounds with no new OPEN findings
                                         //   (incremented by the termination policy)
  "findings": [ /* { id, file, summary, status, reason?, unfixedRounds, arch? }
                   id is an SR-YYYYMMDD-NNN (sharp-review) or a "file|summary" string (fallback) */ ]
}
```

State writes never block the loop: on a Windows/OneDrive rename flake `saveState` returns
`{ persisted: false }` and the round continues in memory.
