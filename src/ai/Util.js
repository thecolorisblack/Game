import * as THREE from 'three';

/**
 * Small, dependency-free maths used across the AI module: a deterministic RNG,
 * value/fbm noise for the character texture bakes, critically-damped springs for
 * gear secondary motion, and a couple of curve helpers for the animation system.
 *
 * Everything here is allocation-free on the hot paths — the springs keep their
 * own state and write into caller-owned vectors.
 */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function invLerp(a, b, v) { return b === a ? 0 : clamp01((v - a) / (b - a)); }
export function smoothstep(a, b, v) { const t = invLerp(a, b, v); return t * t * (3 - 2 * t); }
export function smootherstep(a, b, v) { const t = invLerp(a, b, v); return t * t * t * (t * (t * 6 - 15) + 10); }

/** Frame-rate independent exponential approach. `rate` is 1/e per second. */
export function damp(current, target, rate, dt) {
  return target + (current - target) * Math.exp(-rate * dt);
}

export function shortestAngle(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export function dampAngle(current, target, rate, dt) {
  return current + shortestAngle(current, target) * (1 - Math.exp(-rate * dt));
}

/* ------------------------------------------------------------------ */
/* deterministic RNG                                                   */
/* ------------------------------------------------------------------ */

/** mulberry32 — small, fast, good enough for content generation. */
export class Rand {
  constructor(seed = 1) { this.s = (seed >>> 0) || 1; }
  next() {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  int(a, b) { return Math.floor(this.range(a, b + 1 - 1e-9)); }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  pick(list) { return list[Math.min(list.length - 1, Math.floor(this.next() * list.length))]; }
  bool(p = 0.5) { return this.next() < p; }
}

/* ------------------------------------------------------------------ */
/* noise                                                               */
/* ------------------------------------------------------------------ */

function hash2i(x, y, seed) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Tiling value noise on an integer lattice of period `period`. */
export function valueNoise2(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const wrap = (n) => ((n % period) + period) % period;
  const x0 = wrap(xi), x1 = wrap(xi + 1), y0 = wrap(yi), y1 = wrap(yi + 1);
  const a = hash2i(x0, y0, seed), b = hash2i(x1, y0, seed);
  const c = hash2i(x0, y1, seed), d = hash2i(x1, y1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

/** Tiling fractal noise in [0,1]. `freq` must be an integer for seamlessness. */
export function fbm2(x, y, freq, octaves, seed, gain = 0.5, lacunarity = 2) {
  let sum = 0, amp = 1, norm = 0, f = freq;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise2(x * f, y * f, f, seed + o * 131);
    norm += amp;
    amp *= gain;
    f = Math.round(f * lacunarity);
  }
  return sum / norm;
}

/** Ridged variant — good for fabric fibres and scratches. */
export function ridge2(x, y, freq, octaves, seed) {
  let sum = 0, amp = 1, norm = 0, f = freq;
  for (let o = 0; o < octaves; o++) {
    const n = Math.abs(valueNoise2(x * f, y * f, f, seed + o * 977) * 2 - 1);
    sum += amp * (1 - n);
    norm += amp;
    amp *= 0.55;
    f = Math.round(f * 2);
  }
  return sum / norm;
}

/** Tiling worley/cellular F1 distance in [0,1]. */
export function worley2(x, y, cells, seed) {
  const cx = Math.floor(x * cells), cy = Math.floor(y * cells);
  let best = 4;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i, gy = cy + j;
      const wx = ((gx % cells) + cells) % cells;
      const wy = ((gy % cells) + cells) % cells;
      const px = (gx + hash2i(wx, wy, seed)) / cells;
      const py = (gy + hash2i(wx, wy, seed + 7919)) / cells;
      const dx = px - x, dy = py - y;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return Math.min(1, Math.sqrt(best) * cells);
}

/* ------------------------------------------------------------------ */
/* springs                                                             */
/* ------------------------------------------------------------------ */

/** Scalar spring-damper. `stiffness` in rad/s^2-ish, `damping` as a ratio. */
export class Spring {
  constructor(stiffness = 120, damping = 1.0, value = 0) {
    this.k = stiffness;
    this.d = damping;
    this.value = value;
    this.velocity = 0;
    this.target = value;
  }
  set(v) { this.value = v; this.target = v; this.velocity = 0; return this; }
  kick(v) { this.velocity += v; return this; }
  update(dt) {
    if (dt <= 0) return this.value;
    // semi-implicit Euler, substepped so a 100 ms hitch cannot blow it up
    const steps = dt > 1 / 45 ? Math.min(6, Math.ceil(dt * 90)) : 1;
    const h = dt / steps;
    const c = 2 * Math.sqrt(this.k) * this.d;
    for (let i = 0; i < steps; i++) {
      const a = (this.target - this.value) * this.k - this.velocity * c;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }
}

/** Three-component spring used for the gear/pouch lag. */
export class SpringVec3 {
  constructor(stiffness = 90, damping = 0.85) {
    this.k = stiffness;
    this.d = damping;
    this.value = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this._a = new THREE.Vector3();
  }
  set(v) { this.value.copy(v); this.target.copy(v); this.velocity.set(0, 0, 0); return this; }
  update(dt) {
    if (dt <= 0) return this.value;
    const steps = dt > 1 / 45 ? Math.min(6, Math.ceil(dt * 90)) : 1;
    const h = dt / steps;
    const c = 2 * Math.sqrt(this.k) * this.d;
    for (let i = 0; i < steps; i++) {
      this._a.copy(this.target).sub(this.value).multiplyScalar(this.k)
        .addScaledVector(this.velocity, -c);
      this.velocity.addScaledVector(this._a, h);
      this.value.addScaledVector(this.velocity, h);
    }
    return this.value;
  }
}

/* ------------------------------------------------------------------ */
/* curves                                                              */
/* ------------------------------------------------------------------ */

export function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Ease curves used by the one-shot animation clips. */
export const Ease = {
  linear: (t) => t,
  in2: (t) => t * t,
  out2: (t) => 1 - (1 - t) * (1 - t),
  inout: (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
  out3: (t) => 1 - Math.pow(1 - t, 3),
  in3: (t) => t * t * t,
  /** Overshoot-and-settle, for snappy weapon and gear motion. */
  back: (t) => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
  pulse: (t) => Math.sin(Math.PI * clamp01(t)),
};

/** Cheap deterministic 1-D wobble, cheaper than layering sin() by hand. */
export function wobble(t, seed = 0) {
  return Math.sin(t * 1.7 + seed) * 0.5 + Math.sin(t * 2.83 + seed * 2.3) * 0.32
       + Math.sin(t * 4.61 + seed * 5.1) * 0.18;
}
