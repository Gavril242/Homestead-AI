// Project templates.
//
// Each template defines:
//   • methodology — how work flows (agile, waterfall, kanban-only, free)
//   • toolScopes — which tool categories every agent in this project gets
//   • boot — async function that runs once at create-time to lay down the
//     workspace skeleton (npm init, install vue, add docker config, etc.)
//   • seed — vault notes + initial tasks to give agents something to read
//
// New templates can be added without touching server.js.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ALL_AGENT_SCOPES_BASE = [
  'vault_read', 'vault_write',
  'db_tasks', 'db_reqs', 'db_bugs', 'trace',
];

export const TEMPLATES = {
  // ── Generic Python lab (the user's Python Lab is this kind) ──────
  'python-lab': {
    id: 'python-lab',
    name: 'Python Lab',
    description: 'Sandbox for Python scripts, data analysis, and small CLI tools.',
    emoji: '🐍',
    methodology: 'kanban',
    toolScopes: [...ALL_AGENT_SCOPES_BASE, 'exec_fs', 'exec_shell', 'exec_python', 'exec_git'],
    suggestedAgents: ['conductor', 'forge', 'vince', 'scribe'],
    async boot(ws) {
      writeIfMissing(path.join(ws, 'README.md'),
        `# Python Lab\n\nScratch workspace for Python experiments.\n\n- src/  — scripts\n- tests/ — pytest suites\n- requirements.txt — pip deps\n`);
      writeIfMissing(path.join(ws, 'requirements.txt'), 'pytest\n');
      writeIfMissing(path.join(ws, 'src', '.gitkeep'), '');
      writeIfMissing(path.join(ws, 'tests', '.gitkeep'), '');
      gitInit(ws);
    },
    seed: () => ({ vault: [], tasks: [] }),
  },

  // ── MISALAND FACTORY — the web-dev project the user asked for ────
  'misaland-factory': {
    id: 'misaland-factory',
    name: 'Misaland Factory',
    description: 'Web app builder — Vue 3 frontend + Node.js/Express backend. Agents build, debug, and ship websites.',
    emoji: '🏭',
    methodology: 'agile',
    toolScopes: [...ALL_AGENT_SCOPES_BASE, 'exec_fs', 'exec_shell', 'exec_python', 'exec_git'],
    suggestedAgents: ['conductor', 'forge', 'delphi', 'vince', 'hunter', 'scribe'],
    async boot(ws) {
      writeIfMissing(path.join(ws, 'README.md'),
        `# Misaland Factory\n\nFull-stack web project. Frontend in \`web/\` (Vue 3 + Vite), backend in \`server/\` (Node 18 + Express).\n\n## Quick start\n\`\`\`bash\nnpm run dev:web      # frontend at :5173\nnpm run dev:server   # backend at :3000\n\`\`\`\n`);
      writeIfMissing(path.join(ws, 'package.json'), JSON.stringify({
        name: 'misaland-factory',
        private: true,
        type: 'module',
        scripts: {
          'dev:web': 'cd web && npm run dev',
          'dev:server': 'cd server && npm run dev',
          'build:web': 'cd web && npm run build',
          'test': 'echo "(tests run in web/ and server/)"',
        },
      }, null, 2));

      // Skeleton Vue web/
      writeIfMissing(path.join(ws, 'web', 'package.json'), JSON.stringify({
        name: 'web',
        private: true,
        version: '0.0.1',
        type: 'module',
        scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
        dependencies: { vue: '^3.4.0' },
        devDependencies: { vite: '^5.0.0', '@vitejs/plugin-vue': '^5.0.0' },
      }, null, 2));
      writeIfMissing(path.join(ws, 'web', 'index.html'),
        `<!doctype html>\n<html><head><meta charset="utf-8"/><title>Misaland</title></head>\n<body><div id="app"></div><script type="module" src="/src/main.js"></script></body></html>\n`);
      writeIfMissing(path.join(ws, 'web', 'vite.config.js'),
        `import { defineConfig } from 'vite';\nimport vue from '@vitejs/plugin-vue';\nexport default defineConfig({ plugins: [vue()], server: { port: 5173 } });\n`);
      writeIfMissing(path.join(ws, 'web', 'src', 'main.js'),
        `import { createApp } from 'vue';\nimport App from './App.vue';\ncreateApp(App).mount('#app');\n`);
      writeIfMissing(path.join(ws, 'web', 'src', 'App.vue'),
        `<script setup>\nimport { ref } from 'vue';\nconst greeting = ref('Misaland Factory online.');\n</script>\n<template>\n  <main style="font-family: system-ui; padding: 40px;">\n    <h1>{{ greeting }}</h1>\n    <p>Edit web/src/App.vue and the page hot-reloads.</p>\n  </main>\n</template>\n`);

      // Skeleton Node server/
      writeIfMissing(path.join(ws, 'server', 'package.json'), JSON.stringify({
        name: 'server',
        private: true,
        version: '0.0.1',
        type: 'module',
        scripts: {
          dev: 'node --watch index.js',
          start: 'node index.js',
          test: 'node --experimental-vm-modules node_modules/.bin/jest --passWithNoTests',
        },
        dependencies: { express: '^4.19.2', cors: '^2.8.5' },
        devDependencies: { jest: '^29.0.0', '@jest/globals': '^29.0.0' },
      }, null, 2));
      writeIfMissing(path.join(ws, 'server', 'jest.config.js'),
        `export default { testEnvironment: 'node', testMatch: ['**/tests/**/*.test.js'], transform: {} };\n`);
      writeIfMissing(path.join(ws, 'server', 'index.js'),
        `import express from 'express';\nimport cors from 'cors';\nconst app = express();\napp.use(cors());\napp.use(express.json());\napp.get('/api/health', (req, res) => res.json({ ok: true }));\nconst PORT = process.env.PORT || 3000;\napp.listen(PORT, () => console.log('server up on', PORT));\n`);
      writeIfMissing(path.join(ws, 'server', 'tests', 'health.test.js'),
        `import { describe, it, expect } from '@jest/globals';\n\ndescribe('health', () => {\n  it('placeholder — add real tests here', () => {\n    expect(true).toBe(true);\n  });\n});\n`);

      writeIfMissing(path.join(ws, '.gitignore'),
        `node_modules/\ndist/\n.env\n.env.local\n*.log\n.DS_Store\n`);

      gitInit(ws);
    },
    seed: () => ({
      vault: [
        {
          path: 'README.md',
          frontmatter: { id: 'README', title: 'Misaland Factory project', kind: 'project' },
          body: `# Misaland Factory\n\nFull-stack web app workbench.\n\n## Stack\n- Vue 3 + Vite (web/)\n- Node 18 + Express (server/)\n\n## Workflow\n1. Conductor breaks features into tasks.\n2. Delphi designs the API + component contracts (ADRs in decisions/).\n3. Forge writes Vue components and Express routes.\n4. Vince runs npm test, browser smoke checks via shell_exec.\n5. Hunter triages production-style bugs from logs.\n6. Scribe keeps decisions/ and runbooks/ tidy.\n`,
        },
        {
          path: 'decisions/ADR-001-stack.md',
          frontmatter: { id: 'ADR-001', title: 'Use Vue 3 + Express', kind: 'adr', status: 'accepted' },
          body: `# ADR-001 — Vue 3 + Express\n\n## Context\nWe need a fast iteration loop with hot-reload on the front and a simple REST backend.\n\n## Decision\nVue 3 + Vite for the SPA. Express for the API. JSON file persistence until we feel pain.\n\n## Consequences\n- Frontend at :5173, backend at :3000 in dev.\n- Vite proxy forwards /api/* to :3000 in dev (TODO: wire when needed).\n`,
        },
      ],
      tasks: [
        { title: 'Install web/ dependencies (npm install in web/)', by: 'Forge', tag: 'setup', desc: 'Run `npm install` in web/. Then verify `npm run build` works.', status: 'queued' },
        { title: 'Install server/ dependencies (npm install in server/)', by: 'Forge', tag: 'setup', desc: 'Run `npm install` in server/. Then verify `node index.js` starts and /api/health responds.', status: 'queued' },
        { title: 'Document the dev loop (npm run dev:web / dev:server) in README', by: 'Scribe', tag: 'doc', desc: 'Update README with the actual commands once Forge confirms they work.', status: 'queued' },
      ],
    }),
  },

  // ── Generic blank — minimal scaffolding ──────────────────────────
  'blank': {
    id: 'blank',
    name: 'Blank',
    description: 'Empty workspace. Pick this if no template fits.',
    emoji: '📁',
    methodology: 'free',
    toolScopes: [...ALL_AGENT_SCOPES_BASE, 'exec_fs', 'exec_shell', 'exec_python', 'exec_git'],
    suggestedAgents: ['conductor', 'forge', 'scribe'],
    async boot(ws) {
      writeIfMissing(path.join(ws, 'README.md'), `# New project\n\nTell the Conductor what you want to build.\n`);
      gitInit(ws);
    },
    seed: () => ({ vault: [], tasks: [] }),
  },
};

export function listTemplates() {
  return Object.values(TEMPLATES).map((t) => ({
    id: t.id, name: t.name, description: t.description, emoji: t.emoji,
    methodology: t.methodology,
    suggestedAgents: t.suggestedAgents,
    toolCount: t.toolScopes.length,
  }));
}

export function getTemplate(id) {
  return TEMPLATES[id] || null;
}

// ── helpers ──────────────────────────────────────────────────────────

function writeIfMissing(filePath, content) {
  if (fs.existsSync(filePath)) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function gitInit(ws) {
  if (fs.existsSync(path.join(ws, '.git'))) return;
  spawnSync('git', ['init'], { cwd: ws, stdio: 'ignore' });
  spawnSync('git', ['add', '-A'], { cwd: ws, stdio: 'ignore' });
  spawnSync('git', ['commit', '-m', 'initial scaffold'], {
    cwd: ws, stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Gavirila', GIT_AUTHOR_EMAIL: 'gavirila@homestead', GIT_COMMITTER_NAME: 'Gavirila', GIT_COMMITTER_EMAIL: 'gavirila@homestead' },
  });
}
