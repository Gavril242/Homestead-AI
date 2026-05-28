// Gavirila Homestead — Truthful Status Service (B1-04)
// Single source of truth for human-facing state summaries.
// Generated from live task graph — never from LLM context or cache.

import { repo } from '../db.js';
import { bus } from '../orchestrator/event-bus.js';
import { createHash } from 'node:crypto';
import { BLOCKER_CODES } from '../orchestrator/blocker-codes.js';

const HEARTBEAT_STALE_MS = 3 * 60_000;
const PROGRESS_STALE_MS = 15 * 60_000;

// Short TTL cache — invalidated on task:lifecycle events
let _cache = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 5_000;

// Subscribe to task lifecycle for cache invalidation
bus.subscribe('task:lifecycle', '__status-service__', () => {
  _cache = null;
  _cacheTs = 0;
});

/**
 * Compute project health status from live DB state.
 * This is the ONLY function that should generate human-facing summaries.
 *
 * @param {string} projectId
 * @returns {object} Structured status summary
 */
export function computeProjectStatus(projectId) {
  // Check cache
  const cacheKey = `${projectId}:${Date.now()}`;
  if (_cache && _cache.projectId === projectId && (Date.now() - _cacheTs) < CACHE_TTL_MS) {
    return _cache;
  }

  const tasks = repo.list('tasks').filter(t => t.project_id === projectId);

  // Count by status
  const counts = {
    queued: 0, running: 0, done: 0, failed: 0,
    review: 0, blocked: 0, 'needs-human': 0,
    tribunal: 0, cancelled: 0, other: 0,
  };
  for (const t of tasks) {
    if (counts.hasOwnProperty(t.status)) counts[t.status]++;
    else counts.other++;
  }

  const stalledRunning = tasks.filter((t) => {
    if (t.status !== 'running') return false;
    const lastHeartbeat = t.heartbeat_at || t.started_at || t.updated_at || 0;
    const lastProgress = t.last_progress_at || (t.artifacts || []).slice(-1)[0]?.ts || t.started_at || t.updated_at || 0;
    return (Date.now() - lastHeartbeat) > HEARTBEAT_STALE_MS || (Date.now() - lastProgress) > PROGRESS_STALE_MS;
  });

  // Blocked tasks with reasons
  const blockers = tasks
    .filter(t => (t.status === 'blocked' || t.status === 'needs-human') && t.blocked_reason)
    .map(t => ({
      task_id: t.id,
      title: t.title,
      status: t.status,
      code: t.blocked_reason.code,
      short: t.blocked_reason.short,
      remediation: t.blocked_reason.remediation,
      dep_ids: t.blocked_reason.dep_ids || [],
      blocked_since: t.blocked_reason.ts || t.updated_at,
    }));

  // Stale reviews: in review > 30 min with no human action
  const STALE_REVIEW_MS = 30 * 60_000;
  const staleReview = tasks.filter(t =>
    t.status === 'review' &&
    (Date.now() - (t.updated_at || 0)) > STALE_REVIEW_MS
  );

  // Deadlock detection: all non-terminal tasks are blocked
  const activeNonTerminal = tasks.filter(t =>
    !['done', 'failed', 'cancelled'].includes(t.status)
  );
  const allBlocked = activeNonTerminal.length > 0 &&
    activeNonTerminal.every(t => t.status === 'blocked' || t.status === 'needs-human');
  const deadlockCount = allBlocked ? 1 : 0;

  // Last successful completion
  const doneTasks = tasks.filter(t => t.status === 'done' && t.updated_at);
  const lastCompletion = doneTasks.length > 0
    ? Math.max(...doneTasks.map(t => t.updated_at))
    : null;

  // Progress: done / (total - cancelled)
  const totalActive = tasks.length - counts.cancelled;
  const progressPct = totalActive > 0
    ? Math.round((counts.done / totalActive) * 100)
    : 0;

  const blockedCount = blockers.length;

  // Health score (0-100): penalize blocked, failed, stale
  let health = 100;
  if (totalActive > 0) {
    health -= Math.round((blockedCount / totalActive) * 30);
    health -= Math.round((counts.failed / totalActive) * 20);
    health -= Math.round((staleReview.length / totalActive) * 15);
    health -= Math.round((stalledRunning.length / totalActive) * 20);
    health -= deadlockCount * 25;
    health = Math.max(0, Math.min(100, health));
  }

  // Compute digest hash for idempotency check
  const statusArray = tasks.map(t => `${t.id}:${t.status}`).sort().join('|');
  const digestHash = createHash('sha256').update(statusArray).digest('hex').slice(0, 16);

  const result = {
    projectId,
    source_timestamp: Date.now(),
    digest_hash: digestHash,

    // Counts
    total_tasks: tasks.length,
    progress_pct: progressPct,
    running_count: counts.running,
    stalled_running_count: stalledRunning.length,
    queued_count: counts.queued,
    blocked_count: blockedCount,
    failed_count: counts.failed,
    done_count: counts.done,
    review_count: counts.review,
    needs_human_count: counts['needs-human'],
    stale_review_count: staleReview.length,
    deadlock_count: deadlockCount,

    // Timing
    last_successful_completion: lastCompletion,

    // Health
    health_score: health,

    // Structured blockers
    blockers,

    // Running tasks whose heartbeat or progress is stale
    stalled_running: stalledRunning.map(t => ({
      task_id: t.id,
      title: t.title,
      heartbeat_age_ms: Date.now() - (t.heartbeat_at || t.started_at || t.updated_at || 0),
      progress_age_ms: Date.now() - (t.last_progress_at || (t.artifacts || []).slice(-1)[0]?.ts || t.started_at || t.updated_at || 0),
      progress_summary: t.progress_summary || '',
    })),

    // Stale reviews needing attention
    stale_reviews: staleReview.map(t => ({
      task_id: t.id,
      title: t.title,
      stuck_since: t.updated_at,
      age_min: Math.round((Date.now() - (t.updated_at || 0)) / 60_000),
    })),

    // Deadlock alert
    deadlock: allBlocked ? {
      active_tasks: activeNonTerminal.length,
      message: 'All active tasks are blocked — no forward progress possible without intervention.',
    } : null,
  };

  // Cache
  _cache = result;
  _cacheTs = Date.now();

  return result;
}

/**
 * Compute a brief, one-line health summary for embedding in agent context.
 */
export function computeHealthOneLiner(projectId) {
  const s = computeProjectStatus(projectId);
  const parts = [];
  parts.push(`${s.done_count}/${s.total_tasks} done (${s.progress_pct}%)`);
  if (s.running_count) parts.push(`${s.running_count} running`);
  if (s.blocked_count) parts.push(`${s.blocked_count} blocked`);
  if (s.stalled_running_count) parts.push(`${s.stalled_running_count} stalled-running`);
  if (s.failed_count) parts.push(`${s.failed_count} failed`);
  if (s.deadlock_count) parts.push('⚠️ DEADLOCK');
  return parts.join(', ') + ` | health: ${s.health_score}/100`;
}
