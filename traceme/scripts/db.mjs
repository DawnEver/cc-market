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

    CREATE INDEX IF NOT EXISTS idx_prompts_session ON prompts(session_id);
    CREATE INDEX IF NOT EXISTS idx_prompts_ts ON prompts(timestamp);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_ts ON tool_calls(timestamp);
    CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_summary(date);
  `);
  return db;
}

export function closeDb() {
  if (db) { db.close(); db = null; dbPath = null; }
}

// ── Session CRUD ──

export function insertSession(session) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO sessions (id, project, project_path, branch, started_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(session.id, session.project, session.project_path, session.branch, session.started_at);
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

export function batchUpdatePromptTokens(prompts) {
  const stmt = db.prepare(`
    UPDATE prompts SET input_tokens=?, output_tokens=?, cache_tokens=?, cost_usd=?, model=?, duration_ms=?
    WHERE id=?
  `);
  for (const p of prompts) {
    stmt.run(p.input_tokens, p.output_tokens, p.cache_tokens, p.cost_usd, p.model, p.duration_ms, p.id);
  }
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
  const stmt = db.prepare(`
    INSERT INTO daily_summary (date, project, session_count, prompt_count, total_tokens, total_cost, top_model)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, project) DO UPDATE SET
      session_count = session_count + excluded.session_count,
      prompt_count  = prompt_count + excluded.prompt_count,
      total_tokens  = total_tokens + excluded.total_tokens,
      total_cost    = total_cost + excluded.total_cost,
      top_model     = excluded.top_model
  `);
  stmt.run(date, project, data.session_count, data.prompt_count, data.total_tokens, data.total_cost, data.top_model);
}

// ── Queries ──

export function queryDailySummary(date) {
  const stmt = db.prepare('SELECT * FROM daily_summary WHERE date = ? ORDER BY total_cost DESC');
  return stmt.all(date);
}

export function queryTopPrompts(date, limit = 10) {
  const stmt = db.prepare(`
    SELECT p.*, s.project
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

export function querySessionStats(date) {
  const stmt = db.prepare(`
    SELECT s.project,
           COUNT(*) as sessions,
           COALESCE(SUM(s.prompt_count), 0) as prompts,
           COALESCE(SUM(s.total_tokens), 0) as tokens,
           COALESCE(SUM(s.total_cost), 0) as cost
    FROM sessions s
    WHERE date(s.started_at) = ?
    GROUP BY s.project
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
