// SQLite storage via Node's built-in node:sqlite. No native dependencies to install.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical } from './rules.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','approver','member')),
  pw_hash TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, last_used_at INTEGER);
CREATE TABLE IF NOT EXISTS launches (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '',
  owner_id INTEGER NOT NULL REFERENCES users(id), target_date TEXT,
  status TEXT NOT NULL DEFAULT 'BLOCKED', archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY, launch_id INTEGER NOT NULL REFERENCES launches(id) ON DELETE CASCADE,
  label TEXT NOT NULL, type TEXT NOT NULL, critical INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL DEFAULT '{}', sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY, check_id INTEGER NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
  launch_id INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('pass','fail','unknown')),
  summary TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '{}', ran_at INTEGER NOT NULL,
  ran_by INTEGER REFERENCES users(id), duration_ms INTEGER NOT NULL DEFAULT 0, attested INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS runs_check ON runs(check_id, ran_at DESC);
CREATE TABLE IF NOT EXISTS exceptions (
  id INTEGER PRIMARY KEY, check_id INTEGER NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
  launch_id INTEGER NOT NULL, reason TEXT NOT NULL, accepted_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL, expires_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY, launch_id INTEGER NOT NULL REFERENCES launches(id) ON DELETE CASCADE,
  approver_id INTEGER NOT NULL REFERENCES users(id), decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  fingerprint TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY, launch_id INTEGER NOT NULL REFERENCES launches(id) ON DELETE CASCADE,
  assignee_id INTEGER NOT NULL REFERENCES users(id), due_at INTEGER NOT NULL, note TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, resolved_at INTEGER);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor_id INTEGER, action TEXT NOT NULL,
  launch_id INTEGER, data TEXT NOT NULL DEFAULT '{}', prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
`;

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  const metaGet = db.prepare('SELECT value FROM meta WHERE key = ?');
  const metaSet = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  if (!metaGet.get('schema_version')) metaSet.run('schema_version', '1');

  const api = {
    raw: db,
    all: (sql, ...p) => db.prepare(sql).all(...p),
    get: (sql, ...p) => db.prepare(sql).get(...p),
    run: (sql, ...p) => db.prepare(sql).run(...p),
    meta: { get: k => metaGet.get(k)?.value, set: (k, v) => metaSet.run(k, String(v)) },
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    /** Append-only, hash-chained audit log. Editing or deleting a row breaks the chain. */
    audit(action, { actorId = null, launchId = null, data = {}, at = Date.now() } = {}) {
      const prev = db.prepare('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get()?.hash ?? 'genesis';
      const body = canonical({ at, actorId, action, launchId, data });
      const hash = createHash('sha256').update(prev + '|' + body).digest('hex');
      db.prepare('INSERT INTO audit (at, actor_id, action, launch_id, data, prev_hash, hash) VALUES (?,?,?,?,?,?,?)')
        .run(at, actorId, action, launchId, JSON.stringify(data), prev, hash);
      return hash;
    },
    verifyAudit() {
      let prev = 'genesis';
      for (const row of db.prepare('SELECT * FROM audit ORDER BY id').all()) {
        const body = canonical({ at: row.at, actorId: row.actor_id, action: row.action, launchId: row.launch_id, data: JSON.parse(row.data) });
        const hash = createHash('sha256').update(prev + '|' + body).digest('hex');
        if (row.prev_hash !== prev || row.hash !== hash) return { ok: false, brokenAt: row.id };
        prev = hash;
      }
      return { ok: true };
    },
    close: () => db.close()
  };
  return api;
}
