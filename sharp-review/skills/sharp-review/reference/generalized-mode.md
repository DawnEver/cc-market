# sharp-review — Generalized Mode (Content Review)

Read this only when calling the review workflow **as an external consumer** to review arbitrary
content instead of a git diff (the standard `/sharp-review` flow never needs this). The workflow
engine supports arbitrary content review beyond code diffs: callers configure reviewers, finding
schemas, and review scope — the engine handles parallel fanout, dedup merge, and confidence
tagging.

## Calling from another skill

```js
Workflow({
  scriptPath: "<path-to>/scripts/sharp-review-workflow.js",
  args: {
    date: "<YYYY-MM-DD>",
    contentType: "content",          // "code" (default) | "content"
    content: "<text to review>",      // required when contentType is "content"
    reviewScope: "<review dimensions>",  // overrides default code scope
    findingSchema: { ... },           // JSON Schema for findings (overrides default)
    reviewers: [                      // overrides default A/B/C
      { key: 'A', name: '...', provider: 'claude', model: 'opus' },
      { key: 'B', name: '...', provider: 'deepseek' },
    ],
    pickStrategy: "all",              // "seed-mod" (default, picks 2 via time seed) | "all" (uses all)
    dedupKeyFields: ["summary"],      // fields for dedup key (default: ["file", "summary"])
    idPrefix: "SR",                   // finding ID prefix (default: "SR")
  }
})
```

## Parameters

| Param | Default | Description |
|-------|---------|-------------|
| `contentType` | `"code"` | `"code"` for git diff (original behavior), `"content"` for arbitrary text |
| `content` | — | Review target text. Required when `contentType === "content"` |
| `reviewScope` | 5-dim code scope | Comma-separated review dimensions |
| `findingSchema` | Code schema | JSON Schema for a single finding. Engine wraps in `{ findings: [...] }` |
| `reviewers` | A/B/C | Array of `{ key, name, provider, model? }`. `key` maps to takeover provider routing |
| `pickStrategy` | `"seed-mod"` | `"seed-mod"` picks 2 of N from `args.seed` (time-based, falls back to day-of-month); `"all"` runs all reviewers |
| `dedupKeyFields` | `["file", "summary"]` | Which finding fields form the dedup key (lowercased, first 60 chars each) |
| `idPrefix` | `"SR"` | Prefix for finding IDs (`SR-20260610-001`, `CR-A-20260610-001`, etc.) |

## Return value

```json
{
  "reviewFile": ".claude/memory/2026/06/10/sharp-review.md",
  "markdown": "## Review 2026-06-10 (session) ...",
  "merged": [{ "id": "SR-20260610-001", "severity": "HIGH", ... }],
  "summary": "3 issues (2 high-confidence) → .claude/memory/..."
}
```

The caller is responsible for writing output — the engine returns structured data, not files. For
code reviews, Step 3 of the skill writes memory via `post-review.js`. For content reviews, the
caller handles pipeline integration.

## Example: ai-post 三方会审

ai-post's `/post-review` configures two identities (读者代理人 + 技术核查员), each with 2 models and
custom finding schemas. Runs two workflow calls (one per identity) in parallel, then synthesizes
cross-identity verdicts. See `ai-post/.claude/skills/post-review/SKILL.md`.
