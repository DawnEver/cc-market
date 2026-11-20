---
description: Run the supervision checks once and report — no scheduling, no auto-repair.
argument-hint: "[--project DIR] [--config PATH]"
---

# /watch:check

Run one supervision cycle against a target and show what it found. Nothing is armed, nothing is
scheduled and no remedy is applied: this is the verb for "what does it see right now".

```bash
python -m lab_commons.supervise check \
  --project "${CLAUDE_PROJECT_DIR}" \
  --config "${CLAUDE_PROJECT_DIR}/deploy/supervise.toml"
```

Exit status is `0` when every check passed and `1` when something was wrong, so a shell can branch
on it without parsing anything.

## Reading the answer

The one line it prints leads with the status:

| Status | Means |
|---|---|
| `HEALTHY` | Every enabled check passed |
| `DEGRADED` | Something is wrong; the sources are named after the colon |
| `COMPLETE` | A watched task finished successfully — an outcome, not a fault |

A reason is always attached to what did NOT happen. `1 remedy ran, 1 held by a gate` distinguishes
"we chose not to act" from "we tried and it failed"; a target that goes quiet says which brake held
it, because silence and a stopped supervisor look identical from outside.

## When it reports `supervise.unconfigured`

Nothing is enabled, so nothing is being watched. This is a critical anomaly rather than a quiet
success **on purpose**: a supervisor with no components would otherwise report `healthy` forever
while watching nothing, which is the failure that looks most like working. Write a config — see
`/watch:setup`.

## Looking further back

For what a run of cycles added up to rather than what one found:

```bash
python -m lab_commons.supervise digest --project "${CLAUDE_PROJECT_DIR}"
```

That reads the journal the daemon appends to and reports the window: how many cycles, how many were
degraded, what was done, which channels did not take a notice, and which anomaly was most
persistent. A day with nothing in it says so rather than saying nothing.
