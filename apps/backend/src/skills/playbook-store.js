// apps/backend/src/skills/playbook-store.js
//
// B3-01: Versioned Domain Playbooks
//
// Playbooks are deterministic, versioned workflow recipes for domain-critical tasks.
// They extend the existing skill system with:
//   - Explicit version tracking (semver-like major.minor)
//   - Prerequisites and required inputs
//   - Deterministic step sequences
//   - Validation checks and output schemas
//   - Compatibility tags and deprecation
//
// Storage: data/playbooks/{domain}/{name}@{version}.json
// Active index: data/playbooks/_index.json (maps domain+name → promoted version)

import fs from 'node:fs';
import path from 'node:path';

const PLAYBOOKS_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
  '../../data/playbooks'
);

const INDEX_FILE = path.join(PLAYBOOKS_DIR, '_index.json');

// ── Schema ──────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} PlaybookStep
 * @property {number} order
 * @property {string} action        - Tool name or agent instruction
 * @property {Object} params        - Static parameters
 * @property {string} [expectation] - What success looks like
 * @property {boolean} [critical]   - Failure halts playbook if true
 */

/**
 * @typedef {Object} Playbook
 * @property {string} id            - Unique: `${domain}/${name}`
 * @property {string} domain        - Category (e.g., "utas5", "web-dev", "testing")
 * @property {string} name          - Human-readable name
 * @property {string} version       - "major.minor" (e.g., "1.0", "2.3")
 * @property {string} status        - "draft" | "candidate" | "promoted" | "deprecated"
 * @property {string} description   - What this playbook does
 * @property {string[]} triggers    - Intent keywords/phrases that activate this playbook
 * @property {Object} prerequisites - { tools: string[], files: string[], env: string[] }
 * @property {Object} inputs        - { required: {name,type,desc}[], optional: {name,type,desc,default}[] }
 * @property {PlaybookStep[]} steps - Ordered execution steps
 * @property {Object[]} validations - Post-execution checks: { check, command?, expect }
 * @property {Object} outputSchema  - { fields: {name,type,desc}[] }
 * @property {string[]} compatTags  - Compatibility labels (e.g., "node20+", "windows")
 * @property {string|null} deprecatedBy - ID of replacement playbook if deprecated
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} promotedAt    - When last promoted (0 if never)
 * @property {Object} stats         - { runs: number, successes: number, failures: number, lastRun: number }
 */

// ── Internal helpers ────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadIndex() {
  if (!fs.existsSync(INDEX_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); }
  catch { return {}; }
}

