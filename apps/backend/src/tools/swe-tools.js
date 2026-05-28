/**
 * SWE-agent ACI (Agent-Computer Interface) tools.
 * Adapted from Princeton NLP's SWE-agent — optimized for LLMs writing code.
 *
 * Core insight: Never dump full files. Use windowed reading + line-range editing.
 * This dramatically reduces tokens burned on file I/O and prevents off-by-one errors.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { getWorkspacePath, ensureWorkspace } from './exec-tools.js';

const WINDOW_SIZE = 50; // lines per view
const MAX_SEARCH_RESULTS = 30;

/** Resolve a file path within the agent's project workspace. */
function resolvePath(filePath, ctx) {
  if (path.isAbsolute(filePath)) return filePath;
  if (ctx?.projectId) {
    const ws = ensureWorkspace(ctx.projectId);
    return path.resolve(ws, filePath);
  }
  return path.resolve(filePath);
}

function readFileLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').split('\n');
}

function formatWindow(lines, startLine, filePath) {
  const total = lines.length;
  const end = Math.min(startLine + WINDOW_SIZE - 1, total);
  const lineNums = lines.slice(startLine - 1, end)
    .map((l, i) => `${String(startLine + i).padStart(6)} | ${l}`)
    .join('\n');
  return `[File: ${filePath} (${total} lines total)]\n[Lines ${startLine}-${end} shown]\n${lineNums}`;
}

