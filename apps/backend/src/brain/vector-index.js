// Vector index over the vault.
//
// Strategy: lazy on-demand indexing. We don't run a heavy daemon — instead,
// every time `vault_semantic_search` or `vault_write_note` is called we
// reconcile the index against disk:
//   - a note's mtime changed → re-embed it
//   - a note exists in the index but not on disk → drop it
//   - a note is new → embed and add
//
// The index is persisted under data/vector-index.json so it survives restarts.
// This is intentionally simple — for ~1000 notes a flat array + cosine works
// fine. Swap in HNSW or sqlite-vec when the vault grows past 10k notes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listNotes, readNote, vaultRoot, impactOf, buildGraph } from './vault.js';
import { embedText, cosine } from '../llm/embed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.resolve(__dirname, '..', '..', 'data', 'vector-index.json');

let memIndex = null;     // in-memory copy of the index { byPath: { rel: { mtime, vector, snippet } } }
let dirty = false;
let inFlight = null;     // promise of the current reconcile (so we don't double-run)

function load() {
  if (memIndex) return memIndex;
  try {
    memIndex = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  } catch {
    memIndex = { byPath: {} };
  }
  return memIndex;
}

function persist() {
  if (!dirty) return;
  fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify(memIndex));
  dirty = false;
}

/** Reconcile the index with the vault. Idempotent; safe to call often. */
export async function reconcile({ maxNewPerCall = 25 } = {}) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const idx = load();
    const root = vaultRoot();
    const onDisk = new Set(listNotes());

    // Drop deleted notes
    for (const rel of Object.keys(idx.byPath)) {
      if (!onDisk.has(rel)) { delete idx.byPath[rel]; dirty = true; }
    }

    // Add/update new or changed notes (bounded so a fresh start doesn't bomb the API)
    let added = 0;
    for (const rel of onDisk) {
      if (added >= maxNewPerCall) break;
      const full = path.join(root, rel);
      const stat = fs.statSync(full);
      const cached = idx.byPath[rel];
      if (cached && cached.mtime === stat.mtimeMs) continue;

      try {
        const note = readNote(rel);
        const text = `${note.frontmatter?.title || ''}\n${note.body || ''}`.trim();
        if (!text) continue;
        const vector = await embedText(text);
        idx.byPath[rel] = {
          mtime: stat.mtimeMs,
          vector,
          snippet: text.slice(0, 220),
          title: note.frontmatter?.title || path.basename(rel, '.md'),
          id: note.frontmatter?.id || path.basename(rel, '.md'),
          project: note.frontmatter?.project || (rel.startsWith('projects/') ? rel.split('/')[1] : null),
          kind: note.frontmatter?.kind || rel.split('/')[0],
        };
        dirty = true;
        added++;
      } catch (err) {
        console.warn(`[vector-index] embed failed for ${rel}: ${err.message}`);
      }
    }

    persist();
    return { total: Object.keys(idx.byPath).length, added };
  })().finally(() => { inFlight = null; });
  return inFlight;
}

/**
 * Top-k semantic search.
 * @param {number[]} queryVector - the embedded query
 * @param {object}   opts - { k, projectId, kindFilter }
 */
export function search(queryVector, { k = 5, projectId, kindFilter } = {}) {
  const idx = load();
  const rows = Object.entries(idx.byPath)
    .filter(([rel, entry]) => {
      if (projectId && entry.project && entry.project !== projectId) return false;
      if (kindFilter && entry.kind !== kindFilter) return false;
      return true;
    })
    .map(([rel, entry]) => ({
      path: rel,
      score: cosine(queryVector, entry.vector),
      title: entry.title,
      id: entry.id,
      kind: entry.kind,
      project: entry.project,
      snippet: entry.snippet,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return rows;
}

/** Force-re-embed one path (called after `vault_write_note`). */
export async function reindexNote(rel) {
  const idx = load();
  delete idx.byPath[rel];
  dirty = true;
  // Don't await — let the next reconcile() pick it up.
  reconcile({ maxNewPerCall: 5 }).catch(() => {});
}

export function indexStats() {
  const idx = load();
  return { total: Object.keys(idx.byPath).length, persisted_at: INDEX_PATH };
}

/**
 * GraphRAG search: vector search for entry nodes + graph expansion to 2-degree neighbors.
 * Returns entry nodes (semantic) + expanded nodes (graph) + the sub-graph for rendering.
 */
export async function graphSearch(queryText, { projectId, entryK = 4, maxExpand = 12 } = {}) {
  await reconcile({ maxNewPerCall: 15 });
  const queryVec = await embedText(queryText);
  const entries = search(queryVec, { k: entryK, projectId });

  const idx = load();
  // Build a fast id → entry lookup from the in-memory index
  const idToEntry = {};
  for (const [rel, e] of Object.entries(idx.byPath)) {
    if (e.id) idToEntry[e.id] = { ...e, path: rel };
  }

  const entryIds = new Set(entries.map(e => e.id));
  const allEdges = [];
  const expandedMap = new Map(); // id → { id, path, kind, title, snippet, edges[] }

  for (const entry of entries) {
    const edges = impactOf(entry.id, 2);
    allEdges.push(...edges);
    for (const edge of edges) {
      const connectedId = edge.to;
      if (entryIds.has(connectedId)) continue; // already in entry nodes
      if (!expandedMap.has(connectedId)) {
        const connEntry = idToEntry[connectedId];
        if (!connEntry) continue;
        const note = readNote(connEntry.path);
        expandedMap.set(connectedId, {
          id: connectedId,
          path: connEntry.path,
          kind: connEntry.kind,
          title: connEntry.title || connectedId,
          snippet: note?.body?.slice(0, 200) || connEntry.snippet || '',
          reachedVia: [],
        });
      }
      const node = expandedMap.get(connectedId);
      if (node.reachedVia.length < 4) node.reachedVia.push(edge);
    }
  }

  const expandedNodes = [...expandedMap.values()].slice(0, maxExpand);

  // subgraph for rendering
  const allNodeIds = new Set([...entryIds, ...expandedMap.keys()]);
  const subgraphEdges = allEdges.filter(e => allNodeIds.has(e.from) && allNodeIds.has(e.to));

  return {
    entryNodes: entries,
    expandedNodes,
    subgraph: {
      nodes: [
        ...entries.map(e => ({ id: e.id, title: e.title, kind: e.kind, score: e.score })),
        ...expandedNodes.map(n => ({ id: n.id, title: n.title, kind: n.kind })),
      ],
      edges: subgraphEdges,
    },
  };
}
