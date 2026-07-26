/**
 * The material library itself: one recipe per surface, each composing noise
 * fields and structural passes into a full PBR set.
 *
 * A recipe returns a `Surface` (height + sRGB albedo + roughness + metalness +
 * AO). `Materials` packs it into textures and builds the three.js material from
 * the recipe's declared params/flags. Nothing here imports three, so the whole
 * bake can be profiled and unit-tested outside a browser.
 *
 * Authoring conventions:
 *  - colours are written as sRGB 0..255 triples, the way you'd pick them in a
 *    paint program; the texture is flagged SRGBColorSpace so three linearises.
 *  - `tileMeters` declares how many metres of world one UV tile should cover,
 *    so the world builder can scale UVs without guessing.
 */
import { fbm, worley, warpField, upsample2, mulberry32 } from './Noise.js';
import {
  Surface, alloc, clamp01, smoothstep, lerp,
  addF, addC, mulF, mulC, mixF, mixMask, mixConstMask, maxF, minF, invertF, clampF, copyF,
  contrastF, smoothstepF, powF, screenF, overlayF, ridgeF, remapF, blurWrap,
  gradientLUT, applyGradient, blendGradient, shadeAlbedo, tintMask,
  occlusionFromHeight, horizonAO, curvatureFromHeight,
} from './Fields.js';
import {
  brickCourses, tileGrid, plankRows, panelSeams, corrugation, stitchRows,
  formBoards, weave, crackNetwork, scratches, pitting, leafCluster, cellNoise,
} from './Patterns.js';

/* ------------------------------------------------------------------ */
/* bake context: caches the expensive shared fields per resolution      */
/* ------------------------------------------------------------------ */

export class BakeContext {
  constructor(size) {
    this.size = size;
    this.n = size * size;
    this._cache = new Map();
    this._pool = [];          // recycled scratch buffers
    this._issued = new Set();  // handed out since the last reclaim()
  }

  /**
   * Scratch field from the recycling pool. Everything handed out here is
   * returned by `reclaim()` once the material has been packed to bytes — a Set
   * guarantees a buffer is never handed back twice even if a recipe parked it
   * on the Surface (`cavity`, `alpha`) as well as using it locally.
   */
  alloc(v = 0) {
    const a = this._pool.length ? this._pool.pop() : new Float32Array(this.n);
    a.fill(v);
    this._issued.add(a);
    return a;
  }

  /** Pooled Surface: its seven channel buffers come from the same pool. */
  surface() { return new Surface(this.size, this); }

  reclaim() {
    for (const a of this._issued) if (this._pool.length < 64) this._pool.push(a);
    this._issued.clear();
  }

  /** Cached tileable FBM. Always returns a *copy* so recipes can mutate freely. */
  noise(key, opts) {
    let f = this._cache.get('n:' + key);
    if (!f) { f = fbm(this.size, opts); this._cache.set('n:' + key, f); }
    return copyF(f);
  }

  /** Cached FBM without the copy, for read-only use in hot loops. */
  noiseRef(key, opts) {
    let f = this._cache.get('n:' + key);
    if (!f) { f = fbm(this.size, opts); this._cache.set('n:' + key, f); }
    return f;
  }

  /** Cached Worley set (read-only; copy the channel you intend to mutate). */
  cells(key, cellCount, seed, opts) {
    let w = this._cache.get('w:' + key);
    if (!w) { w = worley(this.size, cellCount, seed, opts); this._cache.set('w:' + key, w); }
    return w;
  }

  dispose() { this._cache.clear(); this._pool.length = 0; this._issued.clear(); }
}

/* ------------------------------------------------------------------ */
/* small local helpers                                                  */
/* ------------------------------------------------------------------ */

function downsampleF(src, size) {
  const half = size >> 1;
  const out = new Float32Array(half * half);
  for (let y = 0; y < half; y++) {
    const a = y * 2 * size;
    const b = a + size;
    for (let x = 0; x < half; x++) {
      out[y * half + x] = (src[a + x * 2] + src[a + x * 2 + 1] + src[b + x * 2] + src[b + x * 2 + 1]) * 0.25;
    }
  }
  return out;
}

/**
 * Horizon AO is a broad-scale term, so it is computed on a quarter-resolution
 * height pyramid and upsampled: 16x fewer rays for a result that is visually
 * identical once it is combined with the full-res cavity occlusion.
 */
function horizonAOFast(height, size, opts) {
  if (size < 256) return horizonAO(height, size, opts);
  const radius = opts?.radius ?? size / 20;
  const q1 = downsampleF(height, size);
  const q = size >> 2;
  const q2 = downsampleF(q1, size >> 1);
  const ao = horizonAO(q2, q, { ...opts, radius: Math.max(2, radius * 0.25) });
  return upsample2(upsample2(ao, q), q << 1);
}

/** Standard AO finish: cavity everywhere, plus directional horizon on heroes. */
function finishAO(surf, { horizon = false, fine = null, broad = null, strength = 1 } = {}) {
  const size = surf.size;
  const cav = occlusionFromHeight(surf.h, size, {
    fine: fine ?? size / 128,
    broad: broad ?? size / 22,
  });
  if (horizon) {
    const hz = horizonAOFast(surf.h, size, { dirs: 8, steps: 6, radius: size / 16, strength: 0.9 });
    for (let i = 0; i < cav.length; i++) cav[i] = Math.min(cav[i], cav[i] * 0.35 + hz[i] * 0.65);
  }
  if (strength !== 1) for (let i = 0; i < cav.length; i++) cav[i] = 1 - (1 - cav[i]) * strength;
  surf.ao = cav;
  return cav;
}

/** Per-pixel scalar mix helper used all over the recipes. */
function mixInto(dst, target, mask, amount = 1) {
  for (let i = 0; i < dst.length; i++) dst[i] += (target - dst[i]) * clamp01(mask[i]) * amount;
  return dst;
}

/** Multiply a field by (1 + f*amount) style modulation. */
function modulate(dst, f, amount) {
  for (let i = 0; i < dst.length; i++) dst[i] = clamp01(dst[i] + (f[i] - 0.5) * amount);
  return dst;
}