function saveIndex(index) {
  ensureDir(PLAYBOOKS_DIR);
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

function playbookPath(domain, name, version) {
  return path.join(PLAYBOOKS_DIR, domain, `${name}@${version}.json`);
}

function loadPlaybook(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a new playbook (starts as "draft").
 */
export function createPlaybook({ domain, name, description, triggers, prerequisites, inputs, steps, validations, outputSchema, compatTags }) {
  const id = `${domain}/${name}`;
  const version = '1.0';
  const now = Date.now();

  const playbook = {
    id,
    domain,
    name,
    version,
    status: 'draft',
    description: description || '',
    triggers: triggers || [],
    prerequisites: { tools: [], files: [], env: [], ...(prerequisites || {}) },
    inputs: { required: [], optional: [], ...(inputs || {}) },
    steps: (steps || []).map((s, i) => ({ order: i + 1, action: s.action, params: s.params || {}, expectation: s.expectation || null, critical: s.critical !== false })),
    validations: validations || [],
    outputSchema: outputSchema || { fields: [] },
    compatTags: compatTags || [],
    deprecatedBy: null,
    createdAt: now,
    updatedAt: now,
    promotedAt: 0,
    stats: { runs: 0, successes: 0, failures: 0, lastRun: 0 },
  };

  const fp = playbookPath(domain, name, version);
  ensureDir(path.dirname(fp));
  fs.writeFileSync(fp, JSON.stringify(playbook, null, 2));

  return playbook;
}

/**
 * Create a new version of an existing playbook (copies from previous, bumps minor).
 */
export function createNewVersion(domain, name, changes = {}) {
  const index = loadIndex();
  const key = `${domain}/${name}`;
  const currentVersion = index[key]?.version || '1.0';
  const [major, minor] = currentVersion.split('.').map(Number);
  const newVersion = `${major}.${minor + 1}`;

  // Load current promoted or latest
  const current = loadPlaybook(playbookPath(domain, name, currentVersion));
  if (!current) throw new Error(`Playbook ${key}@${currentVersion} not found`);

  const now = Date.now();
  const updated = {
    ...current,
    ...changes,
    version: newVersion,
    status: 'draft',
    updatedAt: now,
    promotedAt: 0,
    stats: { runs: 0, successes: 0, failures: 0, lastRun: 0 },
  };
  // Preserve identity
  updated.id = key;
  updated.domain = domain;
  updated.name = name;

  const fp = playbookPath(domain, name, newVersion);
  ensureDir(path.dirname(fp));
  fs.writeFileSync(fp, JSON.stringify(updated, null, 2));

  return updated;
}

/**
 * Promote a playbook version → becomes the active version for its domain/name.
 * Only promotable if status is "candidate" (enforced by regression harness).
 */
export function promotePlaybook(domain, name, version) {
  const fp = playbookPath(domain, name, version);
  const playbook = loadPlaybook(fp);
  if (!playbook) throw new Error(`Playbook ${domain}/${name}@${version} not found`);
  if (playbook.status !== 'candidate') {
    throw new Error(`Cannot promote ${domain}/${name}@${version} — status is "${playbook.status}", must be "candidate"`);
  }

  const now = Date.now();
  playbook.status = 'promoted';
  playbook.promotedAt = now;
  playbook.updatedAt = now;
  fs.writeFileSync(fp, JSON.stringify(playbook, null, 2));

  // Update index
  const index = loadIndex();
  const key = `${domain}/${name}`;

  // Deprecate previous promoted version
  if (index[key]) {
    const prevFp = playbookPath(domain, name, index[key].version);
    const prev = loadPlaybook(prevFp);
    if (prev && prev.status === 'promoted') {
      prev.status = 'deprecated';
      prev.deprecatedBy = `${key}@${version}`;
      prev.updatedAt = now;
      fs.writeFileSync(prevFp, JSON.stringify(prev, null, 2));
    }
  }

  index[key] = { version, promotedAt: now };
  saveIndex(index);

  return playbook;
}

/**
 * Mark a draft playbook as "candidate" (ready for regression testing).
 */
export function markCandidate(domain, name, version) {
  const fp = playbookPath(domain, name, version);
  const playbook = loadPlaybook(fp);
  if (!playbook) throw new Error(`Playbook ${domain}/${name}@${version} not found`);
  if (playbook.status !== 'draft') {
    throw new Error(`Cannot mark ${domain}/${name}@${version} as candidate — status is "${playbook.status}"`);
  }

  playbook.status = 'candidate';
  playbook.updatedAt = Date.now();
  fs.writeFileSync(fp, JSON.stringify(playbook, null, 2));
  return playbook;
}

/**
 * Get the promoted (active) version of a playbook by domain/name.
 */
export function getPromotedPlaybook(domain, name) {
  const index = loadIndex();
  const key = `${domain}/${name}`;
  if (!index[key]) return null;
  return loadPlaybook(playbookPath(domain, name, index[key].version));
}

/**
 * Get a specific version of a playbook.
 */
export function getPlaybook(domain, name, version) {
  return loadPlaybook(playbookPath(domain, name, version));
}

/**
 * List all playbooks, optionally filtered by domain and/or status.
 */
export function listPlaybooks({ domain, status } = {}) {
  if (!fs.existsSync(PLAYBOOKS_DIR)) return [];

  const results = [];
  const domains = domain
    ? [domain]
    : fs.readdirSync(PLAYBOOKS_DIR).filter(d => !d.startsWith('_') && fs.statSync(path.join(PLAYBOOKS_DIR, d)).isDirectory());

  for (const d of domains) {
    const dir = path.join(PLAYBOOKS_DIR, d);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const pb = loadPlaybook(path.join(dir, file));
      if (!pb) continue;
      if (status && pb.status !== status) continue;
      results.push(pb);
    }
  }

  return results;
}

/**
 * Record a playbook execution result (updates stats).
 */
export function recordPlaybookRun(domain, name, version, success) {
  const fp = playbookPath(domain, name, version);
  const playbook = loadPlaybook(fp);
  if (!playbook) return null;

  playbook.stats.runs++;
  if (success) playbook.stats.successes++;
  else playbook.stats.failures++;
  playbook.stats.lastRun = Date.now();
  playbook.updatedAt = Date.now();

  fs.writeFileSync(fp, JSON.stringify(playbook, null, 2));
  return playbook.stats;
}

/**
 * Get stale playbooks that haven't been reviewed/run in a while.
 * Used by scheduled review mechanism.
 */
export function getStalePlaybooks(maxAgeDays = 30) {
  const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60_000);
  return listPlaybooks({ status: 'promoted' })
    .filter(pb => pb.stats.lastRun < cutoff || pb.updatedAt < cutoff);
}

/**
 * Deprecate a playbook with optional replacement reference.
 */
export function deprecatePlaybook(domain, name, version, replacedBy = null) {
  const fp = playbookPath(domain, name, version);
  const playbook = loadPlaybook(fp);
  if (!playbook) throw new Error(`Playbook ${domain}/${name}@${version} not found`);

  playbook.status = 'deprecated';
  playbook.deprecatedBy = replacedBy;
  playbook.updatedAt = Date.now();
  fs.writeFileSync(fp, JSON.stringify(playbook, null, 2));

  // Remove from index if it was promoted
  const index = loadIndex();
  const key = `${domain}/${name}`;
  if (index[key]?.version === version) {
    delete index[key];
    saveIndex(index);
  }

  return playbook;
}
