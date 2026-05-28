// Tool registry for Gavirila agents.
//
// Each tool has:
//   name          — Gemini function name
//   description   — shown to the LLM so it knows when to call it
//   category      — used to filter which agents get which tools
//   parameters    — JSON Schema for Gemini's functionDeclarations
//   execute(args, ctx) — runs the tool, returns a plain-object result
//
// ctx = { repo, vault, broadcast, agentId, projectId }

import { repo, load, getProjectIntegrations } from '../db.js';
import { runVerification } from '../orchestrator/verifier.js';
import { conductorPipeline } from '../orchestrator/conductor-pipeline.js';
import { enforceDriftCheck, getMissionSummaryById, listMissionSummaries } from '../services/mission-contract.js';
import {
  readNote, writeNote, listNotes,
  buildGraph, impactOf, parseNote, vaultRoot,
} from '../brain/vault.js';
import { embedText } from '../llm/embed.js';
import { search as vectorSearch, reindexNote } from '../brain/vector-index.js';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { EXEC_TOOLS, ensureWorkspace as ensureWs, getWorkspacePath } from './exec-tools.js';
import { diagnose, diagnoseRecent } from './lsp-feedback.js';
import { SKILL_TOOLS } from './skills.js';
import { AST_TOOLS } from './ast-tools.js';
import { COMPUTER_USE_TOOLS } from './computer-use.js';
import { SWE_TOOLS } from './swe-tools.js';
import { ACI_TOOLS } from './aci.js';
import { UTAS5_TOOLS } from './utas5-tools.js';
import { ALL_UTAS5_TOOLS as UTAS5_PACK_TOOLS } from '../../../../packs/utas5/tools/index.js';
import { forgeTool, getForgedTools, loadAllTools, watchTools } from './tool-forge.js';
import { filterChunks } from '../brain/relevance-gate.js';
import { createJiraIssue, listJiraProjects, transitionJiraIssue, syncTaskToJira } from './atlassian-etl.js';
import { upsertConfluencePage, pushAllDocs } from './atlassian-doc-engine.js';
import { createConfluenceSpace, seedConfluencePages, provisionAtlassianForProject } from './atlassian-provisioner.js';
import { bus } from '../orchestrator/event-bus.js';

// ── helpers ─────────────────────────────────────────────────────────

/**
 * Full-text search scoped to a project's vault subdir.
 * Vault layout per project:
 *   vault/projects/<projectId>/{reqs,bugs,tests,decisions,components,runs,agents}/...
 * If projectId is missing, fall back to global search (project-shared notes).
 */
function vaultSearch(query, projectId) {
  const root = vaultRoot();
  const results = [];
  const q = query.toLowerCase();
  const all = listNotes();
  const scoped = projectId ? all.filter((rel) => rel.startsWith(`projects/${projectId}/`) || rel.startsWith('shared/')) : all;
  for (const rel of scoped) {
    try {
      const raw = fs.readFileSync(path.join(root, rel), 'utf8');
      if (raw.toLowerCase().includes(q)) {
        const { frontmatter } = parseNote(raw);
        const idx = raw.toLowerCase().indexOf(q);
        const start = Math.max(0, idx - 120);
        const end = Math.min(raw.length, idx + query.length + 120);
        results.push({
          path: rel,
          title: frontmatter.title || path.basename(rel, '.md'),
          id: frontmatter.id || path.basename(rel, '.md'),
          excerpt: raw.slice(start, end).replace(/\n/g, ' '),
        });
      }
    } catch { /* skip unreadable files */ }
  }
  return results.slice(0, 20);
}

/** Resolve a note path: if no leading "projects/" or "shared/", scope to this project. */
function scopedNotePath(relPath, projectId) {
  if (!projectId) return relPath;
  if (relPath.startsWith('projects/') || relPath.startsWith('shared/')) return relPath;
  return `projects/${projectId}/${relPath}`;
}

// Tools that count as "real work" when validating a "done" claim.
// Reading/listing is not enough — the agent must produce something.
const SUBSTANTIVE_TOOLS = [
  'fs_write_file', 'fs_patch_file', 'fs_mkdir', 'fs_delete_file',
  'shell_exec', 'shell_bg', 'python_run', 'browser_run',
  'git_add', 'git_commit', 'git_init',
  'vault_write_note', 'vault_ingest_file',
  'db_create_task', 'db_update_task', 'db_create_req', 'db_start_mission',
  'ping_agent',
  'shell_sandbox',
  'utas5_convert', 'utas5_compile_loop',
];

// Agents that work purely with vault/DB tools (no exec_shell scope).
// Their evidence of work is vault notes + DB records, not filesystem writes.
// SYS-GAP-06 fix: exempt these agents from the workspace_evidence gate.
const ANALYST_AGENTS = new Set(['aria', 'delphi', 'scribe']);

// Build a one-line, human-readable summary of a tool call's effect for the
// task's artifact log (this is what the user sees on the ticket).
function summarizeArtifact(toolName, args, result) {
  if (result?.error) return `❌ ${toolName} error: ${String(result.error).slice(0, 140)}`;
  switch (toolName) {
    case 'fs_write_file':
      return `📝 wrote \`${args?.path}\` (${result?.bytes || '?'} bytes)`;
    case 'fs_patch_file':
      return `🩹 patched \`${args?.path}\` (${result?.match || 'exact'} match)`;
    case 'fs_read_file':
      return `📖 read \`${args?.path}\` (${result?.size || '?'} bytes)`;
    case 'fs_list_dir':
      return `📂 listed \`${args?.dir || '.'}\` → ${result?.count ?? 0} entries`;
    case 'fs_mkdir':
      return `📁 mkdir \`${args?.dir}\``;
    case 'fs_delete_file':
      return `🗑 deleted \`${args?.path}\``;
    case 'shell_exec': {
      const ec = result?.exitCode;
      const tail = (result?.stdout || result?.stderr || '').trim().split('\n').slice(-1)[0]?.slice(0, 80);
      return `▶ \`${args?.cmd}\` → exit ${ec}${tail ? ` · ${tail}` : ''}`;
    }
    case 'shell_bg':
      return `🔄 bg started \`${args?.cmd}\` (job ${result?.jobId || '?'})`;
    case 'python_run': {
      const ec = result?.exitCode;
      const tail = (result?.stdout || result?.stderr || '').trim().split('\n').slice(-1)[0]?.slice(0, 80);
      return `🐍 python ${result?.ran || ''} → exit ${ec}${tail ? ` · ${tail}` : ''}`;
    }
    case 'browser_run':
      return `🌐 browser: ${result?.success ? '✓' : '✗'} "${args?.task?.slice(0, 60) || '?'}"${result?.result ? ` → ${String(result.result).slice(0, 60)}` : ''}`;
    case 'git_commit':
      return `✓ git commit "${args?.message?.slice(0, 60) || ''}"`;
    case 'git_add':
      return `+ git add ${args?.files}`;
    case 'vault_write_note':
      return `📓 wrote vault note \`${result?.path || args?.path}\``;
    case 'vault_search':
      return `🔍 search "${args?.query}" → ${result?.count ?? 0} hits`;
    case 'vault_semantic_search':
      return `🧠 semantic "${args?.query?.slice(0, 50)}" → ${result?.count ?? 0} hits`;
    case 'db_create_task':
      return `📌 created task "${result?.task?.title || args?.title}" → ${result?.task?.by || args?.by}`;
    case 'db_start_mission':
      return `🎯 started mission ${result?.missionId || '?'} → ${result?.task_count ?? 0} tasks`;
    case 'db_update_task':
      return `🔄 updated task ${args?.id} → ${args?.status || ''}`;
    case 'db_finish_task':
      return `${result?.demoted ? '⚠' : '✅'} finished task ${args?.id} → ${result?.task?.status || args?.status}`;
    case 'ask_human':
      return `❓ asked human: "${args?.question?.slice(0, 80)}"`;
    case 'trace_impact':
      return `🌐 impact ${args?.node_id} → ${result?.downstream_count ?? 0} downstream`;
    default:
      return `🔧 ${toolName}(${Object.keys(args || {}).join(', ')})`;
  }
}

/**
 * Append a tool call as an artifact on the active task, if any.
 * Called from `executeTool` after every tool runs.
 */
function recordArtifact(ctx, toolName, args, result) {
  if (!ctx?.taskId) return;
  const task = repo.byId('tasks', ctx.taskId);
  if (!task) return;
  const artifact = {
    ts: Date.now(),
    by: ctx.agentId || 'agent',
    tool: toolName,
    args: shallowSafe(args),
    summary: summarizeArtifact(toolName, args, result),
    ok: !result?.error,
    // Capture exit code for shell/python so the evidence gate can filter failures.
    exitCode: (toolName === 'shell_exec' || toolName === 'python_run')
      ? (result?.exitCode ?? null) : undefined,
  };
  const artifacts = [...(task.artifacts || []), artifact].slice(-200);
  repo.patch('tasks', ctx.taskId, { artifacts, updated_at: Date.now() });
  ctx.broadcast?.({ kind: 'task:artifact', taskId: ctx.taskId, artifact });
}

function shallowSafe(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') out[k] = v.length > 200 ? v.slice(0, 200) + '…' : v;
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    else if (Array.isArray(v)) out[k] = `[${v.length}]`;
    else out[k] = '{…}';
  }
  return out;
}

/**
 * When a task closes (done/review), automatically spawn the next-stage task
 * so work propagates without the human having to nudge each handoff.
 *
 * Chain (bound to agent role):
 *   Aria (req)        → Forge (impl)
 *   Delphi (arch)     → Forge (impl)
 *   Forge (impl)      → Vince (test)
 *   Vince (test fail) → Hunter (debug)
 *   Hunter (debug)    → Forge (patch)
 *
 * Only one-hop — we don't double-spawn if a downstream task already exists.
 */
// Exposed wrapper so the auditorium / runner can trigger propagation
// without going through the tool-call machinery.
export function autoPropagateExternal(originalTask, updatedTask, ctx) {
  return autoPropagate(originalTask, updatedTask, ctx);
}

/**
 * Extract structured handoff context from a completed task's outcome.
 * SYS-GAP-03 fix: passes req IDs, file paths, and vault note paths to the
 * downstream agent so it doesn't have to re-discover what was produced.
 */
function extractHandoffContext(originalTask, outcome) {
  const text = `${outcome || ''} ${originalTask.desc || ''}`;
  const reqIds = [...new Set((text.match(/REQ-[\w-]+/g) || []))];
  const filePaths = [...new Set(((outcome || '').match(/[\w/\\.-]+\.(?:js|ts|jsx|tsx|py|md|json|yaml|yml|sql|html|css|sh)\b/g) || []))
  ].slice(0, 8);
  const vaultPaths = [...new Set(((outcome || '').match(/(?:vault\/|projects\/|runs\/|decisions\/|reqs\/|bugs\/)[\w/.-]+/g) || []))
  ].slice(0, 4);
  return {
    source_task_id: originalTask.id,
    source_agent: originalTask.by,
    outcome_summary: (outcome || '').slice(0, 500),
    req_ids: reqIds,
    files_written: filePaths,
    vault_note_path: vaultPaths[0] || null,
    vault_paths: vaultPaths,
  };
}

