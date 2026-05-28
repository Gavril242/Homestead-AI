// LLM router with Gemini function-calling + smart retry/rate-limit handling.
//
// Behavior:
//   • On 429 (rate limit): respect Retry-After header, otherwise exponential
//     backoff with jitter. Up to MAX_RETRIES_PER_PROVIDER attempts before
//     marking the provider rate-limited and moving to the next.
//   • On 503 / 500: retry with backoff (transient server issues).
//   • On 401 / 403: bail immediately on this provider, mark it as broken
//     for the rest of the process (auth won't fix itself).
//   • On 400: fail with the error — bad request, retry won't help.
//   • Network errors: retry once, then move on.
//
// Function calling loop:
//   1. Build tool declarations from registry (filtered by agent.toolScopes).
//   2. Send to Gemini with `tools`.
//   3. If model returns functionCall(s) → execute them → send results back.
//   4. Loop up to MAX_TOOL_ROUNDS rounds, return final text + toolCalls log.

import { buildPool, pickProviders, recordUsage, markRateLimited, markBroken, isProviderUsable, recordRequest } from './pool.js';
import { cannedReply } from './canned.js';

// Auto-break providers that consistently return empty responses (broken model endpoints)
const _emptyCount = new Map();
import {
  getToolsForScopes, toGeminiFunctionDeclarations, executeTool,
} from '../tools/registry.js';
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';
import { repairJson } from './json-repair.js';

const POOL = buildPool();
export function getPool() { return POOL; }

// VIO-specific undici agent with TLS verification disabled (scoped, not global).
const vioAgent = new UndiciAgent({ connect: { rejectUnauthorized: false } });

const MAX_TOOL_ROUNDS = 12;
const MAX_RETRIES_PER_PROVIDER = 3;
const BASE_BACKOFF_MS = 1500;

// Models that don't support function calling. We strip tools from those calls.
const NO_TOOL_CALL_MODELS = new Set(['gemma-3-27b-it', 'gemma-3-12b-it', 'gemma-3-1b-it']);

export async function chat({ messages, tier, agent, purpose = 'chat', system, toolScopes, toolCtx, thread }) {
  const allCandidates = pickProviders(POOL, { tier, purpose });
  const needTools = toolScopes && toolScopes.length > 0;
  const candidates = needTools
    ? allCandidates.filter((p) => p.supportsTools !== false)
    : allCandidates;

  // Build tool declarations once (per chat call) from agent's scopes.
  let toolDecls = null;
  let availableTools = [];
  if (toolScopes && toolScopes.length) {
    availableTools = getToolsForScopes(toolScopes);
    if (availableTools.length) {
      toolDecls = toGeminiFunctionDeclarations(availableTools);
    }
  }

  const errors = [];
  for (const p of candidates) {
    if (!isProviderUsable(p.id)) {
      errors.push({ provider: p.id, error: 'skipped (rate-limited or broken)' });
      continue;
    }
    try {
      const out = await callProviderWithRetry(p, messages, system, toolDecls, toolCtx || {}, thread);
      // If the model returned nothing at all (no text, no tool calls), skip to next provider.
      // This happens when some VIO models silently refuse tool-augmented chat prompts.
      if (!out.text && (!out.toolCalls || out.toolCalls.length === 0)) {
        errors.push({ provider: p.id, error: 'empty response (no text, no tool calls)' });
        const empties = (_emptyCount.get(p.id) || 0) + 1;
        _emptyCount.set(p.id, empties);
        if (empties >= 6) {
          markBroken(p.id, `auto-break: ${empties} consecutive empty responses`);
          console.warn(`[llm] ${p.id} auto-broken after ${empties} empty responses`);
        } else {
          console.warn(`[llm] ${p.id} returned empty response — trying next provider`);
        }
        continue;
      }
      _emptyCount.delete(p.id); // reset on success
      recordUsage({
        provider: p.id, model: p.model, tier,
        prompt_tokens: out.usage?.prompt_tokens || estimateTokens(messages),
        output_tokens: out.usage?.output_tokens || estimateTokens([{ content: out.text }]),
        agent_id: agent, purpose,
      });
      return {
        reply: out.text, provider: p.id, model: p.model, tier,
        toolCalls: out.toolCalls || [],
      };
    } catch (err) {
      errors.push({ provider: p.id, error: err.message });
      console.warn(`[llm] ${p.id} failed: ${err.message}`);
    }
  }

  // All providers exhausted — fall back to canned reply so the demo never silences.
  console.error(`[llm] ALL providers failed for agent ${agent}. Errors:`, errors);
  const reply = cannedReply({ agent, messages });
  return { reply, provider: 'canned', model: 'fallback', tier: 'fallback', errors, toolCalls: [] };
}

