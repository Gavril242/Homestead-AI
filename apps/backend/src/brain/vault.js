// Obsidian-style markdown brain.
//
//   data/vault/
//     projects/Afeela-SHM.md       <- frontmatter: links to reqs, components, runs
//     reqs/REQ-SHM-0142.md         <- frontmatter: tested-by, implemented-by
//     components/Shm_Swc.md        <- frontmatter: implements, owned-by
//     tests/TC-SHM-212.md          <- frontmatter: verifies
//     decisions/ADR-017-...md
//     runs/HIL-2026-04-25-bench3.md
//     agents/Aria.md               <- per-agent persistent memory
//     bugs/B-9821.md
//
// Every note has a YAML frontmatter block declaring its `links:`. The
// graph is derived FROM the vault — that's the only source of truth.
// `impactOf(noteId)` walks the graph forward to answer "what breaks if
// I change this?" — which is the heart of the user's "modify X without
// breaking Y" requirement.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_VAULT = path.resolve(__dirname, '..', '..', 'data', 'vault');

export function vaultRoot() {
  return process.env.VAULT_PATH || DEFAULT_VAULT;
}

export function ensureVault() {
  const root = vaultRoot();
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  for (const sub of ['projects', 'reqs', 'components', 'tests', 'decisions', 'runs', 'agents', 'bugs']) {
    const p = path.join(root, sub);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }
}

// minimal YAML frontmatter parser — string scalars, list-of-strings, simple keys.
// Good enough for our shape; punt to gray-matter once deps allow.
export function parseNote(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: raw };
  const fm = {};
  const lines = m[1].split('\n');
  let key = null;
  for (const ln of lines) {
    if (!ln.trim()) continue;
    const list = ln.match(/^\s*-\s*(.+?)\s*$/);
    if (list && key) { if (!Array.isArray(fm[key])) fm[key] = fm[key] ? [fm[key]] : []; fm[key].push(stripQuotes(list[1])); continue; }
    const kv = ln.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kv) {
      key = kv[1];
      const val = kv[2].trim();
      if (val === '') fm[key] = [];                     // list follows on next lines
      else            fm[key] = stripQuotes(val);
    }
  }
  return { frontmatter: fm, body: m[2] };
}

function stripQuotes(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

export function serializeNote({ frontmatter, body }) {
  const fmLines = [];
  for (const [k, v] of Object.entries(frontmatter || {})) {
    if (Array.isArray(v)) {
      fmLines.push(`${k}:`);
      for (const item of v) fmLines.push(`  - "${String(item).replace(/"/g, '\\"')}"`);
    } else if (v !== undefined && v !== null) {
      fmLines.push(`${k}: "${String(v).replace(/"/g, '\\"')}"`);
    }
  }
  return `---\n${fmLines.join('\n')}\n---\n${body || ''}`;
}

export function writeNote(relPath, { frontmatter, body }) {
  ensureVault();
  const full = path.join(vaultRoot(), relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, serializeNote({ frontmatter, body }));
  return full;
}

export function readNote(relPath) {
  const full = path.join(vaultRoot(), relPath);
  if (!fs.existsSync(full)) return null;
  const raw = fs.readFileSync(full, 'utf8');
  return { ...parseNote(raw), path: relPath };
}

export function listNotes(subdir = '') {
  ensureVault();
  const base = path.join(vaultRoot(), subdir);
  if (!fs.existsSync(base)) return [];
  const out = [];
  walk(base, (full) => {
    if (full.endsWith('.md')) {
      out.push(path.relative(vaultRoot(), full));
    }
  });
  return out;
}

function walk(dir, fn) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, fn);
    else fn(full);
  }
}

/** Write raw markdown content directly to the vault (bypasses serializeNote). */
function writeRawNote(relPath, content) {
  ensureVault();
  const full = path.join(vaultRoot(), relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

// Build the link graph by scanning every note's frontmatter.
// Returns { nodes: [{id, path, kind, title}], edges: [{from, to, kind}] }.
export function buildGraph() {
  ensureVault();
  const nodes = [];
  const edges = [];
  for (const rel of listNotes()) {
    const note = readNote(rel);
    if (!note) continue;
    const id = note.frontmatter.id || path.basename(rel, '.md');
    nodes.push({
      id,
      path: rel,
      kind: rel.split('/')[0],
      title: note.frontmatter.title || id,
    });
    for (const [linkKind, val] of Object.entries(note.frontmatter)) {
      if (!Array.isArray(val)) continue;
      if (!['tested-by', 'verifies', 'implements', 'implemented-by',
            'depends-on', 'owns', 'owned-by', 'links', 'satisfies',
            'broken-by', 'fixed-by',
            'blocks', 'blocked-by'].includes(linkKind)) continue;
      for (const target of val) edges.push({ from: id, to: target, kind: linkKind });
    }
  }
  return { nodes, edges };
}

// "If I change X, what could break?" — walk forward over the graph
// following the kinds that imply downstream consumption.
export function impactOf(nodeId, maxDepth = 3) {
  const { edges } = buildGraph();
  const FORWARD = new Set(['tested-by', 'implemented-by', 'depends-on', 'owns']);
  const seen = new Set([nodeId]);
  const out = [];
  let frontier = [nodeId];
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const cur of frontier) {
      for (const e of edges) {
        if (e.from !== cur || !FORWARD.has(e.kind)) continue;
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        out.push({ ...e, depth: d + 1 });
        next.push(e.to);
      }
    }
    frontier = next;
  }
  return out;
}

