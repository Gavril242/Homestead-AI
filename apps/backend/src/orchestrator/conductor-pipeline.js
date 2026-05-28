// Conductor Pipeline — deterministic task decomposition.
//
// Replaces the "conductor agent in a 24-round loop" pattern with a
// 2-step LLM pipeline that is structurally incapable of producing 0 tasks.
//
// Flow:
//   1. DECOMPOSE — VIO (GPT-5-chat / gpt5-high), json_object mode
//      → { summary, techStack, tasks[{title, agent, description, acceptanceCriteria, requiredOutputs, verificationMode, dependsOn}] }
//   2. PERSIST   — pure code, 0 LLM calls
//      → vault architecture.md + DB task rows
//
// Token cost: ~3-6k total (vs 200k+ for conductor agent task)

import { repo } from '../db.js';
import { writeNote, readNote } from '../brain/vault.js';
import { buildPool, pickProviders, recordUsage } from '../llm/pool.js';
import { getAtlassianSummary } from '../tools/atlassian-doc-engine.js';
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';
import { loadSkills } from './skills.js';
import { createMission, getMissionSummaryById } from '../services/mission-contract.js';
import { buildPresetBlock, inferGates } from './decomposition-presets.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const vioAgent = new UndiciAgent({ connect: { rejectUnauthorized: false } });

const AGENT_ROSTER = `
conductor🎼  scrum master — orchestration, planning, health reviews
forge🛠       lead engineer — ALL code, scripts, DB migrations, shell runs
aria📋        requirements analyst — REQ-* with testable acceptance criteria
delphi🏛      architect — ADRs, PlantUML, architecture.md
vince🔧       test engineer — runs tests, files bugs when things break
hunter🔎      debugger — repro bugs, root cause, minimal patch proposals
scribe📚      vault keeper — docs, runbooks, post-mortems
william🎨     UI/UX — ReactBits patterns, animations, glassmorphism, frontend polish
max⚙         DevOps — Docker, CI/CD, nginx, pm2, deploy scripts
iris🔐        security — OWASP, npm audit, secrets detection
sage🧠        ML/Data — Python, pandas, sklearn, LLM pipelines
pixel🖥       visual QA — Playwright, screenshots, accessibility
`.trim();

const TASK_SCHEMA = {
  type: 'object',
  required: ['title', 'agent', 'description', 'acceptanceCriteria'],
  properties: {
    title:             { type: 'string', description: 'Short specific task name (60 chars max)' },
    agent:             { type: 'string', description: 'Agent id (forge/vince/william/max/iris/sage/pixel/aria/delphi/scribe/hunter)' },
    description:       { type: 'string', description: 'Full task spec: exact files to create/modify, function signatures, tech decisions, constraints. MUST be actionable without additional context.' },
    acceptanceCriteria:{ type: 'string', description: 'Executable acceptance test: shell command that must exit 0 to prove the task is done. E.g.: ```node -e "import(\'./src/x.js\').then(m => { if (!m.foo) throw new Error(\'missing\') })"```' },
    requiredOutputs:   { type: 'array', items: { type: 'string' }, description: 'Files, docs, reports, or artifacts that must exist when the task is complete.' },
    verificationMode:  { type: 'string', description: 'commands, manual, or hybrid. Use commands when acceptanceCriteria is sufficient.' },
    dependsOn:         { type: 'array', items: { type: 'string' }, description: 'Titles of tasks this one must wait for (exact match from this list)' },
    priority:          { type: 'number', description: '1=high 2=med 3=low' },
  },
};

const DECOMPOSE_SCHEMA = {
  type: 'object',
  required: ['summary', 'tasks'],
  properties: {
    summary:   { type: 'string', description: 'One paragraph: what will be built, what tech stack, key architecture decisions' },
    techStack: { type: 'string', description: 'Comma-separated: e.g. "Node.js ESM, React UMD CDN, no bundler, cheerio"' },
    tasks: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: TASK_SCHEMA,
    },
  },
};

