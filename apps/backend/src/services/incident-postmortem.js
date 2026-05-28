// apps/backend/src/services/incident-postmortem.js
//
// B5-02: Incident Taxonomy and Postmortem Templates
//
// Standardized incident classification and postmortem generation:
//   - Incident classes (severity levels + categories)
//   - Mandatory postmortem fields: trigger, detection gap, failed guardrail,
//     user impact, permanent fix, prevention test
//   - SLA enforcement for postmortem creation
//   - Structured learning: patterns are extracted and fed to failure-guards

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repo } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INCIDENTS_DIR = path.resolve(__dirname, '../../data/incidents');
const POSTMORTEMS_DIR = path.join(INCIDENTS_DIR, 'postmortems');

// ── Incident Taxonomy ───────────────────────────────────────────────────────

export const SEVERITY_LEVELS = {
  S1: { name: 'Critical', description: 'Mission completely blocked, no automated recovery possible', postmortemSlaHours: 4 },
  S2: { name: 'Major', description: 'Multiple tasks blocked or significant drift detected', postmortemSlaHours: 24 },
  S3: { name: 'Minor', description: 'Single task failure with automated recovery available', postmortemSlaHours: 72 },
  S4: { name: 'Low', description: 'Cosmetic or performance issue, no mission impact', postmortemSlaHours: null },
};

export const INCIDENT_CATEGORIES = {
  'orchestration-failure': { description: 'Task runner, scheduler, or pipeline malfunction', owner: 'orchestrator' },
  'dependency-deadlock': { description: 'Circular or unresolvable dependency chain', owner: 'dependency-validator' },
  'agent-loop': { description: 'Agent stuck in repetitive behavior', owner: 'loop-detector' },
  'resource-exhaustion': { description: 'Token budget, rate limit, or timeout exceeded', owner: 'resource-manager' },
  'data-corruption': { description: 'State inconsistency in DB or vault', owner: 'data-integrity' },
  'integration-failure': { description: 'External service or tool unavailable', owner: 'connectors' },
  'scope-explosion': { description: 'Task propagation or mission drift out of control', owner: 'mission-contract' },
  'security-violation': { description: 'Unauthorized action or unsafe operation attempted', owner: 'security' },
  'playbook-regression': { description: 'Playbook update caused behavior degradation', owner: 'playbook-harness' },
  'false-completion': { description: 'Task marked done but outputs invalid', owner: 'verifier' },
};

// ── Incident Management ─────────────────────────────────────────────────────

function ensureDirs() {
  if (!fs.existsSync(INCIDENTS_DIR)) fs.mkdirSync(INCIDENTS_DIR, { recursive: true });
  if (!fs.existsSync(POSTMORTEMS_DIR)) fs.mkdirSync(POSTMORTEMS_DIR, { recursive: true });
}

function incidentPath(id) {
  return path.join(INCIDENTS_DIR, `${id}.json`);
}

function postmortemPath(incidentId) {
  return path.join(POSTMORTEMS_DIR, `${incidentId}.json`);
}

/**
 * Create a new incident record.
 */
