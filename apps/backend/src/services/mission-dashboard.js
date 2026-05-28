// apps/backend/src/services/mission-dashboard.js
//
// B4-01: Mission Dashboard
// B4-02: Guided Recovery Actions
//
// Mission-centric view for non-technical users:
//   - Objective progress (not task-level noise)
//   - Blocker class + next deterministic action
//   - Confidence score
//   - Last verified proof
//   - Estimated completion
//   - One-click recovery actions per blocker type
//
// Progressive disclosure: summary first, deep diagnostics on demand.

import { repo } from '../db.js';

// ── Configuration ───────────────────────────────────────────────────────────

const ESTIMATED_MINUTES_PER_TASK = 8; // Average task completion time

// ── Recovery Action Catalog ─────────────────────────────────────────────────

const RECOVERY_ACTIONS = {
  'dependency-missing': {
    label: 'Repair Dependencies',
    description: 'Attempt to find and reconnect missing task dependencies',
    endpoint: '/api/tasks/{taskId}/repair-dependencies',
    method: 'POST',
    icon: 'link',
    color: 'blue',
    historicalSuccess: 0.72,
  },
  'dependency-failed': {
    label: 'Retry Failed Dependency',
    description: 'Re-run the failed prerequisite task',
    endpoint: '/api/tasks/{taskId}/retry-dependency',
    method: 'POST',
    icon: 'refresh-cw',
    color: 'blue',
    historicalSuccess: 0.65,
  },
  'dependency-cyclic': {
    label: 'Break Dependency Cycle',
    description: 'Remove weakest dependency link to break the cycle',
    endpoint: '/api/tasks/{taskId}/break-cycle',
    method: 'POST',
    icon: 'scissors',
    color: 'orange',
    historicalSuccess: 0.58,
  },
  'workspace-invalid': {
    label: 'Fix Workspace',
    description: 'Create or repair the workspace directory',
    endpoint: '/api/projects/{projectId}/fix-workspace',
    method: 'POST',
    icon: 'folder-plus',
    color: 'yellow',
    historicalSuccess: 0.85,
  },
  'permission-denied': {
    label: 'Request Access',
    description: 'Escalate to admin for permission fix',
    endpoint: '/api/tasks/{taskId}/escalate',
    method: 'POST',
    icon: 'shield',
    color: 'red',
    historicalSuccess: 0.40,
  },
  'validation-failed': {
    label: 'Retry with Constraints',
    description: 'Re-run with stricter constraints to prevent same failure',
    endpoint: '/api/tasks/{taskId}/retry-constrained',
    method: 'POST',
    icon: 'alert-circle',
    color: 'yellow',
    historicalSuccess: 0.60,
  },
  'tool-unavailable': {
    label: 'Use Alternate Tool',
    description: 'Retry with an alternate tool or manual approach',
    endpoint: '/api/tasks/{taskId}/alternate-tool',
    method: 'POST',
    icon: 'tool',
    color: 'gray',
    historicalSuccess: 0.55,
  },
  'human-decision-required': {
    label: 'Provide Input',
    description: 'The system needs your decision to continue',
    endpoint: '/api/tasks/{taskId}/provide-input',
    method: 'POST',
    icon: 'user',
    color: 'purple',
    historicalSuccess: 0.90,
  },
  'constraint-exhausted': {
    label: 'Approve Scope Expansion',
    description: 'Allow the system to try broader approaches',
    endpoint: '/api/tasks/{taskId}/expand-scope',
    method: 'POST',
    icon: 'maximize',
    color: 'orange',
    historicalSuccess: 0.50,
  },
  'stale-review': {
    label: 'Force Complete',
    description: 'Mark as done if outputs exist and look correct',
    endpoint: '/api/tasks/{taskId}/force-complete',
    method: 'POST',
    icon: 'check-circle',
    color: 'green',
    historicalSuccess: 0.78,
  },
};

// ── Dashboard Computation ───────────────────────────────────────────────────

/**
 * Compute mission-centric dashboard for a project.
 * Returns high-level state readable in <10 seconds.
 *
 * @param {string} projectId
 * @returns {Object} Dashboard state
 */
