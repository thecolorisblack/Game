import * as THREE from 'three';

/**
 * Shared scratch, deterministic noise and curve helpers for the VFX module.
 *
 * Everything here is allocation-free at runtime: the `V` / `Q` / `M` scratch
 * objects are reused by every spawner. Any function that returns a vector
 * returns one of those, so callers must consume it before the next call.
 */

/* -------------------------------------------------------------------------- */
/* math                                                                        */
/* -------------------------------------------------------------------------- */

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const saturate = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => { const x = saturate(t); return x * x * (3 - 2 * x); };
export const smootherstep = (t) => { const x = saturate(t); return x * x * x * (x * (x * 6 - 15) + 10); };
export const invLerp = (a, b, v) => (b === a ? 0 : saturate((v - a) / (b - a)));

/** Frame-rate independent exponential approach. */
export const damp = (current, target, lambda, dt) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt));

export const TAU = Math.PI * 2;

/* -------------------------------------------------------------------------- */
/* rng                                                                         */
/* -------------------------------------------------------------------------- */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Small deterministic random source. VFX uses a *seeded* stream for anything
 * baked at boot (textures, ambient placement) so two runs of the capture
 * harness produce byte-identical frames, and `Math.random` for per-shot jitter.
 */
export class Rng {
  constructor(seed = 0x9E3779B9) { this.next = mulberry32(seed); }
  float() { return this.next(); }
  range(a, b) { return a + (b - a) * this.next(); }
  int(n) { return Math.floor(this.next() * n) % n; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  /** Gaussian-ish via the sum of three uniforms — cheap and bounded. */
  gauss() { return (this.next() + this.next() + this.next() - 1.5) * 1.1547; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length) % arr.length]; }
}

/* -------------------------------------------------------------------------- */
/* scratch                                                                     */
/* -------------------------------------------------------------------------- */

export const V = {
  a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(),
  d: new THREE.Vector3(), e: new THREE.Vector3(), f: new THREE.Vector3(),
  g: new THREE.Vector3(), h: new THREE.Vector3(),
};
export const V2 = { a: new THREE.Vector2(), b: new THREE.Vector2() };
export const Q = { a: new THREE.Quaternion(), b: new THREE.Quaternion() };
export const M = { a: new THREE.Matrix4(), b: new THREE.Matrix4(), n: new THREE.Matrix3() };
export const COL = { a: new THREE.Color(), b: new THREE.Color(), c: new THREE.Color() };

const UP = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);
const SIDE = /* @__PURE__ */ new THREE.Vector3(1, 0, 0);

/** Any unit vector perpendicular to `n`, written into `out`. */
export function perpendicular(n, out) {
  const ref = Math.abs(n.y) > 0.94 ? SIDE : UP;
  return out.crossVectors(n, ref).normalize();
}

/** Uniformly distributed unit vector. */
export function randomDirection(out, rnd = Math.random) {
  const z = rnd() * 2 - 1;
  const a = rnd() * TAU;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return out.set(Math.cos(a) * r, Math.sin(a) * r, z);
}

/**
 * A direction inside a cone around `dir`. `spread` is the cone half-angle in
 * radians; `bias` > 1 pushes samples toward the axis (tight cores, wide skirts).
 */
export function coneDirection(dir, spread, out, rnd = Math.random, bias = 1) {
  const cosMax = Math.cos(clamp(spread, 0, Math.PI));
  const u = Math.pow(rnd(), bias);
  const cosT = 1 - u * (1 - cosMax);
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  const phi = rnd() * TAU;
  const t1 = perpendicular(dir, V.g);
  const t2 = V.h.crossVectors(dir, t1);
  out.copy(dir).multiplyScalar(cosT)
    .addScaledVector(t1, Math.cos(phi) * sinT)
    .addScaledVector(t2, Math.sin(phi) * sinT);
  return out.normalize();
}

/** Reflection of `dir` about `normal`, with `scatter` radians of roughness. */
export function reflectScatter(dir, normal, scatter, out, rnd = Math.random) {
  out.copy(dir).addScaledVector(normal, -2 * dir.dot(normal)).normalize();
  if (scatter > 1e-4) coneDirection(out, scatter, out, rnd, 1.4);
  return out;
}

/* -------------------------------------------------------------------------- */
/* springs                                                                     */
/* -------------------------------------------------------------------------- */

/** Critically damped scalar spring — used for flash falloff and haze pumping. */
export class Spring {
  constructor(value = 0, stiffness = 120, damping = 18) {
    this.value = value; this.target = value; this.velocity = 0;
    this.stiffness = stiffness; this.damping = damping;
  }
  set(v) { this.value = this.target = v; this.velocity = 0; return this; }
  kick(v) { this.velocity += v; return this; }
  step(dt) {
    // Semi-implicit Euler, substepped so a 30 Hz frame cannot make it explode.
    const steps = dt > 1 / 45 ? 2 : 1;
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.velocity += (-this.stiffness * (this.value - this.target) - this.damping * this.velocity) * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }
}

