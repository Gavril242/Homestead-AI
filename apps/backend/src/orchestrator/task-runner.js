// Autonomous task runner — v3 (parallel execution engine)
//
// Architecture:
//   • TICK every 3 s — up to 3 tasks per project run in parallel
//   • per-TASK run-set (not per-project) so independent tasks don't block each other
//   • Comment injection — comments added during a run reach the agent on the NEXT
//     continuation round without restarting the task
//   • Scrum-master loop — every 5 min Conductor reviews project health and fills gaps
//   • Requirement context — every task whose parent_req is set gets the full req note
//     injected into its initial mission briefing

import { repo } from '../db.js';
import { getAgent, getAgentSystem } from './agents.js';
import { chat } from '../llm/index.js';
import { callStructured } from '../llm/structured.js';
import { z } from 'zod';
import { readNote } from '../brain/vault.js';
import { recordOutcome } from '../brain/prompt-optimizer.js';
import { conductorPipeline } from './conductor-pipeline.js';
import { buildSkillsBlock } from './skills.js';
import { routeToPlaybook, buildPlaybookBlock } from '../skills/playbook-router.js';
import { checkGuards, buildGuardBlock } from '../brain/failure-guards.js';
import { buildTieredMemoryBlock } from '../brain/tiered-memory.js';
import { recordDecision } from '../services/decision-ledger.js';
import { runTribunal } from './tribunal.js';
import { shouldRunSwarm, runChaosSwarm } from './ui-swarm.js';
import { autoPropagateExternal, getScopesForProject } from '../tools/registry.js';
import { shouldSplit, runArchitectTypist } from './architect-typist.js';
import { applyEscalationLadder } from './escalation-ladder.js';
import { bus } from './event-bus.js';
import { emitHandoff, HANDOFF_TYPES, handleNetworkInterruption, saveCheckpoint, reconcileStuckTasks } from './workflow-engine.js';
import { applyDependencyValidation, areDependenciesSatisfied } from './dependency-validator.js';
import { attemptDependencyRepairs } from './dependency-repair.js';
import { shouldAdvanceLevel, recordLevelAttempt, buildConstraintBlock } from './constraint-levels.js';
import { initTimeMachine, snapshotState } from '../brain/time-machine.js';
import { extractMemories, recallMemories } from '../brain/entity-memory.js';
import { recordFailure, similarFailures } from '../brain/failure-memory.js';
import { setWorkspaceOverride, ensureWorkspace } from '../tools/exec-tools.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';

initTimeMachine();

const TICK_MS                  = 3_000;   // wake every 3 s
const MAX_CONCURRENT_PER_PROJ  = 3;       // up to 3 tasks per project at once
const MAX_AUTO_RETRIES         = 3;       // auto-requeue budget (was 2, raised for resilience)
const MAX_TASK_RUNTIME_MS      = 12 * 60_000; // idle timeout — reset each time agent makes real tool calls
const MAX_TASK_ABSOLUTE_MS     = 35 * 60_000; // hard cap — no task runs longer than this regardless of progress
const DEADLINE_EXTEND_MS       =  8 * 60_000; // how much to add each time agent makes progress
const MAX_TASK_RUNTIME_LABEL   = `${Math.round(MAX_TASK_RUNTIME_MS / 60_000)}min idle / ${Math.round(MAX_TASK_ABSOLUTE_MS / 60_000)}min max`;
const MAX_ROUNDS               = 10;      // enough for explore → edit → validate → finish
const MAX_TOKENS_PER_TASK      = 120_000; // cap prompt burn on routine tasks
const HEARTBEAT_INTERVAL_MS    = 60_000;  // active tasks must prove liveness on a fixed cadence
const SCRUM_INTERVAL_MS        = 15 * 60_000; // scrum-master cadence (15min — reduced thrash)
const CONDUCTOR_COOLDOWN_MS    = 15 * 60_000; // min gap between conductor tasks per project
const REFLECT_INTERVAL_MS      = 30 * 60_000; // self-improvement cadence
const STIR_INTERVAL_MS         = 5 * 60_000;  // how often to stir stuck needs-human tasks
const STIR_MIN_AGE_MS          = 10 * 60_000; // only stir tasks stuck > 10 min in needs-human
const STIR_TRIBUNAL_AGE_MS     = 3 * 60_000;  // re-run tribunal if stuck > 3 min

// Write-class tools — any of these means the agent is doing real work
const WRITE_TOOLS = new Set([
  'fs_write_file', 'fs_mkdir', 'shell_exec', 'shell_bg',
  'db_finish_task', 'db_create_task', 'db_update_task', 'db_create_req',
  'vault_write_note', 'ping_agent',
]);

// ── Smart Rescue — replaces needs-human with autonomous problem-solving ───────
// Instead of freezing the task for human intervention, spawn a Conductor rescue
// task that analyzes the blocker and creates an actionable workaround. Only goes
// to needs-human after the rescue itself fails (absolute last resort).
const MAX_RESCUE_ATTEMPTS = 2;  // max rescue tasks per stuck task

function spawnRescueTask(stuckTask, reason, broadcast) {
  const rescueCount = stuckTask.rescue_count || 0;

  // Safety valve: if rescue has been tried MAX_RESCUE_ATTEMPTS times, give up for real
  if (rescueCount >= MAX_RESCUE_ATTEMPTS) {
    console.warn(`[rescue] ${stuckTask.id} — ${rescueCount} rescue attempts exhausted, genuine needs-human`);
    repo.patch('tasks', stuckTask.id, {
      status: 'needs-human',
      error: `${rescueCount} autonomous rescue attempts failed. Original issue: ${reason.slice(0, 300)}`,
      history: [...(stuckTask.history || []), {
        ts: Date.now(), kind: 'rescue-exhausted', by: 'rescue',
        note: `${rescueCount} rescue attempts failed — escalated to needs-human`,
      }],
    });
    broadcast?.({ kind: 'task:update', task: repo.byId('tasks', stuckTask.id) });
    return;
  }

  // Build a detailed rescue briefing for the Conductor
  const errorHistory = (stuckTask.history || [])
    .filter(h => ['failed', 'demotion-retry', 'demotion-escalated', 'tribunal-failed'].includes(h.kind))
    .slice(-5)
    .map(h => `  [${h.kind}] ${h.note}`)
    .join('\n') || '(no error history)';

  const lastArtifacts = (stuckTask.artifacts || [])
    .slice(-8)
    .map(a => `  [${a.tool}] ${a.summary || JSON.stringify(a.result || {}).slice(0, 150)}`)
    .join('\n') || '(no artifacts)';

  const rescueId = `c-rescue-${Date.now().toString(36)}`;
  const rescueDesc = `**RESCUE MISSION** — Task "${stuckTask.title}" (${stuckTask.id}) is stuck and needs autonomous resolution.

## What went wrong
${reason}

## Error history (last 5 events)
${errorHistory}

## Last artifacts (tool calls)
${lastArtifacts}

## Original task description
${(stuckTask.desc || '').slice(0, 800)}

## YOUR MISSION
You are the Conductor acting as a rescue coordinator. Do NOT simply retry the same approach. Instead:

1. **DIAGNOSE** — Read the error history and artifacts above. Understand the root cause.
2. **FIND A WORKAROUND** — Think laterally. Options:
   - Reassign to a different agent who might handle this better
   - Simplify the task scope (split into smaller achievable subtasks)
   - Remove blocking dependencies
   - Change the technical approach entirely (different tool, different method)
   - Skip the task if it's not critical and mark the parent requirement as partially fulfilled
3. **EXECUTE THE FIX** — Use db_update_task to rewrite the stuck task's description with clear new instructions, or db_create_task to create replacement subtasks, then mark the stuck task as done.
4. **VERIFY** — Ensure the workaround is actionable and doesn't repeat the same mistake.

IMPORTANT: The original task (${stuckTask.id}) is currently paused. After you fix it, either:
- db_update_task it to status "queued" with a rewritten desc (if you want the same task retried differently)
- db_finish_task it as "done" with outcome explaining the workaround
- Create new replacement tasks and finish this one

Agent assigned to stuck task: ${stuckTask.by || 'unknown'}
Project: ${stuckTask.project_id}`;

  // Mark the stuck task as "rescue-pending" so it doesn't get stirred or re-processed
  repo.patch('tasks', stuckTask.id, {
    status: 'blocked',
    rescue_count: rescueCount + 1,
    rescue_task_id: rescueId,
    error: `Rescue task ${rescueId} spawned — autonomous resolution in progress`,
    history: [...(stuckTask.history || []), {
      ts: Date.now(), kind: 'rescue-spawned', by: 'rescue',
      note: `Rescue attempt ${rescueCount + 1}/${MAX_RESCUE_ATTEMPTS}: spawned ${rescueId}`,
    }],
  });

  // Create the rescue task assigned to Conductor
  repo.upsert('tasks', {
    id: rescueId,
    project_id: stuckTask.project_id,
    title: `[Rescue] ${stuckTask.title.slice(0, 60)}`,
    desc: rescueDesc,
    by: 'conductor',
    status: 'queued',
    priority: 'high',
    parent_task_id: stuckTask.id,
    created_at: Date.now(),
    history: [{ ts: Date.now(), kind: 'created', by: 'rescue', note: `Rescue for stuck task ${stuckTask.id}` }],
  });

  broadcast?.({ kind: 'task:update', task: repo.byId('tasks', stuckTask.id) });
  broadcast?.({ kind: 'task:update', task: repo.byId('tasks', rescueId) });
  broadcast?.({ kind: 'toast', toast: {
    title: '🚑 Rescue Dispatched',
    body: `"${stuckTask.title.slice(0, 50)}" — Conductor analyzing blocker`,
    icon: 'wrench', color: 'purple', kind: 'info',
  }});
  console.log(`[rescue] spawned ${rescueId} for stuck task ${stuckTask.id} (attempt ${rescueCount + 1})`);
}

// Detect spin loops: repeated identical calls or pure-research spirals.
// Returns a human-readable reason string, or null if healthy.
// NOTE: pass `round` so we never fire on the first exploration round.
function detectLoop(allArtifacts, round) {
  // Never stop an agent on its first round — that's always pure exploration
  if (round <= 1) return null;
  if (allArtifacts.length < 4) return null;

  // Tools that count as legitimate "startup" reads — always allowed
  const STARTUP_TOOLS = new Set([
    'vault_read_note', 'list_active_tasks', 'db_list_reqs', 'db_list_tasks',
    'db_list_bugs', 'vault_list_notes', 'db_get_task', 'vault_search',
    'db_list_projects', 'ask_human',
    'fs_list_dir', 'fs_read_file',
  ]);

  // Fingerprint = tool + primary arg (path/dir/cmd)
  const fp = (a) => {
    const args = a.args || {};
    switch (a.tool) {
      case 'fs_list_dir':  return `list:${args.dir || '.'}`;
      case 'fs_read_file': return `read:${args.path || ''}`;
      case 'shell_exec':   return `shell:${(args.cmd || '').trim().slice(0, 100)}`;
      case 'shell_bg':     return `shell_bg:${(args.cmd || '').trim().slice(0, 60)}`;
      default:             return a.tool;
    }
  };

  // 1. Repeated identical non-write call ≥ 3 times in last 12
  const recent = allArtifacts.slice(-12);
  const counts = {};
  for (const a of recent) {
    if (STARTUP_TOOLS.has(a.tool)) continue; // never flag startup reads
    counts[fp(a)] = (counts[fp(a)] || 0) + 1;
  }
  for (const [key, n] of Object.entries(counts)) {
    const artifact = recent.find((a) => fp(a) === key);
    if (n >= 3 && artifact && !WRITE_TOOLS.has(artifact.tool)) {
      return `loop detected: "${key}" called ${n}\u00d7 without progress`;
    }
  }

  // 2. Pure read spiral — only fire if the agent has NEVER written anything this task.
  // An agent that wrote files in early rounds then reads/verifies at the end is NOT spiraling.
  const workArtifacts = allArtifacts.filter((a) => !STARTUP_TOOLS.has(a.tool));
  const anyWriteEver = allArtifacts.some((a) => WRITE_TOOLS.has(a.tool));
  const last8 = workArtifacts.slice(-8);
  if (!anyWriteEver && last8.length === 8 && last8.every((a) => !WRITE_TOOLS.has(a.tool))) {
    return `research spiral: 8 consecutive read-only tool calls — no writes at all`;
  }

  // 3. Repeated shell failures: same cmd returned non-zero ≥ 3 times
  const shellFails = {};
  for (const a of allArtifacts) {
    if (a.tool === 'shell_exec' && (a.result?.exitCode ?? 0) !== 0) {
      const key = (a.args?.cmd || '').trim().slice(0, 100);
      shellFails[key] = (shellFails[key] || 0) + 1;
      if (shellFails[key] >= 3) return `shell loop: \`${key}\` failed 3+ times`;
    }
  }

  return null;
}

