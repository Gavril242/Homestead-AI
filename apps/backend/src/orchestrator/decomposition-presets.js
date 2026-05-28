// apps/backend/src/orchestrator/decomposition-presets.js
//
// Decomposition Presets — strategic intelligence for the conductor pipeline.
//
// Unlike skills (which tell agents HOW to do things), presets tell the conductor
// HOW TO THINK about a goal before decomposing it into tasks.
//
// Presets inject:
//   1. STRATEGY — the correct task dependency chain (e.g., "reverse-engineer first, then build, then validate")
//   2. MANDATORY GATES — acceptance criteria that must exist on output tasks
//   3. ANTI-PATTERNS — things the LLM must NOT do (e.g., "never mark done without verifying output size")
//   4. REFERENCE DISCOVERY — what to look for in the workspace before starting
//
// The system has two layers:
//   - GLOBAL PRESETS: Apply to all projects (pattern-matched on goal text)
//   - PROJECT PRESETS: Per-project rules loaded from data/presets/{projectId}.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRESETS_DIR = path.resolve(__dirname, '../../data/presets');

// ── Global Presets (pattern-matched) ────────────────────────────────────────

const GLOBAL_PRESETS = [
  {
    id: 'file-conversion',
    triggers: /convert|transform|migrate|translate.*(?:file|format|excel|csv|xml|json|seq|doc)/i,
    strategy: `FILE CONVERSION STRATEGY (MANDATORY SEQUENCE):
1. DISCOVER: Find reference/example files of the TARGET format in the workspace. Read them. Document their structure.
2. ANALYZE: Read the SOURCE file(s). Map source fields → target fields. Identify gaps and ambiguities.
3. SCHEMA: Write a formal mapping document: source field → target field → transformation rule.
4. BUILD: Create the converter script/tool. Use the mapping document as the contract.
5. VALIDATE: Run the converter. Compare output STRUCTURALLY against reference files:
   - Element/record count must match source (±5% tolerance unless documented).
   - File size must be proportional to source (if reference is 3MB for 500 items, output should scale similarly).
   - Key structural markers must be present (tags, headers, required fields).
6. GATE: The conversion task is NOT done until validation passes.

CRITICAL: Step 1 (DISCOVER) and Step 2 (ANALYZE) must be SEPARATE tasks that complete BEFORE the build task starts.
The build task DEPENDS ON the discovery and analysis tasks.`,
    mandatoryGates: [
      'Output file must exist and have size > 0',
      'Output element/record count must match source inventory (specify exact number in acceptance command)',
      'Output must pass structural validation against documented schema',
    ],
    antiPatterns: [
      'NEVER verify with -WhatIf or dry-run only — must produce and validate real output',
      'NEVER declare done based on "script parsed without errors" — must verify actual output content',
      'NEVER skip output size/count check — a 5KB file when expecting 3MB is not success',
      'If Excel COM or external tool times out, implement a FALLBACK using pre-extracted data (JSON dump, CSV export)',
    ],
  },
  {
    id: 'reverse-engineering',
    triggers: /reverse.?engineer|analyze.*(?:schema|format|structure)|figure.*out.*(?:how|format|structure)|understand.*(?:format|schema|protocol)/i,
    strategy: `REVERSE ENGINEERING STRATEGY (MANDATORY SEQUENCE):
1. COLLECT: Gather 3+ example files of the target format from the workspace.
2. COMPARE: Diff the examples — identify common structure vs variable content.
3. DOCUMENT: Write a schema/spec document with: root structure, required fields, field types, ordering rules, naming conventions.
4. VALIDATE UNDERSTANDING: Parse one example with your schema — every field must map. If gaps exist, go back to step 2.
5. DELIVERABLE: The spec document IS the deliverable. It must be machine-readable enough that a converter can be built from it.

CRITICAL: The schema spec task must complete and be validated BEFORE any generation/conversion task starts.`,
    mandatoryGates: [
      'Schema document must cover all structural elements found in examples',
      'At least 2 example files must be fully parseable using the documented schema',
    ],
    antiPatterns: [
      'NEVER write a converter before documenting the target schema',
      'NEVER assume format from a single example — compare at least 2-3',
      'NEVER skip the "validate understanding" step',
    ],
  },
  {
    id: 'code-generation',
    triggers: /(?:create|build|implement|write|generate).*(?:script|tool|utility|module|converter|generator|parser)/i,
    strategy: `CODE GENERATION STRATEGY:
1. REQUIREMENTS: Define exact inputs, outputs, and edge cases before writing code.
2. REFERENCE: Find similar existing tools in the workspace. Reuse patterns and libraries.
3. IMPLEMENT: Write the code with inline validation (assert inputs, check outputs).
4. TEST: Run against real data (not mocks). Verify output matches expectations.
5. ACCEPTANCE: Define a concrete command that proves the tool works on real input.

CRITICAL: The acceptance command must verify the OUTPUT, not just that the script runs.`,
    mandatoryGates: [
      'Tool must run against real input data (not test/mock data)',
      'Output must be verified for correctness (not just "no errors")',
    ],
    antiPatterns: [
      'NEVER test only with mock/synthetic data if real data is available',
      'NEVER accept "script runs without errors" as proof of correctness',
      'NEVER skip output validation — running successfully ≠ producing correct output',
    ],
  },
  {
    id: 'integration-testing',
    triggers: /(?:test|verify|validate|check|audit).*(?:integration|end.to.end|e2e|output|result|conversion)/i,
    strategy: `VALIDATION STRATEGY:
1. DEFINE EXPECTED: Before running validation, document what "correct" looks like (counts, sizes, structural markers).
2. BUILD VALIDATOR: Create a validation script that checks ALL defined criteria and exits non-zero on failure.
3. RUN AND REPORT: Execute validation. If it fails, the task that produced the output must be re-run.
4. The validator script itself must exit non-zero when checks fail (not just print "FAIL").

CRITICAL: Validation scripts must use exit codes — exit 0 only on full pass.`,
    mandatoryGates: [
      'Validation script must exit non-zero on any check failure',
      'All expected counts/sizes must be specified as constants (not "looks reasonable")',
    ],
    antiPatterns: [
      'NEVER write a validator that prints "FAIL" but exits 0',
      'NEVER use subjective criteria ("looks correct") — use quantitative checks',
    ],
  },
  {
    id: 'workspace-discovery',
    triggers: /(?:scan|explore|inventory|catalog|list|find).*(?:workspace|project|files|codebase|directory)/i,
    strategy: `WORKSPACE DISCOVERY STRATEGY:
1. SCAN: List the directory tree (depth 2-3). Identify file types and patterns.
2. SAMPLE: Read 2-3 representative files of each type. Note their structure.
3. DOCUMENT: Write an inventory: file patterns, counts, purposes, relationships.
4. DELIVERABLE: The inventory document with enough detail to guide subsequent tasks.`,
    mandatoryGates: [
      'Inventory must include file counts and representative structure',
    ],
    antiPatterns: [
      'NEVER just list filenames — read and understand the content',
    ],
  },
  {
    id: 'web-development',
    triggers: /(?:website|web\s*app|web\s*page|landing\s*page|dashboard|portal|frontend|full.?stack|react|vue|node.*server|express|http.*server|html.*css|responsive|SPA|single.page)/i,
    strategy: `WEB DEVELOPMENT LIFECYCLE (MANDATORY SEQUENCE):
1. REQUIREMENTS (Aria): Define pages/routes, UI components, API endpoints, data models. Create REQ-* for each feature.
2. ARCHITECTURE (Delphi): Tech stack decision (React UMD CDN / Vue / vanilla), folder structure, API design, database schema. Write ADR + architecture.md.
3. SCAFFOLD (Max): Initialize project — package.json, folder structure (src/, public/, tests/), install dependencies. Configure ESLint, scripts. Run "npm install" and verify it succeeds.
4. BACKEND (Forge): Build API server (Express/Node.js). Create routes, middleware, database connections. Run server with shell_bg (NOT shell_exec for persistent servers). Verify API responds with curl.
5. FRONTEND (William/Forge): Build UI components, pages, styles. Connect to API. Use React UMD CDN (no bundler) for browser apps unless the goal specifies otherwise.
6. TESTING (Vince): Write and run tests — unit tests, API tests, integration tests. Show real exit codes. File bugs for failures.
7. DOCUMENTATION (Scribe): Write README, API docs, architecture docs. Push to Confluence if enabled. Create Jira issues from requirements if enabled.
8. SHIP (Max/Forge): Start the server on a port using shell_bg. Verify the site loads with curl. Report the URL.

CRITICAL RULES:
- ALL persistent servers MUST use shell_bg, NEVER shell_exec (which blocks forever).
- To verify a server is running: shell_exec("curl -s http://localhost:PORT") — must return HTML/JSON.
- Frontend files go in public/ or dist/. Backend in src/.
- ALWAYS install dependencies (npm install) BEFORE trying to run anything.
- The SHIP task is NOT done until the website is accessible on a port and curl confirms it serves content.
- If Atlassian is enabled: Scribe MUST create Confluence space + seed pages + push docs. Scribe MUST create Jira issues from requirements.`,
    mandatoryGates: [
      'npm install must exit 0 with no missing peer dependencies',
      'Server must be running (shell_bg) and respond to curl on the configured port',
      'At least one page/route must render correct HTML (verified by curl or browser_run)',
      'All tests must pass (exit 0) before marking done',
    ],
    antiPatterns: [
      'NEVER use shell_exec for persistent servers — use shell_bg or the server will hang the agent',
      'NEVER skip npm install — missing dependencies cause every subsequent step to fail',
      'NEVER claim "the site works" without actually curling the URL and showing the response',
      'NEVER create frontend code that requires a bundler (webpack/vite/etc.) unless explicitly requested — use React UMD CDN or vanilla JS',
      'NEVER leave the server down — the final deliverable MUST be a running, accessible website',
    ],
  },
  {
    id: 'utas-autosar',
    triggers: /(?:utas|autosar|arxml|swc|diagnostic|ecu|can\s*bus|lin\s*bus|someip|som\/ip|flexray|doip|uds|obd|capl|a2l|odx|pdx|fibex|dbc|ldf|eth|oem|tier.?1|adas|bsw|mcal|rte|os_task|runnable|port.*interface|client.?server|sender.?receiver)/i,
    strategy: `uTAS / AUTOSAR LIFECYCLE (MANDATORY SEQUENCE):
1. ANALYZE (Aria/Delphi): Inventory existing ARXML, SWC definitions, port interfaces, data types. Understand the current architecture. Document in vault with kind="utas-analysis".
2. REQUIREMENTS (Aria): Define or update requirements (REQ-*) with testable acceptance criteria. Map requirements to SWC components and interfaces.
3. ARCHITECTURE (Delphi): Design or update component architecture — SWC decomposition, port interfaces (client-server, sender-receiver), data types, runnables. Write ADR with PlantUML component diagram.
4. IMPLEMENT (Forge): Create/modify ARXML files, C source, header files. Follow AUTOSAR naming conventions. Run MISRA-C checks if available. Write vault run record.
5. TEST (Vince): Run unit tests, integration tests, CAPL test scripts. Verify against requirements. File bugs for failures. Write test execution records to vault.
6. REPORT (Scribe): Generate test reports, coverage reports, compliance reports. Update Confluence if enabled. Link everything back to requirements for traceability.
7. MAINTAIN: For maintenance tasks — analyze impact (trace_impact), propose minimal changes, test regression, document changes.

CRITICAL RULES:
- ALWAYS use trace_impact before modifying interfaces — shows every consumer that will break.
- ARXML files must be well-formed XML. Validate with shell_exec before committing.
- Every SWC change must have a corresponding test update.
- Requirements traceability is MANDATORY — every implementation must link to a REQ-*.
- For diagnostic sessions: follow UDS sequence (0x10 DiagSession, 0x27 SecAccess, etc.).
- Use vault extensively — the knowledge graph IS the project documentation.`,
    mandatoryGates: [
      'All modified ARXML files must be valid XML (xmllint or equivalent check)',
      'Every implementation change must reference a REQ-* in its task description',
      'Test execution must show real exit codes — no inferred results',
      'trace_impact must be called before interface changes',
    ],
    antiPatterns: [
      'NEVER modify a port interface without running trace_impact first',
      'NEVER skip ARXML validation — malformed XML breaks the entire toolchain',
      'NEVER claim test coverage without running the actual tests',
      'NEVER create a SWC without defining its ports and runnables in the ADR first',
    ],
  },
];