function estimateTokens(str) {
  return Math.ceil((str || '').length / 4);
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function normalizeAcceptanceCommands(rawTask) {
  return normalizeStringList(rawTask.acceptanceCommands ?? rawTask.acceptanceCriteria);
}

function normalizeVerificationMode(rawTask, acceptanceCommands) {
  const rawMode = String(rawTask.verificationMode || '').trim().toLowerCase();
  if (['commands', 'manual', 'hybrid', 'auto'].includes(rawMode)) {
    return rawMode;
  }
  return acceptanceCommands.length ? 'commands' : 'manual';
}

function buildTaskDescription(rawTask, acceptanceCommands, requiredOutputs) {
  const sections = [String(rawTask.description || '').trim()].filter(Boolean);

  if (acceptanceCommands.length) {
    sections.push(`ACCEPTANCE COMMANDS:\n${acceptanceCommands.map((cmd) => `- ${cmd}`).join('\n')}`);
  }

  if (requiredOutputs.length) {
    sections.push(`REQUIRED OUTPUTS:\n${requiredOutputs.map((item) => `- ${item}`).join('\n')}`);
  }

  return sections.join('\n\n');
}

// ── Try VIO models that support json_object response_format ──────────
async function callWithJsonSchema(prompt, schema, label) {
  const POOL = buildPool();
  // Prefer GPT-5-chat or gpt5-high for structure — very reliable JSON mode
  const jsonCapable = POOL.filter((p) =>
    p.kind === 'aumovio' &&
    ['gpt5-chat', 'gpt5-high', 'gpt5-medium', 'gpt4o'].some((s) => p.id.includes(s))
  );
  // Fallback to any aumovio provider
  const candidates = jsonCapable.length ? jsonCapable : POOL.filter((p) => p.kind === 'aumovio');

  const errors = [];
  for (const p of candidates.slice(0, 4)) {
    try {
      const body = {
        model: p.model,
        messages: [
          { role: 'system', content: 'You are a precise task planner. Respond ONLY with valid JSON matching the provided schema. No markdown, no explanation.' },
          { role: 'user',   content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
      };

      const res = await undiciFetch(`${p.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${p.key}` },
        body: JSON.stringify(body),
        dispatcher: vioAgent,
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        errors.push(`${p.id}: ${res.status} ${txt.slice(0, 100)}`);
        continue;
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || '';
      recordUsage({
        provider: p.id, model: p.model, tier: 'strong', purpose: label,
        prompt_tokens: data.usage?.prompt_tokens || estimateTokens(prompt),
        output_tokens: data.usage?.completion_tokens || estimateTokens(content),
      });

      const parsed = JSON.parse(content);
      if (label === 'decompose' && (!parsed.tasks || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0)) {
        errors.push(`${p.id}: returned 0 tasks — retrying with next provider`);
        continue;
      }
      console.log(`[conductor-pipeline] ${label} via ${p.id}: ${parsed.tasks?.length || 1} items`);
      return parsed;

    } catch (err) {
      errors.push(`${p.id}: ${err.message}`);
    }
  }

  // Fallback: try Gemini 2.5 Pro with strong JSON instruction
  const gemPro = POOL.filter((p) => p.kind === 'gemini' && p.id.includes('gemini-pro'));
  for (const p of gemPro.slice(0, 2)) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${p.model}:generateContent?key=${p.key}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: 'Return ONLY valid JSON. No markdown.' }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 4096, responseMimeType: 'application/json' },
        }),
      });
      if (!res.ok) { errors.push(`${p.id}: ${res.status}`); continue; }
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const parsed = JSON.parse(text.replace(/^```json?\n?/, '').replace(/```$/, ''));
      if (label === 'decompose' && (!parsed.tasks?.length)) continue;
      return parsed;
    } catch (err) {
      errors.push(`${p.id}: ${err.message}`);
    }
  }

  throw new Error(`[conductor-pipeline] all providers failed for ${label}: ${errors.join(' | ')}`);
}

