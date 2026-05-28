// apps/backend/src/skills/playbook-router.js
//
// B3-02: Deterministic Playbook Router
//
// Routes task intent to the best matching playbook via:
//   1. Intent extraction (domain terms + action verbs)
//   2. Trigger matching (scored overlap with playbook triggers)
//   3. Prerequisites validation (tools, files, env)
//   4. Input readiness check (required inputs available in task context)
//
// If no eligible playbook, returns exact gap list.
// Falls back to supervised generic flow with explicit warning.

import { listPlaybooks, getPromotedPlaybook } from './playbook-store.js';

// ── Intent Extraction ───────────────────────────────────────────────────────

const DOMAIN_TERMS = new Map([
  ['utas5', ['utas', 'utas5', 'autosar', 'adaptive', 'ara', 'service-discovery', 'someip', 'diag', 'diagnostics']],
  ['web-dev', ['react', 'nextjs', 'express', 'api', 'frontend', 'backend', 'css', 'html', 'component']],
  ['testing', ['test', 'spec', 'unit', 'integration', 'e2e', 'coverage', 'assert', 'mock']],
  ['devops', ['docker', 'deploy', 'ci', 'cd', 'pipeline', 'kubernetes', 'k8s', 'container']],
  ['security', ['auth', 'token', 'jwt', 'cors', 'xss', 'csrf', 'vulnerability', 'audit']],
  ['data', ['database', 'sql', 'migration', 'schema', 'etl', 'csv', 'excel', 'json']],
]);

const ACTION_VERBS = ['create', 'update', 'delete', 'fix', 'debug', 'test', 'deploy', 'refactor', 'migrate', 'analyze', 'configure', 'implement', 'review', 'build'];

/**
 * Extract intent from task text → { domains, actions, terms }
 */
export function extractIntent(text) {
  const lower = text.toLowerCase();
  const words = lower.split(/[\s,.\-_:;()/]+/).filter(w => w.length > 2);

  const domains = [];
  for (const [domain, terms] of DOMAIN_TERMS) {
    const matches = terms.filter(t => lower.includes(t));
    if (matches.length > 0) {
      domains.push({ domain, matches, score: matches.length });
    }
  }
  domains.sort((a, b) => b.score - a.score);

  const actions = ACTION_VERBS.filter(v => words.includes(v) || words.some(w => w.startsWith(v)));

  return { domains, actions, terms: words };
}

// ── Trigger Matching ────────────────────────────────────────────────────────

/**
 * Score how well a playbook's triggers match an intent.
 * Returns 0-1 (1 = perfect match).
 */
function scoreTriggerMatch(playbook, intent) {
  if (!playbook.triggers?.length) return 0;

  const triggerTerms = playbook.triggers
    .flatMap(t => t.toLowerCase().split(/[\s,.\-_:;]+/))
    .filter(w => w.length > 2);

  if (!triggerTerms.length) return 0;

  const taskTermSet = new Set(intent.terms);
  const matched = triggerTerms.filter(t => taskTermSet.has(t) || intent.terms.some(w => w.includes(t)));
  return matched.length / triggerTerms.length;
}

// ── Prerequisite Validation ─────────────────────────────────────────────────

/**
 * Check if playbook prerequisites are satisfied.
 * Returns { satisfied: boolean, gaps: string[] }
 */
function checkPrerequisites(playbook, context = {}) {
  const gaps = [];
  const prereqs = playbook.prerequisites || {};

  // Check tools
  for (const tool of (prereqs.tools || [])) {
    if (context.availableTools && !context.availableTools.includes(tool)) {
      gaps.push(`Missing tool: ${tool}`);
    }
  }

  // Check files (workspace files that must exist)
  for (const file of (prereqs.files || [])) {
    if (context.workspaceFiles && !context.workspaceFiles.some(f => f.includes(file))) {
      gaps.push(`Missing file: ${file}`);
    }
  }

  // Check env vars
  for (const env of (prereqs.env || [])) {
    if (!process.env[env]) {
      gaps.push(`Missing env: ${env}`);
    }
  }

  return { satisfied: gaps.length === 0, gaps };
}

