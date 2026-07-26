/**
 * Single-boot diagnostic matrix.
 *
 * Booting the game under SwiftShader costs minutes, so when a frame looks wrong
 * this boots once and captures a whole matrix of toggles/debug buffers from the
 * same pose. Each variant is a mutation applied to the live game before a
 * re-settle, so you can bisect which pass is responsible in one run.
 *
 *   node scripts/diag.mjs --shot=establishing
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOTS } from './shots.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v = 'true'] = a.replace(/^--/, '').split('='); return [k, v];
}));

const SHOT = SHOTS.find((s) => s.name === (args.shot || 'establishing'));
const OUT = path.resolve(ROOT, args.out || 'shots/diag');
const W = parseInt(args.width || '960', 10);
const H = parseInt(args.height || '540', 10);
const PORT = parseInt(args.port || '4174', 10);

/**
 * Each variant runs in the page. `g` is the game. Return nothing; the harness
 * re-poses and re-settles after applying.
 */
const VARIANTS = [
  ['00-baseline', () => {}],
  ['01-debug-raw', (g) => { g.postfx.debug = 'raw'; }],
  ['02-debug-depth', (g) => { g.postfx.debug = 'depth'; }],
  ['03-debug-normal', (g) => { g.postfx.debug = 'normal'; }],
  ['04-debug-ao', (g) => { g.postfx.debug = 'ao'; }],
  ['05-debug-velocity', (g) => { g.postfx.debug = 'velocity'; }],
  ['06-no-volumetrics', (g) => { g.postfx.debug = null; g.settings.volumetrics = false; }],
  ['07-no-vol-no-bloom', (g) => { g.settings.bloomLevels = 0; }],
  ['08-no-vol-bloom-taa', (g) => { g.settings.taa = false; }],
  ['09-no-post-at-all', (g) => {
    g.settings.ssao = false; g.settings.ssr = false; g.settings.dof = false;
    g.settings.motionBlur = false;
  }],
  ['10-no-fog', (g) => {
    g.scene.fog = null;
    if (g.world?.fogBase !== undefined) g.world.fogBase = 0;
    if (g.postfx?.options) g.postfx.options.volumetricDensity = 0;
  }],
  ['11-restore-all', (g) => {
    g.settings.volumetrics = true; g.settings.bloomLevels = 6; g.settings.taa = true;
    g.settings.ssao = true; g.settings.ssr = true; g.settings.dof = true;
    g.settings.motionBlur = true; g.postfx.debug = null;
  }],
];

async function waitFor(url, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await sleep(300);
  }
  throw new Error('server down');
}

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT, stdio: 'ignore',
});
mkdirSync(OUT, { recursive: true });

try {
  await waitFor(`http://127.0.0.1:${PORT}/`);
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--js-flags=--max-old-space-size=4096'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__READY__===true||window.__BOOT_ERROR__', null, { timeout: 600000 });
  const err = await page.evaluate('window.__BOOT_ERROR__||null');
  if (err) { console.error('BOOT ERROR\n' + err); process.exit(1); }

  await page.evaluate(() => window.__GAME__.setState('playing'));

  for (const [name, fn] of VARIANTS) {
    process.stdout.write(`› ${name} … `);
    await page.evaluate(`(${fn.toString()})(window.__GAME__)`);
    await page.evaluate(([s]) => window.__CAPTURE__.pose(s, 12), [SHOT]);
    await page.waitForFunction('window.__CAPTURE__.settled===true', null, { timeout: 300000 });
    await page.evaluate(() => window.__CAPTURE__.freeze());
    await page.screenshot({ path: path.join(OUT, `${name}.png`), timeout: 120000, animations: 'disabled' });
    await page.evaluate(() => window.__CAPTURE__.thaw());
    console.log('ok');
  }

  const errs = logs.filter((l) => /^\[(error|pageerror)\]/.test(l));
  if (errs.length) console.error(`\n${errs.length} errors:\n` + errs.slice(0, 30).join('\n'));
  await browser.close();
} finally {
  server.kill('SIGTERM');
}
console.log(`\nwrote ${OUT}`);
