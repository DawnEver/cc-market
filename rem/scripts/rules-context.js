/**
 * The host project's `.claude/rules/**\/*.md` as one context text, for Codex.
 *
 * Why: Claude Code natively auto-loads `.claude/rules/` every session. Codex has
 * no such mechanism, so hooks/session-context.js feeds this text in on a Codex
 * SessionStart (startup, clear, compact — not resume/fork, whose context persists).
 */
import fs from "node:fs";
import path from "node:path";
import { findProjectRoot } from "../shared/lib.mjs";

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
 * The rules text for a session started in `cwd` (mirrors how Claude presents
 * auto-loaded rules), or null when there are none: every scope's rules from the
 * project root down to cwd, or the project root's own when no scope exists.
 */
export function rulesContext(cwd) {
  const projectRoot = findProjectRoot(path.resolve(cwd));
  const scopeChain = findScopeChain(cwd, projectRoot);
  const files = scopeChain.length ? collectChainRuleFiles(scopeChain) : collectRuleFiles(projectRoot);
  return buildContextFromFiles(projectRoot, files);
}
