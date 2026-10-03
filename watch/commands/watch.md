---
description: Supervise a target — read the state, apply the remedies the config declares, escalate.
argument-hint: "[--project DIR] [--config PATH]"
---

# /watch:watch

The AI decision layer over `lab_commons.supervise`. The measurement, the remedy chains, the alert
transport and the escalation rules all live in the library; this command reads what they produced
and decides what a person should hear about.

**It decides nothing about the target.** Which checks run, what a failure means and what a remedy
does are all in the target's `deploy/supervise.toml`. If this command and the config disagree, the
config is right — a second copy of a rule here would be the drift the library was extracted to
remove.

## Steps

1. **Read the state.**

   ```bash
   python -m lab_commons.supervise check \
     --project "${CLAUDE_PROJECT_DIR}" \
     --config "${CLAUDE_PROJECT_DIR}/deploy/supervise.toml"
   ```

2. **Branch on the status.**
   - `HEALTHY` — report the one line and stop. Nothing to do.
   - `COMPLETE` — report it. A finished task is good news, not a fault, and it never escalates.
   - `DEGRADED` — continue.

3. **Report what is wrong, and what was already done about it.** The remedies ran *inside* the
   cycle: `N remedies ran, M held by a gate` is the summary's way of saying so. Do not re-run them
   — they are idempotent, but re-running a deployment because a report mentioned it is how a
   supervisor becomes the outage.

4. **Say what a person needs to decide.** For each anomaly, the useful question is not "what is
   wrong" — the check already said that — but *whether this needs a human*:
   - A remedy that ran and failed needs a human.
   - A step a gate held needs the gate explained, not the step re-run.
   - Drift (`drifted`) is somebody working in a checkout. **Never repair it.** Report it and stop.
   - `release_failing` past its tolerance means the same release has failed repeatedly. It is still
     retried every cycle, deliberately; what the count buys is the alert saying how many times.

## Escalation

Alerts are suppressed by the library's own rules — an unchanged signature, a cooldown, a write-off
after so many identical cycles. Do not add a second throttle here. If a notice must go out anyway,
the config's chain already has a `notify` step for it.

## What is NOT here

The daemon, the timer and the process manager. Supervision runs under systemd on the target, not
under a Claude session; this command is what a session adds when a person is watching. A deployment
in flight is not something to start from a chat window.
