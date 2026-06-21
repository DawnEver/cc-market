// profiles.mjs — Sharp Review profile registry + weighted selection.
// A profile is a review *template* (scope, prompt framing, forced mode) — orthogonal to
// providers. Re-exported via lib.mjs.

// ── Review profiles ──
// A profile is a review *template* (scope, prompt framing, forced mode) — NOT bound to any
// provider. Provider/model selection stays the per-reviewer seed-mod rotation. Profiles are
// selected probabilistically per trigger (see pickProfileKey); weights are tunable per project
// via reviewGate.profileWeights in .claude/.rem-state.json.

// `source` names the trigger adapter (see sources.mjs) that fires this profile's review.
// Profiles whose `source` is in the fired set are eligible for selection. Weights are relative
// probabilities WITHIN the eligible (fired-source) set — the source gate decides eligibility,
// the weight decides the pick among eligible profiles. Default weights sum to 1.0. Set a weight
// to 0 to opt a profile out (pickProfileKey drops non-positive weights).
export const PROFILES = {
  diff: {
    key: 'diff',
    label: 'diff review',
    source: 'diff',
    weight: 0.6,            // default probability
    mode: null,             // null = honor diff-manifest's decided mode (review/agent/empty)
    promptKind: 'diff',
    framing: null,          // null = workflow's existing default intro
    reviewScope: null,      // null = DEFAULT_REVIEW_SCOPE in the workflow
  },
  architecture: {
    key: 'architecture',
    label: 'architecture survey (架构锐评)',
    source: 'codebase',
    weight: 0.2,
    mode: 'agent',          // forced — reviewers explore the repo freely
    promptKind: 'architecture',
    framing: '架构锐评: survey the CURRENT codebase architecture as a whole — this is NOT a diff review.',
    reviewScope: [
      'Module boundaries and layering violations',
      'Coupling / cohesion problems and circular dependencies',
      'Duplication and missing abstractions across the codebase',
      'File size — code files > 300 lines warrant scrutiny; > 600 lines MUST be split into smaller modules',
      'Doc size — any single SKILL.md / AGENTS.md / CLAUDE.md > 100 lines warrants scrutiny: push mechanism, schemas, and edge-cases into reference/* (progressive disclosure), keeping runtime docs to the execution path',
      'Inconsistent patterns, dead subsystems, scalability / extensibility limits',
    ].join(', '),
  },
  security: {
    key: 'security',
    label: 'security audit (安全锐评)',
    source: 'diff',
    weight: 0.05,          // competes with `diff` whenever the diff source fires
    mode: null,            // honor diff-manifest's decided mode
    promptKind: 'diff',
    framing: '安全锐评: audit the diff for security vulnerabilities — focus on exploitable defects, not style.',
    reviewScope: [
      'Authorization / access-control gaps and missing authentication',
      'Injection (SQL, command, template, XSS) and unsafe input handling',
      'Hardcoded secrets / credentials / tokens',
      'SSRF and path traversal',
      'Unsafe deserialization',
      'Crypto misuse (weak algorithms, static IVs, predictable randomness)',
    ].join(', '),
  },
  docs: {
    key: 'docs',
    label: 'docs review (文档锐评)',
    source: 'docs',
    weight: 0.1,           // eligible only when the docs source fires
    mode: 'agent',         // reviewers explore docs + code
    promptKind: 'architecture', // reuse the explore prompt path (no diff payload)
    framing: '文档锐评: review the documentation against the current code — this is NOT a diff review.',
    reviewScope: [
      'Accuracy vs. the actual code (claims that no longer hold)',
      'Staleness — outdated instructions, removed features still documented',
      'Broken links / references / anchors',
      'Missing or contradictory setup/usage instructions',
    ].join(', '),
  },
  deps: {
    key: 'deps',
    label: 'dependency review (依赖锐评)',
    source: 'deps',
    weight: 0.05,          // eligible only when the deps source fires
    mode: 'agent',         // reviewers explore manifests + lockfiles
    promptKind: 'architecture',
    framing: '依赖锐评: review the project dependencies for risk — this is NOT a diff review.',
    reviewScope: [
      'Known CVEs / security advisories in pinned versions',
      'Outdated major versions and unmaintained packages',
      'License issues / incompatibilities',
      'Unused or duplicate dependencies',
    ].join(', '),
  },
};

export function resolveProfile(key, registry = PROFILES) {
  return registry[key] || registry.diff || PROFILES.diff;
}

