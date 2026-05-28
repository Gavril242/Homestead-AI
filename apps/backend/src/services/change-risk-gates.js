// apps/backend/src/services/change-risk-gates.js
//
// B5-03: Change Risk Gates
//
// Requires risk scoring before deploying changes to orchestration components:
//   - Classifies changes by impact area (scheduler, verifier, memory, playbook router)
//   - Computes risk score based on scope, blast radius, and historical regression data
//   - Enforces canary rollout for high-risk changes
//   - Blocks global deploy of high-risk without canary verification

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RISK_LOG = path.resolve(__dirname, '../../data/risk-assessments.json');

// ── Risk Classification ─────────────────────────────────────────────────────

export const IMPACT_AREAS = {
  scheduler: { weight: 0.9, description: 'Task runner tick, dispatch, concurrency' },
  verifier: { weight: 0.8, description: 'Output gates, acceptance criteria, completion logic' },
  memory: { weight: 0.7, description: 'Entity memory, tiered memory, failure guards' },
  'playbook-router': { weight: 0.7, description: 'Playbook selection, intent matching, domain routing' },
  'dependency-graph': { weight: 0.85, description: 'Dependency validator, repair, cycle detection' },
  'escalation-ladder': { weight: 0.75, description: 'Failure handling, constraint levels, tribunal' },
  'mission-contract': { weight: 0.8, description: 'Mission scope, drift detection, propagation limits' },
  'agent-dispatch': { weight: 0.6, description: 'Agent selection, tool access, context building' },
  'data-layer': { weight: 0.9, description: 'DB operations, repo, persistence' },
  ui: { weight: 0.3, description: 'Frontend, dashboard, display logic' },
};

export const RISK_LEVELS = {
  low: { threshold: 0.3, canaryRequired: false, approvalRequired: false },
  medium: { threshold: 0.6, canaryRequired: false, approvalRequired: true },
  high: { threshold: 0.8, canaryRequired: true, approvalRequired: true },
  critical: { threshold: 1.0, canaryRequired: true, approvalRequired: true },
};

// ── Risk Scoring ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ChangeDescriptor
 * @property {string} id           - Change identifier
 * @property {string} description  - What changed
 * @property {string[]} impactAreas - Which areas are affected
 * @property {string[]} filesChanged - Changed file paths
 * @property {number} linesChanged - Total lines added + removed
 * @property {boolean} modifiesStateTransitions - Does it change task state machine?
 * @property {boolean} modifiesLlmPrompts - Does it change agent prompts/missions?
 * @property {boolean} modifiesDataSchema - Does it change DB/storage schema?
 * @property {string} [author]
 */

/**
 * Compute risk score for a proposed change.
 * Returns 0-1 score and classification.
 */
export function assessRisk(change) {
  let score = 0;
  const factors = [];

  // 1. Impact area weight (max of affected areas)
  const areaWeights = (change.impactAreas || [])
    .map(a => IMPACT_AREAS[a]?.weight || 0.5);
  const maxAreaWeight = Math.max(...areaWeights, 0);
  score += maxAreaWeight * 0.35;
  if (maxAreaWeight >= 0.8) factors.push(`High-impact area: ${change.impactAreas.join(', ')}`);

  // 2. Blast radius (number of areas affected)
  const areaCount = (change.impactAreas || []).length;
  const radiusFactor = Math.min(areaCount / 4, 1) * 0.2;
  score += radiusFactor;
  if (areaCount >= 3) factors.push(`Wide blast radius: ${areaCount} areas`);

  // 3. Size factor
  const lines = change.linesChanged || 0;
  const sizeFactor = Math.min(lines / 500, 1) * 0.15;
  score += sizeFactor;
  if (lines > 200) factors.push(`Large change: ${lines} lines`);

  // 4. Critical flags
  if (change.modifiesStateTransitions) {
    score += 0.15;
    factors.push('Modifies state transitions');
  }
  if (change.modifiesLlmPrompts) {
    score += 0.10;
    factors.push('Modifies LLM prompts');
  }
  if (change.modifiesDataSchema) {
    score += 0.12;
    factors.push('Modifies data schema');
  }

  score = Math.min(score, 1.0);

  // Classify
  let level = 'low';
  if (score >= RISK_LEVELS.critical.threshold * 0.8) level = 'critical';
  else if (score >= RISK_LEVELS.high.threshold * 0.8) level = 'high';
  else if (score >= RISK_LEVELS.medium.threshold * 0.8) level = 'medium';

  const levelConfig = RISK_LEVELS[level];

  return {
    changeId: change.id,
    score: Math.round(score * 100) / 100,
    level,
    factors,
    canaryRequired: levelConfig.canaryRequired,
    approvalRequired: levelConfig.approvalRequired,
    recommendation: buildRecommendation(level, factors, change),
    assessedAt: Date.now(),
  };
}

