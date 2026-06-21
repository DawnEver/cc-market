#!/usr/bin/env node
/**
 * SessionStart hook — inject the host project's `.claude/rules/**\/*.md` into the
 * session as `additionalContext`, but ONLY under Codex.
 *
 * Why: Claude Code natively auto-loads `.claude/rules/` every session. Codex has
 * no such mechanism. This hook is the plugin-level, project-agnostic bridge: it
 * ships once in rem's hooks.json and, for whatever project Codex opens, reads that
 * project's own rules and feeds them in. Under Claude Code it is a no-op (the rules
 * are already loaded, so injecting would duplicate them).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Detect whether we are running under Codex. The resolved ${CLAUDE_PLUGIN_ROOT}
 * is the most reliable signal: Codex substitutes it beneath `.codex/plugins/…`,
 * Claude Code beneath `.claude/plugins/…`.
 */
export function isCodexHost(env = process.env) {
  const root = env.CLAUDE_PLUGIN_ROOT || "";
  if (/[\\/]\.codex[\\/]/.test(root)) return true;
  if (/[\\/]\.claude[\\/]/.test(root)) return false;
  return Boolean(env.CODEX_HOME);
}

/** Recursively collect `.md` files under `<projectRoot>/.claude/rules`, sorted. */
export function collectRuleFiles(projectRoot) {
  const rulesDir = path.join(projectRoot, ".claude", "rules");
  let entries;
  try {
    entries = fs.readdirSync(rulesDir, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => path.join(e.parentPath || e.path, e.name))
    .sort();
}

/**
 * Build the concatenated rules text (mirrors how Claude presents auto-loaded
 * rules), or null when there are no rule files.
 */
export function buildRulesContext(projectRoot) {
  const files = collectRuleFiles(projectRoot);
  if (!files.length) return null;
  const blocks = files.map((file) => {
    const rel = path.relative(projectRoot, file);
    const body = fs.readFileSync(file, "utf8").replace(/\s+$/, "");
    return `Contents of ${rel}:\n\n${body}`;
  });
  return blocks.join("\n\n");
}

function readStdinCwd() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    const payload = JSON.parse(raw);
    if (payload && typeof payload.cwd === "string") return payload.cwd;
  } catch {
    /* no/invalid stdin — fall back to process cwd */
  }
  return process.cwd();
}

function main() {
  if (!isCodexHost()) return; // Claude Code already auto-loads rules
  const projectRoot = readStdinCwd();
  const context = buildRulesContext(projectRoot);
  if (!context) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context,
      },
    }),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
