// Gavirila Homestead — Dependency Auto-Repair (B1-03)
// Deterministic repair actions for known dependency faults.
// Called after dependency-validator detects issues.

import { repo } from '../db.js';
import { bus } from '../orchestrator/event-bus.js';
import { createBlockedReason } from '../orchestrator/blocker-codes.js';

// Max ticks a task can stay blocked before escalation to human
const ESCALATION_THRESHOLD_TICKS = 10; // ~30 seconds at 3s/tick
// Minimum title similarity for auto-rewire (Levenshtein ratio)
const REWIRE_CONFIDENCE = 0.75;

// Track how many ticks each blocked task has been waiting
const _blockedTickCounts = new Map();

/**
 * Attempt auto-repair for dependency faults on blocked tasks.
 * Called after applyDependencyValidation() each tick.
 *
 * @param {Function} [broadcast] - WebSocket broadcast
 * @returns {{ repaired: number, escalated: number }}
 */
export function attemptDependencyRepairs(broadcast) {
  const allTasks = repo.list('tasks');
  const blockedTasks = allTasks.filter(t =>
    t.status === 'blocked' &&
    t.blocked_reason?.code?.startsWith('dependency-')
  );

  let repaired = 0;
  let escalated = 0;

  for (const task of blockedTasks) {
    // Increment tick counter
    const count = (_blockedTickCounts.get(task.id) || 0) + 1;
    _blockedTickCounts.set(task.id, count);

    const faults = task.blocked_reason?.faults || [];
    let wasRepaired = false;

    for (const fault of faults) {
      switch (fault.type) {
        case 'missing':
          wasRepaired = repairMissing(task, fault, allTasks, broadcast);
          break;
        case 'failed':
        case 'cancelled':
          wasRepaired = repairFailed(task, fault, allTasks, broadcast);
          break;
        case 'stale':
          wasRepaired = repairStale(task, fault, allTasks, broadcast);
          break;
        case 'cyclic':
          wasRepaired = repairCyclic(task, fault, allTasks, broadcast);
          break;
      }
      if (wasRepaired) break;
    }

    if (wasRepaired) {
      repaired++;
      _blockedTickCounts.delete(task.id);
    } else if (count >= ESCALATION_THRESHOLD_TICKS) {
      // Escalate to human after threshold
      escalateToHuman(task, broadcast);
      escalated++;
      _blockedTickCounts.delete(task.id);
    }
  }

  // Clean up counters for tasks no longer blocked
  for (const [id] of _blockedTickCounts) {
    const t = repo.byId('tasks', id);
    if (!t || t.status !== 'blocked') _blockedTickCounts.delete(id);
  }

  return { repaired, escalated };
}

/**
 * Repair missing dependency: find a task with similar title in the same project.
 */
function repairMissing(task, fault, allTasks, broadcast) {
  const projectTasks = allTasks.filter(t => t.project_id === task.project_id && t.id !== task.id);

  // Search by title similarity
  let bestMatch = null;
  let bestScore = 0;

  for (const candidate of projectTasks) {
    if (candidate.id === fault.depId) continue;
    const score = titleSimilarity(fault.depId, candidate.title) ||
                  titleSimilarity(fault.depId, candidate.id);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = candidate;
    }
  }

  if (bestMatch && bestScore >= REWIRE_CONFIDENCE) {
    // Auto-rewire: replace bad dep ID with the matched task ID
    const newDeps = (task.depends_on || []).map(d => d === fault.depId ? bestMatch.id : d);
    repo.patch('tasks', task.id, {
      depends_on: newDeps,
      status: 'queued',
      blocked_reason: null,
      updated_at: Date.now(),
      history: [...(task.history || []), {
        ts: Date.now(),
        kind: 'dep-repair',
        by: 'dependency-repair',
        note: `Auto-rewired missing dep ${fault.depId} → ${bestMatch.id} (${bestMatch.title}) [confidence: ${(bestScore * 100).toFixed(0)}%]`,
      }],
    });

    bus.publish('task:lifecycle', {
      type: 'task:dep-repaired',
      source: 'dependency-repair',
      data: { taskId: task.id, oldDep: fault.depId, newDep: bestMatch.id, confidence: bestScore },
    });
    broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
    return true;
  }

  // Alternative: remove the broken dep if it's the only one and non-critical
  if (task.depends_on?.length === 1) {
    // Single dep that doesn't exist — just remove it
    repo.patch('tasks', task.id, {
      depends_on: [],
      status: 'queued',
      blocked_reason: null,
      updated_at: Date.now(),
      history: [...(task.history || []), {
        ts: Date.now(),
        kind: 'dep-repair',
        by: 'dependency-repair',
        note: `Removed orphaned dependency ${fault.depId} (no match found)`,
      }],
    });
    broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
    return true;
  }

  return false;
}

/**
 * Repair failed/cancelled dependency: retry if budget allows, else create repair task.
 */
