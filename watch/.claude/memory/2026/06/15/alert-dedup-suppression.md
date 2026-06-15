---
name: alert-dedup-suppression
description: watch alert dedup suppression — per-type keying with signature stored in value, not per-signature key
metadata:
  type: project
---

`alerts.suppress_after_n_identical` (default 3, 0=off) stops re-sending an escalated
alert once N consecutive *identical* ones have fired. Implemented in
`core.state.register_alert_signature` + the escalation branch of `core.remediate.apply_remedies`.

**Non-obvious design decisions** (sharp review flagged these as "bugs"; they are intentional):

- **Per-`anomaly_type` state key, NOT per-signature.** Key is `_alert_sig_{type}` and the
  signature is stored *inside* the value (`{'sig', 'sent'}`). A changed signature for the same
  type means the situation moved → counter resets → suppression releases. Only one signature
  per type exists per poll, so there is no cross-signature interference. Daemon recovery
  (`daemon._poll` all-OK branch) and `reset_anomaly` clear by the `_alert_sig_` prefix, which
  relies on this scheme.
- **`sig = anomaly.signature or anomaly.message` fallback is deliberate.** watch anomaly
  messages are stable (no embedded timestamps/IDs), so the message is a safe default identity.
  Components whose message is volatile set `Anomaly.signature` explicitly (field added in
  `components/base.py`, with a docstring saying so).
- Suppression disabled (`suppress_after <= 0`) returns early with no state mutation.

Tests: `watch/tests/test_remediate.py`. Commits `6d0b9b9` (feature) + `9b659cb` (review cleanup).
