/**
 * Boot the game and dump scene/material/light state as JSON.
 *
 * Rendering-based bisection is slow under SwiftShader; most "why is this frame
 * wrong" questions are actually answerable from the scene graph, and this
 * answers them in one boot with no screenshots.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4175;

async function waitFor(url, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if ((await fetch(url)).ok) return; } catch {} await sleep(300); }
  throw new Error('server down');
}

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT, stdio: 'ignore',
});

try {
  await waitFor(`http://127.0.0.1:${PORT}/`);
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--js-flags=--max-old-space-size=4096'],
  });
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__READY__===true||window.__BOOT_ERROR__', null, { timeout: 600000 });
  const boot = await page.evaluate('window.__BOOT_ERROR__||null');
  if (boot) { console.error('BOOT ERROR\n' + boot); process.exit(1); }

  const dump = await page.evaluate(() => {
    const g = window.__GAME__;
    const mats = new Map();
    const lights = [];
    let meshes = 0, tris = 0, transparentTris = 0;

    g.scene.traverse((o) => {
      if (o.isLight) {
        lights.push({
          type: o.type, intensity: o.intensity,
          color: o.color ? `#${o.color.getHexString()}` : null,
          ground: o.groundColor ? `#${o.groundColor.getHexString()}` : undefined,
          castShadow: !!o.castShadow,
          pos: o.position.toArray().map((v) => +v.toFixed(1)),
        });
      }
      if (!o.isMesh && !o.isInstancedMesh) return;
      meshes++;
      const count = o.isInstancedMesh ? o.count : 1;
      const idx = o.geometry?.index?.count ?? o.geometry?.attributes?.position?.count ?? 0;
      const t = (idx / 3) * count;
      tris += t;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!m) continue;
        const key = `${m.name || m.type}`;
        let e = mats.get(key);
        if (!e) mats.set(key, (e = {
          name: key, type: m.type, count: 0, tris: 0,
          transparent: !!m.transparent, opacity: m.opacity,
          depthWrite: m.depthWrite, depthTest: m.depthTest, side: m.side,
          color: m.color ? `#${m.color.getHexString()}` : null,
          rough: m.roughness, metal: m.metalness,
          envInt: m.envMapIntensity, hasEnv: !!m.envMap,
          emissive: m.emissive ? `#${m.emissive.getHexString()}` : null,
          emissiveInt: m.emissiveIntensity,
          map: !!m.map, normalMap: !!m.normalMap, aoMap: !!m.aoMap,
          surface: m.userData?.surface ?? null,
          blending: m.blending, alphaTest: m.alphaTest,
        }));
        e.count++; e.tris += t;
        if (m.transparent) transparentTris += t;
      }
    });

    const env = g.scene.environment;
    return {
      meshes, tris: Math.round(tris), transparentTris: Math.round(transparentTris),
      sceneEnvironment: env ? { type: env.type, mapping: env.mapping, w: env.image?.width } : null,
      environmentIntensity: g.scene.environmentIntensity,
      backgroundIntensity: g.scene.backgroundIntensity,
      fog: g.scene.fog ? { type: g.scene.fog.type, color: `#${g.scene.fog.color.getHexString()}`,
        density: g.scene.fog.density, near: g.scene.fog.near, far: g.scene.fog.far } : null,
      lights,
      toneMapping: g.renderer.toneMapping,
      toneMappingExposure: g.renderer.toneMappingExposure,
      outputColorSpace: g.renderer.outputColorSpace,
      materials: [...mats.values()].sort((a, b) => b.tris - a.tris).slice(0, 30),
    };
  });

  console.log(JSON.stringify(dump, null, 2));
  if (errs.length) console.error('\n--- console ---\n' + errs.slice(0, 20).join('\n'));
  await browser.close();
} finally {
  server.kill('SIGTERM');
}
