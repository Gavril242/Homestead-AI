// File-backed JSON store — fallback when better-sqlite3 is not installed.
// Original gavirila.json-based implementation preserved for compatibility.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTransition } from './orchestrator/state-machine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'gavirila.json');

export const DB_FILE_PATH = DB_PATH;

const EMPTY = {
  projects: [], agents: [], reqs: [], tasks: [], missions: [], events: [], notifications: [], runs: [],
  bugs: [], connectors: [], links: [], pipelines: [], llm_usage: [],
  traces: [], chat: {}, meta: { version: 1, seededAt: null },
};

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify(EMPTY, null, 2));
}

let _state = null;
let _writeQueued = false;

export function load() {
  ensure();
  if (_state) return _state;
  try {
    _state = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    for (const k of Object.keys(EMPTY)) if (!(k in _state)) _state[k] = EMPTY[k];
  } catch (err) {
    console.warn('[db-json] primary DB corrupt/missing:', err.message);
    _state = structuredClone(EMPTY);
  }
  return _state;
}

const SIZE_LIMIT = 100 * 1024 * 1024;

export function save() {
  if (_writeQueued) return;
  _writeQueued = true;
  setImmediate(() => {
    _writeQueued = false;
    try {
      let json = JSON.stringify(_state, null, 2);
      if (json.length > SIZE_LIMIT) {
        if (Array.isArray(_state.llm_usage)) _state.llm_usage = _state.llm_usage.slice(-500);
        if (Array.isArray(_state.traces)) _state.traces = _state.traces.slice(-500);
        if (Array.isArray(_state.events)) _state.events = _state.events.slice(-300);
        json = JSON.stringify(_state, null, 2);
      }
      const TMP = DB_PATH + '.tmp';
      const BAK = DB_PATH + '.bak';
      if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, BAK);
      fs.writeFileSync(TMP, json);
      fs.renameSync(TMP, DB_PATH);
    } catch (err) {
      console.error('[db-json] save failed:', err.message);
    }
  });
}

export function reset() {
  _state = structuredClone(EMPTY);
  save();
  return _state;
}

function _byId(arr, id) {
  return arr?.find(r => r.id === id);
}

export const repo = {
  list(collection) {
    const s = load();
    if (collection === 'chat') return [];
    return Array.isArray(s[collection]) ? s[collection] : [];
  },

  byId(collection, id) {
    const s = load();
    if (!Array.isArray(s[collection])) return undefined;
    return _byId(s[collection], id);
  },

  upsert(collection, row) {
    const s = load();
    if (!Array.isArray(s[collection])) s[collection] = [];
    if (collection === 'tasks') {
      const existing = _byId(s.tasks, row.id);
      if (existing && row.status && existing.status && row.status !== existing.status) {
        try { assertTransition(existing.status, row.status, row.id); }
        catch (err) { console.warn(`[db-json] ${err.message}`); }
      }
    }
    const idx = s[collection].findIndex(r => r.id === row.id);
    if (idx >= 0) s[collection][idx] = row;
    else s[collection].push(row);
    save();
    return row;
  },

  patch(collection, id, updates) {
    const s = load();
    if (!Array.isArray(s[collection])) return null;
    const idx = s[collection].findIndex(r => r.id === id);
    if (idx < 0) return null;
    if (collection === 'tasks' && updates.status) {
      const existing = s[collection][idx];
      if (existing.status && updates.status !== existing.status) {
        try { assertTransition(existing.status, updates.status, id); }
        catch (err) { console.warn(`[db-json] ${err.message}`); }
      }
    }
    const merged = { ...s[collection][idx], ...updates };
    s[collection][idx] = merged;
    save();
    return merged;
  },

  remove(collection, id) {
    const s = load();
    if (!Array.isArray(s[collection])) return;
    s[collection] = s[collection].filter(r => r.id !== id);
    save();
  },

  prepend(collection, row, max = 200) {
    const s = load();
    if (!Array.isArray(s[collection])) s[collection] = [];
    s[collection].unshift(row);
    if (s[collection].length > max) s[collection] = s[collection].slice(0, max);
    save();
    return row;
  },

  chatFor(chatKey) {
    const s = load();
    return s.chat?.[chatKey] || [];
  },

  appendChat(chatKey, msg) {
    const s = load();
    if (!s.chat) s.chat = {};
    if (!s.chat[chatKey]) s.chat[chatKey] = [];
    s.chat[chatKey].push(msg);
    save();
    return msg;
  },
};

// Stubs for SQLite-only helpers (graceful no-ops in JSON mode)
export function appendTaskEvent(taskId, kind, by, note) {}
export function getTaskEvents(taskId) { return []; }
export function saveEvidenceBundle(taskId, bundle) { return bundle?.id || null; }
export function getEvidenceBundles(taskId) { return []; }
export function getProjectIntegrations(projectId) {
  const p = repo.byId('projects', projectId);
  return p?.integrations ?? null;
}