// Per-task loop suppression — when judge says "continue", suppress for N more rounds
const _loopSuppress = new Map(); // taskId → { suppressUntilRound, round }

// Ask a fast LLM whether the agent is genuinely stuck or just doing legitimate repeated work.
// Returns { verdict: 'continue' | 'retry', feedback: string }
const LoopJudgeSchema = z.object({
  verdict: z.enum(['continue', 'retry']).catch('retry'),
  feedback: z.string().catch('loop detected'),
});

async function askLoopJudge(task, agent, loopReason, allArtifacts, round) {
  const recentWork = allArtifacts.slice(-15).map((a) => `  • ${a.summary || a.tool}`).join('\n');
  const prompt = `You are a task supervisor. An automated loop detector flagged this agent run.

TASK: ${task.title}
AGENT: ${agent.id} (${agent.role})
LOOP SIGNAL: ${loopReason}
ROUND: ${round} / ${MAX_ROUNDS}
RECENT TOOL CALLS:
${recentWork || '  (none recorded)'}

Is this agent genuinely stuck in a dead end, or is the repeated pattern legitimate work (e.g. starting multiple background services, retrying a flaky network call, checking multiple ports)?

verdict must be "continue" (agent is making real progress) or "retry" (agent is truly stuck).`;

  try {
    const { data } = await callStructured(LoopJudgeSchema, prompt, {
      system: 'Task supervisor.',
      tier: 'weak', agent: 'loop-judge', purpose: 'classify',
    });
    return { verdict: data.verdict, feedback: data.feedback || '' };
  } catch {
    return { verdict: 'retry', feedback: loopReason };
  }
}

function normalizeCommandText(cmd) {
  return String(cmd || '').replace(/\r\n/g, '\n').trim();
}

async function maybeAutoFinishVerifiedTask({ task, agent, startedAt, projectWorkspace, shadowPath, broadcast }) {
  const liveTask = repo.byId('tasks', task.id);
  if (!liveTask || liveTask.status !== 'running') return false;

  const acceptanceCommands = (liveTask.acceptance_commands || [])
    .map(normalizeCommandText)
    .filter(Boolean);
  if (!acceptanceCommands.length) return false;

  const attemptArtifacts = (liveTask.artifacts || []).filter(
    (artifact) => artifact.ts >= startedAt && artifact.by === agent.id
  );
  const passingCommands = new Set(
    attemptArtifacts
      .filter((artifact) => ['shell_exec', 'python_run'].includes(artifact.tool) && artifact.exitCode === 0)
      .map((artifact) => normalizeCommandText(artifact.args?.cmd || artifact.result?.cmd))
      .filter(Boolean)
  );

  if (!acceptanceCommands.every((cmd) => passingCommands.has(cmd))) return false;

  const hasMeaningfulWork = attemptArtifacts.some(
    (artifact) => WRITE_TOOLS.has(artifact.tool) && artifact.ok !== false
  );
  if (!hasMeaningfulWork) return false;

  const { bundle, newStatus, task: verifiedTask } = await runVerification(task.id, shadowPath || projectWorkspace);
  const autoOutcome = verifiedTask.outcome
    || `Auto-finished after ${bundle.commands.filter((cmd) => cmd.passed).length}/${bundle.commands.length} acceptance commands passed without db_finish_task.`;
  const finalizedTask = repo.patch('tasks', task.id, {
    outcome: autoOutcome,
    updated_at: Date.now(),
    history: [...(verifiedTask.history || []), {
      ts: Date.now(),
      kind: 'auto-finished',
      by: 'runner',
      note: `acceptance commands passed in-task — auto-closed as ${newStatus}`,
    }],
  });

  if (newStatus === 'done' || newStatus === 'review') {
    autoPropagateExternal(task, finalizedTask, {
      repo,
      broadcast,
      agentId: agent.id,
      projectId: task.project_id,
      taskId: task.id,
    });
  }

  broadcast?.({ kind: 'task:update', task: finalizedTask });
  console.log(`[task-runner] ${task.id} auto-finished after acceptance verification (${newStatus})`);
  return true;
}

// Set of task IDs currently being executed (replaces single runningByProject flag)
const runningSet = new Set();
let _tickCount = 0; // for reconcile cadence

// ── Exported entry point ──────────────────────────────────────────────────────

export function startTaskRunner(broadcast) {
  console.log('[task-runner] v3 starting — parallel execution engine');
  // On startup: any task stuck in 'running' from a previous process never gets
  // picked up again (runningSet is empty). Re-queue them so they restart cleanly.
  const allOnBoot = repo.list('tasks');
  const orphaned = allOnBoot.filter((t) => t.status === 'running' || t.status === 'tribunal');
  if (orphaned.length) {
    console.log(`[task-runner] recovering ${orphaned.length} orphaned running task(s)`);
    for (const t of orphaned) {
      repo.patch('tasks', t.id, {
        status: 'queued',
        history: [...(t.history || []), { ts: Date.now(), kind: 'requeued', by: 'system', note: 'server restart — re-queued from orphaned running state' }],
      });
    }
  }

  // Main dispatch loop — recursive setTimeout to prevent overlapping ticks
  async function tick() {
    try {
      _tickCount++;
      // Reconcile tasks stuck in resumable_error/waiting_on_network every 20 ticks (~60s)
      if (_tickCount % 20 === 0) reconcileStuckTasks();

      const allTasks   = repo.list('tasks');
      const allProjects = repo.list('projects');

      // B1-02: Run dependency integrity validation (detect broken deps, cycles, stale deps)
      // This transitions tasks to 'blocked' with structured reasons or unblocks them
      applyDependencyValidation(allTasks, broadcast);

      // B1-03: Attempt auto-repair for blocked dependencies
      attemptDependencyRepairs(broadcast);

      // Re-read tasks after validation may have changed statuses
      const currentTasks = repo.list('tasks');

      const queued = currentTasks.filter((t) => {
        if (t.status !== 'queued')       return false;
        if (runningSet.has(t.id))        return false;
        const project = allProjects.find((p) => p.id === t.project_id);
        if (!project || project.paused)  return false;

        // Dependency gate — uses the validator's fast satisfaction check
        return areDependenciesSatisfied(t, currentTasks);
      });

      if (queued.length) {
        // Chaos audit: scan for tasks recently moved to review → spawn Iris if needed
        const reviewPending = allTasks.filter(t =>
          t.status === 'review' &&
          !_chaosAudited.has(t.id) &&
          t.updated_at && (Date.now() - t.updated_at) < 60_000 // moved to review in last 60s
        );
        for (const rt of reviewPending) {
          maybeSpawnChaosAudit(rt, broadcast);
        }

        // Chaos UI Swarm — fire after UI agent tasks complete
        for (const t of repo.list('tasks').filter(t =>
          t.status === 'done' &&
          t.updated_at &&
          Date.now() - new Date(t.updated_at).getTime() < 90_000 // within last 90s
        )) {
          if (shouldRunSwarm(t)) {
            runChaosSwarm(t, { broadcast }).catch(e => console.error('[tick] swarm error:', e.message));
          }
        }

        // Pick up to MAX_CONCURRENT_PER_PROJ tasks per project (oldest first)
        const byProject = new Map();
        for (const t of queued.sort((a, b) => (a.created_at || 0) - (b.created_at || 0))) {
          const list = byProject.get(t.project_id) || [];
          if (list.length < MAX_CONCURRENT_PER_PROJ) {
            byProject.set(t.project_id, [...list, t]);
          }
        }

        const toRun = [...byProject.values()].flat();
        await Promise.all(toRun.map(async (task) => {
          runningSet.add(task.id);
          try {
            await runOneTask(task, broadcast);
          } catch (err) {
            console.error('[task-runner] dispatch error', task.id, err.message);
          } finally {
            runningSet.delete(task.id);
          }
        }));
      }
    } catch (err) {
      console.error('[task-runner] tick error:', err.message);
    }
    setTimeout(tick, TICK_MS); // schedule AFTER this tick completes
  }
  setTimeout(tick, TICK_MS); // first tick

  // Scrum-master health loop
  startScrumMaster(broadcast);

  // Immediate stir on startup — wake up any tasks stuck in needs-human/needs-info/tribunal
  // from the previous server session without waiting 5 minutes
  setTimeout(() => stirUpStuckTasks(broadcast), 15_000);

  // Self-improvement loop — fires only when ≥3 tasks share the same error pattern (D5 guard)
  startSelfImproveLoop(broadcast);
}

// ── Self-improvement loop ─────────────────────────────────────────────────────
// Every 30 minutes, review recent failures and create Hunter/Forge tasks to fix
// recurring issues. This makes the system self-heal over time.

function startSelfImproveLoop(broadcast) {
  setInterval(async () => {
    try {
    // ── Project-scoped self-improve: never mix failures from different projects ──
    const allTasks = repo.list('tasks');
    const projects = repo.list('projects');

    for (const project of projects) {
      if (project.paused) continue;
      const projectTasks = allTasks.filter((t) => t.project_id === project.id);
      const recent = projectTasks.filter((t) => (t.updated_at || 0) > Date.now() - REFLECT_INTERVAL_MS);

      const loopFails = recent.filter((t) => t.error?.includes('loop detected') || t.error?.includes('research spiral'));
      const shellFails = recent.filter((t) => t.error?.includes('shell loop'));
      const humanNeeds = recent.filter((t) => t.status === 'needs-human' && (t.updated_at || 0) > Date.now() - 10 * 60_000);

      // D5: Only spawn when ≥3 tasks share the same error fingerprint (prevents si-* noise)
      const allFailed = [...loopFails, ...shellFails, ...recent.filter((t) => t.status === 'failed')];
      const errorGroups = {};
      for (const t of allFailed) {
        const key = (t.error || '').slice(0, 80);
        errorGroups[key] = (errorGroups[key] || 0) + 1;
      }
      const recurringCount = Object.values(errorGroups).filter((n) => n >= 3).length;
      if (!recurringCount && !humanNeeds.length) continue;

      const lines = [];
      if (loopFails.length) lines.push(`Loop/spiral failures (${loopFails.length}):\n${loopFails.slice(0, 5).map((t) => `  • ${t.id} [${t.by}]: ${t.title} — ${t.error}`).join('\n')}`);
      if (shellFails.length) lines.push(`Shell loop failures (${shellFails.length}):\n${shellFails.slice(0, 5).map((t) => `  • ${t.id} [${t.by}]: ${t.title}`).join('\n')}`);
      if (humanNeeds.length) lines.push(`New needs-human (${humanNeeds.length}):\n${humanNeeds.slice(0, 5).map((t) => `  • ${t.id} [${t.by}]: ${t.title} — ${t.error || '(no error)'}`).join('\n')}`);

      // Only spawn if there's no active conductor self-improve task for THIS project
      const alreadyRunning = projectTasks.some((t) =>
        t.tag === 'self-improve' && ['queued', 'running'].includes(t.status)
      );
      if (alreadyRunning) continue;

      const id = `si-${Date.now().toString(36)}`;
      const row = {
        id,
        project_id: project.id,
        title: `[Self-Improve] ${recurringCount} recurring error patterns, ${humanNeeds.length} blocked`,
        desc: `Self-improvement review for project "${project.id}".\n\n${lines.join('\n\n')}\n\nFor each failure:\n1. Diagnose root cause\n2. Create a Hunter/Forge task with full context to fix the underlying issue\n3. Write a learning note at agents/conductor/memory.md`,
        by: 'conductor', tag: 'self-improve', status: 'queued',
        created_at: Date.now(), updated_at: Date.now(),
        history: [{ ts: Date.now(), kind: 'created', by: 'self-improve-loop', note: `${recurringCount} recurring patterns (project: ${project.id})` }],
        comments: [],
      };
      repo.upsert('tasks', row);
      broadcast?.({ kind: 'task:create', task: row });
      console.log(`[self-improve] ${project.id}: spawned for ${recurringCount} recurring patterns, ${humanNeeds.length} blocked`);
    }
    } catch (err) { console.error('[self-improve] loop error:', err.message); }
  }, REFLECT_INTERVAL_MS);
}

