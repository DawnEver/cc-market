// plan.mjs — turn the method data, the project config and one manifest into a run plan:
// which profiles review, which provider runs each, and the exact prompt each receives.
// Pure: randomness, clock and git arrive as arguments.
import { effectiveProfiles, eligibleWeights, pickProfiles } from './pick.mjs';
import { renderReviewerPrompt } from './prompt.mjs';

// method.run_modes.interactive.providers: the available roster in alphabetical order, rotated
// by the manifest seed, first `count` of them.
function rotatedRoster(available, spec, seed) {
  const roster = [...available].sort();
  if (!roster.length) return [];
  const start = seed % roster.length;
  const rotated = [...roster.slice(start), ...roster.slice(0, start)];
  return rotated.slice(0, Math.min(spec.count, rotated.length));
}

function shuffle(list, rands) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rands[i] * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function buildPlan({ method, config = {}, manifest, sources, forced, available = [], rands, runId, startedAt, date, seed }) {
  const runMode = method.run_modes.interactive;
  const profiles = effectiveProfiles(method, config);
  let keys;
  if (forced) {
    if (!profiles[forced]) throw new Error(`unknown profile ${forced}; known: ${Object.keys(profiles).join(', ')}`);
    keys = [forced];
  } else {
    keys = pickProfiles(eligibleWeights(profiles, { sources }), method.pick.count, rands.pick, method);
  }
  if (method.pick.assignment === 'shuffled') keys = shuffle(keys, rands.shuffle);

  const providers = rotatedRoster(available, runMode.providers, seed);
  const reviewers = keys.map((key, i) => {
    const profile = profiles[key];
    const provider = providers.length ? providers[i % providers.length] : null;
    const base = { name: key, provider, profile: key };
    if (!provider) return { ...base, status: 'unavailable' };
    const rendered = renderReviewerPrompt(profile, manifest, method);
    if (rendered.status) return { ...base, status: rendered.status };
    const model = runMode.models[provider];
    return { ...base, status: 'pending', call_mode: rendered.call_mode, ...(model ? { model } : {}), prompt: rendered.prompt };
  });

  return {
    schema_version: method.schema_version,
    run_id: runId,
    started_at: startedAt,
    date,
    range: manifest.range,
    seed,
    stats: manifest.stats,
    excludedSummary: manifest.excludedSummary,
    synthesis: runMode.synthesis,
    sink: runMode.sink,
    profiles: keys.map((k) => ({ key: k, label: profiles[k].label })),
    reviewers,
  };
}
