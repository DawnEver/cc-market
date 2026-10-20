// pick.mjs — the effective profile set (method data + project config) and the weighted pick.

// Method profiles overlaid by the project's `.claude/sharp-review.json`: `customProfiles` add or
// replace whole profiles (same shape as method/profiles.json), `profileWeights` retune weights.
// An invalid custom profile is refused by name, never skipped.
export function effectiveProfiles(method, config = {}) {
  const profiles = { ...method.profiles };
  for (const p of config.customProfiles || []) {
    const missing = ['key', 'source', 'context', 'scope'].filter((k) => p?.[k] === undefined || p?.[k] === null);
    if (missing.length) throw new Error(`customProfiles entry ${JSON.stringify(p?.key ?? p)} lacks ${missing.join(', ')}`);
    if (!(p.context in method.contexts)) throw new Error(`customProfiles entry ${p.key} names unknown context ${p.context}`);
    profiles[p.key] = { label: p.key, framing: null, weight: 0.1, ...p };
  }
  for (const [key, w] of Object.entries(config.profileWeights || {})) {
    if (profiles[key]) profiles[key] = { ...profiles[key], weight: w };
  }
  return profiles;
}

// Ordered [key, weight] pairs of the profiles eligible this round: source fired (all when
// `sources` is empty) and, when a run mode restricts contexts, a permitted context.
export function eligibleWeights(profiles, { sources, contexts } = {}) {
  const fired = sources && sources.length ? new Set(sources) : null;
  return Object.values(profiles)
    .filter((p) => (!fired || fired.has(p.source)) && (!contexts || contexts.includes(p.context)))
    .map((p) => [p.key, p.weight]);
}

// method.pick.algorithm = weighted_without_replacement (conformance: method/conformance/pick).
export function pickProfiles(weights, count, rands, method) {
  const remaining = weights.filter(([, w]) => Number.isFinite(w) && w > 0);
  if (!remaining.length) return [method.pick.empty_fallback];
  const picked = [];
  for (let i = 0; i < count && remaining.length; i++) {
    const total = remaining.reduce((s, [, w]) => s + w, 0);
    let threshold = Math.max(0, Math.min(rands[i], 0.999999)) * total;
    let idx = remaining.length - 1;
    for (let j = 0; j < remaining.length; j++) {
      threshold -= remaining[j][1];
      if (threshold < 0) { idx = j; break; }
    }
    picked.push(remaining[idx][0]);
    remaining.splice(idx, 1);
  }
  return picked;
}