function autoPropagate(originalTask, updatedTask, ctx) {
  const role = (originalTask.by || '').toLowerCase();
  const projectId = originalTask.project_id;
  const parentReq = originalTask.parent_req;
  const projectTasks = repo.list('tasks').filter((t) => t.project_id === projectId);

  // B2-01: Propagation depth cap — stop recursive chains from exploding
  const MAX_PROPAGATION_DEPTH = 4;
  const currentDepth = (originalTask.propagation_depth || 0) + 1;
  const rootChainId = originalTask.root_chain_id || originalTask.id;

  if (currentDepth > MAX_PROPAGATION_DEPTH) {
    console.log(`[autoPropagate] depth cap hit (${currentDepth}/${MAX_PROPAGATION_DEPTH}) for chain ${rootChainId} — suppressing spawn from ${originalTask.id}`);
    return;
  }

  // B2-01: Normalize title — strip all prefix stacking (Debug: Test: Patch: → base title)
  function normalizeTitle(title) {
    return (title || '').replace(/^(Implement|Build|Test|Debug|Patch):\s*/gi, '').trim().toLowerCase();
  }

  // B2-01: Semantic dedup — check if same root chain + normalized title exists in active states
  function alreadyHasInChain(by, newTitle) {
    const normalized = normalizeTitle(newTitle);
    return projectTasks.some((t) => {
      if (!['queued', 'running', 'review', 'needs-info', 'needs-human', 'blocked'].includes(t.status)) return false;
      // Same root chain AND same normalized title = duplicate
      if (t.root_chain_id === rootChainId && normalizeTitle(t.title) === normalized) return true;
      // Legacy check: same agent + same prefix (backward compat)
      if (t.by?.toLowerCase() === by.toLowerCase() && t.title.startsWith(newTitle.split(':')[0] + ':')) {
        if (normalizeTitle(t.title) === normalized) return true;
      }
      return false;
    });
  }

  function spawn({ by, title, desc, tag, handoff_context }) {
    // B2-01: Final dedup gate before persisting
    if (alreadyHasInChain(by, title)) {
      console.log(`[autoPropagate] dedup blocked: "${title}" already active in chain ${rootChainId}`);
      return null;
    }

    const id = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const row = {
      id, project_id: projectId,
      title, by, tag: tag || 'task', status: 'queued',
      since: 'just now', desc, parent_req: parentReq,
      created_at: Date.now(), updated_at: Date.now(),
      depends_on: [originalTask.id],
      propagation_depth: currentDepth,
      root_chain_id: rootChainId,
      handoff_context: handoff_context || undefined,
      comments: [], artifacts: [],
      history: [{ ts: Date.now(), kind: 'created', by: 'auto-propagate', note: `spawned from ${originalTask.id} (depth ${currentDepth}/${MAX_PROPAGATION_DEPTH}, chain ${rootChainId})` }],
    };

    // B2-02: Drift check on propagated tasks
    const drift = enforceDriftCheck(row, projectId);
    if (drift?.blocked) {
      console.log(`[autoPropagate] drift blocked: "${title}" (score: ${(drift.drift_score * 100).toFixed(0)}%) — off-mission`);
      return null;
    }

    repo.upsert('tasks', row);
    ctx.broadcast?.({ kind: 'task:create', task: row });
    return row;
  }

  const outcome = updatedTask.outcome || originalTask.title;
  const hc = extractHandoffContext(originalTask, outcome);
  const hcBlock = [
    hc.req_ids.length    ? `- REQ IDs: ${hc.req_ids.join(', ')}` : '',
    hc.vault_note_path   ? `- Vault spec: vault_read_note("${hc.vault_note_path}")` : '',
    hc.files_written.length ? `- Files produced: ${hc.files_written.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  if (role === 'aria') {
    spawn({
      by: 'Forge', tag: 'impl',
      title: `Implement: ${originalTask.title}`,
      handoff_context: hc,
      desc: `Implement the requirement Aria just wrote.\n\n## Handoff Context\n${hcBlock || '(see outcome below)'}\n\n## Aria's Outcome\n${outcome}\n\nSearch vault under reqs/ for the full spec, then build it in src/. Run + verify with shell_exec.`,
    });
  } else if (role === 'delphi') {
    spawn({
      by: 'Forge', tag: 'impl',
      title: `Build: ${originalTask.title}`,
      handoff_context: hc,
      desc: `Implement the architecture Delphi just defined.\n\n## Handoff Context\n${hcBlock || '(see outcome below)'}\n\n## Delphi's Outcome\n${outcome}\n\nRead the ADR via vault_read_note (path in context), then write the code in src/.`,
    });
  } else if (role === 'forge') {
    spawn({
      by: 'Vince', tag: 'test',
      title: `Test: ${originalTask.title}`,
      handoff_context: hc,
      desc: `Verify the implementation Forge just shipped.\n\n## Handoff Context\n${hcBlock || '(see outcome below)'}\n\n## Forge's Outcome\n${outcome}\n\nRun the relevant tests against the files listed above. Show exit code. If it passes, mark done with proof. If it fails, file a bug + repro.`,
    });
  } else if (role === 'vince') {
    // Only spawn Hunter if the test outcome looks like a failure.
    const failed = /\b(fail|failed|error|exception|red|broken)\b/i.test(outcome);
    if (failed) {
      spawn({
        by: 'Hunter', tag: 'bug',
        title: `Debug: ${originalTask.title}`,
        handoff_context: hc,
        desc: `Test failed.\n\n## Handoff Context\n${hcBlock || '(see outcome below)'}\n\n## Vince's Failure Output\n${outcome}\n\nReproduce locally with shell_exec, isolate the suspect change via git_diff, propose a minimal fix.`,
      });
    }
  } else if (role === 'hunter') {
    spawn({
      by: 'Forge', tag: 'patch',
      title: `Patch: ${originalTask.title}`,
      handoff_context: hc,
      desc: `Apply Hunter's proposed fix.\n\n## Handoff Context\n${hcBlock || '(see outcome below)'}\n\n## Hunter's Diagnosis\n${outcome}\n\nApply the patch to the files listed, run the originally failing test, confirm it passes with shell_exec exit 0.`,
    });
  }
}

// ── tool definitions ────────────────────────────────────────────────

