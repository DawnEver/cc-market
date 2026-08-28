#!/usr/bin/env node
/**
 * Second lock on manuscript confidentiality.
 *
 * The first lock is in the CLI: no command prints manuscript body text, only
 * the sanitized record. That one holds on any host. This hook exists because
 * Claude Code can additionally stop a well-meaning agent from opening the raw
 * PDF directly -- and being told "do not read this" in a prompt is not a
 * control.
 *
 * Codex has no equivalent, which is exactly why the CLI, not this file, is the
 * guarantee.
 */

import { readFileSync } from "node:fs";

const BLOCKED = [
  /[\/]0-raw\.pdf$/i,
  /[\/]reviewer-discovery[\/][^\/]+[\/]0-raw\./i,
];

function readInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

const input = readInput();
const target =
  input?.tool_input?.file_path ??
  input?.tool_input?.path ??
  input?.tool_input?.pattern ??
  "";

if (typeof target === "string" && BLOCKED.some((pattern) => pattern.test(target))) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "The raw manuscript is confidential and must not enter model context. " +
          "Read 1-manuscript/sanitized.json instead -- title, abstract, keywords " +
          "and author metadata, which is everything the workflow needs.",
      },
    })
  );
  process.exit(0);
}

process.exit(0);
