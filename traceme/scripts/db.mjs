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
      id                    TEXT PRIMARY KEY,
      date                  TEXT NOT NULL,
      project               TEXT NOT NULL,
      project_path          TEXT,
      repo_origin           TEXT NOT NULL DEFAULT '',
      branch                TEXT,
      started_at            TEXT NOT NULL,
      ended_at              TEXT,
      prompt_count          INTEGER DEFAULT 0,
      input_tokens          INTEGER DEFAULT 0,
      output_tokens         INTEGER DEFAULT 0,
      cache_read_tokens     INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      total_tokens          INTEGER DEFAULT 0,
      total_cost            REAL DEFAULT 0.0,
      top_model             TEXT
    );

    CREATE TABLE IF NOT EXISTS session_models (
      session_id            TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      model                 TEXT NOT NULL,
      requests              INTEGER DEFAULT 0,
      input_tokens          INTEGER DEFAULT 0,
      output_tokens         INTEGER DEFAULT 0,
      cache_read_tokens     INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      cost                  REAL DEFAULT 0.0,
      PRIMARY KEY (session_id, model)
    );

    CREATE TABLE IF NOT EXISTS session_tools (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      tool_name  TEXT NOT NULL,
      count      INTEGER DEFAULT 0,
      PRIMARY KEY (session_id, tool_name)
    );

    CREATE TABLE IF NOT EXISTS session_skills (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      skill_name TEXT NOT NULL,
      count      INTEGER DEFAULT 0,
      PRIMARY KEY (session_id, skill_name)
    );

    CREATE TABLE IF NOT EXISTS session_categories (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      category   TEXT NOT NULL,
      calls      INTEGER DEFAULT 0,
      tokens     INTEGER DEFAULT 0,
      PRIMARY KEY (session_id, category)
    );

    CREATE TABLE IF NOT EXISTS daily_takeover (
      date        TEXT NOT NULL,
      repo_origin TEXT NOT NULL DEFAULT '',
      project     TEXT NOT NULL,
      tokens      INTEGER DEFAULT 0,
      PRIMARY KEY (date, repo_origin)
    );

    CREATE TABLE IF NOT EXISTS traceme_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date);
    CREATE INDEX IF NOT EXISTS idx_sessions_repo ON sessions(repo_origin);
  `);

  ensureColumns();
  return db;
}

// Idempotent additive migrations for existing DBs (CREATE TABLE IF NOT EXISTS won't add
// columns to a table that already exists). Safe to run on every open.
function ensureColumns() {
  const add = (table, col, decl) => {
    const has = db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name=?`).get(table, col);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  };
  add('session_categories', 'bytes_est', 'INTEGER DEFAULT 0');
}

export function closeDb() {
  if (db) { db.close(); db = null; dbPath = null; }
}

// ── Scan ingestion (single source of truth: jsonl-derived session facts) ──

