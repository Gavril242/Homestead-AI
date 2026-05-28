// apps/backend/src/tools/mcp-client.js
//
// MCP (Model Context Protocol) client adapter for Gavirila.
// Reads .mcp.json, spawns MCP server processes, fetches their tool schemas,
// and exposes them as standard Gavirila tool objects (name, description, parameters, execute).
//
// MCP protocol: JSON-RPC 2.0 over stdio.
// Each MCP server is a subprocess; communication via stdin/stdout newline-delimited JSON.

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

// Registry of live MCP server connections: name → { process, pending: Map<id, {resolve,reject}>, tools: [] }
const mcpServers = new Map();
let _nextId = 1;

/**
 * Start an MCP server from a config entry.
 * @param {string} name - server name (key in .mcp.json)
 * @param {{ command: string, args: string[], env: object }} cfg
 */
async function startMcpServer(name, cfg) {
  if (mcpServers.has(name)) return mcpServers.get(name);

  const proc = spawn(cfg.command, cfg.args || [], {
    env: { ...process.env, ...(cfg.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const server = { proc, pending: new Map(), tools: [], name, buffer: '' };
  mcpServers.set(name, server);

  proc.stdout.on('data', (chunk) => {
    server.buffer += chunk.toString();
    const lines = server.buffer.split('\n');
    server.buffer = lines.pop(); // keep partial line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && server.pending.has(msg.id)) {
          const { resolve, reject } = server.pending.get(msg.id);
          server.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch (e) {
        // Ignore unparseable lines (some servers emit log lines)
      }
    }
  });

  proc.stderr.on('data', (d) => {
    // Suppress stderr noise from MCP servers (they log to stderr by convention)
  });

  proc.on('exit', (code) => {
    console.warn(`[mcp] server "${name}" exited with code ${code}`);
    mcpServers.delete(name);
    // Reject all pending calls
    for (const [, { reject }] of server.pending) {
      reject(new Error(`MCP server "${name}" exited`));
    }
  });

  // Send JSON-RPC request, return promise for result
  function rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = _nextId++;
      server.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      proc.stdin.write(msg);
      // Timeout after 15s
      setTimeout(() => {
        if (server.pending.has(id)) {
          server.pending.delete(id);
          reject(new Error(`MCP rpc timeout: ${method}`));
        }
      }, 15_000);
    });
  }
  server.rpc = rpc;

  // Initialize handshake
  try {
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'gavirila-homestead', version: '1.0.0' },
    });
    // Send initialized notification (no response expected)
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  } catch (e) {
    console.warn(`[mcp] initialize failed for "${name}": ${e.message}`);
  }

  // Fetch tool list
  try {
    const listResult = await rpc('tools/list', {});
    server.tools = listResult.tools || [];
    console.log(`[mcp] "${name}" registered ${server.tools.length} tools: ${server.tools.map(t => t.name).join(', ')}`);
  } catch (e) {
    console.warn(`[mcp] tools/list failed for "${name}": ${e.message}`);
  }

  return server;
}

/**
 * Load .mcp.json and start all configured MCP servers.
 * Returns array of Gavirila tool objects ready to push into the registry.
 */
export async function loadMcpTools(mcpConfigPath) {
  if (!mcpConfigPath) {
    // Default: look for .mcp.json at repo root (two dirs up from src/tools/)
    mcpConfigPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../../../../.mcp.json'
    );
  }

  if (!fs.existsSync(mcpConfigPath)) {
    // No config = no MCP tools (not an error)
    return [];
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
  } catch (e) {
    console.warn(`[mcp] failed to parse ${mcpConfigPath}: ${e.message}`);
    return [];
  }

  const servers = config.mcpServers || {};
  const gavirilaTools = [];

  for (const [serverName, serverCfg] of Object.entries(servers)) {
    if (serverCfg.disabled) continue;
    try {
      const server = await startMcpServer(serverName, serverCfg);
      for (const mcpTool of server.tools) {
        gavirilaTools.push(mcpToolToGavirila(serverName, mcpTool, server));
      }
    } catch (e) {
      console.warn(`[mcp] failed to start "${serverName}": ${e.message}`);
    }
  }

  return gavirilaTools;
}

/**
 * Convert an MCP tool definition to a Gavirila tool object.
 */
function mcpToolToGavirila(serverName, mcpTool, server) {
  return {
    name: `mcp__${serverName}__${mcpTool.name}`,
    description: `[MCP:${serverName}] ${mcpTool.description || mcpTool.name}`,
    category: `mcp_${serverName}`,
    // MCP uses JSON Schema for input — pass through directly
    parameters: mcpTool.inputSchema || { type: 'object', properties: {} },
    execute: async (args, _ctx) => {
      try {
        const result = await server.rpc('tools/call', {
          name: mcpTool.name,
          arguments: args,
        });
        // MCP returns { content: [{ type: 'text', text: '...' }] }
        const content = result?.content || result;
        if (Array.isArray(content)) {
          const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
          const images = content.filter(c => c.type === 'image');
          return { ok: true, text, images: images.length ? images : undefined, raw: content };
        }
        return { ok: true, result: content };
      } catch (e) {
        return { error: `MCP tool ${mcpTool.name} failed: ${e.message}` };
      }
    },
  };
}

/**
 * Gracefully shut down all MCP server processes.
 * Call on process exit.
 */
export function shutdownMcpServers() {
  for (const [name, server] of mcpServers) {
    try { server.proc.kill(); } catch {}
    mcpServers.delete(name);
  }
}