// ── Scrum master — fills gaps every 15 min ───────────────────────────────────
// Per-project cooldown map: don't re-spawn conductor until CONDUCTOR_COOLDOWN_MS
// after the last conductor task finished/failed — prevents the thrash loop.
const _lastConductorEndByProject = new Map(); // projectId → epochMs

function startScrumMaster(broadcast) {
  setInterval(async () => {
    try {
      for (const project of repo.list('projects')) {
        if (project.paused) continue;
        await reviewProjectHealth(project, broadcast);
      }
    } catch (err) { console.error('[scrum-master] loop error:', err.message); }
  }, SCRUM_INTERVAL_MS);

  // Stir stuck tasks on a faster cadence (every 5 min)
  setInterval(() => stirUpStuckTasks(broadcast), STIR_INTERVAL_MS);
}

// ── Stir stuck tasks — the "wake-up" loop ─────────────────────────────────────
// Runs every STIR_INTERVAL_MS. Finds tasks stuck in:
//   • needs-human  — apply escalation ladder; if fixable, requeue; otherwise run tribunal
//   • tribunal     — if stuck > STIR_TRIBUNAL_AGE_MS (runner may have crashed mid-tribunal)
//   • needs-info   — auto-convert to queued so the assigned agent can answer the question
//
// This is the fix for the "conductor is dumb" problem: tasks in terminal/stuck states
// should never stay frozen forever. The system always tries to move them forward.
function stirUpStuckTasks(broadcast) {
  const allTasks = repo.list('tasks');
  const now = Date.now();

  // 1. needs-human: apply escalation ladder (template fix → requeue; else tribunal)
  const stuckHuman = allTasks.filter(
    (t) => t.status === 'needs-human' &&
           !t.stirred &&
           (now - (t.updated_at || 0)) > STIR_MIN_AGE_MS
  );

  for (const task of stuckHuman) {
    const errMsg = task.error || task.outcome || '';
    const escalation = applyEscalationLadder(task, errMsg);

    if (escalation.action === 'requeue') {
      repo.patch('tasks', task.id, {
        status: 'queued',
        error: errMsg,
        templateFixApplied: escalation.templateId,
        desc: escalation.newDesc,
        stirred: true,
        history: [...(task.history || []), {
          ts: now, kind: 'stir-requeue', by: 'scrum-master',
          note: `[stir] template fix applied: ${escalation.reason} — requeued by scrum-master`,
        }],
      });
      broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
      broadcast?.({ kind: 'toast', toast: {
        title: '🔄 Task Unstuck',
        body: `"${task.title.slice(0, 60)}" — ${escalation.reason}`,
        icon: 'arrow-repeat', color: 'blue', kind: 'info',
      }});
      console.log(`[stir] ${task.id} unstuck via template: ${escalation.templateId}`);

    } else if (escalation.action === 'needs-human') {
      // Escalation ladder says human-only — but try rescue first
      spawnRescueTask(task, `Stir loop: escalation ladder confirmed human-only (${escalation.reason}). Error: ${errMsg}`, broadcast);
      console.log(`[stir] ${task.id} — rescue dispatched instead of confirming needs-human (${escalation.reason})`);

    } else {
      // Unknown or low-confidence → kick it back to queued with a "stir" note so tribunal runs
      repo.patch('tasks', task.id, {
        status: 'queued',
        attempts: 0,             // reset retry budget for a clean tribunal run
        feedback_requeue: false,
        stirred: true,
        history: [...(task.history || []), {
          ts: now, kind: 'stir-requeue', by: 'scrum-master',
          note: `[stir] re-queued by scrum-master after ${Math.round((now - (task.updated_at || 0)) / 60_000)}min in needs-human — no template match, tribunal will handle`,
        }],
      });
      broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
      console.log(`[stir] ${task.id} re-queued (no template match) for tribunal`);
    }
  }

  // 2. tribunal stuck > STIR_TRIBUNAL_AGE_MS: tribunal process may have died mid-run
  const stuckTribunal = allTasks.filter(
    (t) => t.status === 'tribunal' &&
           (now - (t.tribunalStarted || t.updated_at || 0)) > STIR_TRIBUNAL_AGE_MS
  );
  for (const task of stuckTribunal) {
    console.warn(`[stir] ${task.id} stuck in tribunal > ${STIR_TRIBUNAL_AGE_MS / 60_000}min — re-running tribunal`);
    repo.patch('tasks', task.id, {
      status: 'tribunal',
      tribunalStarted: now,
      history: [...(task.history || []), {
        ts: now, kind: 'tribunal-restart', by: 'scrum-master',
        note: `[stir] tribunal restarted — was stuck for ${Math.round((now - (task.tribunalStarted || task.updated_at || 0)) / 60_000)}min`,
      }],
    });
    import('./tribunal.js').then(({ runTribunal }) => {
      runTribunal(task, broadcast).catch((err) => {
        console.error(`[stir] tribunal restart failed for ${task.id}: ${err.message}`);
        repo.patch('tasks', task.id, {
          status: 'needs-human',
          error: `Tribunal restarted by stir-loop but crashed: ${err.message}`,
        });
        broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
      });
    }).catch((err) => console.error(`[stir] tribunal import error: ${err.message}`));
  }

  // 3. needs-info: convert to queued — agent should answer the question itself
  const stuckInfo = allTasks.filter(
    (t) => t.status === 'needs-info' &&
           !runningSet.has(t.id) &&
           (now - (t.updated_at || 0)) > STIR_MIN_AGE_MS
  );
  for (const task of stuckInfo) {
    repo.patch('tasks', task.id, {
      status: 'queued',
      stirred: true,
      history: [...(task.history || []), {
        ts: now, kind: 'stir-requeue', by: 'scrum-master',
        note: `[stir] needs-info auto-unblocked — re-queued after ${Math.round((now - (task.updated_at || 0)) / 60_000)}min`,
      }],
    });
    broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
    console.log(`[stir] ${task.id} needs-info → queued`);
  }

  // 3b. blocked: if a blocked task's dependencies are now done, or it's been blocked > 15 min, requeue it.
  const STALE_BLOCKED_AGE_MS = 15 * 60_000;
  const stuckBlocked = allTasks.filter(
    (t) => t.status === 'blocked' &&
           (now - (t.updated_at || 0)) > STALE_BLOCKED_AGE_MS
  );
  for (const task of stuckBlocked) {
    // Check if blocking dependencies are now resolved
    const deps = task.depends_on || [];
    const allDepsResolved = deps.length === 0 || deps.every(depId => {
      const dep = repo.byId('tasks', depId);
      return !dep || dep.status === 'done';
    });

    if (allDepsResolved) {
      repo.patch('tasks', task.id, {
        status: 'queued',
        stirred: true,
        history: [...(task.history || []), {
          ts: now, kind: 'stir-unblocked', by: 'scrum-master',
          note: `[stir] dependencies resolved (or none) — unblocked after ${Math.round((now - (task.updated_at || 0)) / 60_000)}min`,
        }],
      });
      broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
      console.log(`[stir] ${task.id} blocked → queued (deps resolved)`);
    } else {
      // Dependencies still pending — requeue anyway after 30 min so it doesn't rot forever
      const HARD_BLOCKED_LIMIT_MS = 30 * 60_000;
      if ((now - (task.updated_at || 0)) > HARD_BLOCKED_LIMIT_MS) {
        repo.patch('tasks', task.id, {
          status: 'queued',
          stirred: true,
          feedback_requeue: true,
          history: [...(task.history || []), {
            ts: now, kind: 'stir-force-unblocked', by: 'scrum-master',
            note: `[stir] force-unblocked after ${Math.round((now - (task.updated_at || 0)) / 60_000)}min — deps still pending but task cannot rot`,
          }],
        });
        broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
        console.log(`[stir] ${task.id} force-unblocked after ${Math.round((now - (task.updated_at || 0)) / 60_000)}min`);
      }
    }
  }

  // 4. B2-05: Stale review resolver — review tasks stuck without resolution
  // Evidence-gate demotions (demotion_reason set) get a shorter fuse: 5 min.
  // All others: 30 min.
  const STALE_REVIEW_AGE_MS = 30 * 60_000;
  const STALE_DEMOTION_AGE_MS = 5 * 60_000;
  const stuckReview = allTasks.filter(
    (t) => t.status === 'review' &&
           !t.stale_resolve_attempted &&
           (now - (t.updated_at || 0)) > (t.demotion_reason ? STALE_DEMOTION_AGE_MS : STALE_REVIEW_AGE_MS)
  );

  for (const task of stuckReview) {
    // Path A: acceptance commands all passed (recorded in artifacts)
    const hasAcceptancePass = (task.artifacts || []).some(a =>
      a.kind === 'acceptance' && a.status === 'pass'
    );
    // Path B: required_outputs exist and no gates failed
    const hasGateFailures = task.gates_failed?.length > 0;
    const hasOutputs = (task.required_outputs || []).length > 0 &&
      (task.artifacts || []).some(a => a.kind === 'output' || a.kind === 'file');

    if (hasGateFailures) {
      // SAFETY: never auto-close if gates_failed is set — mark attempted and skip
      repo.patch('tasks', task.id, { stale_resolve_attempted: true });
      console.log(`[stir] ${task.id} review stale but gates_failed set — not resolving`);
    } else if (hasAcceptancePass) {
      // Path A: acceptance evidence exists → done
      repo.patch('tasks', task.id, {
        status: 'done',
        outcome: task.outcome || 'Auto-resolved: acceptance criteria passed',
        stale_resolve_attempted: true,
        history: [...(task.history || []), {
          ts: now, kind: 'stale-resolved', by: 'scrum-master',
          note: `[stir] review auto-resolved — acceptance commands passed (stale ${Math.round((now - (task.updated_at || 0)) / 60_000)}min)`,
        }],
      });
      broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
      console.log(`[stir] ${task.id} review auto-resolved (acceptance pass)`);
    } else if (hasOutputs && !hasGateFailures) {
      // Path B: outputs exist + no gate failures → done
      repo.patch('tasks', task.id, {
        status: 'done',
        outcome: task.outcome || 'Auto-resolved: required outputs present',
        stale_resolve_attempted: true,
        history: [...(task.history || []), {
          ts: now, kind: 'stale-resolved', by: 'scrum-master',
          note: `[stir] review auto-resolved — outputs present, no gate failures (stale ${Math.round((now - (task.updated_at || 0)) / 60_000)}min)`,
        }],
      });
      broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
      console.log(`[stir] ${task.id} review auto-resolved (outputs present)`);
    } else {
      // Path C: can't determine completion — requeue with gap list
      const gaps = [];
      if ((task.required_outputs || []).length > 0) {
        const outputArtifacts = (task.artifacts || []).filter(a => a.kind === 'output' || a.kind === 'file');
        const missing = (task.required_outputs || []).filter(ro =>
          !outputArtifacts.some(a => (a.path || a.name || '').includes(ro))
        );
        if (missing.length) gaps.push(`Missing outputs: ${missing.join(', ')}`);
      }
      if (!hasAcceptancePass) gaps.push('No acceptance criteria evidence');

      const demotionNote = task.demotion_reason
        ? `\n\n⚠️ EVIDENCE GATE REJECTION:\n${task.demotion_reason}\nYou MUST fix this before calling db_finish_task("done") again.`
        : '';

      repo.patch('tasks', task.id, {
        status: 'queued',
        feedback_requeue: true,   // use continuation brief so the agent sees the rejection context
        stale_resolve_attempted: true,
        history: [...(task.history || []), {
          ts: now, kind: 'stale-requeue', by: 'scrum-master',
          note: `[stir] review stale ${Math.round((now - (task.updated_at || 0)) / 60_000)}min — requeued with gaps: ${gaps.join('; ') || 'unknown'}`,
        }],
        desc: `${task.desc || ''}\n\n--- STALE REVIEW GAPS ---\n${gaps.map(g => `• ${g}`).join('\n')}\nAddress these gaps and finish the task.${demotionNote}`,
      });
      broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
      console.log(`[stir] ${task.id} review stale → requeued with gaps`);
    }
  }

  if (stuckHuman.length + stuckTribunal.length + stuckInfo.length + stuckReview.length > 0) {
    console.log(`[stir] stirred ${stuckHuman.length} needs-human, ${stuckTribunal.length} tribunal, ${stuckInfo.length} needs-info, ${stuckReview.length} review tasks`);
  }
}

