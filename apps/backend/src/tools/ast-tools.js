// AST Code Mapping tools.
//
// Agents use these to understand large files without loading the full content.
//   ast_map_file     → structural skeleton (all function/class/export signatures + line ranges)
//   ast_read_symbol  → read just the lines for one named function/class
//   ast_list_imports → list all import/require statements
//
// Supports JS, TS, JSX, TSX, MJS via @babel/parser.
// Falls back to regex-based scanning for .py, .sh, .json, .md, etc.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Parse a JS/TS/JSX/TSX file and extract the structural skeleton. */
async function mapJSFile(code, filePath) {
  let ast;
  try {
    const { parse } = await import('@babel/parser');
    ast = parse(code, {
      sourceType: 'module',
      plugins: [
        'jsx', 'typescript', 'decorators', 'decoratorAutoAccessors',
        'importMeta', 'topLevelAwait', 'classProperties', 'classPrivateProperties',
      ],
      errorRecovery: true,
    });
  } catch {
    return mapByRegex(code, filePath);
  }

  const symbols = [];

  function nameOf(node) {
    if (!node) return null;
    if (node.type === 'Identifier') return node.name;
    if (node.type === 'StringLiteral') return node.value;
    return null;
  }

  function loc(node) {
    return { start: node.loc?.start?.line ?? 0, end: node.loc?.end?.line ?? 0 };
  }

  function extractFnParams(node) {
    if (!node.params) return '';
    return node.params.map(p => {
      if (p.type === 'Identifier') return p.name;
      if (p.type === 'AssignmentPattern') return `${p.left?.name}=…`;
      if (p.type === 'RestElement') return `...${p.argument?.name}`;
      if (p.type === 'ObjectPattern') return '{…}';
      if (p.type === 'ArrayPattern') return '[…]';
      return '…';
    }).join(', ');
  }

  for (const node of (ast.program?.body || [])) {
    if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') {
      const inner = node.declaration || node;
      const name = nameOf(inner.id) || nameOf(inner.key) || (node.type === 'ExportDefaultDeclaration' ? '<default>' : null);
      if (!name) continue;
      const params = extractFnParams(inner) || extractFnParams(inner.value || {});
      const kind = inner.type?.includes('Function') ? 'function' : inner.type?.includes('Class') ? 'class' : 'export';
      symbols.push({ kind, name, params, ...loc(node), exported: true });
    } else if (node.type === 'FunctionDeclaration' && node.id) {
      symbols.push({ kind: 'function', name: node.id.name, params: extractFnParams(node), ...loc(node) });
    } else if (node.type === 'ClassDeclaration' && node.id) {
      const methods = (node.body?.body || []).map(m => {
        const mname = nameOf(m.key);
        const mparams = extractFnParams(m.value || m);
        return mname
          ? `  ${m.static ? 'static ' : ''}${m.kind !== 'method' ? m.kind + ' ' : ''}${mname}(${mparams}) [L${m.loc?.start?.line}]`
          : null;
      }).filter(Boolean);
      symbols.push({ kind: 'class', name: node.id.name, params: '', ...loc(node), methods });
    } else if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations || []) {
        const name = nameOf(decl.id);
        if (!name) continue;
        const init = decl.init;
        const isArrow = init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression';
        if (isArrow) {
          symbols.push({ kind: 'function', name, params: extractFnParams(init), ...loc(node) });
        } else {
          const val = init?.type === 'StringLiteral' ? `"${init.value?.slice(0, 40)}"` : init?.type === 'NumericLiteral' ? String(init.value) : init?.type || '…';
          symbols.push({ kind: 'const', name, value: val, ...loc(node) });
        }
      }
    }
  }

  return symbols;
}

/** Regex-based skeleton extractor for Python, shell, and unknown file types. */
function mapByRegex(code, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const lines = code.split('\n');
  const symbols = [];

  if (ext === '.py') {
    for (let i = 0; i < lines.length; i++) {
      const fn = lines[i].match(/^(async\s+)?def\s+(\w+)\s*\(([^)]*)\)/);
      if (fn) symbols.push({ kind: 'function', name: fn[2], params: fn[3], start: i + 1, end: i + 1 });
      const cls = lines[i].match(/^class\s+(\w+)/);
      if (cls) symbols.push({ kind: 'class', name: cls[1], params: '', start: i + 1, end: i + 1 });
    }
  } else {
    // Generic: look for function/class-like patterns
    for (let i = 0; i < lines.length; i++) {
      const fn = lines[i].match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
      if (fn) symbols.push({ kind: 'function', name: fn[1], params: fn[2], start: i + 1, end: i + 1 });
      const arrow = lines[i].match(/(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/);
      if (arrow) symbols.push({ kind: 'function', name: arrow[1], params: '…', start: i + 1, end: i + 1 });
      const cls = lines[i].match(/(?:export\s+)?class\s+(\w+)/);
      if (cls) symbols.push({ kind: 'class', name: cls[1], params: '', start: i + 1, end: i + 1 });
    }
  }

  return symbols;
}

/** Format symbols as a compact text skeleton. */
function formatSkeleton(symbols) {
  return symbols.map(s => {
    let line = `[L${s.start}${s.end && s.end !== s.start ? `-${s.end}` : ''}] `;
    if (s.kind === 'class') {
      line += `class ${s.name}`;
      if (s.methods?.length) line += ' {\n' + s.methods.join('\n') + '\n}';
    } else if (s.kind === 'function') {
      line += `${s.exported ? 'export ' : ''}function ${s.name}(${s.params || ''})`;
    } else {
      line += `${s.exported ? 'export ' : ''}const ${s.name} = ${s.value || '…'}`;
    }
    return line;
  }).join('\n');
}

