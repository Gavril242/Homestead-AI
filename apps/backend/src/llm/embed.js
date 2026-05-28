// Gemini embedding adapter.
//
// Uses text-embedding-004 by default (768-dim float vectors).
// Picks the best embedder slot from the pool with quota awareness;
// no retry escalation here — embeddings are background work and a single
// failure just skips that note for now (it'll be retried on the next scan).

import { pickEmbedder, recordUsage, recordRequest, markRateLimited } from './pool.js';
import { getPool } from './index.js';

const POOL = () => getPool();

export async function embedText(text) {
  if (!text || !text.trim()) return null;
  const p = pickEmbedder(POOL());
  if (!p) throw new Error('no embedder available (no Gemini key configured?)');

  recordRequest(p.id);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${p.model}:embedContent?key=${p.key}`;
  const body = {
    model: `models/${p.model}`,
    content: { parts: [{ text: text.slice(0, 8000) }] },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    if (res.status === 429) markRateLimited(p.id, 30_000);
    const errText = await res.text().catch(() => '');
    throw new Error(`embed ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const vector = data.embedding?.values || data.embedding?.value;
  if (!vector) throw new Error('embed: no vector in response');

  recordUsage({
    provider: p.id, model: p.model, tier: 'embed', purpose: 'embed',
    prompt_tokens: Math.ceil(text.length / 4),
    output_tokens: 0,
    agent_id: 'embedder', duration_ms: 0,
  });
  return vector;
}

/** Cosine similarity between two equal-length number arrays. */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
