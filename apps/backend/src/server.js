// Gavirila Homestead — backend.
//
// Single Node 18+ process: Express HTTP for REST, ws for live updates,
// JSON file for persistence, Markdown vault for the Obsidian brain,
// LLM router for the agent chat. Static frontend served at /.

import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { transformAsync } from '@babel/core';
import crypto from 'node:crypto';

import { load, save, repo } from './db.js';
import { bulkSyncJiraProject, bulkSyncConfluenceSpace, ingestJiraIssue, listJiraProjects, listConfluenceSpaces, syncTaskToJira } from './tools/atlassian-etl.js';
import { provisionAtlassianForProject } from './tools/atlassian-provisioner.js';
import { pushAllDocs, scheduleDocSync, stopDocSync, getAtlassianSummary } from './tools/atlassian-doc-engine.js';
import { AGENTS, getAgent, listAgents } from './orchestrator/agents.js';
import { chat, getPool } from './llm/index.js';
import { poolSnapshot } from './llm/pool.js';
import { ensureVault, listNotes, readNote, writeNote, buildGraph, impactOf, parseNote, vaultRoot } from './brain/vault.js';
import { PIPELINES, listPipelineDefs, startPipeline } from './orchestrator/pipelines.js';
import { startTaskRunner } from './orchestrator/task-runner.js';
import { startConductorSupervisor, runConductorSupervisorPass } from './orchestrator/conductor-supervisor.js';
import { conductorPipeline } from './orchestrator/conductor-pipeline.js';
import { getMissionSummaryById, listMissionSummaries } from './services/mission-contract.js';
import { seedAfeelaShm } from './seed/afeela-shm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(__dirname, '..', '..', 'frontend');
const PORT = Number(process.env.PORT || 8765);

// ── global error guards — prevent a single async throw from killing the process ─
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION] — background task threw, process kept alive:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION] — keeping process alive:', err);
});

// ── boot: load DB, init vault ────────────────────────────────
load();
ensureVault();

// Demo seeding is now optional. Call /api/seed to load the Afeela SHM demo.
console.log('[boot] Database loaded.');

const app = express();
app.use(express.json({ limit: '2mb' }));

// CORS — the frontend is served from the same origin, but if a dev
// points a different port at us we want it to just work.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── health & seeding ────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    ok: true, version: '0.6.0', node: process.version,
    pool: poolSnapshot(getPool()),
    seededAt: load().meta.seededAt,
  });
});

app.post('/api/seed', (req, res) => {
  const result = seedAfeelaShm({ force: true });
  save();
  res.json({ success: true, result });
});

// ── bootstrap: everything the FE needs on first paint ───────────────
//
// Project isolation: every list of project-scoped data (tasks, reqs, bugs)
// is filtered to the requested projectId. If the FE doesn't pick one we
// just return empty lists — there is no hidden default project anymore.
app.get('/api/state', (req, res) => {
  const projectId = req.query.project || null; // no default
  res.json({
    projectId,
    projects:    repo.list('projects'),
    agents:      listAgents().map(({ id, name, role, emoji, tier, tools, sub, toolScopes }) => ({ id, name, role, emoji, tier, tools, sub, toolScopes })),
    tasks:       projectId ? repo.list('tasks').filter((t) => t.project_id === projectId) : [],
    events:      repo.list('events'),
    reqs:        projectId ? repo.list('reqs').filter((r) => r.project_id === projectId) : [],
    runs:        projectId ? repo.list('runs').filter((r) => !r.project_id || r.project_id === projectId) : [],
    bugs:        projectId ? repo.list('bugs').filter((b) => b.project_id === projectId) : [],
    connectors:  repo.list('connectors'),
    pipelines:   repo.list('pipelines').slice(0, 25),
    pipelineDefs: listPipelineDefs(),
    pool:        poolSnapshot(getPool()),
    welcome:     !load().meta.welcomeDismissed,
  });
});

app.post('/api/welcome/dismiss', (req, res) => {
  const s = load();
  s.meta.welcomeDismissed = true;
  save();
  res.json({ ok: true });
});

// ── tasks (kanban) ──────────────────────────────────────────────────

// Debounce map: projectId → timer — prevents flooding Confluence on rapid task updates
const _docSyncDebounce = new Map();
function triggerDocSyncForProject(projectId) {
  if (_docSyncDebounce.has(projectId)) clearTimeout(_docSyncDebounce.get(projectId));
  const timer = setTimeout(async () => {
    _docSyncDebounce.delete(projectId);
    const project = repo.byId('projects', projectId);
    if (!project?.integrations?.atlassian?.enabled) return;
    pushAllDocs(project).catch(err => console.warn(`[doc-engine] deferred sync ${projectId}: ${err.message}`));
  }, 30000); // 30s debounce — batches rapid task completions
  _docSyncDebounce.set(projectId, timer);
}

app.patch('/api/tasks/:id', (req, res) => {
  const updated = repo.patch('tasks', req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'task not found' });
  broadcast({ kind: 'task:update', task: updated });
  // When a task is marked done, schedule a deferred Confluence doc sync
  if (updated.project_id && ['done', 'completed'].includes((req.body?.status || '').toLowerCase())) {
    triggerDocSyncForProject(updated.project_id);
  }
  // Sync Jira status if task has a jira_key and project has Jira enabled
  if (updated.jira_key && req.body?.status) {
    const _proj = repo.byId('projects', updated.project_id);
    if (_proj?.integrations?.atlassian?.enabled) {
      syncTaskToJira(_proj, updated)
        .catch((err) => console.warn(`[jira] status sync failed for ${updated.jira_key}: ${err.message}`));
    }
  }
  res.json(updated);
});

app.post('/api/tasks', (req, res) => {
  const t = req.body || {};
  if (!t.project_id) {
    return res.status(400).json({ error: 'project_id is required — pick a project before posting a task' });
  }
  if (!repo.byId('projects', t.project_id)) {
    return res.status(400).json({ error: `unknown project_id: ${t.project_id}` });
  }
  const id = t.id || `c-${Date.now().toString(36)}`;
  const acceptanceCommands = Array.isArray(t.acceptance_commands)
    ? t.acceptance_commands.filter((cmd) => typeof cmd === 'string' && cmd.trim())
    : [];
  const requiredOutputs = Array.isArray(t.required_outputs)
    ? t.required_outputs.filter((item) => typeof item === 'string' && item.trim())
    : Array.isArray(t.evidence_requirements)
      ? t.evidence_requirements.filter((item) => typeof item === 'string' && item.trim())
      : [];
  const row = {
    id, project_id: t.project_id,
    title: t.title || 'untitled', by: t.by || 'Aria',
    tag: t.tag || 'task', status: t.status || 'queued',
    since: 'just now', desc: t.desc || '', parent_req: t.parent_req,
    created_at: Date.now(), updated_at: Date.now(),
    acceptance_commands: acceptanceCommands,
    verification_mode: t.verification_mode || (acceptanceCommands.length ? 'commands' : 'manual'),
    required_outputs: requiredOutputs,
    evidence_requirements: requiredOutputs,
    comments: [],            // human or agent comments on this task
    history: [{ ts: Date.now(), kind: 'created', by: t.created_by || 'human', note: 'task posted' }],
  };
  repo.upsert('tasks', row);
  broadcast({ kind: 'task:create', task: row });

  // Auto-push to Jira if project has Jira enabled and autoSync is on (opt-in per project)
  const _proj = repo.byId('projects', t.project_id);
  if (_proj?.integrations?.atlassian?.enabled && _proj?.integrations?.atlassian?.autoSyncTasks) {
    syncTaskToJira(_proj, row)
      .then((r) => {
        if (r.ok && r.key) {
          const fresh = repo.byId('tasks', row.id);
          if (fresh) broadcast({ kind: 'task:update', task: fresh });
          console.log(`[jira] task ${row.id} → ${r.key}`);
        }
      })
      .catch((err) => console.warn(`[jira] auto-sync failed for ${row.id}: ${err.message}`));
  }

  res.json(row);
});

// ── task detail (single source of truth for the ticket panel) ──────
app.get('/api/tasks/:id', (req, res) => {
  const t = repo.byId('tasks', req.params.id);
  if (!t) return res.status(404).json({ error: 'task not found' });
  res.json(t);
});

// ── append a comment (human or agent) to a task ────────────────────
//
// Smart re-queue policy:
//   running          → just inject (continuation mission picks it up live)
//   queued           → just append
//   review/failed/needs-human → re-queue with feedback_requeue=true so the
//                     runner uses a continuation brief instead of a fresh start
app.post('/api/tasks/:id/comments', (req, res) => {
  const t = repo.byId('tasks', req.params.id);
  if (!t) return res.status(404).json({ error: 'task not found' });
  const { text, by } = req.body || {};
  if (!text) return res.status(400).json({ error: 'empty comment' });

  const comment  = { ts: Date.now(), by: by || 'human', text };
  const comments = [...(t.comments || []), comment];
  const history  = [...(t.history  || []), { ts: Date.now(), kind: 'comment', by: comment.by, note: text.slice(0, 120) }];

  let nextStatus     = t.status;
  let feedbackRequeue = t.feedback_requeue || false;

  const isHuman    = by !== 'agent';
  const needsRetry = ['review', 'failed', 'needs-human', 'needs-info'].includes(t.status);

  if (isHuman && needsRetry) {
    nextStatus      = 'queued';
    feedbackRequeue = true; // runner will use continuation brief, not fresh start
    history.push({ ts: Date.now(), kind: 'requeued', by: 'human-feedback',
      note: 'human feedback — resuming with context intact' });
  }

  const updated = repo.patch('tasks', req.params.id, { comments, history, status: nextStatus, feedback_requeue: feedbackRequeue });
  broadcast({ kind: 'task:update', task: updated });
  res.json(updated);
});

