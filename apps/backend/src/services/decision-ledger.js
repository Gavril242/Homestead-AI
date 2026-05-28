// apps/backend/src/services/decision-ledger.js
//
// B5-04: Auditability and Explainability Ledger
//
// Logs every major orchestration decision with full context:
//   - Cause (what triggered the decision)
//   - Rule applied (which code path / guard / policy)
//   - Evidence used (data that informed the decision)
//   - Decision outcome (what action was taken)
//   - Confidence (how certain the system was)
//
// Covers: block, rewire, auto-cancel, escalation, promotion, scope-expansion,
//         constraint-advance, template-fix, tribunal-verdict, stale-resolve.
//
// Storage: data/decision-ledger/ (daily files for manageable size)
// Retention: 30 days active, then compressed archives.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_DIR = path.resolve(__dirname, '../../data/decision-ledger');
const RETENTION_DAYS = 30;
const MAX_ENTRIES_PER_FILE = 5000;

// ── Decision Types ──────────────────────────────────────────────────────────

export const DECISION_TYPES = {
  'task-blocked': 'Task transitioned to blocked state',
  'dependency-rewire': 'Dependency automatically rewired',
  'auto-cancel': 'Task automatically cancelled',
  'escalation': 'Task escalated to higher authority',
  'constraint-advance': 'Constraint level advanced',
  'template-fix': 'Escalation ladder template fix applied',
  'tribunal-verdict': 'Tribunal rendered a verdict',
  'stale-resolve': 'Stale review auto-resolved',
  'mission-drift-block': 'Task creation blocked for mission drift',
  'propagation-cap': 'Task propagation capped at depth limit',
  'retry-mutation': 'Retry forced to mutate strategy',
  'playbook-select': 'Playbook selected for task',
  'guard-fired': 'Failure guard triggered',
  'slo-breach': 'SLO threshold breached',
  'incident-created': 'Incident auto-detected',
  'canary-verdict': 'Canary rollout verdict rendered',
  'memory-promote': 'Memory promoted from candidate',
  'memory-demote': 'Memory demoted from promoted',
  'scope-expansion': 'Mission scope expanded',
  'rate-limit': 'Safety rate limit triggered',
};

// ── Ledger Entry ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} DecisionEntry
 * @property {string} id          - Unique entry ID
 * @property {number} ts          - Timestamp
 * @property {string} type        - Decision type (from DECISION_TYPES)
 * @property {string} projectId   - Associated project
 * @property {string} taskId      - Associated task (if any)
 * @property {string} cause       - What triggered the decision
 * @property {string} ruleApplied - Which rule/policy/code path
 * @property {Object} evidence    - Data used to make decision
 * @property {string} outcome     - What action was taken
 * @property {number} confidence  - 0-1 confidence in the decision
 * @property {string} actor       - Who/what made the decision (system component)
 */

// ── Internal Helpers ────────────────────────────────────────────────────────

function ensureDir() {
  if (!fs.existsSync(LEDGER_DIR)) fs.mkdirSync(LEDGER_DIR, { recursive: true });
}

function dailyFile(ts = Date.now()) {
  const d = new Date(ts);
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return path.join(LEDGER_DIR, `${dateStr}.jsonl`);
}

