/**
 * Tileable procedural noise primitives.
 *
 * Everything in here is pure JS over Float32Arrays — no three, no DOM — so the
 * whole bake pipeline can be profiled headlessly in node.
 *
 * The workhorse is `fbm()`, which builds fractal noise as a Laplacian-style
 * pyramid: start from a tiny lattice of white noise, upsample 2x with a cubic
 * B-spline kernel, add a fresh band of white noise at the new resolution, and
 * repeat. Cost is sum(4^k) ≈ 1.33·N² instead of octaves·N², which is what makes
 * baking two dozen 1k material sets in a couple of seconds possible at all.
 * Because every level wraps, the result is seamlessly tileable by construction.
 */

/** Fast, well-distributed 32-bit PRNG. Deterministic across runs. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 2D integer hash in [0,1). Used where a stateless per-cell value is needed. */
export function hash2i(x, y, seed = 0) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Wrapping 2x upsample with a [1,6,1]/8 + [4,4]/8 separable B-spline kernel. */
export function upsample2(src, n) {
  const m = n * 2;
  const tmp = new Float32Array(m * n);
  for (let y = 0; y < n; y++) {
    const so = y * n;
    const to = y * m;
    for (let x = 0; x < n; x++) {
      const a = src[so + (x === 0 ? n - 1 : x - 1)];
      const b = src[so + x];
      const c = src[so + (x === n - 1 ? 0 : x + 1)];
      tmp[to + 2 * x] = (a + 6 * b + c) * 0.125;
      tmp[to + 2 * x + 1] = (b + c) * 0.5;
    }
  }
  const out = new Float32Array(m * m);
  for (let y = 0; y < n; y++) {
    const rm = (y === 0 ? n - 1 : y - 1) * m;
    const r0 = y * m;
    const rp = (y === n - 1 ? 0 : y + 1) * m;
    const o0 = 2 * y * m;
    const o1 = o0 + m;
    for (let x = 0; x < m; x++) {
      const a = tmp[rm + x];
      const b = tmp[r0 + x];
      const c = tmp[rp + x];
      out[o0 + x] = (a + 6 * b + c) * 0.125;
      out[o1 + x] = (b + c) * 0.5;
    }
  }
  return out;
}

function seedBand(buf, count, rng, amp, fold) {
  if (fold) {
    for (let i = 0; i < count; i++) buf[i] += (Math.abs(rng() * 2 - 1) * 2 - 1) * amp;
  } else {
    for (let i = 0; i < count; i++) buf[i] += (rng() * 2 - 1) * amp;
  }
}

/**
 * Tileable fractal value noise.
 *
 * @param size      output resolution (power of two)
 * @param start     lattice size of the first (lowest frequency) band
 * @param octaves   how many bands to add
 * @param gain      amplitude falloff per band (0.5 = classic pink FBM)
 * @param seed      PRNG seed
 * @param fold      turbulence-style |n| folding per band (billowy, cloudy)
 * @param finest    the highest band is capped at size/finest (2 = softer)
 * @param normalize remap the result to exactly [0,1]
 */
export function fbm(size, opts = {}) {
  const {
    start = 4, octaves = 12, gain = 0.5, seed = 1,
    fold = false, finest = 1, normalize = true,
  } = opts;

  let r = 1;
  while (r < start) r <<= 1;
  if (r > size) r = size;
  const top = Math.max(r, Math.floor(size / Math.max(1, finest)));

  const rng = mulberry32(seed);
  let cur = new Float32Array(r * r);
  let amp = 1;
  let bands = 1;
  seedBand(cur, r * r, rng, amp, fold);

  while (r < size) {
    cur = upsample2(cur, r);
    r <<= 1;
    if (bands < octaves && r <= top) {
      amp *= gain;
      seedBand(cur, r * r, rng, amp, fold);
      bands++;
    }
  }
  if (normalize) normalizeInPlace(cur);
  return cur;
}

