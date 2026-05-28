/**
 * Structured LLM outputs with Zod validation and automatic retry.
 * The Node.js PydanticAI equivalent.
 *
 * Usage:
 *   const result = await callStructured(z.object({ tasks: z.array(TaskSchema) }), prompt, opts);
 */
import { z } from 'zod';
import { chat } from './index.js';

const MAX_RETRIES = 3;

/**
 * Call LLM and parse + validate output against a Zod schema.
 * On validation failure, injects the error back into messages and retries.
 *
 * @param {z.ZodType} schema - Zod schema to validate against
 * @param {string|Array} messagesOrPrompt - messages array or string prompt
 * @param {object} opts - same opts as chat() plus:
 *   opts.system - system prompt
 *   opts.schemaDescription - human-readable description of expected output
 * @returns {Promise<{ data: T, raw: string, attempts: number }>}
 */
export async function callStructured(schema, messagesOrPrompt, opts = {}) {
  const messages = typeof messagesOrPrompt === 'string'
    ? [{ role: 'user', content: messagesOrPrompt }]
    : [...messagesOrPrompt];

  // Build schema description for the system prompt
  const schemaShape = describeSchema(schema);
  const systemSuffix = `\n\nOUTPUT FORMAT: Respond with ONLY valid JSON matching this schema. No explanation, no markdown fences.\nSchema: ${schemaShape}`;

  const systemPrompt = (opts.system || '') + systemSuffix;

  let lastError = null;
  let lastRaw = '';

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const threadMessages = [...messages];

    // On retry, inject the validation error
    if (attempt > 1 && lastError) {
      threadMessages.push({
        role: 'assistant',
        content: lastRaw
      });
      threadMessages.push({
        role: 'user',
        content: `That response failed validation. Error: ${lastError}\n\nFix the JSON and try again. Output ONLY valid JSON matching the schema.`
      });
    }

    const result = await chat({
      ...opts,
      system: systemPrompt,
      messages: threadMessages,
      toolScopes: [],  // no tools — pure structured output
    });

    lastRaw = result?.reply?.trim() || '';

    // Strip markdown fences if model added them, then extract JSON blob
    let cleaned = lastRaw
      .replace(/^```(?:json)?\n?/i, '')
      .replace(/\n?```$/i, '')
      .trim();

    // Extract JSON object/array embedded in prose
    if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) {
      const objMatch = cleaned.match(/\{[\s\S]*\}/);
      const arrMatch = cleaned.match(/\[[\s\S]*\]/);
      if (objMatch) cleaned = objMatch[0];
      else if (arrMatch) cleaned = arrMatch[0];
    }

    try {
      const parsed = JSON.parse(cleaned);
      const validated = schema.parse(parsed);
      return { data: validated, raw: cleaned, attempts: attempt };
    } catch (e) {
      lastError = e.message?.slice(0, 300) || 'Unknown validation error';
      console.warn(`[structured] Attempt ${attempt}/${MAX_RETRIES} failed: ${lastError.slice(0, 100)}`);
    }
  }

  throw new Error(`Structured output failed after ${MAX_RETRIES} attempts. Last error: ${lastError}\nLast raw: ${lastRaw.slice(0, 200)}`);
}

// Generate a human-readable schema description from a Zod type
function describeSchema(schema, depth = 0) {
  if (depth > 4) return '...';
  const indent = '  '.repeat(depth);

  const typeName = schema?._def?.typeName;

  if (typeName === 'ZodObject') {
    const shape = schema.shape;
    const fields = Object.entries(shape).map(([k, v]) =>
      `${indent}  "${k}": ${describeSchema(v, depth + 1)}`
    ).join(',\n');
    return `{\n${fields}\n${indent}}`;
  }
  if (typeName === 'ZodArray') {
    return `[${describeSchema(schema.element, depth)}]`;
  }
  if (typeName === 'ZodString') return '"string"';
  if (typeName === 'ZodNumber') return 'number';
  if (typeName === 'ZodBoolean') return 'boolean';
  if (typeName === 'ZodEnum') {
    // Zod v4: values is an object; v3: options is an array
    const opts = schema.options ?? Object.keys(schema._def?.values ?? {});
    return opts.map(o => `"${o}"`).join(' | ');
  }
  if (typeName === 'ZodOptional') return `${describeSchema(schema.unwrap(), depth)} (optional)`;
  if (typeName === 'ZodNullable') return `${describeSchema(schema.unwrap(), depth)} | null`;
  if (typeName === 'ZodUnion') return schema.options.map(o => describeSchema(o, depth)).join(' | ');
  return 'any';
}

// ─── Shared schemas for common Gavirila outputs ────────────────────────────

export const TaskSchema = z.object({
  title: z.string().min(1).max(200),
  desc: z.string().min(1),
  agent_id: z.string(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  depends_on: z.array(z.string()).optional()
});

export const PlanSchema = z.object({
  summary: z.string(),
  tasks: z.array(TaskSchema).min(1).max(20)
});

export const ReqSchema = z.object({
  title: z.string().min(1).max(200),
  desc: z.string(),
  priority: z.enum(['low', 'medium', 'high']),
  criteria: z.array(z.string()).optional()
});

export const TribunalVerdictSchema = z.object({
  rootCause: z.string().catch('unknown'),
  errorType: z.string().catch('unknown'),
  evidence: z.string().catch(''),
  suspectArea: z.string().catch('unknown'),
  fixable: z.boolean().catch(true)
});

export const DelphiReviewSchema = z.object({
  designFlawed: z.boolean().catch(false),
  flawedAssumptions: z.array(z.string()).catch([]),
  suggestedApproach: z.string().catch(''),
  adrRequired: z.boolean().catch(false),
  adrTitle: z.string().catch('')
});

export const ForgeProposalSchema = z.object({
  newTaskDescription: z.string().catch('retry task'),
  keyChanges: z.array(z.string()).catch([]),
  testCriteria: z.array(z.string()).catch([]),
  confidence: z.number().catch(0.7)
});

export const ArchitectPlanSchema = z.object({
  files: z.array(z.object({
    path: z.string(),
    action: z.enum(['modify', 'create', 'delete']),
    changes: z.string()
  })),
  testCriteria: z.array(z.string()),
  riskFlags: z.array(z.string()).optional()
});
