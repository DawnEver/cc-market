---
name: sharp-review-2026-06-15
description: Sharp review findings — 6 total
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
