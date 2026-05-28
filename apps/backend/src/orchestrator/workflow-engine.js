// Gavirila Homestead 1.0 — Workflow Engine
// Single source of truth for task lifecycle transitions and typed handoffs.
// task-runner.js calls this to transition states instead of patching repo directly.

import { repo } from '../db.js';
import { bus } from './event-bus.js';

// ── Handoff types ────────────────────────────────────────────────────────────
export const HANDOFF_TYPES = {
  NEEDS_EXECUTION:           'needs_execution',
  NEEDS_VERIFICATION:        'needs_verification',
  NEEDS_SECURITY_REVIEW:     'needs_security_review',
  NEEDS_HUMAN_INPUT:         'needs_human_input',
  BLOCKED_BY_ENVIRONMENT:    'blocked_by_environment',
  RESUME_AFTER_CONNECTIVITY: 'resume_after_connectivity',
  NEEDS_REQUIREMENTS:        'needs_requirements_clarification',
  NEEDS_ARCHITECTURE:        'needs_architecture_decision',
};

// ── Task lifecycle states ─────────────────────────────────────────────────────
export const TASK_STATES = {
  QUEUED:              'queued',
  CLAIMED:             'claimed',
  RUNNING:             'running',
  TRIBUNAL:            'tribunal',
  WAITING_ON_TOOL:     'waiting_on_tool',
  WAITING_ON_NETWORK:  'waiting_on_network',
  WAITING_ON_HUMAN:    'needs-human',
  WAITING_VERIFICATION:'verifying',
  REVIEW:              'review',
  RESUMABLE_ERROR:     'resumable_error',
  FAILED:              'failed',
  DONE:                'done',
  CANCELLED:           'cancelled',
};