/* -------------------------------------------------------------------------- */
/* curves / gradients                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Piecewise gradient sampler. `stops` is `[[t, r,g,b, a], ...]` sorted by t;
 * values may exceed 1 (emissive particles are authored scene-referred).
 */
export function sampleGradient(stops, t, out) {
  const n = stops.length;
  if (n === 0) return out.set(1, 1, 1, 1);
  if (t <= stops[0][0]) { const s = stops[0]; return out.set(s[1], s[2], s[3], s[4]); }
  for (let i = 1; i < n; i++) {
    const s1 = stops[i];
    if (t <= s1[0]) {
      const s0 = stops[i - 1];
      const k = (t - s0[0]) / Math.max(1e-5, s1[0] - s0[0]);
      return out.set(
        lerp(s0[1], s1[1], k), lerp(s0[2], s1[2], k),
        lerp(s0[3], s1[3], k), lerp(s0[4], s1[4], k),
      );
    }
  }
  const s = stops[n - 1];
  return out.set(s[1], s[2], s[3], s[4]);
}

/** Scalar curve sampler for `[[t, v], ...]`. */
export function sampleCurve(stops, t) {
  const n = stops.length;
  if (!n) return 1;
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < n; i++) {
    if (t <= stops[i][0]) {
      const a = stops[i - 1], b = stops[i];
      const k = (t - a[0]) / Math.max(1e-5, b[0] - a[0]);
      return lerp(a[1], b[1], k);
    }
  }
  return stops[n - 1][1];
}

/* -------------------------------------------------------------------------- */
/* pooling                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Fixed-capacity object pool with round-robin stealing: when everything is in
 * flight the *oldest* entry is recycled rather than dropping the request, which
 * is what you want for effects (a missing muzzle flash reads as a bug, a
 * slightly clipped one does not).
 */
export class Pool {
  constructor(size, factory) {
    this.items = new Array(size);
    this.active = new Array(size).fill(false);
    this.stamp = new Float64Array(size);
    for (let i = 0; i < size; i++) this.items[i] = factory(i);
    this._cursor = 0;
    this._clock = 0;
  }
  get size() { return this.items.length; }
  acquire() {
    const n = this.items.length;
    if (!n) return null;
    for (let i = 0; i < n; i++) {
      const idx = (this._cursor + i) % n;
      if (!this.active[idx]) {
        this._cursor = (idx + 1) % n;
        this.active[idx] = true;
        this.stamp[idx] = ++this._clock;
        return this.items[idx];
      }
    }
    // All busy: steal the least recently acquired.
    let oldest = 0;
    for (let i = 1; i < n; i++) if (this.stamp[i] < this.stamp[oldest]) oldest = i;
    this.stamp[oldest] = ++this._clock;
    return this.items[oldest];
  }
  release(item) {
    const i = this.items.indexOf(item);
    if (i >= 0) this.active[i] = false;
  }
  releaseIndex(i) { if (i >= 0 && i < this.active.length) this.active[i] = false; }
  forEach(fn) { for (let i = 0; i < this.items.length; i++) fn(this.items[i], i, this.active[i]); }
  releaseAll() { this.active.fill(false); }
}

/* -------------------------------------------------------------------------- */
/* misc                                                                        */
/* -------------------------------------------------------------------------- */

/** Squared distance without allocating. */
export function distSq(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Distance-based level of detail for spawn counts: effects far from the camera
 * (or behind it) get a fraction of the particles nobody would ever resolve.
 */
export function lodScale(camera, point, near = 12, far = 90) {
  if (!camera || !point) return 1;
  const d = Math.sqrt(distSq(camera.position, point));
  if (d <= near) return 1;
  if (d >= far) return 0.22;
  return lerp(1, 0.22, (d - near) / (far - near));
}

/** True if `point` is roughly inside the view frustum (cheap cone test). */
export function inView(camera, point, cosHalf = -0.2) {
  if (!camera) return true;
  V.a.set(0, 0, -1).applyQuaternion(camera.quaternion);
  V.b.copy(point).sub(camera.position);
  const len = V.b.length();
  if (len < 1e-4) return true;
  return V.b.dot(V.a) / len > cosHalf;
}

export function disposeObject(obj) {
  obj?.traverse?.((o) => {
    o.geometry?.dispose?.();
    const m = o.material;
    if (Array.isArray(m)) m.forEach((x) => x?.dispose?.());
    else m?.dispose?.();
  });
}
