#!/usr/bin/env node
// pick-profile.js — Select N review profiles for this trigger.
// Weighted random draw without replacement: picks 2 profiles (or fewer if <2 eligible).
// Stateless: no persisted index. Weights come from the registry in lib.mjs, overridable
// per project via the tracked `.claude/sharp-review.json` (profileWeights + customProfiles).
// Math.random() is fine here (a normal node script); the Workflow script must never use it.
// Outputs an array of resolved profiles as JSON to stdout: [{ key, label, mode, promptKind, framing, reviewScope }, …].

import { resolveProfile, resolveWeights, eligibleWeights, pickNProfileKeys, mergeProfiles, loadReviewConfig } from './lib.mjs';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const PICK_COUNT = 2; // profiles per round

function getArg(args, flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; }

function main() {
  const args = process.argv.slice(2);
  const forced = getArg(args, '--profile');
  const sourcesArg = getArg(args, '--sources');

  // Tracked per-project config: weight overrides + custom profiles.
  const cfg = loadReviewConfig(ROOT);
  const override = cfg.profileWeights || null;
  const registry = mergeProfiles(cfg.customProfiles);

  let keys;
  if (forced) {
    // Explicit override (e.g. manual run): use the forced profile alone.
    keys = [forced];
  } else {
    const sourceKeys = sourcesArg
      ? sourcesArg.split(',').map(s => s.trim()).filter(Boolean)
      : null;
    // With --sources, filter to eligible profiles whose source fired; without (manual
    // run), draw from the full global rotation.
    const weights = sourceKeys
      ? eligibleWeights(sourceKeys, override, registry)
      : resolveWeights(override, registry);
    keys = pickNProfileKeys(weights, PICK_COUNT);
  }

  const profiles = keys.map(key => {
    const p = resolveProfile(key, registry);
    return { key: p.key, label: p.label, mode: p.mode, promptKind: p.promptKind, framing: p.framing, reviewScope: p.reviewScope };
  });

  // Shuffle reviewer-to-profile assignment so no profile is predictably bound to Reviewer A/B/C.
  for (let i = profiles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [profiles[i], profiles[j]] = [profiles[j], profiles[i]];
  }

  process.stdout.write(JSON.stringify(profiles) + '\n');
}

main();