export const TOOLS = [
  // ── Vault Read ─────────────────────────────────────────────────
  {
    name: 'vault_search',
    description: 'Full-text search across vault notes scoped to this project. Use for exact-string lookups (IDs, error messages, file names). For "what do we know about X?" prefer vault_semantic_search.',
    category: 'vault_read',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The exact search term or phrase to look for.' },
      },
      required: ['query'],
    },
    execute: ({ query }, ctx) => {
      const results = vaultSearch(query, ctx.projectId);
      return { count: results.length, results, scoped_to: ctx.projectId };
    },
  },
  {
    name: 'vault_semantic_search',
    description: 'Concept-level search over vault notes: returns the most semantically related notes, even when they don\'t share keywords with the query. Always call this BEFORE doing significant work, so you build on prior decisions instead of duplicating them.',
    category: 'vault_read',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A natural-language description of what you\'re looking for (e.g. "how we handled OTA rollback", "wake-up timing budget reasoning").' },
        k: { type: 'integer', description: 'How many top results to return. Default 5.' },
        kind: { type: 'string', description: 'Optional kind filter, e.g. "requirement", "adr", "bug", "run".' },
      },
      required: ['query'],
    },
    execute: async ({ query, k = 5, kind }, ctx) => {
      try {
        const v = await embedText(query);
        const hits = vectorSearch(v, { k, projectId: ctx.projectId, kindFilter: kind });

        // Get task description for relevance gating
        let taskDesc = ctx.taskDesc || '';
        if (!taskDesc && ctx.taskId) {
          try {
            const t = repo.byId('tasks', ctx.taskId);
            taskDesc = t?.desc || t?.title || '';
          } catch {}
        }

        // Map hits to filterChunks shape (hits have { id, path, score, snippet })
        const chunked = hits.map(h => ({ id: h.id, path: h.path, content: h.snippet || '', score: h.score }));
        const filtered = await filterChunks(chunked, taskDesc);
        // Return original hit objects that survived the gate
        const filteredIds = new Set(filtered.map(c => c.id || c.path));
        const filteredHits = hits.filter(h => filteredIds.has(h.id) || filteredIds.has(h.path));

        return { count: filteredHits.length, hits: filteredHits, scoped_to: ctx.projectId };
      } catch (err) {
        return { error: `semantic search failed: ${err.message}` };
      }
    },
  },
  {
    name: 'vault_graph_search',
    description: 'GraphRAG search: semantic vector search + 2-degree graph expansion. Returns the direct semantic matches AND all connected vault notes (requirements, components, tests) they link to. Use this instead of vault_search when you want to understand full blast-radius context around a concept.',
    category: 'vault_read',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language query' },
        project_id: { type: 'string', description: 'Optional — filter to a specific project' },
      },
      required: ['query'],
    },
    execute: async ({ query, project_id }, ctx) => {
      const { graphSearch } = await import('../brain/vector-index.js');
      const result = await graphSearch(query, { projectId: project_id || ctx.projectId });
      const { readNote } = await import('../brain/vault.js');

      // Get task description for relevance gating
      let taskDesc = ctx.taskDesc || '';
      if (!taskDesc && ctx.taskId) {
        try {
          const t = repo.byId('tasks', ctx.taskId);
          taskDesc = t?.desc || t?.title || '';
        } catch {}
      }

      // Filter expanded nodes by relevance (entry nodes are always kept)
      let expandedNodes = result.expandedNodes;
      if (expandedNodes.length > 0) {
        const chunked = expandedNodes.map(n => ({ id: n.id, content: n.snippet || n.body || '', score: 0.4 }));
        const filtered = await filterChunks(chunked, taskDesc);
        const filteredIds = new Set(filtered.map(c => c.id));
        expandedNodes = expandedNodes.filter(n => filteredIds.has(n.id));
      }

      const sections = [];
      for (const n of result.entryNodes.slice(0, 3)) {
        const note = readNote(n.path);
        sections.push(`### [${n.kind}] ${n.title} (score: ${n.score.toFixed(3)})\n${note?.body?.slice(0, 800) || n.snippet}`);
      }
      if (expandedNodes.length) {
        sections.push(`\n## Connected Context (graph expansion)\n`);
        for (const n of expandedNodes.slice(0, 6)) {
          sections.push(`**[${n.kind}] ${n.title}** — via ${n.reachedVia.map(e => e.kind).join(', ')}\n${n.snippet}`);
        }
      }
      return {
        count: result.entryNodes.length + expandedNodes.length,
        context: sections.join('\n\n---\n\n'),
        subgraph: result.subgraph,
      };
    },
  },
  {
    name: 'fetch_docs',
    description: 'Fetch a URL and return clean Markdown (strips navbars, ads, JS). Optionally saves to vault under shared/docs/. Use when you need to learn a library, API, or framework from its documentation site.',
    category: 'vault_read',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'Full URL to fetch (e.g. https://docs.example.com/guide)' },
        save_to_vault: { type: 'boolean', description: 'Save result to vault/shared/docs/ for future reference (default: false)' },
        jina_api_key: { type: 'string', description: 'Optional Jina API key for higher rate limits (falls back to JINA_API_KEY env var)' },
      },
    },
    execute: async ({ url, save_to_vault = false, jina_api_key }, ctx) => {
      if (!url || !url.startsWith('http')) {
        return { error: 'url must be a full http/https URL' };
      }

      const apiKey = jina_api_key || process.env.JINA_API_KEY || '';
      // Jina Reader: prefix any URL with https://r.jina.ai/
      const jinaUrl = `https://r.jina.ai/${url}`;

      const headers = {
        'Accept': 'text/markdown,text/plain,*/*',
        'X-Return-Format': 'markdown',
        'X-Timeout': '30',
      };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      let markdown;
      try {
        const resp = await fetch(jinaUrl, {
          headers,
          signal: AbortSignal.timeout(35000),
        });
        if (!resp.ok) {
          // Fallback: try direct fetch + strip HTML tags
          const raw = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Gavirila-Agent/1.0' } });
          const html = await raw.text();
          markdown = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
            .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s{3,}/g, '\n\n')
            .slice(0, 50000);
        } else {
          markdown = await resp.text();
        }
      } catch (e) {
        return { error: `Fetch failed: ${e.message}` };
      }

      // Trim to token-friendly size (~50k chars ≈ 12k tokens)
      const trimmed = markdown.slice(0, 50000);
      const wasTrimmed = markdown.length > 50000;

      let savedPath = null;
      if (save_to_vault) {
        try {
          const { writeNote } = await import('../brain/vault.js');
          // Generate a slug from the URL
          const urlObj = new URL(url);
          const slug = (urlObj.hostname + urlObj.pathname)
            .replace(/[^a-z0-9]/gi, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .toLowerCase()
            .slice(0, 80);

          const frontmatter = `---\nurl: "${url}"\nfetched-at: "${new Date().toISOString()}"\nkind: doc\nsource: jina-reader\n---\n`;
          savedPath = `shared/docs/${slug}.md`;
          writeNote(savedPath, frontmatter + trimmed);
        } catch (e) {
          console.warn('[fetch_docs] vault write failed:', e.message);
        }
      }

      return {
        url,
        chars: trimmed.length,
        trimmed: wasTrimmed,
        saved_to: savedPath,
        content: trimmed,
      };
    },
  },
  {
    name: 'crawl_docs',
    description: 'Fetch a URL using a full JS-rendering browser (Playwright). Better than fetch_docs for SPAs, React docs, GitHub wikis, or any page that requires JavaScript to render. Strips navbars, cookie banners, and ads. Returns clean Markdown. Optionally saves to vault.',
    category: 'vault_read',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'Full URL to crawl' },
        wait_for: { type: 'string', description: 'CSS selector to wait for before extracting (e.g. ".content", "article", "main")' },
        save_to_vault: { type: 'boolean', description: 'Save to vault/shared/docs/ (default false)' },
        follow_links: { type: 'boolean', description: 'Also crawl internal links on the page (max 5 sub-pages, default false)' },
        extract_selector: { type: 'string', description: 'CSS selector of the content area to extract (e.g. "article", ".docs-content"). Helps exclude navbars.' },
      },
    },
    execute: async ({ url, wait_for, save_to_vault = false, follow_links = false, extract_selector }, ctx) => {
      if (!url || !url.startsWith('http')) return { error: 'url must be a full http/https URL' };

      async function crawlPage(pageUrl) {
        const { chromium } = await import('playwright');
        let browser;
        try {
          browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
          const page = await browser.newPage();

          // Block images, fonts, media to speed up crawl
          await page.route('**/*.{png,jpg,jpeg,gif,svg,ico,woff,woff2,ttf,mp4,webm}', r => r.abort());

          await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 25000 });

          if (wait_for) {
            await page.waitForSelector(wait_for, { timeout: 10000 }).catch(() => {});
          }

          // Remove noisy elements
          await page.evaluate(() => {
            const removeSelectors = [
              'nav', 'header', 'footer', '.navbar', '.sidebar', '.nav',
              '.cookie-banner', '.cookie-notice', '#cookie', '.gdpr',
              '.advertisement', '.ads', '[class*="ad-"]', '[id*="ad-"]',
              '.popup', '.modal', '.overlay', '.notification-bar',
              'script', 'style', 'noscript',
            ];
            for (const sel of removeSelectors) {
              document.querySelectorAll(sel).forEach(el => el.remove());
            }
          });

          // Extract content
          let html;
          if (extract_selector) {
            html = await page.evaluate((sel) => {
              const el = document.querySelector(sel);
              return el ? el.innerHTML : document.body.innerHTML;
            }, extract_selector);
          } else {
            // Try common content selectors before falling back to body
            html = await page.evaluate(() => {
              const contentSelectors = ['article', 'main', '.content', '.docs', '.documentation', '.markdown-body', '#content', '#main'];
              for (const sel of contentSelectors) {
                const el = document.querySelector(sel);
                if (el && el.textContent.trim().length > 200) return el.innerHTML;
              }
              return document.body.innerHTML;
            });
          }

          // Collect internal links if requested
          let links = [];
          if (follow_links) {
            const origin = new URL(pageUrl).origin;
            links = await page.evaluate((o) => {
              return [...document.querySelectorAll('a[href]')]
                .map(a => a.href)
                .filter(h => h.startsWith(o) && !h.includes('#'))
                .slice(0, 5);
            }, origin);
          }

          return { html, links };
        } finally {
          await browser?.close().catch(() => {});
        }
      }

      async function htmlToMarkdown(html) {
        try {
          const mod = await import('turndown');
          const TurndownService = mod.default || mod;
          const td = new TurndownService({
            headingStyle: 'atx',
            codeBlockStyle: 'fenced',
            bulletListMarker: '-',
          });
          return td.turndown(html).replace(/\n{4,}/g, '\n\n').slice(0, 50000);
        } catch {
          // Fallback: strip HTML tags
          return html.replace(/<[^>]+>/g, ' ').replace(/\s{3,}/g, '\n\n').slice(0, 50000);
        }
      }

      try {
        const { html, links } = await crawlPage(url);
        let markdown = await htmlToMarkdown(html);

        let subPages = [];
        if (follow_links && links.length > 0) {
          for (const link of links.slice(0, 5)) {
            try {
              const { html: subHtml } = await crawlPage(link);
              const subMd = await htmlToMarkdown(subHtml);
              subPages.push({ url: link, content: subMd.slice(0, 15000) });
            } catch {}
          }
        }

        let savedPaths = [];
        if (save_to_vault) {
          const { writeNote } = await import('../brain/vault.js');

          const urlObj = new URL(url);
          const slug = (urlObj.hostname + urlObj.pathname)
            .replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 80);

          const mainPath = `shared/docs/${slug}.md`;
          writeNote(mainPath, {
            frontmatter: { url, 'fetched-at': new Date().toISOString(), kind: 'doc', source: 'crawl4ai-playwright' },
            body: markdown,
          });
          savedPaths.push(mainPath);

          for (const sp of subPages) {
            const sSlug = new URL(sp.url).pathname.replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/, '').slice(0, 60);
            const spPath = `shared/docs/${slug}/${sSlug}.md`;
            writeNote(spPath, {
              frontmatter: { url: sp.url, parent: url, kind: 'doc' },
              body: sp.content,
            });
            savedPaths.push(spPath);
          }
        }

        return {
          url,
          chars: markdown.length,
          sub_pages_crawled: subPages.length,
          saved_to: savedPaths,
          content: markdown,
          ...(subPages.length > 0 ? { sub_pages: subPages.map(s => ({ url: s.url, chars: s.content.length })) } : {}),
        };
      } catch (e) {
        // Fallback to Jina if Playwright fails
        console.warn(`[crawl_docs] Playwright failed for ${url}: ${e.message}. Falling back to Jina.`);
        const jinaUrl = `https://r.jina.ai/${url}`;
        try {
          const resp = await fetch(jinaUrl, { headers: { 'Accept': 'text/markdown' }, signal: AbortSignal.timeout(20000) });
          if (resp.ok) {
            const md = await resp.text();
            return { url, chars: md.length, fallback: 'jina', content: md.slice(0, 50000) };
          }
        } catch {}
        return { error: `Crawl failed: ${e.message}` };
      }
    },
  },
  {
    name: 'vault_read_note',
    description: 'Read a specific vault note by its relative path (e.g. "reqs/REQ-SHM-0142.md", "bugs/B-9821.md", "agents/Aria.md"). Returns the frontmatter metadata and body text.',
    category: 'vault_read',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within the vault, e.g. "reqs/REQ-SHM-0142.md" or "bugs/B-9821.md".' },
      },
      required: ['path'],
    },
    execute: ({ path: notePath }, ctx) => {
      const resolved = scopedNotePath(notePath, ctx.projectId);
      const note = readNote(resolved);
      if (!note) {
        // Inbox and architecture files may not exist yet — return empty rather than blocking the agent
        const isGraceful = /shared\/inbox\/|\/architecture\.md$/.test(resolved);
        if (isGraceful) return { path: resolved, frontmatter: {}, body: '(empty — no content yet)' };
        return { error: `Note not found: ${resolved}` };
      }
      return { path: note.path, frontmatter: note.frontmatter, body: note.body };
    },
  },
  {
    name: 'vault_list_notes',
    description: 'List all vault notes in a subdirectory. Available subdirectories: projects, reqs, components, tests, decisions, runs, agents, bugs.',
    category: 'vault_read',
    parameters: {
      type: 'object',
      properties: {
        subdir: { type: 'string', description: 'Subdirectory to list, e.g. "reqs", "bugs", "tests", "agents", "decisions", "components", "runs".' },
      },
      required: ['subdir'],
    },
    execute: ({ subdir }, ctx) => {
      const scoped = ctx.projectId ? `projects/${ctx.projectId}/${subdir}` : subdir;
      const notes = listNotes(scoped);
      return { subdir: scoped, count: notes.length, notes };
    },
  },

  // ── Vault Write ────────────────────────────────────────────────
  {
    name: 'vault_write_note',
    description: 'Write or update a vault note. Creates the file if it does not exist. Use this to record decisions, audit trail entries, agent memory updates, or new requirements/bugs/tests.',
    category: 'vault_write',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path in the vault, e.g. "runs/forge-fix-2026-04-25.md" or "agents/Aria.md".' },
        title: { type: 'string', description: 'Title for the note frontmatter.' },
        id: { type: 'string', description: 'Unique ID for the note (e.g. REQ-SHM-0250, B-9830).' },
        kind: { type: 'string', description: 'Kind of note: requirement, bug, test, component, adr, run, agent, project.' },
        body: { type: 'string', description: 'The markdown body content of the note.' },
        links: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs that this note links to (traceability).',
        },
      },
      required: ['path', 'title', 'body'],
    },
    execute: ({ path: notePath, title, id, kind, body, links }, ctx) => {
      const resolved = scopedNotePath(notePath, ctx.projectId);
      const fm = { title };
      if (id) fm.id = id;
      if (kind) fm.kind = kind;
      if (links && links.length) fm.links = links;
      if (ctx.projectId) fm.project = ctx.projectId;
      fm['updated-at'] = new Date().toISOString();
      writeNote(resolved, { frontmatter: fm, body });
      // Trigger background re-embedding so future semantic searches see this note.
      reindexNote(resolved);
      return { ok: true, path: resolved };
    },
  },

  // ── Missions ───────────────────────────────────────────────────
  {
    name: 'db_start_mission',
    description: 'Start a persistent mission for the current project. Use this when the user wants background work to begin from chat, not just a discussion or ad-hoc tickets.',
    category: 'missions',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Exact user goal. Preserve named files, folders, constraints, and success criteria.' },
      },
      required: ['goal'],
    },
    execute: async ({ goal }, ctx) => {
      const trimmedGoal = String(goal || '').trim();
      if (!trimmedGoal) return { error: 'goal is required' };
      if (!ctx.projectId) return { error: 'tool context missing projectId — cannot start mission' };

      const result = await conductorPipeline(ctx.projectId, trimmedGoal, { broadcast: ctx.broadcast });
      return {
        ok: true,
        missionId: result.missionId || null,
        mission: result.mission || null,
        task_count: result.tasksCreated || 0,
        plan_summary: result.mission?.report || `Created ${result.tasksCreated || 0} tasks for "${trimmedGoal.slice(0, 80)}"`,
      };
    },
  },
  {
    name: 'db_list_missions',
    description: 'List persistent missions for the current project so Conductor can report what is in flight or already completed.',
    category: 'missions',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Optional filter by status: active, completed, needs-human.' },
      },
    },
    execute: ({ status }, ctx) => {
      if (!ctx.projectId) return { error: 'tool context missing projectId — cannot list missions' };
      let missions = listMissionSummaries({ projectId: ctx.projectId });
      if (status) missions = missions.filter((mission) => mission.status === status);
      return { count: missions.length, missions };
    },
  },
  {
    name: 'db_get_mission',
    description: 'Get one mission by ID, scoped to the current project.',
    category: 'missions',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Mission ID to inspect.' },
      },
      required: ['id'],
    },
    execute: ({ id }, ctx) => {
      if (!ctx.projectId) return { error: 'tool context missing projectId — cannot load mission' };
      const mission = getMissionSummaryById(id);
      if (!mission || mission.projectId !== ctx.projectId) {
        return { error: `Mission not found: ${id}` };
      }
      return { mission };
    },
  },

  // ── DB: Tasks ──────────────────────────────────────────────────
  {
    name: 'db_list_tasks',
    description: 'List kanban tasks. Optionally filter by status (queued, running, review, done) or by agent name.',
    category: 'db_tasks',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: queued, running, review, done. Leave empty for all.' },
        agent: { type: 'string', description: 'Filter by agent name (e.g. "Forge", "Aria"). Leave empty for all.' },
        project_id: { type: 'string', description: 'Filter by project ID (e.g. "afeela-shm"). Defaults to all.' },
      },
    },
    execute: ({ status, agent }, ctx) => {
      // Always scoped to the calling project — agents never see other projects' tasks.
      let tasks = repo.list('tasks').filter((t) => t.project_id === ctx.projectId);
      if (status) tasks = tasks.filter((t) => t.status === status);
      if (agent) tasks = tasks.filter((t) => t.by?.toLowerCase() === agent.toLowerCase());
      return {
        count: tasks.length,
        tasks: tasks.map((t) => ({
          id: t.id, title: t.title, status: t.status, by: t.by,
          tag: t.tag, parent_req: t.parent_req, desc: t.desc,
        })),
      };
    },
  },
  {
    name: 'db_get_task',
    description: 'Get a single task by its ID.',
    category: 'db_tasks',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID, e.g. "c1", "c4".' },
      },
      required: ['id'],
    },
    execute: ({ id }) => {
      const task = repo.byId('tasks', id);
      if (!task) return { error: `Task not found: ${id}` };
      return { task };
    },
  },
  {
    name: 'db_create_task',
    description: 'Create a new kanban task. Assigns it to an agent with a status.',
    category: 'db_tasks',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the task.' },
        desc: { type: 'string', description: 'Detailed description.' },
        by: { type: 'string', description: 'Agent name to assign (e.g. "Forge", "Vince").' },
        tag: { type: 'string', description: 'Category tag: req, swarch, doc, capl, hil, bug, review, report, can, sec, tools, integ.' },
        status: { type: 'string', description: 'Initial status: queued, running, review, done. Defaults to queued.' },
        parent_req: { type: 'string', description: 'Parent requirement ID (e.g. "REQ-SHM-0142") for traceability.' },
        depends_on: { type: 'array', items: { type: 'string' }, description: 'Array of task IDs this task depends on. It will not start until these are marked done.' },
        project_id: { type: 'string', description: 'Project ID. Defaults to "afeela-shm".' },
      },
      required: ['title', 'by'],
    },
    execute: ({ title, desc, by, tag, status, parent_req, depends_on, project_id }, ctx) => {
      // The project the agent was invoked in always wins. Ignore any
      // project_id the model tried to pass — agents shouldn't reach across projects.
      const pid = ctx.projectId;
      if (!pid) return { error: 'tool context missing projectId — cannot create task' };

      // Role guard: Aria and Scribe are analysts/writers — never assign them
      // implementation, build, or test execution tasks. Auto-correct to Forge.
      const IMPL_KEYWORDS = /\b(implement|build|create|write|code|auth|api|endpoint|scaffold|setup|install|migrate|fix|patch|debug)\b/i;
      const ANALYST_AGENTS = ['aria', 'scribe'];
      let assignedTo = by;
      if (ANALYST_AGENTS.includes((by || '').toLowerCase()) && IMPL_KEYWORDS.test(title)) {
        console.warn(`[registry] db_create_task: re-routing "${title}" from ${by} → Forge (implementation task for analyst)`);
        assignedTo = 'Forge';
      }

      const id = `c-${Date.now().toString(36)}`;
      const row = {
        id, project_id: pid,
        title, by: assignedTo, tag: tag || 'task', status: status || 'queued',
        since: 'just now', desc: desc || '', parent_req, depends_on: depends_on || [],
        created_at: Date.now(), updated_at: Date.now(),
        comments: [],
        history: [{ ts: Date.now(), kind: 'created', by: ctx.agentId || 'agent', note: `created by ${ctx.agentId || 'agent'}` }],
      };

      // B2-02: Mission drift check — flag off-mission task creation
      const drift = enforceDriftCheck(row, pid);
      if (drift?.blocked) {
        row.drift_flagged = true;
        row.drift_score = drift.drift_score;
        row.drift_reason = drift.reason;
        row.history.push({ ts: Date.now(), kind: 'drift-flagged', by: 'drift-detector', note: drift.reason });
        console.warn(`[db_create_task] drift flagged: "${title}" (score: ${(drift.drift_score * 100).toFixed(0)}%) — mission: ${drift.mission_id}`);
      }

      repo.upsert('tasks', row);
      ctx.broadcast?.({ kind: 'task:create', task: row });

      // Auto-write vault note so the task is cross-linked into the project graph.
      try {
        const links = [`projects/${pid}/README`];
        if (parent_req) links.push(`projects/${pid}/reqs/${parent_req}`);
        writeNote(`projects/${pid}/tasks/${id}.md`, {
          frontmatter: {
            id, kind: 'task', title, status: status || 'queued',
            agent: assignedTo, project: pid,
            req: parent_req || undefined,
            created: new Date().toISOString().slice(0, 10),
            links,
          },
          body: `# ${title}\n\n**Agent:** ${assignedTo}\n**Status:** ${status || 'queued'}\n\n## Description\n${desc || '(none)'}\n`,
        });
      } catch (e) { console.warn('[registry] task vault note:', e.message); }

      return { ok: true, task: row };
    },
  },
  {
    name: 'db_update_task',
    description: 'Update a task\'s status or fields.',
    category: 'db_tasks',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID to update.' },
        status: { type: 'string', description: 'New status: queued, running, review, done.' },
        title: { type: 'string', description: 'Updated title (optional).' },
        desc: { type: 'string', description: 'Updated description (optional).' },
      },
      required: ['id'],
    },
    execute: ({ id, ...patch }, ctx) => {
      const updated = repo.patch('tasks', id, patch);
      if (!updated) return { error: `Task not found: ${id}` };
      ctx.broadcast?.({ kind: 'task:update', task: updated });
      return { ok: true, task: updated };
    },
  },
  {
    name: 'db_finish_task',
    description: 'Close out a task. ONLY accepts status="done" if the task has accumulated real artifacts (files written, commands run, vault notes saved). If you call done without proof, the system will demote you to "review" so a human can inspect. Always include a concrete outcome describing what was produced.',
    category: 'db_tasks',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID to finish.' },
        status: { type: 'string', description: 'Final status: "done" requires evidence; "review" hands to human; "needs-human" means stuck.' },
        outcome: { type: 'string', description: 'Summary of what was produced — file paths, commands run, vault notes written.' },
      },
      required: ['id', 'status'],
    },
    execute: async ({ id, status = 'done', outcome, workspacePath }, ctx) => {
      const resolvedId = id || ctx?.taskId;
      const task = repo.byId('tasks', resolvedId);
      if (!task) return { error: `Task not found: ${resolvedId}` };

      // Escalation ladder: intercept needs-human before it sticks
      if (status === 'needs-human') {
        const { applyEscalationLadder } = await import('../orchestrator/escalation-ladder.js');
        const errText = outcome || '';
        const escalation = applyEscalationLadder(task, errText);
        if (escalation.action === 'requeue') {
          // Template fix found — requeue instead of needs-human
          const fixHistory = [...(task.history || []), {
            ts: Date.now(), kind: 'template-fix', by: 'escalation-ladder',
            note: `needs-human intercepted. Auto-fix applied: ${escalation.reason}`,
          }];
          const requeued = repo.patch('tasks', resolvedId, {
            status: 'queued',
            desc: escalation.newDesc,
            templateFixApplied: escalation.templateId,
            error: errText.slice(0, 400),
            history: fixHistory,
          });
          ctx.broadcast?.({ kind: 'task:update', task: requeued });
          ctx.broadcast?.({ kind: 'toast', toast: {
            title: 'Auto-Fix Applied',
            body: `${escalation.reason} — requeued instead of needs-human`,
            icon: 'lightbulb', color: 'blue', kind: 'info',
          }});
          return { ok: true, task: requeued, intercepted: true, templateId: escalation.templateId, reason: escalation.reason };
        }
        // For always-human patterns (or unclassified), fall through to normal needs-human path
      }

      // ── Structured acceptance commands gate ──────────────────────────
      // If the task has acceptance_commands[], run them via the verifier and
      // let it determine the final status. This supersedes all legacy gates.
      if (task.acceptance_commands?.length > 0) {
        // Prefer shadow workspace (where agent actually wrote files) over main workspace
        const ws = ctx?.shadowPath || workspacePath || task.workspace_path || task.workspace || ctx.workspace
          || (task.project_id ? ensureWs(task.project_id) : process.cwd());
        try {
          const { bundle, newStatus, task: updatedTask } = await runVerification(resolvedId, ws);
          const persistedOutcome = (outcome || bundle.outcome_summary || updatedTask.outcome || '').trim();
          const finalizedTask = persistedOutcome
            ? repo.patch('tasks', resolvedId, { outcome: persistedOutcome, updated_at: Date.now() })
            : updatedTask;

          // Update vault note with outcome
          try {
            const notePath = `projects/${task.project_id}/tasks/${resolvedId}.md`;
            const existing = readNote(notePath);
            const fm = existing?.frontmatter || {};
            writeNote(notePath, {
              frontmatter: { ...fm, status: newStatus, outcome: (outcome || bundle.outcome_summary || '').slice(0, 300) },
              body: (existing?.body || `# ${task.title}\n\n`) +
                `\n## Outcome (${new Date().toISOString().slice(0, 10)})\n${outcome || '(verified by acceptance commands)'}\n`,
            });
          } catch (e) { console.warn('[registry] task vault update:', e.message); }

          const ev = { id: Date.now(), who: finalizedTask.by, what: `finished task (${newStatus})`, obj: finalizedTask.title, icon: 'check2', color: newStatus === 'done' ? 'green' : 'yellow' };
          repo.prepend('events', ev);
          ctx.broadcast?.({ kind: 'task:update', task: finalizedTask });
          ctx.broadcast?.({ kind: 'event:append', event: ev });

          if (newStatus === 'done' || newStatus === 'review') {
            autoPropagate(task, finalizedTask, ctx);
          }

          return {
            ok: true,
            taskId: resolvedId,
            status: newStatus,
            verified: bundle.verified,
            commands_passed: bundle.commands.filter(c => c.passed).length,
            commands_total: bundle.commands.length,
            evidence_bundle_id: bundle.id,
            task: finalizedTask,
          };
        } catch (verifyErr) {
          console.warn(`[db_finish_task] verification error for ${resolvedId}:`, verifyErr.message);
          // Fall through to legacy path on verifier error
        }
      }

      // ── Legacy path: no structured acceptance_commands ───────────────

      // Evidence gate: artifacts of substance for "done"
      const artifacts = task.artifacts || [];
      const meaningful = artifacts.filter((a) => SUBSTANTIVE_TOOLS.includes(a.tool));

      // SYS-GAP-06: analyst agents (Aria, Delphi, Scribe) use vault/DB tools as primary evidence.
      // They never run shell_exec, so we can't require exec artifacts.
      const isAnalystAgent = ANALYST_AGENTS.has((ctx?.agentId || task?.by || '').toLowerCase());

      // Require at least one successful write OR shell/python that exited 0.
      const hasSuccess = meaningful.some((a) => {
        if (a.tool === 'shell_exec' || a.tool === 'python_run') return a.exitCode === 0;
        return a.ok !== false;
      });

      // Track how many times this task has been demoted by the evidence gate.
      // After MAX_DEMOTIONS, escalate to needs-human instead of looping forever.
      const MAX_DEMOTIONS = 3;
      const demotionCount = (task.demotion_count || 0);

      let finalStatus = status;
      let demotedReason = null;
      if (status === 'done' && meaningful.length === 0) {
        finalStatus = 'review';
        demotedReason = 'demoted from "done" to "review": no substantive artifacts (file write / shell run / vault note) were recorded for this task';
      } else if (status === 'done' && !hasSuccess) {
        finalStatus = 'review';
        demotedReason = 'demoted from "done" to "review": all shell/python commands failed (non-zero exit code) — task has no verified success';
      }

      // Workspace evidence gate — skipped for analyst agents (SYS-GAP-06)
      // Analyst agents prove work via vault_write_note / db_create_req, not filesystem ops.
      const FS_EVIDENCE_TOOLS = ['fs_read_file', 'fs_list_dir', 'fs_write_file', 'fs_patch_file', 'fs_find', 'shell_exec', 'python_run'];
      if (finalStatus === 'done' && !isAnalystAgent) {
        const hasWorkspaceEvidence = artifacts.some((a) =>
          FS_EVIDENCE_TOOLS.includes(a.tool) && a.ok !== false
        );
        if (!hasWorkspaceEvidence) {
          finalStatus = 'review';
          demotedReason = 'demoted from "done" to "review": no filesystem tool calls succeeded — agent did not verify workspace access';
        }
      }

      // Legacy acceptance criteria gate: regex-extracted from description
      if (finalStatus === 'done' && task.desc) {
        const atMatch = task.desc.match(/ACCEPTANCE\s+TEST:\s*\n([^\n]+)/i);
        if (atMatch) {
          const testCmd = atMatch[1].trim();
          // Prefer shadow workspace (where agent actually wrote files) over main workspace
          const workspace = ctx?.shadowPath || workspacePath || task.workspace || ctx.workspace
            || (task.project_id ? ensureWs(task.project_id) : process.cwd());
          try {
            execSync(testCmd, {
              cwd: workspace,
              timeout: 30_000,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, CI: '1' },
            });
            console.log(`[db_finish_task] acceptance test PASSED for ${resolvedId}: ${testCmd}`);
          } catch (atErr) {
            finalStatus = 'review';
            demotedReason = `demoted from "done" to "review": acceptance test failed (exit ${atErr.status || 'error'}): ${testCmd}\n${(atErr.stderr?.toString() || '').slice(0, 300)}`;
            console.warn(`[db_finish_task] acceptance test FAILED for ${resolvedId}: ${testCmd} → ${atErr.status}`);
          }
        }
      }

      // B1-05: Required outputs gate — verify declared outputs exist on filesystem
      if (finalStatus === 'done' && task.required_outputs?.length > 0) {
        // Prefer shadow workspace (where agent actually wrote files) over main workspace
        const workspace = ctx?.shadowPath || workspacePath || task.workspace_path || task.workspace || ctx.workspace
          || (task.project_id ? ensureWs(task.project_id) : process.cwd());
        const missingOutputs = task.required_outputs.filter(outputPath => {
          try {
            const fullPath = path.isAbsolute(outputPath) ? outputPath : path.join(workspace, outputPath);
            return !fs.existsSync(fullPath);
          } catch { return true; }
        });
        if (missingOutputs.length > 0) {
          finalStatus = 'review';
          demotedReason = `demoted from "done" to "review": ${missingOutputs.length} required output(s) missing: ${missingOutputs.slice(0, 3).join(', ')}`;
        }
      }

      // B1-05: Track which gates passed/failed for structured reporting
      const gatesResult = {
        substantive_artifacts: meaningful.length > 0 && hasSuccess,
        workspace_evidence: finalStatus !== 'review' || !demotedReason?.includes('filesystem tool'),
        required_outputs: !task.required_outputs?.length || finalStatus === 'done',
        acceptance_test: !demotedReason?.includes('acceptance test failed'),
      };
      const gatesFailed = Object.entries(gatesResult).filter(([, v]) => !v).map(([k]) => k);

      const history = [...(task.history || []), {
        ts: Date.now(), kind: 'finished', by: ctx.agentId || 'agent',
        note: demotedReason || `set to ${finalStatus}: ${(outcome || '').slice(0, 140)}`,
      }];
      const updated = repo.patch('tasks', resolvedId, {
        status: finalStatus, outcome,
        verification_status: 'unverified',
        gates_failed: gatesFailed.length > 0 ? gatesFailed : undefined,
        updated_at: Date.now(), history,
      });
      ctx.broadcast?.({ kind: 'task:update', task: updated });

      // Update the task vault note with outcome + final status.
      try {
        const notePath = `projects/${task.project_id}/tasks/${resolvedId}.md`;
        const existing = readNote(notePath);
        const fm = existing?.frontmatter || {};
        writeNote(notePath, {
          frontmatter: { ...fm, status: finalStatus, outcome: (outcome || '').slice(0, 300) },
          body: (existing?.body || `# ${task.title}\n\n`) +
            `\n## Outcome (${new Date().toISOString().slice(0, 10)})\n${outcome || '(no outcome recorded)'}\n`,
        });
      } catch (e) { console.warn('[registry] task vault update:', e.message); }

      const ev = { id: Date.now(), who: updated.by, what: `finished task (${finalStatus})`, obj: updated.title, icon: 'check2', color: finalStatus === 'done' ? 'green' : 'yellow' };
      repo.prepend('events', ev);
      ctx.broadcast?.({ kind: 'event:append', event: ev });

      if (finalStatus === 'done' || (finalStatus === 'review' && !demotedReason)) {
        autoPropagate(task, updated, ctx);
      }

      // When demoted: return an error so the still-running agent sees the rejection
      // and has one more continuation round to fix the issue (e.g. run missing tests,
      // write the missing file). Returning ok:true here causes the LLM to stop and
      // the demotion reason is silently ignored.
      if (demotedReason) {
        const newDemotionCount = demotionCount + 1;

        // If this task has been demoted too many times on the same gate, escalate
        // to needs-human instead of looping forever.
        if (newDemotionCount >= MAX_DEMOTIONS) {
          console.warn(`[evidence-gate] ${resolvedId} hit ${newDemotionCount} demotions — dispatching rescue`);
          const live = repo.byId('tasks', resolvedId);
          if (live) {
            // Import rescue dynamically to avoid circular deps
            import('../orchestrator/task-runner.js').then(({ spawnRescueTask }) => {
              spawnRescueTask(live, `Evidence gate rejected ${newDemotionCount}× — gates failed: ${gatesFailed.join(', ')}. Last: ${demotedReason.slice(0, 200)}`, ctx.broadcast);
            }).catch(err => {
              console.error(`[evidence-gate] rescue import failed: ${err.message}`);
              repo.patch('tasks', resolvedId, {
                status: 'needs-human',
                demotion_count: newDemotionCount,
                error: `Evidence gate rejected ${newDemotionCount}× and rescue failed: ${err.message}`,
              });
              ctx.broadcast?.({ kind: 'task:update', task: repo.byId('tasks', resolvedId) });
            });
          }
          return {
            ok: false,
            error: `Task rescue dispatched after ${newDemotionCount} failed evidence gate attempts. Conductor will analyze and find a workaround.`,
            demotedReason, taskId: resolvedId, gates_failed: gatesFailed,
          };
        }

        // Normal demotion: patch back to running for self-correction.
        const live = repo.byId('tasks', resolvedId);
        if (live && ['review'].includes(live.status)) {
          repo.patch('tasks', resolvedId, {
            status: 'running',
            demotion_count: newDemotionCount,
            gates_failed: gatesFailed.length > 0 ? gatesFailed : undefined,
            demotion_reason: demotedReason,
            history: [...(live.history || []), {
              ts: Date.now(), kind: 'demotion-retry', by: 'evidence-gate',
              note: `demotion ${newDemotionCount}/${MAX_DEMOTIONS} — self-correction: ${demotedReason.slice(0, 200)}`,
            }],
          });
          ctx.broadcast?.({ kind: 'task:update', task: repo.byId('tasks', resolvedId) });
        }
        return {
          ok: false,
          error: `Task NOT accepted — evidence gate rejected your "done" claim.\n\nREASON: ${demotedReason}\n\nACTION REQUIRED: Fix the issue described above, then call db_finish_task again.\n  • Missing file → fs_write_file the file, then db_finish_task.\n  • No shell run → shell_exec the test/script, show exit 0, then db_finish_task.\n  • No vault note → vault_write_note a run record, then db_finish_task.\n  • Required outputs missing → write each output file, then db_finish_task.`,
          demotedReason,
          taskId: resolvedId,
          gates_failed: gatesFailed,
        };
      }

      return { ok: true, task: updated, demoted: false, verified: false };
    },
  },

  // ── Human callback ─────────────────────────────────────────────
  {
    name: 'ask_human',
    description: 'Pause the current task and request specific information from the human user. Use this when you cannot proceed without a decision or details (e.g. "what color scheme?", "which database?", "is this requirement still valid?"). The task moves to "needs-info" and waits for the human to reply via the ticket comments.',
    category: 'db_tasks',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The exact question to ask the human. Be specific.' },
        context: { type: 'string', description: 'Optional: brief context on why you\'re asking.' },
        options: {
          type: 'array', items: { type: 'string' },
          description: 'Optional: a short list of suggested answers/options the human can pick from.',
        },
      },
      required: ['question'],
    },
    execute: ({ question, context, options }, ctx) => {
      if (!ctx.taskId) return { error: 'ask_human only works inside a task — no active task in context.' };
      const task = repo.byId('tasks', ctx.taskId);
      if (!task) return { error: `Task ${ctx.taskId} not found` };
      const comment = {
        ts: Date.now(), by: ctx.agentId || 'agent',
        kind: 'question',
        text: question + (context ? `\n\n_Context: ${context}_` : ''),
        options: options || null,
      };
      const updated = repo.patch('tasks', ctx.taskId, {
        status: 'needs-info',
        comments: [...(task.comments || []), comment],
        history: [...(task.history || []), {
          ts: Date.now(), kind: 'asked-human', by: ctx.agentId,
          note: question.slice(0, 140),
        }],
        updated_at: Date.now(),
      });
      ctx.broadcast?.({ kind: 'task:update', task: updated });
      ctx.broadcast?.({ kind: 'toast', toast: {
        title: `${ctx.agentId || 'agent'} needs your input`,
        body: question.slice(0, 100),
        icon: 'chat', color: 'yellow', kind: 'warn',
      }});
      return { ok: true, task: updated, status: 'needs-info' };
    },
  },
  // ── DB: Requirements ───────────────────────────────────────────
  {
    name: 'db_list_reqs',
    description: 'List all requirements. Optionally filter by status (drafting, in-review, implemented, verified).',
    category: 'db_reqs',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status. Leave empty for all.' },
        project_id: { type: 'string', description: 'Filter by project. Defaults to all.' },
      },
    },
    execute: ({ status }, ctx) => {
      let reqs = repo.list('reqs').filter((r) => r.project_id === ctx.projectId);
      if (status) reqs = reqs.filter((r) => r.status === status);
      return { count: reqs.length, reqs };
    },
  },

  // ── DB: Bugs ───────────────────────────────────────────────────
  {
    name: 'db_list_bugs',
    description: 'List all bugs. Optionally filter by status (open, in-progress, closed) or severity (major, minor, critical).',
    category: 'db_bugs',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status. Leave empty for all.' },
        severity: { type: 'string', description: 'Filter by severity. Leave empty for all.' },
      },
    },
    execute: ({ status, severity }, ctx) => {
      let bugs = repo.list('bugs').filter((b) => b.project_id === ctx.projectId);
      if (status) bugs = bugs.filter((b) => b.status === status);
      if (severity) bugs = bugs.filter((b) => b.severity === severity);
      return { count: bugs.length, bugs };
    },
  },
  {
    name: 'db_get_bug',
    description: 'Get a single bug by its ID.',
    category: 'db_bugs',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Bug ID, e.g. "B-9821".' },
      },
      required: ['id'],
    },
    execute: ({ id }) => {
      const bug = repo.byId('bugs', id);
      if (!bug) return { error: `Bug not found: ${id}` };
      return { bug };
    },
  },

  // ── Traceability ───────────────────────────────────────────────
  {
    name: 'trace_impact',
    description: 'Run forward impact analysis: "If I change node X, what downstream items could break?" Walks the traceability graph following tested-by, implemented-by, depends-on, owns links.',
    category: 'trace',
    parameters: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: 'The ID of the node to check impact for, e.g. "REQ-SHM-0142", "Shm_Swc".' },
        max_depth: { type: 'integer', description: 'How many hops deep to walk. Default 3.' },
      },
      required: ['node_id'],
    },
    execute: ({ node_id, max_depth }) => {
      const downstream = impactOf(node_id, max_depth || 3);
      const links = load().links.filter(l => l.from === node_id || l.to === node_id);
      return { node_id, downstream_count: downstream.length, downstream, direct_links: links };
    },
  },
  {
    name: 'trace_links',
    description: 'Get all direct traceability links for a node (both incoming and outgoing).',
    category: 'trace',
    parameters: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: 'Node ID to query links for.' },
      },
      required: ['node_id'],
    },
    execute: ({ node_id }) => {
      const links = load().links.filter(l => l.from === node_id || l.to === node_id);
      return { node_id, count: links.length, links };
    },
  },
  {
    name: 'vault_graph',
    description: 'Get the full traceability graph of the vault: all nodes (requirements, tests, components, bugs, decisions) and all edges (tested-by, implemented-by, depends-on, etc.).',
    category: 'trace',
    parameters: { type: 'object', properties: {} },
    execute: () => {
      const graph = buildGraph();
      return { node_count: graph.nodes.length, edge_count: graph.edges.length, ...graph };
    },
  },

  // ── Agent coordination ─────────────────────────────────────────
  {
    name: 'ping_agent',
    description: 'Send a message directly to another agent. Creates a task for them AND writes to their inbox vault note. Use to hand off work: Vince→Hunter for bugs, Hunter→Forge for patches, Forge→Vince for tests.',
    category: 'db_tasks',
    parameters: {
      type: 'object',
      properties: {
        to:      { type: 'string', description: 'Target agent ID: conductor, forge, vince, hunter, aria, delphi, scribe.' },
        subject: { type: 'string', description: 'Short subject line (shown as task title).' },
        message: { type: 'string', description: 'Full message body — include context, file paths, repro steps, etc.' },
        priority: { type: 'string', description: 'Priority: high, medium (default), low.' },
      },
      required: ['to', 'subject', 'message'],
    },
    execute: ({ to, subject, message, priority = 'medium' }, ctx) => {
      if (!ctx.projectId) return { error: 'ping_agent requires an active project context' };

      // Write to target agent's inbox vault note (append)
      try {
        const inboxPath = `shared/inbox/${to}.md`;
        const existing = (() => { try { return readNote(inboxPath); } catch { return null; } })();
        const from = ctx.agentId || 'agent';
        const entry = `\n## [${new Date().toISOString()}] from ${from} — ${subject}\n\nTask: ${ctx.taskId || 'n/a'}\n\n${message}\n`;
        writeNote(inboxPath, {
          frontmatter: { kind: 'inbox', target: to, updated: new Date().toISOString() },
          body: (existing?.body || '') + entry,
        });
      } catch (e) { console.warn('[ping_agent] inbox write failed:', e.message); }

      // Create a task for the target agent
      const taskId = `c-ping-${Date.now().toString(36)}`;
      const row = {
        id: taskId, project_id: ctx.projectId,
        title: subject, desc: `Pinged by ${ctx.agentId || 'agent'}:\n\n${message}`,
        by: to.charAt(0).toUpperCase() + to.slice(1), // capitalize agent name
        tag: 'task', status: 'queued',
        since: 'just now',
        parent_req: undefined,
        depends_on: ctx.taskId ? [ctx.taskId] : [],  // optionally wait for sender's task
        created_at: Date.now(), updated_at: Date.now(),
        comments: [], history: [{ ts: Date.now(), kind: 'created', by: ctx.agentId || 'agent', note: `pinged from ${ctx.agentId} task ${ctx.taskId}` }],
        priority,
      };
      // Remove depends_on if empty
      if (!row.depends_on.length) delete row.depends_on;
      repo.upsert('tasks', row);
      ctx.broadcast?.({ kind: 'task:create', task: row });

      return { ok: true, taskId, message: `Created task ${taskId} for ${to}. They will see your message in their inbox.` };
    },
  },

  {
    name: 'list_active_tasks',
    description: 'See what every agent is currently working on in this project. Use before editing files — avoid duplicating work another agent instance is doing.',
    category: 'db_tasks',
    parameters: { type: 'object', properties: {} },
    execute: (_args, ctx) => {
      const all = repo.list('tasks').filter((t) => t.project_id === ctx.projectId);
      const running = all.filter((t) => t.status === 'running').map((t) => ({
        id: t.id, title: t.title, agent: t.by, status: t.status,
        started: t.started_at ? Math.round((Date.now() - t.started_at) / 1000) + 's ago' : '?',
      }));
      const queued = all.filter((t) => t.status === 'queued').slice(0, 10).map((t) => ({
        id: t.id, title: t.title, agent: t.by,
      }));
      return { running_count: running.length, queued_count: queued.length, running, next_queued: queued };
    },
  },

  {
    name: 'db_create_req',
    description: 'Create a new project requirement with acceptance criteria. Automatically writes a vault note linking it to the project. Use this to formalize what needs to be built before spawning tasks.',
    category: 'db_reqs',
    parameters: {
      type: 'object',
      properties: {
        title:    { type: 'string', description: 'Short requirement title.' },
        desc:     { type: 'string', description: 'Detailed description of the requirement.' },
        priority: { type: 'string', description: 'Priority: high, medium (default), low.' },
        criteria: {
          type: 'array', items: { type: 'string' },
          description: 'Acceptance criteria — concrete, testable statements. E.g. "User can log in with email+password and receive a JWT".',
        },
      },
      required: ['title'],
    },
    execute: ({ title, desc, priority = 'medium', criteria = [] }, ctx) => {
      if (!ctx.projectId) return { error: 'db_create_req requires an active project context' };
      const project = repo.byId('projects', ctx.projectId);
      if (!project) return { error: `project not found: ${ctx.projectId}` };

      // Guard: reject junk requirements (agents misuse db_create_req to signal task completion)
      const titleLower = (title || '').toLowerCase();
      const junkPatterns = [
        'finish task', 'mark task', 'finalize task', 'complete task', 'force closure',
        'loop resolution', 'loop detection', 'escalate', 'dummy', 'placeholder', 'ignore',
        'undefined', 'task completion', 'force resolution',
      ];
      if (!title || title === 'undefined' || junkPatterns.some((p) => titleLower.includes(p))) {
        return { error: `Rejected: "${title}" is not a valid requirement. db_create_req is for REAL product requirements (features, behaviors, capabilities). To finish a task, call db_finish_task instead.` };
      }

      // Rate limit: max 10 reqs per project per hour to prevent runaway creation
      const existing = repo.list('reqs').filter((r) => r.project_id === ctx.projectId);
      const recentHour = existing.filter((r) => r.created_at && r.created_at > Date.now() - 3600_000);
      if (recentHour.length >= 10) {
        return { error: 'Rate limited: max 10 requirements per project per hour. Review existing reqs before creating more.' };
      }
      const num = String(existing.length + 1).padStart(4, '0');
      const prefix = ctx.projectId.toUpperCase().replace(/[^A-Z0-9]/g, '-').slice(0, 14);
      const id = `REQ-${prefix}-${num}`;

      const row = {
        id, project_id: ctx.projectId, title, desc: desc || '', priority,
        criteria: Array.isArray(criteria) ? criteria : [criteria],
        status: 'active', created_at: Date.now(),
      };
      repo.upsert('reqs', row);

      // Auto-write vault note
      try {
        const criteriaLines = row.criteria.map((c) => `- [ ] ${c}`).join('\n') || '(none defined)';
        writeNote(`projects/${ctx.projectId}/reqs/${id}.md`, {
          frontmatter: {
            id, kind: 'req', title, status: 'active', priority,
            project: ctx.projectId,
            links: [`projects/${ctx.projectId}/README`],
          },
          body: `# ${title}\n\n**Priority:** ${priority}\n**Project:** [[projects/${ctx.projectId}/README|${project.name}]]\n\n## Description\n${desc || '(none)'}\n\n## Acceptance Criteria\n${criteriaLines}\n\n## Tasks\n_(linked automatically when tasks are created with parent_req="${id}")_\n`,
        });
      } catch (e) { console.warn('[db_create_req] vault note:', e.message); }

      ctx.broadcast?.({ kind: 'req:create', req: row });
      return { ok: true, req: row, vaultPath: `projects/${ctx.projectId}/reqs/${id}.md` };
    },
  },
];

