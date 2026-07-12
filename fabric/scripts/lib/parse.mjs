// parse.mjs — command-block flag parsing, system-prompt building, response text
// extraction. Re-exported via scripts/lib.mjs.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { SCRIPT_DIR } from "./config.mjs";

// ── Command block parsing ──────────────────────────────────────────────────────

export function parseCommandBlock(prompt) {
  if (prompt == null) return { flags: {}, cleanPrompt: prompt || "" };
  const re = /^\s*<command>\s*\n?(.*?)\n?\s*<\/command>\s*\n?/s;
  const match = prompt.match(re);
  if (!match) return { flags: {}, cleanPrompt: prompt };

  const cmdText = match[1].trim();
  const flags = {};

  const providerMatch = cmdText.match(/--provider\s+(\S+)/);
  if (providerMatch) flags.provider = providerMatch[1];

  const modelMatch = cmdText.match(/--model\s+(\S+)/);
  if (modelMatch) flags.model = modelMatch[1];

  if (cmdText.match(/--review/)) flags.mode = "review";
  if (cmdText.match(/--image-edit/)) flags.mode = "image-edit";
  else if (cmdText.match(/--image/)) flags.mode = "image-generate";

  if (cmdText.match(/--write/)) flags.write = true;

  const cleanPrompt = prompt.replace(re, "");
  return { flags, cleanPrompt };
}

// ── Prompt building ──────────────────────────────────────────────────────────

export function buildPrompt(subcommand, userPrompt) {
  const promptsDir = path.join(SCRIPT_DIR, "..", "prompts");
  let systemPrompt = "";
  const templateFile = path.join(promptsDir, `${subcommand}.md`);
  if (fs.existsSync(templateFile)) {
    systemPrompt = fs.readFileSync(templateFile, "utf8").trim();
  }
  return { systemPrompt, userPrompt: userPrompt.trim() };
}

// ── Text extraction ──────────────────────────────────────────────────────────

export function truncateText(text, maxChars = 0) {
  if (!text || maxChars <= 0 || text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n\n[...truncated ${text.length - maxChars} chars, ${Math.round((text.length - maxChars) / 4)} tok est.]`;
}

export function extractText(data) {
  const content = data.content || [];
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  if (!text && content.length > 0) {
    const types = [...new Set(content.map((b) => b.type))].join(", ");
    process.stderr.write(`fabric: warning — response contained no text blocks (got: ${types})\n`);
  }
  return text;
}