/** Vertical gravity streaks: smears a seed field downward with decay. */
function streakDown(seed, size, length = size / 6, decay = 0.965) {
  const out = copyF(seed);
  for (let x = 0; x < size; x++) {
    let acc = 0;
    // two wraparound passes so the streak is seamless top-to-bottom
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < size; y++) {
        const o = y * size + x;
        acc = Math.max(acc * decay, seed[o]);
        if (pass === 1 && acc > out[o]) out[o] = acc;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* palettes                                                            */
/* ------------------------------------------------------------------ */

const LUT = {
  concrete: gradientLUT([
    [0.00, 62, 63, 62], [0.25, 100, 101, 100], [0.55, 132, 133, 131],
    [0.80, 154, 154, 152], [1.00, 174, 175, 174],
  ]),
  concreteStain: gradientLUT([
    [0.0, 46, 43, 38], [0.5, 82, 76, 66], [1.0, 120, 112, 98],
  ]),
  brick: gradientLUT([
    [0.00, 66, 40, 33], [0.20, 96, 54, 42], [0.42, 124, 72, 54],
    [0.60, 146, 92, 70], [0.78, 116, 70, 55], [1.00, 92, 58, 48],
  ]),
  mortar: gradientLUT([
    [0.0, 118, 114, 105], [0.6, 158, 154, 144], [1.0, 186, 182, 172],
  ]),
  rust: gradientLUT([
    [0.00, 58, 28, 16], [0.22, 96, 44, 22], [0.45, 138, 68, 30],
    [0.68, 168, 92, 42], [0.86, 142, 82, 46], [1.00, 96, 60, 40],
  ]),
  steel: gradientLUT([
    [0.0, 54, 56, 61], [0.35, 92, 96, 103], [0.7, 132, 136, 143], [1.0, 168, 172, 179],
  ]),
  gunmetal: gradientLUT([
    [0.0, 28, 29, 32], [0.35, 52, 54, 58], [0.7, 84, 86, 92], [1.0, 122, 125, 132],
  ]),
  wood: gradientLUT([
    [0.00, 52, 34, 21], [0.18, 88, 58, 34], [0.40, 122, 84, 50],
    [0.62, 150, 110, 70], [0.82, 172, 133, 90], [1.00, 190, 156, 112],
  ]),
  woodGrey: gradientLUT([
    [0.0, 82, 76, 68], [0.5, 124, 118, 108], [1.0, 158, 152, 142],
  ]),
  sand: gradientLUT([
    [0.00, 132, 108, 74], [0.28, 168, 142, 100], [0.55, 196, 172, 128],
    [0.78, 202, 180, 140], [1.00, 218, 199, 164],
  ]),
  dirt: gradientLUT([
    [0.00, 38, 30, 22], [0.24, 64, 50, 36], [0.50, 92, 74, 52],
    [0.74, 118, 98, 70], [1.00, 146, 124, 92],
  ]),
  asphalt: gradientLUT([
    [0.00, 22, 22, 24], [0.30, 38, 38, 41], [0.60, 58, 58, 62],
    [0.82, 84, 84, 88], [1.00, 116, 116, 120],
  ]),
  gravel: gradientLUT([
    [0.00, 38, 36, 34], [0.20, 64, 61, 57], [0.42, 96, 91, 85],
    [0.62, 126, 120, 112], [0.82, 102, 92, 80], [1.00, 152, 146, 136],
  ]),
  canvas: gradientLUT([
    [0.0, 74, 68, 52], [0.4, 112, 104, 80], [0.75, 142, 132, 104], [1.0, 164, 154, 124],
  ]),
  cardboard: gradientLUT([
    [0.0, 96, 72, 46], [0.4, 138, 106, 68], [0.75, 168, 134, 92], [1.0, 186, 154, 112],
  ]),
  flesh: gradientLUT([
    [0.00, 108, 66, 54], [0.28, 154, 100, 82], [0.55, 186, 132, 110],
    [0.78, 206, 156, 132], [1.00, 220, 178, 154],
  ]),
  foliage: gradientLUT([
    [0.00, 24, 38, 18], [0.28, 44, 66, 26], [0.52, 66, 92, 34],
    [0.74, 92, 118, 44], [1.00, 128, 148, 66],
  ]),
  tile: gradientLUT([
    [0.0, 156, 158, 154], [0.35, 184, 186, 182], [0.7, 202, 204, 200], [1.0, 218, 220, 217],
  ]),
  plaster: gradientLUT([
    [0.0, 134, 128, 117], [0.4, 168, 162, 150], [0.75, 192, 186, 174], [1.0, 208, 203, 192],
  ]),
  polymer: gradientLUT([
    [0.0, 24, 25, 24], [0.4, 40, 42, 40], [0.75, 58, 60, 57], [1.0, 78, 80, 76],
  ]),
  paint: gradientLUT([
    [0.0, 42, 52, 44], [0.4, 62, 74, 62], [0.75, 82, 94, 80], [1.0, 100, 112, 96],
  ]),
};

/* ================================================================== */
/* recipes                                                             */
/* ================================================================== */

/** Board-formed cast concrete: the backbone surface of the whole level. */
function bakeConcrete(ctx, opts = {}) {
  const size = ctx.size;
  const s = ctx.surface();
  const form = formBoards(size, { boards: 5, ties: 2, tieR: 0.017, lip: 0.028, seed: 97 });
  const agg = ctx.cells('agg64', Math.max(24, size / 16 | 0), 5);
  const blotch = ctx.noiseRef('blotch', { start: 12, octaves: 6, gain: 0.58, seed: 131 });
  const broad = ctx.noiseRef('broad', { start: 4, octaves: 7, gain: 0.55, seed: 11 });
  const mid = ctx.noiseRef('mid', { start: 24, octaves: 6, gain: 0.52, seed: 23 });
  const grit = ctx.noiseRef('grit', { start: 96, octaves: 4, gain: 0.5, seed: 37 });
  const pits = pitting(size, { count: size * 0.85 | 0, rMin: 0.6, rMax: size / 300, depth: 0.7, seed: 149 });

  // --- height -------------------------------------------------------
  const h = s.h;
  const exposedAgg = ctx.alloc();
  for (let i = 0; i < h.length; i++) {
    // Aggregate only shows where the cement paste has worn or spalled away;
    // elsewhere the stones are buried and contribute nothing but a faint swell.
    const expose = smoothstep(0.46, 0.86, blotch[i]);
    const stone = smoothstep(0.58, 0.04, agg.f1[i]);
    const aggregate = stone * (0.12 + expose * 0.88);
    exposedAgg[i] = stone * expose;
    h[i] = form.h[i] + (mid[i] - 0.5) * 0.13 + (blotch[i] - 0.5) * 0.07
      + (grit[i] - 0.5) * 0.05 + aggregate * 0.085 - pits[i] * 0.16;
  }
  clampF(h, 0, 1);

  // --- albedo -------------------------------------------------------
  const tone = ctx.alloc();
  for (let i = 0; i < tone.length; i++) {
    // Stones read both lighter and darker than the paste — a field of uniformly
    // pale dots is the tell-tale of procedural concrete.
    tone[i] = clamp01(0.16 + broad[i] * 0.32 + (blotch[i] - 0.5) * 0.44 + (mid[i] - 0.5) * 0.32
      + (grit[i] - 0.5) * 0.18 + exposedAgg[i] * (agg.id[i] - 0.45) * 0.62);
  }
  applyGradient(s, tone, LUT.concrete);

  // water staining running down from the form-board joints and tie holes
  const stainSeed = ctx.alloc();
  for (let i = 0; i < stainSeed.length; i++) {
    stainSeed[i] = clamp01(form.mask[i] * 0.9 * smoothstep(0.45, 0.75, broad[i]));
  }
  const streak = streakDown(stainSeed, size, size / 5, 0.972);
  for (let i = 0; i < streak.length; i++) streak[i] = clamp01(streak[i] * (0.5 + mid[i] * 0.9));
  blendGradient(s, tone, LUT.concreteStain, streak, 0.62);

  // efflorescence: pale salt bloom in the low-frequency dips
  const bloom = ctx.alloc();
  for (let i = 0; i < bloom.length; i++) bloom[i] = smoothstep(0.74, 0.96, broad[i]) * smoothstep(0.4, 0.75, grit[i]) * 0.30;
  tintMask(s, [214, 212, 204], bloom, 1);

  // dust settled in every recess
  const dust = ctx.alloc();
  for (let i = 0; i < dust.length; i++) dust[i] = clamp01((1 - h[i] * 1.25) * 0.7 * mid[i]);
  tintMask(s, [150, 144, 132], dust, 0.5);

  // --- roughness / metal -------------------------------------------
  const rough = s.rough;
  for (let i = 0; i < rough.length; i++) {
    rough[i] = clamp01(0.82 + (grit[i] - 0.5) * 0.20 + (mid[i] - 0.5) * 0.12
      - exposedAgg[i] * 0.20 + streak[i] * 0.06);
  }
  s.metal.fill(0);
  s.cavity = pits;

  finishAO(s, { horizon: opts.horizon !== false, broad: size / 20 });
  return s;
}

/** Concrete that has taken the fight: spalled, cracked, rebar bleeding through. */
function bakeConcreteCracked(ctx) {
  const size = ctx.size;
  const s = bakeConcrete(ctx, { horizon: false });
  const cellA = ctx.cells('crackA', 7, 91, { jitter: 1 });
  const cellB = ctx.cells('crackB', 17, 113, { jitter: 1 });
  const breakF = ctx.noiseRef('breakF', { start: 8, octaves: 6, gain: 0.55, seed: 211 });
  const mid = ctx.noiseRef('mid', { start: 24, octaves: 6, gain: 0.52, seed: 23 });

  const edgeA = ctx.alloc();
  const edgeB = ctx.alloc();
  for (let i = 0; i < edgeA.length; i++) {
    edgeA[i] = cellA.f2[i] - cellA.f1[i];
    edgeB[i] = cellB.f2[i] - cellB.f1[i];
  }
  const crackMain = crackNetwork(size, edgeA, breakF, { width: 0.035, softness: 0.06, breakThreshold: 0.38, depth: 1 });
  const crackFine = crackNetwork(size, edgeB, mid, { width: 0.05, softness: 0.10, breakThreshold: 0.5, depth: 0.55 });

  // spalled patches where the cover concrete has blown off
  const spallSeed = ctx.noiseRef('spall', { start: 6, octaves: 6, gain: 0.6, seed: 307 });
  const spall = ctx.alloc();
  for (let i = 0; i < spall.length; i++) spall[i] = smoothstep(0.70, 0.86, spallSeed[i]);

  const h = s.h;
  for (let i = 0; i < h.length; i++) {
    h[i] = clamp01(h[i] - crackMain[i] * 0.34 - crackFine[i] * 0.16 - spall[i] * 0.28);
  }

  // exposed aggregate + rebar rust bleeding out of the cracks
  const inCrack = ctx.alloc();
  for (let i = 0; i < inCrack.length; i++) inCrack[i] = clamp01(crackMain[i] * 1.1 + spall[i] * 0.8);
  const dark = ctx.alloc();
  for (let i = 0; i < dark.length; i++) dark[i] = clamp01(0.15 + mid[i] * 0.35);
  blendGradient(s, dark, LUT.concreteStain, inCrack, 0.8);

  const rustSeed = ctx.alloc();
  for (let i = 0; i < rustSeed.length; i++) rustSeed[i] = crackMain[i] * smoothstep(0.55, 0.85, spallSeed[i]);
  const rustRun = streakDown(rustSeed, size, size / 7, 0.968);
  const rustT = ctx.alloc();
  for (let i = 0; i < rustT.length; i++) rustT[i] = clamp01(0.3 + mid[i] * 0.5);
  blendGradient(s, rustT, LUT.rust, rustRun, 0.55);

  for (let i = 0; i < s.rough.length; i++) {
    s.rough[i] = clamp01(s.rough[i] + inCrack[i] * 0.12 + rustRun[i] * 0.08);
  }
  finishAO(s, { horizon: false, broad: size / 16 });
  return s;
}

/** Troweled interior plaster — subtle, smooth, high AO payoff on the swirls. */
function bakePlaster(ctx) {
  const size = ctx.size;
  const s = ctx.surface();
  const broad = ctx.noiseRef('broad', { start: 4, octaves: 7, gain: 0.55, seed: 11 });
  const mid = ctx.noiseRef('mid', { start: 24, octaves: 6, gain: 0.52, seed: 23 });
  const fine = ctx.noiseRef('fine', { start: 64, octaves: 5, gain: 0.5, seed: 53 });
  const warpA = ctx.noiseRef('warpA', { start: 8, octaves: 5, gain: 0.6, seed: 71 });
  const warpB = ctx.noiseRef('warpB', { start: 8, octaves: 5, gain: 0.6, seed: 73 });

  // trowel arcs: concentric-ish sweeps warped into believable hand strokes
  const arcs = ctx.alloc();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = y * size + x;
      const u = x / size, v = y / size;
      const a = Math.sin((u * 5.3 + v * 2.1 + warpA[o] * 3.4) * Math.PI * 2);
      const b = Math.sin((v * 4.1 - u * 1.7 + warpB[o] * 3.9) * Math.PI * 2);
      arcs[o] = clamp01(0.5 + (a * 0.55 + b * 0.45) * 0.22);
    }
  }

  const h = s.h;
  for (let i = 0; i < h.length; i++) {
    h[i] = clamp01(0.5 + (broad[i] - 0.5) * 0.30 + (arcs[i] - 0.5) * 0.42
      + (mid[i] - 0.5) * 0.10 + (fine[i] - 0.5) * 0.05);
  }

  // hairline crazing
  const cell = ctx.cells('crazeP', 22, 401, { jitter: 1 });
  const edge = ctx.alloc();
  for (let i = 0; i < edge.length; i++) edge[i] = cell.f2[i] - cell.f1[i];
  const craze = crackNetwork(size, edge, broad, { width: 0.03, softness: 0.05, breakThreshold: 0.55, depth: 0.5 });
  for (let i = 0; i < h.length; i++) h[i] = clamp01(h[i] - craze[i] * 0.10);

  const tone = ctx.alloc();
  for (let i = 0; i < tone.length; i++) {
    tone[i] = clamp01(0.35 + broad[i] * 0.45 + (arcs[i] - 0.5) * 0.30 + (fine[i] - 0.5) * 0.14);
  }
  applyGradient(s, tone, LUT.plaster);

  // grime along the bottom and around patched repairs
  const patch = ctx.alloc();
  for (let i = 0; i < patch.length; i++) patch[i] = smoothstep(0.68, 0.85, mid[i]) * 0.6;
  tintMask(s, [176, 170, 158], patch, 1);
  const grime = ctx.alloc();
  for (let i = 0; i < grime.length; i++) grime[i] = clamp01(craze[i] * 0.8 + (1 - h[i]) * 0.25 * mid[i]);
  tintMask(s, [116, 110, 100], grime, 0.55);

  for (let i = 0; i < s.rough.length; i++) {
    s.rough[i] = clamp01(0.74 + (fine[i] - 0.5) * 0.16 + (arcs[i] - 0.5) * 0.12 + craze[i] * 0.10);
  }
  finishAO(s, { horizon: false, fine: size / 200, broad: size / 26 });
  return s;
}

/** Coarse exterior stucco: splattered render with a heavy stipple. */
function bakeStucco(ctx) {
  const size = ctx.size;
  const s = ctx.surface();
  const splat = ctx.cells('splat', Math.max(28, size / 14 | 0), 173, { jitter: 1 });
  const splat2 = ctx.cells('splat2', Math.max(48, size / 8 | 0), 179, { jitter: 1 });
  const broad = ctx.noiseRef('broad', { start: 4, octaves: 7, gain: 0.55, seed: 11 });
  const mid = ctx.noiseRef('mid', { start: 24, octaves: 6, gain: 0.52, seed: 23 });
  const grit = ctx.noiseRef('grit', { start: 96, octaves: 4, gain: 0.5, seed: 37 });

  const h = s.h;
  for (let i = 0; i < h.length; i++) {
    const blobA = smoothstep(0.62, 0.05, splat.f1[i]) * (0.5 + splat.id[i] * 0.5);
    const blobB = smoothstep(0.55, 0.08, splat2.f1[i]) * (0.35 + splat2.id[i] * 0.65);
    h[i] = clamp01(0.30 + blobA * 0.44 + blobB * 0.26 + (grit[i] - 0.5) * 0.10 + (broad[i] - 0.5) * 0.14);
  }

  const tone = ctx.alloc();
  for (let i = 0; i < tone.length; i++) {
    tone[i] = clamp01(0.25 + h[i] * 0.55 + broad[i] * 0.28 + (grit[i] - 0.5) * 0.18);
  }
  applyGradient(s, tone, LUT.plaster);
  const dirty = ctx.alloc();
  for (let i = 0; i < dirty.length; i++) dirty[i] = clamp01((1 - h[i]) * 0.85 * (0.4 + mid[i] * 0.9));
  tintMask(s, [122, 114, 100], dirty, 0.7);

  for (let i = 0; i < s.rough.length; i++) s.rough[i] = clamp01(0.88 + (grit[i] - 0.5) * 0.14 - h[i] * 0.06);
  finishAO(s, { horizon: false, broad: size / 18 });
  return s;
}

