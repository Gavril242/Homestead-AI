// Gavirila Homestead — Task Dependency Integrity Validator (B1-02)
// Pre-dispatch validation on every scheduler tick.
// Detects: missing deps, cycles, stale/failed deps, orphaned deps.
// Classifies faults and transitions tasks to 'blocked' with structured reasons.

import { repo } from '../db.js';
import { bus } from './event-bus.js';
import { createBlockedReason, classifyDepFault } from './blocker-codes.js';

// Terminal non-done states that block downstream forever
const TERMINAL_FAILED = new Set(['failed', 'cancelled']);
// States that are "stuck" — not terminal but not progressing
const STALE_STATES = new Set(['needs-human', 'needs-info']);
// Stale threshold: dep stuck > 30 min in stale state
const STALE_THRESHOLD_MS = 30 * 60_000;

/**
 * @typedef {object} DepFault
 * @property {string} taskId - The blocked task
 * @property {string} depId - The problematic dependency
 * @property {'missing'|'failed'|'cancelled'|'cyclic'|'stale'} faultType
 * @property {string} [detail] - Human-readable detail
 */

/**
 * Validate all dependency integrity for queued tasks.
 * Called once per tick with a consistent snapshot of all tasks.
 *
 * @param {Array} allTasks - Full task list snapshot (consistent read)
 * @returns {{ faults: DepFault[], blocked: string[], unblocked: string[] }}
 */
export function validateDependencies(allTasks) {
  const taskMap = new Map(allTasks.map(t => [t.id, t]));
  const faults = [];
  const blocked = [];
  const unblocked = [];

  // Build adjacency for cycle detection
  const graph = new Map(); // taskId → Set<depId>
  for (const t of allTasks) {
    if (t.depends_on?.length) {
      graph.set(t.id, new Set(t.depends_on));
    }
  }

  // Detect cycles using Kahn's algorithm (topological sort)
  const cycleMembers = detectCycles(graph, taskMap);

  for (const task of allTasks) {
    // Only validate queued or already-blocked tasks
    if (task.status !== 'queued' && task.status !== 'blocked') continue;
    if (!task.depends_on?.length) {
      // No deps — if it was blocked due to deps, unblock it
      if (task.status === 'blocked' && task.blocked_reason?.code?.startsWith('dependency-')) {
        unblocked.push(task.id);
      }
      continue;
    }

    const taskFaults = [];

    for (const depId of task.depends_on) {
      const dep = taskMap.get(depId);

      if (!dep) {
        // Dependency ID doesn't exist in DB
        taskFaults.push({ taskId: task.id, depId, faultType: 'missing', detail: `Task ${depId} does not exist` });
        continue;
      }

      // Check if dep is in cycle with this task
      if (cycleMembers.has(task.id) && cycleMembers.has(depId)) {
        taskFaults.push({ taskId: task.id, depId, faultType: 'cyclic', detail: `Circular dependency detected involving ${task.id} ↔ ${depId}` });
        continue;
      }

      // Check terminal failure states
      if (TERMINAL_FAILED.has(dep.status)) {
        taskFaults.push({ taskId: task.id, depId, faultType: dep.status === 'cancelled' ? 'cancelled' : 'failed', detail: `Dependency ${depId} is ${dep.status}` });
        continue;
      }

      // Check stale states (stuck too long)
      if (STALE_STATES.has(dep.status)) {
        const age = Date.now() - (dep.updated_at || dep.created_at || 0);
        if (age > STALE_THRESHOLD_MS) {
          taskFaults.push({ taskId: task.id, depId, faultType: 'stale', detail: `Dependency ${depId} stuck in ${dep.status} for ${Math.round(age / 60_000)}min` });
        }
      }
    }

    if (taskFaults.length > 0) {
      faults.push(...taskFaults);
      blocked.push(task.id);
    } else if (task.status === 'blocked' && task.blocked_reason?.code?.startsWith('dependency-')) {
      // Was blocked, but all deps now look healthy — check if deps are satisfied
      const allSatisfied = task.depends_on.every(depId => {
        const dep = taskMap.get(depId);
        return dep && (dep.status === 'done' || (dep.status === 'review' && (dep.artifacts || []).length >= 3));
      });
      if (allSatisfied) {
        unblocked.push(task.id);
      }
    }
  }

  return { faults, blocked, unblocked };
}

/**
 * Apply dependency validation results: transition tasks to blocked or unblock them.
 * @param {Array} allTasks - Consistent snapshot
 * @param {Function} [broadcast] - WebSocket broadcast function
 * @returns {{ blockedCount: number, unblockedCount: number }}
 */
