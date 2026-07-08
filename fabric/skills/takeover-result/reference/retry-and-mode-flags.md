# Retry Logic & Mode Flags

## Retry Logic

| Status | Behavior |
|---|---|
| 429, 502, 503, 504 | 2 retries with exponential backoff (1s, 2s) |
| 4xx | Fail immediately |
| Network error / timeout | Retry if attempts remain |

`isRetryable(status)` in `lib.mjs` defines the retryable set.

## Mode Flags

`parseCommandBlock()` extracts from `<command>` block:
- `--review` → `mode=review` (adversarial by default)
- `--image-edit` → `mode=image-edit`
- `--image` → `mode=image-generate`
- `--provider X` → provider override
- `--model X` → model override