function buildRecommendation(level, factors, change) {
  switch (level) {
    case 'critical':
      return `BLOCKED: This change requires canary rollout + manual approval. Test against a single project before global deploy. Factors: ${factors.join('; ')}`;
    case 'high':
      return `CANARY REQUIRED: Deploy to one project first, verify for 30 minutes, then promote globally. Factors: ${factors.join('; ')}`;
    case 'medium':
      return `APPROVAL NEEDED: Get review before deploy. Consider staged rollout. Factors: ${factors.join('; ')}`;
    case 'low':
      return 'Safe to deploy. Standard monitoring applies.';
    default:
      return 'Unknown risk level — treat as high.';
  }
}

// ── Canary Management ───────────────────────────────────────────────────────

/**
 * @typedef {Object} CanaryState
 * @property {string} changeId
 * @property {string} projectId      - Project used for canary testing
 * @property {'active'|'passed'|'failed'|'expired'} status
 * @property {number} startedAt
 * @property {number} durationMs     - How long canary must run (default: 30 min)
 * @property {Object} baselineMetrics - SLO metrics before change
 * @property {Object|null} canaryMetrics - SLO metrics during canary
 */

const _activeCanaries = new Map(); // changeId → CanaryState

/**
 * Start a canary rollout for a high-risk change.
 */
export function startCanary(changeId, projectId, baselineMetrics) {
  const canary = {
    changeId,
    projectId,
    status: 'active',
    startedAt: Date.now(),
    durationMs: 30 * 60_000, // 30 minutes
    baselineMetrics,
    canaryMetrics: null,
  };
  _activeCanaries.set(changeId, canary);
  return canary;
}

/**
 * Check if a canary has passed (enough time elapsed + no degradation).
 */
export function checkCanary(changeId, currentMetrics) {
  const canary = _activeCanaries.get(changeId);
  if (!canary) return { exists: false };

  const elapsed = Date.now() - canary.startedAt;
  canary.canaryMetrics = currentMetrics;

  if (elapsed < canary.durationMs) {
    return { exists: true, status: 'active', remainingMs: canary.durationMs - elapsed };
  }

  // Compare metrics — pass if no significant degradation
  const degraded = detectDegradation(canary.baselineMetrics, currentMetrics);
  canary.status = degraded ? 'failed' : 'passed';
  _activeCanaries.set(changeId, canary);

  return { exists: true, status: canary.status, reason: degraded || 'All metrics within acceptable range' };
}

function detectDegradation(baseline, current) {
  if (!baseline || !current) return null;

  // Check each metric — fail if significantly worse
  for (const [key, base] of Object.entries(baseline)) {
    const curr = current[key];
    if (curr == null) continue;
    // Support both flat values and { value: number } objects
    const baseVal = typeof base === 'number' ? base : base?.value;
    const currVal = typeof curr === 'number' ? curr : curr?.value;
    if (typeof baseVal !== 'number' || typeof currVal !== 'number') continue;
    // Allow 20% degradation before flagging
    if (currVal > baseVal * 1.2 && baseVal > 0) {
      return `Metric "${key}" degraded: ${baseVal.toFixed(3)} → ${currVal.toFixed(3)} (+${((currVal / baseVal - 1) * 100).toFixed(0)}%)`;
    }
  }
  return null;
}

/**
 * Promote canary → allow global deploy.
 */
export function promoteCanary(changeId) {
  const canary = _activeCanaries.get(changeId);
  if (!canary) return false;
  if (canary.status !== 'passed') return false;
  _activeCanaries.delete(changeId);
  logAssessment({ ...canary, promotedAt: Date.now() });
  return true;
}

// ── Persistence ─────────────────────────────────────────────────────────────

function logAssessment(assessment) {
  const dir = path.dirname(RISK_LOG);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let log = [];
  if (fs.existsSync(RISK_LOG)) {
    try { log = JSON.parse(fs.readFileSync(RISK_LOG, 'utf8')); }
    catch { log = []; }
  }

  log.push(assessment);
  // Keep last 200 assessments
  if (log.length > 200) log = log.slice(-200);
  fs.writeFileSync(RISK_LOG, JSON.stringify(log, null, 2));
}

/**
 * Record a risk assessment result (for audit trail).
 */
export function recordAssessment(change) {
  const assessment = assessRisk(change);
  logAssessment(assessment);
  return assessment;
}

/**
 * Gate check: can this change be deployed?
 * Returns { allowed, reason, assessment }
 */
export function gateCheck(change) {
  const assessment = assessRisk(change);

  if (assessment.canaryRequired) {
    const canary = _activeCanaries.get(change.id);
    if (!canary) {
      return { allowed: false, reason: 'Canary rollout required but not started', assessment };
    }
    if (canary.status === 'active') {
      return { allowed: false, reason: `Canary still running (${Math.round((Date.now() - canary.startedAt) / 60_000)}min elapsed)`, assessment };
    }
    if (canary.status === 'failed') {
      return { allowed: false, reason: 'Canary failed — do not deploy globally', assessment };
    }
  }

  return { allowed: true, reason: assessment.recommendation, assessment };
}