// ── Project Presets ─────────────────────────────────────────────────────────

// Load project-specific preset rules.
// Stored in data/presets/{projectId}.json
//
// Format:
// {
//   "rules": [
//     { "trigger": "regex string", "strategy": "...", "mandatoryGates": [...], "antiPatterns": [...] }
//   ],
//   "globalContext": "Always-injected context string",
//   "referenceFormats": { "seq": { "exampleGlob": "prj/**/*.seq", "minCount": "...", "sizeRatio": "..." } },
//   "outputConventions": { ... }
// }
function loadProjectPreset(projectId) {
  const presetFile = path.join(PRESETS_DIR, `${projectId}.json`);
  if (!fs.existsSync(presetFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(presetFile, 'utf8'));
  } catch (e) {
    console.warn(`[decomposition-presets] failed to parse ${presetFile}: ${e.message}`);
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Match applicable presets for a goal + project.
 * Returns { strategies, mandatoryGates, antiPatterns, projectContext }
 * to inject into the conductor pipeline's LLM prompt.
 */
export function matchPresets(projectId, goal) {
  const matched = {
    strategies: [],
    mandatoryGates: [],
    antiPatterns: [],
    projectContext: '',
    referenceDiscovery: [],
  };

  // 1. Match global presets
  for (const preset of GLOBAL_PRESETS) {
    if (preset.triggers.test(goal)) {
      matched.strategies.push({ id: preset.id, text: preset.strategy });
      matched.mandatoryGates.push(...(preset.mandatoryGates || []));
      matched.antiPatterns.push(...(preset.antiPatterns || []));
    }
  }

  // 2. Match project presets
  const projPreset = loadProjectPreset(projectId);
  if (projPreset) {
    if (projPreset.globalContext) {
      matched.projectContext = projPreset.globalContext;
    }

    for (const rule of (projPreset.rules || [])) {
      try {
        const re = new RegExp(rule.trigger, 'i');
        if (re.test(goal)) {
          if (rule.strategy) matched.strategies.push({ id: rule.id || 'project-rule', text: rule.strategy });
          if (rule.mandatoryGates) matched.mandatoryGates.push(...rule.mandatoryGates);
          if (rule.antiPatterns) matched.antiPatterns.push(...rule.antiPatterns);
        }
      } catch { /* bad regex — skip */ }
    }

    // Reference format discovery hints
    if (projPreset.referenceFormats) {
      for (const [format, config] of Object.entries(projPreset.referenceFormats)) {
        if (goal.toLowerCase().includes(format)) {
          matched.referenceDiscovery.push({
            format,
            exampleGlob: config.exampleGlob,
            expectedCount: config.minCount,
            sizeHint: config.sizeRatio,
          });
        }
      }
    }
  }

  return matched;
}

/**
 * Build the preset injection block for the conductor pipeline's LLM prompt.
 * Returns a string to append to the decomposition prompt, or '' if no presets match.
 */
export function buildPresetBlock(projectId, goal) {
  const presets = matchPresets(projectId, goal);

  if (!presets.strategies.length && !presets.projectContext && !presets.mandatoryGates.length) {
    return '';
  }

  const sections = [];

  if (presets.projectContext) {
    sections.push(`PROJECT CONTEXT (always applies):\n${presets.projectContext}`);
  }

  if (presets.strategies.length) {
    sections.push(`DECOMPOSITION STRATEGIES (YOU MUST FOLLOW THESE — they override your default planning):\n\n${presets.strategies.map(s => s.text).join('\n\n')}`);
  }

  if (presets.mandatoryGates.length) {
    sections.push(`MANDATORY ACCEPTANCE GATES (every output-producing task MUST have these in its acceptanceCriteria):\n${presets.mandatoryGates.map(g => `• ${g}`).join('\n')}`);
  }

  if (presets.antiPatterns.length) {
    sections.push(`ANTI-PATTERNS (the LLM MUST NOT produce tasks that do these):\n${presets.antiPatterns.map(a => `🚫 ${a}`).join('\n')}`);
  }

  if (presets.referenceDiscovery.length) {
    sections.push(`REFERENCE FILE DISCOVERY (find these BEFORE building anything):\n${presets.referenceDiscovery.map(r => `• Format "${r.format}": examples at ${r.exampleGlob}, expected count: ${r.expectedCount}, size hint: ${r.sizeHint}`).join('\n')}`);
  }

  return `\n\n═══════════════════════════════════════════════════════════════\nDECOMPOSITION INTELLIGENCE (PRE-FLIGHT RULES — READ BEFORE PLANNING)\n═══════════════════════════════════════════════════════════════\n\n${sections.join('\n\n')}\n\n═══════════════════════════════════════════════════════════════`;
}

/**
 * Auto-infer acceptance gates for tasks that produce files.
 * Called after LLM decomposition to patch tasks that lack gates.
 */
export function inferGates(tasks, projectId) {
  const projPreset = loadProjectPreset(projectId);
  const refs = projPreset?.referenceFormats || {};

  for (const task of tasks) {
    // If task already has acceptance commands, skip
    if (task.acceptanceCriteria && task.acceptanceCriteria.includes('exit')) continue;
    if (task.acceptanceCommands?.length) continue;

    // Infer from required outputs
    const outputs = task.requiredOutputs || [];
    for (const output of outputs) {
      const ext = path.extname(output).replace('.', '');
      if (refs[ext]) {
        // Inject size/count check based on project preset
        const ref = refs[ext];
        if (!task.acceptanceCriteria) task.acceptanceCriteria = '';
        task.acceptanceCriteria += `\nVerify ${output}: element count must match ${ref.minCount}, file size must be proportional (${ref.sizeRatio}).`;
      }
    }

    // Infer from task title patterns
    const title = (task.title || '').toLowerCase();
    if (/convert|transform|generate|build.*(?:file|output|seq|xml|json)/.test(title)) {
      if (!task.acceptanceCriteria?.includes('size') && !task.acceptanceCriteria?.includes('count')) {
        task.acceptanceCriteria = (task.acceptanceCriteria || '') +
          '\nMUST verify output file exists AND has expected size/count. A trivially small file is NOT acceptable.';
      }
    }
  }

  return tasks;
}

// ── Initialization ──────────────────────────────────────────────────────────

export function ensurePresetsDir() {
  if (!fs.existsSync(PRESETS_DIR)) {
    fs.mkdirSync(PRESETS_DIR, { recursive: true });
  }
}

export function saveProjectPreset(projectId, preset) {
  ensurePresetsDir();
  fs.writeFileSync(
    path.join(PRESETS_DIR, `${projectId}.json`),
    JSON.stringify(preset, null, 2)
  );
}

export function getProjectPreset(projectId) {
  return loadProjectPreset(projectId);
}
