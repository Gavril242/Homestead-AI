/**
 * Architect & Typist Split
 *
 * Phase 1 — Architect (strong reasoning model, e.g. GPT-5-high):
 *   Reads the task description and produces a structured SEARCH/REPLACE plan.
 *   No tool calls — pure reasoning output.
 *
 * Phase 2 — Typist (fast coding model, e.g. Qwen3-coder-480b):
 *   Receives the Architect's plan and executes it using file/shell tools.
 *   Scoped to exec_fs + exec_shell + vault_read only — cannot call db_finish_task.
 *
 * Phase 3 — Architect Review:
 *   Architect sees the list of changes the Typist made and signs off.
 *   Only after approval does the caller call db_finish_task.
 *
 * NOTE: chat() in llm/index.js handles the full tool-calling loop internally.
 * Tool calls returned in response.toolCalls are already executed.
 * The Typist uses chat()'s internal loop (up to MAX_TOOL_ROUNDS=4 per outer round).
 */

import { chat } from '../llm/index.js';
import { repo } from '../db.js';

const ARCHITECT_TIMEOUT_MS = 90_000;
const TYPIST_MAX_OUTER_ROUNDS = 5;   // each outer round does up to 4 tool-call rounds inside chat()
const REVIEW_TIMEOUT_MS    = 60_000;

// Scopes given to the Typist — deliberately excludes db_tasks to prevent
// db_finish_task, db_create_task, ping_agent etc.  The Architect controls lifecycle.
const TYPIST_TOOL_SCOPES = ['vault_read', 'exec_fs', 'exec_shell'];

// Tool names that count as "file changes" for the review summary
const WRITE_TOOL_NAMES = new Set(['fs_write_file', 'fs_patch_file', 'fs_mkdir', 'fs_delete_file']);

/**
 * Determine if a task should use the Architect/Typist split.
 * Explicit opt-in/out via task.useArchitect takes precedence.
 * Otherwise triggers for complex multi-file tasks assigned to code agents.
 */
export function shouldSplit(task) {
  if (task.useArchitect === false) return false;
  if (task.useArchitect === true)  return true;

  const desc = `${task.title || ''}\n${task.desc || ''}`.toLowerCase();
  const SPLIT_SIGNALS = [
    '[architect]', '[split]', 'architect-typist',
    'use architect', 'use split mode',
  ];
  const isComplex   = SPLIT_SIGNALS.some((signal) => desc.includes(signal));
  const isCodeAgent = new Set(['forge', 'vince', 'forger']).has((task.by || '').toLowerCase());

  return isComplex && isCodeAgent;
}

// ── Phase 1: Architect ────────────────────────────────────────────────────────

