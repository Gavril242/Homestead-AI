// apps/backend/src/services/safety-guards.js
//
// B4-04: Safety and Misuse Hardening
//
// Prevents pathological runs from non-technical users:
//   1. Mission rate limits (max N missions per hour per project)
//   2. Duplicate mission detection (fuzzy title match)
//   3. Oversized workspace warnings
//   4. Impossible-request detector (heuristic)
//
// Implemented as Express middleware on mission/goal creation endpoints.

import fs from 'node:fs';
import path from 'node:path';

// ── Configuration ───────────────────────────────────────────────────────────

const MAX_MISSIONS_PER_HOUR = 5;        // Per project
const MAX_ACTIVE_MISSIONS = 10;         // Per project
const DUPLICATE_THRESHOLD = 0.75;       // Jaccard similarity for duplicate detection
const MAX_WORKSPACE_SIZE_MB = 2000;     // Warn if workspace exceeds this
const RATE_WINDOW_MS = 60 * 60_000;     // 1 hour

// ── Rate Tracking (in-memory, resets on restart) ────────────────────────────

const _rateBuckets = new Map(); // projectId → [{ ts }]

function getRateCount(projectId) {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  const bucket = _rateBuckets.get(projectId) || [];
  const valid = bucket.filter(entry => entry.ts > cutoff);
  _rateBuckets.set(projectId, valid);
  return valid.length;
}

function recordMissionCreation(projectId) {
  const bucket = _rateBuckets.get(projectId) || [];
  bucket.push({ ts: Date.now() });
  _rateBuckets.set(projectId, bucket);
}

// ── Impossible Request Heuristics ───────────────────────────────────────────

const IMPOSSIBLE_PATTERNS = [
  { regex: /delete\s+(all|every|the\s+entire)\s+(file|code|project|repo)/i, reason: 'Destructive: would delete all project files' },
  { regex: /rewrite\s+(everything|the\s+entire|all\s+of)/i, reason: 'Scope too large: full rewrite is not a single-mission task' },
  { regex: /hack|exploit|bypass\s+security|steal|inject\s+malware/i, reason: 'Prohibited: security/ethical violation' },
  { regex: /infinite|never.ending|run\s+forever/i, reason: 'Non-terminating: tasks must have finite completion criteria' },
  { regex: /do\s+everything|fix\s+everything|make\s+it\s+perfect/i, reason: 'Unbounded: goal has no measurable completion criteria' },
];

function detectImpossibleRequest(text) {
  for (const { regex, reason } of IMPOSSIBLE_PATTERNS) {
    if (regex.test(text)) {
      return { impossible: true, reason };
    }
  }
  // Length check — extremely short goals are likely ambiguous
  if (text.trim().length < 10) {
    return { impossible: true, reason: 'Goal too short: provide at least a sentence describing what you need' };
  }
  return { impossible: false, reason: null };
}

// ── Duplicate Detection ─────────────────────────────────────────────────────

