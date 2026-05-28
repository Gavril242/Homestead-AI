// LLM model multiplexer.
//
// Each provider entry declares not just a tier ("weak"/"strong") but the set
// of purposes it serves well. The router picks the best-fit model for the
// requested purpose, biased by remaining quota and current RPM, with hard
// fallover to lower-tier models when the preferred ones are saturated.
//
// Purpose taxonomy (matched against `chat({ purpose })`):
//   plan         — multi-step planning, dependency resolution, deep reasoning
//   synthesize   — code/file generation, refactor, multi-file edits
//   verify       — running tests, classifying pass/fail, summarizing logs
//   summarize    — compressing chat or vault content
//   classify     — short labelling decisions
//   chat         — general agent conversation (default tier-only)
//   embed        — vector embedding (handled by a separate adapter)
//
// Behavior contracts:
//   • recordRequest()   : tracks last-60s request timestamps per provider
//   • markRateLimited() : penalty box for `durationMs` (skipped by the picker)
//   • markBroken()      : permanent skip for this process (auth errors)
//   • pickProviders()   : returns providers ranked best→worst for {tier, purpose}

import { repo, load } from '../db.js';

const liveState = {
  rateLimited: new Map(),     // providerId → { until: epochMs, reason: string }
  broken: new Map(),          // providerId → reason
  recentRequests: new Map(),  // providerId → number[]  (last 60s)
};

