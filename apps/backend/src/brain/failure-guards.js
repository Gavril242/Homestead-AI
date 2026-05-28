// apps/backend/src/brain/failure-guards.js
//
// B3-04: Failure Pattern Library
//
// Synthesizes preventive guard rules from recurring failures:
//   1. Aggregates recurring failures into patterns (by error class + domain)
//   2. Generates reusable guard rules
//   3. Attaches guards to relevant playbooks
//   4. Decays weak rules and checks effectiveness periodically
//
// Guards are checked before playbook execution — if a guard fires,
// the task gets a warning or alternate strategy injected.
//
// Storage: data/failure-guards.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUARDS_FILE = path.resolve(__dirname, '../../data/failure-guards.json');

const MIN_OCCURRENCES_TO_SYNTHESIZE = 3; // Need 3+ similar failures to create a guard
const MAX_GUARDS = 200;
const DECAY_AFTER_DAYS = 30;             // Guards lose effectiveness score after 30 days without trigger
const MIN_EFFECTIVENESS = 0.2;           // Guards below this are auto-removed

// ── Schema ──────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} FailureGuard
 * @property {string} id               - Unique guard ID
 * @property {string} pattern          - Error pattern (regex-like or keyword)
 * @property {string} domain           - Domain this applies to
 * @property {string} description      - Human-readable: what this guard prevents
 * @property {string} prevention       - Instruction to inject when guard fires
 * @property {string[]} playbookIds    - Attached playbook IDs (empty = global)
 * @property {string[]} agents         - Which agents this applies to (empty = all)
 * @property {number} occurrences      - How many failures generated this pattern
 * @property {number} preventions      - Times this guard successfully prevented re-failure
 * @property {number} falsePositives   - Times guard fired but wasn't relevant
 * @property {number} effectiveness    - preventions / (preventions + falsePositives)
 * @property {number} createdAt
 * @property {number} lastTriggeredAt
 * @property {boolean} active
 */

// ── Helpers ─────────────────────────────────────────────────────────────────

function loadGuards() {
  if (!fs.existsSync(GUARDS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(GUARDS_FILE, 'utf8')); }
  catch { return []; }
}