// Task actions: retry, cancel, audit
app.post('/api/tasks/:id/retry', (req, res) => {
  const t = repo.byId('tasks', req.params.id);
  if (!t) return res.status(404).json({ error: 'task not found' });
  const history = [...(t.history || []), { ts: Date.now(), kind: 'requeued', by: 'human', note: 'manual retry' }];
  const updated = repo.patch('tasks', req.params.id, { status: 'queued', error: null, attempts: 0, feedback_requeue: false, history });
  broadcast({ kind: 'task:update', task: updated });
  res.json(updated);
});

app.post('/api/tasks/:id/cancel', (req, res) => {
  const t = repo.byId('tasks', req.params.id);
  if (!t) return res.status(404).json({ error: 'task not found' });
  const history = [...(t.history || []), { ts: Date.now(), kind: 'cancelled', by: 'human', note: 'cancelled by user' }];
  const updated = repo.patch('tasks', req.params.id, { status: 'cancelled', history });
  broadcast({ kind: 'task:update', task: updated });
  res.json(updated);
});

app.post('/api/tasks/:id/audit', async (req, res) => {
  const t = repo.byId('tasks', req.params.id);
  if (!t) return res.status(404).json({ error: 'task not found' });
  const acceptance = t.acceptance || [];
  if (!acceptance.length) return res.status(400).json({ error: 'no acceptance criteria to audit' });

  try {
    const prompt = `Task: ${t.title}\nStatus: ${t.status}\nOutcome: ${t.outcome || '(none)'}\n\nAcceptance criteria:\n${acceptance.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n\nFor each criterion, respond PASS or FAIL with a one-sentence reason. Be strict.`;
    const { reply, provider } = await chat({
      messages: [{ role: 'user', content: prompt }],
      tier: 'weak', purpose: 'chat', agent: 'audit',
    });
    const history = [...(t.history || []), { ts: Date.now(), kind: 'audited', by: 'audit-bot', note: reply.slice(0, 200) }];
    const updated = repo.patch('tasks', req.params.id, { audit: { ts: Date.now(), result: reply, provider }, history });
    broadcast({ kind: 'task:update', task: updated });
    res.json({ task: updated, audit: reply, provider });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Gates: per-project feature flags / pipeline gates
const _gates = new Map(); // projectId -> Map<name, { name, open, updatedAt }>

app.get('/api/projects/:id/gates', (req, res) => {
  const gates = [...(_gates.get(req.params.id) || new Map()).values()];
  res.json({ gates });
});

app.post('/api/projects/:id/gates/:name', (req, res) => {
  if (!repo.byId('projects', req.params.id)) return res.status(404).json({ error: 'project not found' });
  const proj = _gates.get(req.params.id) || new Map();
  const existing = proj.get(req.params.name) || { name: req.params.name, open: false };
  const updated = { ...existing, open: req.body?.open ?? !existing.open, updatedAt: Date.now() };
  proj.set(req.params.name, updated);
  _gates.set(req.params.id, proj);
  broadcast({ kind: 'gate:update', projectId: req.params.id, gate: updated });
  res.json(updated);
});

// Project budget placeholder
app.get('/api/projects/:id/budget', (req, res) => {
  const p = repo.byId('projects', req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const tasks = repo.list('tasks').filter((t) => t.project_id === req.params.id);
  const usage = repo.list('llm_usage') || [];
  const projectUsage = usage.filter((u) => u.projectId === req.params.id);
  const totalTokens = projectUsage.reduce((s, u) => s + (u.total_tokens || 0), 0);
  res.json({ projectId: req.params.id, totalTokens, taskCount: tasks.length, budget: null });
});

// B1-04: Truthful status service — single source for human-facing state summaries
import { computeProjectStatus } from './services/status-service.js';
app.get('/api/projects/:id/status', (req, res) => {
  const p = repo.byId('projects', req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  res.json(computeProjectStatus(req.params.id));
});

// B4-01/02: Mission dashboard + recovery actions
import { computeMissionDashboard, getRecoveryActions, executeRecoveryAction } from './services/mission-dashboard.js';
app.get('/api/projects/:id/dashboard', (req, res) => {
  const p = repo.byId('projects', req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  res.json(computeMissionDashboard(req.params.id));
});
app.get('/api/tasks/:id/recovery-actions', (req, res) => {
  const actions = getRecoveryActions(req.params.id);
  res.json({ taskId: req.params.id, actions });
});
app.post('/api/tasks/:id/recover', (req, res) => {
  const { action, payload } = req.body || {};
  if (!action) return res.status(400).json({ error: 'action is required' });
  const result = executeRecoveryAction(req.params.id, action, payload || {});
  if (result.success) {
    broadcast?.({ kind: 'task:update', task: repo.byId('tasks', req.params.id) });
  }
  res.status(result.success ? 200 : 400).json(result);
});

// B4-03: Input contract assistant
import { analyzeInput, enrichGoal } from './services/input-assistant.js';
app.post('/api/analyze-input', (req, res) => {
  const { goal } = req.body || {};
  if (!goal) return res.status(400).json({ error: 'goal is required' });
  res.json(analyzeInput(goal));
});

// B5-01: SLO and Error Budget Framework
import { computeSloMetrics, evaluateSlos, generateWeeklyReport, listReports, computeBurnRate } from './services/slo-framework.js';
app.get('/api/projects/:id/slo', (req, res) => {
  const p = repo.byId('projects', req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  res.json(evaluateSlos(req.params.id));
});
app.get('/api/projects/:id/slo/metrics', (req, res) => {
  const p = repo.byId('projects', req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  res.json(computeSloMetrics(req.params.id));
});
app.get('/api/projects/:id/slo/burn-rate', (req, res) => {
  const p = repo.byId('projects', req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  res.json(computeBurnRate(req.params.id));
});
app.post('/api/projects/:id/slo/report', (req, res) => {
  const p = repo.byId('projects', req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  res.json(generateWeeklyReport(req.params.id));
});
app.get('/api/projects/:id/slo/reports', (req, res) => {
  const p = repo.byId('projects', req.params.id);
  if (!p) return res.status(404).json({ error: 'project not found' });
  res.json(listReports(req.params.id));
});

// B5-02: Incidents and Postmortems
import { createIncident, updateIncident, listIncidents, createPostmortem, getPostmortem, getOverduePostmortems } from './services/incident-postmortem.js';
app.get('/api/incidents', (req, res) => {
  const { projectId, status, severity } = req.query;
  res.json(listIncidents({ projectId, status, severity }));
});
app.post('/api/incidents', (req, res) => {
  try {
    const incident = createIncident(req.body);
    res.status(201).json(incident);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.patch('/api/incidents/:id', (req, res) => {
  try {
    const incident = updateIncident(req.params.id, req.body);
    res.json(incident);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/incidents/:id/postmortem', (req, res) => {
  try {
    const pm = createPostmortem(req.params.id, req.body);
    res.status(201).json(pm);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.get('/api/incidents/:id/postmortem', (req, res) => {
  const pm = getPostmortem(req.params.id);
  if (!pm) return res.status(404).json({ error: 'postmortem not found' });
  res.json(pm);
});
app.get('/api/incidents/overdue', (req, res) => {
  res.json(getOverduePostmortems());
});

// B5-03: Change Risk Gates
import { assessRisk, gateCheck, startCanary, checkCanary, promoteCanary } from './services/change-risk-gates.js';
app.post('/api/risk/assess', (req, res) => {
  res.json(assessRisk(req.body));
});
app.post('/api/risk/gate-check', (req, res) => {
  const result = gateCheck(req.body);
  res.status(result.allowed ? 200 : 403).json(result);
});
app.post('/api/risk/canary/start', (req, res) => {
  const { changeId, projectId, baselineMetrics } = req.body;
  res.json(startCanary(changeId, projectId, baselineMetrics));
});
app.post('/api/risk/canary/check', (req, res) => {
  const { changeId, currentMetrics } = req.body;
  res.json(checkCanary(changeId, currentMetrics));
});
app.post('/api/risk/canary/promote', (req, res) => {
  const { changeId } = req.body;
  const ok = promoteCanary(changeId);
  res.status(ok ? 200 : 400).json({ promoted: ok });
});

// B5-04: Decision Ledger
import { getTaskDecisions, getProjectDecisions, explainDecision, getLedgerStats, cleanupLedger } from './services/decision-ledger.js';
app.get('/api/decisions/task/:id', (req, res) => {
  res.json(getTaskDecisions(req.params.id));
});
app.get('/api/projects/:id/decisions', (req, res) => {
  const { since, until, type } = req.query;
  res.json(getProjectDecisions(req.params.id, {
    since: since ? Number(since) : undefined,
    until: until ? Number(until) : undefined,
    type,
  }));
});
app.get('/api/decisions/:id/explain', (req, res) => {
  const explanation = explainDecision(req.params.id);
  if (!explanation) return res.status(404).json({ error: 'decision not found' });
  res.json(explanation);
});
app.get('/api/decisions/stats', (req, res) => {
  res.json(getLedgerStats());
});
app.post('/api/decisions/cleanup', (req, res) => {
  const removed = cleanupLedger();
  res.json({ removed, message: `Cleaned up ${removed} expired ledger files` });
});

// ── agents, tools + chat ───────────────────────────────────────────────────
import { createAgent } from './orchestrator/agents.js';
import { TOOLS, initMcpTools } from './tools/registry.js';

app.get('/api/tools', (req, res) => {
  // Strip out the execute function before sending to client
  res.json(TOOLS.map(({ name, description, category, parameters }) => ({ name, description, category, parameters })));
});

app.get('/api/agents', (req, res) => {
  res.json(listAgents().map(({ id, name, role, emoji, tier, tools, sub }) => ({ id, name, role, emoji, tier, tools, sub })));
});

app.post('/api/agents', (req, res) => {
  try {
    const agent = createAgent(req.body);
    broadcast({ kind: 'agent:create', agent });
    res.json(agent);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/agents/:id/messages', (req, res) => {
  const projectId = req.query.projectId;
  if (!projectId) return res.status(400).json({ error: 'projectId is required' });
  const chatKey = `${projectId}:${req.params.id}`;
  const all = repo.chatFor(chatKey);
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const messages = all.slice(-limit);
  res.json({ agent: req.params.id, projectId, messages, total: all.length, hasMore: all.length > limit });
});

app.post('/api/agents/:id/messages', async (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'agent not found' });
  const text = (req.body?.text || '').slice(0, 8000);
  if (!text) return res.status(400).json({ error: 'empty message' });

  // Project isolation: every chat must specify a project. Without one the
  // agent has no workspace to operate in and would leak across projects.
  const projectId = req.body?.projectId;
  if (!projectId) {
    return res.status(400).json({ error: 'projectId is required — agents always operate inside one project workspace' });
  }
  const project = repo.byId('projects', projectId);
  if (!project) {
    return res.status(400).json({ error: `unknown project: ${projectId}` });
  }

  // Per-project chat history key so cross-project memory doesn't bleed.
  const chatKey = `${projectId}:${agent.id}`;

  // user msg → memory
  const userMsg = { id: `u-${Date.now()}`, role: 'user', text, ts: Date.now(), projectId };
  repo.appendChat(chatKey, userMsg);
  broadcast({ kind: 'chat:user', agent: agent.id, projectId, message: userMsg });

  // build enriched context for the system prompt — real project data
  const allTasks = repo.list('tasks').filter((t) => t.project_id === projectId);
  const allBugs = repo.list('bugs').filter((b) => b.project_id === projectId);
  const allReqs = repo.list('reqs').filter((r) => r.project_id === projectId);
  const openTasks = allTasks.filter((t) => t.status !== 'done').length;
  const openBugs = allBugs.filter((b) => b.status !== 'closed').length;
  const doneTasks = allTasks.filter((t) => t.status === 'done').length;

  // For direct human chat we use a short, action-oriented prompt.
  // The task-execution prompt has "YOU MUST CALL TOOLS / text-only ignored" which
  // causes models to return empty content when chatting with humans.
  //
  // Conductor gets orchestration tools in direct chat so it can launch a
  // persistent mission and keep the user-facing conversation natural.
  // Other agents stay tool-free (tools caused empty responses for simple Q&A agents).
  // Register workspace override so exec_fs tools resolve to the right path in chat
  if (project.workspace) setWorkspaceOverride(projectId, project.workspace);

  const isConductor = agent.id === 'conductor';
  const chatToolScopes = isConductor ? ['missions', 'db_tasks', 'db_reqs', 'vault_read', 'exec_fs'] : [];

  const system = [
    `You are ${agent.emoji} ${agent.name} — ${agent.role}.`,
    `Project: ${project.name} (${projectId})`,
    `Status: ${openTasks} open tasks, ${doneTasks} done, ${openBugs} open bugs, ${allReqs.length} reqs.`,
    openTasks > 0 ? `Open tasks: ${allTasks.filter(t=>t.status!=='done').slice(0,8).map(t=>`[${t.status}] ${t.title}`).join(' | ')}` : '',
    allReqs.length > 0 ? `Requirements: ${allReqs.slice(0,5).map(r=>`${r.id}: ${r.title}`).join(' | ')}` : '',
    '',
    isConductor ? `You are in DIRECT CHAT with the user. You are the orchestrator, not the coder. Use mission tools to kick off background work while keeping the conversation natural.
RULES:
  - If the user asks you to fix, convert, build, analyze, validate, check, or otherwise execute work, call db_start_mission immediately. Preserve exact filenames, paths, and constraints in the goal.
  - If the user explicitly wants only ticket reshaping or dependency changes, use db_create_task / db_update_task instead of launching a mission.
  - If the user asks what is in flight or what you already came up with, call db_list_missions unless the answer is already obvious from context.
  - You may inspect files with fs tools for quick context, but do not turn into a code-writing agent.
  - Keep responses to 4 lines max. After starting a mission, state the mission ID, the goal, and the primary delegated work. Never claim you already executed the fix yourself.` :
    `You are in DIRECT CHAT with the user. Be concise and helpful. Answer from context first.`,
    'Never return an empty response.',
  ].filter(Boolean).join('\n');

  // last 8 turns of history for context (project-scoped)
  const history = repo.chatFor(chatKey).slice(-9, -1)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.text }));

  try {
    const { reply, provider, model, tier, toolCalls } = await chat({
      messages: [...history, { role: 'user', content: text }],
      system, tier: agent.tier, agent: agent.id, purpose: 'agent-chat',
      toolScopes: chatToolScopes,
      toolCtx: { repo, broadcast, agentId: agent.id, projectId },
    });
    const aMsg = {
      id: `a-${Date.now()}`, role: 'assistant', text: reply,
      provider, model, tier, ts: Date.now(), projectId,
      tools: (toolCalls || []).map((tc) => `${tc.name}(${Object.keys(tc.args || {}).join(', ')})`),
      toolCalls: toolCalls || [],
    };
    repo.appendChat(chatKey, aMsg);
    broadcast({ kind: 'chat:reply', agent: agent.id, projectId, message: aMsg, source: 'user_chat' });

    // Persist this agent's memory note PER PROJECT — no cross-project bleed.
    const chatLog = repo.chatFor(chatKey).slice(-30).map((m) => `**${m.role}**: ${m.text}`).join('\n\n');
    writeNote(`agents/${projectId}/${agent.id}.md`, {
      frontmatter: { id: `${projectId}:${agent.id}`, type: 'agent-memory', role: agent.role, emoji: agent.emoji, project: projectId },
      body: `# ${agent.name} — memory in ${project.name}\n\n## Recent chat\n\n${chatLog}`,
    });

    res.json({ message: aMsg });
  } catch (err) {
    console.error('[chat error]', agent.id, err);
    res.status(500).json({ error: err.message });
  }
});

// ── LLM pool inspector ─────────────────────────────────────────────
app.get('/api/llm/pool', (req, res) => {
  res.json({ pool: poolSnapshot(getPool()), usage: load().llm_usage.slice(0, 50) });
});

// ── pipelines (the orchestrated AI flows) ───────────────────────────
app.get('/api/pipelines', (req, res) => {
  res.json({
    defs: listPipelineDefs(),
    runs: repo.list('pipelines').slice(0, 50),
  });
});

app.get('/api/pipelines/:id', (req, res) => {
  const row = repo.byId('pipelines', req.params.id);
  if (!row) return res.status(404).json({ error: 'pipeline not found' });
  res.json(row);
});

app.post('/api/pipelines/start', async (req, res) => {
  try {
    const { pipelineId, projectId, payload } = req.body || {};
    const row = await startPipeline({ pipelineId, projectId, payload, broadcast });
    res.json(row);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/pipelines/:id/approve', async (req, res) => {
  try {
    const row = await approveGate({ pipelineId: req.params.id, broadcast });
    res.json(row);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── traceability + Obsidian brain ──────────────────────────────────
app.get('/api/trace/:nodeId', (req, res) => {
  const nodeId = req.params.nodeId;
  const downstream = impactOf(nodeId, 4);
  const linksRow = load().links.filter((l) => l.from === nodeId || l.to === nodeId);
  res.json({ nodeId, downstream, links: linksRow });
});

app.get('/api/vault/files', (req, res) => {
  const subdir = req.query.subdir || '';
  res.json({ files: listNotes(subdir) });
});

app.get('/api/vault/records', (req, res) => {
  const projectId = req.query.project;
  const all = listNotes();
  // Include project-scoped paths + global knowledge sections (reqs, decisions, runs, bugs, tests)
  const GLOBAL = ['reqs/', 'decisions/', 'runs/', 'bugs/', 'tests/'];
  const scoped = projectId
    ? all.filter((rel) =>
        rel.startsWith(`projects/${projectId}/`) ||
        rel.startsWith(`agents/${projectId}/`) ||
        GLOBAL.some((s) => rel.startsWith(s))
      )
    : all;

  const records = [];
  for (const rel of scoped) {
    try {
      const root = vaultRoot();
      const raw = fs.readFileSync(path.join(root, rel), 'utf8');
      const { frontmatter } = parseNote(raw);
      records.push({
        path: rel,
        title: frontmatter.title || rel.split('/').pop().replace('.md', ''),
        type: frontmatter.type || rel.split('/')[0],
        id: frontmatter.id,
        size: raw.length,
      });
    } catch { /* skip */ }
  }
  res.json({ records });
});

// Sprint health + blockers for Record room
app.get('/api/records/mission', (req, res) => {
  const projectId = req.query.project;
  if (!projectId) return res.status(400).json({ error: 'project required' });

  const tasks = repo.list('tasks').filter((t) => t.project_id === projectId);

  const sprint = { total: tasks.length, done: 0, running: 0, queued: 0, blocked: 0, review: 0, cancelled: 0 };
  for (const t of tasks) {
    if (t.status === 'done') sprint.done++;
    else if (t.status === 'running') sprint.running++;
    else if (t.status === 'queued') sprint.queued++;
    else if (['needs-human', 'failed', 'tribunal'].includes(t.status)) sprint.blocked++;
    else if (t.status === 'review') sprint.review++;
    else if (t.status === 'cancelled') sprint.cancelled++;
  }

  const blockers = tasks
    .filter((t) => ['needs-human', 'failed', 'tribunal'].includes(t.status))
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
    .slice(0, 20)
    .map((t) => {
      const hist = t.history || [];
      const lastFail = [...hist].reverse().find((h) =>
        ['error', 'failed', 'escalated', 'tribunal'].includes(h.kind)
      );
      const lastHuman = [...(t.comments || [])].filter((c) => c.by !== 'agent').reverse()[0];
      return {
        id: t.id, title: t.title, status: t.status, by: t.by,
        attempts: t.attempts || 0,
        lastError: lastFail?.note || t.error || null,
        lastHumanComment: lastHuman?.text?.slice(0, 300) || null,
        age: Date.now() - (t.updated_at || t.created_at || 0),
        updated_at: t.updated_at || t.created_at || 0,
      };
    });

  const running = tasks
    .filter((t) => t.status === 'running')
    .map((t) => ({ id: t.id, title: t.title, by: t.by, attempts: t.attempts || 0, updated_at: t.updated_at }));

  const SIGNIFICANT = new Set(['tribunal', 'done', 'completed', 'escalated', 'requeued', 'cancelled', 'audited']);
  const significant = [];
  for (const t of tasks) {
    for (const h of (t.history || [])) {
      if (SIGNIFICANT.has(h.kind)) {
        significant.push({ taskId: t.id, title: t.title, by: t.by, kind: h.kind, note: (h.note || '').slice(0, 200), ts: h.ts });
      }
    }
  }
  significant.sort((a, b) => b.ts - a.ts);

  res.json({ sprint, blockers, running, significant: significant.slice(0, 40) });
});

app.get('/api/vault/note', (req, res) => {
  const note = readNote(req.query.path || '');
  if (!note) return res.status(404).json({ error: 'note not found' });
  res.json(note);
});

app.get('/api/vault/graph', (req, res) => {
  res.json(buildGraph());
});

// ── connectors ─────────────────────────────────────────────────────
app.get('/api/connectors', (req, res) => res.json(repo.list('connectors')));

app.patch('/api/connectors/:id', (req, res) => {
  const updated = repo.patch('connectors', req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'connector not found' });
  broadcast({ kind: 'connector:update', connector: updated });
  res.json(updated);
});

// ── cross-project manager chat ────────────────────────────────────
//
// A separate, project-less chat for asking about everything: which projects
// are running, where work is stuck, what to do next. The "manager" agent
// gets a snapshot of every project + open tasks/bugs, but does NOT have
// any execution tools — only read/listing, so it can't modify projects.
app.post('/api/manager/messages', async (req, res) => {
  const text = (req.body?.text || '').slice(0, 8000);
  if (!text) return res.status(400).json({ error: 'empty message' });

  const userMsg = { id: `u-${Date.now()}`, role: 'user', text, ts: Date.now() };
  repo.appendChat('manager', userMsg);
  broadcast({ kind: 'chat:user', agent: 'manager', message: userMsg });

  // Build the cross-project snapshot
  const projects = repo.list('projects');
  const allTasks = repo.list('tasks');
  const summary = projects.map((p) => {
    const ts = allTasks.filter((t) => t.project_id === p.id);
    const grouped = ts.reduce((acc, t) => { acc[t.status] = (acc[t.status] || 0) + 1; return acc; }, {});
    return `  • ${p.name} (${p.id}, ${p.template || 'custom'}): ` +
      `${ts.length} tasks — ${Object.entries(grouped).map(([k, v]) => `${k}:${v}`).join(', ') || 'none'}`;
  }).join('\n');

  const stuck = allTasks.filter((t) => t.status === 'needs-human').slice(0, 10);
  const failed = allTasks.filter((t) => t.status === 'failed').slice(0, 10);

  const system = `
You are the Manager — a read-only cross-project advisor.
Help the human understand status across all projects and decide what's next.
You have NO execution tools; just give a clear summary or recommendation.

PROJECTS:
${summary || '  (no projects yet — suggest creating one with a template)'}

${stuck.length ? `STUCK (needs-human):\n${stuck.map((t) => `  • ${t.id} in ${t.project_id}: ${t.title}`).join('\n')}\n` : ''}
${failed.length ? `FAILED:\n${failed.map((t) => `  • ${t.id} in ${t.project_id}: ${t.error || ''}`).join('\n')}\n` : ''}

Be concise. If you suggest action, say which project and which agent.`.trim();

  try {
    const history = repo.chatFor('manager').slice(-9, -1)
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.text }));

    const { reply, provider, model, tier } = await chat({
      messages: [...history, { role: 'user', content: text }],
      system, tier: 'strong', agent: 'manager', purpose: 'manager-chat',
      toolScopes: [],
    });

    const aMsg = { id: `a-${Date.now()}`, role: 'assistant', text: reply, provider, model, tier, ts: Date.now() };
    repo.appendChat('manager', aMsg);
    broadcast({ kind: 'chat:reply', agent: 'manager', message: aMsg });
    res.json({ message: aMsg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/manager/messages', (req, res) => {
  res.json({ agent: 'manager', messages: repo.chatFor('manager') });
});

// ── projects ──────────────────────────────────────────────────────
import { ensureWorkspace, getWorkspacePath, setWorkspaceOverride } from './tools/exec-tools.js';
import { spawnSync } from 'node:child_process';
import { TEMPLATES, listTemplates, getTemplate } from './seed/templates.js';

/**
 * Resolve the workspace path for a project, or send a 400 if none was provided.
 * Use the return value as a guard: `if (!ws) return;`.
 */
function ensureWorkspaceOrFail(projectId, res) {
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return null;
  }
  if (!repo.byId('projects', projectId)) {
    res.status(400).json({ error: `unknown project: ${projectId}` });
    return null;
  }
  return ensureWorkspace(projectId);
}

// List the available project templates so the FE can render the picker.
app.get('/api/templates', (req, res) => {
  res.json({ templates: listTemplates() });
});

// Create a project from a template.
//   POST /api/projects { name, description, template, methodology? }
//
// What this does:
//   1. Reserve the project id (slug of name) and persist it to the projects table.
//   2. Create the per-project workspace at ~/gavirila-workspaces/<id>/.
//   3. Run the template's `boot` hook (npm scaffolding, git init, README, etc.).
//   4. Lay down the template's seed vault notes under vault/projects/<id>/.
//   5. Insert the seed tasks into the kanban so agents have something to do.
app.post('/api/projects', async (req, res) => {
  const { name, description, template = 'blank', methodology, integrations, workspace } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!id) return res.status(400).json({ error: 'name produces an empty slug' });
  if (repo.byId('projects', id)) return res.status(409).json({ error: `project "${id}" already exists` });

  const tpl = getTemplate(template);
  if (!tpl) return res.status(400).json({ error: `unknown template: ${template}` });

  // 1. workspace — use custom path if provided, otherwise create one
  const wsPath = workspace && fs.existsSync(workspace) ? workspace : ensureWorkspace(id);

  // 2. boot the workspace from the template
  try {
    await tpl.boot(wsPath);
  } catch (err) {
    console.error('[projects] template boot failed:', err);
    return res.status(500).json({ error: `template boot failed: ${err.message}` });
  }

  // 3. persist project metadata
  const project = {
    id, name,
    sub: description || tpl.description,
    description: description || tpl.description,
    emoji: tpl.emoji,
    hue: Math.floor(Math.random() * 360),
    template: tpl.id,
    methodology: methodology || tpl.methodology,
    toolScopes: tpl.toolScopes,
    suggestedAgents: tpl.suggestedAgents,
    workspace: wsPath,
    created_at: Date.now(),
    ...(integrations ? { integrations } : {}),
  };
  repo.upsert('projects', project);

  // 4. seed vault + tasks for this project
  const seed = tpl.seed();
  for (const note of seed.vault || []) {
    writeNote(`projects/${id}/${note.path}`, {
      frontmatter: { ...note.frontmatter, project: id },
      body: note.body,
    });
  }

  // Auto-create architecture.md if the template didn't seed one — agents read this on every task start
  const archPath = `projects/${id}/architecture.md`;
  if (!readNote(archPath)) {
    writeNote(archPath, {
      frontmatter: { kind: 'architecture', project: id, title: 'Architecture Overview' },
      body: `# Architecture Overview — ${name}\n\n## Stack\n(to be filled in by Delphi or the first Forge task)\n\n## Conventions\n- Source: \`src/\`\n- Tests: \`tests/\`\n- Docs: \`docs/\`\n\n## Key Design Decisions\n(record ADRs here as they are made)\n`,
    });
  }
  for (const t of seed.tasks || []) {
    const taskRow = {
      id: `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      project_id: id,
      title: t.title, by: t.by, tag: t.tag || 'task', status: t.status || 'queued',
      since: 'just now', desc: t.desc || '', parent_req: t.parent_req,
      created_at: Date.now(), updated_at: Date.now(),
      comments: [],
      history: [{ ts: Date.now(), kind: 'created', by: 'template', note: 'seeded by template' }],
    };
    repo.upsert('tasks', taskRow);
  }

  const ev = { id: Date.now(), who: 'system', what: 'created project from template', obj: `${name} (${tpl.name})`, icon: 'check2', color: 'green' };
  repo.prepend('events', ev);
  broadcast({ kind: 'event:append', event: ev });
  broadcast({ kind: 'project:create', project });

  // Auto-provision Atlassian if requested — runs async so project creation responds immediately
  if (integrations?.atlassian?.provision === true) {
    const provisionOpts = {
      confluenceSpaceKey: integrations.atlassian.confluenceSpaceKey,
      jiraProjectKey: integrations.atlassian.jiraProjectKey,
      createJiraProject: integrations.atlassian.createJiraProject === true,
    };
    provisionAtlassianForProject(project, provisionOpts)
      .then(r => {
        const fresh = repo.byId('projects', id);
        if (fresh) broadcast({ kind: 'project:update', project: fresh });
        console.log(`[server] atlassian provision ${id}: ok=${r.ok}`);
        if (r.ok && r.integrations?.confluenceSpaceKey) {
          scheduleDocSync(fresh || project);
        }
      })
      .catch(err => console.error(`[server] atlassian provision ${id} failed: ${err.message}`));
  }

  res.json(project);
});

// ── Atlassian/GitHub integration routes ─────────────────────────────

// Global: list Jira projects (for project-creation UI picker)
app.get('/api/atlassian/jira-projects', async (req, res) => {
  if (!process.env.JIRA_BASE_URL || !process.env.JIRA_TOKEN) {
    return res.status(400).json({ error: 'Atlassian credentials not configured in .env' });
  }
  try {
    const projects = await listJiraProjects();
    res.json({ projects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Global: list Confluence spaces (for project-creation UI picker)
app.get('/api/atlassian/confluence-spaces', async (req, res) => {
  if (!process.env.JIRA_BASE_URL || !process.env.JIRA_TOKEN) {
    return res.status(400).json({ error: 'Atlassian credentials not configured in .env' });
  }
  try {
    const spaces = await listConfluenceSpaces();
    res.json({ spaces });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Push a specific task to Jira: POST /api/projects/:id/atlassian/push-task/:taskId
app.post('/api/projects/:id/atlassian/push-task/:taskId', async (req, res) => {
  const project = repo.byId('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'project not found' });
  if (!project.integrations?.atlassian?.enabled) {
    return res.status(400).json({ error: 'Atlassian not enabled for this project' });
  }
  const task = repo.byId('tasks', req.params.taskId);
  if (!task) return res.status(404).json({ error: 'task not found' });
  try {
    const result = await syncTaskToJira(project, task);
    // Broadcast updated task (now has jira_key)
    const fresh = repo.byId('tasks', task.id);
    if (fresh) broadcast({ kind: 'task:update', task: fresh });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Provision Atlassian for an existing project: POST /api/projects/:id/atlassian/provision
// Body: { confluenceSpaceKey?, jiraProjectKey?, createJiraProject? }
app.post('/api/projects/:id/atlassian/provision', async (req, res) => {
  const project = repo.byId('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'project not found' });
  if (!process.env.JIRA_BASE_URL || !process.env.JIRA_TOKEN) {
    return res.status(400).json({ error: 'Atlassian credentials not configured in .env' });
  }
  try {
    const result = await provisionAtlassianForProject(project, req.body || {});
    const fresh = repo.byId('projects', project.id);
    if (result.ok && fresh?.integrations?.atlassian?.confluenceSpaceKey) {
      scheduleDocSync(fresh);
      // Push initial docs right away
      pushAllDocs(fresh).catch(err => console.warn('[doc-engine] initial push:', err.message));
    }
    broadcast({ kind: 'project:update', project: fresh || project });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Push vault → Confluence: POST /api/projects/:id/atlassian/push-docs
app.post('/api/projects/:id/atlassian/push-docs', async (req, res) => {
  const project = repo.byId('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'project not found' });
  if (!project.integrations?.atlassian?.enabled) {
    return res.status(400).json({ error: 'Atlassian not enabled — call /atlassian/provision first' });
  }
  try {
    const results = await pushAllDocs(project);
    res.json({ ok: true, pages: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atlassian status: GET /api/projects/:id/atlassian/status
app.get('/api/projects/:id/atlassian/status', (req, res) => {
  const project = repo.byId('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'project not found' });
  const atl = project.integrations?.atlassian || {};
  const reqs = repo.list('reqs').filter(r => r.project_id === project.id);
  const tasks = repo.list('tasks').filter(t => t.project_id === project.id);
  res.json({
    enabled: atl.enabled || false,
    jiraProjectKey: atl.jiraProjectKey || null,
    confluenceSpaceKey: atl.confluenceSpaceKey || null,
    provisionedAt: atl.provisionedAt || null,
    lastDocSync: atl.lastDocSync || null,
    scheduledSync: _docSyncDebounce ? undefined : undefined, // placeholder
    stats: {
      jiraIssuesSynced: reqs.filter(r => r.source === 'jira').length,
      totalTasks: tasks.length,
      doneTasks: tasks.filter(t => t.status === 'done').length,
    },
    confluenceUrl: atl.confluenceSpaceKey
      ? `${process.env.CONFLUENCE_BASE_URL || process.env.JIRA_BASE_URL}/wiki/spaces/${atl.confluenceSpaceKey}`
      : null,
  });
});

// Manual full sync: POST /api/projects/:id/sync
app.post('/api/projects/:id/sync', async (req, res) => {
  const project = repo.byId('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'project not found' });
  if (!project.integrations?.atlassian?.enabled) {
    return res.status(400).json({ error: 'Atlassian integration not enabled for this project' });
  }
  try {
    const jira       = await bulkSyncJiraProject(project);
    const confluence = await bulkSyncConfluenceSpace(project);
    broadcast({ kind: 'vault:sync', projectId: project.id, jira: { synced: jira.synced, newCount: jira.newReqs?.length || 0, updatedCount: jira.updatedReqs?.length || 0 }, confluence });
    // Broadcast individual new/updated REQ events
    for (const req of jira.newReqs || []) broadcast({ kind: 'req:new', req, projectId: project.id });
    for (const req of jira.updatedReqs || []) broadcast({ kind: 'req:update', req, projectId: project.id });
    // After pulling from Jira/Confluence → vault, push updated docs back to Confluence
    pushAllDocs(project).catch(err => console.warn('[doc-engine] post-sync push:', err.message));
    res.json({ ok: true, jira: { synced: jira.synced, newCount: jira.newReqs?.length || 0, updatedCount: jira.updatedReqs?.length || 0, errors: jira.errors }, confluence });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Jira/Confluence webhook: POST /api/webhooks/atlassian
app.post('/api/webhooks/atlassian', async (req, res) => {
  // Verify webhook signature
  const secret = process.env.WEBHOOK_SECRET_ATLASSIAN || process.env.WEBHOOK_SECRET;
  if (secret) {
    const sig = req.headers['x-hub-signature-256'] || req.headers['x-atlassian-webhook-signature'] || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(JSON.stringify(req.body)).digest('hex');
    if (sig !== expected) {
      console.warn('[webhook] signature mismatch — rejecting');
      return res.status(403).json({ error: 'invalid webhook signature' });
    }
  }
  const issue = req.body?.issue;
  const issueKey = issue?.key;
  if (!issueKey) return res.status(200).send('no issue key');
  const jiraProjectKey = issueKey.split('-')[0];
  const project = repo.list('projects').find(
    p => p.integrations?.atlassian?.enabled &&
         p.integrations.atlassian.jiraProjectKey === jiraProjectKey
  );
  if (!project) return res.status(200).send('ignored: project not mapped');
  try {
    const result = await ingestJiraIssue(project, issue);
    if (result?.req) {
      broadcast({ kind: 'req:update', req: result.req });
    }
    broadcast({ kind: 'vault:sync', projectId: project.id, issueKey });
  } catch (err) {
    console.error('[webhook:atlassian] ingest error:', err.message);
  }
  res.sendStatus(200);
});

// GitHub webhook: POST /api/webhooks/github
app.post('/api/webhooks/github', (req, res) => {
  // Verify webhook signature
  const secret = process.env.WEBHOOK_SECRET_GITHUB || process.env.WEBHOOK_SECRET;
  if (secret) {
    const sig = req.headers['x-hub-signature-256'] || req.headers['x-atlassian-webhook-signature'] || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(JSON.stringify(req.body)).digest('hex');
    if (sig !== expected) {
      console.warn('[webhook] signature mismatch — rejecting');
      return res.status(403).json({ error: 'invalid webhook signature' });
    }
  }
  const repoFullName = req.body?.repository?.full_name;
  if (!repoFullName) return res.status(200).send('no repo');
  const project = repo.list('projects').find(
    p => p.integrations?.github?.enabled &&
         p.integrations.github.repoFullName === repoFullName
  );
  if (!project) return res.status(200).send('ignored: project not mapped');
  broadcast({ kind: 'vault:sync', projectId: project.id, repo: repoFullName });
  res.sendStatus(200);
});

app.patch('/api/projects/:id', (req, res) => {
  const proj = repo.byId('projects', req.params.id);
  if (!proj) return res.status(404).json({ error: 'project not found' });
  const allowed = ['name', 'sub', 'description', 'emoji', 'hue', 'workspace', 'paused', 'integrations', 'methodology'];
  const patch = {};
  for (const k of allowed) if (req.body[k] !== undefined) patch[k] = req.body[k];
  const updated = repo.upsert('projects', { ...proj, ...patch });
  broadcast({ kind: 'project:update', project: updated });
  res.json(updated);
});

app.patch('/api/projects/:id/pause', (req, res) => {
  const proj = repo.byId('projects', req.params.id);
  if (!proj) return res.status(404).json({ error: 'project not found' });
  const paused = req.body?.paused ?? !proj.paused;
  const updated = repo.upsert('projects', { ...proj, paused });
  broadcast({ kind: 'project:update', project: updated });
  res.json(updated);
});

app.delete('/api/projects/:id', (req, res) => {
  const id = req.params.id;
  const project = repo.byId('projects', id);
  if (!project) return res.status(404).json({ error: 'project not found' });

  // Cascade: remove all related data
  const tables = ['tasks', 'reqs', 'runs', 'bugs', 'links'];
  const counts = {};
  for (const table of tables) {
    const rows = repo.list(table).filter((r) => r.project_id === id);
    for (const row of rows) repo.remove(table, row.id);
    counts[table] = rows.length;
  }
  // Remove project-scoped events
  const events = repo.list('events').filter((e) => e.project_id === id);
  for (const ev of events) repo.remove('events', ev.id);
  counts.events = events.length;

  // Remove vault folder
  try {
    const vaultDir = path.join(vaultRoot(), 'projects', id);
    if (fs.existsSync(vaultDir)) {
      fs.rmSync(vaultDir, { recursive: true, force: true });
      counts.vault = 'deleted';
    }
  } catch (e) { console.warn('[delete-project] vault cleanup:', e.message); }

  // Remove project row last
  repo.remove('projects', id);
  broadcast({ kind: 'project:delete', projectId: id });
  res.json({ ok: true, deleted: id, cascade: counts });
});

// ── requirements CRUD ─────────────────────────────────────────────
//
// Requirements are Jira-style: REQ-{PROJECT}-{NNNN}
// Each req has acceptance criteria, priority, status, and links to tasks.
// A vault note is auto-written for every req so the AI can navigate the graph.

app.get('/api/projects/:id/reqs', (req, res) => {
  const reqs = repo.list('reqs').filter((r) => r.project_id === req.params.id);
  // Attach coverage: count tasks per status for each req
  const tasks = repo.list('tasks').filter((t) => t.project_id === req.params.id);
  const withCoverage = reqs.map((r) => {
    const linked = tasks.filter((t) => t.parent_req === r.id);
    return {
      ...r,
      coverage: {
        total: linked.length,
        queued:  linked.filter((t) => t.status === 'queued').length,
        running: linked.filter((t) => t.status === 'running').length,
        review:  linked.filter((t) => t.status === 'review').length,
        done:    linked.filter((t) => t.status === 'done').length,
        tasks:   linked.map((t) => ({ id: t.id, title: t.title, status: t.status, by: t.by })),
      },
    };
  });
  res.json(withCoverage);
});

app.post('/api/projects/:id/reqs', (req, res) => {
  const { title, desc, priority = 'medium', criteria = [] } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });
  const projectId = req.params.id;
  const project = repo.byId('projects', projectId);
  if (!project) return res.status(404).json({ error: 'project not found' });

  const existing = repo.list('reqs').filter((r) => r.project_id === projectId);
  const num = String(existing.length + 1).padStart(4, '0');
  const prefix = projectId.toUpperCase().replace(/[^A-Z0-9]/g, '-').slice(0, 14);
  const id = `REQ-${prefix}-${num}`;

  const row = {
    id, project_id: projectId, title, desc: desc || '', priority,
    criteria: Array.isArray(criteria) ? criteria : [criteria],
    status: 'active', created_at: Date.now(),
  };
  repo.upsert('reqs', row);

  // Auto-write vault note — links back to project README so the graph connects.
  try {
    const criteriaLines = row.criteria.map((c) => `- [ ] ${c}`).join('\n') || '(none defined)';
    writeNote(`projects/${projectId}/reqs/${id}.md`, {
      frontmatter: {
        id, kind: 'req', title, status: 'active', priority,
        project: projectId,
        links: [`projects/${projectId}/README`],
      },
      body: `# ${title}\n\n**Priority:** ${priority}\n**Project:** [[projects/${projectId}/README|${project.name}]]\n\n## Description\n${desc || '(none)'}\n\n## Acceptance Criteria\n${criteriaLines}\n\n## Tasks\n_(linked automatically when agents create tasks with parent_req="${id}")_\n`,
    });
  } catch (e) { console.warn('[server] req vault note:', e.message); }

  broadcast({ kind: 'req:create', req: row });
  res.json(row);
});

app.patch('/api/reqs/:id', (req, res) => {
  const updated = repo.patch('reqs', req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'req not found' });
  broadcast({ kind: 'req:update', req: updated });
  res.json(updated);
});

app.delete('/api/reqs/:id', (req, res) => {
  const r = repo.byId('reqs', req.params.id);
  if (!r) return res.status(404).json({ error: 'req not found' });
  repo.remove('reqs', req.params.id);
  broadcast({ kind: 'req:delete', id: req.params.id });
  res.json({ ok: true });
});

// ── execution endpoints (direct REST for the Workshop UI) ─────────
app.post('/api/exec/shell', (req, res) => {
  const { cmd, projectId, timeout = 30_000 } = req.body || {};
  if (!cmd) return res.status(400).json({ error: 'cmd is required' });
  const ws = ensureWorkspaceOrFail(projectId, res);
  if (!ws) return;
  const isWin = process.platform === 'win32';
  const shell = isWin ? 'cmd.exe' : 'bash';
  const shellFlag = isWin ? '/c' : '-c';
  try {
    const result = spawnSync(shell, [shellFlag, cmd], {
      cwd: ws, timeout: Math.min(timeout, 120_000), maxBuffer: 1_048_576,
      encoding: 'utf8', env: { ...process.env },
    });
    res.json({
      cmd, exitCode: result.status ?? 0,
      stdout: (result.stdout || '').slice(0, 8000),
      stderr: (result.stderr || '').slice(0, 4000),
      error: result.error?.message || null,
    });
  } catch (err) {
    res.json({ cmd, exitCode: -1, error: err.message, stdout: '', stderr: '' });
  }
});

app.get('/api/exec/fs/tree', (req, res) => {
  const ws = ensureWorkspaceOrFail(req.query.projectId, res);
  if (!ws) return;

  function walk(dir) {
    const entries = [];
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        if (item.name === '.git' || item.name === 'node_modules') continue;
        const fullPath = path.join(dir, item.name);
        const relPath = path.relative(ws, fullPath);
        if (item.isDirectory()) {
          entries.push({ id: relPath, label: item.name, type: 'dir', children: walk(fullPath) });
        } else {
          entries.push({ id: relPath, label: item.name, type: 'file' });
        }
      }
    } catch (e) {
      console.error(e);
    }
    // Sort directories first, then alphabetically
    return entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  }

  res.json({ tree: walk(ws) });
});

app.get('/api/exec/fs/read', (req, res) => {
  const ws = ensureWorkspaceOrFail(req.query.projectId, res);
  if (!ws) return;
  const filePath = req.query.file;
  if (!filePath) return res.status(400).json({ error: 'file is required' });
  const full = path.resolve(ws, filePath);
  if (!full.startsWith(ws)) return res.status(400).json({ error: 'path traversal blocked' });
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'file not found' });

  try {
    const content = fs.readFileSync(full, 'utf8');
    res.json({ file: filePath, content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/exec/python', (req, res) => {
  const { code, projectId } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code is required' });
  const ws = ensureWorkspaceOrFail(projectId, res);
  if (!ws) return;
  const tmpFile = path.join(ws, `.gavirila-run-${Date.now()}.py`);
  fs.writeFileSync(tmpFile, code);
  try {
    const result = spawnSync('python3', [tmpFile], {
      cwd: ws, timeout: 30_000, maxBuffer: 1_048_576,
      encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    fs.unlinkSync(tmpFile);
    res.json({
      exitCode: result.status,
      stdout: (result.stdout || '').slice(0, 8000),
      stderr: (result.stderr || '').slice(0, 4000),
    });
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch {}
    res.json({ exitCode: -1, error: err.message });
  }
});

app.post('/api/exec/fs/write', (req, res) => {
  const { path: filePath, content, projectId } = req.body || {};
  if (!filePath || content === undefined) return res.status(400).json({ error: 'path and content are required' });
  const ws = ensureWorkspaceOrFail(projectId, res);
  if (!ws) return;
  const full = path.resolve(ws, filePath);
  if (!full.startsWith(ws)) return res.status(403).json({ error: 'path traversal blocked' });
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  res.json({ ok: true, path: filePath, bytes: Buffer.byteLength(content) });
});

app.get('/api/exec/fs/list', (req, res) => {
  const { dir = '.', projectId } = req.query;
  const ws = ensureWorkspaceOrFail(projectId, res);
  if (!ws) return;
  const full = path.resolve(ws, dir);
  if (!full.startsWith(ws)) return res.status(403).json({ error: 'path traversal blocked' });
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'directory not found' });
  const entries = fs.readdirSync(full, { withFileTypes: true }).map(ent => ({
    name: ent.name,
    type: ent.isDirectory() ? 'dir' : 'file',
    size: ent.isFile() ? fs.statSync(path.join(full, ent.name)).size : undefined,
  }));
  res.json({ dir, entries });
});

// ── dynamic agents ───────────────────────────────────────────────
// Note: POST /api/agents is handled above (line ~251) via createAgent().
// Custom agents are persisted to 'custom_agents' table and reloaded on boot.

// Load custom agents from DB on boot
{
  const customAgents = repo.list('custom_agents');
  for (const ca of customAgents) {
    if (!getAgent(ca.id)) {
      AGENTS.push({
        id: ca.id, name: ca.name, role: ca.role, emoji: ca.emoji,
        tier: ca.tier, tools: [],
        toolScopes: ca.toolScopes || ['vault_read', 'exec_fs', 'exec_shell', 'exec_python'],
        sub: ca.role,
        systemPrompt: () => ca.systemPromptTemplate || `You are ${ca.name}. You have tools to read/write files, run shell commands, execute Python, and manage git. USE THEM.`,
      });
    }
  }
}

// ── missions (windmill goal launcher) ────────────────────────────────
//
// A mission is a first-class contract that links one goal to spawned tasks.

// B4-04: Safety guards middleware
import { safetyGuardMiddleware } from './services/safety-guards.js';
const missionSafetyGuard = safetyGuardMiddleware(
  (projectId) => listMissionSummaries({ projectId }).filter((mission) => mission.status === 'active'),
  (projectId) => repo.byId('projects', projectId)
);

app.post('/api/missions', missionSafetyGuard, async (req, res) => {
  const { projectId, goal } = req.body || {};
  if (!goal) return res.status(400).json({ error: 'goal is required' });
  if (!projectId) return res.status(400).json({ error: 'projectId is required' });
  const project = repo.byId('projects', projectId);
  if (!project) return res.status(404).json({ error: 'project not found' });

  // B4-03: Analyze input and potentially enrich
  const analysis = analyzeInput(goal);
  const enrichedGoal = analysis.confidence === 'high' ? enrichGoal(goal, analysis) : null;

  try {
    const result = await conductorPipeline(projectId, goal, { broadcast, enrichedGoal });
    res.json({
      id: result.missionId || `pipeline-${Date.now().toString(36)}`,
      missionId: result.missionId || null,
      mission: result.mission || null,
      task_count: result.tasksCreated,
      plan_summary: `Created ${result.tasksCreated} tasks for "${goal.slice(0, 60)}"`,
      inputAnalysis: analysis,
    });
  } catch (err) {
    console.error('[missions] conductorPipeline failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/goal — alias for /api/missions (deprecated, kept for compat)
app.post('/api/projects/:id/goal', missionSafetyGuard, async (req, res) => {
  const project = repo.byId('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'project not found' });
  const { goal } = req.body || {};
  if (!goal) return res.status(400).json({ error: 'goal is required' });

  // B4-03: Analyze input
  const analysis = analyzeInput(goal);
  if (analysis.needsClarification) {
    return res.status(200).json({ needsClarification: true, ...analysis });
  }

  try {
    const result = await conductorPipeline(req.params.id, goal, { broadcast, enrichedGoal: enrichGoal(goal, analysis) });
    res.json({ ok: true, ...result, id: result.missionId || null, inputAnalysis: analysis });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/missions', (req, res) => {
  const { projectId } = req.query;
  res.json({ missions: listMissionSummaries({ projectId }) });
});

app.get('/api/missions/:id', (req, res) => {
  const mission = getMissionSummaryById(req.params.id);
  if (!mission) return res.status(404).json({ error: 'mission not found' });
  res.json(mission);
});

// Goal planner — creates a plan (DAG of tasks) WITHOUT auto-executing.
app.post('/api/projects/:id/plan', async (req, res) => {
  const project = repo.byId('projects', req.params.id);
  if (!project) return res.status(404).json({ error: 'project not found' });
  const { goal } = req.body || {};
  if (!goal) return res.status(400).json({ error: 'goal is required' });

  try {
    const result = await conductorPipeline(req.params.id, goal, { broadcast, draftOnly: true });
    res.json({
      task_count: result.tasksCreated,
      summary: result.summary,
      tech_stack: result.techStack,
      plan_summary: `Planned ${result.tasksCreated} tasks for "${goal.slice(0, 60)}"`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── notifications ────────────────────────────────────────────────
// In-memory for now; persisted per-session only.
const _notifications = [];
app.get('/api/notifications', (req, res) => res.json({ notifications: _notifications }));
app.post('/api/notifications/:id/read', (req, res) => {
  const n = _notifications.find((x) => x.id === req.params.id);
  if (n) n.read = true;
  res.json({ ok: true });
});

// ── project env vars ─────────────────────────────────────────────
const _projectEnv = new Map(); // projectId → { key: value }
app.get('/api/projects/:id/env', (req, res) => {
  const vars = _projectEnv.get(req.params.id) || {};
  res.json({ vars });
});
app.post('/api/projects/:id/env', (req, res) => {
  if (!repo.byId('projects', req.params.id)) return res.status(404).json({ error: 'project not found' });
  const current = _projectEnv.get(req.params.id) || {};
  const merged = { ...current, ...(req.body?.vars || {}) };
  _projectEnv.set(req.params.id, merged);
  res.json({ vars: merged });
});

// ── task diffs (lint-style summary of what changed) ──────────────
app.get('/api/tasks/:id/diff', (req, res) => {
  const t = repo.byId('tasks', req.params.id);
  if (!t) return res.status(404).json({ error: 'task not found' });
  const artifacts = (t.artifacts || []).filter((a) => a.name === 'write_file' || a.name === 'patch_file');
  res.json({ diff: artifacts.map((a) => a.summary || a.args?.path || '').join('\n') || '(no file changes recorded)' });
});

// ── task verification (run acceptance commands → evidence bundle) ──
app.post('/api/tasks/:id/verify', async (req, res) => {
  const t = repo.byId('tasks', req.params.id);
  if (!t) return res.status(404).json({ error: 'task not found' });

  const project = t.project_id ? repo.byId('projects', t.project_id) : null;
  const workspacePath = req.body?.workspacePath || project?.workspace;

  try {
    const { runVerification } = await import('./orchestrator/verifier.js');
    const result = await runVerification(req.params.id, workspacePath);
    broadcast({ kind: 'task:update', task: result.task });
    res.json({ taskId: req.params.id, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── task messages (alias for comments — legacy front-end compat) ──
app.post('/api/tasks/:id/messages', (req, res) => {
  // Redirect to the comments handler logic
  const t = repo.byId('tasks', req.params.id);
  if (!t) return res.status(404).json({ error: 'task not found' });
  const { text, by, kind } = req.body || {};
  if (!text) return res.status(400).json({ error: 'empty message' });
  const comment = { ts: Date.now(), by: by || 'human', text, kind };
  const comments = [...(t.comments || []), comment];
  const updated = repo.patch('tasks', req.params.id, { comments });
  broadcast({ kind: 'task:update', task: updated });
  res.json(updated);
});

// ── execution logs ────────────────────────────────────────────────
app.get('/api/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const projectId = req.query.project;
  // Use events as the primary log source (always populated); supplement with traces if present.
  const events = repo.list('events')
    .filter((e) => !projectId || e.project_id === projectId || !e.project_id)
    .slice(-limit)
    .reverse()
    .map((e) => ({ ...e, _source: 'event' }));
  const traces = repo.list('traces')
    .filter((t) => !projectId || t.projectId === projectId)
    .slice(-limit)
    .map((t) => ({ ...t, _source: 'trace' }));
  const logs = [...traces, ...events]
    .sort((a, b) => (b.created_at || b.ts || 0) - (a.created_at || a.ts || 0))
    .slice(0, limit);
  res.json({ logs, total: logs.length });
});

// ── dev servers (process-supervisor stubs) ────────────────────────
app.get('/api/exec/dev-servers', (req, res) => res.json({ servers: [] }));
app.get('/api/exec/dev-servers/:name/logs', (req, res) => res.json({ logs: [] }));
app.post('/api/exec/dev-servers/:name/stop', (req, res) => res.json({ ok: true }));
app.get('/api/exec/shell-sessions', (req, res) => res.json({ sessions: [] }));

// ── JSX → JS transform (server-side, so the browser needs no Babel) ─
const jsxCache = new Map();
app.get('*.jsx', async (req, res) => {
  const filePath = path.join(FRONTEND, req.path);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  try {
    const src = fs.readFileSync(filePath, 'utf8');
    const cacheKey = `${filePath}:${fs.statSync(filePath).mtimeMs}`;
    if (!jsxCache.has(cacheKey)) {
      jsxCache.clear();
      const { code } = await transformAsync(src, {
        presets: [['@babel/preset-react', { runtime: 'classic' }]],
        filename: req.path,
        sourceMaps: 'inline',
      });
      jsxCache.set(cacheKey, code);
    }
    res.setHeader('Content-Type', 'text/javascript; charset=UTF-8');
    res.send(jsxCache.get(cacheKey));
  } catch (err) {
    console.error('[jsx]', req.path, err.message);
    res.status(500).send(`// JSX transform error in ${req.path}\nconsole.error(${JSON.stringify(err.message)});`);
  }
});

// ── workflow engine endpoints ───────────────────────────────────────
app.post('/api/workflow/reconcile', (req, res) => {
  import('./orchestrator/workflow-engine.js').then(({ reconcileStuckTasks }) => {
    reconcileStuckTasks();
    res.json({ ok: true });
  });
});

// Stir all stuck tasks (needs-human / needs-info / tribunal) — manual trigger from UI
app.post('/api/tasks/stir', (req, res) => {
  import('./orchestrator/task-runner.js').then((m) => {
    if (typeof m.stirUpStuckTasks === 'function') {
      m.stirUpStuckTasks(broadcast);
      res.json({ ok: true, message: 'Stir triggered — stuck tasks re-evaluated' });
    } else {
      res.status(501).json({ ok: false, error: 'stirUpStuckTasks not exported' });
    }
  }).catch(err => res.status(500).json({ ok: false, error: err.message }));
});

app.post('/api/workflow/supervisor-pass', async (req, res) => {
  try {
    const { projectId = null, taskId = null, force = false } = req.body || {};
    const result = await runConductorSupervisorPass(broadcast, { projectId, taskId, force });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/tasks/:id/handoffs', (req, res) => {
  const t = repo.byId('tasks', req.params.id);
  if (!t) return res.status(404).json({ error: 'task not found' });
  const handoffs = (t.history || []).filter((h) => h.kind === 'handoff');
  res.json({ taskId: req.params.id, handoffs, current_handoff: t.handoff_type || null });
});

// ── static frontend ─────────────────────────────────────────────────
app.use(express.static(FRONTEND));
app.get('/', (req, res) => res.sendFile(path.join(FRONTEND, 'index.html')));

// ── HTTP + WS plumbing ─────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Set();
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ kind: 'hello', ts: Date.now() }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) {
    try { c.send(s); } catch { /* dead socket */ }
  }
}

// ── Scheduled Jira inbound sync ─────────────────────────────────────
// Polls Jira every 15 min, detects new/updated tickets, creates tasks from new REQs.

const _jiraSyncTimers = new Map();

function scheduleJiraInboundSync(projects, broadcastFn, intervalMs = 15 * 60 * 1000) {
  if (!projects.length) return;

  for (const project of projects) {
    const pid = project.id;
    if (_jiraSyncTimers.has(pid)) clearInterval(_jiraSyncTimers.get(pid));

    // Run first sync after 30s (give server time to stabilize), then every intervalMs
    const doSync = async () => {
      const fresh = repo.byId('projects', pid);
      if (!fresh?.integrations?.atlassian?.enabled) {
        clearInterval(_jiraSyncTimers.get(pid));
        _jiraSyncTimers.delete(pid);
        return;
      }
      try {
        const result = await bulkSyncJiraProject(fresh);

        // Broadcast events for new and updated REQs
        for (const req of result.newReqs || []) {
          broadcastFn({ kind: 'req:new', req, projectId: pid });
          console.log(`[jira-sync] ${pid}: new ticket → ${req.jira_key}: ${req.title}`);
        }
        for (const req of result.updatedReqs || []) {
          broadcastFn({ kind: 'req:update', req, projectId: pid });
        }

        // Auto-create tasks from new REQs so agents start working on them
        for (const req of result.newReqs || []) {
          // Skip if a task for this REQ already exists
          const existingTasks = repo.list('tasks').filter(
            t => t.project_id === pid && t.parent_req === req.id
          );
          if (existingTasks.length > 0) continue;

          const taskId = `c-jira-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
          const task = {
            id: taskId,
            project_id: pid,
            title: `Implement: ${req.title}`,
            desc: `Auto-created from Jira ticket ${req.jira_key}.\n\n${req.desc || ''}`.slice(0, 2000),
            by: 'Forge',
            tag: 'task',
            status: 'queued',
            parent_req: req.id,
            jira_key: req.jira_key,
            depends_on: [],
            created_at: Date.now(),
            updated_at: Date.now(),
            comments: [],
            history: [{ ts: Date.now(), kind: 'created', by: 'jira-sync', note: `auto-created from Jira ${req.jira_key}` }],
          };
          repo.upsert('tasks', task);
          broadcastFn({ kind: 'task:create', task });
          console.log(`[jira-sync] ${pid}: auto-created task ${taskId} from ${req.jira_key}`);

          // Write vault note for cross-linking
          try {
            writeNote(`projects/${pid}/tasks/${taskId}.md`, {
              frontmatter: {
                id: taskId, kind: 'task', title: task.title, status: 'queued',
                by: 'Forge', tag: 'task', 'parent-req': req.id, 'jira-key': req.jira_key,
                links: [`projects/${pid}/reqs/${req.jira_key}`],
              },
              body: task.desc,
            });
          } catch { /* non-critical */ }
        }

        if ((result.newReqs?.length || 0) + (result.updatedReqs?.length || 0) > 0) {
          console.log(`[jira-sync] ${pid}: ${result.newReqs?.length || 0} new, ${result.updatedReqs?.length || 0} updated`);
        }
      } catch (err) {
        console.warn(`[jira-sync] ${pid}: sync failed: ${err.message}`);
      }
    };

    // First sync after 30s, then every 15 min
    setTimeout(doSync, 30000);
    const timer = setInterval(doSync, intervalMs);
    _jiraSyncTimers.set(pid, timer);
  }

  console.log(`  🔄  Jira inbound sync scheduled for ${projects.length} project(s) (every ${Math.round(intervalMs / 60000)}min)`);
}

// ── boot ────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n  🏡  Gavirila Homestead`);
  console.log(`      → http://localhost:${PORT}`);
  console.log(`      → WS  ws://localhost:${PORT}/ws`);
  console.log(`      → vault: ${path.relative(process.cwd(), path.resolve(FRONTEND, '..', 'backend', 'data', 'vault'))}`);
  console.log(`      → LLM pool: ${getPool().length} provider(s)`);
  console.log(`      → tools: 28 (14 brain + 14 exec)\n`);

  // Start the autonomous task loop
  startTaskRunner(broadcast);
  startConductorSupervisor(broadcast);

  // Boot MCP tools (non-blocking — server starts immediately, tools arrive async)
  initMcpTools().catch(console.warn);

  // Start Confluence doc sync for all Atlassian-enabled projects
  // Stagger starts so they don't all hit Confluence at the same time
  const atlassianProjects = repo.list('projects').filter(p => p.integrations?.atlassian?.enabled);
  atlassianProjects.forEach((p, i) => {
    setTimeout(() => scheduleDocSync(p), i * 5000);
  });
  if (atlassianProjects.length) {
    console.log(`  📄  Atlassian doc sync scheduled for ${atlassianProjects.length} project(s)`);
  }

  // Start inbound Jira poll for all Atlassian-enabled projects
  // Pulls new/updated tickets every 15 min and auto-creates tasks from new REQs
  scheduleJiraInboundSync(atlassianProjects, broadcast);
});

