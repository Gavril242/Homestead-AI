/**
 * Entity Memory — Mem0 concept for Gavirila agents.
 *
 * On task completion: extract entities + relationships from the task thread using a cheap LLM.
 * On task start: retrieve relevant memories by semantic similarity and inject into context.
 *
 * Storage: data/entity-memory/{agentId}.json (array of MemoryEntry objects)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chat } from '../llm/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR = path.resolve(__dirname, '../../data/entity-memory');
const MAX_MEMORIES_PER_AGENT = 200;
const MAX_INJECT_MEMORIES = 8;
const EXTRACT_AFTER_ROUNDS = 3; // only extract if task had >= 3 rounds

// Ensure directory exists
function ensureDir() {
  if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

function memoryFile(agentId) {
  return path.join(MEMORY_DIR, `${agentId}.json`);
}

function loadMemories(agentId) {
  try {
    const f = memoryFile(agentId);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
  } catch { return []; }
}

function saveMemories(agentId, memories) {
  ensureDir();
  fs.writeFileSync(memoryFile(agentId), JSON.stringify(memories, null, 2));
}

/**
 * Extract and store memories from a completed task.
 * @param {string} agentId
 * @param {object} task - completed task object
 * @param {Array} thread - the message thread from the task run
 */
export async function extractMemories(agentId, task, thread) {
  if (!thread || thread.length < EXTRACT_AFTER_ROUNDS * 2) return;

  // Sample thread messages (avoid huge context) — take first + last 6 messages
  const sample = thread.length > 14
    ? [...thread.slice(0, 4), ...thread.slice(-10)]
    : thread;

  const threadText = sample
    .filter(m => typeof m.content === 'string')
    .map(m => `${m.role}: ${m.content.slice(0, 800)}`)
    .join('\n---\n');

  try {
    const result = await chat({
      system: 'You are a memory extraction engine. Extract factual entities and relationships from this agent conversation. Return ONLY valid JSON.',
      messages: [{
        role: 'user',
        content: `Extract memories from this agent task conversation. Return JSON:
{
  "entities": [
    {"type": "file|function|env_var|library|error|preference|pattern", "name": "exact name", "value": "what is known about it"}
  ],
  "lessons": [
    "concise lesson learned (e.g. 'babel.config.js must include @babel/preset-react or JSX fails')"
  ]
}

Task: "${(task.title || task.desc || '').slice(0, 200)}"
Outcome: ${task.status}

Conversation:
${threadText}

Return ONLY the JSON. Max 5 entities, 3 lessons.`
      }],
      purpose: 'classify',
      tier: 'weak',
      toolScopes: [],
      maxTokens: 800,
    });

    let raw = (result?.reply || '').trim()
      .replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    // LLM sometimes returns markdown bullets/preamble before the JSON object
    // Extract the first {...} block to be robust against that
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return; // no JSON object found at all — skip silently
    raw = jsonMatch[0];

    const extracted = JSON.parse(raw);
    if (!extracted.entities && !extracted.lessons) return;

    const ts = new Date().toISOString();
    const newMemories = [
      ...(extracted.entities || []).map(e => ({
        id: `${agentId}-e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'entity',
        content: `[${e.type}] ${e.name}: ${e.value}`,
        source_task: task.id,
        project_id: task.project_id,
        created_at: ts,
      })),
      ...(extracted.lessons || []).map(l => ({
        id: `${agentId}-l-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'lesson',
        content: l,
        source_task: task.id,
        project_id: task.project_id,
        created_at: ts,
      })),
    ];

    if (newMemories.length === 0) return;

    const existing = loadMemories(agentId);
    const merged = [...existing, ...newMemories];
    // Keep most recent MAX_MEMORIES_PER_AGENT
    const trimmed = merged.slice(-MAX_MEMORIES_PER_AGENT);
    saveMemories(agentId, trimmed);

    console.log(`[entity-memory] Stored ${newMemories.length} memories for ${agentId}`);
  } catch (e) {
    console.warn('[entity-memory] Extract failed:', e.message?.slice(0, 100));
  }
}

/**
 * Retrieve relevant memories for a task and format as context injection.
 * Uses simple keyword matching (fast, zero tokens).
 * @returns {string} Formatted memory block to prepend to mission, or ''
 */
export function recallMemories(agentId, task, { projectId } = {}) {
  const memories = loadMemories(agentId);
  if (memories.length === 0) return '';

  const taskText = `${task.title || ''} ${task.desc || ''}`.toLowerCase();
  const words = taskText.split(/\W+/).filter(w => w.length > 3);

  // Score each memory by keyword overlap
  const scored = memories.map(m => {
    const content = m.content.toLowerCase();
    let score = 0;
    for (const word of words) {
      if (content.includes(word)) score++;
    }
    // Boost project-matching memories
    if (m.project_id === (projectId || task.project_id)) score += 2;
    // Boost lessons over entities
    if (m.type === 'lesson') score += 1;
    return { ...m, score };
  });

  const relevant = scored
    .filter(m => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_INJECT_MEMORIES);

  if (relevant.length === 0) return '';

  const lines = relevant.map(m => `- ${m.content}`).join('\n');
  return `\n\n### Relevant Memories from Past Tasks\n${lines}\n`;
}

/**
 * Delete all memories for an agent (for testing/reset).
 */
export function clearMemories(agentId) {
  try { fs.unlinkSync(memoryFile(agentId)); } catch {}
}