// ── Worker job contract ───────────────────────────────────────────────────────
export function createJobContract({ taskId, projectId, objective, allowedTools = [], requiredOutputs = [], verificationMode = 'auto', attemptNumber = 1 }) {
  return {
    job_id: `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    task_id: taskId,
    project_id: projectId,
    objective,
    allowed_tools: allowedTools,
    required_outputs: requiredOutputs,
    verification_mode: verificationMode,
    attempt_number: attemptNumber,
    created_at: Date.now(),
    checkpoint: null,
  };
}

// ── Claim a task (queued → claimed) ──────────────────────────────────────────
export function claimTask(taskId, agentId) {
  const task = repo.byId('tasks', taskId);
  if (!task) return null;
  if (task.status !== 'queued') return null;

  const updated = repo.patch('tasks', taskId, {
    status: 'claimed',
    claimed_by: agentId,
    claimed_at: Date.now(),
    updated_at: Date.now(),
    history: [...(task.history || []), { ts: Date.now(), kind: 'claimed', by: agentId }],
  });
  bus.publish('task:lifecycle', { type: 'task:claimed', source: 'workflow-engine', data: { taskId, agentId } });
  return updated;
}

// ── Start execution (claimed → running) ──────────────────────────────────────
export function startExecution(taskId, jobId) {
  const task = repo.byId('tasks', taskId);
  if (!task) return null;

  const updated = repo.patch('tasks', taskId, {
    status: 'running',
    current_job_id: jobId,
    started_at: Date.now(),
    updated_at: Date.now(),
    history: [...(task.history || []), { ts: Date.now(), kind: 'execution_started', by: 'workflow', note: `job: ${jobId}` }],
  });
  bus.publish('task:lifecycle', { type: 'task:execution_started', source: 'workflow-engine', data: { taskId, jobId } });
  return updated;
}

// ── Save checkpoint ──────────────────────────────────────────────────────────
export function saveCheckpoint(taskId, checkpoint) {
  const task = repo.byId('tasks', taskId);
  if (!task) return null;
  return repo.patch('tasks', taskId, {
    checkpoint,
    checkpoint_at: Date.now(),
    updated_at: Date.now(),
  });
}

// ── Emit a typed handoff ─────────────────────────────────────────────────────
export function emitHandoff(taskId, handoffType, context = {}) {
  const task = repo.byId('tasks', taskId);
  if (!task) return;

  const handoffStatusMap = {
    [HANDOFF_TYPES.NEEDS_HUMAN_INPUT]:         TASK_STATES.WAITING_ON_HUMAN,
    [HANDOFF_TYPES.BLOCKED_BY_ENVIRONMENT]:    TASK_STATES.RESUMABLE_ERROR,
    [HANDOFF_TYPES.RESUME_AFTER_CONNECTIVITY]: TASK_STATES.WAITING_ON_NETWORK,
    [HANDOFF_TYPES.NEEDS_VERIFICATION]:        TASK_STATES.WAITING_VERIFICATION,
    [HANDOFF_TYPES.NEEDS_EXECUTION]:           TASK_STATES.QUEUED,
  };

  const nextStatus = handoffStatusMap[handoffType] || TASK_STATES.REVIEW;

  repo.patch('tasks', taskId, {
    status: nextStatus,
    handoff_type: handoffType,
    handoff_context: context,
    updated_at: Date.now(),
    history: [...(task.history || []), { ts: Date.now(), kind: 'handoff', by: 'workflow', note: `${handoffType}: ${context.reason || ''}` }],
  });

  bus.publish('task:lifecycle', { type: 'task:handoff', source: 'workflow-engine', data: { taskId, handoffType, context } });
}

// ── Complete a task ──────────────────────────────────────────────────────────
export function completeTask(taskId, outcome, evidenceBundle = null) {
  const task = repo.byId('tasks', taskId);
  if (!task) return null;

  const hasEvidence = !!evidenceBundle;
  const newStatus = hasEvidence && evidenceBundle.verified ? 'done' : 'review';

  const updated = repo.patch('tasks', taskId, {
    status: newStatus,
    outcome,
    completed_at: Date.now(),
    updated_at: Date.now(),
    verification_status: hasEvidence ? (evidenceBundle.verified ? 'verified' : 'unverified') : 'not_run',
    evidence_bundles: hasEvidence ? [...(task.evidence_bundles || []), evidenceBundle] : task.evidence_bundles,
    history: [...(task.history || []), {
      ts: Date.now(),
      kind: hasEvidence && evidenceBundle.verified ? 'completed_verified' : 'completion_claimed',
      by: 'workflow',
      note: hasEvidence ? `evidence: ${evidenceBundle.id}` : 'no evidence bundle',
    }],
  });

  bus.publish('task:lifecycle', {
    type: newStatus === 'done' ? 'task:done' : 'task:review',
    source: 'workflow-engine',
    data: { taskId, outcome, evidenceBundle },
  });
  return updated;
}

// ── Fail a task ───────────────────────────────────────────────────────────────
export function failTask(taskId, reason, retryable = false) {
  const task = repo.byId('tasks', taskId);
  if (!task) return null;

  const newStatus = retryable ? 'resumable_error' : 'failed';
  const updated = repo.patch('tasks', taskId, {
    status: newStatus,
    error: reason,
    updated_at: Date.now(),
    history: [...(task.history || []), { ts: Date.now(), kind: 'failed', by: 'workflow', note: reason?.slice(0, 200) }],
  });
  bus.publish('task:lifecycle', { type: 'task:failed', source: 'workflow-engine', data: { taskId, reason, retryable } });
  return updated;
}

// ── Handle network interruption ────────────────────────────────────────────────
export function handleNetworkInterruption(taskId, checkpoint = null) {
  const task = repo.byId('tasks', taskId);
  if (!task) return;

  if (checkpoint) saveCheckpoint(taskId, checkpoint);
  emitHandoff(taskId, HANDOFF_TYPES.RESUME_AFTER_CONNECTIVITY, {
    reason: 'network interruption', paused_at: Date.now(),
  });
}

// ── Resume from checkpoint ────────────────────────────────────────────────────
export function resumeTask(taskId) {
  const task = repo.byId('tasks', taskId);
  if (!task) return null;
  if (!['resumable_error', 'waiting_on_network'].includes(task.status)) return null;

  const updated = repo.patch('tasks', taskId, {
    status: 'queued',
    resumed_at: Date.now(),
    updated_at: Date.now(),
    history: [...(task.history || []), { ts: Date.now(), kind: 'resumed', by: 'workflow' }],
  });
  bus.publish('task:lifecycle', { type: 'task:resumed', source: 'workflow-engine', data: { taskId } });
  return updated;
}

// ── Auto-resume tasks stuck in resumable_error after a delay ──────────────────
const RESUME_AFTER_MS = 2 * 60_000; // 2 minutes
export function reconcileStuckTasks() {
  const stuck = repo.list('tasks').filter((t) =>
    t.status === 'resumable_error' || t.status === 'waiting_on_network'
  );
  for (const task of stuck) {
    const stuckSince = task.updated_at || 0;
    if (Date.now() - stuckSince > RESUME_AFTER_MS) {
      resumeTask(task.id);
    }
  }
}

export default {
  HANDOFF_TYPES, TASK_STATES, createJobContract,
  claimTask, startExecution, saveCheckpoint, emitHandoff,
  completeTask, failTask, handleNetworkInterruption, resumeTask, reconcileStuckTasks,
};
