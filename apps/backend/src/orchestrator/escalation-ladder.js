// Escalation Ladder — L0/L1/L2/L3 decision hierarchy for agent failures
//
// L0: Apply a known fix template (auto-heal) — no LLM call
// L1: Retry with a different agent role  (future extension point)
// L2: Tribunal (Hunter/Delphi/Forge debate)
// L3: needs-human — ONLY for auth credentials, budget approval, security sign-off, hardware

export const PATTERNS = [
  // ── Auto-fixable patterns ────────────────────────────────────────────────
  {
    id: 'powershell-exec-policy',
    pattern: /ExecutionPolicy|cannot be loaded because running scripts is disabled|is not digitally signed/i,
    title: 'PowerShell Execution Policy',
    humanRequired: false,
    confidence: 0.95,
    fixInstructions: `## Auto-Fix: PowerShell Execution Policy
Retry the script using:
  powershell -NoProfile -ExecutionPolicy Bypass -File "<script>.ps1"
OR run in process:
  Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process
Do NOT ask for admin rights — Bypass scope works for current process.`,
  },
  {
    id: 'powershell-script-not-found',
    pattern: /\.ps1.*not found|Cannot find path.*\.ps1|The term.*\.ps1.*not recognized/i,
    title: 'PowerShell Script Not Found',
    humanRequired: false,
    confidence: 0.85,
    fixInstructions: `## Auto-Fix: Script Not Found
1. Run: Get-ChildItem -Recurse -Filter "*.ps1" | Select FullName
2. Find the correct path from the listing above
3. Run the script using the full absolute path`,
  },
  {
    id: 'com-automation-error',
    pattern: /Excel.*(?:cannot|error|failed|COM)|0x80030005|MissingMemberException.*Excel|failed to create.*Excel.*\bCOM\b|COMException.*Excel|New-Object.*-ComObject.*Excel/i,
    title: 'Excel/COM Automation Error',
    humanRequired: false,
    confidence: 0.9,
    fixInstructions: `## Auto-Fix: Excel COM Automation
Common fixes for Excel COM errors:
1. Cast path to [string]: \`$excelPath = [string]$excelPath\`
2. Wrap COM calls in try/catch with proper cleanup:
\`\`\`powershell
$excel = $null
try {
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    # ... your operations ...
} catch {
    Write-Error "Excel COM error: $($_.Exception.Message)"
    exit 1
} finally {
    if ($excel) { 
        $excel.Quit()
        [System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null
        Remove-Variable excel
    }
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
}
\`\`\`
3. If Excel is open interactively, close it first then retry.`,
  },
  {
    id: 'pester-version-compat',
    pattern: /Pester|Describe.*not.*recognized|It.*not.*recognized|Should.*not.*recognized|\.Tests\.ps1.*error/i,
    title: 'Pester Test Compatibility',
    humanRequired: false,
    confidence: 0.85,
    fixInstructions: `## Auto-Fix: Pester Test Compatibility
Pester v3 vs v4/v5 compatibility fixes:
1. Check installed Pester version: \`(Get-Module Pester -ListAvailable | Sort Version -Desc | Select -First 1).Version\`
2. For Pester v3 syntax: use \`Describe\`, \`Context\`, \`It\`, \`Should Be\` (no dash)
3. For Pester v5 syntax: use \`Should -Be\`, \`Should -Throw\`, etc.
4. Run with explicit version: \`Invoke-Pester -Script ./tests -PesterOption @{IncludeVSCodeMarker=$true}\`
5. If version mismatch: \`Import-Module Pester -RequiredVersion 5.x.x -Force\``,
  },
  {
    id: 'npm-module-missing',
    pattern: /Cannot find module|MODULE_NOT_FOUND|npm ERR! missing|require.*cannot.*find/i,
    title: 'Node Module Missing',
    humanRequired: false,
    confidence: 0.9,
    fixInstructions: `## Auto-Fix: Node Module Missing
1. Run: \`npm install\` in the workspace root
2. If a specific package is missing: \`npm install <package-name>\`
3. Check node_modules exists: \`ls node_modules\`
4. If using workspaces: run npm install from the root monorepo directory
5. Check package.json for the missing dependency and add it if absent`,
  },
  {
    id: 'ssl-certificate',
    pattern: /UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF|certificate.*expired|SSL.*handshake|self.signed.*certificate/i,
    title: 'SSL Certificate Error',
    humanRequired: false,
    confidence: 0.8,
    fixInstructions: `## Auto-Fix: SSL Certificate Error
For Node.js/npm: Set NODE_EXTRA_CA_CERTS or use --insecure flag (non-production only).
For PowerShell/Invoke-WebRequest: add \`-SkipCertificateCheck\` parameter.
For git: \`git config --global http.sslVerify false\` (use carefully).
If on corporate network: contact IT for the corporate CA certificate bundle.
Alternative: download packages manually from a machine with proper certs.`,
  },
  {
    id: 'file-not-found',
    pattern: /file.*not.*found|path.*does.*not.*exist|no such file|cannot.*open.*file|ItemNotFoundException/i,
    title: 'File Not Found',
    humanRequired: false,
    confidence: 0.75,
    fixInstructions: `## Auto-Fix: File Not Found
1. List the workspace to find the actual file structure:
   \`fs_list_dir(".")\` then \`fs_list_dir("<subdirectory>")\`
2. Search for the file: \`Get-ChildItem -Recurse -Filter "<filename>"\`
3. Use absolute paths, not relative paths, when passing to scripts
4. Ensure the workspace path is correct — check project.workspace config`,
  },
  {
    id: 'permission-denied',
    pattern: /permission denied|access.*denied|EACCES|unauthorized.*access|insufficient.*privileges/i,
    title: 'Permission Denied',
    humanRequired: false,
    confidence: 0.8,
    fixInstructions: `## Auto-Fix: Permission Denied
1. Check if the file/directory exists and its permissions
2. On Windows: use \`icacls <path>\` to inspect permissions
3. Try running as the current user without elevation
4. If a locked file: close any applications using it
5. Use a different output path if the target directory is read-only`,
  },
  {
    id: 'timeout',
    pattern: /timed? ?out|timeout|ETIMEDOUT|operation.*took.*too.*long|exceeded.*time/i,
    title: 'Operation Timeout',
    humanRequired: false,
    confidence: 0.75,
    fixInstructions: `## Auto-Fix: Timeout
1. Break the operation into smaller pieces
2. Increase timeout if configurable (e.g., \`-TimeoutSec 120\` for Invoke-WebRequest)
3. Check if the target service is running: \`Test-NetConnection\` or \`curl\`
4. Retry once — transient network timeouts often self-resolve
5. If a long-running script: run it in background with \`Start-Process\` and wait`,
  },
  {
    id: 'test-failure',
    pattern: /test.*fail|FAIL.*test|assertion.*fail|expected.*received|\.spec\.|\.test\./i,
    title: 'Test Assertion Failure',
    humanRequired: false,
    confidence: 0.7,
    fixInstructions: `## Auto-Fix: Test Failure
1. Read the full test output to find which assertion failed
2. Check the actual vs expected values in the error message
3. Look at the source code of the failing test to understand the contract
4. Fix the implementation (not the test) unless the test expectation is clearly wrong
5. Run the specific failing test in isolation to confirm the fix`,
  },
  {
    id: 'config-missing',
    pattern: /config.*not.*found|missing.*config|\.env.*not.*found|environment.*variable.*not.*set|ENOENT.*config/i,
    title: 'Configuration Missing',
    humanRequired: false,
    confidence: 0.8,
    fixInstructions: `## Auto-Fix: Configuration Missing
1. Check for example/template config files: \`ls *.example\`, \`ls *.template\`
2. Copy the template: \`cp config.example.json config.json\`
3. For .env files: \`cp .env.example .env\` then fill in values
4. Check vault notes for config schemas: vault_search("config contract")
5. List required fields from the codebase: grep for process.env or $env:`,
  },

  // ── Always-human patterns — NEVER auto-fix ──────────────────────────────
  {
    id: 'auth-credentials',
    pattern: /api.*key|password|secret|token.*required|login.*required|unauthorized.*403|401.*authentication|credentials.*required/i,
    title: 'Authentication / Credentials Required',
    humanRequired: true,
    confidence: 0.95,
    fixInstructions: `Human action required: Provide credentials or API key. Do not hardcode secrets.`,
  },
  {
    id: 'budget-exceeded',
    pattern: /quota.*exceeded|billing|payment.*required|insufficient.*funds|cost.*limit|rate.*limit.*429/i,
    title: 'Budget / Quota Exceeded',
    humanRequired: true,
    confidence: 0.95,
    fixInstructions: `Human action required: Increase quota, add funds, or approve spending.`,
  },
  {
    id: 'security-approval',
    pattern: /security.*review|penetration.*test|vulnerability.*CVE|requires.*sign.?off|requires.*approval/i,
    title: 'Security Review Required',
    humanRequired: true,
    confidence: 0.9,
    fixInstructions: `Human action required: Security review or approval needed.`,
  },
];

