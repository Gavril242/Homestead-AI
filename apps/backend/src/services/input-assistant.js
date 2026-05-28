// apps/backend/src/services/input-assistant.js
//
// B4-03: Input Contract Assistant
//
// Lightweight intent clarification for ambiguous user asks:
//   1. Extract entities, outputs, and constraints from goal text
//   2. Score ambiguity based on missing critical elements
//   3. If ambiguity above threshold, generate ONE targeted clarification question
//   4. Skip prompt when confidence is high
//
// Reduces downstream drift and retries by ensuring missions start with clear inputs.

// ── Configuration ───────────────────────────────────────────────────────────

const AMBIGUITY_THRESHOLD = 0.6; // 0-1 scale; above this we ask for clarification
const MAX_CLARIFICATION_QUESTIONS = 1; // Never ask more than 1 question

// ── Entity Extraction ───────────────────────────────────────────────────────

const ENTITY_PATTERNS = {
  files: /(?:file|path|module|component)s?\s*[:=]?\s*["`']?([^\s"`',]+)/gi,
  urls: /https?:\/\/[^\s)]+/gi,
  commands: /(?:run|execute|call)\s+["`']?([^\s"`']+)/gi,
  technologies: /\b(react|node|python|docker|express|typescript|sql|postgres|redis|nginx|webpack|vite|jest|mocha)\b/gi,
  outputs: /(?:create|generate|produce|output|write|build)\s+(?:a\s+)?([^.,;]+)/gi,
  targets: /(?:in|on|at|for|to)\s+(?:the\s+)?([A-Za-z][\w\-./]+(?:\.[a-z]+)?)/g,
};

/**
 * Extract structured entities from goal text.
 */
export function extractEntities(text) {
  const entities = {
    files: [],
    urls: [],
    commands: [],
    technologies: [],
    outputs: [],
    targets: [],
  };

  for (const [key, pattern] of Object.entries(ENTITY_PATTERNS)) {
    const matches = [...(text.matchAll(new RegExp(pattern.source, pattern.flags)))];
    entities[key] = [...new Set(matches.map(m => (m[1] || m[0]).trim()))].slice(0, 5);
  }

  return entities;
}

// ── Constraint Extraction ───────────────────────────────────────────────────