async function runArchitect(task, agent) {
  const project = repo.byId('projects', task.project_id);

  const architectSystem = `You are a senior software architect. Your ONLY output is a structured implementation plan.
DO NOT write code. DO NOT call any tools. ONLY produce the plan text.

PROJECT: ${project?.name || task.project_id}
TASK: ${task.title || task.desc}
DESCRIPTION: ${task.desc || ''}

Produce a plan with these sections:
1. **Files to modify** — list each file with exact path
2. **Changes per file** as SEARCH/REPLACE blocks:
   \`\`\`
   FILE: path/to/file.js
   SEARCH: [exact existing code to find]
   REPLACE: [new code to put in its place]
   \`\`\`
3. **New files to create** — with full content sketched out
4. **Test criteria** — how to verify the implementation is correct
5. **Risk flags** — things the Typist must be careful about

Be precise. The Typist will follow this plan exactly.`;

  const result = await Promise.race([
    chat({
      system: architectSystem,
      messages: [{ role: 'user', content: 'Create the implementation plan now. Output ONLY the plan.' }],
      purpose: 'plan',
      tier:    'strong',    // maps to GPT-5-high / Gemini 2.5 Pro
      agent:   agent.id,
      toolScopes: [],       // pure reasoning — no tool access
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Architect phase timeout')), ARCHITECT_TIMEOUT_MS)
    ),
  ]);

  return result?.reply || '';
}

// ── Phase 2: Typist ───────────────────────────────────────────────────────────

async function runTypist(plan, task, agent, toolCtx, broadcast) {
  const typistSystem = `You are a precise code implementation specialist (Typist).
You have been given an exact implementation plan by the Architect. Your job is to execute it.
Follow the plan step by step. Use the provided tools to read files and apply changes.
Do NOT deviate from the plan. Do NOT call db_finish_task — the Architect reviews your work.
When all changes are complete, output a brief plain-text summary of what was changed.`;

  const typistMission = `Execute this implementation plan precisely:

${plan}

Steps:
1. Use fs_read_file to verify each file's current content before editing.
2. Apply changes using fs_patch_file (for targeted edits) or fs_write_file (for new/full rewrites).
3. Run any shell commands specified in the plan to verify correctness.
4. When all steps are done, output a summary: "Changes complete: <what was modified>".`;

  // Persistent thread so context accumulates across outer rounds
  const typistThread = [
    { role: 'system', content: typistSystem },
    { role: 'user',   content: typistMission },
  ];

  const allWriteCalls = [];

  for (let outerRound = 0; outerRound < TYPIST_MAX_OUTER_ROUNDS; outerRound++) {
    // On round 0 the thread already has the full mission.
    // On subsequent rounds we push a nudge so the Typist continues.
    if (outerRound > 0) {
      typistThread.push({
        role: 'user',
        content: 'Continue with the remaining steps from the plan. If all steps are done, output your summary.',
      });
    }

    const response = await chat({
      system:     typistSystem,
      messages:   [{ role: 'user', content: typistMission }], // stateless fallback for Gemini
      purpose:    'synthesize',
      tier:       'fast',    // Qwen3-coder-480b or similar
      agent:      agent.id,
      toolScopes: TYPIST_TOOL_SCOPES,
      thread:     typistThread,  // Aumovio uses persistent thread; Gemini ignores it
      toolCtx,
    });

    if (!response) break;

    const roundCalls = response.toolCalls || [];

    // Collect write-class tool calls for the review summary
    const writesThisRound = roundCalls.filter((tc) => WRITE_TOOL_NAMES.has(tc.name));
    allWriteCalls.push(...writesThisRound);

    if (writesThisRound.length > 0) {
      const paths = writesThisRound.map((tc) => tc.args?.path || tc.args?.file_path || tc.name).join(', ');
      broadcast?.({
        kind: 'chat:reply', agent: agent.id, projectId: task.project_id,
        message: `Typist: ${paths}`,
        source: 'architect_typist',
      });
    }

    // No tool calls in this round → Typist either finished or stalled
    if (roundCalls.length === 0) break;
  }

  return allWriteCalls;
}

// ── Phase 3: Architect Review ─────────────────────────────────────────────────

async function runArchitectReview(plan, writeCalls, task) {
  const changesSummary = writeCalls.length > 0
    ? writeCalls.map((tc) => `- ${tc.name}: ${tc.args?.path || tc.args?.file_path || '?'}`).join('\n')
    : '(no file changes detected — Typist may not have made any writes)';

  const reviewPrompt = `You are the Architect reviewing the Typist's work.

ORIGINAL PLAN (first 3000 chars):
${plan.slice(0, 3000)}

FILE CHANGES MADE BY TYPIST:
${changesSummary}

Based on the plan's "Files to modify" and "Test criteria" sections:
- If the changes look complete and match the plan, respond exactly: APPROVED
- If key files are missing or changes don't match the plan, respond exactly: REJECTED: [specific issue]

Output ONLY "APPROVED" or "REJECTED: [reason]" — nothing else.`;

  const result = await Promise.race([
    chat({
      system:    'You are a senior software architect reviewing code changes. Be concise.',
      messages:  [{ role: 'user', content: reviewPrompt }],
      purpose:   'classify',
      tier:      'strong',
      agent:     'architect-review',
      toolScopes: [],
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Review phase timeout')), REVIEW_TIMEOUT_MS)
    ),
  ]);

  const reply    = result?.reply?.trim() || '';
  const approved = reply.startsWith('APPROVED');
  const feedback = approved ? '' : reply.replace(/^REJECTED:\s*/i, '').trim();

  return { approved, feedback };
}

// ── Main entry ────────────────────────────────────────────────────────────────

/**
 * Run the full Architect → Typist → Review pipeline.
 *
 * @param {object} task      — DB task row
 * @param {object} agent     — agent definition from agents.js
 * @param {object} toolCtx   — { repo, broadcast, agentId, projectId, taskId, threadMeta, shadowPath }
 * @param {Function} broadcast — WS broadcast fn
 * @returns {{ outcome: 'done'|'needs-revision'|'failed', plan, changes, feedback }}
 */
export async function runArchitectTypist(task, agent, toolCtx, broadcast) {
  const pid = task.project_id;
  console.log(`[architect-typist] Starting split for task ${task.id}`);

  broadcast?.({
    kind: 'chat:reply', agent: agent.id, projectId: pid,
    message: 'Architect planning...',
    source: 'architect_typist',
  });

  // ── Phase 1: Plan ──────────────────────────────────────────────
  let plan;
  try {
    plan = await runArchitect(task, agent);
  } catch (e) {
    console.error(`[architect-typist] Architect failed: ${e.message}`);
    return { outcome: 'failed', plan: '', changes: [], feedback: `Architect failed: ${e.message}` };
  }

  if (!plan || plan.length < 50) {
    return { outcome: 'failed', plan: '', changes: [], feedback: 'Architect produced empty or trivial plan' };
  }

  broadcast?.({
    kind: 'chat:reply', agent: agent.id, projectId: pid,
    message: `Plan ready (${plan.length} chars). Typist executing...`,
    source: 'architect_typist',
  });

  // ── Phase 2: Execute ───────────────────────────────────────────
  let changes;
  try {
    changes = await runTypist(plan, task, agent, toolCtx, broadcast);
  } catch (e) {
    console.error(`[architect-typist] Typist failed: ${e.message}`);
    return { outcome: 'failed', plan, changes: [], feedback: `Typist failed: ${e.message}` };
  }

  broadcast?.({
    kind: 'chat:reply', agent: agent.id, projectId: pid,
    message: `Typist made ${changes.length} file change(s). Architect reviewing...`,
    source: 'architect_typist',
  });

  // ── Phase 3: Review ────────────────────────────────────────────
  let review;
  try {
    review = await runArchitectReview(plan, changes, task);
  } catch (e) {
    console.error(`[architect-typist] Review failed: ${e.message} — auto-approving`);
    review = { approved: true, feedback: '' };
  }

  if (review.approved) {
    broadcast?.({
      kind: 'chat:reply', agent: agent.id, projectId: pid,
      message: 'Architect approved — task complete',
      source: 'architect_typist',
    });
    return { outcome: 'done', plan, changes, feedback: '' };
  } else {
    broadcast?.({
      kind: 'chat:reply', agent: agent.id, projectId: pid,
      message: `Architect rejected: ${review.feedback.slice(0, 120)}`,
      source: 'architect_typist',
    });
    return { outcome: 'needs-revision', plan, changes, feedback: review.feedback };
  }
}
