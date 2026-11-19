#!/usr/bin/env node
/**
 * Second lock on manuscript confidentiality.
 *
 * The first lock is in the CLI: no command prints manuscript body text, only
 * the sanitized record. That one holds on any host. This hook exists because
 * Claude Code (and Antigravity, via the generated root hooks.json) can
 * additionally stop a well-meaning agent from opening the raw PDF directly --
 * and being told "do not read this" in a prompt is not a control.
 *
 * Codex has no equivalent, which is exactly why the CLI, not this file, is the
 * guarantee.
 */

import { readStdinJSON } from "../shared/lib.mjs";
import { isAgyHost, normalizeHookInput, hookOutput, emitHookOutput } from "../shared/hook-facts.mjs";

const BLOCKED = [
  /[\\/]0-raw\.pdf$/i,
  /[\\/]reviewer-discovery[\\/][^\\/]+[\\/]0-raw\./i,
];

const REASON =
  "The raw manuscript is confidential and must not enter model context. " +
  "Read 1-manuscript/sanitized.json instead -- title, abstract, keywords " +
  "and author metadata, which is everything the workflow needs.";

export function isBlockedTarget(input) {
  const target =
    input?.tool_input?.file_path ??
    input?.tool_input?.path ??
    input?.tool_input?.pattern ??
    "";
  return typeof target === "string" && BLOCKED.some((pattern) => pattern.test(target));
}

const raw = readStdinJSON() || {};
const host = isAgyHost(raw) ? "agy" : "claude";
emitHookOutput(hookOutput({
  host,
  event: "PreToolUse",
  kind: isBlockedTarget(normalizeHookInput(raw)) ? "deny" : "none",
  reason: REASON,
}));