async function reviewProjectHealth(project, broadcast) {
  const tasks = repo.list('tasks').filter((t) => t.project_id === project.id);
  const reqs  = repo.list('reqs').filter((r) => r.project_id === project.id);

  // Auto-archive stale orchestration/self-improve noise tasks (>60min, terminal states)
  const archiveDeadline = Date.now() - 60 * 60_000;
  // c-ping-* are real agent-to-agent handoff tasks (created by ping_agent) — never junk
  const junkPrefixes = ['c-scrum-', 'si-'];
  for (const t of tasks) {
    const isJunk = junkPrefixes.some((p) => t.id.startsWith(p));
    const isTerminal = ['needs-human', 'review', 'done'].includes(t.status);
    // B1-05: Never auto-archive tasks with failed gates — they need real resolution
    const hasGateFailures = t.gates_failed?.length > 0;
    if (isJunk && isTerminal && !hasGateFailures && (t.updated_at || 0) < archiveDeadline) {
      repo.patch('tasks', t.id, {
        status: 'done',
        outcome: 'auto-archived: stale orchestration task',
        history: [...(t.history || []), { ts: Date.now(), kind: 'archived', by: 'scrum-master', note: 'auto-archived after 60min inactivity' }],
      });
      broadcast?.({ kind: 'task:update', task: repo.byId('tasks', t.id) });
    }
  }

  // Cooldown: don't re-trigger pipeline if one ran recently
  const lastEnd = _lastConductorEndByProject.get(project.id) || 0;
  if (Date.now() - lastEnd < CONDUCTOR_COOLDOWN_MS) return;

  // Find active requirements with zero tasks — the ONLY trigger for pipeline
  const coveredReqIds = new Set(tasks.map((t) => t.parent_req).filter(Boolean));
  const uncoveredReqs = reqs.filter((r) => r.status === 'active' && !coveredReqIds.has(r.id));

  // Only spawn when there are actual uncovered requirements — never for stuck tasks alone
  if (!uncoveredReqs.length) return;

  const goal = `Cover uncovered requirements:\n${uncoveredReqs.map((r) => `  • ${r.id}: ${r.title}`).join('\n')}`;

  conductorPipeline(project.id, goal, { broadcast })
    .then((r) => {
      console.log(`[scrum-master] pipeline created ${r.tasksCreated} tasks for ${project.id}`);
      _lastConductorEndByProject.set(project.id, Date.now());
    })
    .catch((err) => {
      console.error(`[scrum-master] pipeline failed for ${project.id}: ${err.message}`);
      _lastConductorEndByProject.set(project.id, Date.now());
    });
  console.log(`[scrum-master] pipeline triggered for ${project.id} — ${uncoveredReqs.length} uncovered reqs`);
}

// ── Mission builders ──────────────────────────────────────────────────────────

function buildInitialMission({ task, project, agent, attempts, commentsBlock, previousErrors, reqContext, workspaceTree, activeAgents, shadowPath, archContext, upstreamContext }) {
  const agentCtx = activeAgents?.length
    ? `ACTIVE AGENTS (DON'T DUPLICATE their work):\n${activeAgents.map((a) => `  • ${a.agent} is working on: "${a.title}" (${a.id})`).join('\n')}`
    : '';
  const richContextEnabled = task.useRichContext === true
    || /\[(rich-context|deep-context)\]/i.test(`${task.title || ''}\n${task.desc || ''}`);

  // Show the actual workspace path the tools resolve to
  const wsDisplay = project.workspace || `~/gavirila-workspaces/${project.id}/`;

  return `
═══ MISSION ═══
TASK: ${task.title} (${task.id})
DESCRIPTION: ${task.desc || '(no description)'}
ATTEMPT: ${attempts} of ${MAX_AUTO_RETRIES + 1}

${task.parent_req ? `REQUIREMENT: ${task.parent_req}` : ''}
${reqContext ? `\nREQUIREMENT DETAIL:\n${reqContext}\n` : ''}
${commentsBlock ? `\nFEEDBACK / COMMENTS:\n${commentsBlock}\n` : ''}
${previousErrors ? `\nPREVIOUS FAILURES (avoid these):\n${previousErrors}\n` : ''}
${task.retry_mutation_required ? `\n⚠️ MANDATORY STRATEGY MUTATION: Your previous approach failed with the SAME fingerprint. You MUST try a fundamentally different strategy — different tools, different file patterns, or different algorithms. Repeating the same approach will result in escalation.\n` : ''}
${task.constraint_level ? buildConstraintBlock(task) : ''}
${agentCtx ? `\n${agentCtx}\n` : ''}

PROJECT: ${project.name} (${project.id})
WORKSPACE: ${wsDisplay}
${/^[A-Z]:\\/.test(wsDisplay) ? `⚠️ This is a WINDOWS HOST PATH. All fs_read_file, fs_write_file, fs_list_dir paths are RELATIVE to this workspace. shell_exec uses PowerShell. Do NOT use Unix commands.\n` : ''}
VAULT: every note you write cross-links the project graph — agents read each other's notes.

${richContextEnabled && archContext ? `ARCHITECTURE:\n${archContext}\n` : ''}
${richContextEnabled && upstreamContext ? `\n${upstreamContext}\n` : ''}
${richContextEnabled && workspaceTree ? `CURRENT FILES IN WORKSPACE:\n${workspaceTree}\n` : ''}

LEAN EXECUTION MODE:
1. One discovery batch: inspect only the files needed to identify the owning code path.
2. One implementation batch: write the code or artifact directly.
3. One validation batch: run the narrowest command that proves the task.
4. Finish immediately with db_finish_task. Do not restate a plan or reopen broad research unless validation falsifies the current approach.

EXECUTION RULES:
1. fs_list_dir(".") first — see what exists before writing anything.
2. Write ALL files for this task in ONE batch — don't stretch across multiple rounds.
3. Run the code after writing — show real exit codes.
4. If you need another agent's help → ping_agent(to, subject, message) — they get a task.
5. When done → db_finish_task(id="${task.id}", status="done", outcome="<summary of what you did>").
6. If blocked → db_finish_task(id="${task.id}", status="needs-human", outcome="blocked: <exact reason>").

🚨 CRITICAL: db_finish_task is the ONLY way to end this task. The runner will NOT stop you
   based on anything you say in text. It only stops when you call db_finish_task, the loop
  detector fires, or the ${Math.round(MAX_TASK_RUNTIME_MS / 60000)}-minute wall-clock expires. If you are done or stuck: CALL IT.

SPEED MATTERS: skip research after round 1. Patch once, validate once, finish.
${buildSkillsBlock(task)}
${buildPlaybookBlock(routeToPlaybook(task))}
${buildGuardBlock(checkGuards({ taskTitle: task.title, taskDesc: task.desc, domain: task.domain, agent: (task.by || '').toLowerCase() }))}
${buildTieredMemoryBlock((task.by || '').toLowerCase(), { domain: task.domain })}
${shadowPath ? `\n🔒 SHADOW WORKSPACE: You are working in an isolated copy at \`${shadowPath}\`. All file edits and shell commands go here — the main repo is untouched until this task is approved.\n` : ''}
GO.`.trim();
}

function buildContinuationMission({ task, round, allArtifacts, startedAt, consecutiveEmptyRounds }) {
  const recentSummary = (allArtifacts || []).slice(-14).map((a) => `  ${a.summary}`).join('\n');
  const hasWrites = (allArtifacts || []).some((a) =>
    ['fs_write_file', 'shell_exec', 'fs_mkdir'].includes(a.tool)
  );
  const onlyResearch = round > 1 && !hasWrites;
  const isLastRounds = round >= MAX_ROUNDS - 2;
  const isToolStall  = consecutiveEmptyRounds >= 3;

  // Include any comments added DURING this run (injected feedback)
  const live = repo.byId('tasks', task.id);
  const freshComments = (live?.comments || [])
    .filter((c) => c.ts > startedAt)
    .map((c) => `  [${c.by}]: ${c.text}`)
    .join('\n');

  return `
═══ CONTINUATION — ROUND ${round} / ${MAX_ROUNDS} ═══
TASK: ${task.title} (${task.id}) | PROJECT: ${task.project_id}

WORK SO FAR:
${recentSummary || '  (nothing recorded yet)'}

