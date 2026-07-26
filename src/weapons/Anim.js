import * as THREE from 'three';

/**
 * Animation primitives for the viewmodel.
 *
 * Two ideas do all the work here:
 *
 *  1. **Springs, not lerps.** Every additive layer — sway, bob, recoil, ADS
 *     transition, hand follow — is a damped harmonic oscillator integrated at a
 *     fixed substep. A lerp always reads as "UI easing"; a spring overshoots,
 *     settles and reacts to how fast the input changed, which is what makes a
 *     weapon feel like it has mass.
 *
 *  2. **Clips are keyframed channel tables with events.** A reload is not a
 *     blend between two poses, it is a timeline of distinct phases (mag out,
 *     mag in, bolt release) that fire events at exact times so the hand, the
 *     magazine object and the ammo counter all stay in agreement.
 */

/* ==================================================================== */
/* easing                                                                */
/* ==================================================================== */

export const Ease = {
  linear: (t) => t,
  smooth: (t) => t * t * (3 - 2 * t),
  smoother: (t) => t * t * t * (t * (t * 6 - 15) + 10),
  inQuad: (t) => t * t,
  outQuad: (t) => t * (2 - t),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outQuart: (t) => 1 - Math.pow(1 - t, 4),
  inQuart: (t) => t * t * t * t,
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inExpo: (t) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
  outSine: (t) => Math.sin((t * Math.PI) / 2),
  inSine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  outBack: (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.5 * Math.pow(t - 1, 2),
  inBack: (t) => 2.2 * t * t * t - 1.5 * t * t,
  outElastic: (t) => (t <= 0 ? 0 : t >= 1 ? 1
    : Math.pow(2, -9 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
  step: () => 1,
};

export function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

/** Frame-rate independent exponential approach. */
export function damp(current, target, lambda, dt) {
  return target + (current - target) * Math.exp(-lambda * dt);
}

export function dampVec(out, target, lambda, dt) {
  const k = Math.exp(-lambda * dt);
  out.x = target.x + (out.x - target.x) * k;
  out.y = target.y + (out.y - target.y) * k;
  out.z = target.z + (out.z - target.z) * k;
  return out;
}

/* ==================================================================== */
/* springs                                                               */
/* ==================================================================== */

const MAX_SUB = 1 / 180;

/** Scalar damped spring. `damping` of 1 is critical. */
export class Spring {
  constructor(stiffness = 120, damping = 1.0, value = 0) {
    this.k = stiffness;
    this.d = damping;
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }

  set(v) { this.value = v; this.target = v; this.velocity = 0; return this; }
  reset(v = 0) { return this.set(v); }
  impulse(v) { this.velocity += v; return this; }

  update(dt) {
    if (dt <= 0) return this.value;
    const steps = Math.min(8, Math.max(1, Math.ceil(dt / MAX_SUB)));
    const h = dt / steps;
    const c = 2 * this.d * Math.sqrt(Math.max(1e-6, this.k));
    for (let i = 0; i < steps; i++) {
      const a = -this.k * (this.value - this.target) - c * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }
}

/** Three independent springs sharing parameters, exposed as a Vector3. */
export class Spring3 {
  constructor(stiffness = 120, damping = 1.0) {
    this.x = new Spring(stiffness, damping);
    this.y = new Spring(stiffness, damping);
    this.z = new Spring(stiffness, damping);
    this.value = new THREE.Vector3();
  }

  get k() { return this.x.k; }
  set k(v) { this.x.k = this.y.k = this.z.k = v; }
  get d() { return this.x.d; }
  set d(v) { this.x.d = this.y.d = this.z.d = v; }

  setTarget(x, y, z) { this.x.target = x; this.y.target = y; this.z.target = z; return this; }
  setTargetVec(v) { return this.setTarget(v.x, v.y, v.z); }
  set(x, y, z) { this.x.set(x); this.y.set(y); this.z.set(z); this.value.set(x, y, z); return this; }
  impulse(x, y, z) { this.x.impulse(x); this.y.impulse(y); this.z.impulse(z); return this; }

  update(dt) {
    this.value.set(this.x.update(dt), this.y.update(dt), this.z.update(dt));
    return this.value;
  }
}

/* ==================================================================== */
/* keyframe tracks                                                       */
/* ==================================================================== */

/**
 * A scalar keyframe track. Keys are `[time, value, easeName?]`; the ease named
 * on a key governs the segment that *ends* at that key.
 */
export class Track {
  constructor(keys) {
    this.keys = keys.slice().sort((a, b) => a[0] - b[0]);
  }

  at(t) {
    const k = this.keys;
    const n = k.length;
    if (n === 0) return 0;
    if (t <= k[0][0]) return k[0][1];
    if (t >= k[n - 1][0]) return k[n - 1][1];
    let i = 1;
    while (i < n && k[i][0] < t) i++;
    const a = k[i - 1];
    const b = k[i];
    const span = b[0] - a[0];
    const u = span > 1e-6 ? (t - a[0]) / span : 1;
    const ease = Ease[b[2]] || Ease.smooth;
    return a[1] + (b[1] - a[1]) * ease(u);
  }
}

/**
 * A named bundle of tracks plus discrete events.
 *
 *   new Clip({
 *     duration: 2.4,
 *     tracks: { 'root.pos.y': [[0,0],[0.3,-0.05,'outCubic'], ...] },
 *     events: [[0.42,'magOut'], [1.15,'magIn']],
 *   })
 *
 * `sample(t, out)` writes every channel into a plain object, reused between
 * frames so a running clip allocates nothing.
 */
export class Clip {
  constructor(def) {
    this.duration = def.duration ?? 1;
    this.loop = def.loop ?? false;
    this.tracks = new Map();
    for (const [name, keys] of Object.entries(def.tracks || {})) {
      this.tracks.set(name, new Track(keys));
    }
    this.events = (def.events || []).slice().sort((a, b) => a[0] - b[0]);
    this.channels = [...this.tracks.keys()];
  }

  sample(t, out) {
    const time = this.loop ? t % this.duration : Math.min(t, this.duration);
    for (const [name, track] of this.tracks) out[name] = track.at(time);
    return out;
  }

  /** Fire every event in (prev, now]. */
  fireEvents(prev, now, cb) {
    if (now < prev) prev = -1;
    for (const [t, name, data] of this.events) {
      if (t > prev && t <= now) cb(name, data);
    }
  }
}

/* ==================================================================== */
/* pose maths                                                            */
/* ==================================================================== */

/** A weapon pose: position + Euler rotation, blended additively or by weight. */
export class Pose {
  constructor(p = [0, 0, 0], r = [0, 0, 0]) {
    this.pos = new THREE.Vector3(p[0], p[1], p[2]);
    this.rot = new THREE.Vector3(r[0], r[1], r[2]);
  }

  copy(o) { this.pos.copy(o.pos); this.rot.copy(o.rot); return this; }
  zero() { this.pos.set(0, 0, 0); this.rot.set(0, 0, 0); return this; }
  add(o, w = 1) { this.pos.addScaledVector(o.pos, w); this.rot.addScaledVector(o.rot, w); return this; }

  lerp(o, t) {
    this.pos.lerp(o.pos, t);
    this.rot.lerp(o.rot, t);
    return this;
  }

  static fromDef(def) {
    return new Pose(def.pos || [0, 0, 0], def.rot || [0, 0, 0]);
  }
}

/**
 * Perlin-ish 1D value noise. Used for weapon idle drift so the breathing loop
 * never repeats exactly the way a sine wave does.
 */
export function noise1(x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash1(i);
  const b = hash1(i + 1);
  return a + (b - a) * u;
}

function hash1(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

/** Layered value noise, for sway that reads as a hand rather than a sine. */
export function fbm1(x, octaves = 3) {
  let a = 0.5;
  let sum = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += noise1(x * f) * a;
    f *= 2.03;
    a *= 0.5;
  }
  return sum;
}