// Idempotent replace: a session is fully recomputed from its transcript on each
// scan, so we delete its prior rows and re-insert. daily_summary / model / tool
// aggregates are all derived at query time — no additive-delta bookkeeping.
export function replaceSession(s) {
  if (!db) throw new Error('DB not open');
  db.prepare('DELETE FROM session_models WHERE session_id=?').run(s.id);
  db.prepare('DELETE FROM session_tools WHERE session_id=?').run(s.id);
  db.prepare('DELETE FROM session_skills WHERE session_id=?').run(s.id);
  db.prepare('DELETE FROM session_categories WHERE session_id=?').run(s.id);
  db.prepare('DELETE FROM sessions WHERE id=?').run(s.id);
  db.prepare(`INSERT INTO sessions
    (id, date, project, project_path, repo_origin, branch, started_at, ended_at,
     prompt_count, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
     total_tokens, total_cost, top_model)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(s.id, s.date, s.project, s.project_path || null, s.repo_origin || '', s.branch || null,
      s.started_at, s.ended_at || null, s.prompt_count || 0, s.input_tokens || 0, s.output_tokens || 0,
      s.cache_read_tokens || 0, s.cache_creation_tokens || 0, s.total_tokens || 0, s.total_cost || 0, s.top_model || null);

  const mStmt = db.prepare(`INSERT INTO session_models
    (session_id, model, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost)
    VALUES (?,?,?,?,?,?,?,?)`);
  for (const m of (s.models || [])) {
    mStmt.run(s.id, m.model, m.requests || 0, m.input || 0, m.output || 0, m.cache_read || 0, m.cache_creation || 0, m.cost || 0);
  }

  const tStmt = db.prepare('INSERT INTO session_tools (session_id, tool_name, count) VALUES (?,?,?)');
  for (const t of (s.tools || [])) tStmt.run(s.id, t.tool_name, t.count || 0);

  const skStmt = db.prepare('INSERT INTO session_skills (session_id, skill_name, count) VALUES (?,?,?)');
  for (const sk of (s.skills || [])) skStmt.run(s.id, sk.skill_name, sk.count || 0);

  const cStmt = db.prepare('INSERT INTO session_categories (session_id, category, calls, tokens, bytes_est) VALUES (?,?,?,?,?)');
  for (const c of (s.categories || [])) cStmt.run(s.id, c.category, c.calls || 0, c.tokens || 0, c.bytes_est || 0);
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

// ── Takeover tokens (separate source: not jsonl-derived) ──

export function upsertTakeoverTokens(date, project, tokens, repoOrigin = '') {
  if (!db) throw new Error('DB not open');
  db.prepare(`
    INSERT INTO daily_takeover (date, repo_origin, project, tokens)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(date, repo_origin) DO UPDATE SET
      tokens = tokens + excluded.tokens,
      project = excluded.project
  `).run(date, repoOrigin, project, tokens);
}

function takeoverByRepo(date) {
  const out = {};
  for (const r of db.prepare('SELECT repo_origin, project, tokens FROM daily_takeover WHERE date=?').all(date)) {
    out[r.repo_origin] = r;
  }
  return out;
}

// ── Derived queries (aggregate sessions at read time) ──

export function queryDailySummary(date) {
  const rows = db.prepare(`
    SELECT date, repo_origin,
           MAX(project) AS project,
           COUNT(*) AS session_count,
           SUM(prompt_count) AS prompt_count,
           SUM(input_tokens + output_tokens + cache_creation_tokens) AS billable_tokens,
           SUM(cache_read_tokens) AS cache_read_tokens,
           SUM(total_tokens) AS total_tokens,
           SUM(total_cost) AS total_cost
    FROM sessions WHERE date=? GROUP BY repo_origin
  `).all(date);

  const byRepo = {};
  for (const r of rows) {
    r.top_model = topModelForRepo(date, r.repo_origin);
    byRepo[r.repo_origin] = r;
  }

  // Fold in takeover tokens (separate source) on the matching repo bucket.
  for (const [repo, tk] of Object.entries(takeoverByRepo(date))) {
    if (byRepo[repo]) {
      byRepo[repo].total_tokens += tk.tokens;
      byRepo[repo].billable_tokens += tk.tokens; // takeover tokens are real output, not re-read cache
    } else {
      byRepo[repo] = { date, repo_origin: repo, project: tk.project, session_count: 0,
        prompt_count: 0, billable_tokens: tk.tokens, cache_read_tokens: 0, total_tokens: tk.tokens, total_cost: 0, top_model: null };
    }
  }
  return Object.values(byRepo).sort((a, b) => b.total_cost - a.total_cost);
}

function topModelForRepo(date, repoOrigin) {
  const row = db.prepare(`
    SELECT sm.model AS model, SUM(sm.requests) AS r
    FROM session_models sm JOIN sessions s ON sm.session_id = s.id
    WHERE s.date=? AND s.repo_origin=?
    GROUP BY sm.model ORDER BY r DESC LIMIT 1
  `).get(date, repoOrigin);
  return row ? row.model : null;
}

export function queryToolUsage(date) {
  return db.prepare(`
    SELECT st.tool_name AS tool_name, SUM(st.count) AS count
    FROM session_tools st JOIN sessions s ON st.session_id = s.id
    WHERE s.date=? GROUP BY st.tool_name ORDER BY count DESC
  `).all(date);
}

export function queryModelBreakdown(date) {
  // `tokens` = billable basis (excludes re-read cache); cache_read / all_tokens exposed too.
  return db.prepare(`
    SELECT sm.model AS model,
           SUM(sm.requests) AS calls,
           SUM(sm.input_tokens + sm.output_tokens + sm.cache_creation_tokens) AS tokens,
           SUM(sm.cache_read_tokens) AS cache_read,
           SUM(sm.input_tokens + sm.output_tokens + sm.cache_read_tokens + sm.cache_creation_tokens) AS all_tokens,
           SUM(sm.cost) AS cost
    FROM session_models sm JOIN sessions s ON sm.session_id = s.id
    WHERE s.date=? GROUP BY sm.model ORDER BY cost DESC
  `).all(date);
}

export function querySessionStats(date) {
  // `tokens` is the billable basis (excludes re-read cache); cache_read exposed separately.
  return db.prepare(`
    SELECT MAX(project) AS project,
           repo_origin,
           COUNT(*) AS sessions,
           COALESCE(SUM(prompt_count), 0) AS prompts,
           COALESCE(SUM(input_tokens + output_tokens + cache_creation_tokens), 0) AS tokens,
           COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
           COALESCE(SUM(total_tokens), 0) AS all_tokens,
           COALESCE(SUM(total_cost), 0) AS cost
    FROM sessions WHERE date=? GROUP BY repo_origin ORDER BY cost DESC
  `).all(date);
}

// Per (skill, project) counts over a date range — powers `traceme insights`.
export function querySkillUsage(from, to, projectLike = null) {
  const params = [from, to];
  let sql = `
    SELECT ss.skill_name AS skill_name, s.project AS project, SUM(ss.count) AS count
    FROM session_skills ss JOIN sessions s ON ss.session_id = s.id
    WHERE s.date >= ? AND s.date <= ?`;
  if (projectLike) { sql += ' AND s.project LIKE ?'; params.push(projectLike); }
  sql += ' GROUP BY ss.skill_name, s.project';
  return db.prepare(sql).all(...params);
}

// Token usage bucketed by tool category (subagent/mcp/plugin/builtin) over a range.
// Local-device only — category data is not synced.
export function queryCategoryBreakdown(from, to, projectLike = null) {
  const params = [from, to];
  let sql = `
    SELECT sc.category AS category, SUM(sc.calls) AS calls,
           SUM(sc.tokens) AS tokens, SUM(sc.bytes_est) AS bytes_est
    FROM session_categories sc JOIN sessions s ON sc.session_id = s.id
    WHERE s.date >= ? AND s.date <= ?`;
  if (projectLike) { sql += ' AND s.project LIKE ?'; params.push(projectLike); }
  sql += ' GROUP BY sc.category ORDER BY tokens DESC';
  return db.prepare(sql).all(...params);
}

// ── Flat fact tables over a date range (power the interactive dashboard) ──
// Each row keeps date + project so the browser can re-filter/aggregate any sub-range
// and project subset client-side. Token components stay separate so the client can
// pick a billable basis (input+output+cache_creation) vs. cache_read on demand.

export function queryModelFacts(from, to) {
  return db.prepare(`
    SELECT s.date AS date, s.project AS project, sm.model AS model,
           SUM(sm.requests) AS requests,
           SUM(sm.input_tokens) AS input,
           SUM(sm.output_tokens) AS output,
           SUM(sm.cache_read_tokens) AS cache_read,
           SUM(sm.cache_creation_tokens) AS cache_creation,
           SUM(sm.input_tokens + sm.output_tokens + sm.cache_read_tokens + sm.cache_creation_tokens) AS tokens,
           SUM(sm.cost) AS cost
    FROM session_models sm JOIN sessions s ON sm.session_id = s.id
    WHERE s.date >= ? AND s.date <= ?
    GROUP BY s.date, s.project, sm.model
    ORDER BY s.date ASC
  `).all(from, to);
}

export function queryCategoryFacts(from, to) {
  return db.prepare(`
    SELECT s.date AS date, s.project AS project, sc.category AS category,
           SUM(sc.calls) AS calls, SUM(sc.tokens) AS tokens, SUM(sc.bytes_est) AS bytes_est
    FROM session_categories sc JOIN sessions s ON sc.session_id = s.id
    WHERE s.date >= ? AND s.date <= ?
    GROUP BY s.date, s.project, sc.category
    ORDER BY s.date ASC
  `).all(from, to);
}

export function querySkillFacts(from, to) {
  return db.prepare(`
    SELECT s.date AS date, s.project AS project, ss.skill_name AS skill_name,
           SUM(ss.count) AS count
    FROM session_skills ss JOIN sessions s ON ss.session_id = s.id
    WHERE s.date >= ? AND s.date <= ?
    GROUP BY s.date, s.project, ss.skill_name
    ORDER BY s.date ASC
  `).all(from, to);
}

export function querySessionFacts(from, to) {
  return db.prepare(`
    SELECT date, project, started_at, ended_at, prompt_count, total_tokens, total_cost
    FROM sessions
    WHERE date >= ? AND date <= ?
    ORDER BY started_at ASC
  `).all(from, to);
}

export function queryDbStats() {
  const sessions = db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c;
  const prompts = db.prepare('SELECT COALESCE(SUM(prompt_count),0) AS c FROM sessions').get().c;
  const tool_calls = db.prepare('SELECT COALESCE(SUM(count),0) AS c FROM session_tools').get().c;
  return { sessions, prompts, tool_calls };
}

// ── Maintenance ──

export function deleteSession(id) {
  db.prepare('DELETE FROM session_models WHERE session_id=?').run(id);
  db.prepare('DELETE FROM session_tools WHERE session_id=?').run(id);
  db.prepare('DELETE FROM session_skills WHERE session_id=?').run(id);
  db.prepare('DELETE FROM session_categories WHERE session_id=?').run(id);
  return db.prepare('DELETE FROM sessions WHERE id=?').run(id).changes;
}

export function allSessionIds() {
  return db.prepare('SELECT id FROM sessions').all().map(r => r.id);
}