/** Weathered fired-clay brick in running bond. */
function bakeBrick(ctx) {
  const size = ctx.size;
  const s = ctx.surface();
  const bk = brickCourses(size, { rows: 12, cols: 6, joint: 0.011, bevel: 0.007, heightJitter: 0.14, seed: 17 });
  const mid = ctx.noiseRef('mid', { start: 24, octaves: 6, gain: 0.52, seed: 23 });
  const fine = ctx.noiseRef('fine', { start: 64, octaves: 5, gain: 0.5, seed: 53 });
  const grit = ctx.noiseRef('grit', { start: 96, octaves: 4, gain: 0.5, seed: 37 });
  const broad = ctx.noiseRef('broad', { start: 4, octaves: 7, gain: 0.55, seed: 11 });
  const pits = pitting(size, { count: size * 2.2 | 0, rMin: 0.6, rMax: size / 240, depth: 1, seed: 251 });

  const face = ctx.alloc();
  for (let i = 0; i < face.length; i++) face[i] = 1 - bk.mask[i];

  // chipped corners: bite out of the brick where edge + noise agree
  const chip = ctx.alloc();
  for (let i = 0; i < chip.length; i++) {
    chip[i] = clamp01(bk.edge[i] * smoothstep(0.58, 0.86, fine[i]) * 1.8) * face[i];
  }

  const h = s.h;
  for (let i = 0; i < h.length; i++) {
    const clay = (fine[i] - 0.5) * 0.07 + (grit[i] - 0.5) * 0.04 - pits[i] * 0.12;
    const mortarTex = (grit[i] - 0.5) * 0.10 + (mid[i] - 0.5) * 0.05;
    h[i] = clamp01(bk.h[i] + clay * face[i] + mortarTex * bk.mask[i] - chip[i] * 0.22);
  }

  // per-brick colour, then within-brick mottling
  const tone = ctx.alloc();
  for (let i = 0; i < tone.length; i++) {
    tone[i] = clamp01(bk.id[i] * 0.86 + 0.05 + (mid[i] - 0.5) * 0.36 + (fine[i] - 0.5) * 0.20);
  }
  applyGradient(s, tone, LUT.brick);

  const mortarTone = ctx.alloc();
  for (let i = 0; i < mortarTone.length; i++) mortarTone[i] = clamp01(0.3 + grit[i] * 0.55 + (mid[i] - 0.5) * 0.3);
  blendGradient(s, mortarTone, LUT.mortar, bk.mask, 1);

  // fresh clay revealed in the chips
  const chipTone = ctx.alloc();
  for (let i = 0; i < chipTone.length; i++) chipTone[i] = clamp01(0.55 + (fine[i] - 0.5) * 0.3);
  blendGradient(s, chipTone, LUT.brick, chip, 0.85);
  tintMask(s, [196, 132, 104], chip, 0.35);

  // soot and rain staining
  const sootSeed = ctx.alloc();
  for (let i = 0; i < sootSeed.length; i++) sootSeed[i] = bk.mask[i] * smoothstep(0.5, 0.8, broad[i]);
  const soot = streakDown(sootSeed, size, size / 6, 0.975);
  tintMask(s, [44, 38, 34], soot, 0.60);

  const efflor = ctx.alloc();
  for (let i = 0; i < efflor.length; i++) efflor[i] = smoothstep(0.80, 0.98, broad[i]) * face[i] * 0.30;
  tintMask(s, [206, 202, 194], efflor, 1);

  for (let i = 0; i < s.rough.length; i++) {
    s.rough[i] = clamp01(0.78 + bk.mask[i] * 0.14 + (grit[i] - 0.5) * 0.16 - efflor[i] * 0.06 + chip[i] * 0.08);
  }
  s.metal.fill(0);
  finishAO(s, { horizon: true, broad: size / 14 });
  return s;
}

/** Glazed ceramic tile with grout, crazing and chipped corners. */
function bakeTile(ctx) {
  const size = ctx.size;
  const s = ctx.surface();
  const tg = tileGrid(size, { rows: 8, cols: 8, joint: 0.011, bevel: 0.010, heightJitter: 0.02, seed: 23 });
  const fine = ctx.noiseRef('fine', { start: 64, octaves: 5, gain: 0.5, seed: 53 });
  const mid = ctx.noiseRef('mid', { start: 24, octaves: 6, gain: 0.52, seed: 23 });
  const grit = ctx.noiseRef('grit', { start: 96, octaves: 4, gain: 0.5, seed: 37 });
  const cell = ctx.cells('crazeT', 40, 409, { jitter: 1 });
  const edge = ctx.alloc();
  for (let i = 0; i < edge.length; i++) edge[i] = cell.f2[i] - cell.f1[i];
  const craze = crackNetwork(size, edge, fine, { width: 0.028, softness: 0.04, breakThreshold: 0.5, depth: 1 });

  const face = ctx.alloc();
  for (let i = 0; i < face.length; i++) face[i] = 1 - tg.mask[i];
  const chip = ctx.alloc();
  for (let i = 0; i < chip.length; i++) chip[i] = clamp01(tg.edge[i] * smoothstep(0.72, 0.93, mid[i]) * 2.2) * face[i];

  const h = s.h;
  for (let i = 0; i < h.length; i++) {
    h[i] = clamp01(tg.h[i] + (grit[i] - 0.5) * 0.10 * tg.mask[i] - craze[i] * 0.03 * face[i] - chip[i] * 0.20);
  }

  const tone = ctx.alloc();
  for (let i = 0; i < tone.length; i++) tone[i] = clamp01(0.45 + tg.id[i] * 0.30 + (fine[i] - 0.5) * 0.16);
  applyGradient(s, tone, LUT.tile);
  const groutTone = ctx.alloc();
  for (let i = 0; i < groutTone.length; i++) groutTone[i] = clamp01(0.18 + grit[i] * 0.4 + (mid[i] - 0.5) * 0.3);
  blendGradient(s, groutTone, LUT.mortar, tg.mask, 1);
  tintMask(s, [86, 80, 70], craze, 0.30);
  const dirt = ctx.alloc();
  for (let i = 0; i < dirt.length; i++) dirt[i] = clamp01(tg.mask[i] * 0.7 * (0.3 + mid[i]));
  tintMask(s, [96, 88, 74], dirt, 0.45);

  for (let i = 0; i < s.rough.length; i++) {
    s.rough[i] = clamp01(0.14 + tg.mask[i] * 0.72 + (fine[i] - 0.5) * 0.06 + craze[i] * 0.18 + chip[i] * 0.5);
  }
  finishAO(s, { horizon: false, fine: size / 180, broad: size / 28 });
  return s;
}

/** Aged asphalt: exposed aggregate in a tired bitumen matrix. */
function bakeAsphalt(ctx) {
  const size = ctx.size;
  const s = ctx.surface();
  const aggA = ctx.cells('aspA', Math.max(30, size / 14 | 0), 311, { jitter: 1 });
  const aggB = ctx.cells('aspB', Math.max(56, size / 10 | 0), 313, { jitter: 1 });
  const broad = ctx.noiseRef('broad', { start: 4, octaves: 7, gain: 0.55, seed: 11 });
  const mid = ctx.noiseRef('mid', { start: 24, octaves: 6, gain: 0.52, seed: 23 });
  const grit = ctx.noiseRef('grit', { start: 96, octaves: 4, gain: 0.5, seed: 37 });
  const cell = ctx.cells('aspCrack', 9, 317, { jitter: 1 });
  const edge = ctx.alloc();
  for (let i = 0; i < edge.length; i++) edge[i] = cell.f2[i] - cell.f1[i];
  const cracks = crackNetwork(size, edge, broad, { width: 0.04, softness: 0.07, breakThreshold: 0.44, depth: 1 });

  const h = s.h;
  const stone = ctx.alloc();
  for (let i = 0; i < h.length; i++) {
    const a = smoothstep(0.52, 0.05, aggA.f1[i]) * (0.4 + aggA.id[i] * 0.6);
    const b = smoothstep(0.48, 0.08, aggB.f1[i]) * (0.3 + aggB.id[i] * 0.7);
    const expose = smoothstep(0.42, 0.72, broad[i]);
    stone[i] = clamp01((a * 0.7 + b * 0.5) * (0.35 + expose * 0.9));
    h[i] = clamp01(0.44 + stone[i] * 0.30 + (grit[i] - 0.5) * 0.10 + (mid[i] - 0.5) * 0.12 - cracks[i] * 0.30);
  }

  const tone = ctx.alloc();
  for (let i = 0; i < tone.length; i++) {
    tone[i] = clamp01(0.16 + stone[i] * 0.62 * (0.4 + aggA.id[i] * 0.9) + (mid[i] - 0.5) * 0.24 + broad[i] * 0.22);
  }
  applyGradient(s, tone, LUT.asphalt);
  // tar repair patches, dead flat and near-black
  const tar = ctx.alloc();
  for (let i = 0; i < tar.length; i++) tar[i] = smoothstep(0.74, 0.84, broad[i]) * 0.9;
  tintMask(s, [26, 25, 26], tar, 1);
  tintMask(s, [18, 17, 18], cracks, 0.75);

  for (let i = 0; i < s.rough.length; i++) {
    s.rough[i] = clamp01(0.86 + (grit[i] - 0.5) * 0.16 - stone[i] * 0.22 - tar[i] * 0.10 + cracks[i] * 0.05);
  }
  s.cavity = cracks;
  finishAO(s, { horizon: true, broad: size / 18 });
  return s;
}

/** Loose graded gravel — reads as a bed of individual stones, not noise. */
function bakeGravel(ctx) {
  const size = ctx.size;
  const s = ctx.surface();
  const big = ctx.cells('grvA', Math.max(16, size / 26 | 0), 421, { jitter: 1 });
  const med = ctx.cells('grvB', Math.max(34, size / 13 | 0), 423, { jitter: 1 });
  const sml = ctx.cells('grvC', Math.max(70, size / 6 | 0), 427, { jitter: 1 });
  const grit = ctx.noiseRef('grit', { start: 96, octaves: 4, gain: 0.5, seed: 37 });
  const mid = ctx.noiseRef('mid', { start: 24, octaves: 6, gain: 0.52, seed: 23 });

  const h = s.h;
  const idField = ctx.alloc();
  for (let i = 0; i < h.length; i++) {
    const a = Math.pow(smoothstep(0.85, 0.0, big.f1[i]), 0.65) * (0.55 + big.id[i] * 0.45);
    const b = Math.pow(smoothstep(0.80, 0.0, med.f1[i]), 0.7) * (0.45 + med.id[i] * 0.55);
    const c = Math.pow(smoothstep(0.78, 0.0, sml.f1[i]), 0.8) * (0.35 + sml.id[i] * 0.65);
    let v = a * 0.55;
    v = Math.max(v, b * 0.42);
    v = Math.max(v, c * 0.28);
    h[i] = clamp01(0.16 + v + (grit[i] - 0.5) * 0.06);
    idField[i] = a > b && a > c ? big.id[i] : b > c ? med.id[i] : sml.id[i];
  }

  const tone = ctx.alloc();
  for (let i = 0; i < tone.length; i++) {
    tone[i] = clamp01(idField[i] * 0.86 + h[i] * 0.22 + (mid[i] - 0.5) * 0.24 + (grit[i] - 0.5) * 0.14);
  }
  applyGradient(s, tone, LUT.gravel);
  // fine dust packed between the stones
  const dust = ctx.alloc();
  for (let i = 0; i < dust.length; i++) dust[i] = clamp01((1 - h[i] * 1.6) * (0.5 + grit[i] * 0.8));
  tintMask(s, [128, 118, 100], dust, 0.65);

  for (let i = 0; i < s.rough.length; i++) {
    s.rough[i] = clamp01(0.86 + (grit[i] - 0.5) * 0.14 - h[i] * 0.14 + dust[i] * 0.08);
  }
  finishAO(s, { horizon: true, fine: size / 120, broad: size / 20, strength: 1.15 });
  return s;
}