${freshComments ? `\n💬 FEEDBACK RECEIVED DURING THIS RUN:\n${freshComments}\n` : ''}
${isToolStall ? `🚨 TOOL-STALL WARNING: You have produced ${consecutiveEmptyRounds} rounds of pure text with ZERO tool calls.\n  The runner CANNOT see your reasoning text — it only records tool results.\n  You MUST call a tool right now. If done: db_finish_task. If writing code: fs_write_file.\n  Continued empty rounds will be auto-failed quickly.\n` : ''}
${onlyResearch ? `⚠️  ROUND ${round}: Only research so far, NO file writes. Write ALL code NOW, then db_finish_task.\n` : ''}
${isLastRounds ? `🚨 FINAL ROUNDS (${round}/${MAX_ROUNDS}): Call db_finish_task RIGHT NOW.\n  • Done → db_finish_task(id, status="done", outcome="...")\n  • Stuck → db_finish_task(id, status="needs-human", outcome="blocked: <reason>")\n  Do NOT read more files. Do NOT explore further. FINISH.\n` : ''}
NEXT: Continue. If all done → db_finish_task(id="${task.id}", status="done", outcome="...").`.trim();
}

// Slim continuation nudge for Aumovio persistent thread (~100 tokens).
// Full history is already in the thread — no need to repeat WORK SO FAR.
function buildContinuationNudge({ task, round, startedAt, consecutiveEmptyRounds, allArtifacts }) {
  const live = repo.byId('tasks', task.id);
  const freshComments = (live?.comments || [])
    .filter((c) => c.ts > startedAt)
    .map((c) => `  [${c.by}]: ${c.text}`)
    .join('\n');

  const hasWrites = (allArtifacts || []).some((a) =>
    ['fs_write_file', 'shell_exec', 'fs_mkdir'].includes(a.tool)
  );
  const onlyResearch = round > 1 && !hasWrites;
  const isLastRounds = round >= MAX_ROUNDS - 2;
  const isToolStall  = consecutiveEmptyRounds >= 3;

  return [
    `═══ ROUND ${round}/${MAX_ROUNDS} — CONTINUE ═══`,
    `TASK: ${task.title} (${task.id})`,
    freshComments ? `\n💬 FEEDBACK:\n${freshComments}` : '',
    isToolStall ? `🚨 TOOL-STALL: ${consecutiveEmptyRounds} rounds with zero tool calls. Call a tool NOW or db_finish_task.` : '',
    onlyResearch ? `⚠️ No file writes yet. Write ALL code next, then db_finish_task.` : '',
    isLastRounds ? `🚨 FINAL ROUNDS: Call db_finish_task RIGHT NOW. Done → status="done". Stuck → status="needs-human".` : '',
    `Continue. If done → db_finish_task(id="${task.id}", status="done", outcome="...").`,
  ].filter(Boolean).join('\n').trim();
}

// ── Shadow workspace helpers ──────────────────────────────────────────────────

/**
 * Create an ephemeral git worktree for a task so agents work in isolation.
 * Returns the shadow path, or null if the project workspace has no git repo.
 */
function createShadowWorktree(projectWorkspace, taskId) {
  if (!projectWorkspace || !fs.existsSync(projectWorkspace)) return null;
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: projectWorkspace, stdio: 'ignore' });
  } catch {
    return null; // not a git repo — skip shadow workspace
  }
  const shadowPath = path.join(os.tmpdir(), `gavirila-shadow-${taskId}`);
  try {
    if (fs.existsSync(shadowPath)) {
      execSync(`git -C "${projectWorkspace}" worktree remove --force "${shadowPath}"`, { stdio: 'ignore' });
    }
    execSync(`git -C "${projectWorkspace}" worktree add "${shadowPath}" HEAD`, { cwd: projectWorkspace });

    // Sync untracked files from the source workspace into the shadow.
    // git worktree only includes committed files — any untracked content
    // (common in pre-existing codebases like uTAS5) would be invisible
    // to agents, causing them to report "shadow is empty" and fail.
    try {
      const untrackedRaw = execSync('git ls-files --others --exclude-standard', {
        cwd: projectWorkspace, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
      });
      const untracked = untrackedRaw.split('\n').filter(Boolean);
      if (untracked.length > 5000) {
        // Too many untracked files to copy (no .gitignore?).
        // Abandon the shadow and let the agent work directly in the source.
        console.warn(`[shadow] ${taskId}: ${untracked.length} untracked files — too many to copy, using source workspace directly`);
        try {
          execSync(`git -C "${projectWorkspace}" worktree remove --force "${shadowPath}"`, { stdio: 'ignore' });
        } catch { /* best effort */ }
        return null;
      }
      if (untracked.length > 0) {
        let copied = 0;
        for (const rel of untracked) {
          const src = path.join(projectWorkspace, rel);
          const dst = path.join(shadowPath, rel);
          try {
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.copyFileSync(src, dst);
            copied++;
          } catch { /* skip files that can't be copied */ }
        }
        if (copied > 0) {
          console.log(`[shadow] ${taskId}: synced ${copied} untracked files from source workspace`);
        }
      }
    } catch (syncErr) {
      // Non-critical — agents still get committed files
      console.warn(`[shadow] ${taskId}: untracked sync skipped: ${syncErr.message?.slice(0, 100)}`);
    }

    return shadowPath;
  } catch (err) {
    console.warn(`[shadow] could not create worktree for ${taskId}: ${err.message}`);
    return null;
  }
}

/**
 * Generate a git diff, apply agent changes back to the main workspace,
 * and remove the shadow worktree.
 * Returns the diff string (may be empty if no changes were made).
 */
function finalizeShadowWorktree(projectWorkspace, shadowPath, taskId) {
  if (!shadowPath || !fs.existsSync(shadowPath)) return '';
  let diff = '';

  // Stage ALL changes first (including new untracked files) so git diff
  // can see them.  Previously we ran `git diff HEAD` before staging, which
  // missed every newly-created file and silently skipped the merge-back.
  try {
    execSync(`git -C "${shadowPath}" add -A`, { stdio: 'ignore' });
  } catch { /* non-critical */ }

  try {
    diff = execSync(`git -C "${shadowPath}" diff --cached HEAD`, { maxBuffer: 4 * 1024 * 1024 }).toString();
  } catch { /* non-critical */ }

  // Fallback: even if diff is empty (e.g. binary-only changes), check
  // whether there is *anything* staged that would produce a commit.
  let hasChanges = !!diff;
  if (!hasChanges) {
    try {
      const status = execSync(`git -C "${shadowPath}" status --porcelain`, {
        encoding: 'utf8', maxBuffer: 1024 * 1024,
      }).trim();
      hasChanges = status.length > 0;
    } catch { /* non-critical */ }
  }

  // Apply agent changes back to the main workspace so future shadow worktrees
  // (created via `git worktree add ... HEAD`) include all prior agent work.
  // Without this, each shadow starts from the same stale HEAD and agents
  // can't see files created by previous tasks.
  if (hasChanges) {
    try {
      // Commit all staged changes in the shadow (already staged above)
      execSync(`git -C "${shadowPath}" commit -m "agent: ${taskId}" --no-verify --allow-empty`, { stdio: 'ignore' });
    } catch { /* may fail if nothing to commit */ }

    try {
      // Merge the shadow's commit into the main workspace's current branch
      // Use --no-edit to auto-accept the merge message
      const shadowHead = execSync(`git -C "${shadowPath}" rev-parse HEAD`, { encoding: 'utf8' }).trim();
      execSync(`git -C "${projectWorkspace}" merge --no-edit --no-verify ${shadowHead}`, { stdio: 'ignore' });
      console.log(`[shadow] ${taskId}: merged agent changes back to main workspace`);
    } catch (mergeErr) {
      // If merge fails (conflict), try applying the diff directly (only if we have one)
      if (diff) {
        try {
          execSync(`git -C "${projectWorkspace}" apply --3way -`, {
            input: diff,
            stdio: ['pipe', 'ignore', 'ignore'],
          });
          execSync(`git -C "${projectWorkspace}" add -A`, { stdio: 'ignore' });
          execSync(`git -C "${projectWorkspace}" commit -m "agent: ${taskId} (patch)" --no-verify --allow-empty`, { stdio: 'ignore' });
          console.log(`[shadow] ${taskId}: applied agent diff back to main workspace (patch fallback)`);
        } catch (applyErr) {
          console.warn(`[shadow] ${taskId}: could not merge back: ${mergeErr.message?.slice(0, 100)}`);
        }
      } else {
        console.warn(`[shadow] ${taskId}: could not merge back (no textual diff for fallback): ${mergeErr.message?.slice(0, 100)}`);
      }
    }
  }

  try {
    execSync(`git -C "${projectWorkspace}" worktree remove --force "${shadowPath}"`, { stdio: 'ignore' });
  } catch { /* best effort */ }
  return diff;
}

// ── Chaos audit trigger (Iris) ────────────────────────────────────────────────


function emitTaskHeartbeat(taskId, agentId, broadcast, payload = {}) {
  const live = repo.byId('tasks', taskId);
  if (!live || live.status !== 'running') return null;
  const ts = Date.now();
  const heartbeat = { ts, agent: agentId, ...payload };
  repo.patch('tasks', taskId, { heartbeat_at: ts, heartbeat });
  broadcast?.({ kind: 'task:heartbeat', taskId, heartbeat });
  return heartbeat;
}

function recordTaskProgress(taskId, agentId, broadcast, payload = {}) {
  const live = repo.byId('tasks', taskId);
  if (!live || live.status !== 'running') return null;
  const ts = Date.now();
  const progressState = payload.kind || 'progress';
  const summary = payload.summary || '';
  const heartbeat = { ts, agent: agentId, kind: progressState, round: payload.round, phase: payload.phase, summary };
  repo.patch('tasks', taskId, {
    heartbeat_at: ts,
    heartbeat,
    last_progress_at: ts,
    progress_state: progressState,
    progress_summary: summary,
  });
  broadcast?.({ kind: 'task:heartbeat', taskId, heartbeat });
  return heartbeat;
}
const _chaosAudited = new Set(); // taskIds that have already had chaos spawned

function maybeSpawnChaosAudit(reviewTask, broadcast) {
  const CODE_AGENTS = new Set(['forge', 'vince', 'hunter', 'forger']);
  if (!CODE_AGENTS.has(reviewTask.by)) return;
  if (_chaosAudited.has(reviewTask.id)) return;
  _chaosAudited.add(reviewTask.id);

  const project = repo.byId('projects', reviewTask.project_id);
  if (!project || project.paused) return;
  if (project.chaosDisabled) return;

  const chaosTask = {
    id: `c-chaos-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    project_id: reviewTask.project_id,
    title: `[Iris] Chaos audit: ${reviewTask.title.slice(0, 60)}`,
    desc: `Adversarial chaos test for task ${reviewTask.id}. Iris must try to break the code Forge wrote. If broken → re-open ${reviewTask.id}. If cleared → human review can proceed.`,
    by: 'iris',
    tag: 'chaos',
    status: 'queued',
    parent_task: reviewTask.id,
    created_at: Date.now(), updated_at: Date.now(),
    since: 'just now',
    comments: [],
    history: [{ ts: Date.now(), kind: 'created', by: 'chaos-system', note: `spawned to audit ${reviewTask.id}` }],
  };
  repo.upsert('tasks', chaosTask);
  broadcast?.({ kind: 'task:create', task: chaosTask });
  console.log(`[chaos] spawned iris audit ${chaosTask.id} for ${reviewTask.id}`);
}

// ── Main runner ───────────────────────────────────────────────────────────────

