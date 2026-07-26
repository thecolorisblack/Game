/**
 * Deterministic pseudo-random utilities for level generation.
 *
 * Every piece of the map is generated from a fixed seed so the level is byte
 * identical between the editor, the capture harness and a player's machine.
 * Nothing here touches Math.random().
 */

export class Rng {
  constructor(seed = 0x5eed1337) {
    this.seed = seed >>> 0;
    this.s = this.seed;
  }

  reset(seed = this.seed) { this.s = seed >>> 0; return this; }

  /** mulberry32 — fast, good enough distribution, 2^32 period. */
  next() {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(a, b) { return a + (b - a) * this.next(); }
  int(a, b) { return Math.floor(a + (b - a + 1) * this.next()); }
  chance(p) { return this.next() < p; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  pick(list) { return list[Math.floor(this.next() * list.length) % list.length]; }

  /** Box–Muller, clamped: useful for jitter that should cluster near zero. */
  gauss(sigma = 1, clamp = 3) {
    const u = Math.max(1e-6, this.next());
    const v = this.next();
    const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185307179586 * v);
    return Math.max(-clamp, Math.min(clamp, g)) * sigma;
  }

  /** Fisher–Yates, in place. */
  shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = list[i]; list[i] = list[j]; list[j] = t;
    }
    return list;
  }

  /** A fresh generator whose stream is independent but reproducible. */
  fork(tag = 0) { return new Rng((this.s ^ (Math.imul(tag + 1, 0x9e3779b1))) >>> 0); }
}

/* ------------------------------------------------------------------ */
/* value noise                                                         */
/* ------------------------------------------------------------------ */

function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ (seed | 0);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Smooth value noise in [-1,1]. Cheap, tileless, no tables. */
export function noise2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = fade(xf), v = fade(yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  const top = a + (b - a) * u;
  const bot = c + (d - c) * u;
  return (top + (bot - top) * v) * 2 - 1;
}

/** Fractal Brownian motion over `octaves` of value noise. Result ~[-1,1]. */
export function fbm2(x, y, octaves = 4, lacunarity = 2.03, gain = 0.5, seed = 0) {
  let sum = 0, amp = 1, norm = 0, fx = x, fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(fx, fy, seed + i * 1013) * amp;
    norm += amp;
    amp *= gain;
    fx *= lacunarity; fy *= lacunarity;
    // rotate to break axis-aligned artefacts
    const t = fx * 0.8 - fy * 0.6;
    fy = fx * 0.6 + fy * 0.8;
    fx = t;
  }
  return sum / (norm || 1);
}

/** Ridged variant — good for dune crests and distant hills. */
export function ridge2(x, y, octaves = 4, seed = 0) {
  let sum = 0, amp = 1, norm = 0, fx = x, fy = y;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise2(fx, fy, seed + i * 733));
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    fx *= 2.07; fy *= 2.07;
  }
  return (sum / (norm || 1)) * 2 - 1;
}

export const smoothstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
};

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
