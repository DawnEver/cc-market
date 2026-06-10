# REM State File Schema

`lib.mjs` exports `loadState()`, `saveState()`, `appendEvent()`. State file: `.claude/.rem-state.json`.

```json
{
  "hook": {
    "sessionKey": "uuid",
    "stopCount": 3,
    "firstStopAt": 1780500000000,
    "remPending": false,
    "remDone": false,
    "lastTouched": 1780500000000,
    "taskActiveUntil": null
  },
  "prune": {
    "lastPruneAt": 1780500000000,
    "events": [{ "ts": "...", "type": "evict", "path": "...", "reason": "stale-90d" }]
  }
}
```

Useful for debugging hook gating (e.g. why `/rem` did or didn't trigger) or checking
recent prune events (demotions/evictions) during a session.
