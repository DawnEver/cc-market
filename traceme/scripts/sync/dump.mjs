import { openDb, queryDailySummary, queryToolUsage } from '../db.mjs';
import { getDeviceId } from './repo.mjs';

export function dumpDailyData(date) {
  const db = openDb();
  return {
    version: 1,
    date,
    device: getDeviceId(),
    generated_at: new Date().toISOString(),
    daily_summary: queryDailySummary(date).map(r => ({
      project: r.project,
      repo_origin: r.repo_origin,
      session_count: r.session_count,
      prompt_count: r.prompt_count,
      total_tokens: r.total_tokens,
      total_cost: Math.round(r.total_cost * 100000) / 100000,
      top_model: r.top_model
    })),
    tool_usage: queryToolUsage(date),
    sessions: db.prepare(`
      SELECT id, project, repo_origin, branch, started_at, ended_at, prompt_count, total_tokens, total_cost
      FROM sessions WHERE date(started_at) = ?
    `).all(date).map(r => ({
      ...r,
      total_cost: Math.round(r.total_cost * 100000) / 100000
    })),
  };
}

// NOTE: foreign device data is deliberately NOT written into the local SQLite
// DB. Cross-device aggregation happens entirely in memory in readMergedSnapshot,
// which reads each device's `.enc` file exactly once — so it is idempotent no
// matter how many times you pull. Writing foreign rows into local `daily_summary`
// was non-idempotent (every pull SUMmed the same snapshot again, inflating
// totals) AND leaked foreign data into this device's own pushed snapshot, since
// dumpDailyData exports the whole table. Local SQLite holds THIS device only —
// the same privacy/ownership boundary already applied to tool_usage.
export function importDailyData(data) {
  return {
    projects: (data.daily_summary || []).length,
    sessions: (data.sessions || []).length,
    device: data.device,
  };
}