/** Pattern IDs that always require human intervention */
export const ALWAYS_HUMAN_PATTERNS = PATTERNS
  .filter(p => p.humanRequired)
  .map(p => p.id);

/**
 * Classify a failure by matching error text + task description against known patterns.
 * Returns the first match, or an 'unknown' classification if nothing matches.
 *
 * @param {string} errorText
 * @param {string} [taskDesc]
 * @returns {{ type: string, title: string, humanRequired: boolean, fixInstructions: string|null, confidence: number }}
 */
export function classifyFailure(errorText, taskDesc = '') {
  const combined = `${errorText} ${taskDesc}`;
  for (const p of PATTERNS) {
    if (p.pattern.test(combined)) {
      return {
        type: p.id,
        title: p.title,
        humanRequired: p.humanRequired,
        fixInstructions: p.fixInstructions,
        confidence: p.confidence,
      };
    }
  }
  return { type: 'unknown', title: 'Unknown Error', humanRequired: false, confidence: 0.0, fixInstructions: null };
}

/**
 * Apply the escalation ladder to a failed task.
 *
 * Decision tree:
 *   humanRequired → needs-human (L3)
 *   confidence >= 0.7 AND no prior template fix → requeue with fix injected (L0)
 *   confidence >= 0.8 AND prior template fix failed → tribunal (L2)
 *   everything else → tribunal (L2)
 *   unknown type → tribunal (L2)
 *
 * @param {object} task  — live task row from the DB
 * @param {string} errMsg
 * @returns {{ action: 'requeue'|'tribunal'|'needs-human', newDesc?: string, reason: string, templateId?: string }}
 */
export function applyEscalationLadder(task, errMsg) {
  const classification = classifyFailure(errMsg, task.desc || '');

  if (classification.humanRequired) {
    return { action: 'needs-human', reason: classification.title };
  }

  if (classification.type === 'unknown') {
    return { action: 'tribunal', reason: 'unclassified failure' };
  }

  const { confidence, fixInstructions, type: templateId, title } = classification;

  if (confidence >= 0.7) {
    if (!task.templateFixApplied) {
      // L0: first attempt — inject fix instructions and requeue (no retry budget consumed)
      const originalDesc = task.desc || '';
      const newDesc = `${originalDesc}\n\n${fixInstructions}`;
      return {
        action: 'requeue',
        newDesc,
        reason: `template: ${title}`,
        templateId,
      };
    }

    if (confidence >= 0.8) {
      // Template fix was applied but didn't resolve — escalate to tribunal
      return { action: 'tribunal', reason: `template fix did not resolve: ${title}` };
    }
  }

  return { action: 'tribunal', reason: 'low confidence fix' };
}