// ── retry wrapper around provider call ────────────────────────────────
async function callProviderWithRetry(p, messages, system, toolDecls, toolCtx, thread) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES_PER_PROVIDER; attempt++) {
    try {
      recordRequest(p.id);
      return await callProvider(p, messages, system, toolDecls, toolCtx, thread);
    } catch (err) {
      lastError = err;
      const status = err.status;

      // Auth errors → fail immediately on this provider, don't retry.
      if (status === 401 || status === 403) {
        markBroken(p.id, err.message);
        throw err;
      }
      // Bad request → context-length overflow gets a truncation retry; other 400s fail fast.
      if (status === 400) {
        const isContextOverflow = err.message && (
          err.message.toLowerCase().includes('context') ||
          err.message.toLowerCase().includes('maximum') ||
          err.message.toLowerCase().includes('too long') ||
          err.message.toLowerCase().includes('token') ||
          err.message.toLowerCase().includes('length')
        );
        if (isContextOverflow && messages.length > 2 && attempt < MAX_RETRIES_PER_PROVIDER - 1) {
          // Drop oldest non-system messages and retry with a smaller context
          const dropCount = Math.max(2, Math.ceil(messages.length * 0.35));
          messages = messages.slice(dropCount);
          console.warn(`[llm] ${p.id} context overflow — truncated ${dropCount} messages, retrying (${messages.length} remaining)`);
          continue;
        }
        throw err;
      }

      // Rate limit → respect Retry-After if present, else exponential backoff.
      if (status === 429) {
        const wait = err.retryAfterMs ?? backoffWithJitter(attempt);
        console.warn(`[llm] ${p.id} rate-limited (429). Backing off ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES_PER_PROVIDER})`);
        if (attempt === MAX_RETRIES_PER_PROVIDER - 1) {
          // Daily quota exhausted → permanently break for this session (not just RPM backoff)
          const isQuota = err.message && (err.message.includes('quota') || err.message.includes('exceeded'));
          if (isQuota) {
            markBroken(p.id, 'daily quota exhausted');
            console.warn(`[llm] ${p.id} auto-broken: daily quota exhausted`);
          } else {
            markRateLimited(p.id, wait);
          }
          throw err;
        }
        await sleep(wait);
        continue;
      }

      // 5xx → transient, retry with backoff.
      if (status >= 500 && status < 600) {
        const wait = backoffWithJitter(attempt);
        console.warn(`[llm] ${p.id} ${status}. Retrying in ${wait}ms`);
        if (attempt === MAX_RETRIES_PER_PROVIDER - 1) throw err;
        await sleep(wait);
        continue;
      }

      // Network/fetch errors → retry once.
      if (!status) {
        if (attempt >= 1) throw err;
        const wait = backoffWithJitter(attempt);
        console.warn(`[llm] ${p.id} network error. Retrying in ${wait}ms: ${err.message}`);
        await sleep(wait);
        continue;
      }

      // Anything else → don't retry.
      throw err;
    }
  }
  throw lastError;
}

