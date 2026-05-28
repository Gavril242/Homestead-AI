// apps/backend/src/orchestrator/skills.js
//
// Progressive Disclosure Skills — load skill files from data/skills/,
// parse their YAML frontmatter, and match them to tasks based on trigger conditions.
//
// Skills are injected into task descriptions / agent context when their
// trigger condition matches the task title or description.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

const SKILLS_DIR = path.resolve(
  MODULE_DIR,
  '../../data/skills'
);
const VAULT_AGENT_SKILLS_DIR = path.resolve(
  MODULE_DIR,
  '../../data/vault/agents'
);

let _skillsCache = null;

function listSkillFiles(dir, { recursive = false } = {}) {
  if (!fs.existsSync(dir)) return [];

  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) files.push(...listSkillFiles(fullPath, { recursive: true }));
      continue;
    }
    if (entry.name.endsWith('.md')) files.push(fullPath);
  }
  return files;
}

function isWithinDir(filePath, dir) {
  const rel = path.relative(dir, filePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Load all skills from shared data/skills and vault agent skill notes.
 * Returns array of parsed skill objects.
 * Results are cached after first load.
 */
export function loadSkills() {
  if (_skillsCache) return _skillsCache;

  const skillFiles = [
    ...listSkillFiles(SKILLS_DIR),
    ...listSkillFiles(VAULT_AGENT_SKILLS_DIR, { recursive: true }),
  ];

  if (!skillFiles.length) {
    _skillsCache = [];
    return _skillsCache;
  }

  const skills = new Map();
  for (const filePath of skillFiles) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const source = isWithinDir(filePath, VAULT_AGENT_SKILLS_DIR) ? 'vault-agent' : 'shared';
      const baseDir = source === 'vault-agent' ? VAULT_AGENT_SKILLS_DIR : SKILLS_DIR;
      const skill = parseSkill(raw, path.relative(baseDir, filePath).replace(/\\/g, '/'), { source });
      if (skill) skills.set(skill.id, skill);
    } catch (e) {
      console.warn(`[skills] failed to parse ${filePath}: ${e.message}`);
    }
  }

  _skillsCache = Array.from(skills.values());
  return _skillsCache;
}

/**
 * Parse a skill markdown file. Returns { id, trigger, applies_to, tokens, body } or null.
 */
function parseSkill(raw, filename, { source = 'shared' } = {}) {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;

  const fm = {};
  for (const line of fmMatch[1].split('\n')) {
    const [k, ...rest] = line.split(':');
    if (!k?.trim()) continue;
    const v = rest.join(':').trim();
    // Parse arrays: [a, b, c]
    if (v.startsWith('[') && v.endsWith(']')) {
      fm[k.trim()] = v.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
    } else {
      fm[k.trim()] = v.replace(/^['"]|['"]$/g, '');
    }
  }

  if (source === 'vault-agent' && fm.kind !== 'agent-skill') return null;

  const body = fmMatch[2].trim();
  const trigger = fm.trigger || fm.description || extractActivationTrigger(body);
  const appliesTo = Array.isArray(fm.applies_to)
    ? fm.applies_to
    : fm.applies_to ? [fm.applies_to] : [];
  if (!appliesTo.length && fm.agent) appliesTo.push(fm.agent);

  return {
    id: fm.id || fm.name || path.basename(filename, '.md'),
    trigger,
    applies_to: appliesTo.map((value) => String(value).toLowerCase()),
    tokens: Number(fm.tokens) || 200,
    body,
    filename,
    source,
  };
}

function extractActivationTrigger(body) {
  const match = body.match(/^## When to activate\s*\n\n([\s\S]*?)(?=^##\s|\Z)/m);
  return match ? match[1].trim().replace(/\s+/g, ' ') : '';
}

/**
 * Match skills relevant to a task. Returns array of matching skill objects.
 *
 * Matching strategy:
 * 1. Check if task title/description contains keywords from skill trigger.
 * 2. Check if assigned agent is in skill's applies_to list (if specified).
 */
export function matchSkillsForTask({ title = '', desc = '', agent = '' }) {
  const skills = loadSkills();
  const text = `${title} ${desc}`.toLowerCase();
  const agentLower = agent.toLowerCase();

  return skills.filter(skill => {
    // Extract keywords from trigger string (quoted phrases and plain words)
    const triggerText = skill.trigger.toLowerCase()
      .replace(/when |writing |running |implementing |using |for /g, '')
      .replace(/[,]/g, ' ');

    const triggerKeywords = triggerText.split(/\s+/).filter(w => w.length > 3);

    // Check if any trigger keyword appears in task text
    const triggerMatches = triggerKeywords.some(kw => text.includes(kw));

    // Check agent filter (applies_to: [] means all agents)
    const agentMatches = !skill.applies_to.length || skill.applies_to.includes(agentLower);

    return triggerMatches && agentMatches;
  });
}

/**
 * Build a skills context block to inject into an agent's task mission.
 * Only includes skills relevant to the task — keeps context lean.
 */
export function buildSkillsBlock(task) {
  const matched = matchSkillsForTask({
    title: task.title || '',
    desc: task.desc || '',
    agent: task.by || '',
  });

  if (!matched.length) return '';

  const blocks = matched.map(s => `### Skill: ${s.id}\n${s.body}`).join('\n\n');
  return `\n\n## Relevant Standards & Skills\n${blocks}\n`;
}

/**
 * Reload skills cache (useful after The Forger adds new skill files).
 */
export function reloadSkills() {
  _skillsCache = null;
  return loadSkills();
}