// ── Main pipeline ─────────────────────────────────────────────────────

export async function conductorPipeline(projectId, goal, { broadcast, draftOnly = false } = {}) {
  const project = repo.byId('projects', projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);

  console.log(`[conductor-pipeline] ${projectId} — goal: "${goal?.slice(0, 80)}"`);

  // Gather context from DB (no LLM needed for discovery)
  const existingTasks = repo.list('tasks').filter((t) => t.project_id === projectId);
  const existingReqs  = repo.list('reqs').filter((r) => r.project_id === projectId);
  const activeTasks   = existingTasks.filter((t) => ['queued', 'running'].includes(t.status));

  // Read architecture if exists
  let archNote = '';
  try {
    const n = readNote(`projects/${projectId}/architecture.md`);
    if (n) archNote = `\nEXISTING ARCHITECTURE:\n${(n.body || '').slice(0, 800)}`;
  } catch { /* new project */ }

  // Atlassian integration context (if enabled)
  let atlassianCtx = '';
  try {
    const summary = getAtlassianSummary(project);
    if (summary) atlassianCtx = `\n${summary}`;
  } catch { /* non-fatal */ }

  // Check workspace structure (first level only)
  let wsTree = '';
  try {
    const wsPath = path.join(os.homedir(), 'gavirila-workspaces', projectId);
    if (fs.existsSync(wsPath)) {
      wsTree = fs.readdirSync(wsPath).slice(0, 20).join(', ');
    }
  } catch { /* ignore */ }

  // Build DECOMPOSE prompt
  const decomposePrompt = `
PROJECT: ${project.name} (id: ${projectId})
WORKSPACE ROOT: ~/gavirila-workspaces/${projectId}/
${wsTree ? `EXISTING FILES: ${wsTree}` : 'WORKSPACE: empty'}
${archNote}
${atlassianCtx}

GOAL: ${goal}

AGENT ROSTER:
${AGENT_ROSTER}

ACTIVE TASKS ALREADY QUEUED (do NOT duplicate these):
${activeTasks.length ? activeTasks.map((t) => `  • [${t.by}] ${t.title}`).join('\n') : '  (none)'}

REQUIREMENTS ALREADY DEFINED:
${existingReqs.length ? existingReqs.map((r) => `  • ${r.id}: ${r.title}`).join('\n') : '  (none)'}

CRITICAL RULES FOR TASKS:
1. Each task description must be FULLY ACTIONABLE — include exact file paths, function signatures,
   npm packages, and tech decisions. The agent reads ONLY this description.
2. acceptanceCriteria must be a shell command that proves completion (must exit 0).
3. dependsOn must be exact title matches from your task list.
4. Assign implementation to forge, tests to vince, UI to william, infra to max.
5. Architecture decisions: ALWAYS specify React UMD CDN (no bundler) for browser apps.
   NEVER use TypeScript for frontend code served without a build step.
6. MAX 7 tasks. Focus. Don't spawn tasks for things that can be done in 1.
7. For WEB PROJECTS: ALWAYS include a final "Ship & Verify" task (assigned to max or forge)
   that starts the server with shell_bg and verifies it responds on a port with curl.
   The website MUST be accessible at the end. Include "npm install" in scaffold tasks.
8. For DOCUMENTATION: If Atlassian integration is enabled, ALWAYS include a Scribe task to:
   - Create Confluence space (create_confluence_space + seed_confluence_pages)
   - Push project docs to Confluence (push_all_docs_to_confluence)
   - Create Jira issues from requirements (create_jira_issue for each REQ)
9. HANDOFF CONTEXT: Every task description must mention what artifacts the previous task
   produces, so the agent knows what to look for (file paths, REQ IDs, vault notes).
10. PERSISTENT SERVERS: Task descriptions for server-related work MUST specify:
    "Use shell_bg (NOT shell_exec) for persistent servers — shell_exec blocks forever."

AVAILABLE SKILL IDs (agents auto-load matching skills based on task description — write clear
descriptions mentioning the domain and the right skill context will be injected automatically):
${loadSkills().map(s => `- ${s.id}: ${s.trigger}`).join('\n')}
${buildPresetBlock(projectId, goal)}

Return JSON matching this schema:
${JSON.stringify(DECOMPOSE_SCHEMA, null, 2)}
`.trim();

  // DECOMPOSE — structured LLM call
  let plan;
  try {
    plan = await callWithJsonSchema(decomposePrompt, DECOMPOSE_SCHEMA, 'decompose');
  } catch (err) {
    console.error(`[conductor-pipeline] decompose failed: ${err.message}`);
    throw err;
  }

  const tasks = plan.tasks || [];
  if (!tasks.length) throw new Error('[conductor-pipeline] decompose returned 0 tasks');

  // POST-DECOMPOSE: Auto-infer acceptance gates for tasks missing them
  inferGates(tasks, projectId);

  if (draftOnly) {
    try {
      writeNote(`projects/${projectId}/plans/draft-${Date.now().toString(36)}.md`, {
        frontmatter: { kind: 'plan-draft', project: projectId, ts: new Date().toISOString(), goal },
        body: `# Draft Plan\n\n**Goal:** ${goal}\n\n**Summary:** ${plan.summary || ''}\n\n**Tech Stack:** ${plan.techStack || 'see tasks'}\n\n## Proposed Tasks\n\n${tasks.map((task) => {
          const acceptanceCommands = normalizeAcceptanceCommands(task);
          const requiredOutputs = normalizeStringList(task.requiredOutputs);
          const dependsOn = normalizeStringList(task.dependsOn);
          const verificationMode = normalizeVerificationMode(task, acceptanceCommands);
          return `### ${task.title} → ${task.agent || 'forge'}\n${buildTaskDescription(task, acceptanceCommands, requiredOutputs)}\n\n**Verification:** ${verificationMode}\n\n**Depends on:** ${dependsOn.join(', ') || 'none'}\n`;
        }).join('\n')}`,
      });
    } catch (err) {
      console.warn(`[conductor-pipeline] draft vault write failed (non-fatal): ${err.message}`);
    }

    console.log(`[conductor-pipeline] draft only — planned ${tasks.length} tasks for ${projectId}`);
    return {
      draftOnly: true,
      summary: plan.summary || '',
      techStack: plan.techStack || '',
      tasksCreated: tasks.length,
      tasks: tasks.map((task) => {
        const acceptanceCommands = normalizeAcceptanceCommands(task);
        const requiredOutputs = normalizeStringList(task.requiredOutputs);
        return {
          title: task.title,
          by: task.agent || 'forge',
          desc: buildTaskDescription(task, acceptanceCommands, requiredOutputs),
          acceptance_commands: acceptanceCommands,
          required_outputs: requiredOutputs,
          verification_mode: normalizeVerificationMode(task, acceptanceCommands),
          depends_on_titles: normalizeStringList(task.dependsOn),
        };
      }),
    };
  }

  // PERSIST — write architecture note + create tasks (pure code, no LLM)
  try {
    writeNote(`projects/${projectId}/architecture.md`, {
      frontmatter: { id: `${projectId}-arch`, kind: 'architecture', project: projectId, updated: new Date().toISOString() },
      body: `# ${project.name} — Architecture\n\n## Summary\n${plan.summary || ''}\n\n## Tech Stack\n${plan.techStack || 'See tasks'}\n\n## Goal\n${goal}\n`,
    });
  } catch (err) {
    console.warn(`[conductor-pipeline] vault write failed (non-fatal): ${err.message}`);
  }

  // Build title → taskId map for dependsOn resolution
  const titleToId = {};
  const createdTasks = [];

  // Link tasks back to requirements — extract REQ-* ids from the goal string
  const goalReqIds = (goal.match(/REQ-[A-Z0-9-]+/g) || []);
  // If goal mentions a single req, all tasks get that parent_req.
  // If multiple, distribute by best-match (first wins for now).
  const defaultParentReq = goalReqIds.length === 1 ? goalReqIds[0]
    : goalReqIds.length > 0 ? goalReqIds[0]
    : (existingReqs.length === 1 ? existingReqs[0].id : null);

  for (const t of tasks) {
    const id = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    titleToId[t.title] = id;
    const acceptanceCommands = normalizeAcceptanceCommands(t);
    const requiredOutputs = normalizeStringList(t.requiredOutputs);
    const verificationMode = normalizeVerificationMode(t, acceptanceCommands);

    const row = {
      id,
      project_id: projectId,
      title: t.title,
      desc: buildTaskDescription(t, acceptanceCommands, requiredOutputs),
      by: t.agent || 'forge',
      tag: 'task',
      status: 'queued',
      priority: t.priority || 2,
      depends_on: [], // filled in second pass
      parent_req: defaultParentReq,
      acceptance_commands: acceptanceCommands,
      verification_mode: verificationMode,
      required_outputs: requiredOutputs,
      evidence_requirements: requiredOutputs,
      artifacts: [],
      comments: [],
      history: [{ ts: Date.now(), kind: 'created', by: 'conductor-pipeline', note: `auto-created from goal: "${goal?.slice(0, 80)}"` }],
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    repo.upsert('tasks', row);
    createdTasks.push({ row, rawTask: t, acceptanceCommands, requiredOutputs, verificationMode });

    // Broadcast immediately so the board updates
    broadcast?.({ kind: 'task:create', task: row });
  }

  // Second pass: resolve dependsOn (titles → ids)
  for (const { row, rawTask } of createdTasks) {
    const deps = (rawTask.dependsOn || [])
      .map((title) => titleToId[title])
      .filter(Boolean);

    if (deps.length) {
      repo.patch('tasks', row.id, { depends_on: deps });
    }
  }

  // B1-01: Create Mission Contract — immutable record linking goal → tasks → outputs
  let mission = null;
  let missionSummary = null;
  try {
    mission = createMission({
      projectId,
      goal,
      plan,
      createdTasks,
    });
    missionSummary = getMissionSummaryById(mission.id);
    if (missionSummary) {
      broadcast?.({ kind: 'mission:start', mission: missionSummary });
    }
    console.log(`[conductor-pipeline] mission contract created: ${mission.id} (${createdTasks.length} tasks)`);
  } catch (err) {
    console.warn(`[conductor-pipeline] mission creation failed (non-fatal): ${err.message}`);
  }

  // Write plan vault note
  try {
    writeNote(`projects/${projectId}/plans/pipeline-${Date.now().toString(36)}.md`, {
      frontmatter: { kind: 'plan', project: projectId, ts: new Date().toISOString(), goal },
      body: `# Plan\n\n**Goal:** ${goal}\n\n**Summary:** ${plan.summary}\n\n**Tech Stack:** ${plan.techStack || 'see tasks'}\n\n## Tasks\n\n${createdTasks.map(({ row, rawTask, acceptanceCommands, requiredOutputs, verificationMode }) => `### ${row.title} → ${row.by}\n${rawTask.description}\n\n**Verification:** ${verificationMode}\n\n**Acceptance:** ${acceptanceCommands.length ? acceptanceCommands.map((cmd) => `\`${cmd}\``).join(', ') : 'manual review'}\n\n**Required outputs:** ${requiredOutputs.length ? requiredOutputs.join(', ') : 'none specified'}\n`).join('\n')}`,
    });
  } catch (err) {
    console.warn(`[conductor-pipeline] plan vault write failed (non-fatal): ${err.message}`);
  }

  console.log(`[conductor-pipeline] done — created ${createdTasks.length} tasks for ${projectId}`);
  return {
    missionId: mission?.id || null,
    mission: missionSummary,
    tasksCreated: createdTasks.length,
    tasks: createdTasks.map(({ row }) => row),
  };
}