/** Battlefield rubble: shattered concrete, brick fragments, dust, rebar. */
function bakeRubble(ctx) {
  const size = ctx.size;
  const s = ctx.surface();
  const chunk = ctx.cells('rubA', Math.max(12, size / 34 | 0), 521, { jitter: 1, chebyshev: true });
  const shard = ctx.cells('rubB', Math.max(26, size / 17 | 0), 523, { jitter: 1 });
  const fines = ctx.cells('rubC', Math.max(56, size / 8 | 0), 527, { jitter: 1 });
  const broad = ctx.noiseRef('broad', { start: 4, octaves: 7, gain: 0.55, seed: 11 });
  const mid = ctx.noiseRef('mid', { start: 24, octaves: 6, gain: 0.52, seed: 23 });
  const grit = ctx.noiseRef('grit', { start: 96, octaves: 4, gain: 0.5, seed: 37 });

  const h = s.h;
  const kind = ctx.alloc();   // 0 = concrete, 1 = brick
  for (let i = 0; i < h.length; i++) {
    const a = Math.pow(smoothstep(0.9, 0.0, chunk.f1[i]), 0.5) * (0.5 + chunk.id[i] * 0.5);
    const b = Math.pow(smoothstep(0.85, 0.0, shard.f1[i]), 0.6) * (0.4 + shard.id[i] * 0.6);
    const c = Math.pow(smoothstep(0.8, 0.0, fines.f1[i]), 0.8) * 0.5;
    let v = a * 0.6;
    v = Math.max(v, b * 0.40);
    v = Math.max(v, c * 0.22);
    h[i] = clamp01(0.14 + v + (grit[i] - 0.5) * 0.07 + (mid[i] - 0.5) * 0.06);
    kind[i] = (a > b ? chunk.id[i] : shard.id[i]) > 0.68 ? 1 : 0;
  }

  const tone = ctx.alloc();
  for (let i = 0; i < tone.length; i++) tone[i] = clamp01(0.22 + h[i] * 0.6 + (mid[i] - 0.5) * 0.26 + (grit[i] - 0.5) * 0.14);
  applyGradient(s, tone, LUT.concrete);
  const brickTone = ctx.alloc();
  for (let i = 0; i < brickTone.length; i++) brickTone[i] = clamp01(0.3 + shard.id[i] * 0.5 + (mid[i] - 0.5) * 0.3);
  blendGradient(s, brickTone, LUT.brick, kind, 0.85);

  const dust = ctx.alloc();
  for (let i = 0; i < dust.length; i++) dust[i] = clamp01((1 - h[i] * 1.4) * (0.45 + broad[i] * 0.9));
  tintMask(s, [172, 166, 154], dust, 0.7);
  const soot = ctx.alloc();
  for (let i = 0; i < soot.length; i++) soot[i] = smoothstep(0.72, 0.9, broad[i]) * 0.55;
  tintMask(s, [46, 42, 38], soot, 1);

  for (let i = 0; i < s.rough.length; i++) s.rough[i] = clamp01(0.88 + (grit[i] - 0.5) * 0.14 - h[i] * 0.08);
  finishAO(s, { horizon: true, fine: size / 110, broad: size / 16, strength: 1.2 });
  return s;
}

/** Compacted earth with clods, pebbles, dry cracking and organic litter. */
function bakeDirt(ctx) {
  const size = ctx.size;
  const s = ctx.surface();
  const clod = ctx.cells('dirtA', Math.max(18, size / 24 | 0), 601, { jitter: 1 });
  const peb = ctx.cells('dirtB', Math.max(52, size / 9 | 0), 607, { jitter: 1 });
  const broad = ctx.noiseRef('broad', { start: 4, octaves: 7, gain: 0.55, seed: 11 });
  const mid = ctx.noiseRef('mid', { start: 24, octaves: 6, gain: 0.52, seed: 23 });
  const grit = ctx.noiseRef('grit', { start: 96, octaves: 4, gain: 0.5, seed: 37 });
  const cell = ctx.cells('dryCrack', 13, 613, { jitter: 1 });
  const edge = ctx.alloc();
  for (let i = 0; i < edge.length; i++) edge[i] = cell.f2[i] - cell.f1[i];
  const cracks = crackNetwork(size, edge, broad, { width: 0.045, softness: 0.08, breakThreshold: 0.40, depth: 1 });

  const h = s.h;
  const pebMask = ctx.alloc();
  for (let i = 0; i < h.length; i++) {
    const c = Math.pow(smoothstep(0.9, 0.05, clod.f1[i]), 0.7) * (0.4 + clod.id[i] * 0.6);
    const p = smoothstep(0.42, 0.0, peb.f1[i]) * (peb.id[i] > 0.55 ? 1 : 0);
    pebMask[i] = p;
    h[i] = clamp01(0.38 + c * 0.26 + p * 0.14 + (mid[i] - 0.5) * 0.16 + (grit[i] - 0.5) * 0.07 - cracks[i] * 0.24);
  }

  const tone = ctx.alloc();
  for (let i = 0; i < tone.length; i++) {
    tone[i] = clamp01(0.20 + broad[i] * 0.42 + (mid[i] - 0.5) * 0.32 + h[i] * 0.24 + (grit[i] - 0.5) * 0.12);
  }
  applyGradient(s, tone, LUT.dirt);
  const stoneTone = ctx.alloc();
  for (let i = 0; i < stoneTone.length; i++) stoneTone[i] = clamp01(0.4 + peb.id[i] * 0.5);
  blendGradient(s, stoneTone, LUT.gravel, pebMask, 0.8);
  tintMask(s, [32, 26, 19], cracks, 0.6);
  // dry dust on the high points
  const dry = ctx.alloc();
  for (let i = 0; i < dry.length; i++) dry[i] = clamp01((h[i] - 0.45) * 2.2) * (0.4 + grit[i] * 0.8) * 0.6;
  tintMask(s, [150, 130, 100], dry, 1);

  for (let i = 0; i < s.rough.length; i++) s.rough[i] = clamp01(0.90 + (grit[i] - 0.5) * 0.12 - pebMask[i] * 0.18);
  finishAO(s, { horizon: true, broad: size / 18 });
  return s;
}

/** Wind-rippled sand with grain sparkle and shell fragments. */
function bakeSand(ctx) {
  const size = ctx.size;
  const s = ctx.surface();
  const warpA = ctx.noiseRef('warpA', { start: 8, octaves: 5, gain: 0.6, seed: 71 });
  const warpB = ctx.noiseRef('warpB', { start: 8, octaves: 5, gain: 0.6, seed: 73 });
  const broad = ctx.noiseRef('broad', { start: 4, octaves: 7, gain: 0.55, seed: 11 });
  const grain = ctx.noiseRef('grainHi', { start: 128, octaves: 3, gain: 0.5, seed: 701 });
  const mid = ctx.noiseRef('mid', { start: 24, octaves: 6, gain: 0.52, seed: 23 });

  // ripples: a sine bank whose phase is domain-warped by low-frequency noise
  const ripple = ctx.alloc();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = y * size + x;
      const u = x / size, v = y / size;
      const phase = (u * 0.32 + v * 1.0) * 15 + (warpA[o] - 0.5) * 1.15 + (warpB[o] - 0.5) * 0.4;
      const t = phase - Math.floor(phase);
      // asymmetric ripple profile: gentle windward, steep lee slope
      const prof = t < 0.72 ? Math.pow(t / 0.72, 1.6) : 1 - (t - 0.72) / 0.28;
      ripple[o] = clamp01(prof);
    }
  }

  const h = s.h;
  for (let i = 0; i < h.length; i++) {
    h[i] = clamp01(0.32 + ripple[i] * 0.30 * (0.45 + broad[i] * 1.0)
      + (mid[i] - 0.5) * 0.16 + (grain[i] - 0.5) * 0.055);
  }

  const tone = ctx.alloc();
  for (let i = 0; i < tone.length; i++) {
    tone[i] = clamp01(0.20 + h[i] * 0.44 + broad[i] * 0.30 + (grain[i] - 0.5) * 0.24 + (mid[i] - 0.5) * 0.22);
  }
  applyGradient(s, tone, LUT.sand);
  // darker damp sand in the ripple troughs
  const damp = ctx.alloc();
  for (let i = 0; i < damp.length; i++) damp[i] = clamp01((0.45 - h[i]) * 2.4) * smoothstep(0.3, 0.7, broad[i]) * 0.5;
  tintMask(s, [128, 104, 72], damp, 1);
  // shell / quartz flecks
  const fleck = ctx.alloc();
  for (let i = 0; i < fleck.length; i++) fleck[i] = smoothstep(0.90, 0.99, grain[i]) * 0.8;
  tintMask(s, [244, 238, 224], fleck, 1);

  for (let i = 0; i < s.rough.length; i++) {
    s.rough[i] = clamp01(0.90 + (grain[i] - 0.5) * 0.10 - fleck[i] * 0.35 + damp[i] * 0.04);
  }
  finishAO(s, { horizon: true, fine: size / 160, broad: size / 22, strength: 0.8 });
  return s;
}

/* ---------------------------- metals ------------------------------ */

/** Bare hot-rolled steel: mill scale, brushed passes, light pitting. */
function bakeMetal(ctx) {
  const size = ctx.size;
  const s = ctx.surface();
  const mid = ctx.noiseRef('mid', { start: 24, octaves: 6, gain: 0.52, seed: 23 });
  const fine = ctx.noiseRef('fine', { start: 64, octaves: 5, gain: 0.5, seed: 53 });
  const brush = scratches(size, { count: size * 0.9 | 0, angle: 0.06, spread: 0.05, lengthMin: 0.4, lengthMax: 1.0, width: 1.1, seed: 811 });
  const nicks = scratches(size, { count: 90, angle: 1.1, spread: 1.4, lengthMin: 0.02, lengthMax: 0.14, width: 1.6, seed: 823 });
  const pits = pitting(size, { count: size * 1.1 | 0, rMin: 0.5, rMax: size / 300, depth: 1, seed: 829 });

  const h = s.h;
  for (let i = 0; i < h.length; i++) {
    h[i] = clamp01(0.55 + (mid[i] - 0.5) * 0.06 + (fine[i] - 0.5) * 0.03
      + brush[i] * 0.035 - nicks[i] * 0.06 - pits[i] * 0.10);
  }

  const tone = ctx.alloc();
  for (let i = 0; i < tone.length; i++) {
    tone[i] = clamp01(0.42 + (mid[i] - 0.5) * 0.5 + (fine[i] - 0.5) * 0.3 + brush[i] * 0.25 - pits[i] * 0.4);
  }
  applyGradient(s, tone, LUT.steel);

  // mill-scale bloom: darker blue-grey oxide islands
  const scale = ctx.alloc();
  for (let i = 0; i < scale.length; i++) scale[i] = smoothstep(0.30, 0.62, mid[i]) * 0.7;
  tintMask(s, [56, 58, 66], scale, 1);

  for (let i = 0; i < s.rough.length; i++) {
    s.rough[i] = clamp01(0.40 + scale[i] * 0.34 + (fine[i] - 0.5) * 0.20 - brush[i] * 0.22 + pits[i] * 0.35);
  }
  for (let i = 0; i < s.metal.length; i++) s.metal[i] = clamp01(1 - pits[i] * 0.5 - scale[i] * 0.18);
  finishAO(s, { horizon: false, fine: size / 220, broad: size / 40, strength: 0.7 });
  return s;
}

