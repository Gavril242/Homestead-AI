// apps/backend/src/services/slo-framework.js
//
// B5-01: SLO and Error Budget Framework
//
// Defines mission-level Service Level Objectives and tracks them:
//   - Mission success rate (target: ≥85%)
//   - Mean time to unblock (target: ≤30 min)
//   - Stale queue ratio (target: ≤10%)
//   - Status truth mismatch rate (target: ≤5%)
//
// Generates weekly SLO reports automatically.
// Each SLO has an owner and escalation policy.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repo } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SLO_DIR = path.resolve(__dirname, '../../data/slo');
const REPORTS_DIR = path.join(SLO_DIR, 'reports');

// ── SLO Definitions ─────────────────────────────────────────────────────────

export const SLO_DEFINITIONS = [
  {
    id: 'mission-success-rate',
    name: 'Mission Success Rate',
    description: 'Percentage of missions that complete without human intervention',
    target: 0.85,
    unit: 'ratio',
    window: '7d',
    owner: 'orchestrator',
    escalation: 'If below target for 2 consecutive windows: review playbook coverage and failure guards',
  },
  {
    id: 'mean-time-to-unblock',
    name: 'Mean Time to Unblock',
    description: 'Average minutes from task entering blocked state to resolution',
    target: 30,
    unit: 'minutes',
    window: '7d',
    owner: 'scrum-master',
    escalation: 'If above target: review stir interval, escalation ladder, and dependency repair effectiveness',
  },
  {
    id: 'stale-queue-ratio',
    name: 'Stale Queue Ratio',
    description: 'Percentage of queued tasks older than 60 minutes',
    target: 0.10,
    unit: 'ratio',
    window: '7d',
    owner: 'scheduler',
    escalation: 'If above target: check concurrency limits, agent availability, and task prioritization',
  },
  {
    id: 'status-truth-mismatch',
    name: 'Status Truth Mismatch Rate',
    description: 'Percentage of tasks whose reported status contradicts actual evidence',
    target: 0.05,
    unit: 'ratio',
    window: '7d',
    owner: 'status-service',
    escalation: 'If above target: audit status transitions and gate enforcement',
  },
];

// ── Metric Computation ──────────────────────────────────────────────────────

/**
 * Compute current SLO metrics for a project over a time window.
 * @param {string} projectId
 * @param {number} windowMs - Time window in milliseconds (default: 7 days)
 */
export function computeSloMetrics(projectId, windowMs = 7 * 24 * 60 * 60_000) {
  const now = Date.now();
  const windowStart = now - windowMs;
  const tasks = repo.list('tasks').filter(t =>
    t.project_id === projectId && (t.created_at || 0) >= windowStart
  );

  return {
    projectId,
    window: { start: windowStart, end: now, durationMs: windowMs },
    metrics: {
      'mission-success-rate': computeMissionSuccessRate(tasks),
      'mean-time-to-unblock': computeMeanTimeToUnblock(tasks, windowStart),
      'stale-queue-ratio': computeStaleQueueRatio(tasks, now),
      'status-truth-mismatch': computeStatusMismatchRate(tasks),
    },
    computedAt: now,
  };
}

function computeMissionSuccessRate(tasks) {
  const missions = tasks.filter(t => t.tag === 'mission' || t.is_mission);
  if (!missions.length) return { value: 1.0, sample: 0 };

  const succeeded = missions.filter(t =>
    t.status === 'done' && !t.gates_failed?.length
  ).length;

  return { value: missions.length > 0 ? succeeded / missions.length : 1.0, sample: missions.length };
}

function computeMeanTimeToUnblock(tasks, windowStart) {
  // Find tasks that were blocked and later unblocked within the window
  const unblockTimes = [];

  for (const task of tasks) {
    const history = task.history || [];
    let blockedAt = null;

    for (const entry of history) {
      if (entry.ts < windowStart) continue;
      if (entry.kind === 'blocked' || (entry.kind === 'status-change' && entry.note?.includes('blocked'))) {
        blockedAt = entry.ts;
      } else if (blockedAt && (entry.kind === 'started' || entry.kind === 'requeued' || entry.kind === 'stir-requeue')) {
        unblockTimes.push(entry.ts - blockedAt);
        blockedAt = null;
      }
    }
  }

  if (!unblockTimes.length) return { value: 0, sample: 0 };
  const mean = unblockTimes.reduce((a, b) => a + b, 0) / unblockTimes.length / 60_000; // minutes
  return { value: Math.round(mean * 10) / 10, sample: unblockTimes.length };
}

function computeStaleQueueRatio(tasks, now) {
  const STALE_THRESHOLD_MS = 60 * 60_000; // 60 minutes
  const queued = tasks.filter(t => t.status === 'queued');
  if (!queued.length) return { value: 0, sample: 0 };

  const stale = queued.filter(t => (now - (t.updated_at || t.created_at || 0)) > STALE_THRESHOLD_MS);
  return { value: stale.length / queued.length, sample: queued.length };
}

