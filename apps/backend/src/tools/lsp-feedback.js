import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

// Run diagnostics on a file based on its extension
export function diagnose(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const results = [];

  try {
    switch (ext) {
      case '.js':
      case '.mjs':
      case '.jsx':
        // Node.js syntax check
        try {
          execSync(`node --check "${filePath}"`, { encoding: 'utf8', timeout: 10000 });
          results.push({ level: 'ok', tool: 'node --check', message: 'Syntax valid' });
        } catch (e) {
          results.push({ level: 'error', tool: 'node --check', message: e.stderr || e.message });
        }
        break;

      case '.ts':
      case '.tsx':
        // TypeScript compiler check (no emit)
        try {
          execSync(`npx tsc --noEmit --pretty "${filePath}"`, { encoding: 'utf8', timeout: 30000 });
          results.push({ level: 'ok', tool: 'tsc', message: 'No type errors' });
        } catch (e) {
          results.push({ level: 'error', tool: 'tsc', message: e.stdout || e.message });
        }
        break;

      case '.py':
        // Python syntax check
        try {
          execSync(`python -m py_compile "${filePath}"`, { encoding: 'utf8', timeout: 10000 });
          results.push({ level: 'ok', tool: 'py_compile', message: 'Syntax valid' });
        } catch (e) {
          results.push({ level: 'error', tool: 'py_compile', message: e.stderr || e.message });
        }
        break;

      case '.json':
        try {
          JSON.parse(fs.readFileSync(filePath, 'utf8'));
          results.push({ level: 'ok', tool: 'JSON.parse', message: 'Valid JSON' });
        } catch (e) {
          results.push({ level: 'error', tool: 'JSON.parse', message: e.message });
        }
        break;

      case '.ps1':
        // PowerShell syntax check — escape single quotes in path to prevent injection
        try {
          const escapedPs1Path = filePath.replace(/'/g, "''");
          execSync(`powershell -NoProfile -Command "$errors = @(); $tokens = @(); [System.Management.Automation.Language.Parser]::ParseFile('${escapedPs1Path}', [ref]$errors, [ref]$tokens); if($errors.Count -gt 0){$errors | ForEach-Object{$_.Message}; exit 1}"`, { encoding: 'utf8', timeout: 10000 });
          results.push({ level: 'ok', tool: 'PS Parser', message: 'Syntax valid' });
        } catch (e) {
          results.push({ level: 'error', tool: 'PS Parser', message: e.stderr || e.stdout || e.message });
        }
        break;

      default:
        results.push({ level: 'skip', tool: 'none', message: `No linter for ${ext}` });
    }
  } catch (e) {
    results.push({ level: 'error', tool: 'system', message: e.message });
  }

  return results;
}

// Bulk diagnose: check all recently modified files in a directory
export function diagnoseRecent(dir, sinceMinutes = 10) {
  const since = Date.now() - sinceMinutes * 60 * 1000;
  const results = {};

  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs > since) {
          const diag = diagnose(full);
          if (diag.some(d => d.level === 'error')) {
            results[full] = diag;
          }
        }
      } catch {}
    }
  }
  walk(dir);
  return results;
}
