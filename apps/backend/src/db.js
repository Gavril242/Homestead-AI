// Homestead 1.0: persistence adapter with SQLite-first, JSON fallback.
// Uses the built-in node:sqlite module (Node.js 22.5+) — no npm install needed.
// Requires --experimental-sqlite flag (already set in npm start/dev scripts).

let _m;
try {
  _m = await import('./db-sqlite.js');
  console.log('[db] SQLite persistence active (homestead.db).');
} catch (err) {
  const hint = err.message?.includes('node:sqlite') || err.message?.includes('experimental')
    ? '\n[db]    To enable: use `npm start` (flag is set automatically) or add --experimental-sqlite'
    : '';
  console.warn('[db] ⚠  SQLite unavailable:', err.message, hint);
  console.warn('[db]    Falling back to gavirila.json store.');
  _m = await import('./db-json.js');
}

export const load                   = _m.load;
export const save                   = _m.save;
export const reset                  = _m.reset ?? (() => {});
export const repo                   = _m.repo;
export const DB_FILE_PATH           = _m.DB_FILE_PATH;
export const appendTaskEvent        = _m.appendTaskEvent ?? (() => {});
export const getTaskEvents          = _m.getTaskEvents ?? (() => []);
export const saveEvidenceBundle     = _m.saveEvidenceBundle ?? (() => null);
export const getEvidenceBundles     = _m.getEvidenceBundles ?? (() => []);
export const getProjectIntegrations = _m.getProjectIntegrations ?? (() => null);