function backoffWithJitter(attempt) {
  const base = BASE_BACKOFF_MS * Math.pow(2, attempt); // 1.5s, 3s, 6s
  const jitter = Math.random() * 800;
  return Math.min(15000, base + jitter);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── provider dispatch ─────────────────────────────────────────────────
async function callProvider(p, messages, system, toolDecls, toolCtx, thread) {
  if (p.kind === 'gemini')    return callGemini(p, messages, system, toolDecls, toolCtx);
  if (p.kind === 'aumovio')   return callAumovio(p, messages, system, toolDecls, toolCtx, thread);
  if (p.kind === 'anthropic') return callAnthropic(p, messages, system);
  throw new Error(`unknown provider kind: ${p.kind}`);
}

/**
 * Splits a system prompt into cached + live blocks for Anthropic-compatible prompt caching.
 * The large static HOMESTEAD_OPERATIONAL_MANUAL prefix gets a cache_control marker;
 * the small dynamic per-task suffix stays uncached.
 *
 * Returns an array of content blocks for Anthropic's `system` field.
 * If the system prompt is short (<2000 chars), returns it as a plain string (no caching overhead).
 */
function buildCachedSystemBlocks(system) {
  if (!system || system.length < 2000) return system;

  // Find the split point: the HOMESTEAD_OPERATIONAL_MANUAL ends at "═══" or "ROLE:" marker
  // Everything up to and including the operational manual is stable → cache it.
  // The per-task ROLE: section and LIVE PROJECT STATE is dynamic → don't cache.
  const splitMarkers = ['\nROLE:', '\n═══ LIVE', '\nKANBAN', '\nOPEN BUGS', '\nREQUIREMENTS'];
  let splitIdx = -1;
  for (const marker of splitMarkers) {
    const idx = system.indexOf(marker);
    if (idx > 1200) { // must be past the manual itself
      splitIdx = idx;
      break;
    }
  }

  if (splitIdx < 0) {
    // No good split point found — cache the whole thing as one block
    return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  }

  return [
    { type: 'text', text: system.slice(0, splitIdx), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: system.slice(splitIdx) },
  ];
}

// ── Gemini direct with function-calling and tool-loop ────────────────
async function callGemini(p, messages, system, toolDecls, toolCtx) {
  const supportsTools = !NO_TOOL_CALL_MODELS.has(p.model);
  const useTools = supportsTools && toolDecls && toolDecls.length > 0;

  // Build the running conversation as Gemini-format `contents`.
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const allToolCalls = [];
  const totalUsage = { prompt_tokens: 0, output_tokens: 0 };

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${p.model}:generateContent?key=${p.key}`;
    const body = {
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents,
      generationConfig: { temperature: 0.5, maxOutputTokens: 4096 },
    };

    if (useTools && round < MAX_TOOL_ROUNDS) {
      body.tools = [{ functionDeclarations: toolDecls }];
      body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
      const e = new Error(`gemini ${res.status}: ${errText.slice(0, 200)}`);
      e.status = res.status;
      e.retryAfterMs = retryAfterMs;
      throw e;
    }

    const data = await res.json();

    if (data.usageMetadata) {
      totalUsage.prompt_tokens += data.usageMetadata.promptTokenCount || 0;
      totalUsage.output_tokens += data.usageMetadata.candidatesTokenCount || 0;
    }

    const candidate = data.candidates?.[0];
    if (!candidate?.content?.parts) {
      // Empty response — if we have tool results, synthesize a summary so the UI gets text.
      if (allToolCalls.length > 0) {
        return { text: summarizeToolCalls(allToolCalls), usage: totalUsage, toolCalls: allToolCalls };
      }
      return { text: '(no response from model)', usage: totalUsage, toolCalls: allToolCalls };
    }

    const parts = candidate.content.parts;
    const fnCalls = parts.filter((x) => x.functionCall);
    const textParts = parts.filter((x) => x.text);

    if (fnCalls.length > 0 && round < MAX_TOOL_ROUNDS) {
      // Execute each function call this turn.
      const fnResponses = [];
      for (const part of fnCalls) {
        const { name, args } = part.functionCall;
        console.log(`[tool] ${toolCtx.agentId || '?'} → ${name}(${JSON.stringify(args || {}).slice(0, 120)})`);

        let result;
        try {
          result = await executeTool(name, args || {}, toolCtx);
        } catch (err) {
          result = { error: `Tool execution failed: ${err.message}` };
        }

        allToolCalls.push({ name, args, result: truncateResult(result) });
        // Broadcast tool calls live so the UI can render them as chips.
        toolCtx.broadcast?.({ kind: 'tool:call', agent: toolCtx.agentId, name, args, result: truncateResult(result) });

        fnResponses.push({
          functionResponse: { name, response: { content: result } },
        });
      }

      // Append model turn (with the function calls) and the tool results back to contents.
      contents.push({ role: 'model', parts: fnCalls });
      contents.push({ role: 'user', parts: fnResponses });
      continue;
    }

    // Model produced text → done.
    const text = textParts.map((x) => x.text).join('') || '';
    if (!text && allToolCalls.length > 0) {
      return { text: summarizeToolCalls(allToolCalls), usage: totalUsage, toolCalls: allToolCalls };
    }
    return { text, usage: totalUsage, toolCalls: allToolCalls };
  }

  return { text: '(tool loop exhausted)', usage: totalUsage, toolCalls: allToolCalls };
}

function summarizeToolCalls(allToolCalls) {
  const lines = allToolCalls.map((tc) => {
    const r = tc.result;
    const a = tc.args || {};
    if (r?.error) return `❌ ${tc.name}: ${r.error}`;

    switch (tc.name) {
      case 'shell_exec':
        return `🔧 ran \`${a.cmd || '?'}\` → exit ${r?.exitCode ?? '?'}`;
      case 'python_run':
        return `🐍 ran python ${a.filename || 'script'} → exit ${r?.exitCode ?? '?'}`;
      case 'fs_write_file':
        return `📝 wrote ${a.path || 'file'}`;
      case 'fs_read_file':
        return `📖 read ${a.path || 'file'} (${r?.content?.length || 0} chars)`;
      case 'fs_list_dir':
        return `📂 listed ${a.dir || '.'} (${r?.count ?? (r?.entries?.length ?? '?')} items)`;
      case 'fs_mkdir':
        return `📁 created dir ${a.dir || '?'}`;
      case 'vault_write_note':
        return `📓 wrote vault note "${a.title || a.id || '?'}"`;
      case 'vault_search':
        return `🔍 searched vault for "${a.query || '?'}" → ${r?.count ?? 0} results`;
      case 'vault_list_notes':
        return `📋 listed ${r?.count ?? 0} vault notes`;
      case 'db_create_task':
        return `📌 created task "${a.title || '?'}" → ${a.by || '?'}`;
      case 'db_finish_task':
        return `✅ finished task ${a.id || '?'} (${a.status || 'done'})`;
      case 'db_update_task':
        return `📝 updated task ${a.id || '?'}`;
      case 'git_init': return `🔀 git init`;
      case 'git_add': return `🔀 git add ${a.files || '.'}`;
      case 'git_commit': return `🔀 git commit: ${a.message || '?'}`;
      default:
        if (r?.ok) return `✅ ${tc.name}`;
        return `🔧 ${tc.name}`;
    }
  });
  return lines.join('\n');
}

