// engine/observe-reader.mjs — read + interpret the observe proxy's http.jsonl.
// The proxy writes flat rows (t:'request'|'response'|'error'); this pairs them by id and
// filters to real main turns, mirroring cc-lab's tap reader responsibility. Kept separate
// from the proxy so capture stays dumb and analysis stays here.

import { readFileSync, existsSync } from 'node:fs';

/** Parse http.jsonl into rows. Returns [] if the file is absent/empty. */
export function loadRows(jsonlPath) {
  if (!existsSync(jsonlPath)) return [];
  const text = readFileSync(jsonlPath, 'utf8').trim();
  if (!text) return [];
  return text.split('\n').map((l) => JSON.parse(l));
}

/**
 * Pair request rows with their response/error by id → [{id, request, response, error}].
 * Preserves request order.
 */
export function pair(rows) {
  const byId = new Map();
  for (const row of rows) {
    const e = byId.get(row.id) || { id: row.id };
    if (row.t === 'request') e.request = row;
    else if (row.t === 'response') e.response = row;
    else if (row.t === 'error') e.error = row;
    byId.set(row.id, e);
  }
  return [...byId.values()].sort((a, b) => (a.request?.ts ?? 0) - (b.request?.ts ?? 0));
}

/** True for the client's `max_tokens:1` "quota" probe to /v1/messages?beta=true (404). */
export function isQuotaProbe(entry) {
  const p = entry.request?.path || '';
  const body = entry.request?.body;
  const tiny = body && typeof body === 'object' && body.max_tokens === 1;
  return p.includes('beta=true') && (tiny || entry.response?.status === 404);
}

/**
 * Real assistant turns: a POST to /v1/messages that returned 200 with a messages array,
 * excluding the quota probe. This is the primary analysis target.
 */
export function mainTurns(rows) {
  return pair(rows).filter((e) => {
    if (!e.request || !e.response) return false;
    if (e.response.status !== 200) return false;
    if (!/\/v1\/messages/.test(e.request.path)) return false;
    if (isQuotaProbe(e)) return false;
    const b = e.request.body;
    return b && typeof b === 'object' && Array.isArray(b.messages);
  });
}

/** One-line-per-field rollup for quick eyeballing / assertions. */
export function summarize(rows) {
  const turns = mainTurns(rows);
  return {
    totalRows: rows.length,
    requests: rows.filter((r) => r.t === 'request').length,
    errors: rows.filter((r) => r.t === 'error').length,
    mainTurns: turns.length,
    models: [...new Set(turns.map((t) => t.request.modelAfter).filter(Boolean))],
    providers: [...new Set(turns.map((t) => t.request.provider).filter(Boolean))],
  };
}

/** Convenience: load + summarize a jsonl file in one call. */
export function summarizeFile(jsonlPath) {
  return summarize(loadRows(jsonlPath));
}
