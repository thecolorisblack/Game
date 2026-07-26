/**
 * Headless capture harness.
 *
 * Builds the game, serves the bundle, drives it through a scripted sequence of
 * camera placements + actions in headless Chromium and writes PNGs to shots/.
 * This is the only way visual quality gets verified, so it must stay honest:
 * it renders the real pipeline at the real resolution with no debug shortcuts.
 *
 *   node scripts/shoot.mjs                 # all shots
 *   node scripts/shoot.mjs --only=hall,sky # subset
 *   node scripts/shoot.mjs --out=shots/r2  # alternate output dir
 *   node scripts/shoot.mjs --width=1920 --height=1080
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOTS } from './shots.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  }),
);

const WIDTH = parseInt(args.width || '1600', 10);
const HEIGHT = parseInt(args.height || '900', 10);
const OUT = path.resolve(ROOT, args.out || 'shots');
const ONLY = args.only ? new Set(args.only.split(',')) : null;
const PORT = parseInt(args.port || '4173', 10);
const SETTLE = parseInt(args.settle || '26', 10); // frames to render before capture

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', ...opts });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    p.on('error', reject);
  });
}

async function waitForServer(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(300);
  }
  throw new Error(`server never came up at ${url}`);
}

async function main() {
  if (!args.noBuild) {
    console.log('› building');
    await run('npx', ['vite', 'build', '--logLevel', 'warn']);
  }

  if (existsSync(OUT) && !args.keep) rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  console.log('› serving');
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', detached: false,
  });
  const url = `http://127.0.0.1:${PORT}/`;
  try {
    await waitForServer(url);

    const browser = await chromium.launch({
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--disable-frame-rate-limit',
        '--js-flags=--max-old-space-size=4096',
      ],
    });
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
    });

    const logs = [];
    page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

    console.log('› loading');
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Boot can take a while under SwiftShader: procedural texture bake + shader compile.
    await page.waitForFunction('window.__READY__ === true || window.__BOOT_ERROR__', null, { timeout: 300000 })
      .catch(async () => {
        console.error('!! boot timed out');
      });

    const bootErr = await page.evaluate('window.__BOOT_ERROR__ || null');
    if (bootErr) {
      console.error('!! BOOT ERROR\n' + bootErr);
      console.error(logs.slice(-40).join('\n'));
      await browser.close();
      process.exitCode = 1;
      return;
    }

    // Deterministic capture mode: fixed timestep, no pointer lock requirement,
    // RNG seeded so two runs of the same build are directly comparable.
    await page.evaluate(() => window.__GAME__.setState('playing'));

    for (const shot of SHOTS) {
      if (ONLY && !ONLY.has(shot.name)) continue;
      process.stdout.write(`› shot ${shot.name} … `);
      try {
        await page.evaluate(
          ([s, settle]) => window.__CAPTURE__.pose(s, settle),
          [shot, SETTLE],
        );
        await page.waitForFunction('window.__CAPTURE__.settled === true', null, { timeout: 300000 });
        await page.evaluate(() => window.__CAPTURE__.freeze());
        await page.screenshot({ path: path.join(OUT, `${shot.name}.png`), timeout: 120000, animations: 'disabled' });
        await page.evaluate(() => window.__CAPTURE__.thaw());
        console.log('ok');
      } catch (e) {
        console.log(`FAILED (${e.message})`);
      }
    }

    const errors = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
    if (errors.length) {
      console.error(`\n!! ${errors.length} console errors:`);
      console.error(errors.slice(0, 25).join('\n'));
    }

    const perf = await page.evaluate(() => window.__CAPTURE__?.stats?.() ?? null);
    if (perf) console.log('\n› stats', JSON.stringify(perf));

    await browser.close();
  } finally {
    server.kill('SIGTERM');
  }
  console.log(`\n› wrote ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