export const SWE_TOOLS = [
  {
    name: 'file_open',
    description: 'Open a file and show a 50-line window starting from a given line. Better than fs_read_file for large files — use this when you need to navigate a file section by section. Shows line numbers for precise editing.',
    category: 'exec_fs',
    parameters: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'File path (relative to workspace or absolute)' },
        line: { type: 'number', description: 'Line number to start viewing (default 1)' },
      },
    },
    execute: async ({ path: filePath, line = 1 }, ctx) => {
      const resolved = resolvePath(filePath, ctx);
      if (!fs.existsSync(resolved)) return { error: `File not found: ${filePath}` };
      const lines = readFileLines(resolved);
      const start = Math.max(1, Math.min(line, lines.length));
      return {
        content: formatWindow(lines, start, filePath),
        total_lines: lines.length,
        current_line: start,
        has_more: start + WINDOW_SIZE - 1 < lines.length,
      };
    },
  },

  {
    name: 'file_scroll',
    description: 'Scroll down (or up) in a file you have already opened with file_open. Use "down" to see the next 50 lines, "up" for previous.',
    category: 'exec_fs',
    parameters: {
      type: 'object',
      required: ['path', 'direction', 'current_line'],
      properties: {
        path: { type: 'string', description: 'File path' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
        current_line: { type: 'number', description: 'The current start line (from the previous file_open/file_scroll result)' },
      },
    },
    execute: async ({ path: filePath, direction, current_line }, ctx) => {
      const resolved = resolvePath(filePath, ctx);
      if (!fs.existsSync(resolved)) return { error: `File not found: ${filePath}` };
      const lines = readFileLines(resolved);
      const newStart = direction === 'down'
        ? Math.min(current_line + WINDOW_SIZE, lines.length)
        : Math.max(1, current_line - WINDOW_SIZE);
      return {
        content: formatWindow(lines, newStart, filePath),
        total_lines: lines.length,
        current_line: newStart,
        has_more: newStart + WINDOW_SIZE - 1 < lines.length,
      };
    },
  },

  {
    name: 'file_goto_line',
    description: 'Jump to a specific line number in a file. Shows a 50-line window centered around that line.',
    category: 'exec_fs',
    parameters: {
      type: 'object',
      required: ['path', 'line'],
      properties: {
        path: { type: 'string', description: 'File path' },
        line: { type: 'number', description: 'Line number to jump to' },
      },
    },
    execute: async ({ path: filePath, line }, ctx) => {
      const resolved = resolvePath(filePath, ctx);
      if (!fs.existsSync(resolved)) return { error: `File not found: ${filePath}` };
      const lines = readFileLines(resolved);
      // Center the window around the target line
      const start = Math.max(1, Math.min(line - Math.floor(WINDOW_SIZE / 2), lines.length - WINDOW_SIZE + 1));
      return {
        content: formatWindow(lines, start, filePath),
        total_lines: lines.length,
        current_line: start,
        target_line: line,
      };
    },
  },

  {
    name: 'file_edit_lines',
    description: 'Replace a range of lines in a file with new content. The most precise editing tool — specify exact line numbers to replace. No regex, no pattern matching. Use file_open to find the right line numbers first.',
    category: 'exec_fs',
    parameters: {
      type: 'object',
      required: ['path', 'start_line', 'end_line', 'new_content'],
      properties: {
        path: { type: 'string', description: 'File path' },
        start_line: { type: 'number', description: 'First line to replace (inclusive, 1-indexed)' },
        end_line: { type: 'number', description: 'Last line to replace (inclusive, 1-indexed)' },
        new_content: { type: 'string', description: 'New content to insert (replaces lines start_line through end_line)' },
      },
    },
    execute: async ({ path: filePath, start_line, end_line, new_content }, ctx) => {
      const resolved = resolvePath(filePath, ctx);
      if (!fs.existsSync(resolved)) return { error: `File not found: ${filePath}` };

      const lines = readFileLines(resolved);
      const total = lines.length;

      if (start_line < 1 || start_line > total) return { error: `start_line ${start_line} out of range (file has ${total} lines)` };
      if (end_line < start_line || end_line > total) return { error: `end_line ${end_line} out of range (start: ${start_line}, total: ${total})` };

      const newLines = new_content.split('\n');
      const result = [
        ...lines.slice(0, start_line - 1),
        ...newLines,
        ...lines.slice(end_line),
      ];

      fs.writeFileSync(resolved, result.join('\n'), 'utf8');

      // Show result around the edit
      const previewStart = Math.max(1, start_line - 2);
      const previewEnd = Math.min(result.length, start_line + newLines.length + 2);
      const preview = result.slice(previewStart - 1, previewEnd)
        .map((l, i) => `${String(previewStart + i).padStart(6)} | ${l}`)
        .join('\n');

      return {
        success: true,
        lines_replaced: end_line - start_line + 1,
        lines_inserted: newLines.length,
        new_total_lines: result.length,
        preview: `[Lines ${previewStart}-${previewEnd} after edit]\n${preview}`,
      };
    },
  },

  {
    name: 'file_insert_line',
    description: 'Insert new content AFTER a specific line number without replacing anything. Use for adding new functions, imports, or blocks.',
    category: 'exec_fs',
    parameters: {
      type: 'object',
      required: ['path', 'after_line', 'content'],
      properties: {
        path: { type: 'string', description: 'File path' },
        after_line: { type: 'number', description: 'Insert after this line (0 = insert at beginning)' },
        content: { type: 'string', description: 'Content to insert' },
      },
    },
    execute: async ({ path: filePath, after_line, content }, ctx) => {
      const resolved = resolvePath(filePath, ctx);
      if (!fs.existsSync(resolved)) return { error: `File not found: ${filePath}` };

      const lines = readFileLines(resolved);
      const newLines = content.split('\n');
      const insertAt = Math.max(0, Math.min(after_line, lines.length));

      lines.splice(insertAt, 0, ...newLines);
      fs.writeFileSync(resolved, lines.join('\n'), 'utf8');

      return {
        success: true,
        inserted_at_line: insertAt + 1,
        lines_inserted: newLines.length,
        new_total_lines: lines.length,
      };
    },
  },

  {
    name: 'search_in_file',
    description: 'Search for a pattern in a file and show matching lines with context (like grep -n -C 3). Returns line numbers so you can use file_goto_line or file_edit_lines.',
    category: 'exec_fs',
    parameters: {
      type: 'object',
      required: ['path', 'pattern'],
      properties: {
        path: { type: 'string', description: 'File path' },
        pattern: { type: 'string', description: 'Search string or regex pattern' },
        context_lines: { type: 'number', description: 'Lines of context around each match (default 3)' },
        case_sensitive: { type: 'boolean', description: 'Case sensitive? (default false)' },
      },
    },
    execute: async ({ path: filePath, pattern, context_lines = 3, case_sensitive = false }, ctx) => {
      const resolved = resolvePath(filePath, ctx);
      if (!fs.existsSync(resolved)) return { error: `File not found: ${filePath}` };

      const lines = readFileLines(resolved);
      let regex;
      try {
        regex = new RegExp(pattern, case_sensitive ? '' : 'i');
      } catch (e) {
        return { error: `Invalid regex pattern: ${e.message}` };
      }
      const matches = [];

      lines.forEach((line, i) => {
        if (regex.test(line)) {
          const start = Math.max(0, i - context_lines);
          const end = Math.min(lines.length - 1, i + context_lines);
          matches.push({
            line_number: i + 1,
            match: line.trim(),
            context: lines.slice(start, end + 1).map((l, j) =>
              `${String(start + j + 1).padStart(6)} ${start + j === i ? '=>' : '  '} | ${l}`
            ).join('\n'),
          });
        }
      });

      if (matches.length === 0) return { found: false, count: 0 };
      return {
        found: true,
        count: matches.length,
        file: filePath,
        matches: matches.slice(0, MAX_SEARCH_RESULTS).map(m => ({ line: m.line_number, context: m.context })),
      };
    },
  },

  {
    name: 'search_codebase',
    description: 'Search for a pattern across all files in the project workspace (like ripgrep). Returns file paths and line numbers. Use to find function definitions, import sites, or usages.',
    category: 'exec_fs',
    parameters: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', description: 'Search pattern (string or regex)' },
        file_glob: { type: 'string', description: 'File extension filter (default: *.{js,ts,jsx,tsx,py,md})' },
        case_sensitive: { type: 'boolean', description: 'Case sensitive? Default false' },
      },
    },
    execute: async ({ pattern, file_glob = '*.{js,ts,jsx,tsx,py,md}', case_sensitive = false }, ctx) => {
      let workspace;
      try {
        workspace = ctx?.projectId ? getWorkspacePath(ctx.projectId) : process.cwd();
      } catch {
        workspace = process.cwd();
      }

      if (!fs.existsSync(workspace)) {
        return { found: false, error: `Workspace does not exist: ${workspace}` };
      }

      try {
        const flags = case_sensitive ? '' : '-i';
        // Use git grep if in a git repo, otherwise fall back to grep
        let output;
        try {
          output = execSync(
            `git grep ${flags} -rn --include="${file_glob}" "${pattern}" 2>/dev/null | head -${MAX_SEARCH_RESULTS}`,
            { cwd: workspace, stdio: 'pipe', timeout: 10000 }
          ).toString().trim();
        } catch {
          // git grep exits non-zero when no matches — that's fine
          output = '';
        }

        if (!output) {
          // Try plain grep as fallback
          try {
            output = execSync(
              `grep ${flags} -rn --include="${file_glob}" "${pattern}" . 2>/dev/null | head -${MAX_SEARCH_RESULTS}`,
              { cwd: workspace, stdio: 'pipe', timeout: 10000 }
            ).toString().trim();
          } catch {
            output = '';
          }
        }

        if (!output) return { found: false, count: 0 };

        // Parse "file:line:content" lines
        const resultLines = output.split('\n').filter(Boolean);
        const byFile = {};
        for (const line of resultLines) {
          const m = line.match(/^([^:]+):(\d+):(.*)/);
          if (m) {
            const [, file, lineNum, content] = m;
            if (!byFile[file]) byFile[file] = [];
            byFile[file].push({ line: parseInt(lineNum, 10), content: content.slice(0, 200) });
          }
        }

        const results = Object.entries(byFile).map(([file, matches]) => ({ file, matches }));
        return { found: true, file_count: results.length, total_matches: resultLines.length, results };
      } catch (e) {
        return { found: false, error: `Search failed: ${e.message}` };
      }
    },
  },

  {
    name: 'file_diff',
    description: 'Show the git diff for a file (what changed since last commit). Useful to verify your edits before finishing a task.',
    category: 'exec_fs',
    parameters: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'File path to diff' },
      },
    },
    execute: async ({ path: filePath }, ctx) => {
      const resolved = resolvePath(filePath, ctx);
      const dir = path.dirname(resolved);
      try {
        const diff = execSync(`git diff "${resolved}" 2>/dev/null`, { cwd: dir, stdio: 'pipe', timeout: 5000 }).toString();
        if (!diff.trim()) return { status: 'no changes', message: 'File matches last commit' };
        return { diff: diff.slice(0, 10000) };
      } catch {
        return { error: 'git diff failed — file may not be in a git repo' };
      }
    },
  },
];
