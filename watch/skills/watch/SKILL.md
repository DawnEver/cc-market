---
name: watch
description: Read what supervision found on a target and decide what a person should hear about. Use when a project has a deploy/supervise.toml and something may be wrong with what it runs.
---

# watch

The AI layer over `lab_commons.supervise`. The library measures, decides and acts; this skill reads
what it produced and adds the one thing a library cannot: judgment about whether a person needs to
be involved.

## The rule that keeps this thin

**Config decides, not this file.** Which checks run, what a failure means, what a remedy does and
when an alert escalates all live in the target's `deploy/supervise.toml` and the library that reads
it. If what follows disagrees with the config, the config is right. A second copy of a rule here
would be the drift the machine was extracted into a library to remove — and the predecessor proved
it: two copies of the remedy chain, one in a daemon and one in a loop, and no way to tell which had
run.

## Steps

1. **Read the state.**

   ```bash
   python -m lab_commons.supervise check \
     --project "${CLAUDE_PROJECT_DIR}" \
     --config "${CLAUDE_PROJECT_DIR}/deploy/supervise.toml"
   ```

2. **Branch on the status.**

   | Status | What to do |
   |---|---|
   | `HEALTHY` | Report the line. Stop. |
   | `COMPLETE` | Report it. A finished task is good news and never escalates. |
   | `DEGRADED` | Continue. |

3. **Do not re-run what already ran.** The remedies executed *inside* the cycle — the summary's
   `N remedies ran` says so. They are idempotent, but re-running a deployment because a report
   mentioned it is how a supervisor becomes the outage.

4. **Sort what is left by who can act on it.**
   - **A remedy ran and failed** — a person. This is the real escalation.
   - **A step a gate held** — explain the gate. The config chose not to act; re-running would not
     change that.
   - **`drifted`** — somebody is working in a checkout. **Never repair it.** Report and stop;
     resetting it would destroy their work to make a number go green.
   - **`release_failing`** — the same release has failed past its tolerance and is *still retried*,
     deliberately. What the count buys is the alert saying how many times; say that, not "blocked".
   - **`no_verified_release`** — the honest warning that the first deployment is the one with
     nowhere to roll back to.
   - **`supervise.unconfigured`** — nothing is being watched at all. Say that plainly; it is the
     failure that looks most like success.

5. **Escalate through the library, not around it.** Alerts are already suppressed by signature,
   cooldown and write-off. Do not add a second throttle here. If a notice must go regardless, the
   config's chain has a `notify` step for exactly that.

## What is deliberately absent

No daemon, no timer, no process manager. Supervision runs under systemd on the host that runs the
target. A Claude session adds judgment when a person is watching; it is not a supervisor, and a
deployment must never be started from one.

`reference/plugin-update.md` covers keeping this plugin itself current.