// ── Custom (config-driven) profiles ──
// A project can declare extra review templates in .claude/.rem-state.json →
// reviewGate.customProfiles (array) WITHOUT touching plugin code. Each entry is normalized into
// the PROFILES shape and merged into the registry that pick-profile.js draws from. This keeps
// the engine source-agnostic: a custom profile just attaches its framing/scope to an existing
// `source` trigger (usually `codebase`, agent mode) and competes on weight like any built-in.
//
// Entry shape: { key, source, weight?, mode?, promptKind?, framing?, reviewScope?, label? }
//   key, source        required (source must be a known trigger: diff|codebase|docs|deps)
//   weight             default 0.1; non-positive/garbage → dropped at weighting time
//   mode               'agent' (default) | 'review' | null (honor diff-manifest)
//   promptKind         'architecture' (default, explore — no diff payload) | 'diff'
//   reviewScope        string or string[] (joined with ', '); keep it tight — verbose framing
//                      wastes reviewer attention
export function normalizeCustomProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = typeof raw.key === 'string' ? raw.key.trim() : '';
  const source = typeof raw.source === 'string' ? raw.source.trim() : '';
  if (!key || !source) return null; // key + source are required
  const mode = raw.mode === null || raw.mode === 'review' || raw.mode === 'agent' ? raw.mode : 'agent';
  const scope = Array.isArray(raw.reviewScope)
    ? raw.reviewScope.filter(Boolean).join(', ')
    : (typeof raw.reviewScope === 'string' && raw.reviewScope.trim() ? raw.reviewScope.trim() : null);
  return {
    key,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : key,
    source,
    weight: Number.isFinite(raw.weight) && raw.weight > 0 ? raw.weight : 0.1,
    mode,
    promptKind: raw.promptKind === 'diff' ? 'diff' : 'architecture',
    framing: typeof raw.framing === 'string' && raw.framing.trim() ? raw.framing.trim() : null,
    reviewScope: scope,
    custom: true,
  };
}

// Build the effective registry = built-in PROFILES + normalized custom profiles. A custom entry
// reusing a built-in key overrides it (last wins) — lets a project retune a shipped profile's
// framing/scope. Invalid entries (missing key/source) are skipped silently.
export function mergeProfiles(customProfiles, base = PROFILES) {
  if (!Array.isArray(customProfiles) || !customProfiles.length) return base;
  const merged = { ...base };
  for (const raw of customProfiles) {
    const p = normalizeCustomProfile(raw);
    if (p) merged[p.key] = p;
  }
  return merged;
}

// Merge a per-project weight override map over the registry defaults. Unknown keys ignored;
// non-positive / non-finite weights dropped. Returns { <key>: weight } for known profiles.
export function resolveWeights(override, registry = PROFILES) {
  const weights = {};
  for (const [key, p] of Object.entries(registry)) {
    const w = override && Number.isFinite(override[key]) ? override[key] : p.weight;
    if (Number.isFinite(w) && w > 0) weights[key] = w;
  }
  return weights;
}

// Collapse the GLOBAL weight distribution onto the profiles eligible this round (those whose
// `source` trigger fired). Selection is a single global weighted draw — there is no "pick a
// source, then a profile within it" stage. Profiles whose source is cold donate their weight
// ("orphan mass") to the catch-all `diff` review, so every eligible *specialist* keeps its exact
// GLOBAL weight and `diff` absorbs the slack (its effective rate sits above its base weight).
// Edge case — `diff` itself ineligible (its source didn't fire, e.g. a doc-only change): the
// orphan mass is spread across the eligible profiles in proportion to their weight, preserving
// their relative global shares. Returns {} when nothing is eligible (caller skips the review).
export function globalWeightsForSources(sourceKeys, override, fallbackKey = 'diff', registry = PROFILES) {
  const fired = new Set(sourceKeys || []);
  const all = resolveWeights(override, registry);  // global weights (non-positive already dropped)
  const eligible = {};
  let orphan = 0;
  for (const [key, w] of Object.entries(all)) {
    if (fired.has(registry[key]?.source)) eligible[key] = w;
    else orphan += w;
  }
  const keys = Object.keys(eligible);
  if (!keys.length || orphan <= 0) return eligible;
  if (eligible[fallbackKey] !== undefined) {
    eligible[fallbackKey] += orphan;               // catch-all absorbs the slack
  } else {
    const total = keys.reduce((s, k) => s + eligible[k], 0);
    for (const k of keys) eligible[k] += orphan * (eligible[k] / total);
  }
  return eligible;
}

// Pure weighted pick. `rand` ∈ [0,1) injected by the caller (Math.random in the script,
// fixed values in tests). Falls back to 'diff' when weights are empty/garbage.
export function pickProfileKey(weights, rand) {
  const entries = Object.entries(weights).filter(([, w]) => Number.isFinite(w) && w > 0);
  if (!entries.length) return 'diff';
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let threshold = (Number.isFinite(rand) ? Math.max(0, Math.min(rand, 0.999999)) : 0) * total;
  for (const [key, w] of entries) {
    threshold -= w;
    if (threshold < 0) return key;
  }
  return entries[entries.length - 1][0];
}
