---
name: recall-ttl-cache
description: recall.js (UserPromptSubmit hook) candidate cache re-stats the memory tree at mo
metadata:
  type: project
---

recall.js (UserPromptSubmit hook) candidate cache re-stats the memory tree at most once per FINGERPRINT_TTL_MS = 30s. Within the TTL window the cached candidates are served without touching the memory tree — per-prompt cost drops to a single statSync on the tmpdir cache file. On expiry it re-stats and compares the tree fingerprint: unchanged → refresh ts + reuse candidates; changed → rebuild. Legacy cache files without ts migrate automatically. Tradeoff: a memory write is picked up within <=30s (bounded staleness — acceptable for best-effort relevance recall). telemetry records fast:true on TTL-window hits; `recall.js --telemetry` prints the fast-path hit rate. Added 2026-07-31 (cc-market/rem, uncommitted).
