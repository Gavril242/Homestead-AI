/**
 * Relevance Gate — filters vault search chunks through a cheap binary model.
 * Drops chunks that are not directly relevant to the task description.
 * Pure optimization: never changes what agents DO, only what they SEE.
 */

// Cache recent gate decisions to avoid duplicate calls
// key: `${chunkId}::${taskHash}` → true/false
const _cache = new Map();
const MAX_CACHE = 1000;

function taskHash(taskDesc) {
  // Simple hash: first 60 chars normalized
  return (taskDesc || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
}

function chunkKey(chunk, tHash) {
  const id = chunk.id || chunk.path || (chunk.content || '').slice(0, 40);
  return `${id}::${tHash}`;
}

/**
 * Filter an array of vault chunks to only those relevant to taskDesc.
 * @param {Array} chunks - each has { id?, path?, content, score? }
 * @param {string} taskDesc - the current task description
 * @param {{ minScore?: number, maxChunks?: number, skipGate?: boolean }} opts
 * @returns {Promise<Array>} filtered chunks
 */
export async function filterChunks(chunks, taskDesc, opts = {}) {
  if (!chunks || chunks.length === 0) return chunks;

  // Skip gate if disabled or task desc missing (can't judge relevance)
  if (opts.skipGate || !taskDesc || taskDesc.length < 10) return chunks;

  // If only 1-2 chunks, not worth gating
  if (chunks.length <= 2) return chunks;

  // Fast pre-filter: drop chunks with very low vector score (< 0.25)
  const minScore = opts.minScore ?? 0.25;
  const scored = chunks.filter(c => !c.score || c.score >= minScore);
  if (scored.length <= 2) return scored;

  const tHash = taskHash(taskDesc);

  // Check cache for all chunks
  const uncached = scored.filter(c => !_cache.has(chunkKey(c, tHash)));

  if (uncached.length > 0) {
    // Run gate checks in parallel (cheap model, fast)
    await Promise.allSettled(uncached.map(chunk => runGate(chunk, taskDesc, tHash)));
  }

  // Apply cache results
  const relevant = scored.filter(c => {
    const key = chunkKey(c, tHash);
    return _cache.get(key) !== false; // keep if relevant OR if gate failed (safe default)
  });

  const dropped = scored.length - relevant.length;
  if (dropped > 0) {
    console.log(`[relevance-gate] Dropped ${dropped}/${scored.length} irrelevant chunks for: "${taskDesc.slice(0, 60)}"`);
  }

  // Never drop ALL chunks
  return relevant.length > 0 ? relevant : scored.slice(0, 2);
}

async function runGate(chunk, taskDesc, tHash) {
  const key = chunkKey(chunk, tHash);
  const content = (chunk.content || chunk.text || '').slice(0, 1000);

  if (!content.trim()) {
    _cache.set(key, false);
    return;
  }

  try {
    const { chat } = await import('../llm/index.js');
    const result = await chat({
      system: 'You are a relevance classifier. Answer with a single word: YES or NO. No other output.',
      messages: [{
        role: 'user',
        content: `Task: "${taskDesc.slice(0, 200)}"\n\nChunk:\n${content}\n\nIs this chunk directly useful for the task? YES or NO.`,
      }],
      purpose: 'classify',
      tier: 'fast',
      toolScopes: [],
      maxTokens: 5,
    });

    const answer = (result?.reply || '').trim().toUpperCase();
    const relevant = answer.startsWith('YES');
    _cache.set(key, relevant);

    // Trim cache if too large
    if (_cache.size > MAX_CACHE) {
      const firstKey = _cache.keys().next().value;
      _cache.delete(firstKey);
    }
  } catch {
    // On any error, default to KEEP (safe)
    _cache.set(key, true);
  }
}

export function clearGateCache() {
  _cache.clear();
}