// ── Typed note templates (Homestead 1.0) ─────────────────────────────────────

/**
 * Write a structured requirement note.
 */
export function writeReqNote(projectId, req) {
  const { id, title, problem = '', scope = '', nonGoals = '', acceptance = [], status = 'draft', owner = '' } = req;
  const noteId = `projects/${projectId}/requirements/${id}.md`;
  const content = `---
id: ${id}
type: requirement
project: ${projectId}
status: ${status}
owner: ${owner}
created: ${new Date().toISOString()}
---

# ${title}

## Problem Statement
${problem}

## Scope
${scope}

## Non-Goals
${nonGoals}

## Acceptance Criteria
${acceptance.map((a, i) => `${i + 1}. ${a}`).join('\n')}
`;
  writeRawNote(noteId, content);
  return noteId;
}

/**
 * Write a structured ADR (Architecture Decision Record).
 */
export function writeAdrNote(projectId, adr) {
  const { id, title, context = '', decision = '', consequences = '', status = 'proposed' } = adr;
  const noteId = `projects/${projectId}/decisions/${id}.md`;
  const content = `---
id: ${id}
type: adr
project: ${projectId}
status: ${status}
created: ${new Date().toISOString()}
---

# ADR: ${title}

## Context
${context}

## Decision
${decision}

## Consequences
${consequences}
`;
  writeRawNote(noteId, content);
  return noteId;
}

/**
 * Write a structured run note.
 */
export function writeRunNote(projectId, run) {
  const { runId, taskId, commands = [], exitCodes = [], outcome = '', artifacts = [] } = run;
  const noteId = `projects/${projectId}/runs/${runId}.md`;
  const content = `---
id: ${runId}
type: run
project: ${projectId}
task_id: ${taskId}
created: ${new Date().toISOString()}
---

# Run: ${runId}

## Task
${taskId}

## Commands Executed
${commands.map((c, i) => `\`\`\`\n$ ${c}\n# exit: ${exitCodes[i] ?? '?'}\n\`\`\``).join('\n\n')}

## Outcome
${outcome}

## Artifacts
${artifacts.map(a => `- ${a}`).join('\n')}
`;
  writeRawNote(noteId, content);
  return noteId;
}

/**
 * Write a structured bug note.
 */
export function writeBugNote(projectId, bug) {
  const { id, title, repro = '', rootCause = '', evidence = [], status = 'open' } = bug;
  const noteId = `projects/${projectId}/bugs/${id}.md`;
  const content = `---
id: ${id}
type: bug
project: ${projectId}
status: ${status}
created: ${new Date().toISOString()}
---

# Bug: ${title}

## Reproduction Steps
${repro}

## Root Cause
${rootCause}

## Evidence
${evidence.map(e => `- ${e}`).join('\n')}
`;
  writeRawNote(noteId, content);
  return noteId;
}

/**
 * Write a structured evidence note.
 */
export function writeEvidenceNote(projectId, evidence) {
  const { id, taskId, commands = [], passed = false, summary = '' } = evidence;
  const noteId = `projects/${projectId}/evidence/${id}.md`;
  const content = `---
id: ${id}
type: evidence
project: ${projectId}
task_id: ${taskId}
passed: ${passed}
created: ${new Date().toISOString()}
---

# Evidence: ${id}

## Task
${taskId}

## Verification Result
${passed ? '✅ PASSED' : '❌ FAILED'}

## Commands Run
${commands.map(c => `\`\`\`\n$ ${c.cmd}\n# exit: ${c.exitCode}\n${c.stdout ? c.stdout.slice(0, 500) : ''}\n\`\`\``).join('\n\n')}

## Summary
${summary}
`;
  writeRawNote(noteId, content);
  return noteId;
}