async function runOneTask(task, broadcast) {
  if (!task.project_id) {
    repo.patch('tasks', task.id, { status: 'needs-human', error: 'no project_id' });
    emitHandoff(task.id, HANDOFF_TYPES.NEEDS_HUMAN_INPUT, { reason: 'no project_id' });
    return;
  }

  const agent = getAgent(task.by?.toLowerCase());
  if (!agent) {
    repo.patch('tasks', task.id, { status: 'needs-human', error: `unknown agent: ${task.by}` });
    emitHandoff(task.id, HANDOFF_TYPES.NEEDS_HUMAN_INPUT, { reason: `unknown agent: ${task.by}` });
    return;
  }

  const project = repo.byId('projects', task.project_id);
  if (!project) {
    repo.patch('tasks', task.id, { status: 'needs-human', error: `unknown project: ${task.project_id}` });
    emitHandoff(task.id, HANDOFF_TYPES.NEEDS_HUMAN_INPUT, { reason: `unknown project: ${task.project_id}` });
    return;
  }

  // ── Pathfinder: register explicit workspace + pre-flight scan ──────
  // If the project has a custom workspace path (e.g. "F:\\uTAS5"), register it
  // so exec-tools routes fs/shell calls there instead of ~/gavirila-workspaces/.
  if (project.workspace) {
    setWorkspaceOverride(task.project_id, project.workspace);
  }
  const projectWorkspace = project.workspace || path.join(os.homedir(), 'gavirila-workspaces', project.id);

  // ── GR2: Pre-flight workspace validator (zero-trust) ──────────────
  // Before the LLM is EVER invoked, verify the workspace is physically reachable.
  // If not, fail instantly with a human-readable error — saves tokens and prevents
  // agents from hallucinating workarounds for infrastructure problems.
  {
    const ws = projectWorkspace;
    if (!fs.existsSync(ws)) {
      const errMsg = `System Halt: Workspace "${ws}" is unreachable. The directory does not exist on the host filesystem. Create it or fix project.workspace before running tasks.`;
      console.error(`[GR2] ${task.id}: ${errMsg}`);
      repo.patch('tasks', task.id, {
        status: 'needs-human',
        error: errMsg,
        history: [...(task.history || []), { ts: Date.now(), kind: 'preflight-failed', by: 'kernel', note: errMsg }],
      });
      emitHandoff(task.id, HANDOFF_TYPES.NEEDS_HUMAN_INPUT, { reason: errMsg });
      broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
      broadcast?.({ kind: 'toast', toast: { title: 'Pre-flight Failed', body: errMsg, icon: 'x-circle', color: 'red', kind: 'error' } });
      return; // agent is NEVER invoked
    }
    // Verify write access by touching a temp file
    const probe = path.join(ws, `.gavirila-probe-${Date.now()}`);
    try {
      fs.writeFileSync(probe, 'preflight', { flag: 'wx' });
      fs.unlinkSync(probe);
    } catch (accessErr) {
      const errMsg = `System Halt: Workspace "${ws}" exists but is not writable (${accessErr.code}). Check permissions.`;
      console.error(`[GR2] ${task.id}: ${errMsg}`);
      repo.patch('tasks', task.id, {
        status: 'needs-human', error: errMsg,
        history: [...(task.history || []), { ts: Date.now(), kind: 'preflight-failed', by: 'kernel', note: errMsg }],
      });
      emitHandoff(task.id, HANDOFF_TYPES.NEEDS_HUMAN_INPUT, { reason: errMsg });
      broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
      broadcast?.({ kind: 'toast', toast: { title: 'Pre-flight Failed', body: errMsg, icon: 'x-circle', color: 'red', kind: 'error' } });
      return;
    }
  }

  // Create an isolated shadow workspace (git worktree) for this task.
  // Falls back gracefully if the project workspace has no git repo.
  const shadowPath = createShadowWorktree(projectWorkspace, task.id);
  if (shadowPath) {
    console.log(`[shadow] ${task.id} → ${shadowPath}`);
  }

  const attempts  = (task.attempts || 0) + 1;
  const startedAt  = Date.now();
  _loopSuppress.delete(task.id); // clear any previous judge verdicts for this attempt
  let heartbeatPhase = 'boot';
  let heartbeatRound = 0;

  // If the task was re-queued with human feedback, start from a continuation brief
  // (preserves context) instead of starting fresh. Then clear the flag.
  const isFeedbackRequeue = !!(task.feedback_requeue && (task.artifacts || []).length > 0);

  const updated = repo.patch('tasks', task.id, {
    status: 'running', attempts, started_at: startedAt,
    feedback_requeue: false, // clear flag
    heartbeat_at: startedAt,
    heartbeat: { ts: startedAt, agent: agent.id, kind: 'started', phase: heartbeatPhase, round: heartbeatRound, attempt: attempts },
    last_progress_at: startedAt,
    progress_state: 'started',
    progress_summary: 'task execution started',
    blocked_reason: null,
    history: [...(task.history || []),
      { ts: startedAt, kind: 'started', by: agent.id, note: `attempt ${attempts}${isFeedbackRequeue ? ' (feedback-continuation)' : ''}` }],
  });
  broadcast?.({ kind: 'task:update', task: updated });
  bus.publish('task:lifecycle', { type: 'task:started', source: agent.id, data: { taskId: task.id, projectId: task.project_id, attempt: attempts } });

  const heartbeatTimer = setInterval(() => {
    const liveTask = repo.byId('tasks', task.id);
    if (!liveTask || liveTask.status !== 'running') {
      clearInterval(heartbeatTimer);
      return;
    }
    emitTaskHeartbeat(task.id, agent.id, broadcast, { kind: 'alive', phase: heartbeatPhase, round: heartbeatRound, attempt: attempts });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  // ── Context gathering ─────────────────────────────────────────────
  const projectTasks = repo.list('tasks').filter((t) => t.project_id === task.project_id);
  const projectBugs  = repo.list('bugs').filter((b) => b.project_id === task.project_id);
  const projectReqs  = repo.list('reqs').filter((r) => r.project_id === task.project_id);

  const commentsBlock = (task.comments || []).slice(-8).map((c) =>
    `  [${new Date(c.ts).toISOString()}] ${c.by}: ${c.text}`).join('\n');

  const previousErrors = (task.history || [])
    .filter((h) => h.kind === 'failed').slice(-3)
    .map((h) => `  • ${h.note}`).join('\n');

  // Surface evidence gate demotion reason prominently so the agent knows exactly
  // what it must fix before calling db_finish_task("done") again.
  const demotionBlock = task.demotion_reason
    ? `\n⚠️ EVIDENCE GATE REJECTION (previous attempt):\n  ${task.demotion_reason}\n  Fix this issue FIRST, then call db_finish_task.`
    : '';

  // D1: Augment previous errors with cross-task failure RAG (best-effort, don't block start)
  let previousErrorsAugmented = (previousErrors + demotionBlock).trim() || previousErrors;
  if (attempts > 1 && task.project_id) {
    try {
      const query = `${task.title} ${previousErrors}`.slice(0, 600);
      const past = await similarFailures({ projectId: task.project_id, by: (task.by || '').toLowerCase(), query, k: 3 });
      if (past.length) {
        const pastBlock = past.map((f) => `  • [${f.by}] ${(f.error || '').slice(0, 200)}`).join('\n');
        previousErrorsAugmented = previousErrors
          + `\n\nSIMILAR PAST FAILURES (tried before — avoid these approaches):\n${pastBlock}`;
      }
    } catch { /* embed may fail — non-fatal */ }
  }

  // Requirement context — vault note or DB row
  let reqContext = null;
  if (task.parent_req) {
    try {
      const reqNote = readNote(`projects/${task.project_id}/reqs/${task.parent_req}.md`);
      if (reqNote) reqContext = reqNote.body?.slice(0, 2000) || null;
    } catch { /* miss */ }
    if (!reqContext) {
      const reqRow = repo.byId('reqs', task.parent_req);
      if (reqRow) {
        reqContext = `Title: ${reqRow.title}\nPriority: ${reqRow.priority || 'medium'}\nDesc: ${reqRow.desc || ''}\nCriteria:\n${(reqRow.criteria || []).map((c) => `  - ${c}`).join('\n') || '  (none)'}`;
      }
    }
  }

  // Workspace tree — use explicit project.workspace if set, else default path
  let workspaceTree = '';
  try {
    const ws = project.workspace || path.join(os.homedir(), 'gavirila-workspaces', project.id);
    if (fs.existsSync(ws)) {
      const isWinPath = /^[A-Z]:\\/.test(ws);
      // For Windows host paths, use PowerShell tree command for reliable output
      if (isWinPath) {
        try {
          const r = spawnSync('powershell', ['-NoProfile', '-Command',
            `Get-ChildItem '${ws}' -Recurse -Depth 3 -Name | Where-Object { $_ -notmatch 'node_modules|__pycache__|.git\\\\|.venv|dist\\\\|build\\\\' } | Select-Object -First 80`
          ], { timeout: 10_000, encoding: 'utf8' });
          workspaceTree = (r.stdout || '').trim().split('\n').map(l => `  📄 ${l.trim()}`).join('\n');
        } catch { /* fall through to JS walk */ }
      }
      if (!workspaceTree) {
        const lines = [];
        const walk = (dir, depth) => {
          if (depth > 3) return;
          for (const ent of fs.readdirSync(dir, { withFileTypes: true }).slice(0, 30)) {
            if (['node_modules', '.git', '__pycache__', '.venv'].includes(ent.name)) continue;
            const rel = path.relative(ws, path.join(dir, ent.name));
            lines.push(`${'  '.repeat(depth)}${ent.isDirectory() ? '📁' : '📄'} ${rel}`);
            if (ent.isDirectory()) walk(path.join(dir, ent.name), depth + 1);
          }
        };
        walk(ws, 0);
        workspaceTree = lines.slice(0, 80).join('\n');
      }
    } else {
      workspaceTree = `⚠️ WORKSPACE PATH DOES NOT EXIST: ${ws}\nThe agent must create this directory or the project workspace config is wrong.`;
    }
  } catch { /* non-critical */ }

  // Auto-inject architecture context (saves 2-3 rounds of agent reading)
  let archContext = '';
  try {
    const archNote = readNote(`projects/${task.project_id}/architecture.md`);
    if (archNote?.body) archContext = archNote.body.slice(0, 2000);
  } catch { /* miss */ }

  // Upstream task context — what did the dependency tasks produce?
  // This solves the handoff problem: downstream agents see upstream artifacts
  let upstreamContext = '';
  if (task.depends_on?.length) {
    const upstreamLines = [];
    for (const depId of task.depends_on.slice(0, 3)) {
      const dep = repo.byId('tasks', depId);
      if (!dep) continue;
      const writes = (dep.artifacts || [])
        .filter(a => ['fs_write_file', 'shell_exec', 'fs_patch_file'].includes(a.tool))
        .slice(-8)
        .map(a => `    ${a.summary || a.tool}`);
      upstreamLines.push(`  [${dep.by}] "${dep.title}" (${dep.status}):\n    outcome: ${(dep.outcome || '').slice(0, 300)}\n${writes.join('\n')}`);
    }
    if (upstreamLines.length) {
      upstreamContext = `UPSTREAM WORK (build on this, don't redo):\n${upstreamLines.join('\n')}`;
    }
  }

  // Active agents in this project (for coordination awareness)
  const activeAgents = projectTasks
    .filter((t) => t.status === 'running' && t.id !== task.id)
    .map((t) => ({ id: t.id, title: t.title, agent: t.by }));

  const system = getAgentSystem(agent.id, {
    project,
    openTasks: projectTasks.filter((t) => t.status !== 'done').length,
    openBugs:  projectBugs.filter((b) => b.status !== 'closed').length,
    reqs: projectReqs, bugs: projectBugs, tasks: projectTasks,
  });

  // Persistent conversation thread for Aumovio providers (OpenAI format).
  // Carries ALL tool calls + results across outer rounds → agents never re-read unchanged files.
  // Gemini/Anthropic providers fall back to stateless messages[] param (unchanged behavior).
  const aumThread = [{ role: 'system', content: system }];
  const threadMeta = { filesRead: {}, round: 1 };

  // Sliding deadline: starts at 12 min, extends by DEADLINE_EXTEND_MS whenever the
  // agent makes real tool calls. Never exceeds MAX_TASK_ABSOLUTE_MS from startedAt.
  const absoluteDeadline = startedAt + MAX_TASK_ABSOLUTE_MS;
  let deadline = startedAt + MAX_TASK_RUNTIME_MS;
  let lastReply = '';
  let lastProvider = '';
  let lastToolCalls = [];
  let consecutiveEmptyRounds = 0;  // tool-stall detector
  let taskTokensUsed = 0;         // token budget tracker
  let cannedRoundCount = 0;       // LLM pool exhaustion tracker

  // ── Architect / Typist split for complex code tasks ───────────────
  // For tasks that match the split heuristic, run a two-phase pipeline:
  //   Phase 1: strong reasoning model produces a SEARCH/REPLACE plan (no tools)
  //   Phase 2: fast coding model executes the plan with file/shell tools
  //   Phase 3: reasoning model reviews the diff and approves or rejects
  // On approval  → mark done and skip the normal agentic loop.
  // On rejection → re-queue with Architect feedback injected into desc.
  // On failure   → fall through to the normal loop as a safety net.
  if (shouldSplit(task)) {
    console.log(`[task-runner] Architect/Typist split activated for ${task.id}`);
    const splitToolCtx = {
      repo, broadcast,
      agentId:   agent.id,
      projectId: task.project_id,
      taskId:    task.id,
      threadMeta,
      shadowPath,
    };
    const splitResult = await runArchitectTypist(task, agent, splitToolCtx, broadcast);

    if (splitResult.outcome === 'done') {
      // Typist made real file changes which were already artifact-recorded by executeTool.
      // db_finish_task was not called, so we close the task here.
      const changesSummary = splitResult.changes
        .map((tc) => tc.args?.path || tc.args?.file_path || tc.name)
        .join(', ');
      repo.patch('tasks', task.id, {
        status:     'review',   // human review before done — Architect approved but human should verify
        outcome:    `Architect/Typist split complete. Files changed: ${changesSummary || '(see artifacts)'}`,
        updated_at: Date.now(),
        history:    [...(repo.byId('tasks', task.id)?.history || task.history || []), {
          ts: Date.now(), kind: 'finished', by: agent.id,
          note: 'architect-typist pipeline completed — moved to review',
        }],
      });
      broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
      return; // skip normal agentic loop
    } else if (splitResult.outcome === 'needs-revision') {
      // Re-queue with Architect feedback injected; disable split to avoid infinite loop
      repo.patch('tasks', task.id, {
        status:       'queued',
        useArchitect: false,
        desc:         `${task.desc || task.title}\n\n[Architect Feedback — revision needed]: ${splitResult.feedback}`,
        updated_at:   Date.now(),
        history:      [...(repo.byId('tasks', task.id)?.history || task.history || []), {
          ts: Date.now(), kind: 'requeued', by: 'architect-typist',
          note: `architect rejected changes: ${splitResult.feedback.slice(0, 140)}`,
        }],
      });
      broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
      return; // skip normal agentic loop
    }
    // outcome === 'failed' → fall through to normal loop as safety net
    console.warn(`[task-runner] Architect/Typist split failed for ${task.id} — falling back to normal loop`);
  }

  // ── Multi-round agentic loop ──────────────────────────────────────
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const roundStart = Date.now();

    if (Date.now() >= deadline) {
      return handleFailure(task, agent, `task timeout (${MAX_TASK_RUNTIME_LABEL})`, broadcast);
    }

    const live = repo.byId('tasks', task.id);
    if (!live || live.status !== 'running') break;

    const allArtifactsThisAttempt = (live.artifacts || []).filter(
      (a) => a.ts >= startedAt && a.by === agent.id
    );

    const isFirstRound = round === 1 && !isFeedbackRequeue;
    heartbeatRound = round;
    heartbeatPhase = isFirstRound ? 'initial-brief' : 'continuation';
    emitTaskHeartbeat(task.id, agent.id, broadcast, { kind: 'round-start', phase: heartbeatPhase, round, attempt: attempts });
    let mission = isFirstRound
      ? buildInitialMission({ task: live, project, agent, attempts, commentsBlock, previousErrors: previousErrorsAugmented, reqContext, workspaceTree, activeAgents, shadowPath, archContext, upstreamContext })
      : buildContinuationMission({ task: live, round, allArtifacts: allArtifactsThisAttempt, startedAt, consecutiveEmptyRounds });

    // D2: Inject entity memories on first round of EVERY attempt (including feedback-requeue retries)
    if (round === 1) {
      const memoryContext = recallMemories(agent.id, live, { projectId: live.project_id });
      if (memoryContext) mission += memoryContext;
    }

    // Push to persistent thread: full mission on round 1, slim nudge on round 2+
    // (Aumovio already has full context in thread — no need to repeat WORK SO FAR)
    const threadUserMsg = isFirstRound
      ? mission
      : buildContinuationNudge({ task: live, round, startedAt, consecutiveEmptyRounds, allArtifacts: allArtifactsThisAttempt });
    aumThread.push({ role: 'user', content: threadUserMsg });

    // Flaw 5: Cap aumThread to prevent unbounded memory growth
    if (aumThread.length > 42) {
      const systemMsg = aumThread[0];
      const recent = aumThread.slice(-40);
      aumThread.length = 0;
      aumThread.push(systemMsg, ...recent);
    }

    threadMeta.round = round;

    let result;
    try {
      result = await Promise.race([
        chat({
          messages: [{ role: 'user', content: mission }],
          system,
          tier: agent.tier,
          agent: agent.id,
          purpose: 'task-execution',
          toolScopes: getScopesForProject(task.project_id, agent.toolScopes || []),
          thread: aumThread,
          toolCtx: {
            repo, broadcast,
            agentId: agent.id,
            projectId: task.project_id,
            taskId: task.id,
            threadMeta,
            shadowPath,
          },
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`task timeout (${MAX_TASK_RUNTIME_LABEL})`)), deadline - Date.now())),
      ]);
    } catch (err) {
      return handleFailure(task, agent, err.message, broadcast);
    }

    const { reply, provider, toolCalls } = result;
    lastReply    = reply;
    lastProvider = provider;
    lastToolCalls = toolCalls || [];

    // LLM pool exhaustion guard — if all providers are down and we got a canned reply,
    // don't waste the agent's attempt budget spinning on fallback responses.
    if (provider === 'canned') {
      cannedRoundCount = (cannedRoundCount || 0) + 1;
      if (cannedRoundCount >= 2) {
        console.warn(`[task-runner] ${task.id} got ${cannedRoundCount} consecutive canned replies — all LLM providers exhausted, failing task`);
        return handleFailure(task, agent, `LLM pool exhausted: ${cannedRoundCount} consecutive canned replies — all providers are down or rate-limited`, broadcast);
      }
    } else {
      cannedRoundCount = 0;
    }

    // Token budget guard — estimate tokens used this round and accumulate
    const roundTokenEstimate = Math.ceil(((reply || '').length + JSON.stringify(toolCalls || []).length) / 3);
    taskTokensUsed += roundTokenEstimate;
    if (taskTokensUsed > MAX_TOKENS_PER_TASK) {
      console.warn(`[task-runner] ${task.id} hit token budget (${taskTokensUsed} > ${MAX_TOKENS_PER_TASK}) at round ${round}`);
      return handleFailure(task, agent, `token budget exceeded: ~${taskTokensUsed} tokens used (max ${MAX_TOKENS_PER_TASK})`, broadcast);
    }

    // Record artifacts
    const roundArtifacts = (toolCalls || []).map((tc) => ({
      tool: tc.name, args: tc.args, result: tc.result,
      summary: _summarizeToolCall(tc),
      ts: Date.now(), by: agent.id, round,
    }));
    if (roundArtifacts.length) {
      const cur = repo.byId('tasks', task.id);
      if (cur) repo.patch('tasks', task.id, { artifacts: [...(cur.artifacts || []), ...roundArtifacts] });
      recordTaskProgress(task.id, agent.id, broadcast, {
        kind: 'tool-call',
        phase: 'tool-results',
        round,
        summary: roundArtifacts.slice(-2).map((artifact) => artifact.summary).join(' | '),
      });
      // Extend the sliding deadline — agent is making real progress
      const extended = Math.min(Date.now() + DEADLINE_EXTEND_MS, absoluteDeadline);
      if (extended > deadline) {
        deadline = extended;
      }
    } else {
      emitTaskHeartbeat(task.id, agent.id, broadcast, { kind: 'no-tool-response', phase: 'tool-results', round, attempt: attempts });
    }

    // Tool-stall detector — agent stuck in pure text-only mode, will never finish.
    // Tool-stall detector — fires when ALL three conditions hold:
    //   1. round > 2  (allow a short warm-up)
    //   2. N consecutive rounds with zero tool calls
    //   3. threshold: 4 if agent never used a tool yet; 6 if it did some work but went silent
    //
    // NOTE: removing the old `totalArtifacts < 3` guard — it silently disabled stall
    // detection entirely once an agent made 3+ calls, letting zombies run to MAX_ROUNDS.
    if (roundArtifacts.length === 0 && round > 2) {
      consecutiveEmptyRounds++;
      const totalArtifactsThisAttempt = allArtifactsThisAttempt.length;
      const stallThreshold = totalArtifactsThisAttempt === 0 ? 4 : 6;
      if (consecutiveEmptyRounds >= stallThreshold) {
        console.warn(`[task-runner] ${task.id} tool-stall at round ${round}: ${consecutiveEmptyRounds} consecutive empty rounds (${totalArtifactsThisAttempt} total artifacts)`);
        return handleFailure(task, agent, `tool-stall: ${consecutiveEmptyRounds} consecutive rounds with zero tool calls — agent not using tools`, broadcast);
      }
    } else {
      consecutiveEmptyRounds = 0;
    }

    // ── Filesystem failure escalation ──────────────────────────────────
    // If the last 3+ tool calls were fs errors ("not found", "Directory not found"),
    // auto-run a diagnostic and inject results into the agent's next round.
    const recentArtifacts = (repo.byId('tasks', task.id)?.artifacts || []).filter(a => a.ts >= startedAt).slice(-5);
    const consecutiveFsErrors = recentArtifacts.filter(a =>
      ['fs_read_file', 'fs_list_dir', 'fs_find', 'shell_exec'].includes(a.tool) &&
      a.ok === false
    ).length;
    if (consecutiveFsErrors >= 3 && project.workspace) {
      const ws = project.workspace;
      const isWinPath = /^[A-Z]:\\/.test(ws);
      let diagOutput = '';
      try {
        if (isWinPath) {
          const r = spawnSync('powershell', ['-NoProfile', '-Command',
            `if(Test-Path '${ws}'){Get-ChildItem '${ws}' -Depth 2 | Select-Object FullName | Format-Table -HideTableHeaders}else{Write-Output 'PATH DOES NOT EXIST: ${ws}'}`
          ], { timeout: 10_000, encoding: 'utf8' });
          diagOutput = (r.stdout || r.stderr || '').slice(0, 3000);
        } else {
          const r = spawnSync('bash', ['-c', `ls -la "${ws}" 2>&1 | head -50`], { timeout: 10_000, encoding: 'utf8' });
          diagOutput = (r.stdout || r.stderr || '').slice(0, 3000);
        }
      } catch (e) { diagOutput = `diagnostic failed: ${e.message}`; }

      // Inject as a system comment so the agent sees it next round
      const diagComment = {
        id: `diag-${Date.now()}`, by: 'pathfinder',
        text: `🔍 AUTO-DIAGNOSTIC: ${consecutiveFsErrors} consecutive filesystem errors detected.\nWorkspace: ${ws}\nDirectory listing:\n\`\`\`\n${diagOutput}\n\`\`\`\nUse these EXACT paths in your tool calls. The workspace is "${ws}".`,
        ts: Date.now(),
      };
      const liveDiag = repo.byId('tasks', task.id);
      repo.patch('tasks', task.id, { comments: [...(liveDiag?.comments || []), diagComment] });
      console.log(`[pathfinder] injected diagnostic for ${task.id} after ${consecutiveFsErrors} fs errors`);
    }

    // Loop detection — consult AI judge before killing; false positives are common
    const allArtifactsNow = (repo.byId('tasks', task.id)?.artifacts || []).filter(
      (a) => a.ts >= startedAt && a.by === agent.id
    );
    const loopReason = detectLoop(allArtifactsNow, round);
    if (loopReason) {
      const isHardLoop = loopReason.startsWith('loop detected:') || loopReason.startsWith('shell loop:');
      if (isHardLoop) {
        console.warn(`[task-runner] ${task.id} hard loop at round ${round}: ${loopReason}`);
        return handleFailure(task, agent, loopReason, broadcast);
      }
      const suppress = _loopSuppress.get(task.id);
      if (suppress && round <= suppress.suppressUntilRound) {
        // Judge already cleared this — keep going silently
        console.log(`[task-runner] ${task.id} loop signal suppressed by judge (until round ${suppress.suppressUntilRound})`);
      } else {
        console.warn(`[task-runner] ${task.id} loop signal at round ${round}: ${loopReason} — consulting judge`);
        const judgment = await askLoopJudge(task, agent, loopReason, allArtifactsNow, round);
        if (judgment.verdict === 'continue') {
          _loopSuppress.set(task.id, { suppressUntilRound: round + 6 });
          console.log(`[task-runner] ${task.id} judge: continue — ${judgment.feedback}`);
          // Inject judge feedback as a comment so agent sees the nudge next round
          if (judgment.feedback) {
            const live2 = repo.byId('tasks', task.id);
            const c = { id: `judge-${Date.now()}`, by: 'loop-judge', text: `[supervisor] ${judgment.feedback}`, ts: Date.now() };
            repo.patch('tasks', task.id, { comments: [...(live2?.comments || []), c] });
          }
        } else {
          console.warn(`[task-runner] ${task.id} judge: retry — ${judgment.feedback}`);
          return handleFailure(task, agent, `${loopReason} | judge: ${judgment.feedback}`, broadcast);
        }
      }
    }

    // Append to agent chat log (this is what the frontend listens to via WS).
    // When the LLM emits only tool calls and no text, synthesise a brief
    // activity line so the chat doesn't show blank header-only messages.
    const toolSummary = (toolCalls || []).map((tc) => `${tc.name}(${Object.keys(tc.args || {}).join(', ')})`);
    const displayText = reply?.trim()
      || (toolSummary.length ? `🔧 ${toolSummary.join('  →  ')}` : null);

    // Skip broadcast entirely if there is nothing to show (shouldn't happen, but safety net).
    if (!displayText) {
      // Still persist so history is complete
      repo.appendChat(`${task.project_id}:${agent.id}`, {
        id: `a-task-${Date.now()}-${Math.random().toString(36).slice(2,5)}`,
        role: 'assistant', text: '', provider, ts: Date.now(),
        tools: toolSummary, toolCalls: toolCalls || [],
      });
    } else {
      const chatKey = `${task.project_id}:${agent.id}`;
      const aMsg = {
        id: `a-task-${Date.now()}-${Math.random().toString(36).slice(2,5)}`,
        role: 'assistant',
        text: displayText,
        provider, ts: Date.now(), projectId: task.project_id,
        tools: toolSummary,
        toolCalls: toolCalls || [],
      };
      repo.appendChat(chatKey, aMsg);
      // Tag as task_execution so frontend can distinguish from user-initiated chat
      broadcast?.({ kind: 'chat:reply', agent: agent.id, projectId: task.project_id, message: aMsg, source: 'task_execution' });
      bus.publish('agent:chat', { type: 'chat:reply', source: agent.id, data: { projectId: task.project_id, taskId: task.id, message: aMsg } });
    }

    if (provider === 'canned') {
      return handleFailure(task, agent, 'all LLM providers exhausted (canned fallback)', broadcast);
    }

    try {
      const autoFinished = await maybeAutoFinishVerifiedTask({
        task,
        agent,
        startedAt,
        projectWorkspace,
        shadowPath,
        broadcast,
      });
      if (autoFinished) break;
    } catch (verifyErr) {
      console.warn(`[task-runner] ${task.id} auto-finish check failed: ${verifyErr.message}`);
    }

    // Only valid early exits:
    //   1. agent called db_finish_task (status changed from 'running')
    //   2. loop detection fired (handled above)
    //   3. wall-clock deadline (handled above)
    //   4. canned provider (handled above)
    // Never exit based on LLM reply text — the agent controls its own lifecycle.
    const afterRound = repo.byId('tasks', task.id);
    if (!afterRound || afterRound.status !== 'running') break;
  }

  // ── Final disposition if agent didn't call db_finish_task ─────────
  // This only fires if the agent hit MAX_ROUNDS without finishing.
  // Re-queue with a continuation brief so it can wrap up.
  // After MAX_AUTO_RETRIES exhausted, escalate to review for human eyes.
  const after = repo.byId('tasks', task.id);
  if (after && after.status === 'running') {
    if (attempts <= MAX_AUTO_RETRIES) {
      repo.patch('tasks', task.id, {
        status: 'queued',
        feedback_requeue: true,
        history: [...(after.history || []), {
          ts: Date.now(), kind: 'requeued', by: 'runner',
          note: `hit MAX_ROUNDS (${MAX_ROUNDS}) without db_finish_task — re-queuing continuation (attempt ${attempts})`,
        }],
      });
    } else {
      repo.patch('tasks', task.id, {
        status: 'review',
        outcome: lastReply.slice(0, 600),
        history: [...(after.history || []), {
          ts: Date.now(), kind: 'auto-resolved', by: agent.id,
          note: `MAX_ROUNDS hit, ${attempts} attempts exhausted — set to review`,
        }],
      });
    }
    broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
  }
  // Record conductor end time for cooldown (success path — agent called db_finish_task)
  if (agent?.id === 'conductor') _lastConductorEndByProject.set(task.project_id, Date.now());

  // Record outcome for the self-optimizing prompt system
  const finalTask = repo.byId('tasks', task.id);
  const taskSucceeded = finalTask?.status === 'done';
  const taskErrorPattern = finalTask?.status === 'needs-human' ? 'escalated-to-human'
    : finalTask?.status === 'tribunal' ? 'tribunal-escalated'
    : !taskSucceeded ? (finalTask?.status || 'unknown') : null;

  // Publish lifecycle event for task completion
  if (taskSucceeded) {
    bus.publish('task:lifecycle', { type: 'task:finished', source: agent.id, data: { taskId: task.id, projectId: task.project_id, status: finalTask.status, outcome: finalTask.outcome } });
  } else if (finalTask?.status && finalTask.status !== 'running') {
    bus.publish('task:lifecycle', { type: 'task:failed', source: agent.id, data: { taskId: task.id, projectId: task.project_id, status: finalTask.status, error: taskErrorPattern } });
  }

  recordOutcome(agent.id, {
    success: taskSucceeded,
    errorPattern: taskErrorPattern,
    taskDesc: task.desc || task.title || '',
  });

  // Extract entity memories from this task for future context injection
  if (finalTask?.status === 'done' || finalTask?.status === 'review') {
    extractMemories(agent.id, finalTask, aumThread)
      .catch(e => console.error('[entity-memory] Extract error:', e.message));
  }

  // Finalize shadow workspace: generate diff, then clean up
  if (shadowPath) {
    const diff = finalizeShadowWorktree(projectWorkspace, shadowPath, task.id);
    if (diff) {
      const live = repo.byId('tasks', task.id);
      if (live) {
        repo.patch('tasks', task.id, { shadowDiff: diff.slice(0, 8000), shadowDiffLines: diff.split('\n').length });
      }
      console.log(`[shadow] ${task.id} diff: ${diff.split('\n').length} lines`);
    }
  }

  // Snapshot state after every completed task
  const finalTaskStatus = repo.byId('tasks', task.id)?.status || 'done';
  snapshotState(`task-${task.id}-${finalTaskStatus}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _summarizeToolCall(tc) {
  const a = tc.args || {};
  const r = tc.result || {};
  switch (tc.name) {
    case 'shell_exec':       return `ran \`${a.cmd || '?'}\` → exit ${r.exitCode ?? '?'}`;
    case 'fs_write_file':    return `wrote ${a.path || 'file'} (${String(a.content || '').length} chars)`;
    case 'fs_read_file':     return `read ${a.path || 'file'}`;
    case 'fs_list_dir':      return `listed ${a.dir || '.'}`;
    case 'fs_mkdir':         return `mkdir ${a.dir || '?'}`;
    case 'vault_write_note': return `vault note "${a.title || a.id || '?'}"`;
    case 'vault_search':     return `vault search "${(a.query || '').slice(0, 40)}"`;
    case 'db_finish_task':   return `finished ${a.id || '?'} → ${a.status || 'done'}`;
    case 'db_create_task':   return `new task "${a.title || '?'}" → ${a.by || '?'}`;
    case 'ping_agent':       return `pinged ${a.to || '?'}: ${(a.subject || '').slice(0, 40)}`;
    default:                 return `${tc.name}`;
  }
}

