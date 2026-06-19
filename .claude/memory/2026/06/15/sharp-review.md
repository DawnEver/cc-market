---
name: sharp-review-2026-06-15
description: Sharp review findings — 11 total
metadata:
  type: project
---


## Review 2026-06-15 (session) — current branch

### Reviewer Status
- Reviewer A (Codex): OK
- Reviewer B (DeepSeek): OK
- Reviewer C (Sonnet): skipped

### Confirmed findings

---

### [SR-20260615-001] [HIGH] watch/core/remediate.py — Missing `import sys` likely causes NameError when printing alert suppressed message to stderr.

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add `import sys` at the top of remediate.py.

False positive — `import sys` is already present on line 7. The reviewer saw an abbreviated diff without the file header.

---

### [SR-20260615-002] [MEDIUM] watch/core/state.py — Alert suppression key uses only anomaly_type, not signature.

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Include signature in the key.

By design — per-type keying is intentional. A changed signature means the situation moved, so resetting the counter releases suppression. Only one signature per type exists per poll; daemon recovery clears keys by `_alert_sig_` prefix, which relies on this scheme.

---

### [SR-20260615-003] [MEDIUM] watch/core/remediate.py — Defaulting signature to `anomaly.message` may fail dedup if messages contain dynamic parts.

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Always set a stable `Anomaly.signature`.

Accepted as documented behavior. watch anomaly messages are stable (no timestamps/IDs). The `signature` docstring already tells components to set a stable identity when their message is volatile; message fallback is a safe default.

---

### [SR-20260615-004] [LOW] watch/core/state.py — Counter increments indefinitely when suppression disabled (suppress_after=0).

- **Category:** Performance
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Only mutate state when `suppress_after > 0`.

Fixed — early return without state mutation when suppression disabled.

---

### [SR-20260615-005] [LOW] watch/core/state.py — Redundant reassignment `state[key] = prev`.

- **Category:** Performance
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Remove `state[key] = prev`.

Fixed — `prev` is already the stored dict reference.

---

### [SR-20260615-006] [LOW] watch/core/state.py — Redundant `suppress_after and suppress_after > 0` double-check.

- **Category:** Performance
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Simplify the condition.

Fixed — early guard handles the disabled/non-positive case; inner check is now a plain `sent >= suppress_after`.


## Review 2026-06-15 (follow-up)

## Review 2026-06-15 (session) — current branch

### Reviewer Status
- Reviewer A (Codex): OK
- Reviewer B (DeepSeek): OK
- Reviewer C (Sonnet): skipped

### Confirmed findings

---

### [SR-20260615-001] [HIGH] watch/core/remediate.py — Cooldown comparisons may use stale timestamp if 'ts' is not updated for each anomaly.

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Ensure 'ts' is generated fresh (e.g., datetime.now().isoformat()) for each anomaly before the cooldown check, or pass the current time explicitly.

In the new cooldown logic, 'ts' is used to compute elapsed time. If 'ts' is a variable set once at the start of apply_remedies (as implied by its prior use in set_alert_sent), all anomalies processed in the same call will have the same timestamp. This means after the first alert, any subsequent alert during the same run will see elapsed = 0 and be suppressed indefinitely, even if real cooldown period has passed.

**Maintainer note (2026-06-19): RESOLVED-ALREADY, not a bug.** Cooldown is cross-poll, not intra-call: line 86-94 compares the current poll's `ts` against `get_anomaly_last_alerted(state, anomaly.type)`, the timestamp stored on a *prior* poll (`set_anomaly_alerted` keys by anomaly type, `state[f'_alert_ts_{type}']`). Only one anomaly per type exists per poll, so the shared per-call `ts` is correct (it represents this poll's time). `last_ts` is never updated mid-call for the same type, so the elapsed=0 scenario does not occur. Covered by `test_cooldown_suppresses_within_window` / `test_cooldown_releases_after_window`.

---

### [SR-20260615-002] [MEDIUM] watch/core/remediate.py — Unvalidated numeric cast of 'cooldown_minutes' can cause runtime TypeError.

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Explicitly convert or validate 'cooldown_minutes' as a numeric value before multiplication.

'cooldown_s = alerts_cfg.get('email', {}).get('cooldown_minutes', 0) * 60' multiplies the config value by 60. If the configuration is a string or None (other than the default 0), this will raise a TypeError. The code relies on user-provided config being correct.

**Maintainer note (2026-06-19): RESOLVED-ALREADY.** remediate.py lines 66-70 now wrap the cast in `try: cooldown_s = float(... or 0) * 60 except (TypeError, ValueError): cooldown_s = 0`. Covered by `test_string_cooldown_minutes_does_not_crash` and `test_garbage_cooldown_minutes_treated_as_disabled`.

---

### [SR-20260615-003] [LOW] watch/core/remediate.py — Falsy check for signature falls back on message even when signature is an empty string.

- **Category:** Bug
- **Status:** WONTFIX
- **Confidence:** single-reviewer
- **Suggestion:** Use 'anomaly.signature if anomaly.signature is not None else anomaly.message' to preserve intentional empty strings.

'sig = anomaly.signature or anomaly.message' treats an empty string as falsy, potentially using the message instead. This may lead to inconsistent suppression grouping if a signature is explicitly set to an empty string.

**Maintainer note (2026-06-15): FALSE POSITIVE, not applying.** `Anomaly.signature` is declared `signature: str = ''` in `components/base.py` — the empty string IS the "unset" sentinel, by design. `or` is the intended fallback (empty → use message). The suggested `is not None` change would break `test_changed_signature_resumes_alerting`, which relies on the message-based fallback. Reviewer did not see base.py.

---

### [SR-20260615-004] [LOW] watch/core/remediate.py — Repeated escalation and state-setting code increases maintenance risk.

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Extract the common escalation + state updates into a helper function to avoid duplication.

The sequence '_escalate(...); set_alert_sent(state, ts); set_anomaly_alerted(state, anomaly.type, ts)' appears in three separate branches (cooldown expired, no prior alert, cooldown disabled). Any future change to alert handling must be applied in all three places.

**Maintainer note (2026-06-19): RESOLVED-ALREADY.** remediate.py lines 74-77 now define an `_emit_alert()` closure containing `_escalate(...); set_alert_sent(state, ts); set_anomaly_alerted(state, anomaly.type, ts)`, called from all three branches. The duplication is gone.

---

### [SR-20260615-005] [INFO] watch/core/remediate.py — Alert suppression logic is becoming non-trivial; consider extracting to a dedicated module.

- **Category:** Feature
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Move signature suppression and cooldown check into a separate function or class to keep apply_remedies focused on remediation flow.

The 'if step.escalate_after' block is now 30+ lines with nested conditional logic. Encapsulating this in an AlertSuppressor or similar would improve readability and testability.

**Maintainer note (2026-06-19): CLOSED (INFO, won't extract).** After SR-002/004 fixes the `if step.escalate_after` block is compact (~40 lines) with the `_emit_alert()` helper factoring out the common path. Suppression (A: signature) and cooldown (B: time) read as a clean if/elif/else. A dedicated AlertSuppressor module would add indirection for one call site without test benefit (the path is already covered by 10 `test_remediate.py` cases). Not worth the extraction; closing as accepted-as-is.
