// SQLite persistence layer for Gavirila Homestead.
// Uses the built-in node:sqlite module (Node.js 22.5+) — no native compilation needed.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { assertTransition } from './orchestrator/state-machine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.resolve(__dirname, '..', 'data');
const DB_PATH    = path.join(DATA_DIR, 'homestead.db');
const JSON_PATH  = path.join(DATA_DIR, 'gavirila.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── open / create DB ────────────────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH, { readBigInts: false });
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous  = NORMAL');
db.exec('PRAGMA foreign_keys = ON');

// ── schema ──────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id         TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS agents (
    id         TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS reqs (
    id         TEXT PRIMARY KEY,
    project_id TEXT,
    data       TEXT NOT NULL,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id         TEXT PRIMARY KEY,
    project_id TEXT,
    data       TEXT NOT NULL,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS missions (
    id         TEXT PRIMARY KEY,
    project_id TEXT,
    data       TEXT NOT NULL,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS events (
    id         TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id         TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS runs (
    id         TEXT PRIMARY KEY,
    project_id TEXT,
    data       TEXT NOT NULL,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS bugs (
    id         TEXT PRIMARY KEY,
    project_id TEXT,
    data       TEXT NOT NULL,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS connectors (
    id         TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS links (
    id         TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS pipelines (
    id         TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS llm_usage (
    id         TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS traces (
    id         TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id         TEXT PRIMARY KEY,
    chat_key   TEXT NOT NULL,
    data       TEXT NOT NULL,
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS task_events (
    id         TEXT PRIMARY KEY,
    task_id    TEXT NOT NULL,
    kind       TEXT,
    by         TEXT,
    note       TEXT,
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS evidence_bundles (
    id         TEXT PRIMARY KEY,
    task_id    TEXT NOT NULL,
    data       TEXT NOT NULL,
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS custom_agents (
    id   TEXT PRIMARY KEY,
    data TEXT NOT NULL DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_reqs_project      ON reqs(project_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_project     ON tasks(project_id);
  CREATE INDEX IF NOT EXISTS idx_missions_project  ON missions(project_id);
  CREATE INDEX IF NOT EXISTS idx_runs_project      ON runs(project_id);
  CREATE INDEX IF NOT EXISTS idx_bugs_project      ON bugs(project_id);
  CREATE INDEX IF NOT EXISTS idx_chat_key          ON chat_messages(chat_key);
  CREATE INDEX IF NOT EXISTS idx_task_events_task  ON task_events(task_id);
  CREATE INDEX IF NOT EXISTS idx_evidence_task     ON evidence_bundles(task_id);
`);

// ── prepared statements cache ───────────────────────────────────────────────
const stmts = {};
function stmt(key, sql) {
  if (!stmts[key]) stmts[key] = db.prepare(sql);
  return stmts[key];
}

// ── low-level helpers ────────────────────────────────────────────────────────

// Tables that use created_at (append-only semantics)
const CREATED_AT_TABLES = new Set(['events', 'notifications', 'llm_usage', 'traces']);

// Tables with a project_id column
const PROJECT_ID_TABLES = new Set(['reqs', 'tasks', 'missions', 'runs', 'bugs']);

function rowToData(row) {
  try { return JSON.parse(row.data); } catch { return {}; }
}

function _selectAll(table) {
  return db.prepare(`SELECT data FROM "${table}" ORDER BY rowid ASC`).all().map(rowToData);
}

function _selectById(table, id) {
  const row = db.prepare(`SELECT data FROM "${table}" WHERE id = ?`).get(id);
  return row ? rowToData(row) : undefined;
}

function _upsert(table, row) {
  const id  = row.id ?? randomUUID();
  const now = Date.now();
  const data = JSON.stringify({ ...row, id });

  if (PROJECT_ID_TABLES.has(table)) {
    stmt(`upsert_${table}`,
      `INSERT OR REPLACE INTO "${table}" (id, project_id, data, updated_at) VALUES (?, ?, ?, ?)`
    ).run(id, row.project_id ?? null, data, now);
  } else if (CREATED_AT_TABLES.has(table)) {
    stmt(`upsert_${table}`,
      `INSERT OR REPLACE INTO "${table}" (id, data, created_at) VALUES (?, ?, ?)`
    ).run(id, data, now);
  } else {
    stmt(`upsert_${table}`,
      `INSERT OR REPLACE INTO "${table}" (id, data, updated_at) VALUES (?, ?, ?)`
    ).run(id, data, now);
  }
  return { ...row, id };
}

function _patch(table, id, updates) {
  const existing = _selectById(table, id);
  if (!existing) return null;
  const merged = { ...existing, ...updates, updated_at: Date.now() };
  _upsert(table, merged);
  return merged;
}

// ── meta helpers (key-value) ─────────────────────────────────────────────────
function metaGet(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  if (!row) return undefined;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function metaSet(key, value) {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
}

// ── Proxy returned by load() ─────────────────────────────────────────────────
// Gives call-sites the illusion of a mutable in-memory state object while
// actually reading from / writing to SQLite synchronously.

const ARRAY_TABLES = ['projects','agents','reqs','tasks','missions','events','notifications','runs',
                      'bugs','connectors','links','pipelines','llm_usage','traces'];

const metaProxy = new Proxy({}, {
  get(_, key) { return metaGet(String(key)); },
  set(_, key, value) { metaSet(String(key), value); return true; },
  ownKeys() { return db.prepare("SELECT key FROM meta").all().map(r => r.key); },
  getOwnPropertyDescriptor(_, key) {
    const val = metaGet(String(key));
    if (val === undefined) return undefined;
    return { configurable: true, enumerable: true, writable: true, value: val };
  },
});

const dbProxy = new Proxy({}, {
  get(_, prop) {
    if (prop === 'meta') return metaProxy;
    if (prop === 'chat')  return {}; // legacy: chat is in chat_messages table
    if (ARRAY_TABLES.includes(prop)) return _selectAll(prop);
    return undefined;
  },
  set(_, prop, value) {
    if (prop === 'links' && Array.isArray(value)) {
      // Bulk replace: seed file sets s.links = [...] directly
      const del = db.prepare('DELETE FROM links');
      const ins = db.prepare(
        'INSERT OR REPLACE INTO links (id, data, updated_at) VALUES (?, ?, ?)'
      );
      db.exec('BEGIN');
      try {
        del.run();
        for (const row of value) {
          const id = row.id ?? `${row.from}__${row.to}__${row.kind ?? 'link'}`;
          ins.run(id, JSON.stringify({ ...row, id }), Date.now());
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return true;
    }
    // Silently accept other direct property sets (meta is handled via proxy above)
    return true;
  },
});

// ── public API ───────────────────────────────────────────────────────────────

/** Returns a proxy that reads/writes directly to SQLite for backward compat. */
export function load() {
  return dbProxy;
}

/** No-op: all SQLite writes happen synchronously at the point of mutation. */
export function save() { /* noop */ }

/** Wipe all tables and re-initialise (used by tests / hard reset). */
export function reset() {
  for (const t of [...ARRAY_TABLES, 'chat_messages', 'task_events', 'evidence_bundles']) {
    db.prepare(`DELETE FROM "${t}"`).run();
  }
  db.prepare('DELETE FROM meta').run();
  return dbProxy;
}

export const repo = {
  list(table) {
    if (table === 'chat') return [];
    return _selectAll(table);
  },

  byId(table, id) {
    return _selectById(table, id);
  },

  upsert(table, row) {
    if (table === 'tasks') {
      const existing = _selectById('tasks', row.id);
      if (existing && row.status && existing.status && row.status !== existing.status) {
        try {
          assertTransition(existing.status, row.status, row.id);
        } catch (err) {
          console.warn(`[db] ${err.message}`);
          row = { ...row, _transition_warning: `${existing.status} → ${row.status}` };
        }
      }
    }
    return _upsert(table, row);
  },

  patch(table, id, updates) {
    if (table === 'tasks' && updates.status) {
      const existing = _selectById('tasks', id);
      if (existing && existing.status && updates.status !== existing.status) {
        try {
          assertTransition(existing.status, updates.status, id);
        } catch (err) {
          console.warn(`[db] ${err.message}`);
          updates = { ...updates, _transition_warning: `${existing.status} → ${updates.status}` };
        }
      }
    }
    return _patch(table, id, updates);
  },

  remove(table, id) {
    db.prepare(`DELETE FROM "${table}" WHERE id = ?`).run(id);
  },

  /** prepend: insert with newest-first semantics (used by llm_usage). Max is advisory. */
  prepend(table, row, _max = 200) {
    return _upsert(table, row);
  },

  chatFor(chatKey) {
    return db.prepare(
      'SELECT data FROM chat_messages WHERE chat_key = ? ORDER BY created_at ASC'
    ).all(chatKey).map(rowToData);
  },

  appendChat(chatKey, msg) {
    const id  = msg.id ?? randomUUID();
    const now = Date.now();
    db.prepare(
      'INSERT OR REPLACE INTO chat_messages (id, chat_key, data, created_at) VALUES (?, ?, ?, ?)'
    ).run(id, chatKey, JSON.stringify({ ...msg, id }), now);
    return msg;
  },
};

// ── new helpers ──────────────────────────────────────────────────────────────

export function appendTaskEvent(taskId, kind, by, note) {
  db.prepare(
    'INSERT INTO task_events (id, task_id, kind, by, note, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(randomUUID(), taskId, kind ?? null, by ?? null, note ?? null, Date.now());
}

export function getTaskEvents(taskId) {
  return db.prepare(
    'SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC'
  ).all(taskId);
}

export function saveEvidenceBundle(taskId, bundle) {
  const id = bundle.id ?? randomUUID();
  db.prepare(
    'INSERT OR REPLACE INTO evidence_bundles (id, task_id, data, created_at) VALUES (?, ?, ?, ?)'
  ).run(id, taskId, JSON.stringify({ ...bundle, id }), Date.now());
  return id;
}

export function getEvidenceBundles(taskId) {
  return db.prepare(
    'SELECT data FROM evidence_bundles WHERE task_id = ? ORDER BY created_at ASC'
  ).all(taskId).map(rowToData);
}

// ── compat helpers ───────────────────────────────────────────────────────────

export function getProjectIntegrations(projectId) {
  const p = repo.byId('projects', projectId);
  return p?.integrations ?? null;
}

export const DB_FILE_PATH = DB_PATH;

// ── one-time JSON → SQLite migration ─────────────────────────────────────────

function migrateFromJson() {
  const alreadyDone = metaGet('_migrated_from_json');
  if (alreadyDone) return;
  if (!fs.existsSync(JSON_PATH)) return;

  let state;
  try {
    state = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  } catch (err) {
    console.warn('[db-sqlite] could not read gavirila.json for migration:', err.message);
    return;
  }

  console.log('[db-sqlite] migrating gavirila.json → homestead.db …');

  const ARRAY_COLLECTIONS = ['projects','agents','reqs','tasks','missions','events','runs',
                              'bugs','connectors','links','pipelines','llm_usage','traces'];

  db.exec('BEGIN');
  try {
    for (const col of ARRAY_COLLECTIONS) {
      const rows = Array.isArray(state[col]) ? state[col] : [];
      for (const row of rows) {
        try { _upsert(col, row); } catch {}
      }
    }

    // chat: { agentId: [{role,text,...}] }
    if (state.chat && typeof state.chat === 'object') {
      for (const [chatKey, msgs] of Object.entries(state.chat)) {
        if (!Array.isArray(msgs)) continue;
        for (const msg of msgs) {
          repo.appendChat(chatKey, msg);
        }
      }
    }

    // meta: { version, seededAt, welcomeDismissed, … }
    if (state.meta && typeof state.meta === 'object') {
      for (const [k, v] of Object.entries(state.meta)) {
        metaSet(k, v);
      }
    }

    metaSet('_migrated_from_json', new Date().toISOString());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  console.log('[db-sqlite] migration complete.');
}

migrateFromJson();
