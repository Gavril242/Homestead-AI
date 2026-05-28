// Pipeline gates — formal multi-stage approval points.
//
// A gate is a named checkpoint within a project ("design-approved",
// "code-reviewed", "ship-approved"). Tasks can declare a `gate` field;
// they only run when the gate is open. Gates are opened by humans via
// /api/projects/:id/gates/:name/open.

import { repo } from '../db.js';

export function ensureGates(projectId) {
  const all = repo.list('gates');
  const existing = all.filter((g) => g.project_id === projectId).map((g) => g.name);
  const defaults = ['plan-approved', 'design-approved', 'impl-reviewed', 'ship-approved'];
  for (const name of defaults) {
    if (!existing.includes(name)) {
      repo.upsert('gates', { id: `${projectId}:${name}`, project_id: projectId, name, open: false, history: [] });
    }
  }
}

export function listGates(projectId) {
  return repo.list('gates').filter((g) => !projectId || g.project_id === projectId);
}

export function setGate({ projectId, name, open, by = 'human' }) {
  const id = `${projectId}:${name}`;
  const cur = repo.byId('gates', id);
  if (!cur) {
    repo.upsert('gates', { id, project_id: projectId, name, open, history: [{ ts: Date.now(), by, open }] });
  } else {
    repo.patch('gates', id, { open, history: [...(cur.history || []), { ts: Date.now(), by, open }] });
  }
  return repo.byId('gates', id);
}

export function isGateOpen(projectId, name) {
  if (!name) return true;
  const g = repo.byId('gates', `${projectId}:${name}`);
  return !!g?.open;
}