function generateId() {
  return `dec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Record a decision in the ledger.
 * This is the primary entry point — called from orchestration components.
 */
export function recordDecision({ type, projectId, taskId, cause, ruleApplied, evidence, outcome, confidence, actor }) {
  ensureDir();

  const entry = {
    id: generateId(),
    ts: Date.now(),
    type: type || 'unknown',
    projectId: projectId || null,
    taskId: taskId || null,
    cause: cause || '',
    ruleApplied: ruleApplied || '',
    evidence: evidence || {},
    outcome: outcome || '',
    confidence: typeof confidence === 'number' ? confidence : 0.5,
    actor: actor || 'system',
  };

  // Append to daily JSONL file (fast, append-only)
  const fp = dailyFile();
  fs.appendFileSync(fp, JSON.stringify(entry) + '\n');

  return entry;
}

/**
 * Query decisions for a specific task (full audit trail).
 */
export function getTaskDecisions(taskId, limit = 50) {
  return queryLedger({ taskId }, limit);
}

/**
 * Query decisions for a project within a time range.
 */
export function getProjectDecisions(projectId, { since, until, type, limit = 100 } = {}) {
  return queryLedger({ projectId, since, until, type }, limit);
}

/**
 * Query the ledger with filters.
 */
export function queryLedger(filters = {}, limit = 100) {
  ensureDir();
  const files = fs.readdirSync(LEDGER_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .sort()
    .reverse(); // newest first

  const results = [];

  for (const file of files) {
    if (results.length >= limit) break;

    // Date-based filtering
    if (filters.since || filters.until) {
      const fileDate = file.replace('.jsonl', '');
      if (filters.since) {
        const sinceDate = new Date(filters.since).toISOString().slice(0, 10);
        if (fileDate < sinceDate) continue;
      }
      if (filters.until) {
        const untilDate = new Date(filters.until).toISOString().slice(0, 10);
        if (fileDate > untilDate) continue;
      }
    }

    const fp = path.join(LEDGER_DIR, file);
    let lines;
    try { lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean); }
    catch { continue; }

    // Read in reverse for most-recent-first
    for (let i = lines.length - 1; i >= 0 && results.length < limit; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (matchesFilters(entry, filters)) {
          results.push(entry);
        }
      } catch { /* skip malformed lines */ }
    }
  }

  return results;
}

function matchesFilters(entry, filters) {
  if (filters.taskId && entry.taskId !== filters.taskId) return false;
  if (filters.projectId && entry.projectId !== filters.projectId) return false;
  if (filters.type && entry.type !== filters.type) return false;
  if (filters.since && entry.ts < filters.since) return false;
  if (filters.until && entry.ts > filters.until) return false;
  if (filters.actor && entry.actor !== filters.actor) return false;
  return true;
}

/**
 * Get a human-readable explanation for a specific decision.
 */
export function explainDecision(decisionId) {
  // Search recent files for the decision
  ensureDir();
  const files = fs.readdirSync(LEDGER_DIR).filter(f => f.endsWith('.jsonl')).sort().reverse();

  for (const file of files) {
    const fp = path.join(LEDGER_DIR, file);
    let lines;
    try { lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean); }
    catch { continue; }

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.id === decisionId) {
          return formatExplanation(entry);
        }
      } catch { continue; }
    }
  }

  return null;
}

function formatExplanation(entry) {
  const typeDesc = DECISION_TYPES[entry.type] || entry.type;
  return {
    id: entry.id,
    timestamp: new Date(entry.ts).toISOString(),
    type: entry.type,
    typeDescription: typeDesc,
    summary: `[${entry.actor}] ${typeDesc}: ${entry.outcome}`,
    detail: {
      cause: entry.cause,
      rule: entry.ruleApplied,
      evidence: entry.evidence,
      outcome: entry.outcome,
      confidence: `${Math.round(entry.confidence * 100)}%`,
    },
    context: {
      projectId: entry.projectId,
      taskId: entry.taskId,
    },
  };
}

// ── Retention & Cleanup ─────────────────────────────────────────────────────

/**
 * Clean up old ledger files beyond retention period.
 * Returns number of files removed.
 */
export function cleanupLedger() {
  ensureDir();
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60_000).toISOString().slice(0, 10);
  const files = fs.readdirSync(LEDGER_DIR).filter(f => f.endsWith('.jsonl'));
  let removed = 0;

  for (const file of files) {
    const fileDate = file.replace('.jsonl', '');
    if (fileDate < cutoff) {
      fs.unlinkSync(path.join(LEDGER_DIR, file));
      removed++;
    }
  }

  return removed;
}

/**
 * Get ledger statistics for monitoring.
 */
export function getLedgerStats() {
  ensureDir();
  const files = fs.readdirSync(LEDGER_DIR).filter(f => f.endsWith('.jsonl'));
  let totalEntries = 0;
  let totalSize = 0;

  for (const file of files) {
    const fp = path.join(LEDGER_DIR, file);
    const stat = fs.statSync(fp);
    totalSize += stat.size;
    try {
      const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
      totalEntries += lines.length;
    } catch { /* skip */ }
  }

  return {
    files: files.length,
    totalEntries,
    totalSizeBytes: totalSize,
    oldestFile: files.sort()[0] || null,
    newestFile: files.sort().pop() || null,
    retentionDays: RETENTION_DAYS,
  };
}
