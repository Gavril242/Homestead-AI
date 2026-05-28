// Conductor supervisor.
//
// A continuous read-mostly loop. Runs every TICK_MS, scans every project,
// and uses the LLM to decide if any stall needs intervention. When the
// Conductor identifies a missing follow-up or a stuck ticket, it:
//   • Calls db_create_task to spawn corrective work
//   • Calls task_post_update to nudge stuck tickets
//   • Emits a notification toast for the human if escalation is needed
//
// This is what makes the system feel autonomous — the orchestrator
// continuously prods work forward without the user re-asking.

import { repo } from '../db.js';
import { chat } from '../llm/index.js';
import { getAgent } from './agents.js';
import { executeTool } from '../tools/registry.js';
import { createBlockedReason } from './blocker-codes.js';

const TICK_MS = 3 * 60_000;            // every 3 min (was 60s — too aggressive, fought the runner)
const HEARTBEAT_STALE_MS = 3 * 60_000; // a running task without a heartbeat is not alive, regardless of narrative activity
const STALL_AFTER_MS = 15 * 60_000;    // 15 min before considering a task stalled (was 5 — normal tasks take 8-12 min)
const NEEDS_INFO_REMIND_MS = 60 * 60_000; // 1 hour before nudging needs-info (was 30 min)
const COOLDOWN_PER_TASK_MS = 15 * 60_000; // 15 min cooldown between pokes on same task (was 8 min)

const lastProd = new Map();  // taskId → { ts, count, lastStatus }


let running = false;
let intervalHandle = null;

function getTaskActivity(task, now = Date.now()) {
  const lastArtifactAt = (task.artifacts || []).slice(-1)[0]?.ts || 0;
  const lastHeartbeatAt = task.heartbeat_at || task.started_at || task.updated_at || 0;
  const lastProgressAt = task.last_progress_at || lastArtifactAt || task.started_at || task.updated_at || 0;
  return {
    lastHeartbeatAt,
    lastProgressAt,
    heartbeatAgeMs: now - lastHeartbeatAt,
    progressAgeMs: now - lastProgressAt,
  };
}

