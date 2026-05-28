// Gavirila Homestead — Mission Contract System (B1-01)
// Every decomposition creates an immutable Mission Contract.
// Tasks must map to a mission output. No task creation outside mission scope.

import { repo } from '../db.js';
import { bus } from '../orchestrator/event-bus.js';

const MISSION_BLOCKER_STATUSES = new Set(['needs-human', 'failed', 'tribunal', 'blocked']);

/**
 * @typedef {object} MissionContract
 * @property {string} id
 * @property {string} project_id
 * @property {string} user_intent - Original goal/request
 * @property {string[]} scope_boundaries - What's in scope
 * @property {string[]} required_outputs - All outputs the mission must produce
 * @property {string[]} accepted_methods - Allowed approaches
 * @property {string[]} hard_constraints - Non-negotiable rules
 * @property {object[]} quality_gates - Gates that must pass
 * @property {string[]} stop_conditions - When to stop
 * @property {string[]} task_ids - Tasks linked to this mission
 * @property {object} output_mapping - taskId → which outputs it contributes to
 * @property {string} status - active, completed, abandoned
 * @property {number} created_at
 * @property {number} updated_at
 */

/**
 * Create a new Mission Contract from a conductor pipeline decomposition.
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.goal - User intent / original goal
 * @param {object} params.plan - Decomposition result (summary, techStack, tasks)
 * @param {Array} params.createdTasks - Task rows created from the plan
 * @returns {MissionContract}
 */