// B2-04: Build a fingerprint capturing the approach taken in this attempt
function buildRetryFingerprint(artifacts, errMsg) {
  const toolsUsed = [...new Set(artifacts.map(a => a.tool || a.kind || 'unknown'))].sort();
  const errClass = (errMsg.match(/^[A-Z_]+:/) || [errMsg.split(/[:\n]/)[0].slice(0, 50)])[0];
  const raw = `${toolsUsed.join(',')}|${errClass}`;
  // Simple string hash — enough for dedup within a few attempts
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  return { hash: String(hash), tools: toolsUsed, errClass };
}

function handleFailure(task, agent, errMsg, broadcast) {
  // Read attempts from the live DB row — runOneTask already incremented + patched it
  const live = repo.byId('tasks', task.id);
  const attempts = live?.attempts || task.attempts || 1;
  console.error(`[task-runner] ${task.id} failed (attempt ${attempts}): ${errMsg}`);
  bus.publish('task:lifecycle', { type: 'task:failed', source: agent?.id || 'runner', data: { taskId: task.id, projectId: task.project_id, error: errMsg, attempt: attempts } });

  // B2-04: Capture retry fingerprint — hash of tools used + key args + error class
  const currentArtifacts = (live?.artifacts || task.artifacts || [])
    .filter(a => a.ts && a.ts >= (live?.started_at || task.started_at || 0));
  const fingerprint = buildRetryFingerprint(currentArtifacts, errMsg);
  const existingFingerprints = live?.retry_fingerprints || task.retry_fingerprints || [];
  const newFingerprints = [...existingFingerprints, { attempt: attempts, ...fingerprint, ts: Date.now() }];

  // D1: Record failure into RAG index (best-effort, async fire-and-forget)
  recordFailure({
    taskId: task.id, projectId: task.project_id,
    by: agent?.id || 'runner',
    error: errMsg,
    context: (task.title || '') + '\n' + (task.desc || '').slice(0, 500),
  }).catch(() => { /* embed best-effort */ });

  const history = [...((live?.history || task.history) || []), {
    ts: Date.now(), kind: 'failed', by: agent?.id || 'runner',
    note: `attempt ${attempts}: ${errMsg.slice(0, 200)}`,
  }];

  // Escalation ladder: check for auto-fixable patterns BEFORE burning retry budget
  const escalation = applyEscalationLadder(live || task, errMsg);
  if (escalation.action === 'requeue') {
    // Template fix found — requeue with fix instructions injected into desc
    // This does NOT consume the retry budget (attempts not incremented)
    repo.patch('tasks', task.id, {
      status: 'queued',
      error: errMsg,
      templateFixApplied: escalation.templateId,
      desc: escalation.newDesc,
      history: [...history, {
        ts: Date.now(), kind: 'template-fix', by: 'escalation-ladder',
        note: `Auto-fix applied: ${escalation.reason} — requeuing with fix instructions`,
      }],
    });
    broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
    broadcast?.({ kind: 'toast', toast: { title: 'Auto-Fix Applied', body: escalation.reason, icon: 'lightbulb', color: 'blue', kind: 'info' } });
    recordDecision({ type: 'template-fix', projectId: task.project_id, taskId: task.id, cause: errMsg.slice(0, 200), ruleApplied: `escalation-ladder.${escalation.templateId}`, evidence: { templateId: escalation.templateId }, outcome: `Template fix applied: ${escalation.reason}`, confidence: 0.8, actor: 'escalation-ladder' });
    console.log(`[escalation-ladder] ${task.id}: template fix applied (${escalation.templateId}) — requeued`);
    return;
  } else if (escalation.action === 'needs-human') {
    // Was always-human (auth, budget, security) — try rescue first
    const liveForRescue = repo.byId('tasks', task.id) || task;
    spawnRescueTask(liveForRescue, `Escalation ladder: ${escalation.reason}. Error: ${errMsg}`, broadcast);
    return;
  }
  // escalation.action === 'tribunal' → fall through to existing retry/tribunal logic

  // B2-03: Adaptive constraint ladder — track failure at current level and advance if needed
  const levelAttempts = recordLevelAttempt(live || task, 'failed', errMsg.slice(0, 200));
  const levelAdvance = shouldAdvanceLevel({ ...(live || task), level_attempts: levelAttempts });

  if (levelAdvance.advance && levelAdvance.nextLevel) {
    const advanceHistory = [...history, {
      ts: Date.now(), kind: 'constraint-advance', by: 'constraint-ladder',
      note: levelAdvance.reason,
    }];

    if (levelAdvance.nextLevel === 4) {
      // L4: All constraint levels exhausted — spawn rescue instead of needs-human
      repo.patch('tasks', task.id, {
        constraint_level: 4,
        level_attempts: levelAttempts,
        history: advanceHistory,
      });
      recordDecision({ type: 'constraint-advance', projectId: task.project_id, taskId: task.id, cause: errMsg.slice(0, 200), ruleApplied: 'constraint-levels.shouldAdvanceLevel', evidence: { level: 4, attempts: levelAttempts }, outcome: 'Rescue dispatched — all constraint levels exhausted', confidence: 0.9, actor: 'constraint-ladder' });
      const liveForRescue = repo.byId('tasks', task.id) || task;
      spawnRescueTask(liveForRescue, `Constraint ladder exhausted (L4). Error: ${errMsg}`, broadcast);
      console.log(`[constraint-ladder] ${task.id}: L4 — rescue dispatched`);
      return;
    }

    // Advance to next level and requeue
    repo.patch('tasks', task.id, {
      status: 'queued',
      error: errMsg,
      constraint_level: levelAdvance.nextLevel,
      level_attempts: levelAttempts,
      history: advanceHistory,
    });
    broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
    console.log(`[constraint-ladder] ${task.id}: advanced to L${levelAdvance.nextLevel} — requeued`);
    return;
  }

  // Record attempt without advancing
  repo.patch('tasks', task.id, { level_attempts: levelAttempts, retry_fingerprints: newFingerprints });

  if (attempts <= MAX_AUTO_RETRIES) {
    // B2-04: Check for duplicate retry fingerprint — block same strategy
    const isDuplicate = existingFingerprints.some(prev =>
      prev.hash === fingerprint.hash && prev.attempt !== attempts
    );
    const TRANSIENT_ERRORS = /ETIMEDOUT|ECONNREFUSED|ECONNRESET|rate.limit|429|503|socket.hang.up/i;
    const isTransient = TRANSIENT_ERRORS.test(errMsg);

    if (isDuplicate && !isTransient) {
      // Same approach already failed — inject mutation requirement
      repo.patch('tasks', task.id, {
        status: 'queued', error: errMsg,
        retry_mutation_required: true,
        history: [...history, { ts: Date.now(), kind: 'requeued', by: 'runner', note: `auto-retry (MUTATION REQUIRED — previous identical approach failed)` }],
      });
    } else {
      repo.patch('tasks', task.id, {
        status: 'queued', error: errMsg,
        history: [...history, { ts: Date.now(), kind: 'requeued', by: 'runner', note: `auto-retry${isTransient ? ' (transient error — same approach allowed)' : ''}` }],
      });
    }
    if (agent?.id === 'conductor') _lastConductorEndByProject.set(task.project_id, Date.now());
    broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
  } else {
    // Before escalating to human: run the Tribunal.
    // The tribunal runs async (fire-and-forget) so it doesn't block the task runner tick.
    repo.patch('tasks', task.id, { status: 'tribunal', error: errMsg, history });
    recordDecision({ type: 'escalation', projectId: task.project_id, taskId: task.id, cause: `Retry budget exhausted after ${attempts} attempts`, ruleApplied: 'handleFailure.tribunal', evidence: { attempts, error: errMsg.slice(0, 200) }, outcome: 'Escalated to tribunal', confidence: 0.7, actor: 'task-runner' });
    if (agent?.id === 'conductor') _lastConductorEndByProject.set(task.project_id, Date.now());
    broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
    // Tribunal runs in background — its final broadcast will update the UI
    runTribunal(task, broadcast).catch(err => {
      console.error(`[tribunal] crashed for ${task.id}: ${err.message}`);
      // Hard fallback: spawn rescue if tribunal itself crashes
      const liveForRescue = repo.byId('tasks', task.id) || task;
      spawnRescueTask(liveForRescue, `Tribunal crashed: ${err.message}. Original error: ${errMsg}`, broadcast);
    });
    return; // Don't broadcast needs-human here — tribunal does it
  }
}

// Export for manual trigger via /api/tasks/stir endpoint
export { stirUpStuckTasks, spawnRescueTask };
