const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const STATUSES = ['open', 'in_progress', 'done', 'wont_fix'];
const VERDICTS = ['true_positive', 'needs_review', 'false_positive'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description    TEXT,
  api_key_hash   TEXT NOT NULL UNIQUE,
  api_key_prefix TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scans (
  id              INTEGER PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch          TEXT,
  commit_sha      TEXT,
  run_url         TEXT,
  triggered_by    TEXT,
  engine          TEXT,
  model           TEXT,
  summary         TEXT,
  report_markdown TEXT,
  finding_count   INTEGER NOT NULL DEFAULT 0,
  new_count       INTEGER NOT NULL DEFAULT 0,
  reopened_count  INTEGER NOT NULL DEFAULT 0,
  received_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS scans_project ON scans(project_id, id);

CREATE TABLE IF NOT EXISTS findings (
  id                 INTEGER PRIMARY KEY,
  project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint        TEXT NOT NULL,
  rule_id            TEXT,
  title              TEXT NOT NULL,
  file               TEXT,
  line               INTEGER,
  locations          TEXT NOT NULL DEFAULT '[]',
  severity           TEXT NOT NULL,
  severity_rank      INTEGER NOT NULL,
  severity_locked    INTEGER NOT NULL DEFAULT 0,
  verdict            TEXT NOT NULL,
  reasoning          TEXT,
  fix                TEXT,
  status             TEXT NOT NULL DEFAULT 'open',
  assignee_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  first_seen_scan_id INTEGER,
  last_seen_scan_id  INTEGER,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at        TEXT,
  UNIQUE (project_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS findings_list ON findings(project_id, status, severity_rank);
CREATE INDEX IF NOT EXISTS findings_assignee ON findings(assignee_id);

CREATE TABLE IF NOT EXISTS activity (
  id         INTEGER PRIMARY KEY,
  finding_id INTEGER NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL,
  message    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS activity_finding ON activity(finding_id, id);
`;

function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Additive migrations for databases created by earlier versions. */
function migrate(db) {
  const projectCols = db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
  if (!projectCols.includes('scan_interval_days')) {
    // NULL = use the server default (SCAN_INTERVAL_DAYS)
    db.exec('ALTER TABLE projects ADD COLUMN scan_interval_days REAL');
  }
  // Cover image per project, kept out of the projects table so project lists stay small
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_covers (
      project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      mime       TEXT NOT NULL,
      data       BLOB NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
}

/** Runs fn inside a transaction; rolls back on error. */
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value
  );
}

module.exports = {
  openDb,
  transaction,
  getSetting,
  setSetting,
  SEVERITIES,
  SEVERITY_RANK,
  STATUSES,
  VERDICTS,
};
