// Playwright-based browser tools — the deterministic feedback engine.
//
// Browser instance is shared across calls but stays headless. Each call
// opens a fresh page so test runs don't bleed state. Console errors,
// network failures, and the rendered DOM all return structured.

import fs from 'node:fs';
import path from 'node:path';
import { vaultRoot } from '../brain/vault.js';

let _chromium = null;
let _browser = null;

async function getBrowser() {
  if (_browser) return _browser;
  try {
    if (!_chromium) {
      const pw = await import('playwright');
      _chromium = pw.chromium;
    }
    _browser = await _chromium.launch({ headless: true });
    return _browser;
  } catch (err) {
    throw new Error(`playwright unavailable: ${err.message}. Run: cd apps/backend && npx playwright install chromium`);
  }
}

export async function browserOpen({ url, wait_for, wait_ms = 800 }) {
  const browser = await getBrowser();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const consoleMsgs = [];
  const networkErrors = [];

  page.on('console', (msg) => {
    consoleMsgs.push({ type: msg.type(), text: msg.text().slice(0, 500) });
  });
  page.on('pageerror', (err) => {
    consoleMsgs.push({ type: 'pageerror', text: err.message.slice(0, 500) });
  });
  page.on('response', (resp) => {
    if (!resp.ok() && resp.status() >= 400) {
      networkErrors.push({ url: resp.url(), status: resp.status() });
    }
  });

  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    if (wait_for) {
      try { await page.waitForSelector(wait_for, { timeout: 5000 }); } catch {}
    } else {
      await page.waitForTimeout(wait_ms);
    }
    const title = await page.title().catch(() => '');
    const text = (await page.evaluate(() => document.body?.innerText || '').catch(() => '')).slice(0, 4000);
    const html_len = (await page.content().catch(() => '')).length;
    const status = response?.status() || 0;
    await ctx.close();
    return {
      ok: status > 0 && status < 400,
      url, status, title,
      text,
      html_len,
      console: consoleMsgs.slice(-30),
      network_errors: networkErrors.slice(-20),
    };
  } catch (err) {
    await ctx.close().catch(() => {});
    return { ok: false, url, error: err.message.slice(0, 300), console: consoleMsgs, network_errors: networkErrors };
  }
}

export async function browserEval({ url, script, wait_ms = 600 }) {
  const browser = await getBrowser();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(wait_ms);
    const result = await page.evaluate(script);
    await ctx.close();
    return { ok: true, result: typeof result === 'object' ? result : { value: result } };
  } catch (err) {
    await ctx.close().catch(() => {});
    return { ok: false, error: err.message.slice(0, 300) };
  }
}

export async function browserScreenshot({ url, projectId, taskId }) {
  const browser = await getBrowser();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(800);
    const buffer = await page.screenshot({ fullPage: true });
    await ctx.close();
    const dir = path.join(vaultRoot(), 'projects', projectId, 'runs', 'screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${taskId || Date.now()}-${Date.now()}.png`;
    fs.writeFileSync(path.join(dir, filename), buffer);
    return { ok: true, path: `projects/${projectId}/runs/screenshots/${filename}`, bytes: buffer.length };
  } catch (err) {
    await ctx.close().catch(() => {});
    return { ok: false, error: err.message.slice(0, 300) };
  }
}

export async function shutdownBrowser() {
  if (_browser) { try { await _browser.close(); } catch {} _browser = null; }
}
