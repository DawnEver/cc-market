# REM State File Schema

`lib.mjs` exports `loadState()`, `saveState()`, `appendEvent()`. State file: `.claude/.rem-state.json`.

```json
{
  "hook": {
    "taskActiveUntil": null,
    "sessions": {
      "<native-session-id>": {
        "sessionKey": "<native-session-id>",
        "stopCount": 3,
        "firstStopAt": 1780500000000,
        "remPending": true,
        "remDone": false,
        "lastTouched": 1780500000000,
        "taskActiveUntil": null,
        "requestId": "<native-session-id>:1780500000000",
        "requestExpiresAt": 1780501800000
      }
    }
  },
  "prune": {
    "lastPruneAt": 1780500000000,
    "events": [{ "ts": "...", "type": "evict", "path": "...", "reason": "stale-90d" }]
  },
  "scopes": {
    "ignore": ["vendor", "test-*", "packages/legacy"],
    "split": {
      "minOwnEntries": 30,
      "minClusterEntries": 5,
      "maxBytes": 524288
    }
  }
}
```

Runtime hook decisions use `hook.sessions[id]`, never a single project-wide counter.
The project-level `taskActiveUntil` still defers lifecycle work while an explicitly
protected task is active. Reads, gate decisions and writes run under `withStateLock()`.
Inactive slots expire after 30 minutes; a pending request has a separate 30-minute lease.
Another Stop is not completion evidence. The successful REM workflow acknowledges the
matching request through `rem-session.js complete`; expired or replayed acknowledgements
are rejected. A live review reservation defers REM; a Stop continuation does not recurse.

`scopes.ignore` — glob/name patterns for directories that `findAllScopes` /
`findChildScopes` skip during scope discovery (and prune their descendants). A bare
pattern (no `/`) matches a directory's basename; a pattern containing `/` matches the
path relative to the scan root. Both support `*` and `?`. Empty by default.

Useful for debugging hook gating (e.g. why `/rem` did or didn't trigger) or checking
recent prune events (demotions/evictions) during a session.
