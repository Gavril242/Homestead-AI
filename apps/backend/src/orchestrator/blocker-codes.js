// Gavirila Homestead — Canonical Blocker Reason Taxonomy (B1-06)
// Every blocked task MUST carry one of these codes with structured explanations.

export const BLOCKER_CODES = {
  'dependency-missing': {
    short: 'Missing dependency',
    long: 'One or more upstream task IDs referenced in depends_on do not exist in the database.',
    remediation: 'Verify dependency IDs. If the task was deleted or renamed, rewire or remove the dependency.',
  },
  'dependency-failed': {
    short: 'Dependency failed',
    long: 'An upstream dependency has permanently failed or been cancelled — downstream work cannot proceed.',
    remediation: 'Retry the failed dependency, create a replacement task, or remove the dependency if no longer needed.',
  },
  'dependency-cyclic': {
    short: 'Circular dependency',
    long: 'A dependency cycle was detected — tasks reference each other directly or transitively.',
    remediation: 'Break the cycle by removing the weakest dependency link or restructuring the task graph.',
  },
  'dependency-stale': {
    short: 'Stale dependency',
    long: 'An upstream dependency is stuck in a terminal non-done state (needs-human, review) for too long.',
    remediation: 'Resolve the upstream task (approve, retry, or cancel) to unblock downstream work.',
  },
  'workspace-invalid': {
    short: 'Workspace inaccessible',
    long: 'The project workspace path does not exist or is not writable.',
    remediation: 'Verify the project workspace path exists and has correct permissions.',
  },
  'permission-denied': {
    short: 'Permission denied',
    long: 'The agent lacks required permissions to perform the task (tool scope, file access, etc.).',
    remediation: 'Check agent tool scopes and workspace permissions.',
  },
  'validation-failed': {
    short: 'Validation failed',
    long: 'One or more completion gates failed — required outputs missing, acceptance commands failed, or no substantive work recorded.',
    remediation: 'Review the failing gates and address each failure before re-attempting completion.',
  },
  'execution-stalled': {
    short: 'Execution stalled',
    long: 'The task stopped making verifiable progress or stopped emitting runner heartbeats while still marked active.',
    remediation: 'Inspect the latest heartbeat, progress summary, and artifacts. Retry with a changed approach or escalate to a human if execution cannot resume safely.',
  },
  'tool-unavailable': {
    short: 'Required tool unavailable',
    long: 'A tool required for task execution is not available in the current environment.',
    remediation: 'Install or enable the required tool, or reassign to an agent with access.',
  },
  'human-decision-required': {
    short: 'Human decision required',
    long: 'The system cannot automatically resolve this blocker — human input is needed to choose a path forward.',
    remediation: 'Review the provided options and make a decision to unblock execution.',
  },
  'unknown-blocker': {
    short: 'Unknown blocker',
    long: 'The task is blocked for an unclassified reason.',
    remediation: 'Inspect task history and error fields for additional context.',
  },
};

/**
 * Create a structured blocked_reason object.
 * @param {string} code - One of the BLOCKER_CODES keys
 * @param {object} [extra] - Additional context (dep_ids, gates_failed, choices, etc.)
 * @returns {{ code, short, long, remediation, ...extra }}
 */
export function createBlockedReason(code, extra = {}) {
  const base = BLOCKER_CODES[code] || BLOCKER_CODES['unknown-blocker'];
  return {
    code: BLOCKER_CODES[code] ? code : 'unknown-blocker',
    short: base.short,
    long: base.long,
    remediation: base.remediation,
    ts: Date.now(),
    ...extra,
  };
}

/**
 * Classify a dependency fault into a blocker code.
 * @param {'missing'|'failed'|'cyclic'|'stale'|'cancelled'} faultType
 * @returns {string} blocker code
 */
export function classifyDepFault(faultType) {
  switch (faultType) {
    case 'missing':   return 'dependency-missing';
    case 'failed':    return 'dependency-failed';
    case 'cancelled': return 'dependency-failed';
    case 'cyclic':    return 'dependency-cyclic';
    case 'stale':     return 'dependency-stale';
    default:          return 'unknown-blocker';
  }
}
