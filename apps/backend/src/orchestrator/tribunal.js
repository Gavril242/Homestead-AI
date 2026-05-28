// Tribunal Escalation — multi-agent automated root-cause analysis.
//
// Triggered when a task exhausts its MAX_AUTO_RETRIES budget.
// Three agents debate sequentially in a shared Aumovio thread to find
// root cause and produce a consensus approach before the human ever sees it.
//
// Flow:
//   1. Hunter   → diagnoses what failed and why (error artifacts + vault bugs)
//   2. Delphi   → reviews architecture assumptions (vault ADRs + REQ notes)
//   3. Forge    → proposes the new technical approach given the above context
//   4. Synthesis → merges into a consensus brief, writes vault note, requeues task
//
// If the tribunal itself fails (all LLM providers down), falls back to needs-human.

import { repo } from '../db.js';
import { callStructured, TribunalVerdictSchema, DelphiReviewSchema, ForgeProposalSchema } from '../llm/structured.js';
import { writeNote, readNote } from '../brain/vault.js';
import { getAgent } from './agents.js';
import { snapshotState } from '../brain/time-machine.js';
import path from 'node:path';

const TRIBUNAL_TIMEOUT_MS = 8 * 60_000; // 8 minutes for the whole tribunal

export async function runTribunal(failedTask, broadcast) {
  const task = repo.byId('tasks', failedTask.id) || failedTask;
  console.log(`[tribunal] starting for ${task.id}: "${task.title}"`);

  // Early exit: if the last artifacts show a successful run (exit 0 / SMOKE_OK),
  // the agent completed the work but forgot to call db_finish_task.
  // Mark done immediately — no need to debate a task that already succeeded.
  // BUT: skip this shortcut if the task has acceptance_commands (those must be run properly)
  // or if any shell output contains failure indicators.
  const hasAcceptanceGates = (task.acceptance_commands || []).length > 0 || (task.required_outputs || []).length > 0;
  const recentArtifacts = (task.artifacts || []).slice(-6);
  const failureIndicators = /\bFAIL\b|FAIL:|CHECK \d+ FAIL|delta=-\d|error:|CRITICAL/i;
  const lastShellOk = !hasAcceptanceGates && recentArtifacts.some((a) =>
    (a.tool === 'shell_exec' && (a.result?.exitCode === 0 || String(a.result?.stdout || '').includes('SMOKE_OK'))
      && !failureIndicators.test(String(a.result?.stdout || '') + String(a.result?.stderr || ''))) ||
    (a.summary && (a.summary.includes('exit 0') || a.summary.includes('SMOKE_OK'))
      && !failureIndicators.test(a.summary))
  );
  if (lastShellOk) {
    console.log(`[tribunal] ${task.id} — last artifacts show success, skipping tribunal and marking done`);
    repo.patch('tasks', task.id, {
      status: 'done',
      outcome: 'Task completed successfully (smoke/exit 0 detected). db_finish_task was not called — auto-closed by tribunal pre-check.',
      history: [...(task.history || []), { ts: Date.now(), kind: 'auto-closed', by: 'tribunal', note: 'last artifacts showed successful exit — skipped tribunal' }],
    });
    broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
    return;
  }

  // Mark task as in-tribunal
  repo.patch('tasks', task.id, {
    status: 'tribunal',
    tribunalStarted: Date.now(),
    history: [...(task.history || []), { ts: Date.now(), kind: 'tribunal', by: 'system', note: 'max retries exhausted — tribunal convened' }],
  });
  broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });

  const project = repo.byId('projects', task.project_id);
  const allArtifacts = (task.artifacts || []).map(a =>
    `[${a.tool}] ${a.summary || JSON.stringify(a.result || {}).slice(0, 200)}`
  ).slice(-20).join('\n');

  const errorHistory = (task.history || [])
    .filter(h => h.kind === 'failed')
    .map(h => `Attempt ${h.note}`)
    .join('\n') || 'No error history recorded';

  const reqNote = task.parent_req ? readNote(`projects/${task.project_id}/reqs/${task.parent_req}.md`) : null;
  const reqContext = reqNote ? `\n### Requirement\n${reqNote.body?.slice(0, 600) || ''}` : '';
  const archNote = readNote(`projects/${task.project_id}/architecture.md`);
  const archContext = archNote ? `\n### Architecture\n${archNote.body?.slice(0, 800) || ''}` : '';

  const sharedContext = `
## TRIBUNAL: Task "${task.title}" (${task.id})

### What failed:
${errorHistory}

### Last agent artifacts (tool calls):
${allArtifacts || '(none recorded)'}

### Task description as originally written:
${task.desc || '(no description)'}
${reqContext}
${archContext}
`.trim();

  // ── Step 1: Hunter diagnosis ────────────────────────────────────────────────

  let hunterData = null;
  let hunterDiagnosis = '';
  try {
    const hunterPrompt = `${sharedContext}

You are Hunter, the Debugger. Analyze the failure above.

Identify the root cause, error type (logic-bug | missing-context | wrong-approach | flawed-requirement | environment-issue | resource-limit), the key evidence as a single descriptive string, the suspect area (file or system component), and whether the issue is fixable.`;

    const hunterResult = await Promise.race([
      callStructured(TribunalVerdictSchema, hunterPrompt, {
        tier: 'strong',
        agent: 'hunter',
        purpose: 'classify',
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Hunter timeout')), 90_000)),
    ]);
    hunterData = hunterResult.data;
    hunterDiagnosis = JSON.stringify(hunterData);
    console.log(`[tribunal] Hunter diagnosis: rootCause="${hunterData.rootCause}" errorType="${hunterData.errorType}"`);
  } catch (err) {
    console.warn(`[tribunal] Hunter step failed: ${err.message}`);
    hunterData = { rootCause: err.message, errorType: 'environment-issue', evidence: '', suspectArea: 'unknown', fixable: false };
    hunterDiagnosis = JSON.stringify(hunterData);
  }

  // ── Step 2: Delphi architecture review ─────────────────────────────────────

  let delphiData = null;
  let delphiReview = '';
  try {
    const delphiPrompt = `${sharedContext}

Hunter's diagnosis:
${hunterDiagnosis}

You are Delphi, the Architect. Review the design assumptions given the above failure context.

Determine whether the design was fundamentally flawed, list any flawed assumptions, describe the correct technical approach in one paragraph, and note whether an Architecture Decision Record is required.`;

    const delphiResult = await Promise.race([
      callStructured(DelphiReviewSchema, delphiPrompt, {
        tier: 'strong',
        agent: 'delphi',
        purpose: 'plan',
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Delphi timeout')), 90_000)),
    ]);
    delphiData = delphiResult.data;
    delphiReview = JSON.stringify(delphiData);
    console.log(`[tribunal] Delphi review: designFlawed=${delphiData.designFlawed} adrRequired=${delphiData.adrRequired}`);
  } catch (err) {
    console.warn(`[tribunal] Delphi step failed: ${err.message}`);
    delphiData = { designFlawed: false, flawedAssumptions: [], suggestedApproach: 'Retry with a fresh start and explicit step-by-step plan.', adrRequired: false, adrTitle: '' };
    delphiReview = JSON.stringify(delphiData);
  }

  // ── Step 3: Forge new approach ──────────────────────────────────────────────

  let forgeData = null;
  let forgeProposal = '';
  try {
    const forgePrompt = `${sharedContext}

Hunter's diagnosis:
${hunterDiagnosis}

Delphi's architecture review:
${delphiReview}

You are Forge, the Engineer. Given the diagnosis and the architectural guidance, propose a concrete new implementation plan.

Provide a full rewritten task description (2-5 paragraphs, very explicit step-by-step), a list of key changes, test criteria for verification, and a confidence score between 0 and 1.`;

    const forgeResult = await Promise.race([
      callStructured(ForgeProposalSchema, forgePrompt, {
        tier: 'strong',
        agent: 'forge',
        purpose: 'plan',
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Forge timeout')), 90_000)),
    ]);
    forgeData = forgeResult.data;
    forgeProposal = JSON.stringify(forgeData);
    console.log(`[tribunal] Forge proposal: confidence=${forgeData.confidence} keyChanges=${forgeData.keyChanges?.length}`);
  } catch (err) {
    console.warn(`[tribunal] Forge step failed: ${err.message}`);
    // Forge timed out — synthesize a fallback from Delphi's guidance so the task
    // still gets requeued with actionable direction instead of escalating to human.
    if (delphiData?.suggestedApproach) {
      forgeData = {
        newTaskDescription: `${delphiData.suggestedApproach}\n\nRoot cause (Hunter): ${hunterData?.rootCause || 'unknown'} — ${hunterData?.evidence || ''}\nSuspect area: ${hunterData?.suspectArea || 'unknown'}\n\nRetry with the above approach. Be explicit about each step.`,
        keyChanges: [`Fix: ${hunterData?.suspectArea || 'see Hunter diagnosis'}`],
        testCriteria: ['Task completes without error', 'No loop detection triggered'],
        confidence: 0.6,
      };
      forgeProposal = JSON.stringify(forgeData);
      console.log(`[tribunal] Forge fallback built from Delphi guidance (confidence: 0.6)`);
    } else {
      forgeData = null;
      forgeProposal = '';
    }
  }

  // ── Step 4: Apply consensus and requeue ────────────────────────────────────

  const consensus = forgeData;

  // Write tribunal vault note regardless of outcome
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  try {
    writeNote(`projects/${task.project_id}/runs/tribunal-${task.id}-${ts}.md`, {
      frontmatter: {
        id: `tribunal-${task.id}`,
        kind: 'tribunal',
        project: task.project_id,
        task: task.id,
        title: `Tribunal: ${task.title}`,
        'created-at': new Date().toISOString(),
      },
      body: `## Tribunal Report\n\nTask: **${task.title}** (${task.id})\nConvened: ${new Date().toISOString()}\n\n### Hunter's Diagnosis\n\`\`\`json\n${hunterDiagnosis}\n\`\`\`\n\n### Delphi's Architecture Review\n\`\`\`json\n${delphiReview}\n\`\`\`\n\n### Forge's Proposal\n\`\`\`json\n${forgeProposal}\n\`\`\`\n`,
    });
  } catch (err) {
    console.warn(`[tribunal] vault write failed: ${err.message}`);
  }

  if (consensus?.newTaskDescription && consensus.confidence > 0.5) {
    // Requeue with new brief
    repo.patch('tasks', task.id, {
      status: 'queued',
      desc: `[TRIBUNAL CONSENSUS]\n\n${consensus.newTaskDescription}\n\n---\nKey changes: ${(consensus.keyChanges || []).join(', ')}\nTest criteria: ${(consensus.testCriteria || []).join(', ')}`,
      attempts: 1,          // Start at 1 (not 0) — preserves retry budget instead of infinite loop
      stirred: false,       // D4: allow stir loop to fire again if tribunal-requeued task stalls
      feedback_requeue: true,
      tribunalConsensus: {
        hunterDiagnosis: hunterDiagnosis.slice(0, 500),
        delphiReview: delphiReview.slice(0, 500),
        forgeConfidence: consensus.confidence,
        ts: Date.now(),
      },
      history: [...((repo.byId('tasks', task.id)?.history) || []), {
        ts: Date.now(), kind: 'tribunal-resolved', by: 'tribunal',
        note: `Consensus reached (confidence: ${consensus.confidence}). Task requeued with new brief.`,
      }],
    });
    broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
    console.log(`[tribunal] ${task.id} → consensus reached (confidence: ${consensus.confidence}) — requeued`);
  } else {
    // No consensus — check tribunal count before escalating
    const currentTask = repo.byId('tasks', task.id) || task;
    const tribunalCount = (currentTask.tribunalCount || 0) + 1;
    repo.patch('tasks', task.id, { tribunalCount });

    if (tribunalCount >= 3) {
      // Third tribunal failure — restore state to prevent further damage
      console.warn(`[tribunal] ${task.id} → triple tribunal failure (count: ${tribunalCount}) — triggering system restore`);
      try {
        const { restoreState } = await import('../brain/time-machine.js');
        await restoreState(5, { taskId: task.id });
        broadcast?.({ kind: 'system:restore', reason: 'Triple tribunal failure', taskId: task.id });
      } catch (restoreErr) {
        console.error(`[tribunal] system restore failed: ${restoreErr.message}`);
      }
      return;
    }

    // No consensus — spawn a Conductor rescue task instead of needs-human.
    // Import spawnRescueTask dynamically to avoid circular dependency.
    try {
      const { spawnRescueTask } = await import('./task-runner.js');
      const freshTask = repo.byId('tasks', task.id) || task;
      spawnRescueTask(freshTask, `Tribunal could not reach consensus. See vault: runs/tribunal-${task.id}-${ts}.md`, broadcast);
      console.log(`[tribunal] ${task.id} → no consensus — rescue dispatched`);
    } catch (rescueErr) {
      console.error(`[tribunal] rescue spawn failed: ${rescueErr.message} — falling back to needs-human`);
      repo.patch('tasks', task.id, {
        status: 'needs-human',
        error: `Tribunal failed and rescue spawn also failed: ${rescueErr.message}`,
        history: [...((repo.byId('tasks', task.id)?.history) || []), {
          ts: Date.now(), kind: 'tribunal-failed', by: 'tribunal',
          note: 'No consensus and rescue failed — escalated to human',
        }],
      });
      broadcast?.({ kind: 'task:update', task: repo.byId('tasks', task.id) });
    }
  }
}