/** Painted, riveted sheet steel with paint failing at every edge. */
function bakeMetalPainted(ctx) {
  const size = ctx.size;
  const s = ctx.surface();
  const pn = panelSeams(size, { rows: 3, cols: 2, seam: 0.005, bevel: 0.008, rivets: 8, rivetR: 0.0075, rivetInset: 0.022, seed: 59 });
  const mid = ctx.noiseRef('mid', { start: 24, octaves: 6, gain: 0.52, seed: 23 });
  const fine = ctx.noiseRef('fine', { start: 64, octaves: 5, gain: 0.5, seed: 53 });
  const grit = ctx.noiseRef('grit', { start: 96, octaves: 4, gain: 0.5, seed: 37 });
  const broad = ctx.noiseRef('broad', { start: 4, octaves: 7, gain: 0.55, seed: 11 });
  const nicks = scratches(size, { count: 200, angle: 0.9, spread: 1.6, lengthMin: 0.02, lengthMax: 0.22, width: 1.3, seed: 907 });
  const dents = ctx.cells('dents', 9, 911, { jitter: 1 });

  const h = s.h;
  for (let i = 0; i < h.length; i++) {
    const dent = smoothstep(0.55, 0.0, dents.f1[i]) * (dents.id[i] > 0.72 ? 1 : 0) * 0.09;
    h[i] = clamp01(pn.h[i] + (mid[i] - 0.5) * 0.035 + (grit[i] - 0.5) * 0.02 - nicks[i] * 0.045 - dent);
  }

  // chipping mask: edges + rivet rims + noise
  const curve = curvatureFromHeight(s.h, size, Math.max(1, size / 220));
  const chip = ctx.alloc();
  for (let i = 0; i < chip.length; i++) {
    const exposure = clamp01(pn.edge[i] * 0.8 + pn.rivet[i] * 0.7 + (curve[i] - 0.5) * 1.4 + nicks[i] * 0.9);
    chip[i] = clamp01(smoothstep(0.42, 0.78, exposure * (0.55 + fine[i] * 0.9)) * 1.2);
  }
  const primer = ctx.alloc();
  for (let i = 0; i < primer.length; i++) primer[i] = clamp01(chip[i] * 1.5) * (1 - clamp01(chip[i] * 2.2 - 0.9));

  const paintTone = ctx.alloc();
  for (let i = 0; i < paintTone.length; i++) {
    paintTone[i] = clamp01(0.30 + pn.id[i] * 0.28 + (mid[i] - 0.5) * 0.30 + (broad[i] - 0.5) * 0.22 + pn.rivet[i] * 0.12);
  }
  applyGradient(s, paintTone, LUT.paint);
  tintMask(s, [132, 78, 48], primer, 0.75);           // red-oxide primer coat
  const steelTone = ctx.alloc();
  for (let i = 0; i < steelTone.length; i++) steelTone[i] = clamp01(0.35 + (fine[i] - 0.5) * 0.5);
  blendGradient(s, steelTone, LUT.steel, chip, 0.9);

  // rust weeping down from the chips and rivets
  const rustSeed = ctx.alloc();
  for (let i = 0; i < rustSeed.length; i++) rustSeed[i] = chip[i] * smoothstep(0.42, 0.75, broad[i]);
  const rustRun = streakDown(rustSeed, size, size / 6, 0.970);
  const rustTone = ctx.alloc();
  for (let i = 0; i < rustTone.length; i++) rustTone[i] = clamp01(0.25 + fine[i] * 0.6);
  blendGradient(s, rustTone, LUT.rust, rustRun, 0.48);
  // grime in the seams
  tintMask(s, [42, 40, 36], pn.mask, 0.45);

  for (let i = 0; i < s.rough.length; i++) {
    s.rough[i] = clamp01(0.34 + (grit[i] - 0.5) * 0.10 + chip[i] * 0.30 + rustRun[i] * 0.42
      + pn.mask[i] * 0.20 + (broad[i] - 0.5) * 0.10);
  }
  for (let i = 0; i < s.metal.length; i++) {
    s.metal[i] = clamp01(chip[i] * 0.95 - rustRun[i] * 0.8 - primer[i] * 0.5);
  }
  s.cavity = chip;
  finishAO(s, { horizon: true, fine: size / 200, broad: size / 30, strength: 0.85 });
  return s;
}

/** Deep, scabby rust — flaking laminae over pitted steel. */
function bakeMetalRusted(ctx) {
  const size = ctx.size;
  const s = ctx.surface();
  const scabA = ctx.cells('rustA', Math.max(14, size / 30 | 0), 1009, { jitter: 1 });
  const scabB = ctx.cells('rustB', Math.max(38, size / 12 | 0), 1013, { jitter: 1 });
  const broad = ctx.noiseRef('broad', { start: 4, octaves: 7, gain: 0.55, seed: 11 });
  const mid = ctx.noiseRef('mid', { start: 24, octaves: 6, gain: 0.52, seed: 23 });
  const fine = ctx.noiseRef('fine', { start: 64, octaves: 5, gain: 0.5, seed: 53 });
  const grit = ctx.noiseRef('grit', { start: 96, octaves: 4, gain: 0.5, seed: 37 });
  const pits = pitting(size, { count: size * 3.5 | 0, rMin: 0.6, rMax: size / 160, depth: 1, seed: 1019 });

  const rustAmt = ctx.alloc();
  for (let i = 0; i < rustAmt.length; i++) {
    rustAmt[i] = clamp01(smoothstep(0.24, 0.66, broad[i]) * 0.75 + smoothstep(0.4, 0.8, mid[i]) * 0.5);
  }

  const h = s.h;
  for (let i = 0; i < h.length; i++) {
    // flakes: worley plateaus stacked, then bitten by pitting
    const flakeA = smoothstep(0.72, 0.05, scabA.f1[i]) * (0.4 + scabA.id[i] * 0.6);
    const flakeB = smoothstep(0.66, 0.08, scabB.f1[i]) * (0.35 + scabB.id[i] * 0.65);
    const lam = (flakeA * 0.55 + flakeB * 0.35) * rustAmt[i];
    h[i] = clamp01(0.5 + lam * 0.34 + (grit[i] - 0.5) * 0.08 - pits[i] * 0.26 * (1 - rustAmt[i] * 0.4));
  }

  const steelTone = ctx.alloc();
  for (let i = 0; i < steelTone.length; i++) steelTone[i] = clamp01(0.22 + (fine[i] - 0.5) * 0.5 - pits[i] * 0.35);
  applyGradient(s, steelTone, LUT.steel);
  const rustTone = ctx.alloc();
  for (let i = 0; i < rustTone.length; i++) {
    rustTone[i] = clamp01(0.16 + scabA.id[i] * 0.22 + scabB.id[i] * 0.16 + (mid[i] - 0.5) * 0.5
      + (fine[i] - 0.5) * 0.34 + (grit[i] - 0.5) * 0.26 + h[i] * 0.28);
  }
  blendGradient(s, rustTone, LUT.rust, rustAmt, 1);

  const runSeed = ctx.alloc();
  for (let i = 0; i < runSeed.length; i++) runSeed[i] = rustAmt[i] * smoothstep(0.6, 0.85, mid[i]);
  const run = streakDown(runSeed, size, size / 5, 0.974);
  blendGradient(s, rustTone, LUT.rust, run, 0.5);
  // black scale in the deepest pits
  tintMask(s, [38, 30, 25], pits, 0.32);

  for (let i = 0; i < s.rough.length; i++) {
    s.rough[i] = clamp01(0.34 + rustAmt[i] * 0.55 + (grit[i] - 0.5) * 0.16 + pits[i] * 0.25 + run[i] * 0.12);
  }
  for (let i = 0; i < s.metal.length; i++) s.metal[i] = clamp01(1 - rustAmt[i] * 0.95 - pits[i] * 0.4);
  s.cavity = rustAmt;
  finishAO(s, { horizon: true, fine: size / 140, broad: size / 24 });
  return s;
}

/** Corrugated galvanised sheet — every shanty town and depot roof. */
function bakeMetalCorrugated(ctx) {
  const size = ctx.size;
  const s = ctx.surface();
  const cg = corrugation(size, { ribs: 8, flat: 0.3, shoulder: 0.13, seed: 71 });
  const broad = ctx.noiseRef('broad', { start: 4, octaves: 7, gain: 0.55, seed: 11 });
  const mid = ctx.noiseRef('mid', { start: 24, octaves: 6, gain: 0.52, seed: 23 });
  const fine = ctx.noiseRef('fine', { start: 64, octaves: 5, gain: 0.5, seed: 53 });
  const grit = ctx.noiseRef('grit', { start: 96, octaves: 4, gain: 0.5, seed: 37 });
  const streaksV = scratches(size, { count: 140, angle: Math.PI / 2, spread: 0.06, lengthMin: 0.3, lengthMax: 0.9, width: 1.4, seed: 1103 });
  const dings = pitting(size, { count: 220, rMin: size / 220, rMax: size / 90, depth: 1, seed: 1109 });

  const h = s.h;
  for (let i = 0; i < h.length; i++) {
    h[i] = clamp01(cg.h[i] + (mid[i] - 0.5) * 0.035 + (grit[i] - 0.5) * 0.018 - dings[i] * 0.10 - streaksV[i] * 0.012);
  }

  // galvanised spangle: large crystalline facets
  const spangle = ctx.cells('spangle', Math.max(20, size / 22 | 0), 1117, { jitter: 1 });
  const tone = ctx.alloc();
  for (let i = 0; i < tone.length; i++) {
    tone[i] = clamp01(0.34 + spangle.id[i] * 0.22 + (fine[i] - 0.5) * 0.20 + cg.crest[i] * 0.12 + (mid[i] - 0.5) * 0.16);
  }
  applyGradient(s, tone, LUT.steel);

  const rustAmt = ctx.alloc();
  for (let i = 0; i < rustAmt.length; i++) {
    // rust starts in the valleys where water sits, and around the dings
    rustAmt[i] = clamp01((1 - cg.crest[i]) * smoothstep(0.42, 0.78, broad[i]) * 1.1 + dings[i] * 0.8 * smoothstep(0.3, 0.7, mid[i]));
  }
  const runSeed = ctx.alloc();
  for (let i = 0; i < runSeed.length; i++) runSeed[i] = rustAmt[i] * 0.9;
  const run = streakDown(runSeed, size, size / 4, 0.978);
  const rustTone = ctx.alloc();
  for (let i = 0; i < rustTone.length; i++) rustTone[i] = clamp01(0.25 + (mid[i] - 0.5) * 0.45 + (grit[i] - 0.5) * 0.2);
  blendGradient(s, rustTone, LUT.rust, rustAmt, 0.95);
  blendGradient(s, rustTone, LUT.rust, run, 0.45);

  for (let i = 0; i < s.rough.length; i++) {
    s.rough[i] = clamp01(0.52 + rustAmt[i] * 0.38 + run[i] * 0.16 + (fine[i] - 0.5) * 0.14 - cg.crest[i] * 0.05);
  }
  for (let i = 0; i < s.metal.length; i++) s.metal[i] = clamp01(1 - rustAmt[i] * 0.9 - run[i] * 0.4);
  finishAO(s, { horizon: true, broad: size / 12, strength: 0.9 });
  return s;
}

/** Parkerised / bead-blasted gun metal. Doubles as the brass base via tint. */
function bakeGunMetal(ctx) {
  const size = ctx.size;
  const s = ctx.surface();
  const stipple = ctx.noiseRef('stippleHi', { start: 192, octaves: 3, gain: 0.5, seed: 1201 });
  const fine = ctx.noiseRef('fine', { start: 64, octaves: 5, gain: 0.5, seed: 53 });
  const mid = ctx.noiseRef('mid', { start: 24, octaves: 6, gain: 0.52, seed: 23 });
  const machining = scratches(size, { count: size * 0.6 | 0, angle: 0, spread: 0.02, lengthMin: 0.5, lengthMax: 1.0, width: 0.9, seed: 1213 });
  const handling = scratches(size, { count: 70, angle: 0.4, spread: 2.0, lengthMin: 0.03, lengthMax: 0.18, width: 1.2, seed: 1217 });

  const h = s.h;
  for (let i = 0; i < h.length; i++) {
    h[i] = clamp01(0.52 + (stipple[i] - 0.5) * 0.10 + machining[i] * 0.02 - handling[i] * 0.05 + (fine[i] - 0.5) * 0.02);
  }

  const tone = ctx.alloc();
  for (let i = 0; i < tone.length; i++) {
    tone[i] = clamp01(0.34 + (stipple[i] - 0.5) * 0.30 + (mid[i] - 0.5) * 0.22 + handling[i] * 0.55 + machining[i] * 0.10);
  }
  applyGradient(s, tone, LUT.gunmetal);

  // holster wear: polished bright metal on the high points
  const wear = ctx.alloc();
  for (let i = 0; i < wear.length; i++) wear[i] = clamp01(handling[i] * 1.2 + smoothstep(0.72, 0.9, mid[i]) * 0.5);
  tintMask(s, [186, 190, 198], wear, 0.7);

  for (let i = 0; i < s.rough.length; i++) {
    s.rough[i] = clamp01(0.46 + (stipple[i] - 0.5) * 0.28 + (fine[i] - 0.5) * 0.10 - wear[i] * 0.32 - machining[i] * 0.10);
  }
  s.metal.fill(1);
  for (let i = 0; i < s.metal.length; i++) s.metal[i] = clamp01(0.92 + wear[i] * 0.08);
  finishAO(s, { horizon: false, fine: size / 240, broad: size / 60, strength: 0.5 });
  return s;
}

