// Failure-mode memory. Indexes past failures so the runner can prepend
// "we've seen this before" context to retry prompts.
// Stored in db.json under `failure_index` for now (simple, fast for <1k rows).

import { repo } from '../db.js';
import { embedText, cosine } from '../llm/embed.js';

/** Record a failure for later RAG. */
export async function recordFailure({ taskId, projectId, by, error, context }) {
  const text = [error || '', context || ''].join('\n').slice(0, 1500);
  let vector = null;
  try { vector = await embedText(text); } catch { /* embed best-effort */ }
  repo.prepend('failure_index', {
    id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    taskId, projectId, by, error: (error || '').slice(0, 800),
    context: (context || '').slice(0, 1500),
    vector, ts: Date.now(),
  }, 1000);
}

/** Find the top-k most similar past failures to a given task description. */
export async function similarFailures({ projectId, by, query, k = 3 }) {
  if (!query) return [];
  let qVec = null;
  try { qVec = await embedText(query); } catch { return []; }
  if (!qVec) return [];
  const rows = (repo.list('failure_index') || []).filter((r) =>
    (!projectId || r.projectId === projectId) && (!by || r.by === by) && r.vector,
  );
  return rows
    .map((r) => ({ ...r, score: cosine(qVec, r.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ vector, ...rest }) => rest);
}