// Each provider is duplicated per Gemini key so 5 keys = 5x headroom.
//
// Why hand-tune per-purpose preferenceWeight?
// Because for the same model, value differs by job: Pro is gold for `plan`
// but overkill for `classify`. Higher weight = preferred earlier.
export function buildPool() {
  const pool = [];
  const env = process.env;

  // ── LiteLLM proxy — optional local router (docker-compose up litellm) ───────
  //
  // When LITELLM_URL is set, adds purpose-grouped aliases to the pool at higher
  // priority than direct VIO/Gemini entries. LiteLLM handles retries, fallback
  // chains, and per-model RPM caps internally via litellm-config.yaml.
  // Uses kind='aumovio' because LiteLLM exposes a standard OpenAI-compatible API.
  const litellmUrl = env.LITELLM_URL;
  const litellmKey = env.LITELLM_KEY || 'sk-homestead-local';
  if (litellmUrl) {
    const litellmModels = [
      { suffix: 'plan',      model: 'purpose-plan',      purposes: { plan: 98, synthesize: 80, verify: 60, summarize: 50, chat: 65 }, rpm: 60 },
      { suffix: 'synthesize', model: 'purpose-synthesize', purposes: { plan: 70, synthesize: 98, verify: 85, summarize: 70, chat: 82 }, rpm: 60 },
      { suffix: 'chat',      model: 'purpose-chat',      purposes: { plan: 60, synthesize: 78, verify: 70, summarize: 72, classify: 65, chat: 95 }, rpm: 60 },
      { suffix: 'verify',    model: 'purpose-verify',    purposes: { plan: 55, synthesize: 75, verify: 95, summarize: 68, chat: 72 }, rpm: 60 },
      { suffix: 'summarize', model: 'purpose-summarize', purposes: { plan: 45, synthesize: 60, verify: 60, summarize: 95, classify: 80, chat: 70 }, rpm: 60 },
    ];
    for (const m of litellmModels) {
      pool.push({
        id: `litellm-${m.suffix}`,
        kind: 'aumovio',     // LiteLLM is OpenAI-compatible — reuse callAumovio
        baseUrl: litellmUrl,
        key: litellmKey,
        model: m.model,
        tier: 'strong',
        purposes: m.purposes,
        rpm: m.rpm,
        budget: { window: 'monthly', max: 10_000_000 },
        supportsTools: true,
        isLitellm: true,
      });
    }
  }

  // ── VIO gateway — PRIMARY provider (OpenAI-compatible, Claude + GPT models) ─
  //
  // Base URL: VIO_BASE_URL (https://vio.automotive-wan.com:446)
  // Endpoint: /chat/completions  (NO /v1/ prefix)
  // Auth:     VIO_KEY_1 / VIO_KEY_2  — up to 2 keys for doubled RPM headroom.
  //
  // Active VIO chain (Homestead 1.0 — expanded 2026-05-20):
  //   GPT-5-high        → plan / deep reasoning       (primary planner)
  //   DeepSeek R1       → reasoning chains / debugging
  //   GPT 5-chat        → code gen / synthesis / chat  (⚠ empty responses)
  //   GPT-5.3-Codex     → code synthesis / patches     (⚠ empty responses)
  //   GPT-5.1           → premium planner/executor (Tier B)
  //   Claude 4.6 Sonnet → synthesis/verifier (Tier B)
  //   GPT-5-medium      → balanced mid-tier
  //   GPT-4o            → primary verifier / stable fallback
  //   GPT 5-mini        → cheap summarize/classify/chat fallback
  //   GPT 5-nano        → cheap classify/routing helper
  //   Claude 4.6 Opus   → plan / deep synthesis
  //   Claude 4.5 Opus   → fallback heavy reasoning
  //   Claude 4.5 Sonnet → fallback workhorse
  //   GPT-5-low         → cheap fallback (re-enabled 2026-05-20)
  //   GPT-o3-mini       → reasoning fallback (re-enabled 2026-05-20)
  //   Nova Premier      → AWS fallback (re-enabled 2026-05-20)
  //   GPT-5 (base)      → strong planner/synthesizer (NEW 2026-05-20)
  //   GPT-OSS-120B      → open-source large model (NEW 2026-05-20)
  //   Meta LLaMA 3.3 70B→ open-source workhorse (NEW 2026-05-20)
  //   Nova Lite          → AWS cheap fallback (NEW 2026-05-20)
  //   Nova Micro         → AWS cheapest fallback (NEW 2026-05-20)
  //   GPT-3.5 Turbo     → legacy cheap classify/chat (NEW 2026-05-20)
  //
  // Disabled (add VIO_MODEL_<SUFFIX>_ENABLE=1 to re-enable):
  //   Grok-3, Grok-3-mini, Grok-4-fast, MAI-DS-R1, Qwen 3.5 235B,
  //   Qwen3-coder-480b, Phi-4-reasoning, Claude 3.7 Sonnet,
  //   Claude 3.5 Sonnet, VIO:Gemini 2.5 Pro, VIO:Gemini 2.0 Flash
  const vioBase = env.VIO_BASE_URL || env.AUMOVIO_BASE_URL;  // legacy alias
  if (vioBase) {
    // Collect VIO_KEY_1 … VIO_KEY_N dynamically — just add VIO_KEY_4, VIO_KEY_5, etc.
    // Legacy single-key env vars (VIO_KEY / AUMOVIO_KEY*) still work as slot 1.
    const vioKeys = [];
    for (let n = 1; n <= 9; n++) {
      const k = env[`VIO_KEY_${n}`] || env[`AUMOVIO_KEY_${n}`];
      if (k) vioKeys.push(k);
    }
    if (!vioKeys.length && (env.VIO_KEY || env.AUMOVIO_KEY)) {
      vioKeys.push(env.VIO_KEY || env.AUMOVIO_KEY);
    }

    // ── Homestead 1.0 Routing Matrix ─────────────────────────────────────────
    //
    // Job type          | Primary            | Backup             | Cheap fallback
    // ──────────────────|────────────────────|────────────────────|──────────────────
    // plan/decompose    | VIO:GPT-5-high     | VIO:DeepSeek R1    | Gemini 2.5 Flash
    // synthesize/code   | VIO:GPT 5-chat     | VIO:GPT-5.3-Codex  | VIO:GPT-4o
    // debug/reasoning   | VIO:DeepSeek R1    | VIO:GPT-5-high     | Gemini 2.5 Flash
    // verify/summary    | VIO:GPT-4o         | VIO:GPT 5-mini     | Gemini 3.1 Flash Lite
    // classify/route    | Gemma 4 31B        | Gemma 4 26B        | Gemini 3.1 Flash Lite
    // embed             | Gemini Embedding 1 | —                  | —
    //
    // Prohibited: Gemma/Flash Lite as primary executor; premium VIO as sole classifier;
    //             Grok-3, MAI-DS-R1, Qwen 3.5 235B, Phi-4, Nova Premier in any default path.
    //
    // Re-enable disabled models per-deployment: set VIO_MODEL_<SUFFIX>_ENABLE=1
    // ─────────────────────────────────────────────────────────────────────────────

    // VIO model definitions — full chain confirmed available 2026-04-29.
    // Ordered best→worst. Env overrides via VIO_MODEL_* vars.
    const vioModels = [
      // ── Tier A — GPT-5-high: primary planner / decomposer ────────────────
      {
        suffix: 'gpt5-high', envKey: 'VIO_MODEL_GPT5_HIGH',
        defaultModel: 'VIO:GPT-5-high',
        purposes: { plan: 96, synthesize: 88, verify: 65, summarize: 55, chat: 72 },
        rpm: 30, monthlyBudget: 2_000_000,
        routingHint: 'plan',
      },
      // ── Tier A — DeepSeek R1: primary debugger / reasoning fallback ───────
      {
        suffix: 'deepseek-r1', envKey: 'VIO_MODEL_DEEPSEEK_R1',
        defaultModel: 'VIO:DeepSeek R1',
        purposes: { plan: 90, synthesize: 72, verify: 62, summarize: 52, chat: 65 },
        rpm: 30, monthlyBudget: 2_000_000,
        routingHint: 'debug',
      },
      // ── Tier A — GPT-5 chat: primary synthesizer / code workhorse ─────────
      {
        suffix: 'gpt5-chat', envKey: 'VIO_MODEL_GPT5_CHAT',
        defaultModel: 'VIO:GPT 5-chat',
        purposes: { plan: 76, synthesize: 96, verify: 85, summarize: 75, classify: 65, chat: 88 },
        rpm: 50, monthlyBudget: 2_000_000,
        routingHint: 'synthesize',
      },
      // ── Tier A — GPT-5.3 Codex: code synthesis / patch generation ─────────
      {
        suffix: 'gpt53-codex', envKey: 'VIO_MODEL_GPT53_CODEX',
        defaultModel: 'VIO:GPT-5.3-Codex',
        purposes: { plan: 62, synthesize: 96, verify: 80, summarize: 50, chat: 70 },
        rpm: 50, monthlyBudget: 2_000_000,
        routingHint: 'synthesize',
      },
      // ── DISABLED — Grok-3: adds routing noise without consistent value ─────
      {
        suffix: 'grok3', envKey: 'VIO_MODEL_GROK3',
        defaultModel: 'VIO:Grok-3',
        purposes: { plan: 76, synthesize: 80, verify: 62, summarize: 58, chat: 75 },
        rpm: 30, monthlyBudget: 2_000_000,
        disabled: true,
      },
      // ── DISABLED — Qwen3 Coder 480B: routing noise ───────────────────────
      {
        suffix: 'qwen3-coder', envKey: 'VIO_MODEL_QWEN3_CODER',
        defaultModel: 'VIO:Qwen3-coder-480b-a35b-v1',
        purposes: { plan: 58, synthesize: 90, verify: 72, summarize: 45, chat: 60 },
        rpm: 30, monthlyBudget: 2_000_000,
        disabled: true,
      },
      // ── Tier B — GPT-5.1: premium alternate planner/executor ──────────────
      {
        suffix: 'gpt51', envKey: 'VIO_MODEL_GPT51',
        defaultModel: 'VIO:Gpt-5.1',
        purposes: { plan: 94, synthesize: 94, verify: 80, summarize: 70, chat: 85 },
        rpm: 30, monthlyBudget: 20_000_000,
        routingHint: 'plan',
      },
      // ── DISABLED — Grok-4 fast: routing noise ────────────────────────────
      {
        suffix: 'grok4-fast', envKey: 'VIO_MODEL_GROK4_FAST',
        defaultModel: 'VIO:Grok-4-fast-non-reasoning',
        purposes: { plan: 72, synthesize: 85, verify: 70, summarize: 62, chat: 82 },
        rpm: 30, monthlyBudget: 2_000_000,
        disabled: true,
      },
      // ── DISABLED — MAI-DS-R1: routing noise ──────────────────────────────
      {
        suffix: 'mai-ds-r1', envKey: 'VIO_MODEL_MAI_DS_R1',
        defaultModel: 'VIO:MAI-DS-R1',
        purposes: { plan: 88, synthesize: 78, verify: 65, summarize: 55, chat: 62 },
        rpm: 30, monthlyBudget: 2_000_000,
        disabled: true,
      },
      // ── DISABLED — Qwen 3.5 235B: routing noise ──────────────────────────
      {
        suffix: 'qwen35-235b', envKey: 'VIO_MODEL_QWEN35',
        defaultModel: 'VIO:Qwen 3.5 235B',
        purposes: { plan: 70, synthesize: 85, verify: 68, summarize: 55, chat: 72 },
        rpm: 30, monthlyBudget: 2_000_000,
        disabled: true,
      },
      // ── DISABLED — Phi-4 Reasoning: routing noise ────────────────────────
      {
        suffix: 'phi4-reasoning', envKey: 'VIO_MODEL_PHI4_REASONING',
        defaultModel: 'VIO:Phi-4-reasoning',
        purposes: { plan: 78, synthesize: 65, verify: 60, summarize: 50, chat: 55 },
        rpm: 30, monthlyBudget: 2_000_000,
        disabled: true,
      },
      // ── Tier C — Nova Premier: AWS fallback ────────────────────────────────
      {
        suffix: 'nova-premier', envKey: 'VIO_MODEL_NOVA_PREMIER',
        defaultModel: 'VIO:Nova Premier',
        purposes: { plan: 62, synthesize: 72, verify: 65, summarize: 60, chat: 70 },
        rpm: 50, monthlyBudget: 2_000_000,
      },
      // ── Tier C — GPT-5-low: cheap fallback ────────────────────────────────
      {
        suffix: 'gpt5-low', envKey: 'VIO_MODEL_GPT5_LOW',
        defaultModel: 'VIO:GPT-5-low',
        purposes: { plan: 55, synthesize: 70, verify: 60, summarize: 58, chat: 72 },
        rpm: 50, monthlyBudget: 2_000_000,
      },
      // ── Tier B — GPT 5-mini: cheap summarize / classify / chat fallback ───
      {
        suffix: 'gpt5-mini', envKey: 'VIO_MODEL_GPT5_MINI',
        defaultModel: 'VIO:GPT 5-mini',
        purposes: { plan: 48, synthesize: 60, verify: 55, summarize: 62, classify: 65, chat: 68 },
        rpm: 60, monthlyBudget: 5_000_000,
        routingHint: 'summarize',
      },
      // ── Tier B — GPT 5-nano: cheap classify / routing helper ──────────────
      {
        suffix: 'gpt5-nano', envKey: 'VIO_MODEL_GPT5_NANO',
        defaultModel: 'VIO:GPT 5-nano',
        purposes: { plan: 30, synthesize: 40, verify: 45, summarize: 70, classify: 80, chat: 60 },
        rpm: 60, monthlyBudget: 5_000_000,
        routingHint: 'classify',
      },
      // ── DISABLED — VIO-passthrough Gemini 2.5 Pro (quota unavailable) ─────
      {
        suffix: 'gemini-25-pro', envKey: 'VIO_MODEL_GEMINI_25_PRO',
        defaultModel: 'VIO:Gemini 2.5 Pro',
        purposes: { plan: 92, synthesize: 85, verify: 65, summarize: 50, chat: 68 },
        rpm: 30, monthlyBudget: 2_000_000,
        disabled: true,
      },
      // ── DISABLED — VIO-passthrough Gemini 2.0 Flash ───────────────────────
      {
        suffix: 'gemini-20-flash', envKey: 'VIO_MODEL_GEMINI_20_FLASH',
        defaultModel: 'VIO:Gemini 2.0 Flash',
        purposes: { plan: 50, synthesize: 68, verify: 60, summarize: 60, classify: 55, chat: 72 },
        rpm: 50, monthlyBudget: 2_000_000,
        disabled: true,
      },
      // ── Tier 1 — Claude 4.6 Opus: best reasoning, planning, architecture ──
      {
        suffix: 'opus-46', envKey: 'VIO_MODEL_OPUS_46',
        defaultModel: 'VIO:Claude 4.6 Opus',
        purposes: { plan: 100, synthesize: 92, verify: 68, summarize: 58, chat: 74 },
        rpm: 30, monthlyBudget: 10_000_000,
        routingHint: 'plan',
      },
      // ── Tier B — Claude 4.6 Sonnet: alternate high-quality synthesis/verifier
      {
        suffix: 'sonnet-46', envKey: 'VIO_MODEL_SONNET_46',
        defaultModel: 'VIO:Claude 4.6 Sonnet',
        purposes: { plan: 74, synthesize: 100, verify: 90, summarize: 80, classify: 68, chat: 90 },
        rpm: 50, monthlyBudget: 20_000_000,
        routingHint: 'synthesize',
      },
      // ── Tier 2 — Claude 4.5 Opus: fallback for heavy reasoning ───────────
      {
        suffix: 'opus-45', envKey: 'VIO_MODEL_OPUS_45',
        defaultModel: 'VIO:Claude 4.5 Opus',
        purposes: { plan: 88, synthesize: 82, verify: 60, summarize: 50, chat: 65 },
        rpm: 30, monthlyBudget: 5_000_000,
        routingHint: 'plan',
      },
      // ── Tier 2 — Claude 4.5 Sonnet: fallback workhorse ───────────────────
      {
        suffix: 'sonnet-45', envKey: 'VIO_MODEL_SONNET_45',
        defaultModel: 'VIO:Claude 4.5 Sonnet',
        purposes: { plan: 65, synthesize: 88, verify: 80, summarize: 72, classify: 60, chat: 82 },
        rpm: 50, monthlyBudget: 20_000_000,
        routingHint: 'synthesize',
      },
      // ── Tier B — GPT-5-medium: balanced mid-tier ─────────────────────────
      {
        suffix: 'gpt5-medium', envKey: 'VIO_MODEL_GPT5_MEDIUM',
        defaultModel: 'VIO:GPT-5-medium',
        purposes: { plan: 68, synthesize: 82, verify: 70, summarize: 65, chat: 78 },
        rpm: 50, monthlyBudget: 2_000_000,
      },
      // ── Tier A — GPT-4o: primary verification / stable fallback ──────────
      {
        suffix: 'gpt4o', envKey: 'VIO_MODEL_GPT4O',
        defaultModel: 'VIO:GPT-4o',
        purposes: { plan: 58, synthesize: 76, verify: 72, summarize: 66, classify: 58, chat: 80 },
        rpm: 50, monthlyBudget: 2_000_000,
        routingHint: 'verify',
      },
      // ── Tier C — GPT-o3-mini: reasoning fallback ──────────────────────────
      {
        suffix: 'gpto3-mini', envKey: 'VIO_MODEL_GPTO3_MINI',
        defaultModel: 'VIO:GPT-o3-mini',
        purposes: { plan: 72, synthesize: 62, verify: 55, summarize: 48, chat: 60 },
        rpm: 50, monthlyBudget: 2_000_000,
      },
      // ── DISABLED — Grok-3-mini: routing noise ────────────────────────────
      {
        suffix: 'grok3-mini', envKey: 'VIO_MODEL_GROK3_MINI',
        defaultModel: 'VIO:Grok-3-mini',
        purposes: { plan: 52, synthesize: 58, verify: 50, summarize: 55, chat: 65 },
        rpm: 50, monthlyBudget: 2_000_000,
        disabled: true,
      },
      // ── DISABLED — Claude 3.7 Sonnet ─────────────────────────────────────
      {
        suffix: 'sonnet-37', envKey: 'VIO_MODEL_SONNET_37',
        defaultModel: 'VIO:Claude 3.7 Sonnet',
        purposes: { plan: 45, synthesize: 52, verify: 55, summarize: 65, classify: 55, chat: 72 },
        rpm: 50, monthlyBudget: 2_000_000,
        disabled: true,
      },
      // ── DISABLED — Claude 3.5 Sonnet ─────────────────────────────────────
      {
        suffix: 'sonnet-35', envKey: 'VIO_MODEL_SONNET_35',
        defaultModel: 'VIO:Claude 3.5 Sonnet',
        purposes: { plan: 35, synthesize: 42, verify: 45, summarize: 60, classify: 50, chat: 65 },
        rpm: 50, monthlyBudget: 5_000_000,
        disabled: true,
      },
      // ── NEW — GPT-5 (base): strong planner/synthesizer ────────────────────
      {
        suffix: 'gpt5', envKey: 'VIO_MODEL_GPT5',
        defaultModel: 'VIO:GPT-5',
        purposes: { plan: 90, synthesize: 92, verify: 75, summarize: 68, chat: 85 },
        rpm: 30, monthlyBudget: 2_000_000,
        routingHint: 'plan',
      },
      // ── NEW — GPT-OSS-120B: open-source large model ───────────────────────
      {
        suffix: 'gpt-oss-120b', envKey: 'VIO_MODEL_GPT_OSS_120B',
        defaultModel: 'VIO:GPT-OSS-120B',
        purposes: { plan: 60, synthesize: 78, verify: 65, summarize: 62, chat: 75 },
        rpm: 30, monthlyBudget: 5_000_000,
        routingHint: 'synthesize',
      },
      // ── NEW — Meta LLaMA 3.3 70B: open-source workhorse ───────────────────
      {
        suffix: 'llama-70b', envKey: 'VIO_MODEL_LLAMA_70B',
        defaultModel: 'VIO:Meta LLaMA 3.3 70B',
        purposes: { plan: 55, synthesize: 72, verify: 60, summarize: 65, classify: 60, chat: 75 },
        rpm: 30, monthlyBudget: 5_000_000,
        routingHint: 'synthesize',
      },
      // ── NEW — Nova Lite: AWS cheap fallback ────────────────────────────────
      {
        suffix: 'nova-lite', envKey: 'VIO_MODEL_NOVA_LITE',
        defaultModel: 'VIO:Nova Lite',
        purposes: { plan: 40, synthesize: 55, verify: 55, summarize: 65, classify: 60, chat: 65 },
        rpm: 50, monthlyBudget: 5_000_000,
        routingHint: 'summarize',
      },
      // ── NEW — Nova Micro: AWS cheapest fallback ────────────────────────────
      {
        suffix: 'nova-micro', envKey: 'VIO_MODEL_NOVA_MICRO',
        defaultModel: 'VIO:Nova Micro',
        purposes: { plan: 30, synthesize: 40, verify: 45, summarize: 60, classify: 65, chat: 60 },
        rpm: 60, monthlyBudget: 10_000_000,
        routingHint: 'classify',
      },
      // ── NEW — GPT-3.5 Turbo: legacy cheap classify/chat ───────────────────
      {
        suffix: 'gpt35-turbo', envKey: 'VIO_MODEL_GPT35_TURBO',
        defaultModel: 'VIO:GPT-3.5 Turbo',
        purposes: { plan: 35, synthesize: 45, verify: 50, summarize: 60, classify: 55, chat: 65 },
        rpm: 60, monthlyBudget: 5_000_000,
        routingHint: 'classify',
      },
    ];

    for (let i = 0; i < vioKeys.length; i++) {
      const key = vioKeys[i];
      const slot = i + 1;
      for (const m of vioModels) {
        // Skip disabled models unless explicitly re-enabled via <envKey>_ENABLE=1
        if (m.disabled && !env[m.envKey + '_ENABLE']) continue;
        pool.push({
          id: `vio-${m.suffix}-${slot}`, kind: 'aumovio',   // kind='aumovio' reuses callAumovio (OpenAI-compat)
          baseUrl: vioBase, key,
          model: env[m.envKey] || m.defaultModel, tier: 'strong',
          purposes: m.purposes,
          rpm: m.rpm, budget: { window: 'monthly', max: m.monthlyBudget },
          supportsTools: true,
          ...(m.routingHint ? { routingHint: m.routingHint } : {}),
        });
      }
    }
  }

  for (let i = 1; i <= 5; i++) {
    const key = env[`GEMINI_KEY_${i}`];
    if (!key) continue;

    // ── 2.5 Pro — DISABLED (quota unavailable; re-enable with GEMINI_PRO_ENABLE=1) ─
    if (env.GEMINI_PRO_ENABLE) pool.push({
      id: `gemini-pro-${i}`, kind: 'gemini', key,
      model: 'gemini-2.5-pro', tier: 'strong',
      purposes: { plan: 100, synthesize: 88, verify: 65, summarize: 50, classify: 30, chat: 70 },
      rpm: 5, budget: { window: 'daily', max: 200_000 },
      supportsTools: true,
      routingHint: 'plan',
    });

    // ── 2.5 Flash — classify, secondary planning, log compression ────────
    pool.push({
      id: `gemini-flash-${i}`, kind: 'gemini', key,
      model: 'gemini-2.5-flash', tier: 'strong',
      purposes: { plan: 60, synthesize: 90, verify: 70, summarize: 60, classify: 60, chat: 80 },
      rpm: 5, budget: { window: 'daily', max: 250_000 },
      supportsTools: true,
      routingHint: 'classify',
    });

    // ── 3.1 Flash Lite — ultra-cheap classify / route / normalize ─────────
    pool.push({
      id: `gemini-3.1-flash-lite-${i}`, kind: 'gemini', key,
      model: 'gemini-3.1-flash-lite-preview', tier: 'strong',
      purposes: { plan: 50, synthesize: 70, verify: 80, summarize: 75, classify: 80, chat: 80 },
      rpm: 15, budget: { window: 'daily', max: 1_000_000 },
      supportsTools: true,
      routingHint: 'classify',
    });

    // ── 2.5 Flash Lite — cheap classifier/summarizer ──────────────────
    pool.push({
      id: `gemini-flash-lite-${i}`, kind: 'gemini', key,
      model: 'gemini-2.5-flash-lite', tier: 'weak',
      purposes: { plan: 30, synthesize: 50, verify: 70, summarize: 80, classify: 90, chat: 70 },
      rpm: 10, budget: { window: 'daily', max: 1_000_000 },
      supportsTools: true,
      routingHint: 'classify',
    });

    // ── Gemma 4 31B — primary classifier/judge (1.5K RPD, 15 RPM) ───
    // Doesn't support function calling, so the chat router excludes it
    // when tools are required. For text-only purposes (chat, manager,
    // summarize) it's the highest-priority pick because of its quota.
    pool.push({
      id: `gemma4-31b-${i}`, kind: 'gemini', key,
      model: 'gemma-4-31b-it', tier: 'strong',
      purposes: { summarize: 100, classify: 90, chat: 100 },
      rpm: 15, budget: { window: 'daily', max: 5_000_000 },
      supportsTools: false,
      routingHint: 'classify',
    });
    pool.push({
      id: `gemma4-26b-${i}`, kind: 'gemini', key,
      model: 'gemma-4-26b-a4b-it', tier: 'weak',
      purposes: { summarize: 100, classify: 100, chat: 95 },
      rpm: 15, budget: { window: 'daily', max: 5_000_000 },
      supportsTools: false,
      routingHint: 'classify',
    });

    // ── Embeddings (gemini-embedding-001 — 100 RPM, 1K RPD) ───────────
    pool.push({
      id: `gemini-embed-${i}`, kind: 'gemini-embed', key,
      model: 'gemini-embedding-001', tier: 'embed',
      purposes: { embed: 100 },
      rpm: 100, budget: { window: 'daily', max: 1_000_000 },
      supportsTools: false,
    });
  }

  // Anthropic direct — reserved for future use (leave ANTHROPIC_API_KEY blank).
  // Wired up but inactive; add a key when needed as a last-resort fallback.
  if (env.ANTHROPIC_API_KEY) {
    pool.push({
      id: 'anthropic-opus', kind: 'anthropic',
      key: env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL_OPUS || 'claude-opus-4-6', tier: 'strong',
      purposes: { plan: 100, synthesize: 90, verify: 60, summarize: 50, chat: 70 },
      rpm: 30, budget: { window: 'monthly', max: 500_000 },
      supportsTools: false, // callAnthropic() doesn't implement tool calling yet
    });
    pool.push({
      id: 'anthropic-sonnet', kind: 'anthropic',
      key: env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL_SONNET || 'claude-sonnet-4-6', tier: 'strong',
      purposes: { plan: 70, synthesize: 100, verify: 85, summarize: 75, classify: 60, chat: 85 },
      rpm: 50, budget: { window: 'monthly', max: 2_000_000 },
      supportsTools: false, // callAnthropic() doesn't implement tool calling yet
    });
  }

  return pool;
}

