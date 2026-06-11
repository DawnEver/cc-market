import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TRACEME_DIR } from './lib.mjs';

// --- Takeover trace scanning (NDJSON contract, no code dependency) ---
//
// Token usage from takeover (other-model) requests does not flow through the
// Claude Code transcript, so it cannot be derived by scan.mjs. The takeover
// plugin appends one NDJSON record per request to this file; we fold the totals
// into daily_takeover.

const TAKEOVER_TRACES_FILE = join(TRACEME_DIR, 'takeover_traces.jsonl');

export function scanTakeoverTraces(date, since = null) {
  const traces = [];
  let maxTs = since || null;
  try {
    const raw = readFileSync(TAKEOVER_TRACES_FILE, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.ts && rec.ts.slice(0, 10) === date) {
          if (since && rec.ts <= since) continue;
          traces.push(rec);
          if (!maxTs || rec.ts > maxTs) maxTs = rec.ts;
        }
      } catch {}
    }
  } catch {
    return { traces: [], totalTokens: 0, totalInput: 0, totalOutput: 0, byProvider: {}, maxTs };
  }

  let totalInput = 0, totalOutput = 0;
  const byProvider = {};

  for (const t of traces) {
    totalInput += t.input_tokens || 0;
    totalOutput += t.output_tokens || 0;
    const key = `${t.provider}/${t.model}`;
    if (!byProvider[key]) byProvider[key] = { provider: t.provider, model: t.model, input_tokens: 0, output_tokens: 0, count: 0 };
    byProvider[key].input_tokens += t.input_tokens || 0;
    byProvider[key].output_tokens += t.output_tokens || 0;
    byProvider[key].count++;
  }

  return {
    traces,
    totalTokens: totalInput + totalOutput,
    totalInput,
    totalOutput,
    byProvider: Object.values(byProvider),
    maxTs,
  };
}
