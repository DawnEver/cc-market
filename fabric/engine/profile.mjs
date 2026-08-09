// engine/profile.mjs — spawn profiles (G2). The spawn point is where policy attaches:
// a profile SETS what a child may do (allowedTools, permissionMode) and which env vars
// it must NOT inherit (envDeny). A profile can grant as well as restrict — what makes
// it a control is that it is applied LAST at the spawn point and that a REMOTE peer
// resolves names against its OWN config (sharp-review 2026-08-09: a client-supplied
// object obeyed verbatim is obedience, not enforcement).
//
// Config: the `fabric.profiles` block of claude_env_settings.json —
//   "profiles": { "author": { "allowedTools": "Read,Grep", "permissionMode": "default",
//                             "envDeny": ["INTEGRATOR_TOKEN"] } }

const PERMISSION_MODES = ["default", "plan", "acceptEdits", "dontAsk", "bypassPermissions"];

// Role-tier tool presets → `--tools` (schema trimming, NOT permissions).
// Measured schema on claude 2.1.226: exec 6.1k / coord 7.7k / daily 16.4k tok;
// full = no --tools flag (all 31 built-ins ≈ 33.6k).
// exec: execution-only agents. coord: secondary coordination (dispatch, verify,
// notify — no writes). daily: everyday interactive use (default).
export const TOOL_PRESETS = {
  exec: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
  coord: ["Read", "Glob", "Grep", "Bash", "SendMessage", "PushNotification", "WebFetch", "WebSearch"],
  daily: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Skill", "Agent", "EnterWorktree", "ExitWorktree", "Monitor", "ScheduleWakeup", "WebFetch", "WebSearch", "SendMessage", "PushNotification"],
};

// The flags a profile owns; a caller's extraArgs must not smuggle them past it.
export const PROFILE_OWNED_FLAGS = ["--allowedTools", "--permission-mode", "--dangerously-skip-permissions", "--tools", "--system-prompt-file", "--system-prompt"];

function validate(profile) {
  if (profile?.permissionMode && !PERMISSION_MODES.includes(profile.permissionMode)) {
    throw new Error(`profile permissionMode "${profile.permissionMode}" is not one of: ${PERMISSION_MODES.join(", ")}`);
  }
  if (profile?.toolsPreset && !(profile.toolsPreset in TOOL_PRESETS)) {
    throw new Error(`profile toolsPreset "${profile.toolsPreset}" is not one of: ${Object.keys(TOOL_PRESETS).join(", ")} (or "full" for no --tools)`);
  }
  return profile;
}

/**
 * Resolve a profile reference: an object passes through (validated), a name looks up
 * `cfg.profiles`, absent → null, unknown name → throw naming what exists.
 */
export function resolveProfile(ref, cfg = {}) {
  if (ref == null) return null;
  if (typeof ref === "object") return validate(ref);
  const profiles = cfg.profiles || {};
  if (!(ref in profiles)) {
    throw new Error(`unknown spawn profile "${ref}". Available: ${Object.keys(profiles).join(", ") || "(none configured — add fabric.profiles)"}`);
  }
  return validate(profiles[ref]);
}

/**
 * Subtract the profile's envDeny vars. Case-insensitive on win32 — Windows env keys
 * are case-insensitive, so an exact-match delete would silently no-op on Secret_Token.
 */
export function applyProfileEnv(env, profile, platform = process.platform) {
  if (!profile?.envDeny?.length) return env;
  const out = { ...env };
  if (platform === "win32") {
    const deny = new Set(profile.envDeny.map((k) => k.toLowerCase()));
    for (const k of Object.keys(out)) if (deny.has(k.toLowerCase())) delete out[k];
  } else {
    for (const k of profile.envDeny) delete out[k];
  }
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
  // toolsPreset trims the injected tool schema (cost); "full" or absent = all tools.
  if (profile.toolsPreset && profile.toolsPreset in TOOL_PRESETS) {
    args.push("--tools", TOOL_PRESETS[profile.toolsPreset].join(","));
  }
  // systemPromptFile replaces the stock system prompt (cache-key layer). A
  // profile wins over the platform default; null disables injection entirely.
  if (profile.systemPromptFile) {
    args.push("--system-prompt-file", profile.systemPromptFile);
  }
  return args;
}

/**
 * Strip profile-owned flags (and their values) from caller extraArgs. Applied when a
 * profile is present so "last flag wins" cannot be used to override it.
 */
export function stripProfileOwnedFlags(extraArgs = []) {
  const out = [];
  for (let i = 0; i < extraArgs.length; i++) {
    if (PROFILE_OWNED_FLAGS.includes(extraArgs[i])) {
      if (extraArgs[i] !== "--dangerously-skip-permissions") i++; // skip the value too
      continue;
    }
    out.push(extraArgs[i]);
  }
  return out;
}
