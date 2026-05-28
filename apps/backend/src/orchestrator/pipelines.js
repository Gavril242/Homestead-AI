// Pipelines = fixed orderings of agent steps that move work from
// "raw requirement" to "shipped + audited". They are NOT autonomous —
// every pipeline has explicit `human-gate` steps so a reviewer must
// approve before a state transition.
//
// Each step writes a vault note (`runs/pipeline-<id>-<step>.md`) so
// nothing is lost in chat. That's the anti-hallucination contract:
// the audit trail is on disk, not in an LLM's context window.

import { repo } from '../db.js';
import { chat } from '../llm/index.js';
import { getAgent } from './agents.js';
import { writeNote } from '../brain/vault.js';

function normalizePipelineStep(step, pipelineId, index) {
  if (!step || typeof step !== 'object') {
    throw new Error(`invalid pipeline step at ${pipelineId}[${index}]`);
  }

  const normalizedStep = String(step.step || '').trim();
  if (!normalizedStep) {
    throw new Error(`missing step name at ${pipelineId}[${index}]`);
  }

  if (step.gate) {
    return Object.freeze({
      step: normalizedStep,
      gate: String(step.gate).trim(),
    });
  }

  if (!step.agent || !step.tier || !step.purpose) {
    throw new Error(`pipeline step ${pipelineId}.${normalizedStep} must define agent, tier, and purpose`);
  }

  return Object.freeze({
    step: normalizedStep,
    agent: String(step.agent).trim(),
    tier: String(step.tier).trim(),
    purpose: String(step.purpose).trim(),
  });
}

function buildPipelineRegistry(definitions) {
  const registry = {};

  for (const [key, definition] of Object.entries(definitions)) {
    const id = String(definition?.id || key).trim();
    const name = String(definition?.name || '').trim();
    const description = String(definition?.description || '').trim();
    const steps = Array.isArray(definition?.steps)
      ? definition.steps.map((step, index) => normalizePipelineStep(step, id, index))
      : [];

    if (!id || !name || !description || steps.length === 0) {
      throw new Error(`invalid pipeline definition: ${key}`);
    }

    const gateCount = steps.filter((step) => step.gate).length;
    const uniqueAgents = [...new Set(steps.filter((step) => step.agent).map((step) => step.agent))];

    registry[id] = Object.freeze({
      id,
      name,
      description,
      steps,
      gateCount,
      agentCount: uniqueAgents.length,
      agents: uniqueAgents,
      requiresApproval: gateCount > 0,
    });
  }

  return Object.freeze(registry);
}

export function listPipelineDefs() {
  return Object.values(PIPELINES).map(({ id, name, description, steps, gateCount, agentCount, agents, requiresApproval }) => ({
    id,
    name,
    description,
    steps,
    gateCount,
    agentCount,
    agents,
    requiresApproval,
  }));
}

// Library of pipelines. Add to this when a new flow stabilizes.
const RAW_PIPELINES = {
  feature: {
    id: 'feature', name: 'Feature → ship',
    description: 'Requirement → architecture → code → tests → integrate → review.',
    steps: [
      { step: 'analyze',      agent: 'aria',      tier: 'weak',   purpose: 'normalize-req' },
      { step: 'architect',    agent: 'delphi',    tier: 'strong', purpose: 'design-interface' },
      { step: 'split-tasks',  agent: 'conductor', tier: 'weak',   purpose: 'plan-sprint' },
      { step: 'human-gate',   gate: 'plan-approval' },
      { step: 'implement',    agent: 'forge',     tier: 'strong', purpose: 'edit-code' },
      { step: 'test',         agent: 'vince',     tier: 'weak',   purpose: 'run-tests' },
      { step: 'integrate',    agent: 'ingo',      tier: 'weak',   purpose: 'kick-pipeline' },
      { step: 'document',     agent: 'scribe',    tier: 'weak',   purpose: 'write-adr' },
      { step: 'human-gate',   gate: 'final-review' },
    ],
  },
  bugfix: {
    id: 'bugfix', name: 'Bug → fix',
    description: 'Reproduce, isolate, patch, re-test, document.',
    steps: [
      { step: 'reproduce',  agent: 'hunter', tier: 'strong', purpose: 'repro-bug' },
      { step: 'isolate',    agent: 'hunter', tier: 'strong', purpose: 'isolate-bug' },
      { step: 'patch',      agent: 'forge',  tier: 'strong', purpose: 'minimal-fix' },
      { step: 'verify',     agent: 'vince',  tier: 'weak',   purpose: 'rerun-failing' },
      { step: 'human-gate', gate: 'fix-review' },
      { step: 'document',   agent: 'scribe', tier: 'weak',   purpose: 'postmortem' },
    ],
  },
};