// ── Input Readiness ─────────────────────────────────────────────────────────

/**
 * Check if required inputs are available in task context.
 * Returns { ready: boolean, missing: string[] }
 */
function checkInputReadiness(playbook, taskContext = {}) {
  const missing = [];
  const required = playbook.inputs?.required || [];

  for (const input of required) {
    const name = input.name || input;
    // Check if the input is available in task desc, params, or explicit inputs
    const available = taskContext.desc?.toLowerCase().includes(name.toLowerCase()) ||
      taskContext.params?.[name] !== undefined ||
      taskContext.inputs?.[name] !== undefined;
    if (!available) {
      missing.push(`${name}${input.desc ? ` (${input.desc})` : ''}`);
    }
  }

  return { ready: missing.length === 0, missing };
}

// ── Main Router ─────────────────────────────────────────────────────────────

/**
 * @typedef {Object} RouteResult
 * @property {'matched'|'fallback'|'no-match'} outcome
 * @property {Object|null} playbook         - The selected playbook (if matched)
 * @property {number} confidence            - 0-1 confidence in the match
 * @property {string} reason                - Human-readable explanation
 * @property {string[]} gaps                - What's missing (if no match or fallback)
 * @property {Object[]} candidates          - Other considered playbooks with scores
 */

const MIN_TRIGGER_SCORE = 0.3;
const MIN_CONFIDENCE = 0.5;

/**
 * Route a task to the best matching playbook.
 *
 * @param {Object} task - Task object { title, desc, by, project_id, ... }
 * @param {Object} context - Runtime context { availableTools, workspaceFiles, ... }
 * @returns {RouteResult}
 */
export function routeToPlaybook(task, context = {}) {
  const text = `${task.title || ''} ${task.desc || ''}`;
  const intent = extractIntent(text);

  if (!intent.domains.length && !intent.actions.length) {
    return {
      outcome: 'no-match',
      playbook: null,
      confidence: 0,
      reason: 'No domain or action intent detected in task',
      gaps: ['Task text does not match any known domain terms or action verbs'],
      candidates: [],
    };
  }

  // Get all promoted playbooks for matched domains
  const targetDomains = intent.domains.length
    ? intent.domains.map(d => d.domain)
    : [...DOMAIN_TERMS.keys()]; // broad search if no domain detected

  const allPlaybooks = targetDomains.flatMap(d => listPlaybooks({ domain: d, status: 'promoted' }));

  if (!allPlaybooks.length) {
    return {
      outcome: 'no-match',
      playbook: null,
      confidence: 0,
      reason: `No promoted playbooks for domains: ${targetDomains.join(', ')}`,
      gaps: [`No playbooks available for: ${targetDomains.join(', ')}`],
      candidates: [],
    };
  }

  // Score each playbook
  const scored = allPlaybooks.map(pb => {
    const triggerScore = scoreTriggerMatch(pb, intent);
    const domainBoost = intent.domains.find(d => d.domain === pb.domain)?.score || 0;
    const normalizedDomainBoost = Math.min(domainBoost / 3, 0.3);
    const confidence = Math.min(triggerScore * 0.7 + normalizedDomainBoost, 1.0);

    return { playbook: pb, triggerScore, confidence };
  }).filter(s => s.triggerScore >= MIN_TRIGGER_SCORE)
    .sort((a, b) => b.confidence - a.confidence);

  if (!scored.length) {
    return {
      outcome: 'fallback',
      playbook: null,
      confidence: 0,
      reason: 'No playbooks matched with sufficient trigger score',
      gaps: [`Best trigger score below threshold (${MIN_TRIGGER_SCORE}). Available playbooks: ${allPlaybooks.map(p => p.id).join(', ')}`],
      candidates: allPlaybooks.map(pb => ({ id: pb.id, triggerScore: scoreTriggerMatch(pb, intent) })),
    };
  }

  const best = scored[0];

  // Validate prerequisites
  const prereqCheck = checkPrerequisites(best.playbook, context);
  if (!prereqCheck.satisfied) {
    return {
      outcome: 'fallback',
      playbook: best.playbook,
      confidence: best.confidence * 0.5, // halve confidence if prereqs fail
      reason: `Playbook ${best.playbook.id} matched but prerequisites not met`,
      gaps: prereqCheck.gaps,
      candidates: scored.slice(0, 5).map(s => ({ id: s.playbook.id, confidence: s.confidence })),
    };
  }

  // Validate input readiness
  const inputCheck = checkInputReadiness(best.playbook, { desc: text, params: task.params, inputs: task.inputs });
  if (!inputCheck.ready) {
    return {
      outcome: 'fallback',
      playbook: best.playbook,
      confidence: best.confidence * 0.7, // reduce confidence
      reason: `Playbook ${best.playbook.id} matched but missing required inputs`,
      gaps: inputCheck.missing.map(m => `Missing input: ${m}`),
      candidates: scored.slice(0, 5).map(s => ({ id: s.playbook.id, confidence: s.confidence })),
    };
  }

  // Full match
  if (best.confidence < MIN_CONFIDENCE) {
    return {
      outcome: 'fallback',
      playbook: best.playbook,
      confidence: best.confidence,
      reason: `Playbook ${best.playbook.id} matched but confidence too low (${(best.confidence * 100).toFixed(0)}%)`,
      gaps: ['Low confidence — supervised generic flow recommended'],
      candidates: scored.slice(0, 5).map(s => ({ id: s.playbook.id, confidence: s.confidence })),
    };
  }

  return {
    outcome: 'matched',
    playbook: best.playbook,
    confidence: best.confidence,
    reason: `Matched playbook ${best.playbook.id}@${best.playbook.version} (${(best.confidence * 100).toFixed(0)}% confidence)`,
    gaps: [],
    candidates: scored.slice(1, 5).map(s => ({ id: s.playbook.id, confidence: s.confidence })),
  };
}