function escalateExecutionStall(target, projectId, broadcast, now, last, activity, reason) {
  const notif = {
    id: `n-sup-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    ts: now, kind: 'needs-human',
    project_id: target.project_id, task_id: target.id,
    title: `${target.by || 'Agent'} is stuck on "${target.title}"`,
    body: `Task ${target.id} has been escalated for stalled execution (status: ${target.status}). ${reason}`.trim(),
  };
  repo.prepend('notifications', notif, 200);
  broadcast?.({ kind: 'notification', notification: notif });
  broadcast?.({ kind: 'toast', toast: { title: notif.title, body: notif.body, color: 'red', icon: 'warn', kind: 'warn' } });
  repo.patch('tasks', target.id, {
    status: 'needs-human',
    blocked_reason: createBlockedReason('execution-stalled', {
      supervisor_pokes: last.count,
      heartbeat_age_ms: activity?.heartbeatAgeMs,
      progress_age_ms: activity?.progressAgeMs,
      last_heartbeat_at: activity?.lastHeartbeatAt || null,
      last_progress_at: activity?.lastProgressAt || null,
      reason,
    }),
    history: [...(target.history || []), {
      ts: now, kind: 'escalated', by: 'supervisor',
      note: reason,
    }],
  });
  broadcast?.({ kind: 'task:update', task: repo.byId('tasks', target.id) });
  lastProd.set(target.id, { ts: now, count: 0, lastStatus: 'needs-human' });
  console.warn(`[supervisor] escalated ${target.id} to human: ${reason}`);
  return {
    projectId,
    taskId: target.id,
    status: target.status,
    heartbeat_age_ms: activity?.heartbeatAgeMs,
    progress_age_ms: activity?.progressAgeMs,
  };
}

export function startConductorSupervisor(broadcast) {
  if (intervalHandle) return intervalHandle;
  console.log('[supervisor] starting Conductor cross-project supervisor');
  intervalHandle = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runConductorSupervisorPass(broadcast);
    } catch (err) {
      console.error('[supervisor] tick error:', err.message);
    } finally {
      running = false;
    }
  }, TICK_MS);
  intervalHandle.unref?.();
  return intervalHandle;
}

export async function runConductorSupervisorPass(broadcast, options = {}) {
  const { projectId = null, taskId = null, force = false } = options || {};
  const projects = projectId
    ? repo.list('projects').filter((project) => project.id === projectId)
    : repo.list('projects');
  const allTasks = repo.list('tasks');
  const now = Date.now();
  const result = {
    ts: now,
    filters: { projectId, taskId, force: !!force },
    projects_scanned: projects.length,
    candidates: [],
    nudged: [],
    escalated: [],
    skipped_cooldown: [],
  };

  for (const project of projects) {
    const projectTasks = allTasks.filter((t) => t.project_id === project.id && (!taskId || t.id === taskId));
    if (!projectTasks.length) continue;

    const stalls = projectTasks.filter((t) => {
      if (t.status === 'running') {
        const activity = getTaskActivity(t, now);
        return activity.heartbeatAgeMs > HEARTBEAT_STALE_MS || activity.progressAgeMs > STALL_AFTER_MS;
      }
      if (t.status === 'needs-info') {
        return now - (t.updated_at || 0) > NEEDS_INFO_REMIND_MS;
      }
      return false;
    });

    const staleReview = projectTasks.filter((t) =>
      (t.status === 'review' || t.status === 'done') &&
      now - (t.updated_at || 0) > 90_000 &&
      !hasDownstream(t, projectTasks),
    );

    if (!stalls.length && !staleReview.length) continue;

    // Pick the most actionable one (oldest stall first).
    const target = [...stalls, ...staleReview].sort((a, b) => (a.updated_at || 0) - (b.updated_at || 0))[0];
    if (!target) continue;
    result.candidates.push({ projectId: project.id, taskId: target.id, status: target.status });

    const last = lastProd.get(target.id) || { ts: 0, count: 0, lastStatus: null };
    if (!force && now - last.ts < COOLDOWN_PER_TASK_MS) {
      result.skipped_cooldown.push({ projectId: project.id, taskId: target.id, status: target.status });
      continue;
    }

    const activity = target.status === 'running' ? getTaskActivity(target, now) : null;
    const missedHeartbeat = !!activity && activity.heartbeatAgeMs > HEARTBEAT_STALE_MS;
    const maxPokesBeforeHuman = missedHeartbeat ? 1 : 5;

    if (missedHeartbeat) {
      const escalation = escalateExecutionStall(
        target,
        project.id,
        broadcast,
        now,
        last,
        activity,
        `runner heartbeat stale for ${Math.round(activity.heartbeatAgeMs / 1000)}s`,
      );
      result.escalated.push(escalation);
      continue;
    }

    // After 5 pokes with no status change — stop burning LLM calls and
    // escalate straight to the human with a persistent notification.
    const sameStatus = last.lastStatus === target.status;
    if (last.count >= maxPokesBeforeHuman && sameStatus) {
      const escalation = escalateExecutionStall(
        target,
        project.id,
        broadcast,
        now,
        last,
        activity,
        `escalated to human after ${last.count} supervisor pokes with no progress`,
      );
      result.escalated.push(escalation);
      continue;
    }

    lastProd.set(target.id, { ts: now, count: (sameStatus ? last.count : 0) + 1, lastStatus: target.status });

    const supervised = await superviseOne(project, target, projectTasks, broadcast);
    result.nudged.push({
      projectId: project.id,
      taskId: target.id,
      status: target.status,
      action: supervised?.action || 'inspect',
      tool_calls: supervised?.toolCalls || [],
    });
  }

  return result;
}

function hasDownstream(task, all) {
  return all.some((t) => (t.depends_on || []).includes(task.id));
}

async function superviseOne(project, task, projectTasks, broadcast) {
  const conductor = getAgent('conductor');
  if (!conductor) return { action: 'no-conductor', toolCalls: [] };

  const tasksSummary = projectTasks.slice(0, 30).map((t) =>
    `  ${t.id} [${t.status}] (${t.by}) — ${t.title}`).join('\n');
  const targetArtifacts = (task.artifacts || []).slice(-8).map((a) => `  ${a.summary}`).join('\n') || '  (none)';
  const targetMessages = (task.messages || []).slice(-6).map((m) => `  [${m.kind || 'msg'}] ${m.by}: ${m.text?.slice(0, 200)}`).join('\n') || '  (none)';

  const prompt = `
You are the Conductor running a SUPERVISOR PASS — not an interactive chat.
A ticket needs your attention.

PROJECT: ${project.name} (${project.id})

TICKET IN QUESTION:
  id: ${task.id}
  title: ${task.title}
  by: ${task.by}
  status: ${task.status}
  age: ${Math.round((Date.now() - (task.updated_at || task.created_at || 0)) / 1000)}s since last update
  heartbeat_age: ${task.status === 'running' ? Math.round(getTaskActivity(task).heartbeatAgeMs / 1000) : 'n/a'}s
  progress_age: ${task.status === 'running' ? Math.round(getTaskActivity(task).progressAgeMs / 1000) : 'n/a'}s
  attempts: ${task.attempts || 0}

Recent artifacts on this ticket:
${targetArtifacts}

Recent messages:
${targetMessages}

Other open tasks in this project:
${tasksSummary}

YOUR JOB: pick ONE corrective action and call its tool ONCE, then summarize in 1-2 lines.
Options:
  • If the ticket is stuck mid-work, call task_post_update on it with concrete advice ("Forge: skip the npm install retry, the workspace already has node_modules").
  • If a "review" ticket has no downstream task, call db_create_task to spawn the next stage (test for impl, debug for failed test, etc.).
  • If the ticket needs human attention you cannot resolve, call task_post_update with kind="blocker" so a notification fires.
  • If everything looks fine on closer inspection, just say so — don't call any tool.

Do NOT invent new tickets out of thin air. Stay narrowly focused on this one ticket.
`.trim();

  try {
    const { reply, toolCalls } = await chat({
      messages: [{ role: 'user', content: prompt }],
      system: conductor.systemPrompt({ project, tasks: projectTasks }),
      tier: 'strong', agent: 'conductor', purpose: 'plan',
      toolScopes: conductor.toolScopes,
      toolCtx: { repo, broadcast, agentId: 'conductor', projectId: project.id, taskId: task.id },
    });
    console.log(`[supervisor] poked ${task.id} (${task.status}): ${reply.slice(0, 80)}`);
    broadcast?.({ kind: 'supervisor:tick', taskId: task.id, project_id: project.id,
      reply: reply.slice(0, 200), tool_calls: (toolCalls || []).map((tc) => tc.name) });
    return { action: reply.slice(0, 200), toolCalls: (toolCalls || []).map((tc) => tc.name) };
  } catch (err) {
    console.warn(`[supervisor] LLM call failed for ${task.id}:`, err.message);
    return { action: `llm-error: ${err.message}`, toolCalls: [] };
  }
}
