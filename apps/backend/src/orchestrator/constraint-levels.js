// Gavirila Homestead — Adaptive Constraint Ladder (B2-03)
// Formalizes deterministic adaptation levels for task execution.
// Advances only with evidence of failure at current level.

/**
 * Constraint levels (1-4):
 *   L1: Strict method — exact approach prescribed in task desc
 *   L2: Equivalent method — alternative tool/approach allowed if same output
 *   L3: Decomposition — task can be broken into sub-tasks
 *   L4: Human decision — escalate with options
 */
export const CONSTRAINT_LEVELS = {
  1: {
    name: 'strict',
    label: 'Strict Method',
    description: 'Execute exactly as prescribed. Use only the tools and approach specified.',
    max_attempts_at_level: 2,
    allowed_adaptations: [],
  },
  2: {
    name: 'equivalent',
    label: 'Equivalent Method',
    description: 'The prescribed method failed. You may use an alternative tool or approach that produces the SAME output.',
    max_attempts_at_level: 2,
    allowed_adaptations: ['alternative-tool', 'different-command', 'reorder-steps'],
  },
  3: {
    name: 'decomposition',
    label: 'Decomposition Allowed',
    description: 'Direct execution failed at multiple levels. Break this task into smaller sub-tasks if needed. Create child tasks with db_create_task.',
    max_attempts_at_level: 2,
    allowed_adaptations: ['alternative-tool', 'different-command', 'reorder-steps', 'decompose', 'skip-optional'],
  },
  4: {
    name: 'human-decision',
    label: 'Human Decision Required',
    description: 'All automated approaches exhausted. Present findings and options to the human.',
    max_attempts_at_level: 1,
    allowed_adaptations: ['escalate'],
  },
};

/**
 * Determine if a task should advance to the next constraint level.
 *
 * @param {object} task - Current task state
 * @returns {{ advance: boolean, nextLevel: number|null, reason: string|null }}
 */
export function shouldAdvanceLevel(task) {
  const currentLevel = task.constraint_level || 1;
  const levelConfig = CONSTRAINT_LEVELS[currentLevel];
  if (!levelConfig) return { advance: false, nextLevel: null, reason: null };

  // Count failures at current level
  const failuresAtLevel = (task.level_attempts || [])
    .filter(a => a.level === currentLevel && a.outcome === 'failed')
    .length;

  if (failuresAtLevel >= levelConfig.max_attempts_at_level) {
    const nextLevel = currentLevel + 1;
    if (nextLevel > 4) {
      return { advance: false, nextLevel: null, reason: 'All levels exhausted' };
    }
    return {
      advance: true,
      nextLevel,
      reason: `Failed ${failuresAtLevel}x at L${currentLevel} (${levelConfig.name}) — advancing to L${nextLevel} (${CONSTRAINT_LEVELS[nextLevel].name})`,
    };
  }

  return { advance: false, nextLevel: null, reason: null };
}

/**
 * Record a level attempt outcome on a task.
 *
 * @param {object} task - Task to update (mutable reference or provide for patch)
 * @param {'success'|'failed'} outcome
 * @param {string} [errorSummary]
 * @returns {object} Updated level_attempts array
 */
export function recordLevelAttempt(task, outcome, errorSummary = '') {
  const currentLevel = task.constraint_level || 1;
  const attempts = [...(task.level_attempts || []), {
    level: currentLevel,
    outcome,
    error: errorSummary.slice(0, 200),
    ts: Date.now(),
  }];
  return attempts;
}

/**
 * Build the constraint injection for the agent's mission briefing.
 *
 * @param {object} task
 * @returns {string} Constraint block to inject into mission
 */
export function buildConstraintBlock(task) {
  const level = task.constraint_level || 1;
  const config = CONSTRAINT_LEVELS[level];
  if (!config) return '';

  const lines = [
    `\n═══ CONSTRAINT LEVEL: L${level} — ${config.label} ═══`,
    config.description,
  ];

  if (level >= 2) {
    const prevAttempts = (task.level_attempts || [])
      .filter(a => a.level < level && a.outcome === 'failed')
      .slice(-3);
    if (prevAttempts.length) {
      lines.push(`\nPrevious approaches that FAILED (do NOT repeat):`)
      for (const a of prevAttempts) {
        lines.push(`  • L${a.level}: ${a.error || 'unknown error'}`);
      }
    }
  }

  if (config.allowed_adaptations.length) {
    lines.push(`\nAllowed adaptations: ${config.allowed_adaptations.join(', ')}`);
  }

  return lines.join('\n');
}