// ── Event Bus tools ─────────────────────────────────────────────────────────
TOOLS.push(
  {
    name: 'bus_subscribe',
    description: 'Subscribe the calling agent to an event bus channel. Channels: task:lifecycle, agent:chat, system:alerts, workspace:changes, or * for all.',
    category: 'db_tasks',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel name to subscribe to (e.g. "task:lifecycle", "agent:chat", "*").' },
      },
      required: ['channel'],
    },
    execute: ({ channel }, ctx) => {
      return bus.subscribe(channel, ctx.agentId || 'agent', () => {});
    },
  },
  {
    name: 'bus_publish',
    description: 'Publish a message to an event bus channel so other subscribed agents can react to it.',
    category: 'db_tasks',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel to publish on (e.g. "task:lifecycle", "agent:chat", "system:alerts", "workspace:changes").' },
        message: { type: 'string', description: 'Message text or JSON payload to publish.' },
      },
      required: ['channel', 'message'],
    },
    execute: ({ channel, message }, ctx) => {
      const notified = bus.publish(channel, {
        type: 'agent:message',
        source: ctx.agentId || 'agent',
        data: { message, projectId: ctx.projectId, taskId: ctx.taskId },
      });
      return { ok: true, channel, notified };
    },
  },
  {
    name: 'bus_recent',
    description: 'Get recent events from an event bus channel. Useful for catching up on what happened while you were idle.',
    category: 'db_tasks',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel to query (e.g. "task:lifecycle", "agent:chat").' },
        limit: { type: 'integer', description: 'Max events to return (default 20).' },
      },
      required: ['channel'],
    },
    execute: ({ channel, limit = 20 }) => {
      const events = bus.replay(channel, 0, limit);
      return { channel, count: events.length, events };
    },
  },
);