function repairFailed(task, fault, allTasks, broadcast) {
  const dep = allTasks.find(t => t.id === fault.depId);
  if (!dep) return false;

  // If dep has retry budget, trigger retry
  if (dep.status === 'failed' && (dep.attempts || 0) < 2) {
    repo.patch('tasks', dep.id, {
      status: 'queued',
      attempts: (dep.attempts || 0),
      updated_at: Date.now(),
      history: [...(dep.history || []), {
        ts: Date.now(),
        kind: 'dep-repair-retry',
        by: 'dependency-repair',
        note: `Auto-retried because downstream task ${task.id} is blocked`,
      }],
    });
    broadcast?.({ kind: 'task:update', task: repo.byId('tasks', dep.id) });
    // Don't unblock the waiting task yet — let it wait for the retry to succeed
    return false;
  }

  // Dep is cancelled or exhausted retries — remove dep and unblock
  const newDeps = (task.depends_on || []).filter(d => d !== fault.depId);
  repo.patch('tasks', task.id, {
    depends_on: newDeps,
    status: newDeps.length === 0 ? 'queued' : task.status,
    blocked_reason: newDeps.length === 0 ? null : task.blocked_reason,
    updated_at: Date.now(),
    history: [...(task.history || []), {
      ts: Date.now(),
      kind: 'dep-repair',
      by: 'dependency-repair',
      note: `Removed ${dep.status} dependency ${fault.depId} (${dep.title}) — cannot be satisfied`,
    }],
  });
  broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
  return newDeps.length === 0;
}

/**
 * Repair stale dependency: if stuck in needs-human/needs-info, try stirring.
 */
function repairStale(task, fault, allTasks, broadcast) {
  const dep = allTasks.find(t => t.id === fault.depId);
  if (!dep) return false;

  // If dep is in review with sufficient artifacts, consider it satisfiable
  if (dep.status === 'review' && (dep.artifacts || []).length >= 3) {
    // Treat as satisfied — unblock
    const allSatisfied = (task.depends_on || []).every(depId => {
      const d = allTasks.find(t => t.id === depId);
      return d && (d.status === 'done' || (d.status === 'review' && (d.artifacts || []).length >= 3));
    });

    if (allSatisfied) {
      repo.patch('tasks', task.id, {
        status: 'queued',
        blocked_reason: null,
        updated_at: Date.now(),
        history: [...(task.history || []), {
          ts: Date.now(),
          kind: 'dep-repair',
          by: 'dependency-repair',
          note: `Unblocked: stale dep ${fault.depId} has sufficient artifacts (review+3)`,
        }],
      });
      broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
      return true;
    }
  }

  return false;
}

/**
 * Repair cyclic dependency: break the weakest link (lowest priority dep).
 */
function repairCyclic(task, fault, allTasks, broadcast) {
  // Find the cycle member with lowest priority (highest number = lowest priority)
  const cycleDeps = (task.depends_on || []).filter(depId => {
    const d = allTasks.find(t => t.id === depId);
    return d && d.depends_on?.includes(task.id); // direct mutual cycle
  });

  if (cycleDeps.length > 0) {
    // Remove the first mutual dependency (break the cycle)
    const toRemove = cycleDeps[0];
    const newDeps = (task.depends_on || []).filter(d => d !== toRemove);
    repo.patch('tasks', task.id, {
      depends_on: newDeps,
      status: 'queued',
      blocked_reason: null,
      updated_at: Date.now(),
      history: [...(task.history || []), {
        ts: Date.now(),
        kind: 'dep-repair',
        by: 'dependency-repair',
        note: `Broke cycle: removed mutual dependency on ${toRemove}`,
      }],
    });
    broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
    return true;
  }

  return false;
}

/**
 * Escalate to human: task has been blocked too long for auto-repair.
 */
function escalateToHuman(task, broadcast) {
  const reason = createBlockedReason('human-decision-required', {
    original_blocker: task.blocked_reason,
    choices: [
      'Remove the broken dependency and let the task proceed',
      'Cancel this task (it depends on work that cannot be completed)',
      'Manually reassign or create a replacement dependency',
    ],
  });

  repo.patch('tasks', task.id, {
    status: 'needs-human',
    blocked_reason: reason,
    updated_at: Date.now(),
    history: [...(task.history || []), {
      ts: Date.now(),
      kind: 'escalated',
      by: 'dependency-repair',
      note: `Auto-repair exhausted after ${ESCALATION_THRESHOLD_TICKS} attempts — human decision required`,
    }],
  });

  bus.publish('task:lifecycle', {
    type: 'task:escalated',
    source: 'dependency-repair',
    data: { taskId: task.id, reason: reason.code },
  });

  broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
  broadcast?.({ kind: 'toast', toast: {
    title: 'Dependency repair failed',
    body: `Task "${task.title}" needs human decision — auto-repair exhausted`,
    icon: 'alert-triangle', color: 'orange', kind: 'warn',
  }});
}

/**
 * Compute title similarity using Levenshtein distance ratio.
 */
function titleSimilarity(a, b) {
  if (!a || !b) return 0;
  const la = a.toLowerCase().trim();
  const lb = b.toLowerCase().trim();
  if (la === lb) return 1;

  const maxLen = Math.max(la.length, lb.length);
  if (maxLen === 0) return 1;

  const dist = levenshteinDistance(la, lb);
  return 1 - (dist / maxLen);
}

function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}
