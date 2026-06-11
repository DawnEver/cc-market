import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { getDbPath } from './lib.mjs';

let db = null;
let dbPath = null;

export function openDb(opts = {}) {
  const path = opts.path || getDbPath();
  if (db && dbPath === path) return db;
  if (db) { db.close(); db = null; dbPath = null; }
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(path);
  dbPath = path;
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('PRAGMA busy_timeout=5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,
      project       TEXT NOT NULL,
      project_path  TEXT NOT NULL,
      branch        TEXT,
      started_at    TEXT NOT NULL,
      ended_at      TEXT,
      prompt_count  INTEGER DEFAULT 0,
      total_tokens  INTEGER DEFAULT 0,
      total_cost    REAL DEFAULT 0.0
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL REFERENCES sessions(id),
      turn_index    INTEGER NOT NULL,
      text          TEXT,
      timestamp     TEXT NOT NULL,
      input_tokens  INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_tokens  INTEGER DEFAULT 0,
      cost_usd      REAL DEFAULT 0.0,
      model         TEXT,
      duration_ms   INTEGER
    );

    CREATE TABLE IF NOT EXISTS tool_calls (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL REFERENCES sessions(id),
      prompt_id     TEXT REFERENCES prompts(id),
      tool_name     TEXT NOT NULL,
      summary       TEXT,
      timestamp     TEXT NOT NULL,
      duration_ms   INTEGER
    );

    CREATE TABLE IF NOT EXISTS daily_summary (
      date          TEXT NOT NULL,
      project       TEXT NOT NULL,
      session_count INTEGER DEFAULT 0,
      prompt_count  INTEGER DEFAULT 0,
      total_tokens  INTEGER DEFAULT 0,
      total_cost    REAL DEFAULT 0.0,
      top_model     TEXT,
      PRIMARY KEY (date, project)
    );

    CREATE TABLE IF NOT EXISTS traceme_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_prompts_session ON prompts(session_id);
    CREATE INDEX IF NOT EXISTS idx_prompts_ts ON prompts(timestamp);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_ts ON tool_calls(timestamp);
    CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_summary(date);
  `);

  const sessCols = db.prepare("PRAGMA table_info('sessions')").all().map(c => c.name);
  if (!sessCols.includes('repo_origin')) {
    db.exec("ALTER TABLE sessions ADD COLUMN repo_origin TEXT");
  }
  const dsCols = db.prepare("PRAGMA table_info('daily_summary')").all().map(c => c.name);
  if (!dsCols.includes('repo_origin')) {
    db.exec(`
      CREATE TABLE daily_summary_new (
        date          TEXT NOT NULL,
        project       TEXT NOT NULL,
        repo_origin   TEXT NOT NULL DEFAULT '',
        session_count INTEGER DEFAULT 0,
        prompt_count  INTEGER DEFAULT 0,
        total_tokens  INTEGER DEFAULT 0,
        total_cost    REAL DEFAULT 0.0,
        top_model     TEXT,
        PRIMARY KEY (date, repo_origin)
      );
      INSERT INTO daily_summary_new SELECT date, project, '', session_count, prompt_count, total_tokens, total_cost, top_model FROM daily_summary;
      DROP TABLE daily_summary;
      ALTER TABLE daily_summary_new RENAME TO daily_summary;
      CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_summary(date);
    `);
  }

  return db;
}

export function closeDb() {
  if (db) { db.close(); db = null; dbPath = null; }
}

// ── Session CRUD ──

export function insertSession(session) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO sessions (id, project, project_path, repo_origin, branch, started_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(session.id, session.project, session.project_path, session.repo_origin, session.branch, session.started_at);
}

export function closeSession(id, endedAt) {
  const stmt = db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?');
  stmt.run(endedAt, id);
}

// ── Prompt CRUD ──

export function insertPrompt(prompt) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO prompts (id, session_id, turn_index, text, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(prompt.id, prompt.session_id, prompt.turn_index, prompt.text, prompt.timestamp);
}

// ── Tool Call CRUD ──

export function insertToolCall(tc) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO tool_calls (id, session_id, prompt_id, tool_name, summary, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(tc.id, tc.session_id, tc.prompt_id || null, tc.tool_name, tc.summary, tc.timestamp);
}

// ── Daily Summary ──

export function upsertDailySummary(date, project, data) {
  const repoOrigin = data.repo_origin || '';
  const existing = db.prepare('SELECT * FROM daily_summary WHERE date=? AND repo_origin=?').get(date, repoOrigin);
  if (existing) {
    db.prepare(`UPDATE daily_summary SET
      session_count = session_count + ?,
      prompt_count  = prompt_count + ?,
      total_tokens  = total_tokens + ?,
      total_cost    = total_cost + ?,
      top_model     = COALESCE(?, top_model),
      project       = ?
      WHERE date=? AND repo_origin=?`)
      .run(data.session_count, data.prompt_count, data.total_tokens, data.total_cost, data.top_model, project, date, repoOrigin);
  } else {
    db.prepare('INSERT INTO daily_summary (date, project, repo_origin, session_count, prompt_count, total_tokens, total_cost, top_model) VALUES (?,?,?,?,?,?,?,?)')
      .run(date, project, repoOrigin, data.session_count, data.prompt_count, data.total_tokens, data.total_cost, data.top_model);
  }
}

// ── Metadata ──

export function getMeta(key) {
  if (!db) throw new Error('DB not open');
  const row = db.prepare('SELECT value FROM traceme_meta WHERE key=?').get(key);
  return row ? row.value : null;
}

export function setMeta(key, value) {
  if (!db) throw new Error('DB not open');
  db.prepare('INSERT OR REPLACE INTO traceme_meta (key, value) VALUES (?, ?)').run(key, String(value));
}

// ── Takeover Tokens (idempotent delta, only touches total_tokens) ──

export function upsertTakeoverTokens(date, project, tokens, repoOrigin = '') {
  if (!db) throw new Error('DB not open');
  db.prepare(`
    INSERT INTO daily_summary (date, project, repo_origin, session_count, prompt_count, total_tokens, total_cost)
    VALUES (?, ?, ?, 0, 0, ?, 0)
    ON CONFLICT(date, repo_origin) DO UPDATE SET
      total_tokens = total_tokens + excluded.total_tokens,
      project = excluded.project
  `).run(date, project, repoOrigin, tokens);
}

// ── Queries ──

export function queryDailySummary(date) {
  const stmt = db.prepare('SELECT * FROM daily_summary WHERE date = ? ORDER BY total_cost DESC');
  return stmt.all(date);
}

export function queryTopPrompts(date, limit = 10) {
  const stmt = db.prepare(`
    SELECT p.*, s.project, s.repo_origin
    FROM prompts p JOIN sessions s ON p.session_id = s.id
    WHERE date(p.timestamp) = ?
    ORDER BY p.cost_usd DESC
    LIMIT ?
  `);
  return stmt.all(date, limit);
}

export function queryToolUsage(date) {
  const stmt = db.prepare(`
    SELECT tool_name, COUNT(*) as count
    FROM tool_calls
    WHERE date(timestamp) = ?
    GROUP BY tool_name
    ORDER BY count DESC
  `);
  return stmt.all(date);
}

export function queryModelBreakdown(date) {
  const stmt = db.prepare('SELECT model, COUNT(*) as calls, SUM(input_tokens + output_tokens + COALESCE(cache_tokens, 0)) as tokens, SUM(cost_usd) as cost FROM prompts WHERE date(timestamp) = ? AND model IS NOT NULL GROUP BY model ORDER BY cost DESC');
  return stmt.all(date);
}

export function querySessionStats(date) {
  const stmt = db.prepare(`
    SELECT s.project,
           s.repo_origin,
           COUNT(*) as sessions,
           COALESCE(SUM(s.prompt_count), 0) as prompts,
           COALESCE(SUM(s.total_tokens), 0) as tokens,
           COALESCE(SUM(s.total_cost), 0) as cost
    FROM sessions s
    WHERE date(s.started_at) = ?
    GROUP BY COALESCE(s.repo_origin, s.project_path, s.project)
    ORDER BY cost DESC
  `);
  return stmt.all(date);
}

export function queryDbStats() {
  const tables = ['sessions', 'prompts', 'tool_calls', 'daily_summary'];
  const stats = {};
  for (const t of tables) {
    const row = db.prepare(`SELECT COUNT(*) as count FROM ${t}`).get();
    stats[t] = row.count;
  }
  return stats;
}

export function nullifyOldPrompts(days) {
  if (!db) throw new Error('DB not open');
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const result = db.prepare("UPDATE prompts SET text = NULL WHERE date(timestamp) < ? AND text IS NOT NULL").run(cutoffStr);
  return result.changes;
}

export function nullifyOldToolCalls(days) {
  if (!db) throw new Error('DB not open');
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const result = db.prepare("UPDATE tool_calls SET summary = NULL WHERE date(timestamp) < ? AND summary IS NOT NULL").run(cutoffStr);
  return result.changes;
}

export function deleteOldToolCalls(days) {
  if (!db) throw new Error('DB not open');
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const result = db.prepare('DELETE FROM tool_calls WHERE date(timestamp) < ?').run(cutoffStr);
  return result.changes;
}

export function countOldToolCalls(days) {
  if (!db) throw new Error('DB not open');
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return db.prepare('SELECT COUNT(*) as count FROM tool_calls WHERE date(timestamp) < ?').get(cutoffStr).count;
}

export function countOldPrompts(days, onlyWithText = false) {
  if (!db) throw new Error('DB not open');
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  if (onlyWithText) {
    return db.prepare('SELECT COUNT(*) as count FROM prompts WHERE date(timestamp) < ? AND text IS NOT NULL').get(cutoffStr).count;
  }
  return db.prepare('SELECT COUNT(*) as count FROM prompts WHERE date(timestamp) < ?').get(cutoffStr).count;
}

export function countOldPromptsDate(cutoffDate) {
  return db.prepare('SELECT COUNT(*) as count FROM prompts WHERE date(timestamp) < ?').get(cutoffDate).count;
}
export function countOldPromptsWithTextDate(cutoffDate) {
  return db.prepare('SELECT COUNT(*) as count FROM prompts WHERE date(timestamp) < ? AND text IS NOT NULL').get(cutoffDate).count;
}
export function countOldToolCallsDate(cutoffDate) {
  return db.prepare('SELECT COUNT(*) as count FROM tool_calls WHERE date(timestamp) < ?').get(cutoffDate).count;
}
export function nullifyOldPromptsDate(cutoffDate) {
  return db.prepare("UPDATE prompts SET text = NULL WHERE date(timestamp) < ? AND text IS NOT NULL").run(cutoffDate).changes;
}
export function nullifyOldToolCallsDate(cutoffDate) {
  return db.prepare("UPDATE tool_calls SET summary = NULL WHERE date(timestamp) < ? AND summary IS NOT NULL").run(cutoffDate).changes;
}
export function deleteOldToolCallsDate(cutoffDate) {
  return db.prepare('DELETE FROM tool_calls WHERE date(timestamp) < ?').run(cutoffDate).changes;
}