// Merge execution tools into the main registry
TOOLS.push(...EXEC_TOOLS);
TOOLS.push(...SKILL_TOOLS);
TOOLS.push(...AST_TOOLS);
TOOLS.push(...COMPUTER_USE_TOOLS);
TOOLS.push(...SWE_TOOLS);
TOOLS.push(...ACI_TOOLS);
TOOLS.push(...UTAS5_TOOLS);
// uTAS5 knowledge pack — extended tools (project, ustudio bridge, run analyzer, extensions)
TOOLS.push(...UTAS5_PACK_TOOLS.filter(t => !TOOLS.some(existing => existing.name === t.name)));

// ── LSP / Linter feedback tools ─────────────────────────────────────────────
TOOLS.push(
  {
    name: 'lsp_check_file',
    description: 'Run syntax/type diagnostics on a single file (JS, TS, Python, JSON, PS1). Returns errors and warnings without executing the code. Use after writing files to catch mistakes early.',
    category: 'exec_fs',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within the project workspace, e.g. "src/main.js".' },
      },
      required: ['path'],
    },
    execute: ({ path: filePath }, ctx) => {
      if (!ctx?.projectId) return { error: 'No projectId in context' };
      const ws = ensureWs(ctx.projectId);
      const absPath = path.resolve(ws, filePath);
      if (!fs.existsSync(absPath)) return { error: `File not found: ${filePath}` };
      const results = diagnose(absPath);
      return { path: filePath, diagnostics: results };
    },
  },
  {
    name: 'lsp_check_recent',
    description: 'Scan the project workspace for recently modified files and run diagnostics on each. Returns only files with errors. Use to catch issues across multiple files after a batch of changes.',
    category: 'exec_fs',
    parameters: {
      type: 'object',
      properties: {
        minutes: { type: 'integer', description: 'Check files modified within the last N minutes (default 10).' },
      },
    },
    execute: ({ minutes = 10 }, ctx) => {
      if (!ctx?.projectId) return { error: 'No projectId in context' };
      const ws = ensureWs(ctx.projectId);
      const results = diagnoseRecent(ws, minutes);
      const errorCount = Object.keys(results).length;
      return { scanned_minutes: minutes, files_with_errors: errorCount, results };
    },
  },
);

