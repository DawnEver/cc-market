---
name: Codex memory and review lifecycle integration
description: Enable native recall and compact restoration, isolate Stop gates, and remove implicit Claude classification.
metadata:
  type: project
---

# Outcome

REM and sharp-review share bundled, host-neutral structured hook facts. Codex recall
and compact restoration are enabled; Stop continuation is bounded and explicitly
acknowledged rather than treating a pending request as successful work.

- REM keeps transient counters and completion requests per session under the existing
  transaction lock. Native lifecycle source replaces transcript-size resume guessing.
- Injected recalled memories record semantic access. Arbitrary shell reads are not
  reconstructed as reliable semantic memory access.
- Codex runs REM inline unless a real inherited-context fork is available. Completion
  requires the matching unexpired request; acknowledgement paths/IDs travel as encoded
  argv data, not interpolated executable shell source.
- Review uses deterministic source thresholds and a native worker, not a hidden Claude
  classifier. Checkout-wide atomic claims expire; only successfully persisted findings
  credit reviewed content. A below-threshold first Stop no longer disables later reviews.
- REM/review coordinate reservations and do not recursively trigger one another during
  an existing Stop continuation. Deferred work waits for the next eligible ordinary Stop.
- Canonical shared/hook-facts.mjs is bundled to all six importing plugins and generated
  Codex manifests were refreshed through the generator.

Verification before release: complete JS suite 1088 passed, one skipped, zero failures;
fixtures cover both transcript formats, concurrent session gates, explicit completion,
no Claude classifier, safe acknowledgement data, generated bundles and public hygiene.
No paid provider probes, trust bypass or remote push was performed. The user authorized
a local release commit/tag and local plugin update, explicitly without pushing.