function tokenize(text) {
  return (text || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
}

function jaccardSimilarity(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (!setA.size || !setB.size) return 0;
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

/**
 * Check if a new mission goal is too similar to existing active missions.
 */
function detectDuplicate(newGoal, existingMissions) {
  for (const mission of existingMissions) {
    const goalText = mission.goal || mission.title || mission.scope_boundaries?.join(' ') || '';
    const similarity = jaccardSimilarity(newGoal, goalText);
    if (similarity >= DUPLICATE_THRESHOLD) {
      return {
        isDuplicate: true,
        existingMission: mission.id,
        similarity: (similarity * 100).toFixed(0),
      };
    }
  }
  return { isDuplicate: false };
}

// ── Workspace Size Check ────────────────────────────────────────────────────

function checkWorkspaceSize(workspacePath) {
  if (!workspacePath || !fs.existsSync(workspacePath)) return { oversized: false };

  try {
    // Quick heuristic: count files, not total size (faster)
    let fileCount = 0;
    const MAX_FILES = 50000;
    const walkQuick = (dir, depth = 0) => {
      if (depth > 8 || fileCount > MAX_FILES) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        fileCount++;
        if (entry.isDirectory()) walkQuick(path.join(dir, entry.name), depth + 1);
      }
    };
    walkQuick(workspacePath);

    if (fileCount > MAX_FILES) {
      return {
        oversized: true,
        reason: `Workspace has ${fileCount}+ files — tasks may time out. Consider narrowing scope.`,
      };
    }
    return { oversized: false };
  } catch {
    return { oversized: false }; // can't check = don't block
  }
}

// ── Express Middleware ───────────────────────────────────────────────────────

/**
 * Safety guard middleware for mission/goal creation.
 * Mount on POST /api/projects/:id/goal and POST /api/missions.
 *
 * Returns 429 for rate limit, 409 for duplicate, 422 for impossible request.
 * Returns 200 with warning header for workspace size.
 */
export function safetyGuardMiddleware(getActiveMissions, getProject) {
  return (req, res, next) => {
    const projectId = req.params.id || req.body?.project_id;
    if (!projectId) return next(); // can't validate without project

    const goal = req.body?.goal || req.body?.title || req.body?.description || '';

    // 1. Impossible request detection
    const impossibleCheck = detectImpossibleRequest(goal);
    if (impossibleCheck.impossible) {
      return res.status(422).json({
        error: 'Request cannot be fulfilled',
        reason: impossibleCheck.reason,
        suggestion: 'Please rephrase with specific, measurable objectives',
        guard: 'impossible-request',
      });
    }

    // 2. Rate limit
    const currentRate = getRateCount(projectId);
    if (currentRate >= MAX_MISSIONS_PER_HOUR) {
      return res.status(429).json({
        error: 'Mission rate limit exceeded',
        reason: `Maximum ${MAX_MISSIONS_PER_HOUR} missions per hour per project`,
        suggestion: 'Wait for existing missions to complete, or combine related goals',
        guard: 'rate-limit',
        retryAfter: RATE_WINDOW_MS / 1000,
      });
    }

    // 3. Active mission cap
    const activeMissions = getActiveMissions(projectId);
    if (activeMissions.length >= MAX_ACTIVE_MISSIONS) {
      return res.status(429).json({
        error: 'Too many active missions',
        reason: `Maximum ${MAX_ACTIVE_MISSIONS} concurrent missions per project`,
        suggestion: 'Wait for some missions to complete before starting new ones',
        guard: 'active-cap',
      });
    }

    // 4. Duplicate detection
    const dupCheck = detectDuplicate(goal, activeMissions);
    if (dupCheck.isDuplicate) {
      return res.status(409).json({
        error: 'Duplicate mission detected',
        reason: `${dupCheck.similarity}% similar to existing mission ${dupCheck.existingMission}`,
        suggestion: 'The existing mission likely covers this goal. Check its progress first.',
        guard: 'duplicate',
        existingMission: dupCheck.existingMission,
      });
    }

    // 5. Workspace size warning (non-blocking)
    const project = getProject(projectId);
    if (project?.workspace) {
      const wsCheck = checkWorkspaceSize(project.workspace);
      if (wsCheck.oversized) {
        res.setHeader('X-Safety-Warning', wsCheck.reason);
      }
    }

    // All checks passed — record rate and continue
    recordMissionCreation(projectId);
    next();
  };
}

/**
 * Utility: explain why a guard was triggered (for UI toasts).
 */
export function explainGuard(guardType) {
  switch (guardType) {
    case 'rate-limit': return { icon: 'clock', color: 'yellow', action: 'Wait for existing work to finish' };
    case 'active-cap': return { icon: 'layers', color: 'yellow', action: 'Review and close completed missions' };
    case 'duplicate': return { icon: 'copy', color: 'blue', action: 'Check the existing mission\'s progress' };
    case 'impossible-request': return { icon: 'alert-triangle', color: 'red', action: 'Rephrase with specific objectives' };
    default: return { icon: 'info', color: 'gray', action: 'Contact support' };
  }
}
