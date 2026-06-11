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

export function importDailyData(data) {
  const db = openDb();

  // Merge daily_summary — SUM across devices (matches aggregate logic on main)
  for (const row of (data.daily_summary || [])) {
    const repoOrigin = row.repo_origin || row.project || '';
    const existing = db.prepare(
      'SELECT * FROM daily_summary WHERE date=? AND repo_origin=?'
    ).get(data.date, repoOrigin);
    if (existing) {
      db.prepare(`
        UPDATE daily_summary SET
          session_count = session_count + ?,
          prompt_count  = prompt_count + ?,
          total_tokens  = total_tokens + ?,
          total_cost    = total_cost + ?,
          top_model     = COALESCE(?, top_model),
          project       = ?
        WHERE date=? AND repo_origin=?
      `).run(row.session_count, row.prompt_count, row.total_tokens, row.total_cost, row.top_model, row.project, data.date, repoOrigin);
    } else {
      db.prepare(`
        INSERT INTO daily_summary (date, project, repo_origin, session_count, prompt_count, total_tokens, total_cost, top_model)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(data.date, row.project, repoOrigin, row.session_count, row.prompt_count, row.total_tokens, row.total_cost, row.top_model);
    }
  }

  // Merge sessions (skip duplicates by id)
  for (const s of (data.sessions || [])) {
    const exists = db.prepare('SELECT 1 FROM sessions WHERE id=?').get(s.id);
    if (!exists) {
      db.prepare(`
        INSERT OR IGNORE INTO sessions (id, project, project_path, repo_origin, branch, started_at, ended_at, prompt_count, total_tokens, total_cost)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(s.id, s.project, s.project || 'unknown', s.repo_origin || '', s.branch, s.started_at, s.ended_at, s.prompt_count, s.total_tokens, s.total_cost);
    }
  }

  // tool_usage (and skill_usage) are intentionally NOT imported into the local
  // tool_calls table. Cross-device tool usage is aggregated by readMergedSnapshot
  // (which merges tool_usage from all device snapshots in memory). The local DB's
  // tool_calls table is meant for this device only — privacy boundary.

  console.log(`Imported: ${(data.daily_summary || []).length} project summaries, ${(data.sessions || []).length} sessions from ${data.device}`);
}