// ── Quality & Safety tools ────────────────────────────────────────────────────
TOOLS.push(
  {
    name: 'jq_query',
    description: 'Apply a jq filter to a JSON string or file. Ideal for extracting fields, filtering arrays, and transforming JSON output from shell commands. Returns the filtered result. Use this instead of writing Node.js scripts to parse JSON output.',
    category: 'exec_fs',
    parameters: {
      type: 'object',
      properties: {
        input:     { type: 'string', description: 'JSON string to filter (use this OR file_path, not both).' },
        file_path: { type: 'string', description: 'Path to a JSON file relative to the project workspace.' },
        filter:    { type: 'string', description: 'jq filter expression, e.g. ".tasks[] | select(.status==\"done\") | .title"' },
        compact:   { type: 'boolean', description: 'Output compact JSON (default true).' },
      },
      required: ['filter'],
    },
    execute: ({ input, file_path, filter, compact = true }, ctx) => {
      let filePath = null;
      if (file_path && ctx?.projectId) {
        const ws = ensureWs(ctx.projectId);
        filePath = path.resolve(ws, file_path);
        if (!fs.existsSync(filePath)) return { error: `File not found: ${file_path}` };
      }
      const args = compact ? ['-c', filter] : [filter];
      if (filePath) args.push(filePath);
      const r = spawnSync('jq', args, {
        input: filePath ? undefined : input,
        encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024,
      });
      if (r.error?.code === 'ENOENT') {
        // jq not installed — do best-effort with JSON.parse
        try {
          const data = JSON.parse(filePath ? fs.readFileSync(filePath, 'utf8') : input);
          return { ok: true, result: JSON.stringify(data), note: 'jq not found in PATH — returned raw JSON. Install jq for filter support.' };
        } catch { return { error: 'jq not found in PATH. Install jq: https://jqlang.github.io/jq/download/' }; }
      }
      if (r.status !== 0) return { error: `jq error: ${(r.stderr || '').trim()}` };
      return { ok: true, result: (r.stdout || '').trim() };
    },
  },
  {
    name: 'json_diff',
    description: 'Structural diff between two JSON objects. Returns added, removed, and changed keys. Use to compare task state snapshots, API responses, or config files before and after a change.',
    category: 'exec_fs',
    parameters: {
      type: 'object',
      properties: {
        before: { type: 'string', description: 'JSON string of the original/expected state.' },
        after:  { type: 'string', description: 'JSON string of the new/actual state.' },
      },
      required: ['before', 'after'],
    },
    execute: ({ before, after }) => {
      let a, b;
      try { a = JSON.parse(before); } catch (e) { return { error: `"before" is not valid JSON: ${e.message}` }; }
      try { b = JSON.parse(after);  } catch (e) { return { error: `"after" is not valid JSON: ${e.message}` }; }
      function diff(left, right, prefix = '') {
        const changes = [];
        const allKeys = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
        for (const k of allKeys) {
          const key = prefix ? `${prefix}.${k}` : k;
          if (!(k in left))  changes.push({ op: 'add',    key, value: right[k] });
          else if (!(k in right)) changes.push({ op: 'remove', key, was: left[k] });
          else if (JSON.stringify(left[k]) !== JSON.stringify(right[k])) {
            if (left[k] && right[k] && typeof left[k] === 'object' && !Array.isArray(left[k])) {
              changes.push(...diff(left[k], right[k], key));
            } else {
              changes.push({ op: 'change', key, was: left[k], now: right[k] });
            }
          }
        }
        return changes;
      }
      const changes = diff(a, b);
      return { ok: true, change_count: changes.length, changes };
    },
  },
  {
    name: 'lint_js',
    description: 'Lint and type-check JS/TS files in the project workspace. MANDATORY before db_finish_task when you have written .js or .ts files. Tries biome (local install) → global biome → tsc → AST fallback.',
    category: 'exec_fs',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to a file or directory (e.g. "src/", "src/main.ts").' },
      },
      required: ['path'],
    },
    execute: ({ path: lintPath }, ctx) => {
      if (!ctx?.projectId) return { error: 'No projectId in context' };
      const ws = ensureWs(ctx.projectId);
      const absPath = path.resolve(ws, lintPath);
      if (!fs.existsSync(absPath)) return { error: `Not found: ${lintPath}` };
      const ext = process.platform === 'win32' ? '.cmd' : '';
      // 1. local biome
      const biomeBin = path.join(ws, 'node_modules', '.bin', `biome${ext}`);
      if (fs.existsSync(biomeBin)) {
        const r = spawnSync(biomeBin, ['check', '--no-errors-on-unmatched', absPath], { cwd: ws, encoding: 'utf8', timeout: 30_000, maxBuffer: 512 * 1024 });
        return { tool: 'biome', ok: r.status === 0, exit_code: r.status, output: ((r.stdout || '') + (r.stderr || '')).trim().slice(0, 4096) };
      }
      // 2. global biome
      const biomeGlobal = spawnSync('biome', ['--version'], { encoding: 'utf8', timeout: 3000 });
      if (!biomeGlobal.error) {
        const r = spawnSync('biome', ['check', '--no-errors-on-unmatched', absPath], { cwd: ws, encoding: 'utf8', timeout: 30_000, maxBuffer: 512 * 1024 });
        return { tool: 'biome', ok: r.status === 0, exit_code: r.status, output: ((r.stdout || '') + (r.stderr || '')).trim().slice(0, 4096) };
      }
      // 3. local tsc
      const tscBin = path.join(ws, 'node_modules', '.bin', `tsc${ext}`);
      if (fs.existsSync(tscBin) && fs.existsSync(path.join(ws, 'tsconfig.json'))) {
        const r = spawnSync(tscBin, ['--noEmit', '--skipLibCheck'], { cwd: ws, encoding: 'utf8', timeout: 60_000, maxBuffer: 512 * 1024 });
        return { tool: 'tsc', ok: r.status === 0, exit_code: r.status, output: ((r.stdout || '') + (r.stderr || '')).trim().slice(0, 4096) };
      }
      // 4. AST fallback via lsp-feedback
      const results = diagnose(absPath);
      const errors = results.filter(d => d.severity === 'error');
      return { tool: 'lsp-ast', ok: errors.length === 0, error_count: errors.length, diagnostics: results };
    },
  },
  {
    name: 'git_scan_secrets',
    description: 'Scan workspace files for hardcoded secrets (API keys, passwords, tokens). MANDATORY before git_commit. Uses gitleaks if installed, falls back to regex. Findings must be resolved before committing.',
    category: 'exec_git',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory or file to scan relative to workspace (default ".").' },
      },
    },
    execute: ({ path: scanPath = '.' }, ctx) => {
      const ws = ctx?.projectId ? ensureWs(ctx.projectId) : process.cwd();
      const absPath = path.resolve(ws, scanPath);
      // Try gitleaks
      const gl = spawnSync('gitleaks', ['detect', '--source', absPath, '--no-banner', '-q', '--exit-code', '1'], {
        encoding: 'utf8', timeout: 30_000, maxBuffer: 512 * 1024,
      });
      if (!gl.error) {
        if (gl.status === 0) return { ok: true, tool: 'gitleaks', findings: [], message: 'No secrets detected.' };
        return { ok: false, tool: 'gitleaks', findings_raw: ((gl.stdout || '') + (gl.stderr || '')).trim().slice(0, 4096), message: 'SECRETS DETECTED — do not commit. Fix findings or call ask_human.' };
      }
      // Regex fallback
      const SECRET_PATTERNS = [
        { name: 'generic-key', re: /(?:api[_-]?key|apikey|secret|token|password|passwd|pwd)\s*[:=]\s*["']?([a-zA-Z0-9_\-/+]{16,})["']?/gi },
        { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/g },
        { name: 'private-key', re: /-----BEGIN (RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY-----/g },
        { name: 'jwt', re: /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g },
      ];
      const findings = [];
      function scanFile(fp) {
        try {
          if (fs.statSync(fp).size > 500_000) return;
          const content = fs.readFileSync(fp, 'utf8');
          for (const { name, re } of SECRET_PATTERNS) {
            re.lastIndex = 0;
            if (re.test(content)) findings.push({ file: path.relative(ws, fp), pattern: name });
          }
        } catch {}
      }
      function walk(dir, depth = 0) {
        if (depth > 5) return;
        try {
          for (const entry of fs.readdirSync(dir)) {
            if (entry === 'node_modules' || entry === '.git' || entry.startsWith('.')) continue;
            const full = path.join(dir, entry);
            if (fs.statSync(full).isDirectory()) walk(full, depth + 1);
            else if (/\.(js|ts|jsx|tsx|py|env|json|yaml|yml|sh|ps1)$/.test(entry)) scanFile(full);
          }
        } catch {}
      }
      const stat = fs.statSync(absPath);
      if (stat.isDirectory()) walk(absPath); else scanFile(absPath);
      if (findings.length === 0) return { ok: true, tool: 'regex-fallback', findings: [], message: 'No secrets detected (regex scan). Install gitleaks for comprehensive coverage.' };
      return { ok: false, tool: 'regex-fallback', findings, message: `${findings.length} potential secret(s) found. Remove before committing.` };
    },
  },
  {
    name: 'vault_ingest_file',
    description: 'Convert a local file (PDF, DOCX, XLSX, PPTX, HTML, CSV) to Markdown and write it into the vault. Uses markitdown if installed (pip install markitdown). After ingestion the document is searchable via vault_semantic_search.',
    category: 'vault_write',
    parameters: {
      type: 'object',
      properties: {
        file_path:  { type: 'string', description: 'Absolute path or workspace-relative path of the file to ingest.' },
        vault_path: { type: 'string', description: 'Where to save in vault (e.g. "shared/docs/spec.md").' },
        title:      { type: 'string', description: 'Title for the vault note (defaults to filename).' },
      },
      required: ['file_path', 'vault_path'],
    },
    execute: ({ file_path, vault_path, title }, ctx) => {
      let absPath = file_path;
      if (!path.isAbsolute(absPath) && ctx?.projectId) {
        absPath = path.resolve(getWorkspacePath(ctx.projectId), file_path);
      }
      if (!fs.existsSync(absPath)) return { error: `File not found: ${absPath}` };
      const ext = path.extname(absPath).toLowerCase();
      let markdown = null;
      // Try markitdown CLI
      const r = spawnSync('markitdown', [absPath], { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      if (!r.error && r.status === 0 && r.stdout?.trim()) {
        markdown = r.stdout.trim();
      }
      // Fallback for plain text/CSV/MD
      if (!markdown && ['.txt', '.csv', '.md'].includes(ext)) {
        try { markdown = fs.readFileSync(absPath, 'utf8'); } catch {}
      }
      if (!markdown) return { error: `Cannot ingest ${ext} file: markitdown not installed. Run: pip install markitdown`, tip: 'Supports: PDF, DOCX, XLSX, PPTX, HTML, CSV' };
      const resolved = scopedNotePath(vault_path, ctx?.projectId);
      const fm = { title: title || path.basename(absPath), kind: 'document', source: absPath, ingested: new Date().toISOString() };
      if (ctx?.projectId) fm.project = ctx.projectId;
      writeNote(resolved, { frontmatter: fm, body: markdown.slice(0, 200_000) });
      reindexNote(resolved);
      return { ok: true, path: resolved, chars: Math.min(markdown.length, 200_000), trimmed: markdown.length > 200_000 };
    },
  },
  {
    name: 'shell_sandbox',
    description: 'Run a command in an isolated Docker container with the project workspace mounted read-only. Use for chaos tests, running untrusted scripts, or validating agent-generated code without risking the host. Falls back with a warning if Docker is not available.',
    category: 'exec_shell',
    parameters: {
      type: 'object',
      properties: {
        cmd:        { type: 'string', description: 'Shell command to run inside the sandbox.' },
        image:      { type: 'string', description: 'Docker image (default: node:22-alpine).' },
        timeout_ms: { type: 'integer', description: 'Timeout in ms (default 30000).' },
      },
      required: ['cmd'],
    },
    execute: ({ cmd, image = 'node:22-alpine', timeout_ms = 30_000 }, ctx) => {
      const ws = ctx?.projectId ? ensureWs(ctx.projectId) : process.cwd();
      const dockerCheck = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 5000 });
      if (dockerCheck.error) {
        return { error: 'Docker not available. Install Docker Desktop to use shell_sandbox for isolated execution. Use shell_exec for unsandboxed runs.' };
      }
      const r = spawnSync('docker', [
        'run', '--rm',
        '-v', `${ws}:/workspace:ro`,
        '-w', '/workspace',
        '--network', 'none',
        '--memory', '512m',
        '--cpus', '1',
        image, 'sh', '-c', cmd,
      ], { encoding: 'utf8', timeout: timeout_ms, maxBuffer: 512 * 1024 });
      return {
        tool: 'docker-sandbox', image, cmd,
        exitCode: r.status ?? -1,
        stdout: (r.stdout || '').slice(0, 4096),
        stderr: (r.stderr || '').slice(0, 2048),
        error: r.error?.message || null,
      };
    },
  },
);

// ── MCP tools — loaded asynchronously at startup ─────────────────────────────
// MCP servers are started once; their tools are pushed into TOOLS[] so all
// the existing routing (getToolsForScopes, toGeminiFunctionDeclarations, etc.)
// works unchanged. Category is `mcp_<serverName>` — add to an agent's
// toolScopes to grant access.
let _mcpToolsLoaded = false;

// ── Atlassian Confluence tools ─────────────────────────────────────────────────
TOOLS.push(
  {
    name: 'create_confluence_page',
    description: 'Create or update a Confluence page. If a page with the same title exists in the space, it will be updated (version incremented). Body should be HTML/Confluence Storage Format.',
    category: 'atlassian_confluence',
    parameters: {
      type: 'object',
      properties: {
        space_key:  { type: 'string', description: 'Confluence space key (e.g. "MYPROJ"). If omitted, uses the project\'s configured space key.' },
        title:      { type: 'string', description: 'Page title. Must be unique within the space.' },
        body:       { type: 'string', description: 'Page content in HTML or Confluence Storage Format. Supports <h1>, <p>, <table>, <ac:structured-macro>, etc.' },
      },
      required: ['title', 'body'],
    },
    execute: async ({ space_key, title, body }, ctx) => {
      try {
        const project = ctx.projectId ? repo.byId('projects', ctx.projectId) : null;
        const spaceKey = space_key || project?.integrations?.atlassian?.confluenceSpaceKey;
        if (!spaceKey) return { error: 'No space_key provided and project has no Confluence space configured. Provide space_key explicitly.' };
        const result = await upsertConfluencePage(spaceKey, title, body);
        return { ok: true, page_id: result?.id, title, space_key: spaceKey, url: result?._links?.webui ? `${process.env.CONFLUENCE_BASE_URL || ''}${result._links.webui}` : null };
      } catch (e) {
        return { error: `create_confluence_page failed: ${e.message}` };
      }
    },
  },
  {
    name: 'create_confluence_space',
    description: 'Create a new Confluence space for the project. Idempotent — if the space already exists (409), returns the existing space info. After creating, call seed_confluence_pages to populate standard pages.',
    category: 'atlassian_confluence',
    parameters: {
      type: 'object',
      properties: {
        space_key:   { type: 'string', description: 'Unique space key (uppercase letters, e.g. "MYPROJ").' },
        name:        { type: 'string', description: 'Human-readable space name.' },
        description: { type: 'string', description: 'Optional space description.' },
      },
      required: ['space_key', 'name'],
    },
    execute: async ({ space_key, name, description }, ctx) => {
      try {
        const result = await createConfluenceSpace(space_key, name, description || '');
        return { ok: true, space_key, name, space_id: result?.id || result?.key };
      } catch (e) {
        return { error: `create_confluence_space failed: ${e.message}` };
      }
    },
  },
  {
    name: 'seed_confluence_pages',
    description: 'Create the 5 standard project pages in a Confluence space: Overview, Architecture, Test Results, Reports & Metrics, Changelog. Requires the space to exist first.',
    category: 'atlassian_confluence',
    parameters: {
      type: 'object',
      properties: {
        space_key:    { type: 'string', description: 'Confluence space key to populate.' },
        project_name: { type: 'string', description: 'Project name for page titles.' },
      },
      required: ['space_key', 'project_name'],
    },
    execute: async ({ space_key, project_name }, ctx) => {
      try {
        const results = await seedConfluencePages(space_key, project_name);
        return { ok: true, pages_created: results?.length || 5, space_key };
      } catch (e) {
        return { error: `seed_confluence_pages failed: ${e.message}` };
      }
    },
  },
  {
    name: 'push_all_docs_to_confluence',
    description: 'Push all 5 standard project pages (Overview, Architecture, Test Results, Reports, Changelog) to Confluence. Uses live project data from the vault and task board. Call this to sync documentation after tasks complete.',
    category: 'atlassian_confluence',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID to sync. Defaults to current project if omitted.' },
      },
    },
    execute: async ({ project_id }, ctx) => {
      try {
        const pid = project_id || ctx.projectId;
        const project = repo.byId('projects', pid);
        if (!project) return { error: `Project ${pid} not found` };
        const results = await pushAllDocs(project);
        return { ok: true, pages_synced: results?.length || 5, project_id: pid };
      } catch (e) {
        return { error: `push_all_docs_to_confluence failed: ${e.message}` };
      }
    },
  },
);