const CONSTRAINT_SIGNALS = [
  { pattern: /must\s+not|should\s+not|don'?t|avoid|never|without/i, type: 'negative' },
  { pattern: /must|should|require|need|has\s+to|mandatory/i, type: 'positive' },
  { pattern: /by|before|deadline|within|limit|maximum|timeout/i, type: 'temporal' },
  { pattern: /only|exactly|specific|particular|just\s+the/i, type: 'scope' },
];

export function extractConstraints(text) {
  const constraints = [];
  for (const { pattern, type } of CONSTRAINT_SIGNALS) {
    if (pattern.test(text)) {
      const match = text.match(new RegExp(`(${pattern.source}[^.;!?]{3,60})`, 'i'));
      if (match) constraints.push({ type, text: match[1].trim() });
    }
  }
  return constraints;
}

// ── Ambiguity Scoring ───────────────────────────────────────────────────────

/**
 * Score how ambiguous a goal is. 0 = crystal clear, 1 = totally unclear.
 *
 * Factors:
 *   - No output/deliverable mentioned → +0.3
 *   - No target location (file/path) → +0.2
 *   - Very short text → +0.2
 *   - No technology context → +0.1
 *   - No constraints → +0.1
 *   - Vague words ("something", "stuff", "things", "it") → +0.1
 */
export function scoreAmbiguity(text, entities, constraints) {
  let score = 0;

  // No output mentioned
  if (!entities.outputs.length && !/create|build|write|fix|update|deploy|test|delete|configure/i.test(text)) {
    score += 0.3;
  }

  // No target
  if (!entities.files.length && !entities.targets.length) {
    score += 0.2;
  }

  // Very short
  if (text.trim().split(/\s+/).length < 8) {
    score += 0.2;
  }

  // No technology context
  if (!entities.technologies.length) {
    score += 0.1;
  }

  // No constraints
  if (!constraints.length) {
    score += 0.1;
  }

  // Vague language
  if (/\b(something|stuff|things?|it|that|this|whatever|somehow)\b/i.test(text)) {
    score += 0.1;
  }

  return Math.min(score, 1.0);
}

// ── Clarification Generation ────────────────────────────────────────────────

/**
 * Generate a single targeted clarification question based on what's missing.
 */
function generateClarification(text, entities, constraints, ambiguityScore) {
  // Priority order: most impactful missing info first
  if (!entities.outputs.length && !/create|build|write|fix|update|deploy|test|delete|configure/i.test(text)) {
    return {
      question: 'What specific output or deliverable should this produce?',
      hint: 'e.g., "a new React component", "updated config file", "test results"',
      missing: 'output',
    };
  }

  if (!entities.files.length && !entities.targets.length) {
    return {
      question: 'Where should this change be made? (file, directory, or component)',
      hint: 'e.g., "src/api/auth.js", "the login page", "docker-compose.yml"',
      missing: 'target',
    };
  }

  if (text.trim().split(/\s+/).length < 8) {
    return {
      question: 'Can you describe what you need in a bit more detail?',
      hint: 'A sentence or two about what the end result should look like',
      missing: 'detail',
    };
  }

  if (!entities.technologies.length) {
    return {
      question: 'What technology or framework is this for?',
      hint: 'e.g., "React frontend", "Node.js backend", "Docker setup"',
      missing: 'technology',
    };
  }

  // Generic fallback
  return {
    question: 'What does "done" look like for this task? (acceptance criteria)',
    hint: 'How will we know it worked? e.g., "tests pass", "page loads without errors"',
    missing: 'acceptance',
  };
}

// ── Main API ────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} InputAnalysis
 * @property {number} ambiguity         - 0-1 score
 * @property {boolean} needsClarification
 * @property {Object|null} clarification - { question, hint, missing }
 * @property {Object} entities          - Extracted entities
 * @property {Object[]} constraints     - Extracted constraints
 * @property {string} confidence        - 'high' | 'medium' | 'low'
 */

/**
 * Analyze a user goal and determine if clarification is needed.
 * Returns analysis object — caller decides whether to prompt user.
 */
export function analyzeInput(goalText) {
  const text = (goalText || '').trim();

  if (!text) {
    return {
      ambiguity: 1.0,
      needsClarification: true,
      clarification: { question: 'What would you like to accomplish?', hint: 'Describe your goal in a sentence or two', missing: 'everything' },
      entities: { files: [], urls: [], commands: [], technologies: [], outputs: [], targets: [] },
      constraints: [],
      confidence: 'low',
    };
  }

  const entities = extractEntities(text);
  const constraints = extractConstraints(text);
  const ambiguity = scoreAmbiguity(text, entities, constraints);
  const needsClarification = ambiguity >= AMBIGUITY_THRESHOLD;

  const clarification = needsClarification
    ? generateClarification(text, entities, constraints, ambiguity)
    : null;

  const confidence = ambiguity < 0.3 ? 'high' : ambiguity < 0.6 ? 'medium' : 'low';

  return {
    ambiguity,
    needsClarification,
    clarification,
    entities,
    constraints,
    confidence,
  };
}

/**
 * Enrich a goal with extracted context (for downstream use in conductor pipeline).
 * Called when confidence is high enough to proceed without clarification.
 */
export function enrichGoal(goalText, analysis) {
  const enriched = {
    originalGoal: goalText,
    entities: analysis.entities,
    constraints: analysis.constraints,
    confidence: analysis.confidence,
  };

  // Build structured hints for the conductor
  if (analysis.entities.technologies.length) {
    enriched.techContext = analysis.entities.technologies;
  }
  if (analysis.entities.files.length || analysis.entities.targets.length) {
    enriched.targets = [...analysis.entities.files, ...analysis.entities.targets];
  }
  if (analysis.constraints.length) {
    enriched.constraintSummary = analysis.constraints.map(c => c.text).join('; ');
  }

  return enriched;
}