export function createMission({ projectId, goal, plan, createdTasks }) {
  const id = `mission-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  // Derive required outputs from all tasks
  const allOutputs = createdTasks
    .flatMap(t => t.required_outputs || t.row?.required_outputs || [])
    .filter(Boolean);

  // Build output mapping: which task contributes which outputs
  const outputMapping = {};
  for (const t of createdTasks) {
    const taskRow = t.row || t;
    const outputs = taskRow.required_outputs || [];
    if (outputs.length) {
      outputMapping[taskRow.id] = outputs;
    }
  }

  const mission = {
    id,
    project_id: projectId,
    user_intent: goal,
    summary: plan.summary || '',
    tech_stack: plan.techStack || '',
    scope_boundaries: extractScopeBoundaries(goal, plan),
    required_outputs: [...new Set(allOutputs)],
    accepted_methods: [],
    hard_constraints: [],
    quality_gates: createdTasks
      .filter(t => (t.row || t).acceptance_commands?.length > 0)
      .map(t => ({
        task_id: (t.row || t).id,
        commands: (t.row || t).acceptance_commands,
      })),
    stop_conditions: ['all required_outputs present', 'all quality_gates pass'],
    task_ids: createdTasks.map(t => (t.row || t).id),
    output_mapping: outputMapping,
    adaptation_rules: [],
    status: 'active',
    created_at: Date.now(),
    updated_at: Date.now(),
  };

  repo.upsert('missions', mission);

  // Link tasks back to mission
  for (const t of createdTasks) {
    const taskId = (t.row || t).id;
    repo.patch('tasks', taskId, { mission_id: id });
  }

  bus.publish('task:lifecycle', {
    type: 'mission:created',
    source: 'mission-contract',
    data: { missionId: id, projectId, taskCount: createdTasks.length },
  });

  return mission;
}

/**
 * List canonical mission summaries for a project.
 * @param {object} [filters]
 * @param {string} [filters.projectId]
 * @returns {Array<object>}
 */
export function listMissionSummaries({ projectId } = {}) {
  return (repo.list('missions') || [])
    .filter((mission) => !projectId || mission.project_id === projectId)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
    .map((mission) => buildMissionSummary(mission.id))
    .filter(Boolean);
}

/**
 * Get one canonical mission summary by id.
 * @param {string} missionId
 * @returns {object|null}
 */
export function getMissionSummaryById(missionId) {
  return buildMissionSummary(missionId);
}

/**
 * Validate that a new task maps to an existing mission's outputs.
 * Returns null if valid, or an error string if invalid.
 * @param {object} task - Task to validate
 * @param {string} [missionId] - Optional mission to check against
 * @returns {string|null} Error message or null if valid
 */
export function validateTaskMissionMapping(task, missionId) {
  if (!missionId && !task.mission_id) {
    // Tasks without missions are allowed (manual creation, legacy)
    return null;
  }

  const mid = missionId || task.mission_id;
  const mission = repo.byId('missions', mid);
  if (!mission) return `Mission ${mid} not found`;
  if (mission.status !== 'active') return `Mission ${mid} is ${mission.status} — no new tasks allowed`;

  // Task must declare at least one output that maps to mission scope
  // OR be a support task (no outputs) with explicit mission_id
  if (task.required_outputs?.length > 0 && mission.required_outputs.length > 0) {
    const hasMapping = task.required_outputs.some(o =>
      mission.required_outputs.includes(o) ||
      mission.scope_boundaries.some(s => o.includes(s))
    );
    if (!hasMapping) {
      return `Task outputs ${JSON.stringify(task.required_outputs)} do not map to mission ${mid} scope`;
    }
  }

  return null;
}

/**
 * Check mission completion status.
 * @param {string} missionId
 * @returns {{ complete: boolean, progress_pct: number, missing_outputs: string[] }}
 */
export function checkMissionCompletion(missionId) {
  const mission = repo.byId('missions', missionId);
  if (!mission) return { complete: false, progress_pct: 0, missing_outputs: [] };

  const tasks = mission.task_ids
    .map(id => repo.byId('tasks', id))
    .filter(Boolean);

  const doneTasks = tasks.filter(t => t.status === 'done');
  const progressPct = tasks.length > 0
    ? Math.round((doneTasks.length / tasks.length) * 100)
    : 0;

  // Check which required outputs are covered by done tasks
  const coveredOutputs = new Set();
  for (const t of doneTasks) {
    for (const o of (t.required_outputs || [])) {
      coveredOutputs.add(o);
    }
  }

  const missingOutputs = mission.required_outputs.filter(o => !coveredOutputs.has(o));

  const complete = missingOutputs.length === 0 && tasks.every(t =>
    ['done', 'cancelled'].includes(t.status)
  );

  if (complete && mission.status === 'active') {
    repo.patch('missions', missionId, {
      status: 'completed',
      completed_at: Date.now(),
      updated_at: Date.now(),
    });
  }

  return { complete, progress_pct: progressPct, missing_outputs: missingOutputs };
}

/**
 * Add an adaptation rule to a mission (controlled scope extension).
 */
export function addAdaptationRule(missionId, rule) {
  const mission = repo.byId('missions', missionId);
  if (!mission) return null;

  const updated = repo.patch('missions', missionId, {
    adaptation_rules: [...(mission.adaptation_rules || []), {
      ...rule,
      added_at: Date.now(),
    }],
    updated_at: Date.now(),
  });

  return updated;
}

/**
 * Get the mission for a task.
 */
export function getMissionForTask(taskId) {
  const task = repo.byId('tasks', taskId);
  if (!task?.mission_id) return null;
  return repo.byId('missions', task.mission_id);
}

function buildMissionSummary(missionId) {
  const mission = repo.byId('missions', missionId);
  if (!mission) return null;

  const completion = checkMissionCompletion(missionId);
  const latestMission = repo.byId('missions', missionId) || mission;
  const blocker = findMissionBlocker(latestMission);

  return {
    id: latestMission.id,
    goal: latestMission.user_intent,
    status: latestMission.status,
    projectId: latestMission.project_id,
    report: buildMissionReport(latestMission, completion),
    taskIds: latestMission.task_ids || [],
    blocker,
    created_at: latestMission.created_at,
    updated_at: latestMission.updated_at,
    progress_pct: completion.progress_pct,
    missing_outputs: completion.missing_outputs,
  };
}

function buildMissionReport(mission, completion) {
  const lines = [];
  if (mission.summary) lines.push(mission.summary);
  if (typeof completion.progress_pct === 'number') {
    lines.push(`Progress: ${completion.progress_pct}%`);
  }
  if (completion.missing_outputs?.length) {
    lines.push(`Missing outputs: ${completion.missing_outputs.join(', ')}`);
  }
  return lines.join('\n').trim();
}

function findMissionBlocker(mission) {
  for (const taskId of mission.task_ids || []) {
    const task = repo.byId('tasks', taskId);
    if (!task || !MISSION_BLOCKER_STATUSES.has(task.status)) continue;
    return {
      id: task.id,
      title: task.title,
      error: task.error || null,
      status: task.status,
    };
  }
  return null;
}

// ── B2-02: Mission Drift Detection ────────────────────────────────────────────

const DRIFT_THRESHOLD = 0.15; // Below this = off-mission
const MAX_OVERRIDES_PER_MISSION = 1;

/**
 * Score how well a task aligns with its project's active mission.
 * Returns a relevance score (0-1) and drift determination.
 *
 * @param {object} task - Task being created (title, desc, required_outputs)
 * @param {string} projectId - Project to check missions for
 * @returns {{ score: number, drifted: boolean, mission_id: string|null, reason: string|null }}
 */
export function scoreMissionAlignment(task, projectId) {
  // Find active mission for this project
  const missions = (repo.list('missions') || []).filter(m =>
    m.project_id === projectId && m.status === 'active'
  );

  if (!missions.length) {
    // No active mission = no drift possible
    return { score: 1, drifted: false, mission_id: null, reason: null };
  }

  // Use the most recent active mission
  const mission = missions.sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];

  // Build corpus from mission intent, outputs, scope, and tech stack
  const missionTerms = extractTerms([
    mission.user_intent,
    mission.summary,
    mission.tech_stack,
    ...(mission.required_outputs || []),
    ...(mission.scope_boundaries || []),
  ].join(' '));

  // Build corpus from task
  const taskTerms = extractTerms([
    task.title || '',
    task.desc || task.description || '',
    ...(task.required_outputs || []),
  ].join(' '));

  if (missionTerms.size === 0 || taskTerms.size === 0) {
    return { score: 0.5, drifted: false, mission_id: mission.id, reason: null };
  }

  // Jaccard-like overlap score
  let overlap = 0;
  for (const term of taskTerms) {
    if (missionTerms.has(term)) overlap++;
  }
  const score = overlap / Math.max(taskTerms.size, 1);

  const drifted = score < DRIFT_THRESHOLD;
  const reason = drifted
    ? `Task relevance score ${(score * 100).toFixed(0)}% below threshold ${(DRIFT_THRESHOLD * 100).toFixed(0)}% — task appears unrelated to mission "${mission.user_intent?.slice(0, 60)}"`
    : null;

  return { score, drifted, mission_id: mission.id, reason };
}

/**
 * Enforce drift check on task creation. Returns null if allowed,
 * or a rejection object if blocked.
 *
 * @param {object} task - Task being created
 * @param {string} projectId
 * @returns {{ blocked: boolean, reason?: string, drift_score?: number, mission_id?: string } | null}
 */
export function enforceDriftCheck(task, projectId) {
  const { score, drifted, mission_id, reason } = scoreMissionAlignment(task, projectId);

  if (!drifted) return null;

  // Check if mission has override budget remaining
  if (mission_id) {
    const mission = repo.byId('missions', mission_id);
    const overridesUsed = (mission?.adaptation_rules || [])
      .filter(r => r.type === 'drift-override').length;
    if (overridesUsed < MAX_OVERRIDES_PER_MISSION) {
      // Allow with override — consume budget
      addAdaptationRule(mission_id, {
        type: 'drift-override',
        task_title: task.title,
        drift_score: score,
        reason: 'Auto-allowed: override budget available',
      });
      return null;
    }
  }

  return {
    blocked: true,
    reason,
    drift_score: score,
    mission_id,
  };
}

/**
 * Extract meaningful terms from text for scoring.
 */
function extractTerms(text) {
  const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'must', 'to', 'of', 'in',
    'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
    'during', 'before', 'after', 'above', 'below', 'between', 'under',
    'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where',
    'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
    'other', 'some', 'such', 'no', 'not', 'only', 'own', 'same', 'so',
    'than', 'too', 'very', 'just', 'because', 'and', 'but', 'or', 'if',
    'this', 'that', 'these', 'those', 'it', 'its', 'file', 'task', 'run',
  ]);

  const words = (text || '').toLowerCase()
    .replace(/[^a-z0-9/_.-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  return new Set(words);
}

// Internal: extract scope boundaries from goal text
function extractScopeBoundaries(goal, plan) {
  const boundaries = [];
  // Extract file paths mentioned
  const pathMatches = goal.match(/[\w/.-]+\.(js|ts|jsx|tsx|md|json|yaml|yml|css|html)/g) || [];
  boundaries.push(...pathMatches);
  // Extract component/module names
  if (plan.techStack) boundaries.push(plan.techStack);
  return [...new Set(boundaries)];
}