/** Resolve a file path against ctx workspace or cwd. */
function resolvePath(filePath, ctx) {
  if (path.isAbsolute(filePath)) return filePath;
  const ws = ctx?.shadowPath || (ctx?.projectId ? path.join(os.homedir(), 'gavirila-workspaces', ctx.projectId) : null);
  if (ws) return path.join(ws, filePath);
  return path.resolve(filePath);
}

export const AST_TOOLS = [
  {
    name: 'ast_map_file',
    description: 'Returns the structural skeleton of a source file — all function names, class names, exports, and their line ranges — WITHOUT loading the full code body. Use this first to understand a large file before calling ast_read_symbol to zoom into a specific function.',
    category: 'exec_fs',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative path to the source file.' },
      },
      required: ['path'],
    },
    async execute({ path: filePath }, ctx) {
      const full = resolvePath(filePath, ctx);
      if (!fs.existsSync(full)) return { error: `file not found: ${full}` };

      const stat = fs.statSync(full);
      if (stat.size > 500_000) return { error: 'file too large (> 500 KB) — use shell_exec + head/grep' };

      const code = fs.readFileSync(full, 'utf8');
      const lines = code.split('\n').length;
      const ext = path.extname(full).toLowerCase();

      let symbols;
      if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) {
        symbols = await mapJSFile(code, full);
      } else {
        symbols = mapByRegex(code, full);
      }

      const skeleton = formatSkeleton(symbols);
      return {
        path: full,
        lines,
        size_kb: Math.round(stat.size / 1024),
        symbol_count: symbols.length,
        skeleton: skeleton || '(no top-level symbols found — use fs_read_file to inspect)',
        hint: 'Use ast_read_symbol to read the body of any symbol listed above.',
      };
    },
  },

  {
    name: 'ast_read_symbol',
    description: 'Read the exact lines of a named function, class, or variable from a file. Use after ast_map_file to zoom into just the code you need, avoiding loading the full file.',
    category: 'exec_fs',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the source file.' },
        symbol: { type: 'string', description: 'Name of the function, class, or export to read.' },
        context_lines: { type: 'number', description: 'Extra lines of context above/below the symbol (default: 2).' },
      },
      required: ['path', 'symbol'],
    },
    async execute({ path: filePath, symbol, context_lines = 2 }, ctx) {
      const full = resolvePath(filePath, ctx);
      if (!fs.existsSync(full)) return { error: `file not found: ${full}` };

      const code = fs.readFileSync(full, 'utf8');
      const allLines = code.split('\n');
      const ext = path.extname(full).toLowerCase();

      let symbols;
      if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) {
        symbols = await mapJSFile(code, full);
      } else {
        symbols = mapByRegex(code, full);
      }

      const match = symbols.find(s => s.name === symbol);
      if (!match) {
        // Fallback: search for the name in lines
        const lineIdx = allLines.findIndex(l =>
          new RegExp(`(?:function|class|const|let|var|def)\\s+${symbol}\\b`).test(l)
        );
        if (lineIdx < 0) return {
          error: `symbol "${symbol}" not found in ${full}`,
          available: symbols.map(s => s.name),
        };
        const start = Math.max(0, lineIdx - context_lines);
        const end = Math.min(allLines.length - 1, lineIdx + 40 + context_lines);
        return {
          symbol,
          start_line: start + 1,
          end_line: end + 1,
          content: allLines.slice(start, end + 1).map((l, i) => `${start + i + 1}: ${l}`).join('\n'),
          note: 'Found by line scan (AST parse did not match).',
        };
      }

      const start = Math.max(0, match.start - 1 - context_lines);
      const end = Math.min(allLines.length - 1, (match.end || match.start) - 1 + context_lines);
      return {
        symbol,
        start_line: match.start,
        end_line: match.end || match.start,
        content: allLines.slice(start, end + 1).map((l, i) => `${start + i + 1}: ${l}`).join('\n'),
      };
    },
  },

  {
    name: 'ast_list_imports',
    description: "List all import/require statements in a JS/TS file. Useful for understanding a file's dependencies before modifying it.",
    category: 'exec_fs',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the JS/TS source file.' },
      },
      required: ['path'],
    },
    execute({ path: filePath }, ctx) {
      const full = resolvePath(filePath, ctx);
      if (!fs.existsSync(full)) return { error: `file not found: ${full}` };
      const code = fs.readFileSync(full, 'utf8');
      const lines = code.split('\n');
      const imports = [];
      for (let i = 0; i < Math.min(lines.length, 100); i++) {
        const imp = lines[i].match(/^(?:import|export)\s+.+\s+from\s+['"]([^'"]+)['"]/);
        const req = lines[i].match(/(?:const|let|var)\s+\S+\s*=\s*require\(['"]([^'"]+)['"]\)/);
        if (imp) imports.push({ line: i + 1, type: 'esm', source: imp[1], raw: lines[i].trim() });
        if (req) imports.push({ line: i + 1, type: 'cjs', source: req[1], raw: lines[i].trim() });
      }
      return { count: imports.length, imports };
    },
  },
];