export function computeMissionDashboard(projectId) {
  const tasks = repo.list('tasks').filter(t => t.project_id === projectId);
  let missions = [];
  try { missions = repo.list('missions')?.filter(m => m.project_id === projectId) || []; }
  catch { /* missions table may not exist */ }
  const now = Date.now();

  // Group tasks by mission
  const missionViews = missions.map(mission => {
    const missionTasks = tasks.filter(t =>
      mission.task_ids?.includes(t.id) || t.mission_id === mission.id
    );

    return computeMissionView(mission, missionTasks, now);
  });

  // Orphan tasks (no mission)
  const missionTaskIds = new Set(missions.flatMap(m => m.task_ids || []));
  const orphanTasks = tasks.filter(t => !missionTaskIds.has(t.id) && !t.mission_id);

  // Overall project summary
  const totalTasks = tasks.length;
  const doneTasks = tasks.filter(t => t.status === 'done').length;
  const blockedTasks = tasks.filter(t => ['blocked', 'needs-human', 'tribunal'].includes(t.status));
  const activeTasks = tasks.filter(t => ['running', 'queued'].includes(t.status));

  const overallProgress = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
  const overallConfidence = computeOverallConfidence(missionViews);

  // Estimated completion
  const remainingTasks = totalTasks - doneTasks;
  const avgCompletionTime = computeAverageCompletionTime(tasks);
  const estimatedMinutes = remainingTasks * (avgCompletionTime || ESTIMATED_MINUTES_PER_TASK);

  return {
    projectId,
    summary: {
      progress: overallProgress,
      confidence: overallConfidence,
      activeMissions: missionViews.filter(m => m.status !== 'completed').length,
      totalMissions: missionViews.length,
      blockerCount: blockedTasks.length,
      estimatedMinutesRemaining: Math.round(estimatedMinutes),
    },
    missions: missionViews,
    blockers: computeBlockerSummary(blockedTasks),
    orphanTasks: orphanTasks.length,
    computedAt: now,
  };
}

/**
 * Compute view for a single mission.
 */
function computeMissionView(mission, tasks, now) {
  const total = tasks.length;
  const done = tasks.filter(t => t.status === 'done').length;
  const failed = tasks.filter(t => ['needs-human', 'tribunal'].includes(t.status)).length;
  const blocked = tasks.filter(t => t.status === 'blocked').length;
  const running = tasks.filter(t => t.status === 'running').length;

  const progress = total > 0 ? Math.round((done / total) * 100) : 0;

  // Confidence: reduced by failures and blockers
  let confidence = 1.0;
  if (total > 0) {
    confidence -= (failed / total) * 0.4;
    confidence -= (blocked / total) * 0.2;
  }
  confidence = Math.max(0, Math.min(1, confidence));

  // Last verified proof
  const lastDone = tasks
    .filter(t => t.status === 'done' && t.outcome)
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))[0];

  // Next deterministic action
  const nextAction = determineNextAction(tasks, mission);

  // Status
  let status = 'active';
  if (done === total && total > 0) status = 'completed';
  else if (failed > 0 && running === 0 && blocked === 0) status = 'stalled';
  else if (blocked > 0) status = 'blocked';

  return {
    missionId: mission.id,
    title: mission.goal || mission.title || '(unnamed mission)',
    status,
    progress,
    confidence: Math.round(confidence * 100),
    taskCounts: { total, done, failed, blocked, running },
    lastVerifiedProof: lastDone ? {
      taskId: lastDone.id,
      title: lastDone.title,
      outcome: (lastDone.outcome || '').slice(0, 200),
      at: lastDone.updated_at,
    } : null,
    nextAction,
    createdAt: mission.createdAt || mission.created_at,
  };
}

/**
 * Determine the next action a user should take for a mission.
 */
function determineNextAction(tasks, mission) {
  // Check for blocked tasks with recovery options
  const blocked = tasks.filter(t => ['blocked', 'needs-human', 'tribunal'].includes(t.status));
  if (blocked.length) {
    const topBlocker = blocked[0];
    const blockerCode = topBlocker.blocked_reason?.code || 'human-decision-required';
    const recovery = RECOVERY_ACTIONS[blockerCode] || RECOVERY_ACTIONS['human-decision-required'];

    return {
      type: 'resolve-blocker',
      label: recovery.label,
      description: `${topBlocker.title} — ${recovery.description}`,
      taskId: topBlocker.id,
      recovery,
    };
  }

  // All running → wait
  const running = tasks.filter(t => t.status === 'running');
  if (running.length) {
    return {
      type: 'wait',
      label: 'In Progress',
      description: `${running.length} task(s) currently executing`,
    };
  }

  // Queued → will start soon
  const queued = tasks.filter(t => t.status === 'queued');
  if (queued.length) {
    return {
      type: 'wait',
      label: 'Starting Soon',
      description: `${queued.length} task(s) queued for execution`,
    };
  }

  // All done
  if (tasks.every(t => t.status === 'done')) {
    return {
      type: 'complete',
      label: 'Mission Complete',
      description: 'All tasks finished successfully',
    };
  }

  return {
    type: 'unknown',
    label: 'Review Status',
    description: 'Check individual task statuses for details',
  };
}

// ── Blocker Summary ─────────────────────────────────────────────────────────

function computeBlockerSummary(blockedTasks) {
  const byClass = new Map();

  for (const task of blockedTasks) {
    const code = task.blocked_reason?.code || task.status;
    if (!byClass.has(code)) byClass.set(code, []);
    byClass.get(code).push(task);
  }

  return [...byClass.entries()].map(([code, tasks]) => {
    const recovery = RECOVERY_ACTIONS[code] || RECOVERY_ACTIONS['human-decision-required'];
    return {
      code,
      count: tasks.length,
      tasks: tasks.slice(0, 3).map(t => ({ id: t.id, title: t.title })),
      recovery: {
        ...recovery,
        endpoint: recovery.endpoint
          .replace('{taskId}', tasks[0].id)
          .replace('{projectId}', tasks[0].project_id),
      },
    };
  }).sort((a, b) => b.count - a.count);
}

