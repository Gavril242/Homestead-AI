// Strict DAG state machine for task statuses.
// Replaces loose status transitions with a validated transition graph.

const TRANSITIONS = {
  'queued':           ['running', 'cancelled', 'claimed'],
  'claimed':          ['running', 'verifying', 'resumable_error', 'queued', 'cancelled'],
  'running':          ['queued', 'done', 'failed', 'review', 'needs-human', 'needs-info', 'blocked', 'verifying', 'resumable_error', 'waiting_on_network', 'tribunal'],
  'blocked':          ['queued', 'cancelled'],
  'review':           ['done', 'failed', 'queued', 'verifying', 'tribunal'],
  'needs-human':      ['queued', 'cancelled', 'done', 'tribunal'],
  'verifying':        ['done', 'failed', 'review', 'queued'],
  'resumable_error':  ['queued', 'cancelled'],
  'waiting_on_network': ['queued', 'cancelled'],
  'failed':           ['queued', 'cancelled', 'tribunal'],
  'tribunal':         ['queued', 'review', 'needs-human', 'done', 'cancelled'],
  'needs-info':       ['queued', 'cancelled', 'needs-human'],
  'done':             ['queued', 'needs-human', 'tribunal'],
  'cancelled':        [],
};

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

export function assertTransition(from, to, context = '') {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid status transition: ${from} → ${to}${context ? ` (${context})` : ''}`);
  }
}

export function nextStates(current) {
  return TRANSITIONS[current] || [];
}

export function validateHistory(statuses) {
  for (let i = 1; i < statuses.length; i++) {
    if (!canTransition(statuses[i - 1], statuses[i])) {
      return { valid: false, failedAt: i, from: statuses[i - 1], to: statuses[i] };
    }
  }
  return { valid: true };
}
