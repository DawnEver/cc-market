// engine/profile.mjs — spawn profiles (G2). The spawn point is the only place where
// credential SUBTRACTION cannot be bypassed, so this is where policy attaches: a profile
// names what a child may do (tools, permission mode) and which env vars it must NOT
// inherit. Fabric defines the MECHANISM; the caller's config names the roles.
//
// Config: the `fabric.profiles` block of claude_env_settings.json —
//   "profiles": { "author": { "allowedTools": "Read,Grep", "permissionMode": "default",
//                             "envDeny": ["INTEGRATOR_TOKEN"] } }
// A profile only ever subtracts; there is deliberately no envAdd.

/**
 * Resolve a profile reference: an object passes through, a name looks up
 * `cfg.profiles`, absent → null, unknown name → throw naming what exists.
 */
export function resolveProfile(ref, cfg = {}) {
  if (ref == null) return null;
  if (typeof ref === "object") return ref;
  const profiles = cfg.profiles || {};
  if (!(ref in profiles)) {
    throw new Error(`unknown spawn profile "${ref}". Available: ${Object.keys(profiles).join(", ") || "(none configured — add fabric.profiles)"}`);
  }
  return profiles[ref];
}

/** Subtract the profile's envDeny vars. Never adds. */
export function applyProfileEnv(env, profile) {
  if (!profile?.envDeny?.length) return env;
  const out = { ...env };
  for (const k of profile.envDeny) delete out[k];
  return out;
}

/** CLI flags for the claude child implementing the tool/permission policy. */
export function profileArgs(profile) {
  if (!profile) return [];
  const args = [];
  if (profile.allowedTools) {
    args.push("--allowedTools", Array.isArray(profile.allowedTools) ? profile.allowedTools.join(",") : profile.allowedTools);
  }
  if (profile.permissionMode) args.push("--permission-mode", profile.permissionMode);
  return args;
}
