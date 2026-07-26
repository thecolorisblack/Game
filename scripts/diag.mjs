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
  ['01-hide-transparent', (g) => {
    // Anything that does not write depth is drawn unsorted after the opaque
    // pass; a single oversized one of these veils the whole frame.
    g.__hidden = [];
    g.scene.traverse((o) => {
      if (!o.visible || !(o.isMesh || o.isInstancedMesh || o.isPoints || o.isSprite)) return;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      if (ms.some((m) => m && (m.transparent || m.depthWrite === false || m.blending === 2))) {
        o.visible = false; g.__hidden.push(o);
      }
    });
    console.log('[diag] hid ' + g.__hidden.length + ' transparent objects');
  }],
  ['02-restore-hide-vfx', (g) => {
    for (const o of g.__hidden || []) o.visible = true;
    g.__hidden = [];
    const roots = [];
    g.scene.traverse((o) => {
      const n = (o.name || '').toLowerCase();
      if (n.includes('vfx') || n.includes('particle') || n.includes('ambient') || n.includes('dust')) roots.push(o);
    });
    for (const o of roots) { o.visible = false; g.__hidden.push(o); }
    console.log('[diag] vfx roots hidden: ' + roots.map((o) => o.name).join(','));
  }],
  ['03-restore-hide-ai', (g) => {
    for (const o of g.__hidden || []) o.visible = true;
    g.__hidden = [];
    g.scene.traverse((o) => {
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      if (ms.some((m) => m && /^ai_/.test(m.name || ''))) { o.visible = false; g.__hidden.push(o); }
    });
    console.log('[diag] hid ' + g.__hidden.length + ' ai meshes');
  }],
  ['04-world-only', (g) => {
    for (const o of g.__hidden || []) o.visible = true;
    g.__hidden = [];
    for (const child of [...g.scene.children]) {
      if (child.isLight || child === g.world?.root) continue;
      if (child.visible) { child.visible = false; g.__hidden.push(child); }
    }
    console.log('[diag] scene children: ' + g.scene.children.map((c) => `${c.name || c.type}:${c.visible}`).join(' '));
  }],
  ['05-world-only-basic', (g) => {
    // Replace every world material with flat white: isolates geometry and
    // visibility from shading. If this reads as a solid town, meshes are fine.
    const THREE = window.__THREE__;
    if (!THREE) { console.log('[diag] no THREE handle'); return; }
    g.__swapped = [];
    g.world?.root?.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh) return;
      g.__swapped.push([o, o.material]);
      o.material = new THREE.MeshBasicMaterial({ color: 0xbbbbbb });
    });
    console.log('[diag] swapped ' + g.__swapped.length + ' world materials to basic');
  }],
  ['06-restore', (g) => {
    for (const [o, m] of g.__swapped || []) o.material = m;
    g.__swapped = [];
    for (const o of g.__hidden || []) o.visible = true;
    g.__hidden = [];
  }],
  ['07-debug-normal', (g) => { g.postfx.debug = 'normal'; }],
  ['08-debug-ao', (g) => { g.postfx.debug = 'ao'; }],
  ['09-final', (g) => { g.postfx.debug = null; }],
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