/** Remap a field so its min maps to lo and its max to hi. */
export function normalizeInPlace(f, lo = 0, hi = 1) {
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < f.length; i++) {
    const v = f[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const d = mx - mn;
  if (d < 1e-9) { f.fill((lo + hi) * 0.5); return f; }
  const s = (hi - lo) / d;
  for (let i = 0; i < f.length; i++) f[i] = lo + (f[i] - mn) * s;
  return f;
}

/**
 * Tileable Worley / cellular noise on a jittered grid.
 * Returns F1 and F2 distances normalised so a typical F1 sits near 0.5, plus a
 * per-cell random id (great for pebble colour variation and cracked plates).
 */
export function worley(size, cells, seed = 3, opts = {}) {
  const { jitter = 0.95, chebyshev = false } = opts;
  const rng = mulberry32(seed);
  const nc = cells * cells;
  const px = new Float32Array(nc);
  const py = new Float32Array(nc);
  const pid = new Float32Array(nc);
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const i = cy * cells + cx;
      px[i] = (cx + 0.5 + (rng() - 0.5) * jitter) / cells;
      py[i] = (cy + 0.5 + (rng() - 0.5) * jitter) / cells;
      pid[i] = rng();
    }
  }

  const f1 = new Float32Array(size * size);
  const f2 = new Float32Array(size * size);
  const id = new Float32Array(size * size);
  const inv = 1 / size;

  // Walk cell by cell rather than pixel by pixel: the nine candidate feature
  // points (and their wrap offsets) are gathered once per cell into small
  // arrays that stay in L1, instead of being re-derived a million times.
  const nx = new Float64Array(9);
  const ny = new Float64Array(9);
  const nid = new Float64Array(9);

  for (let cy = 0; cy < cells; cy++) {
    const y0 = Math.max(0, Math.ceil((cy * size) / cells - 0.5));
    const y1 = Math.min(size, Math.ceil(((cy + 1) * size) / cells - 0.5));
    for (let cx = 0; cx < cells; cx++) {
      const x0 = Math.max(0, Math.ceil((cx * size) / cells - 0.5));
      const x1 = Math.min(size, Math.ceil(((cx + 1) * size) / cells - 0.5));
      if (x1 <= x0 || y1 <= y0) continue;

      let k = 0;
      for (let oy = -1; oy <= 1; oy++) {
        let gy = cy + oy;
        let wy = 0;
        if (gy < 0) { gy += cells; wy = -1; } else if (gy >= cells) { gy -= cells; wy = 1; }
        const row = gy * cells;
        for (let ox = -1; ox <= 1; ox++) {
          let gx = cx + ox;
          let wx = 0;
          if (gx < 0) { gx += cells; wx = -1; } else if (gx >= cells) { gx -= cells; wx = 1; }
          const i = row + gx;
          nx[k] = px[i] + wx;
          ny[k] = py[i] + wy;
          nid[k] = pid[i];
          k++;
        }
      }

      for (let y = y0; y < y1; y++) {
        const v = (y + 0.5) * inv;
        const rowOut = y * size;
        for (let x = x0; x < x1; x++) {
          const u = (x + 0.5) * inv;
          let d1 = 1e9;
          let d2 = 1e9;
          let best = 0;
          for (let j = 0; j < 9; j++) {
            const dx = nx[j] - u;
            const dy = ny[j] - v;
            const d = chebyshev
              ? (Math.abs(dx) > Math.abs(dy) ? Math.abs(dx) : Math.abs(dy))
              : dx * dx + dy * dy;
            if (d < d1) { d2 = d1; d1 = d; best = nid[j]; } else if (d < d2) { d2 = d; }
          }
          const o = rowOut + x;
          if (chebyshev) { f1[o] = d1 * cells * 2; f2[o] = d2 * cells * 2; }
          else { f1[o] = Math.sqrt(d1) * cells * 1.4; f2[o] = Math.sqrt(d2) * cells * 1.4; }
          id[o] = best;
        }
      }
    }
  }
  return { f1, f2, id };
}

/** Bilinear sample with wraparound; coords are in pixels and may be out of range. */
export function bilinearWrap(src, size, x, y) {
  let x0 = Math.floor(x);
  let y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  x0 = ((x0 % size) + size) % size;
  y0 = ((y0 % size) + size) % size;
  const x1 = x0 === size - 1 ? 0 : x0 + 1;
  const y1 = y0 === size - 1 ? 0 : y0 + 1;
  const r0 = y0 * size;
  const r1 = y1 * size;
  const a = src[r0 + x0];
  const b = src[r0 + x1];
  const c = src[r1 + x0];
  const d = src[r1 + x1];
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

/** Domain-warp `src` by two control fields (each centred on 0.5). */
export function warpField(src, size, dx, dy, ampX, ampY = ampX) {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = y * size + x;
      out[o] = bilinearWrap(src, size, x + (dx[o] - 0.5) * ampX, y + (dy[o] - 0.5) * ampY);
    }
  }
  return out;
}

/** Nearest-power-of-two bilinear upscale of a smaller field (wrapping). */
export function upscaleTo(src, srcSize, dstSize) {
  if (srcSize === dstSize) return src;
  let cur = src;
  let n = srcSize;
  while (n < dstSize) { cur = upsample2(cur, n); n <<= 1; }
  return cur;
}
