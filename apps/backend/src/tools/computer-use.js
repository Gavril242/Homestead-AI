/**
 * Anthropic Computer Use integration
 *
 * Runs a full autonomous computer-use session inside the anthropic/computer-use-demo
 * Docker container. Uses Claude claude-sonnet-4-6 with beta computer-use tools.
 *
 * Container: ghcr.io/anthropics/anthropic-quickstarts:computer-use-demo-latest
 * Requires: ANTHROPIC_API_KEY in .env
 * Docker ports: 5900 (VNC), 8501 (Streamlit UI), 6080 (noVNC), 8080 (API)
 */

import { execSync, exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const execAsync = promisify(exec);

const CONTAINER_NAME = 'gavirila-computer-use';
const CONTAINER_IMAGE = 'ghcr.io/anthropics/anthropic-quickstarts:computer-use-demo-latest';
const DISPLAY_PORT = 5900;
const NOVNC_PORT = 6080;
const API_PORT = 8080;
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const COMPUTER_USE_MODEL = 'claude-sonnet-4-6';
const MAX_STEPS = 20;
const STEP_TIMEOUT_MS = 30_000;

// Check if docker is available
function dockerAvailable() {
  try { execSync('docker --version', { stdio: 'pipe' }); return true; }
  catch { return false; }
}

// Check if the container is running
function containerRunning() {
  try {
    const out = execSync(`docker inspect -f '{{.State.Running}}' ${CONTAINER_NAME} 2>/dev/null`, { stdio: 'pipe' }).toString().trim();
    return out === 'true';
  } catch { return false; }
}

// Start the container if not running
async function ensureContainer() {
  if (!dockerAvailable()) throw new Error('Docker not available. Install Docker to use computer-use.');
  if (containerRunning()) return;

  console.log(`[computer-use] Starting container ${CONTAINER_NAME}...`);
  await execAsync(
    `docker run -d --name ${CONTAINER_NAME} --rm ` +
    `-p ${DISPLAY_PORT}:5900 -p ${NOVNC_PORT}:6080 -p ${API_PORT}:8080 ` +
    `-e ANTHROPIC_API_KEY="${process.env.ANTHROPIC_API_KEY || ''}" ` +
    `${CONTAINER_IMAGE}`
  );

  // Wait for container to be ready (up to 30s)
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (containerRunning()) {
      console.log(`[computer-use] Container ready`);
      return;
    }
  }
  throw new Error('Container failed to start within 30s');
}

// Take a screenshot via xdotool inside the container
async function takeScreenshot() {
  try {
    const tmpPath = path.join(os.tmpdir(), `cu-screenshot-${Date.now()}.png`);
    await execAsync(
      `docker exec ${CONTAINER_NAME} bash -c "DISPLAY=:1 import -window root /tmp/screenshot.png" 2>/dev/null || ` +
      `docker exec ${CONTAINER_NAME} bash -c "DISPLAY=:1 scrot /tmp/screenshot.png 2>/dev/null || gnome-screenshot -f /tmp/screenshot.png"`
    );
    await execAsync(`docker cp ${CONTAINER_NAME}:/tmp/screenshot.png "${tmpPath}"`);
    const imageData = fs.readFileSync(tmpPath);
    fs.unlinkSync(tmpPath);
    return imageData.toString('base64');
  } catch (e) {
    console.warn('[computer-use] Screenshot failed:', e.message);
    return null;
  }
}

