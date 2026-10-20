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

// The provider list, most specific first: --providers, the project config's
// providers.<run mode>, the run mode's own list, else the interactive rotated roster.
function providerList(runMode, modeName, { requested, config, available, seed }) {
  if (requested && requested.length) return requested;
  const configured = config.providers?.[modeName];
  if (configured && configured.length) return configured;
  if (Array.isArray(runMode.providers)) return runMode.providers;
  return rotatedRoster(available, runMode.providers, seed);
}

export function buildPlan({ method, config = {}, manifest, sources, forced, runMode: modeName = 'interactive', requested, available = [], rands, runId, startedAt, date, seed }) {
  const runMode = method.run_modes[modeName];
  if (!runMode) throw new Error(`unknown run mode ${modeName}; known: ${Object.keys(method.run_modes).join(', ')}`);
  const profiles = effectiveProfiles(method, config);
  let keys;
  if (forced) {
    if (!profiles[forced]) throw new Error(`unknown profile ${forced}; known: ${Object.keys(profiles).join(', ')}`);
    keys = [forced];
  } else {
    keys = pickProfiles(eligibleWeights(profiles, { sources, contexts: runMode.contexts }), method.pick.count, rands.pick, method);
  }
  if (method.pick.assignment === 'shuffled') keys = shuffle(keys, rands.shuffle);

  const providers = providerList(runMode, modeName, { requested, config, available, seed });
  const reachable = new Set(available);
  const reviewers = keys.map((key, i) => {
    const profile = profiles[key];
    const provider = providers.length ? providers[i % providers.length] : null;
    const base = { name: key, provider, profile: key };
    if (!provider || !reachable.has(provider)) return { ...base, status: 'unavailable' };
    const rendered = renderReviewerPrompt(profile, manifest, method);
    if (rendered.status) return { ...base, status: rendered.status };
    if (!runMode.call_modes.includes(rendered.call_mode)) return { ...base, status: 'unsupported', call_mode: rendered.call_mode };
    const model = runMode.models[provider];
    return { ...base, status: 'pending', call_mode: rendered.call_mode, ...(model ? { model } : {}), prompt: rendered.prompt };
  });

  return {
    schema_version: method.schema_version,
    run_id: runId,
    started_at: startedAt,
    date,
    run_mode: modeName,
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
