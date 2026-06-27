#!/usr/bin/env node
/**
 * SessionStart hook — inject the host project's `.claude/rules/**\/*.md` into the
 * session as `additionalContext`, but ONLY under Codex and ONLY on a fresh session
 * (not a resume — the rules are already in context from the original session).
 *
 * Why: Claude Code natively auto-loads `.claude/rules/` every session. Codex has
 * no such mechanism. This hook is the plugin-level, project-agnostic bridge: it
 * ships once in rem's hooks.json and, for whatever project Codex opens, reads that
 * project's own rules and feeds them in. Under Claude Code it is a no-op (the rules
 * are already loaded, so injecting would duplicate them). On a resumed Codex session
 * (transcript already has content) it also skips — the rules were injected on the
 * original SessionStart and persist through the resume.
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
  return buildContextFromFiles(projectRoot, collectRuleFiles(projectRoot));
}

/** Build context text from an explicit file list (used by multi-scope collection). */
export function buildContextFromFiles(projectRoot, files) {
  if (!files.length) return null;
  const blocks = files.map((file) => {
    const rel = path.relative(projectRoot, file);
    const body = fs.readFileSync(file, "utf8").replace(/\s+$/, "");
    return `Contents of ${rel}:\n\n${body}`;
  });
  return blocks.join("\n\n");
}

/**
 * Walk up from startDir to find the nearest .git directory — i.e. the project root.
 * Falls back to startDir when no .git is found (mirrors shared/lib.mjs:findProjectRoot).
 */
export function findGitRoot(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir);
}

/**
 * Walk UP from cwd toward projectRoot. Every directory that contains .claude/memory/
 * is a scope. Returns [rootScope, …, leafScope] — furthest ancestor first, nearest
 * scope to cwd last. Returns [] when no scope (no .claude/memory/) is found anywhere.
 */
export function findScopeChain(cwd, projectRoot) {
  const scopes = [];
  let dir = path.resolve(cwd);
  const root = path.resolve(projectRoot);

  while (true) {
    if (fs.existsSync(path.join(dir, ".claude", "memory"))) {
      scopes.push(dir);
    }
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    // Never walk above the project root (handles cross-drive too)
    const rel = path.relative(root, parent);
    if (rel.startsWith("..") || path.isAbsolute(rel)) break;
    dir = parent;
  }

  scopes.reverse();
  return scopes;
}

/** Collect rule files from every scope in the chain, deduplicated by absolute path. */
export function collectChainRuleFiles(scopeChain) {
  const seen = new Set();
  const files = [];
  for (const scopeDir of scopeChain) {
    for (const file of collectRuleFiles(scopeDir)) {
      if (!seen.has(file)) {
        seen.add(file);
        files.push(file);
      }
    }
  }
  return files;
}

/**
 * Read the full hook payload from stdin. Returns { cwd, transcript_path } (both
 * may be undefined if stdin is absent or malformed).
 */
function readStdinPayload() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** True when the transcript already has content — i.e. this is a resume, not a fresh session. */
export function isResume(transcriptPath) {
  if (!transcriptPath) return false;
  try {
    return fs.statSync(transcriptPath).size > 500;
  } catch {
    return false;
  }
}

function main() {
  if (!isCodexHost()) return; // Claude Code already auto-loads rules
  const payload = readStdinPayload();

  // On resume the rules are already in context from the original session — don't re-inject.
  if (isResume(payload.transcript_path)) return;

  const cwd = typeof payload.cwd === "string"
    ? path.resolve(payload.cwd)
    : process.cwd();
  const projectRoot = findGitRoot(cwd);
  const scopeChain = findScopeChain(cwd, projectRoot);

  // Collect rules from all scopes in the chain; fall back to single-directory
  // collection at the project root when no scopes (.claude/memory/) exist.
  let files;
  if (scopeChain.length > 0) {
    files = collectChainRuleFiles(scopeChain);
  } else {
    files = collectRuleFiles(projectRoot);
  }

  if (!files.length) return;
  const context = buildContextFromFiles(projectRoot, files);

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