export function applyDependencyValidation(allTasks, broadcast) {
  const { faults, blocked, unblocked } = validateDependencies(allTasks);

  let blockedCount = 0;
  let unblockedCount = 0;

  // Group faults by task
  const faultsByTask = new Map();
  for (const f of faults) {
    if (!faultsByTask.has(f.taskId)) faultsByTask.set(f.taskId, []);
    faultsByTask.get(f.taskId).push(f);
  }

  // Block tasks with faults
  for (const taskId of blocked) {
    const task = repo.byId('tasks', taskId);
    if (!task) continue;

    // Already blocked with same reason? Skip to avoid history spam
    if (task.status === 'blocked' && task.blocked_reason?.code?.startsWith('dependency-')) {
      continue;
    }

    const taskFaults = faultsByTask.get(taskId) || [];
    // Pick the most severe fault as primary
    const primary = taskFaults.find(f => f.faultType === 'cyclic')
      || taskFaults.find(f => f.faultType === 'missing')
      || taskFaults.find(f => f.faultType === 'failed' || f.faultType === 'cancelled')
      || taskFaults.find(f => f.faultType === 'stale')
      || taskFaults[0];

    const blockedReason = createBlockedReason(classifyDepFault(primary.faultType), {
      dep_ids: taskFaults.map(f => f.depId),
      faults: taskFaults.map(f => ({ depId: f.depId, type: f.faultType, detail: f.detail })),
    });

    repo.patch('tasks', taskId, {
      status: 'blocked',
      blocked_reason: blockedReason,
      updated_at: Date.now(),
      history: [...(task.history || []), {
        ts: Date.now(),
        kind: 'blocked',
        by: 'dependency-validator',
        note: `${primary.faultType}: ${primary.detail}`,
      }],
    });

    bus.publish('task:lifecycle', {
      type: 'task:blocked',
      source: 'dependency-validator',
      data: { taskId, reason: blockedReason },
    });

    broadcast?.({ kind: 'task:update', task: repo.byId('tasks', taskId) });
    blockedCount++;
  }

  // Unblock tasks whose deps are now satisfied
  for (const taskId of unblocked) {
    const task = repo.byId('tasks', taskId);
    if (!task || task.status !== 'blocked') continue;

    repo.patch('tasks', taskId, {
      status: 'queued',
      blocked_reason: null,
      updated_at: Date.now(),
      history: [...(task.history || []), {
        ts: Date.now(),
        kind: 'unblocked',
        by: 'dependency-validator',
        note: 'All dependencies now satisfied — requeued',
      }],
    });

    bus.publish('task:lifecycle', {
      type: 'task:unblocked',
      source: 'dependency-validator',
      data: { taskId },
    });

    broadcast?.({ kind: 'task:update', task: repo.byId('tasks', taskId) });
    unblockedCount++;
  }

  return { blockedCount, unblockedCount };
}

/**
 * Detect cycles in the dependency graph using Kahn's algorithm.
 * Returns a Set of task IDs that participate in at least one cycle.
 */
function detectCycles(graph, taskMap) {
  // Build in-degree map for all tasks that have deps
  const inDegree = new Map();
  const adjList = new Map(); // depId → Set<taskId> (reverse edges)

  for (const [taskId, deps] of graph) {
    if (!inDegree.has(taskId)) inDegree.set(taskId, 0);
    for (const depId of deps) {
      if (!taskMap.has(depId)) continue; // skip missing deps (handled separately)
      if (!inDegree.has(depId)) inDegree.set(depId, 0);
      inDegree.set(taskId, (inDegree.get(taskId) || 0) + 1);
      if (!adjList.has(depId)) adjList.set(depId, new Set());
      adjList.get(depId).add(taskId);
    }
  }

  // Kahn's: start with nodes that have zero in-degree
  const queue = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted = new Set();
  while (queue.length > 0) {
    const node = queue.shift();
    sorted.add(node);
    const neighbors = adjList.get(node) || new Set();
    for (const neighbor of neighbors) {
      const newDeg = inDegree.get(neighbor) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  // Any node NOT in sorted set is part of a cycle
  const cycleMembers = new Set();
  for (const [id] of inDegree) {
    if (!sorted.has(id)) cycleMembers.add(id);
  }

  return cycleMembers;
}

/**
 * Quick check: are all dependencies of a task satisfied?
 * Used by the scheduler as a fast gate (replaces the old inline filter).
 */
export function areDependenciesSatisfied(task, allTasks) {
  if (!task.depends_on?.length) return true;
  const taskMap = new Map(allTasks.map(t => [t.id, t]));
  return task.depends_on.every(depId => {
    const dep = taskMap.get(depId);
    return dep && (
      dep.status === 'done' ||
      (dep.status === 'review' && (dep.artifacts || []).length >= 3)
    );
  });
}
