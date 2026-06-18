#!/usr/bin/env node
// pick-profile.js — Select a review profile for this trigger.
// Probability-weighted, stateless: no persisted index. Weights come from the registry in
// lib.mjs, overridable per project via reviewGate.profileWeights in .claude/.rem-state.json.
// Math.random() is fine here (a normal node script); the Workflow script must never use it.
// Outputs the resolved profile as JSON to stdout: { key, label, mode, promptKind, framing, reviewScope }.

import { join } from 'path';

import { loadState } from '../shared/state.mjs';
import { resolveProfile, resolveWeights, pickProfileKey, globalWeightsForSources } from '../lib.mjs';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function getArg(args, flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; }

function readWeightOverride() {
  try {
    const state = loadState(join(ROOT, '.claude', '.rem-state.json'));
    return state.reviewGate?.profileWeights || null;
  } catch {
    return null;
  }
}

function main() {
  const args = process.argv.slice(2);
  const forced = getArg(args, '--profile');
  const sourcesArg = getArg(args, '--sources');

  let key;
  if (forced) {
    // Explicit override (e.g. manual run): select without consulting weights.
    key = forced;
  } else {
    const override = readWeightOverride();
    const sourceKeys = sourcesArg
      ? sourcesArg.split(',').map(s => s.trim()).filter(Boolean)
      : null;
    // With --sources, fold the global distribution onto the eligible profiles (orphan mass →
    // diff); without it (manual run), draw from the full global rotation.
    const weights = sourceKeys ? globalWeightsForSources(sourceKeys, override) : resolveWeights(override);
    key = pickProfileKey(weights, Math.random());
  }

  const profile = resolveProfile(key);
  process.stdout.write(JSON.stringify({
    key: profile.key,
    label: profile.label,
    mode: profile.mode,
    promptKind: profile.promptKind,
    framing: profile.framing,
    reviewScope: profile.reviewScope,
  }) + '\n');
}

main();