// ── Helper Computations ─────────────────────────────────────────────────────

function computeOverallConfidence(missionViews) {
  if (!missionViews.length) return 100;
  const avg = missionViews.reduce((sum, m) => sum + m.confidence, 0) / missionViews.length;
  return Math.round(avg);
}

function computeAverageCompletionTime(tasks) {
  const completed = tasks.filter(t =>
    t.status === 'done' && t.started_at && t.updated_at && t.updated_at > t.started_at
  );
  if (!completed.length) return null;

  const times = completed.map(t => (t.updated_at - t.started_at) / 60_000); // minutes
  return times.reduce((a, b) => a + b, 0) / times.length;
}

// ── Recovery Action Executor ────────────────────────────────────────────────

/**
 * Get available recovery actions for a specific task.
 * Returns sorted by historical success rate.
 */
export function getRecoveryActions(taskId) {
  const task = repo.byId('tasks', taskId);
  if (!task) return [];

  const blockerCode = task.blocked_reason?.code || task.status;
  const actions = [];

  // Primary recovery for the blocker type
  if (RECOVERY_ACTIONS[blockerCode]) {
    actions.push({ ...RECOVERY_ACTIONS[blockerCode], primary: true });
  }

  // Secondary: retry with alternate strategy
  if (task.constraint_level && task.constraint_level < 4) {
    actions.push({
      ...RECOVERY_ACTIONS['constraint-exhausted'],
      label: `Advance to Constraint Level ${task.constraint_level + 1}`,
    });
  }

  // Tertiary: force complete (if outputs exist)
  if (task.artifacts?.length && task.status === 'review') {
    actions.push(RECOVERY_ACTIONS['stale-review']);
  }

  // Always offer: provide input
  if (!actions.find(a => a.label === RECOVERY_ACTIONS['human-decision-required'].label)) {
    actions.push(RECOVERY_ACTIONS['human-decision-required']);
  }

  return actions.sort((a, b) => (b.historicalSuccess || 0) - (a.historicalSuccess || 0));
}

/**
 * Execute a recovery action for a task.
 * Returns { success, message, newStatus }
 */
export function executeRecoveryAction(taskId, actionType, payload = {}) {
  const task = repo.byId('tasks', taskId);
  if (!task) return { success: false, message: 'Task not found' };

  const now = Date.now();
  const history = [...(task.history || []), {
    ts: now, kind: 'recovery-action', by: 'user',
    note: `Recovery: ${actionType}${payload.input ? ` — ${payload.input.slice(0, 100)}` : ''}`,
  }];

  switch (actionType) {
    case 'retry-constrained':
      repo.patch('tasks', taskId, {
        status: 'queued',
        constraint_level: Math.min((task.constraint_level || 1) + 1, 3),
        history,
      });
      return { success: true, message: 'Re-queued with stricter constraints', newStatus: 'queued' };

    case 'expand-scope':
      repo.patch('tasks', taskId, {
        status: 'queued',
        constraint_level: Math.max((task.constraint_level || 1) - 1, 1),
        retry_mutation_required: true,
        history,
      });
      return { success: true, message: 'Re-queued with expanded scope', newStatus: 'queued' };

    case 'provide-input':
      repo.patch('tasks', taskId, {
        status: 'queued',
        feedback_requeue: true,
        comments: [...(task.comments || []), { ts: now, by: 'user', text: payload.input || '(no input provided)' }],
        history,
      });
      return { success: true, message: 'Input provided — task re-queued', newStatus: 'queued' };

    case 'force-complete':
      if (task.gates_failed?.length) {
        return { success: false, message: 'Cannot force complete — output gates failed' };
      }
      repo.patch('tasks', taskId, {
        status: 'done',
        outcome: payload.outcome || 'Force-completed by user',
        history,
      });
      return { success: true, message: 'Task marked as complete', newStatus: 'done' };

    case 'repair-dependencies':
      repo.patch('tasks', taskId, {
        status: 'queued',
        blocked_reason: null,
        history,
      });
      return { success: true, message: 'Dependencies cleared — task re-queued for repair', newStatus: 'queued' };

    case 'alternate-tool':
      repo.patch('tasks', taskId, {
        status: 'queued',
        retry_mutation_required: true,
        history,
      });
      return { success: true, message: 'Re-queued with alternate approach required', newStatus: 'queued' };

    case 'escalate':
      repo.patch('tasks', taskId, {
        status: 'needs-human',
        history: [...history, { ts: now, kind: 'escalated', by: 'user', note: 'Escalated by user' }],
      });
      return { success: true, message: 'Escalated — awaiting admin resolution', newStatus: 'needs-human' };

    default:
      return { success: false, message: `Unknown action: ${actionType}` };
  }
}
