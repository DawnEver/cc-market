// trace.mjs — TraceMe NDJSON emission + structured request logging (stderr ndjson).
// Re-exported via scripts/lib.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// ── TraceMe integration (NDJSON contract, no code dependency) ───────────────

const TRACEME_DIR = path.join(os.homedir(), '.claude', 'traceme');
const TAKEOVER_TRACES_FILE = path.join(TRACEME_DIR, 'takeover_traces.jsonl');

function parseTokenCount(s) {
  const t = String(s).trim().toLowerCase();
  if (t.endsWith('k')) return Math.round(parseFloat(t) * 1000);
  return parseInt(t, 10) || 0;
}

export function extractUsageFromStderr(stderr) {
  const m = stderr.match(/Tokens:\s+(\S+)\s+input,\s+(\S+)\s+output/);
  if (!m) return null;
  return { input_tokens: parseTokenCount(m[1]), output_tokens: parseTokenCount(m[2]) };
}

export function emitTakeoverTrace(entry) {
  try {
    if (!fs.existsSync(TRACEME_DIR)) fs.mkdirSync(TRACEME_DIR, { recursive: true });
    fs.appendFileSync(TAKEOVER_TRACES_FILE, JSON.stringify(entry) + '\n');
  } catch {}
}

// ── Structured request logging (ndjson to stderr) ──────────────────────────

let _requestSeq = 0;

export function logTakeoverRequest(startTs, provider, model, mode, status, { durationMs, inputTokens, outputTokens, error } = {}) {
  _requestSeq++;
  const entry = {
    ts: startTs,
    request_id: `tk-${startTs.replace(/[^0-9]/g, '').slice(0, 14)}-${String(_requestSeq).padStart(4, '0')}`,
    provider,
    model: model || 'default',
    mode: mode || 'task',
    status,
    duration_ms: durationMs,
    input_tokens: inputTokens || 0,
    output_tokens: outputTokens || 0,
    ...(error ? { error: error.slice(0, 200) } : {}),
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}