/** Stippled, weathered polymer: gun furniture, crates, radios. */
function bakePolymer(ctx) {
  const size = ctx.size;
  const s = ctx.surface();
  const stipMask = ctx.cells('stip', Math.max(80, size / 5 | 0), 1301, { jitter: 0.6 });
  const mid = ctx.noiseRef('mid', { start: 24, octaves: 6, gain: 0.52, seed: 23 });
  const fine = ctx.noiseRef('fine', { start: 64, octaves: 5, gain: 0.5, seed: 53 });
  const broad = ctx.noiseRef('broad', { start: 4, octaves: 7, gain: 0.55, seed: 11 });
  const scuff = scratches(size, { count: 150, angle: 0.2, spread: 2.4, lengthMin: 0.02, lengthMax: 0.20, width: 1.5, seed: 1307 });

  const h = s.h;
  for (let i = 0; i < h.length; i++) {
    const pyramid = Math.pow(smoothstep(0.9, 0.1, stipMask.f1[i]), 1.4);
    h[i] = clamp01(0.34 + pyramid * 0.42 + (fine[i] - 0.5) * 0.04 - scuff[i] * 0.05);
  }

  const tone = ctx.alloc();
  for (let i = 0; i < tone.length; i++) {
    tone[i] = clamp01(0.32 + h[i] * 0.34 + (mid[i] - 0.5) * 0.24 + (broad[i] - 0.5) * 0.18 + scuff[i] * 0.5);
  }
  applyGradient(s, tone, LUT.polymer);
  // UV-faded, chalky high points
  const faded = ctx.alloc();
  for (let i = 0; i < faded.length; i++) faded[i] = clamp01((h[i] - 0.55) * 2.2) * smoothstep(0.4, 0.8, broad[i]) * 0.5;
  tintMask(s, [104, 106, 100], faded, 1);

  for (let i = 0; i < s.rough.length; i++) {
    s.rough[i] = clamp01(0.58 + (fine[i] - 0.5) * 0.14 + faded[i] * 0.24 - scuff[i] * 0.20 - h[i] * 0.06);
  }
  s.metal.fill(0);
  finishAO(s, { horizon: false, fine: size / 200, broad: size / 50, strength: 0.7 });
  return s;
}

/* ---------------------------- organics ---------------------------- */

/** Sawn softwood planks: grain, knots, splits and weather-greyed edges. */
function bakeWood(ctx) {
  const size = ctx.size;
  const s = ctx.surface();
  const pk = plankRows(size, { rows: 5, perRow: 2, gap: 0.0032, bevel: 0.004, cup: 0.07, seed: 41 });
  const warpA = ctx.noiseRef('warpA', { start: 8, octaves: 5, gain: 0.6, seed: 71 });
  const warpB = ctx.noiseRef('warpB', { start: 8, octaves: 5, gain: 0.6, seed: 73 });
  const fine = ctx.noiseRef('fine', { start: 64, octaves: 5, gain: 0.5, seed: 53 });
  const mid = ctx.noiseRef('mid', { start: 24, octaves: 6, gain: 0.52, seed: 23 });
  const broad = ctx.noiseRef('broad', { start: 4, octaves: 7, gain: 0.55, seed: 11 });

  // knots: a handful of radial distortion centres per tile
  const rng = mulberry32(1409);
  const KN = 7;
  const kx = new Float32Array(KN), ky = new Float32Array(KN), kr = new Float32Array(KN);
  for (let i = 0; i < KN; i++) { kx[i] = rng(); ky[i] = rng(); kr[i] = 0.018 + rng() * 0.030; }

  const grain = ctx.alloc();
  const knotMask = ctx.alloc();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = y * size + x;
      const u = x / size, v = y / size;
      // Growth rings run the length of the board, so the ring coordinate
      // varies across the plank width (v) and only wobbles slowly along it.
      let warpU = v * 58 + (warpA[o] - 0.5) * 2.2 + (warpB[o] - 0.5) * 0.8 + pk.id[o] * 13.7;
      let knotPull = 0;
      let knotCore = 0;
      for (let k = 0; k < KN; k++) {
        let dx = u - kx[k]; dx -= Math.round(dx);
        let dy = (v - ky[k]) * 1.0; dy -= Math.round(dy);
        const d2 = dx * dx + dy * dy;
        const reach = kr[k] * 6;
        if (d2 >= reach * reach) continue;
        const d = Math.sqrt(d2);
        {
          const q = d / (kr[k] * 2.4);
          const infl = Math.exp(-(q * q));
          knotPull += infl * 2.6 * Math.sign(dy || 1);
          knotCore = Math.max(knotCore, 1 - smoothstep(kr[k] * 0.5, kr[k] * 1.5, d));
        }
      }
      warpU += knotPull;
      const ring = Math.abs(Math.sin(warpU * Math.PI));
      grain[o] = clamp01(Math.pow(ring, 0.75) * 0.9 + (fine[o] - 0.5) * 0.14);
      knotMask[o] = knotCore;
    }
  }

  // splits along the grain at plank ends
  const splits = scratches(size, { count: 70, angle: 0, spread: 0.05, lengthMin: 0.06, lengthMax: 0.42, width: 0.8, seed: 1423 });

  const h = s.h;
  for (let i = 0; i < h.length; i++) {
    const face = 1 - pk.mask[i];
    // late wood stands proud of early wood on weathered timber
    const relief = (grain[i] - 0.5) * 0.13 + knotMask[i] * 0.06;
    h[i] = clamp01(pk.h[i] + (relief + (fine[i] - 0.5) * 0.03) * face - splits[i] * 0.14 * face);
  }

  const tone = ctx.alloc();
  for (let i = 0; i < tone.length; i++) {
    tone[i] = clamp01(0.18 + grain[i] * 0.52 + pk.id[i] * 0.26 + (mid[i] - 0.5) * 0.16 - knotMask[i] * 0.55);
  }
  applyGradient(s, tone, LUT.wood);

  // silvered weathering, strongest at exposed edges and the top of each plank
  const weather = ctx.alloc();
  for (let i = 0; i < weather.length; i++) {
    weather[i] = clamp01(smoothstep(0.34, 0.78, broad[i]) * 0.95 + pk.edge[i] * 0.6 + (1 - pk.along[i]) * 0.2);
  }
  const greyTone = ctx.alloc();
  for (let i = 0; i < greyTone.length; i++) greyTone[i] = clamp01(0.25 + grain[i] * 0.55 + (fine[i] - 0.5) * 0.3);
  blendGradient(s, greyTone, LUT.woodGrey, weather, 0.78);
  tintMask(s, [46, 36, 27], pk.mask, 0.62);
  tintMask(s, [42, 30, 20], splits, 0.55);

  for (let i = 0; i < s.rough.length; i++) {
    s.rough[i] = clamp01(0.68 + (grain[i] - 0.5) * 0.20 + weather[i] * 0.20 + pk.mask[i] * 0.12 + knotMask[i] * -0.12);
  }
  s.metal.fill(0);
  finishAO(s, { horizon: true, fine: size / 180, broad: size / 26 });
  return s;
}

/** Beaten-up corrugated cardboard, torn to show the fluting. */
function bakeCardboard(ctx) {
  const size = ctx.size;
  const s = ctx.surface();
  const flute = corrugation(size, { ribs: 26, flat: 0.4, shoulder: 0.3, seed: 1511 });
  const fine = ctx.noiseRef('fine', { start: 64, octaves: 5, gain: 0.5, seed: 53 });
  const mid = ctx.noiseRef('mid', { start: 24, octaves: 6, gain: 0.52, seed: 23 });
  const broad = ctx.noiseRef('broad', { start: 4, octaves: 7, gain: 0.55, seed: 11 });
  const fibres = ctx.noiseRef('fibreHi', { start: 160, octaves: 3, gain: 0.5, seed: 1523 });
  const creases = scratches(size, { count: 26, angle: 0.6, spread: 2.6, lengthMin: 0.2, lengthMax: 0.8, width: 2.2, seed: 1531 });

  // torn regions where the liner is gone and the flutes show
  const torn = ctx.alloc();
  for (let i = 0; i < torn.length; i++) torn[i] = smoothstep(0.74, 0.84, broad[i]);

  const h = s.h;
  for (let i = 0; i < h.length; i++) {
    const liner = 0.62 + (fibres[i] - 0.5) * 0.05 + (mid[i] - 0.5) * 0.04;
    const core = 0.30 + flute.h[i] * 0.30;
    h[i] = clamp01(liner + (core - liner) * torn[i] - creases[i] * 0.08);
  }

  const tone = ctx.alloc();
  for (let i = 0; i < tone.length; i++) {
    tone[i] = clamp01(0.34 + (mid[i] - 0.5) * 0.34 + (fibres[i] - 0.5) * 0.28 + broad[i] * 0.20 - torn[i] * 0.24);
  }
  applyGradient(s, tone, LUT.cardboard);
  // water stains and printed ink smudges
  const stain = ctx.alloc();
  for (let i = 0; i < stain.length; i++) stain[i] = smoothstep(0.52, 0.74, mid[i]) * 0.55;
  tintMask(s, [104, 78, 48], stain, 1);
  const ink = ctx.alloc();
  for (let i = 0; i < ink.length; i++) ink[i] = smoothstep(0.80, 0.92, fine[i]) * 0.4 * (1 - torn[i]);
  tintMask(s, [44, 42, 46], ink, 1);
  tintMask(s, [188, 172, 148], creases, 0.35);

  for (let i = 0; i < s.rough.length; i++) {
    s.rough[i] = clamp01(0.90 + (fibres[i] - 0.5) * 0.12 - creases[i] * 0.06 + torn[i] * 0.05);
  }
  finishAO(s, { horizon: false, fine: size / 160, broad: size / 30 });
  return s;
}

/** Heavy cotton duck / canvas — tarps, webbing, tent walls. */
function bakeFabric(ctx) {
  const size = ctx.size;
  const s = ctx.surface();
  const wv = weave(size, { threads: Math.max(28, size / 12 | 0), twill: 0, gap: 0.14, round: 1.7, seed: 101 });
  const fuzz = ctx.noiseRef('fuzzHi', { start: 176, octaves: 3, gain: 0.5, seed: 1601 });
  const mid = ctx.noiseRef('mid', { start: 24, octaves: 6, gain: 0.52, seed: 23 });
  const broad = ctx.noiseRef('broad', { start: 4, octaves: 7, gain: 0.55, seed: 11 });
  const folds = ctx.noiseRef('folds', { start: 6, octaves: 5, gain: 0.62, seed: 1607 });

  const h = s.h;
  for (let i = 0; i < h.length; i++) {
    h[i] = clamp01(wv.h[i] * 0.86 + (folds[i] - 0.5) * 0.14 + (fuzz[i] - 0.5) * 0.05);
  }

  const tone = ctx.alloc();
  for (let i = 0; i < tone.length; i++) {
    tone[i] = clamp01(0.30 + wv.h[i] * 0.36 + (mid[i] - 0.5) * 0.28 + broad[i] * 0.20 + (fuzz[i] - 0.5) * 0.14);
  }
  applyGradient(s, tone, LUT.canvas);
  const grime = ctx.alloc();
  for (let i = 0; i < grime.length; i++) grime[i] = clamp01((1 - wv.h[i]) * 0.5 + smoothstep(0.55, 0.85, mid[i]) * 0.55);
  tintMask(s, [70, 62, 48], grime, 0.5);

  for (let i = 0; i < s.rough.length; i++) {
    s.rough[i] = clamp01(0.90 + (fuzz[i] - 0.5) * 0.10 - wv.h[i] * 0.10 + grime[i] * 0.05);
  }
  finishAO(s, { horizon: false, fine: size / 220, broad: size / 40, strength: 1.1 });
  return s;
}

