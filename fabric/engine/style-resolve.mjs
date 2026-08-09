// engine/style-resolve.mjs — resolve a profile `style` to a built system-prompt
// file, rebuilding it from the platform's style sources when stale.
//
// The platform layout lives NEXT TO the configured systemPromptFile (e.g.
// Sync/claude/system-prompt/): build.mjs + discover-styles.mjs + dist/.
// fabric derives everything from the config path — no hardcoded locations.
//
//   profile.style: "academic"  → <dir>/dist/academic.claude.md (auto-built)
//   priority: profile.systemPromptFile > profile.style > cfg.systemPromptFile
import { existsSync, statSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function dirOf(baseFile) {
  return dirname(resolve(baseFile));
}

/** The built file for a style; rebuilds via build.mjs when missing or stale. */
export function resolveStyleFile(style, baseFile, { _exec = process.execPath } = {}) {
  if (!baseFile) throw new Error(`resolveStyleFile("${style}"): no systemPromptFile configured to derive the platform dir from`);
  const dir = dirOf(baseFile);
  const buildScript = join(dir, "build.mjs");
  const distFile = join(dir, "dist", `${style}.claude.md`);
  if (!existsSync(buildScript)) {
    throw new Error(`resolveStyleFile("${style}"): no build.mjs at ${buildScript} — the platform dir must contain the style tooling`);
  }
  mkdirSync(join(dir, "dist"), { recursive: true });
  if (!existsSync(distFile) || isStale(style, dir, distFile)) {
    const res = spawnSync(_exec, [buildScript, style], { cwd: dir, encoding: "utf8", timeout: 60000 });
    if (res.status !== 0) {
      throw new Error(`resolveStyleFile("${style}"): build failed (${res.status}): ${(res.stderr || res.stdout || "").slice(0, 300)}`);
    }
  }
  return distFile;
}

// Rebuild when any style source (discovered via discover-styles.mjs semantics:
// any <dir>/../output-styles or <dir>/.claude/output-styles) is newer than dist.
function isStale(style, dir, distFile) {
  const distMtime = statSync(distFile).mtimeMs;
  const candidates = [
    join(dirname(dir), "output-styles"),
    join(dir, ".claude", "output-styles"),
    join(process.env.HOME || process.env.USERPROFILE || "", ".claude", "output-styles"),
  ];
  if (process.env.STYLE_SEARCH_DIRS) {
    for (const d of process.env.STYLE_SEARCH_DIRS.split(";")) if (d.trim()) candidates.push(d.trim());
  }
  for (const cand of candidates) {
    if (!existsSync(cand)) continue;
    const styleFile = join(cand, `${style}.md`);
    if (existsSync(styleFile) && statSync(styleFile).mtimeMs > distMtime) return true;
  }
  return false;
}