export function createIncident({ projectId, severity, category, title, trigger, affectedTasks, context }) {
  ensureDirs();
  const now = Date.now();
  const id = `inc-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  if (!SEVERITY_LEVELS[severity]) throw new Error(`Invalid severity: ${severity}`);
  if (!INCIDENT_CATEGORIES[category]) throw new Error(`Invalid category: ${category}`);

  const incident = {
    id,
    projectId,
    severity,
    category,
    title: title || `${category} incident`,
    status: 'open', // open → investigating → resolved → postmortem-pending → closed
    trigger: trigger || '',
    affectedTasks: affectedTasks || [],
    context: context || '',
    owner: INCIDENT_CATEGORIES[category].owner,
    createdAt: now,
    resolvedAt: null,
    postmortemDue: SEVERITY_LEVELS[severity].postmortemSlaHours
      ? now + (SEVERITY_LEVELS[severity].postmortemSlaHours * 60 * 60_000)
      : null,
    postmortemId: null,
    timeline: [{ ts: now, event: 'created', by: 'system', note: `Severity ${severity}: ${title}` }],
  };

  fs.writeFileSync(incidentPath(id), JSON.stringify(incident, null, 2));
  return incident;
}

/**
 * Update incident status with timeline entry.
 */
export function updateIncident(id, { status, note, by }) {
  const fp = incidentPath(id);
  if (!fs.existsSync(fp)) throw new Error(`Incident ${id} not found`);

  const incident = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const now = Date.now();

  if (status) incident.status = status;
  if (status === 'resolved') incident.resolvedAt = now;

  incident.timeline.push({ ts: now, event: status || 'update', by: by || 'system', note: note || '' });
  fs.writeFileSync(fp, JSON.stringify(incident, null, 2));
  return incident;
}

/**
 * List incidents, optionally filtered.
 */
export function listIncidents({ projectId, status, severity, limit = 50 } = {}) {
  ensureDirs();
  const files = fs.readdirSync(INCIDENTS_DIR).filter(f => f.startsWith('inc-') && f.endsWith('.json'));

  let incidents = files.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(INCIDENTS_DIR, f), 'utf8')); }
    catch { return null; }
  }).filter(Boolean);

  if (projectId) incidents = incidents.filter(i => i.projectId === projectId);
  if (status) incidents = incidents.filter(i => i.status === status);
  if (severity) incidents = incidents.filter(i => i.severity === severity);

  return incidents.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

// ── Postmortem System ───────────────────────────────────────────────────────

/**
 * Postmortem template — mandatory fields for structured learning.
 */
const POSTMORTEM_TEMPLATE = {
  trigger: '',              // What caused the incident
  detectionGap: '',         // Why wasn't it caught earlier
  failedGuardrail: '',      // Which existing guard should have prevented this
  userImpact: '',           // How the user was affected
  permanentFix: '',         // What was done to fix it permanently
  preventionTest: '',       // How do we verify this won't recur
  rootCause: '',            // Underlying root cause
  contributingFactors: [],  // Other factors that made it worse
  lessonsLearned: [],       // Key takeaways
  actionItems: [],          // Follow-up work items: { action, owner, deadline }
};

/**
 * Create a postmortem for an incident.
 */
export function createPostmortem(incidentId, fields = {}) {
  ensureDirs();
  const incFp = incidentPath(incidentId);
  if (!fs.existsSync(incFp)) throw new Error(`Incident ${incidentId} not found`);

  const incident = JSON.parse(fs.readFileSync(incFp, 'utf8'));

  // Validate mandatory fields for S1/S2
  const mandatory = ['trigger', 'detectionGap', 'failedGuardrail', 'userImpact', 'permanentFix', 'preventionTest'];
  if (['S1', 'S2'].includes(incident.severity)) {
    const missing = mandatory.filter(f => !fields[f]?.trim());
    if (missing.length) {
      throw new Error(`Mandatory postmortem fields missing for ${incident.severity}: ${missing.join(', ')}`);
    }
  }

  const now = Date.now();
  const postmortem = {
    id: `pm-${incidentId}`,
    incidentId,
    ...POSTMORTEM_TEMPLATE,
    ...fields,
    createdAt: now,
    updatedAt: now,
    withinSla: incident.postmortemDue ? now <= incident.postmortemDue : true,
  };

  fs.writeFileSync(postmortemPath(incidentId), JSON.stringify(postmortem, null, 2));

  // Update incident
  incident.postmortemId = postmortem.id;
  incident.status = 'closed';
  incident.timeline.push({ ts: now, event: 'postmortem-created', by: 'system', note: `SLA ${postmortem.withinSla ? 'met' : 'breached'}` });
  fs.writeFileSync(incFp, JSON.stringify(incident, null, 2));

  return postmortem;
}

/**
 * Get postmortem for an incident.
 */
export function getPostmortem(incidentId) {
  const fp = postmortemPath(incidentId);
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch { return null; }
}

/**
 * Get incidents that are past their postmortem SLA deadline.
 */
export function getOverduePostmortems() {
  const now = Date.now();
  return listIncidents({ status: 'resolved' })
    .concat(listIncidents({ status: 'postmortem-pending' }))
    .filter(i => i.postmortemDue && now > i.postmortemDue && !i.postmortemId);
}

// ── Auto-Incident Detection ─────────────────────────────────────────────────

/**
 * Automatically create incidents from task failures.
 * Called from task runner or stir loop when patterns are detected.
 */
export function autoDetectIncident(task, errMsg, context = {}) {
  // Classify severity
  let severity = 'S3';
  if (task.constraint_level >= 4 || task.status === 'needs-human') severity = 'S2';
  if (context.missionBlocked || context.deadlockDetected) severity = 'S1';

  // Classify category
  let category = 'orchestration-failure';
  if (/loop|repetit|stuck|stall/i.test(errMsg)) category = 'agent-loop';
  if (/depend|cycle|deadlock/i.test(errMsg)) category = 'dependency-deadlock';
  if (/token|budget|timeout|rate.limit/i.test(errMsg)) category = 'resource-exhaustion';
  if (/drift|scope|propag/i.test(errMsg)) category = 'scope-explosion';
  if (/permission|auth|security/i.test(errMsg)) category = 'security-violation';
  if (/gate.*fail|output.*miss/i.test(errMsg)) category = 'false-completion';

  return createIncident({
    projectId: task.project_id,
    severity,
    category,
    title: `${category}: ${(task.title || '').slice(0, 60)}`,
    trigger: errMsg.slice(0, 300),
    affectedTasks: [task.id],
    context: JSON.stringify({ taskId: task.id, attempts: task.attempts, constraintLevel: task.constraint_level }),
  });
}