function computeStatusMismatchRate(tasks) {
  // Detect tasks whose status contradicts evidence:
  // - "done" but gates_failed is set
  // - "running" but no started_at or started_at > 60 min ago with no recent artifacts
  // - "queued" but actually in a blocked dependency state
  let mismatches = 0;
  const checked = tasks.filter(t => !['cancelled'].includes(t.status));

  for (const task of checked) {
    if (task.status === 'done' && task.gates_failed?.length > 0) {
      mismatches++;
    } else if (task.status === 'running' && task.started_at &&
      (Date.now() - task.started_at) > 60 * 60_000 &&
      !(task.artifacts || []).some(a => a.ts > Date.now() - 30 * 60_000)) {
      mismatches++;
    }
  }

  return { value: checked.length > 0 ? mismatches / checked.length : 0, sample: checked.length };
}

// ── SLO Evaluation ──────────────────────────────────────────────────────────

/**
 * Evaluate SLOs against targets. Returns pass/fail per SLO with budget remaining.
 */
export function evaluateSlos(projectId, windowMs) {
  const metrics = computeSloMetrics(projectId, windowMs);
  const results = [];

  for (const slo of SLO_DEFINITIONS) {
    const metric = metrics.metrics[slo.id];
    if (!metric) continue;

    let passing;
    if (slo.id === 'mission-success-rate') {
      // Higher is better — pass if actual >= target
      passing = metric.value >= slo.target;
    } else if (slo.unit === 'ratio' || slo.unit === 'minutes') {
      // Lower is better — pass if actual <= target
      passing = metric.value <= slo.target;
    } else {
      passing = true;
    }

    // Error budget: how much slack remains
    let budgetRemaining;
    if (slo.id === 'mission-success-rate') {
      // Higher is better: budget = actual - target
      budgetRemaining = metric.value - slo.target;
    } else {
      // Lower is better: budget = target - actual
      budgetRemaining = slo.target - metric.value;
    }

    results.push({
      sloId: slo.id,
      name: slo.name,
      target: slo.target,
      actual: metric.value,
      sample: metric.sample,
      passing,
      budgetRemaining,
      owner: slo.owner,
      escalation: passing ? null : slo.escalation,
    });
  }

  return {
    projectId,
    window: metrics.window,
    results,
    overallPassing: results.every(r => r.passing),
    computedAt: metrics.computedAt,
  };
}

// ── Report Generation ───────────────────────────────────────────────────────

/**
 * Generate a weekly SLO report and persist it.
 */
export function generateWeeklyReport(projectId) {
  const evaluation = evaluateSlos(projectId, 7 * 24 * 60 * 60_000);
  const now = new Date();
  const weekId = `${now.getFullYear()}-W${String(Math.ceil((now.getDate() + now.getDay()) / 7)).padStart(2, '0')}`;

  const report = {
    id: `slo-${projectId}-${weekId}`,
    projectId,
    weekId,
    generatedAt: Date.now(),
    evaluation,
    summary: {
      passing: evaluation.results.filter(r => r.passing).length,
      failing: evaluation.results.filter(r => !r.passing).length,
      total: evaluation.results.length,
      overallHealth: evaluation.overallPassing ? 'healthy' : 'degraded',
    },
    escalations: evaluation.results
      .filter(r => !r.passing)
      .map(r => ({ slo: r.name, owner: r.owner, action: r.escalation })),
  };

  // Persist
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = path.join(REPORTS_DIR, `${report.id}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  return report;
}

/**
 * List historical SLO reports for a project.
 */
export function listReports(projectId, limit = 12) {
  if (!fs.existsSync(REPORTS_DIR)) return [];

  return fs.readdirSync(REPORTS_DIR)
    .filter(f => f.startsWith(`slo-${projectId}-`) && f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit)
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

/**
 * Get error budget burn rate (how fast we're consuming budget).
 * Useful for predicting if we'll breach SLO before window ends.
 */
export function computeBurnRate(projectId) {
  const current = evaluateSlos(projectId, 7 * 24 * 60 * 60_000);
  const halfWindow = evaluateSlos(projectId, 3.5 * 24 * 60 * 60_000);

  return current.results.map(curr => {
    const half = halfWindow.results.find(r => r.sloId === curr.sloId);
    const burnRate = half ? (half.actual - curr.actual) / 0.5 : 0; // change per window fraction
    return {
      sloId: curr.sloId,
      name: curr.name,
      currentBudget: curr.budgetRemaining,
      burnRate,
      projectedBreach: burnRate > 0 && curr.budgetRemaining > 0
        ? Math.round(curr.budgetRemaining / burnRate * 100) / 100
        : null,
    };
  });
}