/** Multicam-style printed camouflage over a twill weave. */
function bakeCamo(ctx) {
  const size = ctx.size;
  const s = bakeFabric(ctx);
  const warpA = ctx.noiseRef('warpA', { start: 8, octaves: 5, gain: 0.6, seed: 71 });
  const warpB = ctx.noiseRef('warpB', { start: 8, octaves: 5, gain: 0.6, seed: 73 });
  const blobBase = ctx.noiseRef('camoBase', { start: 5, octaves: 5, gain: 0.58, seed: 1709 });
  const blobMid = ctx.noiseRef('camoMid', { start: 11, octaves: 5, gain: 0.55, seed: 1721 });
  const blobFine = ctx.noiseRef('camoFine', { start: 23, octaves: 4, gain: 0.5, seed: 1723 });

  const warped = warpField(blobBase, size, warpA, warpB, size * 0.045);
  const warped2 = warpField(blobMid, size, warpB, warpA, size * 0.030);

  const COL = [
    [124, 118, 86],   // pale khaki base
    [96, 96, 66],     // olive
    [72, 66, 48],     // dark drab
    [148, 132, 96],   // sand highlight
    [52, 46, 36],     // near-black accents
  ];
  const { r, g, b } = s;
  for (let i = 0; i < r.length; i++) {
    const a = warped[i];
    const bb = warped2[i];
    const c = blobFine[i];
    let col = COL[0];
    if (a > 0.58) col = COL[1];
    if (a > 0.72) col = COL[2];
    if (bb > 0.70 && a < 0.62) col = COL[3];
    if (c > 0.82 && a > 0.5) col = COL[4];
    // the weave and grime already in the surface modulate the printed ink
    const shade = 0.62 + s.h[i] * 0.55;
    const kr = (col[0] / 255) * shade;
    const kg = (col[1] / 255) * shade;
    const kb = (col[2] / 255) * shade;
    // ink sits on the thread crowns and misses the interstices
    const ink = clamp01(0.55 + s.h[i] * 0.75);
    r[i] += (kr - r[i]) * ink;
    g[i] += (kg - g[i]) * ink;
    b[i] += (kb - b[i]) * ink;
  }
  // dusting of dirt on top of the print
  const grime = ctx.alloc();
  for (let i = 0; i < grime.length; i++) grime[i] = clamp01((1 - s.h[i]) * 0.55 + smoothstep(0.6, 0.9, blobFine[i]) * 0.3);
  tintMask(s, [86, 78, 62], grime, 0.35);
  return s;
}

/** Hessian sandbag: coarse jute weave, stitched seam, sand dust, sun bleach. */
function bakeSandbag(ctx) {
  const size = ctx.size;
  const s = ctx.surface();
  const wv = weave(size, { threads: Math.max(16, size / 26 | 0), twill: 0, gap: 0.28, round: 1.3, seed: 1801 });
  const st = stitchRows(size, { rows: 2, stitches: Math.max(20, size / 22 | 0), thread: 0.4, depth: 0.12, seed: 1811 });
  const fuzz = ctx.noiseRef('fuzzHi', { start: 176, octaves: 3, gain: 0.5, seed: 1601 });
  const mid = ctx.noiseRef('mid', { start: 24, octaves: 6, gain: 0.52, seed: 23 });
  const broad = ctx.noiseRef('broad', { start: 4, octaves: 7, gain: 0.55, seed: 11 });
  const bulge = ctx.noiseRef('bulge', { start: 5, octaves: 4, gain: 0.6, seed: 1823 });

  const h = s.h;
  for (let i = 0; i < h.length; i++) {
    h[i] = clamp01(wv.h[i] * 0.72 + (bulge[i] - 0.5) * 0.26 + st.h[i] + (fuzz[i] - 0.5) * 0.06);
  }

  const tone = ctx.alloc();
  for (let i = 0; i < tone.length; i++) {
    tone[i] = clamp01(0.26 + wv.h[i] * 0.34 + broad[i] * 0.30 + (mid[i] - 0.5) * 0.24 + (fuzz[i] - 0.5) * 0.16);
  }
  applyGradient(s, tone, LUT.canvas);
  // sand packed into the weave and dusted over the crowns
  const sandDust = ctx.alloc();
  for (let i = 0; i < sandDust.length; i++) sandDust[i] = clamp01((1 - wv.h[i]) * 0.7 + smoothstep(0.45, 0.8, broad[i]) * 0.55);
  tintMask(s, [186, 162, 120], sandDust, 0.6);
  // sun-bleached tops
  const bleach = ctx.alloc();
  for (let i = 0; i < bleach.length; i++) bleach[i] = clamp01((bulge[i] - 0.55) * 2.4) * 0.5;
  tintMask(s, [196, 182, 150], bleach, 1);
  tintMask(s, [60, 52, 38], st.mask, 0.3);

  for (let i = 0; i < s.rough.length; i++) {
    s.rough[i] = clamp01(0.92 + (fuzz[i] - 0.5) * 0.10 - wv.h[i] * 0.06);
  }
  finishAO(s, { horizon: true, fine: size / 150, broad: size / 26, strength: 1.15 });
  return s;
}

/** Human skin for the enemy models: pores, creases, capillary variation. */
function bakeFlesh(ctx) {
  const size = ctx.size;
  const s = ctx.surface();
  const pores = ctx.cells('pores', Math.max(64, size / 7 | 0), 1901, { jitter: 1 });
  const fine = ctx.noiseRef('fine', { start: 64, octaves: 5, gain: 0.5, seed: 53 });
  const mid = ctx.noiseRef('mid', { start: 24, octaves: 6, gain: 0.52, seed: 23 });
  const broad = ctx.noiseRef('broad', { start: 4, octaves: 7, gain: 0.55, seed: 11 });
  const warpA = ctx.noiseRef('warpA', { start: 8, octaves: 5, gain: 0.6, seed: 71 });
  const creases = ctx.alloc();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = y * size + x;
      const v = Math.sin((x / size * 7.3 + y / size * 3.1 + warpA[o] * 5.2) * Math.PI * 2);
      creases[o] = clamp01(0.5 + v * 0.5);
    }
  }

  const h = s.h;
  for (let i = 0; i < h.length; i++) {
    const pore = smoothstep(0.34, 0.0, pores.f1[i]) * (pores.id[i] > 0.35 ? 1 : 0);
    h[i] = clamp01(0.58 - pore * 0.14 + (creases[i] - 0.5) * 0.10 + (fine[i] - 0.5) * 0.05);
  }

  const tone = ctx.alloc();
  for (let i = 0; i < tone.length; i++) {
    tone[i] = clamp01(0.42 + broad[i] * 0.30 + (mid[i] - 0.5) * 0.26 + (fine[i] - 0.5) * 0.14 + h[i] * 0.18);
  }
  applyGradient(s, tone, LUT.flesh);
  // capillary flush and stubble shadow
  const flush = ctx.alloc();
  for (let i = 0; i < flush.length; i++) flush[i] = smoothstep(0.55, 0.85, mid[i]) * 0.45;
  tintMask(s, [186, 92, 76], flush, 1);
  const shadowT = ctx.alloc();
  for (let i = 0; i < shadowT.length; i++) shadowT[i] = smoothstep(0.62, 0.9, broad[i]) * 0.4;
  tintMask(s, [96, 74, 66], shadowT, 1);

  for (let i = 0; i < s.rough.length; i++) {
    s.rough[i] = clamp01(0.52 + (fine[i] - 0.5) * 0.16 + (creases[i] - 0.5) * 0.10 - flush[i] * 0.08);
  }
  finishAO(s, { horizon: false, fine: size / 240, broad: size / 50, strength: 0.6 });
  return s;
}

/** Alpha-cut foliage card: a cluster of lanceolate leaves. */
function bakeFoliage(ctx) {
  const size = ctx.size;
  const s = ctx.surface();
  const lc = leafCluster(size, { count: Math.max(30, size / 11 | 0), lenMin: 0.16, lenMax: 0.38, ratio: 0.30, seed: 163 });
  const mid = ctx.noiseRef('mid', { start: 24, octaves: 6, gain: 0.52, seed: 23 });
  const fine = ctx.noiseRef('fine', { start: 64, octaves: 5, gain: 0.5, seed: 53 });
  const broad = ctx.noiseRef('broad', { start: 4, octaves: 7, gain: 0.55, seed: 11 });

  const h = s.h;
  for (let i = 0; i < h.length; i++) h[i] = clamp01(0.35 + lc.height[i] * 0.6 + (fine[i] - 0.5) * 0.04);

  const tone = ctx.alloc();
  for (let i = 0; i < tone.length; i++) {
    tone[i] = clamp01(0.22 + lc.tint[i] * 0.46 + (mid[i] - 0.5) * 0.24 + broad[i] * 0.22 + lc.height[i] * 0.20);
  }
  applyGradient(s, tone, LUT.foliage);
  // dry, yellowed leaf tips
  const dry = ctx.alloc();
  for (let i = 0; i < dry.length; i++) dry[i] = smoothstep(0.66, 0.9, mid[i]) * 0.55;
  tintMask(s, [146, 128, 62], dry, 1);
  const dust = ctx.alloc();
  for (let i = 0; i < dust.length; i++) dust[i] = smoothstep(0.5, 0.85, broad[i]) * 0.3;
  tintMask(s, [148, 140, 118], dust, 1);

  for (let i = 0; i < s.rough.length; i++) s.rough[i] = clamp01(0.62 + (fine[i] - 0.5) * 0.18 + dry[i] * 0.2);
  s.metal.fill(0);

  // coverage: leaves only, with a slightly eroded edge so alphaTest looks soft
  const cov = ctx.alloc();
  for (let i = 0; i < cov.length; i++) cov[i] = clamp01(lc.cover[i] * (0.7 + lc.height[i] * 0.9));
  s.alpha = cov;
  finishAO(s, { horizon: false, fine: size / 220, broad: size / 40, strength: 0.5 });
  return s;
}

/** Dirty glazing: dust film, rain runs, wiper arcs, micro-scratches. */
function bakeGlass(ctx) {
  const size = ctx.size;
  const s = ctx.surface();
  const mid = ctx.noiseRef('mid', { start: 24, octaves: 6, gain: 0.52, seed: 23 });
  const fine = ctx.noiseRef('fine', { start: 64, octaves: 5, gain: 0.5, seed: 53 });
  const broad = ctx.noiseRef('broad', { start: 4, octaves: 7, gain: 0.55, seed: 11 });
  const scr = scratches(size, { count: 120, angle: 0.3, spread: 2.8, lengthMin: 0.05, lengthMax: 0.4, width: 0.8, seed: 2003 });

  const dustSeed = ctx.alloc();
  for (let i = 0; i < dustSeed.length; i++) dustSeed[i] = smoothstep(0.55, 0.9, broad[i]) * 0.8;
  const runs = streakDown(dustSeed, size, size / 3, 0.985);

  const h = s.h;
  for (let i = 0; i < h.length; i++) {
    h[i] = clamp01(0.5 + (mid[i] - 0.5) * 0.03 + scr[i] * 0.05 + runs[i] * 0.02);
  }
  const { r, g, b } = s;
  for (let i = 0; i < r.length; i++) {
    const dust = clamp01(runs[i] * 0.7 + smoothstep(0.6, 0.95, fine[i]) * 0.3);
    const v = 0.72 + dust * 0.26;
    r[i] = v * 0.94; g[i] = v * 0.97; b[i] = v;
  }
  for (let i = 0; i < s.rough.length; i++) {
    s.rough[i] = clamp01(0.04 + runs[i] * 0.30 + scr[i] * 0.25 + smoothstep(0.7, 0.98, fine[i]) * 0.18);
  }
  s.metal.fill(0);
  s.ao.fill(1);
  // Glass is the one material with no shader extensions, so its albedo alpha is
  // read straight as opacity — keep it fully opaque and let `opacity` rule.
  s.alpha = ctx.alloc(1);
  return s;
}

/** Water surface: two-scale wind chop baked as a height field for scrolling. */
function bakeWater(ctx) {
  const size = ctx.size;
  const s = ctx.surface();
  const a = ctx.noiseRef('waveA', { start: 6, octaves: 6, gain: 0.55, seed: 2101 });
  const b = ctx.noiseRef('waveB', { start: 14, octaves: 5, gain: 0.5, seed: 2103 });
  const c = ctx.noiseRef('waveC', { start: 40, octaves: 4, gain: 0.5, seed: 2107 });

  const h = s.h;
  for (let i = 0; i < h.length; i++) {
    // sharpen the crests so the normal map has believable specular glints
    const v = a[i] * 0.55 + b[i] * 0.3 + c[i] * 0.15;
    h[i] = clamp01(Math.pow(v, 1.25));
  }
  const { r, g, b: bb } = s;
  for (let i = 0; i < r.length; i++) {
    const foam = smoothstep(0.86, 0.99, h[i]) * 0.5;
    r[i] = 0.055 + foam * 0.75;
    g[i] = 0.105 + foam * 0.78;
    bb[i] = 0.115 + foam * 0.80;
    s.rough[i] = clamp01(0.045 + foam * 0.55);
  }
  s.metal.fill(0);
  s.ao.fill(1);
  return s;
}

/* ------------------------------------------------------------------ */
/* detail normals + macro variation (shared across all materials)       */
/* ------------------------------------------------------------------ */