// ── Atlassian Jira tools ──────────────────────────────────────────────────────
TOOLS.push(
  {
    name: 'create_jira_issue',
    description: 'Create a Jira issue in the project\'s Jira board. Maps to Jira REST API v2. Returns the issue key (e.g. "PROJ-42").',
    category: 'atlassian_jira',
    parameters: {
      type: 'object',
      properties: {
        summary:     { type: 'string', description: 'Issue title / summary.' },
        description: { type: 'string', description: 'Issue description (plain text or Jira markdown).' },
        issue_type:  { type: 'string', description: 'Issue type: Task, Bug, Story, Epic. Defaults to Task.' },
        priority:    { type: 'string', description: 'Priority: Highest, High, Medium, Low, Lowest. Defaults to Medium.' },
        labels:      { type: 'array', items: { type: 'string' }, description: 'Optional labels to add to the issue.' },
      },
      required: ['summary', 'description'],
    },
    execute: async ({ summary, description, issue_type, priority, labels }, ctx) => {
      try {
        const project = ctx.projectId ? repo.byId('projects', ctx.projectId) : null;
        if (!project?.integrations?.atlassian?.jiraProjectKey) {
          return { error: 'Project has no Jira project key configured. Enable Atlassian integration first.' };
        }
        const result = await createJiraIssue(project, {
          summary, description: description || '',
          issueType: issue_type || 'Task',
          priority: priority || 'Medium',
          labels: labels || [],
        });
        return { ok: true, issue_key: result?.key, issue_id: result?.id, summary };
      } catch (e) {
        return { error: `create_jira_issue failed: ${e.message}` };
      }
    },
  },
  {
    name: 'list_jira_projects',
    description: 'List all Jira projects visible to the configured credentials. Useful to verify connectivity and find project keys.',
    category: 'atlassian_jira',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, _ctx) => {
      try {
        const projects = await listJiraProjects();
        return { ok: true, projects: (projects || []).map(p => ({ key: p.key, name: p.name, id: p.id })) };
      } catch (e) {
        return { error: `list_jira_projects failed: ${e.message}` };
      }
    },
  },
  {
    name: 'transition_jira_issue',
    description: 'Change the status of a Jira issue (e.g. To Do → In Progress → Done). Automatically finds the right transition ID.',
    category: 'atlassian_jira',
    parameters: {
      type: 'object',
      properties: {
        issue_key:     { type: 'string', description: 'Jira issue key (e.g. "PROJ-42").' },
        target_status: { type: 'string', description: 'Target status name: "To Do", "In Progress", "Done", etc.' },
      },
      required: ['issue_key', 'target_status'],
    },
    execute: async ({ issue_key, target_status }, _ctx) => {
      try {
        await transitionJiraIssue(issue_key, target_status);
        return { ok: true, issue_key, new_status: target_status };
      } catch (e) {
        return { error: `transition_jira_issue failed: ${e.message}` };
      }
    },
  },
  {
    name: 'provision_atlassian',
    description: 'One-shot setup: create Confluence space + seed 5 pages + try to create Jira project for this Homestead project. Call this once when setting up a new project with Atlassian integration.',
    category: 'atlassian_confluence',
    parameters: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Homestead project ID. Defaults to current project.' },
      },
    },
    execute: async ({ project_id }, ctx) => {
      try {
        const pid = project_id || ctx.projectId;
        const project = repo.byId('projects', pid);
        if (!project) return { error: `Project ${pid} not found` };
        const result = await provisionAtlassianForProject(project, { force: true });
        return { ok: true, ...result };
      } catch (e) {
        return { error: `provision_atlassian failed: ${e.message}` };
      }
    },
  },
);