// Execute a computer action via xdotool
async function executeAction(action) {
  const { type } = action;
  try {
    if (type === 'screenshot') {
      return await takeScreenshot();
    } else if (type === 'left_click') {
      await execAsync(`docker exec ${CONTAINER_NAME} bash -c "DISPLAY=:1 xdotool mousemove ${action.coordinate[0]} ${action.coordinate[1]} click 1"`);
    } else if (type === 'right_click') {
      await execAsync(`docker exec ${CONTAINER_NAME} bash -c "DISPLAY=:1 xdotool mousemove ${action.coordinate[0]} ${action.coordinate[1]} click 3"`);
    } else if (type === 'double_click') {
      await execAsync(`docker exec ${CONTAINER_NAME} bash -c "DISPLAY=:1 xdotool mousemove ${action.coordinate[0]} ${action.coordinate[1]} click --repeat 2 1"`);
    } else if (type === 'type') {
      const escaped = (action.text || '').replace(/'/g, "'\\''");
      await execAsync(`docker exec ${CONTAINER_NAME} bash -c "DISPLAY=:1 xdotool type --clearmodifiers '${escaped}'"`);
    } else if (type === 'key') {
      await execAsync(`docker exec ${CONTAINER_NAME} bash -c "DISPLAY=:1 xdotool key ${action.key}"`);
    } else if (type === 'scroll') {
      const dir = action.direction === 'up' ? 4 : 5;
      const count = action.amount || 3;
      await execAsync(`docker exec ${CONTAINER_NAME} bash -c "DISPLAY=:1 xdotool mousemove ${action.coordinate[0]} ${action.coordinate[1]} click --repeat ${count} ${dir}"`);
    } else if (type === 'mouse_move') {
      await execAsync(`docker exec ${CONTAINER_NAME} bash -c "DISPLAY=:1 xdotool mousemove ${action.coordinate[0]} ${action.coordinate[1]}"`);
    } else if (type === 'left_click_drag') {
      const [x1, y1] = action.start_coordinate;
      const [x2, y2] = action.coordinate;
      await execAsync(`docker exec ${CONTAINER_NAME} bash -c "DISPLAY=:1 xdotool mousemove ${x1} ${y1} mousedown 1 mousemove ${x2} ${y2} mouseup 1"`);
    }
    return null;
  } catch (e) {
    return `Action failed: ${e.message}`;
  }
}

// Open a URL in the container's browser
async function openUrl(url) {
  await execAsync(`docker exec ${CONTAINER_NAME} bash -c "DISPLAY=:1 xdg-open '${url}' &" 2>/dev/null`).catch(() => {});
  await new Promise(r => setTimeout(r, 2000));
}

/**
 * Run a full autonomous computer-use session.
 * Claude claude-sonnet-4-6 operates the desktop to complete the task.
 */
async function runComputerUseSession(taskDescription, { startUrl, apiKey, maxSteps = MAX_STEPS } = {}) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY required for computer use');

  await ensureContainer();
  if (startUrl) await openUrl(startUrl);

  // Take initial screenshot
  const initialScreenshot = await takeScreenshot();

  const messages = [];
  if (initialScreenshot) {
    messages.push({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: initialScreenshot } },
        { type: 'text', text: taskDescription }
      ]
    });
  } else {
    messages.push({ role: 'user', content: taskDescription });
  }

  const screenshots = [];
  const actions = [];
  let finalResult = '';

  for (let step = 0; step < maxSteps; step++) {
    // Call Claude with computer-use beta
    const resp = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'computer-use-2024-10-22'
      },
      body: JSON.stringify({
        model: COMPUTER_USE_MODEL,
        max_tokens: 4096,
        tools: [{
          type: 'computer_20241022',
          name: 'computer',
          display_width_px: 1366,
          display_height_px: 768,
          display_number: 1
        }],
        messages,
        system: `You are a computer use agent. Complete the task precisely. When done, output: TASK COMPLETE: [brief result summary]`
      }),
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS)
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Anthropic API error ${resp.status}: ${err.slice(0, 200)}`);
    }

    const data = await resp.json();
    const assistantMsg = { role: 'assistant', content: data.content };
    messages.push(assistantMsg);

    let doneFlag = false;
    const toolResults = [];

    for (const block of data.content || []) {
      if (block.type === 'text') {
        finalResult = block.text;
        if (block.text.includes('TASK COMPLETE')) { doneFlag = true; }
      } else if (block.type === 'tool_use' && block.name === 'computer') {
        const action = block.input;
        actions.push(action);

        let toolResult;
        if (action.action === 'screenshot') {
          const screenshot = await takeScreenshot();
          if (screenshot) screenshots.push(screenshot);
          toolResult = screenshot
            ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshot } }]
            : [{ type: 'text', text: 'Screenshot failed' }];
        } else {
          const err = await executeAction({ type: action.action, ...action });
          // Take screenshot after action
          await new Promise(r => setTimeout(r, 500));
          const screenshot = await takeScreenshot();
          if (screenshot) screenshots.push(screenshot);
          toolResult = screenshot
            ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshot } }]
            : [{ type: 'text', text: err || 'Action executed' }];
        }

        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: toolResult });
      }
    }

    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults });
    }

    if (doneFlag || data.stop_reason === 'end_turn') break;
  }

  return { result: finalResult, screenshots, actions, steps: actions.length };
}

// Save screenshots to vault
async function saveScreenshots(screenshots, taskId, projectId) {
  if (!screenshots.length) return [];
  const paths = [];
  try {
    const dir = path.resolve(process.cwd(), `data/vault/projects/${projectId}/screenshots`);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < screenshots.length; i++) {
      const p = path.join(dir, `cu-${taskId}-${i}.png`);
      fs.writeFileSync(p, Buffer.from(screenshots[i], 'base64'));
      paths.push(p);
    }
  } catch {}
  return paths;
}

export const COMPUTER_USE_TOOLS = [
  {
    name: 'computer_run_task',
    description: 'Run an autonomous computer-use session: Claude claude-sonnet-4-6 visually sees and operates a full desktop (X11/VNC) to complete the task. Better than Playwright for visual QA, native apps, or DOM-invisible rendering bugs.',
    category: 'computer_use',
    parameters: {
      type: 'object',
      required: ['task'],
      properties: {
        task: { type: 'string', description: 'What to do on the desktop (e.g. "Open localhost:8765 and verify the Kanban board renders without visual glitches")' },
        start_url: { type: 'string', description: 'URL to open before starting the task (optional)' },
        max_steps: { type: 'number', description: 'Max interaction steps (default 20)' }
      }
    },
    execute: async ({ task, start_url, max_steps }, ctx) => {
      console.log(`[computer-use] Running task: ${task.slice(0, 80)}`);
      const result = await runComputerUseSession(task, {
        startUrl: start_url,
        maxSteps: max_steps || MAX_STEPS
      });
      const screenshotPaths = await saveScreenshots(result.screenshots, ctx.taskId || 'manual', ctx.projectId || 'shared');
      return {
        result: result.result,
        steps: result.steps,
        screenshots: screenshotPaths,
        actionsPerformed: result.actions.map(a => a.action).join(', ')
      };
    }
  },
  {
    name: 'computer_screenshot',
    description: 'Take a screenshot of the current computer-use desktop. Container must be running.',
    category: 'computer_use',
    parameters: { type: 'object', properties: {} },
    execute: async (_, ctx) => {
      if (!containerRunning()) return { error: 'Container not running. Call computer_run_task first or start it manually.' };
      const data = await takeScreenshot();
      if (!data) return { error: 'Screenshot failed' };
      const p = path.join(os.tmpdir(), `cu-screenshot-${Date.now()}.png`);
      fs.writeFileSync(p, Buffer.from(data, 'base64'));
      return { screenshot_path: p, size_bytes: data.length * 0.75 };
    }
  },
  {
    name: 'computer_start',
    description: 'Start the computer-use Docker container. Must be done before running tasks if container is not already running.',
    category: 'computer_use',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      await ensureContainer();
      return { ok: true, container: CONTAINER_NAME, novnc_url: `http://localhost:${NOVNC_PORT}` };
    }
  },
  {
    name: 'computer_stop',
    description: 'Stop the computer-use Docker container.',
    category: 'computer_use',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      try {
        execSync(`docker stop ${CONTAINER_NAME}`, { stdio: 'pipe' });
        return { ok: true };
      } catch (e) {
        return { error: e.message };
      }
    }
  }
];