export const PIPELINES = buildPipelineRegistry(RAW_PIPELINES);

// Kick a pipeline. `payload` carries the input (a req, a bug, a free-text goal).
// We write a row to db.pipelines and start firing steps. The function returns
// immediately with the pipeline id; live progress goes over the WebSocket.
export async function startPipeline({ pipelineId, projectId, payload, broadcast }) {
  const def = PIPELINES[pipelineId];
  if (!def) throw new Error(`unknown pipeline: ${pipelineId}`);

  const id = `pipe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const row = {
    id, name: def.name, project_id: projectId,
    pipeline: pipelineId,
    status: 'running', current_step: def.steps[0].step,
    payload, steps: [], created_at: Date.now(),
  };
  repo.upsert('pipelines', row);
  broadcast?.({ kind: 'pipeline:start', pipeline: row });

  // Fire-and-forget: progress runs async, broadcasts as it goes.
  runSteps(row, def, broadcast).catch((err) => {
    repo.patch('pipelines', id, { status: 'failed', error: err.message });
    broadcast?.({ kind: 'pipeline:error', id, error: err.message });
  });

  return row;
}

async function runSteps(row, def, broadcast) {
  for (const step of def.steps) {
    repo.patch('pipelines', row.id, { current_step: step.step });
    broadcast?.({ kind: 'pipeline:step', id: row.id, step: step.step });

    if (step.gate) {
      // Human gate — pause. The frontend POST /api/pipelines/:id/approve resumes.
      repo.patch('pipelines', row.id, { status: 'awaiting-human', gate: step.gate });
      broadcast?.({ kind: 'pipeline:gate', id: row.id, gate: step.gate });
      return;          // resume on approval
    }

    const agent = getAgent(step.agent);
    const sys = agent.systemPrompt({ project: { name: row.payload?.projectName || 'Afeela SHM' }, openTasks: '?', openBugs: '?' });
    const userMsg = renderStepPrompt(step, row.payload);
    const { reply, provider, model } = await chat({
      messages: [{ role: 'user', content: userMsg }],
      system: sys, tier: step.tier, agent: step.agent, purpose: step.purpose,
    });

    // Persist the step output to vault so it survives chat clearing.
    const notePath = `runs/pipe-${row.id}-${step.step}.md`;
    writeNote(notePath, {
      frontmatter: {
        id: `${row.id}-${step.step}`,
        title: `${def.name} · ${step.step}`,
        agent: step.agent, provider, model, tier: step.tier,
        pipeline: row.id, ts: new Date().toISOString(),
        links: [row.payload?.linkBack].filter(Boolean),
      },
      body: `## Prompt\n\n${userMsg}\n\n## Reply\n\n${reply}\n`,
    });

    const stepRow = { step: step.step, agent: step.agent, provider, ts: Date.now(), notePath };
    row.steps.push(stepRow);
    repo.patch('pipelines', row.id, { steps: row.steps });
    broadcast?.({ kind: 'pipeline:reply', id: row.id, step: step.step, agent: step.agent, reply, provider });

    // brief pace so the UI streams smoothly; not throttling the LLM.
    await new Promise((r) => setTimeout(r, 250));
  }

  repo.patch('pipelines', row.id, { status: 'done', current_step: null });
  broadcast?.({ kind: 'pipeline:done', id: row.id });
}

export async function approveGate({ pipelineId, broadcast }) {
  const row = repo.byId('pipelines', pipelineId);
  if (!row) throw new Error('pipeline not found');
  const def = PIPELINES[row.pipeline];
  // Resume after the gate that's currently blocking.
  const remaining = def.steps.slice(def.steps.findIndex((s) => s.gate === row.gate) + 1);
  repo.patch('pipelines', pipelineId, { status: 'running', gate: null });
  broadcast?.({ kind: 'pipeline:resume', id: pipelineId });
  runSteps({ ...row, steps: row.steps || [] }, { ...def, steps: remaining }, broadcast)
    .catch((err) => repo.patch('pipelines', pipelineId, { status: 'failed', error: err.message }));
  return repo.byId('pipelines', pipelineId);
}

function renderStepPrompt(step, payload) {
  const goal = payload?.goal || payload?.title || '(no goal supplied)';
  const ctx = payload?.context ? `\n\nContext:\n${payload.context}` : '';
  return `Step: ${step.step}\nGoal: ${goal}${ctx}\n\nProduce the step output as if you were ${step.agent}. Keep it focused; the next agent will pick it up.`;
}