// ── Tool Forge — dynamically forged tools ─────────────────────────────────────
TOOLS.push(
  {
    name: 'forge_tool',
    description: 'Create a new custom tool at runtime. Write a full ES module with a default export: { name, description, category, parameters, execute(args, ctx) }. The tool is saved to data/skills/ and immediately available.',
    category: 'exec_system',
    parameters: {
      type: 'object',
      properties: {
        name:        { type: 'string', description: 'Tool name (alphanumeric + underscores). Will be the filename and the tool identifier.' },
        description: { type: 'string', description: 'What the tool does — shown to the LLM.' },
        code:        { type: 'string', description: 'Full ES module source. Must export default { name, description, category, parameters, execute }.' },
      },
      required: ['name', 'description', 'code'],
    },
    execute: async ({ name, description, code }, _ctx) => {
      try {
        const tool = await forgeTool(name, code);
        if (!TOOLS.find(t => t.name === tool.name)) {
          TOOLS.push(tool);
        }
        return { ok: true, tool: { name: tool.name, description: tool.description || description } };
      } catch (e) {
        return { error: `forge_tool failed: ${e.message}` };
      }
    },
  },
  {
    name: 'list_forged_tools',
    description: 'List all dynamically forged custom tools (created via forge_tool). Shows name and description of each.',
    category: 'exec_system',
    parameters: { type: 'object', properties: {} },
    execute: () => {
      const tools = getForgedTools();
      return {
        count: tools.length,
        tools: tools.map(t => ({ name: t.name, description: t.description || '(no description)' })),
      };
    },
  },
);

// Load previously forged tools from data/skills/ and start hot-reload watcher
(async () => {
  try {
    const forged = await loadAllTools();
    for (const tool of forged) {
      if (!TOOLS.find(t => t.name === tool.name)) {
        TOOLS.push(tool);
      }
    }
    if (forged.length > 0) {
      console.log(`[tool-forge] loaded ${forged.length} forged tools: ${forged.map(t => t.name).join(', ')}`);
    }
    watchTools();
  } catch (e) {
    console.warn('[tool-forge] init failed:', e.message);
  }

  // Seed uTAS5 knowledge pack vault (only writes if files don't exist yet)
  try {
    const { seedVault: seedUtas5Vault } = await import('../../../../packs/utas5/vault/seed.js');
    const { installSkills } = await import('../../../../packs/utas5/skills/definitions.js');
    const vr = vaultRoot();
    await seedUtas5Vault();
    installSkills(vr);
    console.log('[utas5-pack] vault knowledge + skills installed');
  } catch (e) {
    console.warn('[utas5-pack] vault seed skipped:', e.message);
  }
})();
export async function initMcpTools() {
  if (_mcpToolsLoaded) return;
  _mcpToolsLoaded = true;
  try {
    const { loadMcpTools } = await import('./mcp-client.js');
    const mcpTools = await loadMcpTools();
    TOOLS.push(...mcpTools);
    if (mcpTools.length > 0) {
      console.log(`[registry] loaded ${mcpTools.length} MCP tools from ${[...new Set(mcpTools.map(t => t.category))].join(', ')}`);
    }
  } catch (e) {
    console.warn('[registry] MCP tool init failed:', e.message);
  }
}

// ── exports ─────────────────────────────────────────────────────────

/** Get tools available for a set of category scopes. */
export function getToolsForScopes(scopes) {
  return TOOLS.filter(t => scopes.includes(t.category));
}

/** Get effective scopes for a task, merging agent scopes with project-level integrations.
 *  GR5: Also REMOVES integration scopes that aren't enabled — if the project has no
 *  Atlassian integration, jira/confluence tools are stripped from the schema entirely.
 *  The LLM can't hallucinate calls to tools it doesn't know exist. */
export function getScopesForProject(projectId, agentToolScopes) {
  const integrations = getProjectIntegrations(projectId);
  const scopes = [...(agentToolScopes || [])];

  // Add enabled integrations
  if (integrations?.github?.enabled) scopes.push('mcp_github');
  if (integrations?.atlassian?.enabled) scopes.push('atlassian_jira', 'atlassian_confluence', 'mcp_atlassian-jira');

  // GR5: Strip integration scopes if NOT enabled — prevents hallucinated tool calls
  const INTEGRATION_SCOPES = {
    github: ['mcp_github'],
    atlassian: ['atlassian_jira', 'atlassian_confluence', 'mcp_atlassian', 'mcp_atlassian-jira'],
  };
  const stripScopes = new Set();
  if (!integrations?.github?.enabled) {
    for (const s of INTEGRATION_SCOPES.github) stripScopes.add(s);
  }
  if (!integrations?.atlassian?.enabled) {
    for (const s of INTEGRATION_SCOPES.atlassian) stripScopes.add(s);
  }

  // GR5: Intersect with project-level toolScopes if the project defines them.
  // If the project only allows exec_fs + exec_shell, the agent never sees
  // exec_python or exec_browser — can't call what it can't see.
  const project = repo.byId('projects', projectId);
  const projectScopes = project?.toolScopes;

  let filtered = scopes.filter(s => !stripScopes.has(s));
  if (projectScopes?.length) {
    const allowed = new Set(projectScopes);
    // Always allow core DB/vault scopes (every agent needs these)
    ['vault_read', 'vault_write', 'db_tasks', 'db_reqs', 'db_bugs', 'trace'].forEach(s => allowed.add(s));
    filtered = filtered.filter(s => allowed.has(s));
  }

  return [...new Set(filtered)];
}

/** Convert tools to Gemini functionDeclarations format. */
export function toGeminiFunctionDeclarations(tools) {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/** Convert tools to OpenAI tools format (used by Aumovio and other OpenAI-compatible gateways). */
export function toOpenAIToolDeclarations(tools) {
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Execute a tool by name. Also records an artifact on the active task (if any). */
export async function executeTool(name, args, ctx) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    const out = { error: `Unknown tool: ${name}` };
    recordArtifact(ctx, name, args, out);
    return out;
  }
  let result;
  try {
    result = await tool.execute(args || {}, ctx);
  } catch (err) {
    result = { error: `Tool ${name} failed: ${err.message}` };
  }
  recordArtifact(ctx, name, args, result);
  return result;
}
