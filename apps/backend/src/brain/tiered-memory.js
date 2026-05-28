// apps/backend/src/brain/tiered-memory.js
//
// B3-03: Candidate vs Promoted Memory
//
// Splits agent memory into two tiers:
//   - Candidate: recently learned, unverified lessons from task runs
//   - Promoted: verified across repeated runs, high confidence
//
// Promotion requires:
//   - At least N successful uses without contradiction (PROMOTION_THRESHOLD)
//   - Verifier-backed success (task completed + no regression)
//
// Promoted memories have:
//   - Confidence score (0-1, decays over time)
//   - Expiration (auto-demote if unused for MAX_AGE_DAYS)
//   - Domain tag for scoped retrieval
//
// Only promoted memory influences critical routing and completion decisions.
// Candidate memory is available as "suggestions" with explicit disclaimers.
//
// Storage: data/tiered-memory/{agentId}.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TIERED_DIR = path.resolve(__dirname, '../../data/tiered-memory');

const PROMOTION_THRESHOLD = 3;    // Successes needed to promote
const MAX_AGE_DAYS = 60;          // Promoted memory expires after 60 days unused
const CONFIDENCE_DECAY_PER_DAY = 0.005; // Slight decay for unused memories
const MAX_PROMOTED = 100;         // Cap per agent
const MAX_CANDIDATES = 200;       // Cap per agent

// ── Schema ──────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} TieredMemory
 * @property {string} id            - Unique ID
 * @property {'candidate'|'promoted'} tier
 * @property {string} agentId       - Owning agent
 * @property {string} domain        - Domain tag (e.g., "utas5", "testing")
 * @property {string} type          - Memory type: pattern, lesson, preference, fact, guard
 * @property {string} content       - The actual memory content
 * @property {string} context       - What task/situation produced this
 * @property {number} confidence    - 0-1 (only meaningful for promoted)
 * @property {number} successCount  - Times used successfully
 * @property {number} failureCount  - Times contradicted
 * @property {number} createdAt
 * @property {number} lastUsedAt    - Last time this memory was retrieved and used
 * @property {number} promotedAt    - When promoted (0 if candidate)
 * @property {number} expiresAt     - Auto-demote after this time (promoted only)
 */

// ── Helpers ─────────────────────────────────────────────────────────────────

function ensureDir() {
  if (!fs.existsSync(TIERED_DIR)) fs.mkdirSync(TIERED_DIR, { recursive: true });
}

function memoryFile(agentId) {
  return path.join(TIERED_DIR, `${agentId}.json`);
}

function loadAll(agentId) {
  try {
    const f = memoryFile(agentId);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
  } catch { return []; }
}

function saveAll(agentId, memories) {
  ensureDir();
  fs.writeFileSync(memoryFile(agentId), JSON.stringify(memories, null, 2));
}

