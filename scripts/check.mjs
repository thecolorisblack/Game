/**
 * Per-module build gate for parallel contributors.
 *
 * `npx vite build` type-checks the whole tree, which is useless when several
 * agents are mid-write in files you don't own. This bundles only the entry you
 * name (plus whatever it imports), so you verify *your* module compiles without
 * being blocked by, or tempted to "fix", somebody else's half-written file.
 *
 *   node scripts/check.mjs src/weapons/WeaponSystem.js [more.js ...]
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entries = process.argv.slice(2);

if (!entries.length) {
  console.error('usage: node scripts/check.mjs <entry.js> [...]');
  process.exit(2);
}

let failed = false;
for (const entry of entries) {
  try {
    const result = await build({
      entryPoints: [path.resolve(ROOT, entry)],
      bundle: true,
      write: false,
      format: 'esm',
      target: 'esnext',
      platform: 'browser',
      logLevel: 'silent',
      absWorkingDir: ROOT,
      // Resolve bare specifiers from node_modules but don't inline three itself;
      // we only care that syntax and local imports are sound.
      external: ['three', 'three/*', 'three-mesh-bvh', 'simplex-noise'],
    });
    const bytes = result.outputFiles?.[0]?.contents?.length ?? 0;
    console.log(`ok   ${entry}  (${(bytes / 1024).toFixed(1)} kB)`);
  } catch (err) {
    failed = true;
    console.error(`FAIL ${entry}`);
    for (const e of err.errors ?? []) {
      const loc = e.location ? `${e.location.file}:${e.location.line}:${e.location.column}` : '';
      console.error(`  ${loc} ${e.text}`);
    }
    if (!err.errors) console.error(`  ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
