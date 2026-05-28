import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TOOLS_DIR = path.resolve('data/skills');  // custom tools live here
const forgedTools = new Map();  // name -> tool definition

// Ensure tools directory exists
if (!fs.existsSync(TOOLS_DIR)) fs.mkdirSync(TOOLS_DIR, { recursive: true });

// Load a tool from a .js file in the skills directory
export async function loadTool(filename) {
  const filePath = path.join(TOOLS_DIR, filename);
  if (!fs.existsSync(filePath)) throw new Error(`Tool file not found: ${filename}`);

  // Dynamic import with cache-busting for hot reload
  const url = pathToFileURL(filePath).href + '?t=' + Date.now();
  const mod = await import(url);

  if (!mod.default || !mod.default.name || !mod.default.execute) {
    throw new Error(`Tool ${filename} must export default { name, desc, params, execute }`);
  }

  forgedTools.set(mod.default.name, mod.default);
  return mod.default;
}

// Load all tools from the skills directory
export async function loadAllTools() {
  const files = fs.readdirSync(TOOLS_DIR).filter(f => f.endsWith('.js'));
  const results = [];
  for (const f of files) {
    try {
      results.push(await loadTool(f));
    } catch (e) {
      console.error(`[tool-forge] Failed to load ${f}:`, e.message);
    }
  }
  return results;
}

// Create a new tool from code (written by an agent)
export async function forgeTool(name, code) {
  // Validate: no require(), no process.exit, no eval
  const BANNED = [/\brequire\s*\(/, /\bprocess\.exit/, /\beval\s*\(/, /\bFunction\s*\(/];
  for (const pat of BANNED) {
    if (pat.test(code)) throw new Error(`Tool code contains banned pattern: ${pat}`);
  }

  const filename = `${name}.js`;
  const filePath = path.join(TOOLS_DIR, filename);
  fs.writeFileSync(filePath, code, 'utf8');
  return loadTool(filename);
}

// Get all forged tools as array
export function getForgedTools() {
  return [...forgedTools.values()];
}

// Watch for changes (hot reload)
export function watchTools() {
  fs.watch(TOOLS_DIR, async (eventType, filename) => {
    if (filename && filename.endsWith('.js')) {
      try {
        await loadTool(filename);
        console.log(`[tool-forge] Hot-reloaded: ${filename}`);
      } catch (e) {
        console.error(`[tool-forge] Reload failed for ${filename}:`, e.message);
      }
    }
  });
}