function generateId() {
  return `tm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Add a candidate memory from a recent task run.
 */
export function addCandidate(agentId, { domain, type, content, context }) {
  const all = loadAll(agentId);
  const now = Date.now();

  // Dedup: don't add if very similar content already exists
  const exists = all.find(m =>
    m.content === content ||
    (m.content.length > 20 && content.includes(m.content.slice(0, 20)))
  );
  if (exists) {
    // Just bump the success count on existing
    exists.successCount++;
    exists.lastUsedAt = now;
    saveAll(agentId, all);
    return exists;
  }

  const memory = {
    id: generateId(),
    tier: 'candidate',
    agentId,
    domain: domain || 'general',
    type: type || 'lesson',
    content,
    context: context || '',
    confidence: 0.3, // starting confidence for candidates
    successCount: 1,
    failureCount: 0,
    createdAt: now,
    lastUsedAt: now,
    promotedAt: 0,
    expiresAt: 0,
  };

  all.push(memory);

  // Cap candidates
  const candidates = all.filter(m => m.tier === 'candidate');
  if (candidates.length > MAX_CANDIDATES) {
    // Remove oldest, lowest-success candidates
    candidates.sort((a, b) => a.successCount - b.successCount || a.createdAt - b.createdAt);
    const toRemove = new Set(candidates.slice(0, candidates.length - MAX_CANDIDATES).map(m => m.id));
    const filtered = all.filter(m => !toRemove.has(m.id));
    saveAll(agentId, filtered);
    return memory;
  }

  saveAll(agentId, all);
  return memory;
}

/**
 * Record a success for a memory (was used and task succeeded).
 * Auto-promotes if threshold reached.
 */
export function recordSuccess(agentId, memoryId) {
  const all = loadAll(agentId);
  const memory = all.find(m => m.id === memoryId);
  if (!memory) return null;

  memory.successCount++;
  memory.lastUsedAt = Date.now();

  // Check promotion threshold
  if (memory.tier === 'candidate' && memory.successCount >= PROMOTION_THRESHOLD && memory.failureCount === 0) {
    promoteMemory(memory);
  }

  saveAll(agentId, all);
  return memory;
}

/**
 * Record a failure/contradiction for a memory.
 */
export function recordFailure(agentId, memoryId) {
  const all = loadAll(agentId);
  const memory = all.find(m => m.id === memoryId);
  if (!memory) return null;

  memory.failureCount++;
  memory.lastUsedAt = Date.now();

  // If promoted and failures exceed threshold, demote back to candidate
  if (memory.tier === 'promoted' && memory.failureCount >= 2) {
    memory.tier = 'candidate';
    memory.promotedAt = 0;
    memory.expiresAt = 0;
    memory.confidence = 0.2;
  }

  // If candidate and too many failures, remove it
  if (memory.tier === 'candidate' && memory.failureCount >= 3) {
    const filtered = all.filter(m => m.id !== memoryId);
    saveAll(agentId, filtered);
    return null; // removed
  }

  saveAll(agentId, all);
  return memory;
}

/**
 * Internal: promote a candidate memory.
 */
function promoteMemory(memory) {
  const now = Date.now();
  memory.tier = 'promoted';
  memory.promotedAt = now;
  memory.confidence = 0.8;
  memory.expiresAt = now + (MAX_AGE_DAYS * 24 * 60 * 60_000);
}

/**
 * Get promoted memories for an agent, optionally filtered by domain.
 * These are the high-confidence memories safe for critical routing.
 */
export function getPromotedMemories(agentId, { domain, type, limit = 10 } = {}) {
  const all = loadAll(agentId);
  const now = Date.now();

  let promoted = all.filter(m => m.tier === 'promoted');

  // Apply confidence decay and expiration check
  let modified = false;
  for (const m of promoted) {
    // Decay confidence for unused memories
    const daysSinceUse = (now - m.lastUsedAt) / (24 * 60 * 60_000);
    const decayedConfidence = m.confidence - (daysSinceUse * CONFIDENCE_DECAY_PER_DAY);
    if (decayedConfidence < 0.3) {
      // Demote expired memories
      m.tier = 'candidate';
      m.promotedAt = 0;
      m.expiresAt = 0;
      m.confidence = decayedConfidence;
      modified = true;
      continue;
    }
    if (m.expiresAt > 0 && now > m.expiresAt) {
      m.tier = 'candidate';
      m.promotedAt = 0;
      m.expiresAt = 0;
      modified = true;
      continue;
    }
    m.confidence = decayedConfidence;
  }

  if (modified) saveAll(agentId, all);

  // Re-filter after potential demotions
  promoted = all.filter(m => m.tier === 'promoted');

  if (domain) promoted = promoted.filter(m => m.domain === domain);
  if (type) promoted = promoted.filter(m => m.type === type);

  return promoted
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
}

/**
 * Get candidate memories (for "suggestions" — not authoritative).
 */
export function getCandidateMemories(agentId, { domain, limit = 5 } = {}) {
  const all = loadAll(agentId);
  let candidates = all.filter(m => m.tier === 'candidate');

  if (domain) candidates = candidates.filter(m => m.domain === domain);

  return candidates
    .sort((a, b) => b.successCount - a.successCount)
    .slice(0, limit);
}

/**
 * Build a tiered memory block for injection into task missions.
 * Promoted memories are authoritative; candidates are suggestions.
 */
export function buildTieredMemoryBlock(agentId, { domain } = {}) {
  const promoted = getPromotedMemories(agentId, { domain, limit: 6 });
  const candidates = getCandidateMemories(agentId, { domain, limit: 3 });

  if (!promoted.length && !candidates.length) return '';

  let block = '\n## Agent Memory\n';

  if (promoted.length) {
    block += '### Verified Patterns (follow these):\n';
    block += promoted.map(m => `  ✓ [${m.domain}/${m.type}] ${m.content} (confidence: ${(m.confidence * 100).toFixed(0)}%)`).join('\n');
    block += '\n';
  }

  if (candidates.length) {
    block += '### Suggestions (unverified — use with caution):\n';
    block += candidates.map(m => `  ? [${m.domain}/${m.type}] ${m.content} (${m.successCount} uses, unverified)`).join('\n');
    block += '\n';
  }

  return block;
}

/**
 * Bootstrap seed memories for a domain (for initial setup).
 */
export function seedMemories(agentId, seeds) {
  const all = loadAll(agentId);
  const now = Date.now();

  for (const seed of seeds) {
    // Don't seed if content already exists
    if (all.find(m => m.content === seed.content)) continue;

    all.push({
      id: generateId(),
      tier: 'promoted', // seeds start promoted
      agentId,
      domain: seed.domain || 'general',
      type: seed.type || 'fact',
      content: seed.content,
      context: seed.context || 'seeded',
      confidence: 0.7,
      successCount: PROMOTION_THRESHOLD, // meet threshold
      failureCount: 0,
      createdAt: now,
      lastUsedAt: now,
      promotedAt: now,
      expiresAt: now + (MAX_AGE_DAYS * 24 * 60 * 60_000),
    });
  }

  saveAll(agentId, all);
}

/**
 * Manual force-promote (for curated memories).
 */
export function forcePromote(agentId, memoryId) {
  const all = loadAll(agentId);
  const memory = all.find(m => m.id === memoryId);
  if (!memory) return null;
  promoteMemory(memory);
  saveAll(agentId, all);
  return memory;
}