/** High-frequency detail height fields, tiled ~20x over the base material. */
export function bakeDetailHeight(size, kind) {
  if (kind === 'weave') {
    const w = weave(size, { threads: 26, twill: 2, gap: 0.2, round: 1.5, seed: 3001 });
    const n = fbm(size, { start: 96, octaves: 3, gain: 0.5, seed: 3002 });
    const out = new Float32Array(size * size);
    for (let i = 0; i < out.length; i++) out[i] = w.h[i] * 0.8 + n[i] * 0.2;
    return out;
  }
  if (kind === 'brushed') {
    const sc = scratches(size, { count: size * 1.3 | 0, angle: 0, spread: 0.035, lengthMin: 0.4, lengthMax: 1.0, width: 0.8, seed: 3011 });
    const n = fbm(size, { start: 128, octaves: 3, gain: 0.5, seed: 3012 });
    const out = new Float32Array(size * size);
    for (let i = 0; i < out.length; i++) out[i] = clamp01(0.5 + sc[i] * 0.5 + (n[i] - 0.5) * 0.25);
    return out;
  }
  if (kind === 'stipple') {
    const w = worley(size, 96, 3021, { jitter: 0.85 });
    const n = fbm(size, { start: 160, octaves: 3, gain: 0.5, seed: 3022 });
    const out = new Float32Array(size * size);
    for (let i = 0; i < out.length; i++) {
      out[i] = clamp01(Math.pow(smoothstep(0.9, 0.05, w.f1[i]), 1.5) * 0.75 + (n[i] - 0.5) * 0.35 + 0.15);
    }
    return out;
  }
  // 'grit' — default: dense micro-aggregate for stone, concrete, ground
  const w = worley(size, 72, 3031, { jitter: 1 });
  const n1 = fbm(size, { start: 96, octaves: 4, gain: 0.5, seed: 3032 });
  const n2 = fbm(size, { start: 200, octaves: 2, gain: 0.5, seed: 3033 });
  const out = new Float32Array(size * size);
  for (let i = 0; i < out.length; i++) {
    out[i] = clamp01(smoothstep(0.55, 0.02, w.f1[i]) * 0.42 + n1[i] * 0.40 + (n2[i] - 0.5) * 0.28 + 0.1);
  }
  return out;
}

/**
 * Macro-variation texture. RGB is a gentle hue/value drift centred on 0.5 (the
 * shader multiplies by 2), A is the value used to bias roughness. Sampled at
 * 1/16 the base frequency, this is what stops a 4-metre wall from looking like
 * the same 2-metre tile stamped twice.
 */
export function bakeMacro(size) {
  const base = fbm(size, { start: 2, octaves: 5, gain: 0.62, seed: 4001 });
  const hue = fbm(size, { start: 3, octaves: 4, gain: 0.6, seed: 4003 });
  const patch = fbm(size, { start: 5, octaves: 4, gain: 0.55, seed: 4007 });
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const v = base[i] * 0.65 + patch[i] * 0.35;
    const warm = (hue[i] - 0.5);
    // ±18% value, ±5% hue swing — subtle enough to never read as a stain
    const r = 0.5 * (1 + (v - 0.5) * 0.36 + warm * 0.10);
    const g = 0.5 * (1 + (v - 0.5) * 0.36);
    const b = 0.5 * (1 + (v - 0.5) * 0.36 - warm * 0.10);
    const o = i * 4;
    out[o] = Math.max(0, Math.min(255, r * 255 + 0.5)) | 0;
    out[o + 1] = Math.max(0, Math.min(255, g * 255 + 0.5)) | 0;
    out[o + 2] = Math.max(0, Math.min(255, b * 255 + 0.5)) | 0;
    out[o + 3] = Math.max(0, Math.min(255, v * 255 + 0.5)) | 0;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* registry                                                            */
/* ------------------------------------------------------------------ */

/**
 * `surface`      one of the ten contract surface ids (bullet impacts, footsteps)
 * `res`          hero = 1024, std = 512, small = 256
 * `tileMeters`   world size one UV tile should cover
 * `detail`       which shared detail-normal set to layer on
 * `flags`        shader features (macro variation, parallax, triplanar, ...)
 * `params`       three.js material constructor params
 */
export const RECIPES = {
  concrete:      { surface: 'concrete', res: 'hero', tileMeters: 2.4, detail: 'grit',    normalStrength: 1.15, detailScale: 18, detailStrength: 0.55, macro: [0.30, 0.16], build: bakeConcrete },
  concrete_cracked:{ surface:'concrete', res: 'std', tileMeters: 2.6, detail: 'grit',    normalStrength: 1.35, detailScale: 16, detailStrength: 0.6,  macro: [0.34, 0.18], parallax: 0.030, build: bakeConcreteCracked },
  plaster:       { surface: 'concrete', res: 'std',  tileMeters: 2.2, detail: 'grit',    normalStrength: 0.75, detailScale: 22, detailStrength: 0.32, macro: [0.26, 0.12], build: bakePlaster },
  stucco:        { surface: 'concrete', res: 'std',  tileMeters: 1.8, detail: 'grit',    normalStrength: 1.25, detailScale: 20, detailStrength: 0.55, macro: [0.30, 0.16], build: bakeStucco },
  brick:         { surface: 'concrete', res: 'hero', tileMeters: 1.9, detail: 'grit',    normalStrength: 1.30, detailScale: 18, detailStrength: 0.45, macro: [0.34, 0.14], parallax: 0.026, build: bakeBrick },
  tile:          { surface: 'concrete', res: 'std',  tileMeters: 1.6, detail: 'grit',    normalStrength: 1.10, detailScale: 24, detailStrength: 0.22, macro: [0.18, 0.10], build: bakeTile },
  asphalt:       { surface: 'concrete', res: 'std',  tileMeters: 3.0, detail: 'grit',    normalStrength: 1.20, detailScale: 20, detailStrength: 0.6,  macro: [0.30, 0.18], build: bakeAsphalt },
  gravel:        { surface: 'dirt',     res: 'std',  tileMeters: 1.6, detail: 'grit',    normalStrength: 1.45, detailScale: 18, detailStrength: 0.65, macro: [0.34, 0.16], parallax: 0.035, triplanarReady: true, triplanarDefault: true, build: bakeGravel },
  rubble:        { surface: 'concrete', res: 'std',  tileMeters: 2.0, detail: 'grit',    normalStrength: 1.5,  detailScale: 16, detailStrength: 0.7,  macro: [0.36, 0.18], parallax: 0.035, triplanarReady: true, triplanarDefault: true, build: bakeRubble },
  dirt:          { surface: 'dirt',     res: 'std',  tileMeters: 2.6, detail: 'grit',    normalStrength: 1.25, detailScale: 18, detailStrength: 0.6,  macro: [0.36, 0.16], triplanarReady: true, build: bakeDirt },
  sand:          { surface: 'sand',     res: 'hero', tileMeters: 3.2, detail: 'grit',    normalStrength: 1.0,  detailScale: 22, detailStrength: 0.5,  macro: [0.30, 0.12], triplanarReady: true, build: bakeSand },

  metal:         { surface: 'metal',    res: 'std',  tileMeters: 1.4, detail: 'brushed', normalStrength: 0.7,  detailScale: 20, detailStrength: 0.35, macro: [0.20, 0.14], build: bakeMetal },
  metal_painted: { surface: 'metal',    res: 'hero', tileMeters: 2.2, detail: 'brushed', normalStrength: 1.0,  detailScale: 20, detailStrength: 0.30, macro: [0.24, 0.14], build: bakeMetalPainted },
  metal_rusted:  { surface: 'metal',    res: 'std',  tileMeters: 1.8, detail: 'grit',    normalStrength: 1.35, detailScale: 18, detailStrength: 0.6,  macro: [0.34, 0.18], parallax: 0.028, build: bakeMetalRusted },
  metal_corrugated:{ surface:'metal',   res: 'std',  tileMeters: 2.4, detail: 'brushed', normalStrength: 1.6,  detailScale: 22, detailStrength: 0.35, macro: [0.26, 0.14], build: bakeMetalCorrugated },
  gun_metal:     { surface: 'metal',    res: 'std',  tileMeters: 0.35, detail: 'brushed', normalStrength: 0.55, detailScale: 16, detailStrength: 0.3, macro: [0.14, 0.10], build: bakeGunMetal },
  polymer:       { surface: 'metal',    res: 'std',  tileMeters: 0.40, detail: 'stipple', normalStrength: 0.8,  detailScale: 14, detailStrength: 0.35, macro: [0.16, 0.10], build: bakePolymer },

  wood:          { surface: 'wood',     res: 'hero', tileMeters: 2.0, detail: 'brushed', normalStrength: 1.0,  detailScale: 20, detailStrength: 0.30, macro: [0.30, 0.14], build: bakeWood },
  cardboard:     { surface: 'wood',     res: 'std',  tileMeters: 1.0, detail: 'weave',   normalStrength: 0.9,  detailScale: 16, detailStrength: 0.35, macro: [0.24, 0.12], build: bakeCardboard },

  fabric:        { surface: 'fabric',   res: 'std',  tileMeters: 1.1, detail: 'weave',   normalStrength: 1.0,  detailScale: 14, detailStrength: 0.45, macro: [0.26, 0.12], build: bakeFabric },
  camo:          { surface: 'fabric',   res: 'std',  tileMeters: 1.3, detail: 'weave',   normalStrength: 1.0,  detailScale: 14, detailStrength: 0.45, macro: [0.22, 0.12], build: bakeCamo },
  sandbag:       { surface: 'sand',     res: 'std',  tileMeters: 0.9, detail: 'weave',   normalStrength: 1.35, detailScale: 12, detailStrength: 0.5,  macro: [0.30, 0.14], build: bakeSandbag },

  flesh:         { surface: 'flesh',    res: 'std',  tileMeters: 0.6, detail: 'stipple', normalStrength: 0.6,  detailScale: 18, detailStrength: 0.25, macro: [0.18, 0.10], saturation: 0.92, gain: 0.96, build: bakeFlesh },
  foliage:       { surface: 'foliage',  res: 'std',  tileMeters: 1.0, detail: 'grit',    normalStrength: 0.9,  detailScale: 12, detailStrength: 0.25, macro: [0.24, 0.12], saturation: 0.88, gain: 0.95, alphaFromMap: true, build: bakeFoliage },
  glass:         { surface: 'glass',    res: 'small',tileMeters: 2.0, detail: null,      normalStrength: 0.35, detailScale: 0,  detailStrength: 0,    macro: [0.10, 0.06], saturation: 1.0, gain: 1.0, build: bakeGlass },
  water:         { surface: 'water',    res: 'std',  tileMeters: 6.0, detail: null,      normalStrength: 1.6,  detailScale: 0,  detailStrength: 0,    macro: [0, 0],       saturation: 1.0, gain: 1.0, build: bakeWater },
};

/**
 * Materials that reuse another recipe's baked map set with different shading
 * parameters. Cheap: no extra bake, no extra VRAM, but they read as genuinely
 * different materials because tint + roughness + metalness do most of the work
 * for metals and painted finishes.
 */
export const DERIVED = {
  brass:      { from: 'gun_metal', surface: 'metal', tileMeters: 0.30,
                params: { color: 0xf5c66b, roughness: 0.42, metalness: 1.0 },
                roughnessScale: 0.62 },
  wet_asphalt:{ from: 'asphalt', surface: 'concrete', tileMeters: 3.0,
                params: { color: 0xffffff, roughness: 1.0, metalness: 0.0 },
                wet: [1.0, 0.30, 0.72] },
  wet_concrete:{ from: 'concrete', surface: 'concrete', tileMeters: 2.4,
                params: { color: 0xffffff, roughness: 1.0, metalness: 0.0 },
                wet: [0.8, 0.34, 0.78] },
  painted_wall:{ from: 'plaster', surface: 'concrete', tileMeters: 2.2,
                params: { color: 0x8fa0a4, roughness: 0.72, metalness: 0.0 },
                roughnessScale: 0.82 },
  steel_dark: { from: 'metal', surface: 'metal', tileMeters: 1.4,
                params: { color: 0x6d7076, roughness: 0.9, metalness: 1.0 },
                roughnessScale: 1.15 },
};
