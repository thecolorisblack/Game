import * as THREE from 'three';

/**
 * Animation primitives shared by the movement and camera code.
 *
 * Everything the player controller animates — eye height, FOV, recoil, landing
 * dip, lean — is authored as a spring or an exponential decay rather than a
 * fixed-length lerp. Springs compose (two impulses in the same frame simply
 * add), they are frame-rate independent, and they never "arrive" with a visible
 * corner the way an eased tween does. That is most of the difference between a
 * camera that feels like Modern Warfare and one that feels like a tech demo.
 */

/** Frame-rate independent exponential approach. `lambda` is 1/time-constant. */
export function damp(current, target, lambda, dt) {
  return target + (current - target) * Math.exp(-lambda * dt);
}

/** Same, for a THREE.Vector3, in place. */
export function dampVec3(current, target, lambda, dt) {
  const k = Math.exp(-lambda * dt);
  current.x = target.x + (current.x - target.x) * k;
  current.y = target.y + (current.y - target.y) * k;
  current.z = target.z + (current.z - target.z) * k;
  return current;
}

/** Shortest-path angular damp, so yaw wrapping never spins the long way round. */
export function dampAngle(current, target, lambda, dt) {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return current + d * (1 - Math.exp(-lambda * dt));
}

export function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

export function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
}

export function easeOutCubic(t) { const u = 1 - clamp01(t); return 1 - u * u * u; }
export function easeInOutSine(t) { return 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t)); }

/**
 * Damped harmonic oscillator, integrated semi-implicitly and substepped so a
 * 15 fps hitch cannot make a stiff spring explode.
 *
 *   freq     natural frequency in rad/s (higher = snappier)
 *   damping  1.0 = critically damped, <1 overshoots, >1 sluggish
 */
export class Spring {
  constructor(freq = 14, damping = 1, value = 0) {
    this.freq = freq;
    this.damping = damping;
    this.value = value;
    this.vel = 0;
    this.target = value;
  }

  reset(v = 0) { this.value = v; this.vel = 0; this.target = v; return this; }

  /** Add raw velocity. */
  impulse(v) { this.vel += v; return this; }

  /**
   * Add the velocity that makes a critically damped spring peak at `peak`.
   * For x(t) = v0*t*e^(-wt) the peak is v0/(w*e), so v0 = peak*w*e.
   */
  impulseForPeak(peak) {
    this.vel += peak * this.freq * Math.E * (this.damping < 1 ? this.damping : 1);
    return this;
  }

  step(dt, target = this.target) {
    this.target = target;
    if (!(dt > 0)) return this.value;
    const n = dt > 0.009 ? Math.min(10, Math.ceil(dt / 0.008)) : 1;
    const h = dt / n;
    const w = this.freq;
    const k = w * w;
    const c = 2 * this.damping * w;
    for (let i = 0; i < n; i++) {
      this.vel += (-k * (this.value - target) - c * this.vel) * h;
      this.value += this.vel * h;
    }
    if (!Number.isFinite(this.value)) this.reset(target);
    return this.value;
  }
}

/** Three independent springs sharing one set of coefficients. */
export class SpringVec3 {
  constructor(freq = 14, damping = 1) {
    this.x = new Spring(freq, damping);
    this.y = new Spring(freq, damping);
    this.z = new Spring(freq, damping);
    this.value = new THREE.Vector3();
  }

  set freq(v) { this.x.freq = this.y.freq = this.z.freq = v; }
  set damping(v) { this.x.damping = this.y.damping = this.z.damping = v; }

  reset() { this.x.reset(); this.y.reset(); this.z.reset(); this.value.set(0, 0, 0); return this; }

  impulse(v) { this.x.impulse(v.x); this.y.impulse(v.y); this.z.impulse(v.z); return this; }

  impulseForPeak(v) {
    this.x.impulseForPeak(v.x);
    this.y.impulseForPeak(v.y);
    this.z.impulseForPeak(v.z);
    return this;
  }

  step(dt, target = null) {
    this.value.set(
      this.x.step(dt, target ? target.x : 0),
      this.y.step(dt, target ? target.y : 0),
      this.z.step(dt, target ? target.z : 0),
    );
    return this.value;
  }
}

/**
 * Unity-style critically damped smoothing with an explicit approach time.
 * Better than a spring where overshoot is unacceptable — FOV and eye height.
 */
export class Smoothed {
  constructor(value = 0) { this.value = value; this.vel = 0; }

  reset(v) { this.value = v; this.vel = 0; return this; }

  step(target, smoothTime, dt, maxSpeed = Infinity) {
    if (!(dt > 0)) return this.value;
    const st = Math.max(1e-4, smoothTime);
    const omega = 2 / st;
    const x = omega * dt;
    const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);

    const goal = target;
    let change = this.value - target;
    const maxChange = maxSpeed * st;
    if (change > maxChange) change = maxChange;
    else if (change < -maxChange) change = -maxChange;
    const shifted = this.value - change;

    const temp = (this.vel + omega * change) * dt;
    this.vel = (this.vel - omega * temp) * exp;
    let out = shifted + (change + temp) * exp;

    // Clamp the classic overshoot on the far side of the goal.
    if ((goal - this.value > 0) === (out > goal)) {
      out = goal;
      this.vel = 0;
    }
    if (!Number.isFinite(out)) { out = goal; this.vel = 0; }
    this.value = out;
    return out;
  }
}

/** Move `current` toward `target` at a bounded rate (units/second). */
export function moveTowards(current, target, maxDelta) {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}
