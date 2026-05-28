// Pure ESM. Tracks per-agent task outcomes and periodically rewrites system prompts using an LLM.
// Uses file-based storage at data/prompt-metrics/{agentId}.json so it doesn't depend on
// a 'kv' table that isn't in the DB schema.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNote, writeNote } from './vault.js';
import { chat } from '../llm/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const METRICS_DIR = path.resolve(__dirname, '..', '..', 'data', 'prompt-metrics');

const OPTIMIZE_AFTER = 20; // run optimizer after every 20 outcomes per agent

function ensureMetricsDir() {
  if (!fs.existsSync(METRICS_DIR)) fs.mkdirSync(METRICS_DIR, { recursive: true });
}

function loadMetrics(agentId) {
  ensureMetricsDir();
  const file = path.join(METRICS_DIR, `${agentId}.json`);
  if (!fs.existsSync(file)) return { agentId, outcomes: [], version: 0 };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { agentId, outcomes: [], version: 0 };
  }
}

function saveMetrics(agentId, metrics) {
  ensureMetricsDir();
  const file = path.join(METRICS_DIR, `${agentId}.json`);
  fs.writeFileSync(file, JSON.stringify(metrics, null, 2));
}

// Record an outcome. Called from task-runner after a task ends.
export function recordOutcome(agentId, { success, errorPattern, taskDesc }) {
  const metrics = loadMetrics(agentId);
  metrics.outcomes.push({
    ts: new Date().toISOString(),
    success,
    errorPattern: errorPattern || null,
    taskDesc: (taskDesc || '').slice(0, 200),
  });
  // Keep last 100 outcomes
  if (metrics.outcomes.length > 100) metrics.outcomes = metrics.outcomes.slice(-100);
  saveMetrics(agentId, metrics);

  // Check if we should optimize
  const since = metrics.version * OPTIMIZE_AFTER;
  if (metrics.outcomes.length - since >= OPTIMIZE_AFTER) {
    optimizePrompt(agentId, metrics).catch((e) =>
      console.error('[prompt-optimizer]', e.message)
    );
  }
}

// Get the (possibly optimized) system prompt for an agent.
// Returns null if no optimized prompt exists yet.
export function getOptimizedPrompt(agentId) {
  try {
    const note = readNote(`agents/${agentId}/optimized-prompt.md`);
    if (!note) return null;
    const body = (note.body || '').trim();
    return body || null;
  } catch {
    return null;
  }
}

async function optimizePrompt(agentId, metrics) {
  const { getAgent } = await import('../orchestrator/agents.js');
  const agent = getAgent(agentId);
  if (!agent) return;

  const recentOutcomes = metrics.outcomes.slice(-OPTIMIZE_AFTER);
  const failures = recentOutcomes.filter((o) => !o.success);
  const successRate = (
    ((recentOutcomes.length - failures.length) / recentOutcomes.length) *
    100
  ).toFixed(0);

  if (failures.length === 0) {
    console.log(
      `[prompt-optimizer] ${agentId} 100% success — no optimization needed`
    );
    return;
  }

  const failureSummary = failures
    .map((f) => `- Task: "${f.taskDesc}" | Error: "${f.errorPattern || 'unknown'}"`)
    .join('\n');

  // Build a static version of the base system prompt (no project context available here)
  let baseSystem = '';
  try {
    baseSystem = agent.systemPrompt({ project: { name: 'the project', id: 'proj' }, openTasks: 0, openBugs: 0, reqs: [], bugs: [], tasks: [] });
  } catch {
    baseSystem = agent.sub || `${agent.name} — ${agent.role}`;
  }

  const optimizerPrompt = `You are a prompt engineer. You will rewrite an AI agent's system prompt to fix recurring failure patterns.

AGENT: ${agentId} (${agent.name})
CURRENT SUCCESS RATE: ${successRate}% over last ${recentOutcomes.length} tasks

RECURRING FAILURES:
${failureSummary}

CURRENT SYSTEM PROMPT:
${baseSystem.slice(0, 3000)}

TASK: Rewrite the system prompt to prevent the above failures. Rules:
- Keep the same role, personality, and tool usage instructions
- Add specific guidance to prevent the failure patterns above
- Do NOT add more than 200 words to the prompt
- Return ONLY the new system prompt, no explanation, no markdown fences`;

  console.log(
    `[prompt-optimizer] Optimizing ${agentId} prompt (${failures.length}/${recentOutcomes.length} failures)...`
  );

  const result = await chat({
    system: 'You are a prompt engineering expert. Return only the optimized system prompt text.',
    messages: [{ role: 'user', content: optimizerPrompt }],
    purpose: 'classify',
    tier: 'weak',
    toolScopes: [],
  });

  if (!result?.reply || result.reply.length < 100) {
    console.warn(
      '[prompt-optimizer] Optimizer returned empty/short response, skipping'
    );
    return;
  }

  writeNote(`agents/${agentId}/optimized-prompt.md`, {
    frontmatter: {
      agent: agentId,
      version: String(metrics.version + 1),
      'success-rate-before': `${successRate}%`,
      'optimized-at': new Date().toISOString(),
    },
    body: result.reply,
  });

  metrics.version += 1;
  saveMetrics(agentId, metrics);

  console.log(
    `[prompt-optimizer] Saved optimized prompt for ${agentId} (v${metrics.version})`
  );
}
