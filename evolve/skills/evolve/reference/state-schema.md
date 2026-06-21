# evolve — state schema (`.claude/.rem-state.json`)

evolve persists its loop state under the `evolveState` key of rem's shared
`.claude/.rem-state.json` (rem is a hard dependency). **Never hand-edit this** — go through
`scripts/evolve.mjs` (`loadState`/`saveState`/`initState`/`recordRound`), which writes
atomically and preserves the other top-level keys rem owns. This schema is here for debugging
/ inspection only.

```jsonc
{
  "hook": { "taskActiveUntil": 0 },      // set during loop (rem only), deleted on exit
  "evolveState": {
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
}
```

`saveState` only replaces the `evolveState` key — it must preserve all other top-level keys
(`hook`, `prune`, `reviewGate`, …) shared with rem. State writes never block the loop: on a
Windows/OneDrive rename flake `saveState` returns `{ persisted: false }` and the round
continues in memory.