function truncateResult(result) {
  const str = JSON.stringify(result);
  if (str.length <= 2000) return result;
  if (result?.results && Array.isArray(result.results)) return { count: result.count, results: result.results.slice(0, 8) };
  if (result?.tasks && Array.isArray(result.tasks)) return { count: result.count, tasks: result.tasks.slice(0, 8) };
  if (result?.notes && Array.isArray(result.notes)) return { count: result.count, notes: result.notes.slice(0, 15) };
  if (result?.entries && Array.isArray(result.entries)) return { count: result.count, entries: result.entries.slice(0, 30) };
  if (typeof result?.content === 'string' && result.content.length > 6000) {
    return { ...result, content: result.content.slice(0, 6000) + '\n...[truncated]' };
  }
  if (typeof result?.stdout === 'string' && result.stdout.length > 6000) {
    return { ...result, stdout: result.stdout.slice(0, 6000) + '\n...[truncated]' };
  }
  return { _truncated: true, preview: str.slice(0, 1500) };
}

// ── Aumovio gateway (OpenAI-compatible, full tool-calling loop) ───────
async function callAumovio(p, messages, system, toolDecls, toolCtx, thread) {
  const useTools = toolDecls && toolDecls.length > 0;
  const openAITools = useTools
    ? toolDecls.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
    : undefined;

  // Persistent thread: use by reference so appended messages carry into future rounds.
  // Without thread (e.g. direct chat): build a fresh messages array.
  const runningMessages = thread || [
    ...(system ? [{ role: 'system', content: system }] : []),
    ...messages,
  ];

  // For Claude models via VIO: inject cache_control into system message for prompt caching.
  // This reduces cost by 90%+ on the stable HOMESTEAD_OPERATIONAL_MANUAL prefix.
  const isClaudeModel = p.model?.toLowerCase().includes('claude');
  if (!thread && isClaudeModel && system && runningMessages.length > 0 && runningMessages[0].role === 'system') {
    const sysContent = runningMessages[0].content;
    if (typeof sysContent === 'string' && sysContent.length > 2000) {
      const blocks = buildCachedSystemBlocks(sysContent);
      if (Array.isArray(blocks)) {
        runningMessages[0] = { role: 'system', content: blocks };
      }
    }
  }

  const allToolCalls = [];
  const totalUsage = { prompt_tokens: 0, output_tokens: 0 };

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const body = {
      model: p.model,
      messages: runningMessages,
      temperature: 0.6,
      max_tokens: 8192,
    };
    if (useTools && round < MAX_TOOL_ROUNDS) {
      body.tools = openAITools;
      body.tool_choice = 'auto';
    }

    const res = await undiciFetch(`${p.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${p.key}` },
      body: JSON.stringify(body),
      // LiteLLM proxy on localhost needs no TLS bypass; VIO gateway (remote self-signed cert) does.
      dispatcher: p.baseUrl?.startsWith('http://') ? undefined : vioAgent,
    });
    if (!res.ok) {
      const err = new Error(`aumovio ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    if (data.usage) {
      totalUsage.prompt_tokens += data.usage.prompt_tokens || 0;
      totalUsage.output_tokens += data.usage.completion_tokens || 0;
      // Track cache hits/misses
      if (data.usage.cache_read_input_tokens) totalUsage.cache_read_tokens = (totalUsage.cache_read_tokens || 0) + data.usage.cache_read_input_tokens;
      if (data.usage.cache_creation_input_tokens) totalUsage.cache_write_tokens = (totalUsage.cache_write_tokens || 0) + data.usage.cache_creation_input_tokens;
    }

    const msg = data.choices?.[0]?.message;
    if (msg?.tool_calls && msg.tool_calls.length > 0 && round < MAX_TOOL_ROUNDS) {
      runningMessages.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
      for (const tc of msg.tool_calls) {
        const name = tc.function.name;
        let args;
        const rawArgs = tc.function.arguments || '{}';
        try {
          args = JSON.parse(rawArgs);
        } catch (parseErr) {
          const repaired = await repairJson(rawArgs, parseErr.message);
          if (repaired) {
            args = JSON.parse(repaired);
            console.log(`[bouncer] Repaired malformed JSON for tool call "${name}" (${rawArgs.length} chars)`);
          } else {
            console.warn(`[bouncer] Could not repair JSON for tool call "${name}" — falling back to empty args`);
            args = {};
          }
        }
        console.log(`[tool] ${toolCtx?.agentId || '?'} → ${name}(${JSON.stringify(args).slice(0, 120)})`);
        let result;
        try { result = await executeTool(name, args, toolCtx || {}); }
        catch (err) { result = { error: `Tool execution failed: ${err.message}` }; }
        allToolCalls.push({ name, args, result: truncateResult(result) });
        toolCtx?.broadcast?.({ kind: 'tool:call', agent: toolCtx.agentId, name, args, result: truncateResult(result) });
        runningMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      continue;
    }

    const text = msg?.content || '';
    if (!text && allToolCalls.length > 0) {
      const summary = summarizeToolCalls(allToolCalls);
      runningMessages.push({ role: 'assistant', content: summary });
      return { text: summary, usage: totalUsage, toolCalls: allToolCalls };
    }
    // Append final assistant message to thread so next outer round has full context
    runningMessages.push({ role: 'assistant', content: text });
    return { text, usage: totalUsage, toolCalls: allToolCalls };
  }
  return { text: '(tool loop exhausted)', usage: totalUsage, toolCalls: allToolCalls };
}

// ── Anthropic (Claude — strong-tier debug fallback) ──────────────────
async function callAnthropic(p, messages, system) {
  const systemPayload = buildCachedSystemBlocks(system);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': p.key,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
    body: JSON.stringify({
      model: p.model,
      max_tokens: 2048,
      ...(Array.isArray(systemPayload)
        ? { system: systemPayload }
        : { system: systemPayload || '' }),
      messages,
      ...(p.cacheControl !== false ? {} : {}), // marker for future flags
    }),
  });
  if (!res.ok) {
    const err = new Error(`anthropic ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return {
    text: data.content?.[0]?.text || '',
    usage: data.usage && {
      prompt_tokens: data.usage.input_tokens,
      output_tokens: data.usage.output_tokens,
      cache_read_tokens: data.usage.cache_read_input_tokens || 0,
      cache_write_tokens: data.usage.cache_creation_input_tokens || 0,
    },
    toolCalls: [],
  };
}

function estimateTokens(msgs) {
  return Math.ceil(msgs.reduce((acc, m) => acc + (m.content?.length || 0), 0) / 4);
}
