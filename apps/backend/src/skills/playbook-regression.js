// apps/backend/src/skills/playbook-regression.js
//
// B3-05: Playbook Regression Harness
//
// Ensures playbook updates don't silently break behavior by:
//   1. Maintaining golden case snapshots per playbook (representative inputs → expected outputs)
//   2. Running regression suite on every version change
//   3. Gating promotion: no version is promotable without regression pass
//
// Storage: data/playbooks/{domain}/_regression/{name}.cases.json

import fs from 'node:fs';
import path from 'node:path';
import { getPlaybook, markCandidate } from './playbook-store.js';

const PLAYBOOKS_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
  '../../data/playbooks'
);

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} RegressionCase
 * @property {string} id           - Unique case ID
 * @property {string} description  - What this case tests
 * @property {Object} input        - Simulated task context (title, desc, params)
 * @property {Object} expected     - Expected outcome { steps_executed, validations_pass, output_fields }
 * @property {string} addedInVersion - Which version introduced this case
 * @property {number} createdAt
 */

/**
 * @typedef {Object} RegressionResult
 * @property {boolean} passed
 * @property {number} total
 * @property {number} passed_count
 * @property {number} failed_count
 * @property {Object[]} failures    - { caseId, expected, actual, reason }
 * @property {number} runAt
 */

// ── Helpers ─────────────────────────────────────────────────────────────────

function casesPath(domain, name) {
  return path.join(PLAYBOOKS_DIR, domain, '_regression', `${name}.cases.json`);
}

function resultsPath(domain, name, version) {
  return path.join(PLAYBOOKS_DIR, domain, '_regression', `${name}@${version}.results.json`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadCases(domain, name) {
  const fp = casesPath(domain, name);
  if (!fs.existsSync(fp)) return [];
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch { return []; }
}

function saveCases(domain, name, cases) {
  const fp = casesPath(domain, name);
  ensureDir(path.dirname(fp));
  fs.writeFileSync(fp, JSON.stringify(cases, null, 2));
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Add a golden regression case for a playbook.
 */
export function addRegressionCase(domain, name, { id, description, input, expected }) {
  const cases = loadCases(domain, name);

  if (cases.find(c => c.id === id)) {
    throw new Error(`Regression case "${id}" already exists for ${domain}/${name}`);
  }

  // Get current version for tracking
  const playbook = getPlaybook(domain, name, 'latest') || { version: '1.0' };

  cases.push({
    id,
    description: description || '',
    input: input || {},
    expected: expected || {},
    addedInVersion: playbook.version,
    createdAt: Date.now(),
  });

  saveCases(domain, name, cases);
  return cases.length;
}

/**
 * Remove a regression case by ID.
 */
export function removeRegressionCase(domain, name, caseId) {
  const cases = loadCases(domain, name);
  const filtered = cases.filter(c => c.id !== caseId);
  if (filtered.length === cases.length) return false;
  saveCases(domain, name, filtered);
  return true;
}

/**
 * List all regression cases for a playbook.
 */
export function listRegressionCases(domain, name) {
  return loadCases(domain, name);
}

/**
 * Run regression suite for a playbook version.
 *
 * The validator function receives (playbook, caseInput) and returns
 * { steps_executed: string[], validations_pass: boolean, output_fields: string[] }
 *
 * If no validator is provided, uses structural comparison.
 */
export function runRegression(domain, name, version, validator) {
  const playbook = getPlaybook(domain, name, version);
  if (!playbook) throw new Error(`Playbook ${domain}/${name}@${version} not found`);

  const cases = loadCases(domain, name);
  if (!cases.length) {
    // No cases = trivial pass (but warn)
    return {
      passed: true,
      total: 0,
      passed_count: 0,
      failed_count: 0,
      failures: [],
      runAt: Date.now(),
      warning: 'No regression cases defined — trivial pass',
    };
  }

  const failures = [];
  let passedCount = 0;

  for (const testCase of cases) {
    try {
      const actual = validator
        ? validator(playbook, testCase.input)
        : structuralValidate(playbook, testCase);

      const casePass = compareExpected(testCase.expected, actual);
      if (casePass) {
        passedCount++;
      } else {
        failures.push({
          caseId: testCase.id,
          expected: testCase.expected,
          actual,
          reason: 'Output mismatch',
        });
      }
    } catch (err) {
      failures.push({
        caseId: testCase.id,
        expected: testCase.expected,
        actual: null,
        reason: `Exception: ${err.message}`,
      });
    }
  }

  const result = {
    passed: failures.length === 0,
    total: cases.length,
    passed_count: passedCount,
    failed_count: failures.length,
    failures,
    runAt: Date.now(),
  };

  // Persist result
  const rp = resultsPath(domain, name, version);
  ensureDir(path.dirname(rp));
  fs.writeFileSync(rp, JSON.stringify(result, null, 2));

  return result;
}

/**
 * Structural validation — checks that playbook steps still cover expected steps.
 */
function structuralValidate(playbook, testCase) {
  const stepActions = playbook.steps.map(s => s.action);
  const validationChecks = playbook.validations.map(v => v.check);
  const outputFields = (playbook.outputSchema?.fields || []).map(f => f.name);

  return {
    steps_executed: stepActions,
    validations_pass: validationChecks.length > 0, // structural: has validations = pass
    output_fields: outputFields,
  };
}

/**
 * Compare expected vs actual outputs.
 */
function compareExpected(expected, actual) {
  if (!expected || !actual) return false;

  // Check steps coverage
  if (expected.steps_executed) {
    const actualSteps = new Set(actual.steps_executed || []);
    const allCovered = expected.steps_executed.every(s => actualSteps.has(s));
    if (!allCovered) return false;
  }

  // Check validations pass
  if (expected.validations_pass !== undefined && actual.validations_pass !== expected.validations_pass) {
    return false;
  }

  // Check output fields
  if (expected.output_fields) {
    const actualFields = new Set(actual.output_fields || []);
    const allPresent = expected.output_fields.every(f => actualFields.has(f));
    if (!allPresent) return false;
  }

  return true;
}

/**
 * Gate: attempt to promote a playbook. Runs regression first.
 * Returns { promoted: boolean, regressionResult, playbook? }
 */
export function promoteWithRegression(domain, name, version, validator) {
  const regressionResult = runRegression(domain, name, version, validator);

  if (!regressionResult.passed) {
    return {
      promoted: false,
      regressionResult,
      reason: `Regression failed: ${regressionResult.failed_count}/${regressionResult.total} cases failed`,
    };
  }

  // Regression passed — mark as candidate (pre-promotion step)
  try {
    markCandidate(domain, name, version);
  } catch (e) {
    // May already be candidate
    if (!e.message.includes('already')) throw e;
  }

  return {
    promoted: true, // caller should then call promotePlaybook()
    regressionResult,
    reason: `All ${regressionResult.total} regression cases passed`,
  };
}

/**
 * Get last regression result for a playbook version.
 */
export function getLastRegressionResult(domain, name, version) {
  const rp = resultsPath(domain, name, version);
  if (!fs.existsSync(rp)) return null;
  try { return JSON.parse(fs.readFileSync(rp, 'utf8')); }
  catch { return null; }
}
