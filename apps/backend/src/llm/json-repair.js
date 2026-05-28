/**
 * Syntactic Bouncer — cheap JSON repair using a fast model.
 * Called when a tool-call JSON string fails to parse.
 * Never touches business logic, only fixes syntax.
 */

// A single stateless call - no thread, no tools
let _repairInFlight = 0;
const MAX_CONCURRENT_REPAIRS = 3;

export async function repairJson(rawStr, parseError) {
  if (_repairInFlight >= MAX_CONCURRENT_REPAIRS) {
    // Too many concurrent repairs — fall through to manual only
    return manualRepair(rawStr);
  }

  // Try manual fixups first (free, synchronous)
  const manual = manualRepair(rawStr);
  if (manual !== null) return manual;

  _repairInFlight++;
  try {
    const { chat } = await import('./index.js');
    const result = await chat({
      system: 'You are a JSON syntax fixer. Return ONLY the corrected JSON. No explanation, no markdown fences, no extra text.',
      messages: [{
        role: 'user',
        content: `Fix this JSON so it parses correctly. The parse error was: ${parseError}\n\nRaw input:\n${rawStr.slice(0, 8000)}`,
      }],
      purpose: 'classify',
      tier: 'fast',
      toolScopes: [],
      maxTokens: 4096,
    });

    const reply = result?.reply?.trim() || '';
    // Strip markdown fences if model added them
    const cleaned = reply.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();

    // Validate the repair actually parses
    JSON.parse(cleaned); // throws if still broken
    return cleaned;
  } catch (e) {
    console.warn('[json-repair] LLM repair failed:', e.message?.slice(0, 100));
    return null; // caller will handle original error
  } finally {
    _repairInFlight--;
  }
}

// Manual regex fixups — handles common LLM output mistakes without any LLM call
function manualRepair(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();

  // Strip markdown fences
  s = s.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();

  // Already valid?
  try { JSON.parse(s); return s; } catch {}

  // Fix trailing commas before } or ]
  s = s.replace(/,(\s*[}\]])/g, '$1');

  // Add missing closing braces/brackets
  const opens    = (s.match(/\{/g) || []).length - (s.match(/\}/g) || []).length;
  const openArr  = (s.match(/\[/g) || []).length - (s.match(/\]/g) || []).length;
  if (opens   > 0) s += '}'.repeat(opens);
  if (openArr > 0) s += ']'.repeat(openArr);

  // Fix unquoted keys: { foo: "bar" } → { "foo": "bar" }
  s = s.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');

  try { JSON.parse(s); return s; } catch {}
  return null;
}