// ── Token usage (persistent across restarts) ──────────────────────────

export function tokensUsed(providerId, window = 'daily') {
  const usage = load().llm_usage;
  const windowMs = window === 'monthly' ? 30 * 24 * 60 * 60 * 1000
    : window === 'weekly'               ?  7 * 24 * 60 * 60 * 1000
    :                                      24 * 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;
  return usage
    .filter((u) => u.provider === providerId && u.ts >= cutoff)
    .reduce((acc, u) => acc + (u.prompt_tokens + u.output_tokens), 0);
}

export function tokensRemaining(p) {
  return Math.max(0, p.budget.max - tokensUsed(p.id, p.budget?.window));
}

export function recordUsage({ provider, model, tier, purpose, prompt_tokens, output_tokens, agent_id, duration_ms, project_id }) {
  repo.prepend('llm_usage', {
    id: `${provider}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    provider, model, tier, purpose,
    prompt_tokens: prompt_tokens || 0,
    output_tokens: output_tokens || 0,
    agent_id, project_id, duration_ms, ts: Date.now(),
  }, 5000);
}

// ── In-memory live state ──────────────────────────────────────────────

export function recordRequest(providerId) {
  const now = Date.now();
  const arr = liveState.recentRequests.get(providerId) || [];
  while (arr.length && arr[0] < now - 60_000) arr.shift();
  arr.push(now);
  liveState.recentRequests.set(providerId, arr);
}

export function requestsLastMinute(providerId) {
  const now = Date.now();
  const arr = liveState.recentRequests.get(providerId) || [];
  return arr.filter((ts) => ts >= now - 60_000).length;
}

export function markRateLimited(providerId, durationMs) {
  liveState.rateLimited.set(providerId, { until: Date.now() + durationMs, reason: 'rate-limited' });
}

export function markBroken(providerId, reason) {
  // For empty-response auto-breaks, use a timed cooldown (10 min) instead of permanent.
  // Auth errors (401/403) stay permanently broken.
  if (reason?.startsWith('auto-break:')) {
    liveState.broken.set(providerId, { reason, until: Date.now() + 10 * 60_000 });
  } else {
    liveState.broken.set(providerId, { reason, until: Infinity });
  }
}

export function isProviderUsable(providerId) {
  const b = liveState.broken.get(providerId);
  if (b) {
    if (b.until <= Date.now()) {
      liveState.broken.delete(providerId);  // cooldown expired — provider recoverable
      console.log(`[llm] ${providerId} recovered from broken state (cooldown expired)`);
    } else {
      return false;
    }
  }
  const rl = liveState.rateLimited.get(providerId);
  if (rl && rl.until > Date.now()) return false;
  if (rl && rl.until <= Date.now()) liveState.rateLimited.delete(providerId);
  return true;
}

// ── Multiplexer routing ───────────────────────────────────────────────
//
// Picks providers ranked by:
//   1. Purpose-fit (provider must declare a purposes[purpose] score > 0)
//   2. Currently usable (not rate-limited, not broken, RPM not maxed)
//   3. Composite score: purpose_score * 100 + routing_hint_bonus + headroom - rpm_pressure
//
// Routing hint bonus (+300): when provider.routingHint matches the canonical
// purpose (or its debug↔plan equivalence). This ensures that the matrix-assigned
// primary model always wins over equally-scored alternatives — e.g. GPT-5-high
// tops the plan list over DeepSeek R1 and Gemini, and Gemma/Flash Lite tops
// classify over premium VIO planners that lack a classify score entirely.
//
// Map fuzzy/freeform purpose strings to the canonical buckets in `purposes`.
// New callers can use `chat`, `plan`, `synthesize`, `verify`, `summarize`, etc.
// directly. Older or freeform names route here.
const PURPOSE_ALIASES = {
  'agent-chat': 'chat',
  'manager-chat': 'chat',           // text summary, no tools needed → Gemma fits
  'task-execution': 'synthesize',
  'edit-code': 'synthesize',
  'plan-sprint': 'plan',
  'design-interface': 'plan',
  'normalize-req': 'summarize',
  'run-tests': 'verify',
  'rerun-failing': 'verify',
  'kick-pipeline': 'verify',
  'write-adr': 'summarize',
  'postmortem': 'summarize',
  'minimal-fix': 'synthesize',
  'repro-bug': 'verify',
  'isolate-bug': 'plan',
};

// Routing hint → canonical purpose mapping (debug is a plan-tier concern).
const HINT_CANONICAL = {
  plan: 'plan', debug: 'plan',
  synthesize: 'synthesize',
  verify: 'verify',
  summarize: 'summarize',
  classify: 'classify',
};

const ROUTING_HINT_BONUS = 300;

function resolvePurpose(p) {
  if (!p) return 'chat';
  return PURPOSE_ALIASES[p] || p;
}

// `tier` acts as a coarse filter when given; otherwise pure purpose-fit.
// If the requested purpose isn't declared by any provider, fall back to `chat`
// so the call still routes (instead of hitting the canned-reply fallback).
export function pickProviders(pool, { tier, purpose = 'chat' } = {}) {
  const canonical = resolvePurpose(purpose);
  const base = pool
    .filter((p) => p.kind !== 'gemini-embed')           // embeddings have their own picker
    .filter((p) => !tier || p.tier === tier || (tier === 'weak' && p.tier === 'strong') || tier === 'fast')  // weak can fall up to strong
    .filter((p) => isProviderUsable(p.id))
    .filter((p) => !p.rpm || requestsLastMinute(p.id) < p.rpm);

  // Prefer providers with budget headroom; if ALL are over-budget, use them anyway
  // (lifeboat) rather than falling through to the canned-reply path.
  const budgeted = base.filter((p) => tokensRemaining(p) > 1000);
  const eligible = budgeted.length > 0 ? budgeted : base;

  // If no provider declares this purpose, fall back to `chat` (every chat-tier
  // provider declares a chat score, so we always have something).
  const declaresPurpose = eligible.filter((p) => (p.purposes?.[canonical] ?? 0) > 0);
  const pool2 = declaresPurpose.length ? declaresPurpose : eligible.filter((p) => (p.purposes?.chat ?? 0) > 0);
  const scoreKey = declaresPurpose.length ? canonical : 'chat';

  return pool2
    .map((p) => ({
      provider: p,
      // Purpose score dominates; token headroom and RPM are tie-breakers only.
      // Divide remaining by budget to normalise (0–1 range scaled to 200 pts max).
      // Routing hint bonus (+300) locks in the matrix-assigned primary model
      // over equally-scored alternatives without distorting the fallback chain.
      score: (p.purposes[scoreKey] || 0) * 100
        + (p.routingHint && HINT_CANONICAL[p.routingHint] === canonical ? ROUTING_HINT_BONUS : 0)
        + Math.min(200, (tokensRemaining(p) / (p.budget?.max || 1_000_000)) * 200)
        - requestsLastMinute(p.id) * 5,
    }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.provider);
}

// Dedicated picker for embeddings.
export function pickEmbedder(pool) {
  return pool
    .filter((p) => p.kind === 'gemini-embed')
    .filter((p) => isProviderUsable(p.id))
    .filter((p) => tokensRemaining(p) > 100)
    .sort((a, b) => requestsLastMinute(a.id) - requestsLastMinute(b.id))[0] || null;
}

// ── Homestead 1.0 canonical routing matrix ───────────────────────────
//
// Exported for inspection (e.g. GET /api/llm/routing-matrix) and for
// documentation tooling. Mirrors the routingHint assignments above.
export const HOMESTEAD_ROUTING_MATRIX = {
  plan: {
    primary:   'VIO:GPT-5-high',
    backup:    'VIO:DeepSeek R1',
    cheapFallback: 'Gemini 2.5 Flash (low-stakes only)',
    prohibited: 'Gemini free-tier as sole heavy planner',
  },
  synthesize: {
    primary:   'VIO:GPT 5-chat',
    backup:    'VIO:GPT-5.3-Codex',
    cheapFallback: 'VIO:GPT-4o',
    prohibited: 'Gemma/Flash Lite as primary executor',
  },
  debug: {
    primary:   'VIO:DeepSeek R1',
    backup:    'VIO:GPT-5-high',
    cheapFallback: 'Gemini 2.5 Flash (summarization only)',
    prohibited: 'broad multi-model roulette',
  },
  verify: {
    primary:   'VIO:GPT-4o',
    backup:    'VIO:GPT 5-mini',
    cheapFallback: 'Gemini 3.1 Flash Lite',
    prohibited: 'canned fallback in production verdict paths',
  },
  classify: {
    primary:   'Gemma 4 31B',
    backup:    'Gemma 4 26B',
    cheapFallback: 'Gemini 3.1 Flash Lite',
    prohibited: 'premium VIO planners',
  },
  embed: {
    primary:   'Gemini Embedding 1',
    backup:    null,
    cheapFallback: null,
    prohibited: 'multiple concurrent embedding systems',
  },
};

// ── Snapshot for /api/llm/pool ────────────────────────────────────────

export function poolSnapshot(pool) {
  return pool.map((p) => {
    const broken = liveState.broken.get(p.id);
    const rl = liveState.rateLimited.get(p.id);
    const rateLimitedFor = rl && rl.until > Date.now() ? Math.ceil((rl.until - Date.now()) / 1000) : 0;
    return {
      id: p.id, kind: p.kind, tier: p.tier, model: p.model,
      purposes: p.purposes,
      used_tokens: tokensUsed(p.id, p.budget?.window),
      used_24h: tokensUsed(p.id, 'daily'),   // kept for UI backwards compat
      max: p.budget.max, window: p.budget.window,
      remaining: tokensRemaining(p),
      rpm_cap: p.rpm || null,
      rpm_now: requestsLastMinute(p.id),
      rate_limited_for_seconds: rateLimitedFor,
      broken: broken || null,
      usable: isProviderUsable(p.id) && tokensRemaining(p) > 1000,
    };
  });
}
