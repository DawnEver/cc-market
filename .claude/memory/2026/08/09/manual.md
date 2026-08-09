---
name: manual-2026-08-09
description: Manual tasks created on 2026-08-09
metadata:
  type: project
---

- [ ] MANUAL-20260809-001 [MEDIUM] fabric: WS1 native claude sessions route to deepseek-v4-flash and fail auth. CORRECTED diagnosis: loadProviderEnv already strips PROVIDER_ENV_KEYS for provider claude, so the pollution is NOT the serve terminal env — the likely source is WS1's own ~/.claude/settings.json env block (native claude keeps the real config dir by design). Verify on WS1 and decide: user config to clean, or fabric should pass an explicit model for native sessions. (2026-08-09)
      module: fabric