/**
 * Build a playbook execution block to inject into a task's mission briefing.
 * Only emitted when router matches with sufficient confidence.
 */
export function buildPlaybookBlock(routeResult) {
  if (routeResult.outcome !== 'matched' || !routeResult.playbook) {
    if (routeResult.outcome === 'fallback' && routeResult.gaps.length) {
      return `\n⚠️ PLAYBOOK ROUTING WARNING: ${routeResult.reason}\nGaps: ${routeResult.gaps.join('; ')}\nProceeding with generic supervised flow.\n`;
    }
    return '';
  }

  const pb = routeResult.playbook;
  const stepsBlock = pb.steps.map(s =>
    `  ${s.order}. [${s.critical ? 'CRITICAL' : 'optional'}] ${s.action}${s.expectation ? ` → expect: ${s.expectation}` : ''}`
  ).join('\n');

  const validationsBlock = pb.validations.map(v =>
    `  • ${v.check}${v.command ? ` (run: ${v.command})` : ''}`
  ).join('\n');

  return `
═══ PLAYBOOK: ${pb.id}@${pb.version} ═══
${pb.description}

REQUIRED STEPS (execute in order):
${stepsBlock}

VALIDATIONS (run after all steps):
${validationsBlock || '  (none defined)'}

OUTPUT SCHEMA: ${pb.outputSchema?.fields?.length ? pb.outputSchema.fields.map(f => `${f.name}:${f.type}`).join(', ') : '(flexible)'}

⚠️ Follow this playbook exactly. Do NOT deviate unless a step explicitly fails.
`;
}

/**
 * Register custom domain terms (for project-specific vocabularies).
 */
export function registerDomainTerms(domain, terms) {
  const existing = DOMAIN_TERMS.get(domain) || [];
  DOMAIN_TERMS.set(domain, [...new Set([...existing, ...terms])]);
}