function saveGuards(guards) {
  const dir = path.dirname(GUARDS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(GUARDS_FILE, JSON.stringify(guards, null, 2));
}

function generateId() {
  return `fg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function classifyError(errMsg) {
  const lower = (errMsg || '').toLowerCase();
  if (/timeout|etimedout/i.test(lower)) return 'timeout';
  if (/permission|eacces|forbidden/i.test(lower)) return 'permission';
  if (/not.found|enoent|404/i.test(lower)) return 'not-found';
  if (/syntax|parse|unexpected/i.test(lower)) return 'syntax';
  if (/loop|infinite|recursive/i.test(lower)) return 'loop';
  if (/token|budget|limit/i.test(lower)) return 'resource-limit';
  if (/connect|econnrefused|network/i.test(lower)) return 'network';
  if (/auth|401|403|credential/i.test(lower)) return 'auth';
  if (/tool.stall|empty.round/i.test(lower)) return 'tool-stall';
  return 'unknown';
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Analyze a batch of failures and synthesize new guard rules.
 * Called periodically or after a burst of failures.
 *
 * @param {Object[]} failures - Array of { error, domain, agent, taskTitle, ts }
 * @returns {Object[]} Newly created guards
 */
export function synthesizeGuards(failures) {
  if (!failures?.length) return [];

  // Group by error class + domain
  const groups = new Map();
  for (const f of failures) {
    const errClass = classifyError(f.error);
    const key = `${errClass}::${f.domain || 'general'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }

  const existingGuards = loadGuards();
  const existingPatterns = new Set(existingGuards.map(g => g.pattern));
  const newGuards = [];

  for (const [key, group] of groups) {
    if (group.length < MIN_OCCURRENCES_TO_SYNTHESIZE) continue;

    const [errClass, domain] = key.split('::');
    const pattern = errClass;

    // Don't duplicate existing guards
    if (existingPatterns.has(`${pattern}@${domain}`)) continue;

    // Extract common context from failures
    const commonTerms = extractCommonTerms(group.map(f => f.error));
    const agents = [...new Set(group.map(f => f.agent).filter(Boolean))];

    const guard = {
      id: generateId(),
      pattern: `${pattern}@${domain}`,
      domain,
      description: `Prevent recurring ${errClass} failures in ${domain} tasks${commonTerms ? ` (common: ${commonTerms})` : ''}`,
      prevention: generatePrevention(errClass, commonTerms, group),
      playbookIds: [],
      agents,
      occurrences: group.length,
      preventions: 0,
      falsePositives: 0,
      effectiveness: 0.5, // start neutral
      createdAt: Date.now(),
      lastTriggeredAt: 0,
      active: true,
    };

    newGuards.push(guard);
  }

  if (newGuards.length) {
    const all = [...existingGuards, ...newGuards];
    // Cap
    if (all.length > MAX_GUARDS) {
      all.sort((a, b) => b.effectiveness - a.effectiveness);
      all.length = MAX_GUARDS;
    }
    saveGuards(all);
  }

  return newGuards;
}

/**
 * Check if any guards fire for a given task context.
 * Returns fired guards with their prevention instructions.
 */
export function checkGuards({ taskTitle, taskDesc, domain, agent, playbookId }) {
  const guards = loadGuards().filter(g => g.active);
  const text = `${taskTitle || ''} ${taskDesc || ''}`.toLowerCase();
  const fired = [];

  for (const guard of guards) {
    // Domain match
    if (guard.domain !== 'general' && guard.domain !== domain) continue;

    // Agent match (empty = all agents)
    if (guard.agents.length && !guard.agents.includes(agent)) continue;

    // Playbook match (empty = global)
    if (guard.playbookIds.length && playbookId && !guard.playbookIds.includes(playbookId)) continue;

    // Pattern match — check if the error class keywords appear in context
    const patternClass = guard.pattern.split('@')[0];
    const guardKeywords = guard.description.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const keywordMatch = guardKeywords.some(kw => text.includes(kw));
    const classMatch = text.includes(patternClass);

    if (keywordMatch || classMatch) {
      fired.push(guard);
      // Update trigger timestamp
      guard.lastTriggeredAt = Date.now();
    }
  }

  if (fired.length) {
    saveGuards(loadGuards().map(g => {
      const f = fired.find(fg => fg.id === g.id);
      return f ? { ...g, lastTriggeredAt: f.lastTriggeredAt } : g;
    }));
  }

  return fired;
}

/**
 * Build a guard block for injection into task mission.
 */
export function buildGuardBlock(firedGuards) {
  if (!firedGuards?.length) return '';

  return `\n## ⚠️ FAILURE PREVENTION GUARDS\nThese patterns have caused repeated failures in similar tasks:\n${
    firedGuards.map(g => `  🛡️ ${g.description}\n     → ${g.prevention}`).join('\n')
  }\n`;
}

/**
 * Record that a guard successfully prevented a failure.
 */
export function recordPrevention(guardId) {
  const guards = loadGuards();
  const guard = guards.find(g => g.id === guardId);
  if (!guard) return;

  guard.preventions++;
  guard.effectiveness = guard.preventions / (guard.preventions + guard.falsePositives + 1);
  saveGuards(guards);
}

/**
 * Record a false positive (guard fired but task succeeded without following it).
 */
export function recordFalsePositive(guardId) {
  const guards = loadGuards();
  const guard = guards.find(g => g.id === guardId);
  if (!guard) return;

  guard.falsePositives++;
  guard.effectiveness = guard.preventions / (guard.preventions + guard.falsePositives + 1);

  // Deactivate if effectiveness drops too low
  if (guard.effectiveness < MIN_EFFECTIVENESS && (guard.preventions + guard.falsePositives) >= 5) {
    guard.active = false;
  }
  saveGuards(guards);
}

/**
 * Attach a guard to specific playbooks.
 */
export function attachGuardToPlaybook(guardId, playbookId) {
  const guards = loadGuards();
  const guard = guards.find(g => g.id === guardId);
  if (!guard) return false;

  if (!guard.playbookIds.includes(playbookId)) {
    guard.playbookIds.push(playbookId);
    saveGuards(guards);
  }
  return true;
}

/**
 * Run periodic decay — deactivate stale guards.
 */
export function decayGuards() {
  const guards = loadGuards();
  const now = Date.now();
  const cutoff = now - (DECAY_AFTER_DAYS * 24 * 60 * 60_000);
  let modified = false;

  for (const guard of guards) {
    if (!guard.active) continue;

    // Decay if not triggered recently and effectiveness is low
    if (guard.lastTriggeredAt < cutoff && guard.effectiveness < 0.5) {
      guard.effectiveness *= 0.8; // 20% decay
      modified = true;

      if (guard.effectiveness < MIN_EFFECTIVENESS) {
        guard.active = false;
      }
    }
  }

  if (modified) saveGuards(guards);
  return guards.filter(g => !g.active).length; // count deactivated
}

/**
 * List all active guards, optionally filtered.
 */
export function listGuards({ domain, active = true } = {}) {
  let guards = loadGuards();
  if (active !== undefined) guards = guards.filter(g => g.active === active);
  if (domain) guards = guards.filter(g => g.domain === domain || g.domain === 'general');
  return guards;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function extractCommonTerms(errors) {
  const wordCounts = new Map();
  for (const err of errors) {
    const words = (err || '').toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const seen = new Set();
    for (const w of words) {
      if (seen.has(w)) continue;
      seen.add(w);
      wordCounts.set(w, (wordCounts.get(w) || 0) + 1);
    }
  }

  // Terms appearing in >50% of failures
  const threshold = errors.length * 0.5;
  return [...wordCounts.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word)
    .join(', ');
}

function generatePrevention(errClass, commonTerms, failures) {
  switch (errClass) {
    case 'timeout':
      return 'Set explicit timeouts, break into smaller operations, check network/service availability first';
    case 'permission':
      return 'Verify file/directory permissions before write operations, use appropriate credentials';
    case 'not-found':
      return `Check path existence before access${commonTerms ? ` (commonly missing: ${commonTerms})` : ''}, use fs_list_dir first`;
    case 'syntax':
      return 'Validate generated code syntax before writing, use proper escaping for special characters';
    case 'loop':
      return 'Add explicit iteration limits, check for circular dependencies before proceeding';
    case 'resource-limit':
      return 'Minimize token usage, break task into smaller chunks, use targeted file reads not full scans';
    case 'network':
      return 'Verify connectivity before network operations, implement retry with backoff for transient failures';
    case 'auth':
      return 'Verify credentials/tokens are available and valid before making authenticated requests';
    case 'tool-stall':
      return 'If tools are not producing results, try a completely different approach rather than retrying the same tool';
    default:
      return `Known failure pattern in this domain${commonTerms ? ` (keywords: ${commonTerms})` : ''} — try alternate approach`;
  }
}
