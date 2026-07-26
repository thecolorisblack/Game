import * as THREE from 'three';
import { BONE_COUNT, BONE_INDEX, BIND_LOCAL, BIND_POSITION, PARENT } from './Skeleton.js';
import { clamp, clamp01, lerp, smoothstep, damp, dampAngle, DEG, Spring, Ease, wobble } from './Util.js';

/**
 * Animation for the operator rig.
 *
 * Clips are authored here as sparse keyframe curves and compiled once at module
 * load. Leg tracks are written in *absolute* segment pitch (thigh, shank, foot
 * measured from vertical/horizontal) and converted to parent-relative rotations
 * by the compiler, because that is how a human reads a gait — "heel strike at
 * 25 degrees of hip flexion, knee almost straight" — and it makes the curves
 * verifiable by hand.
 *
 * Runtime layering, in order:
 *   1. locomotion blend tree      idle / walk / run / back / strafe / crouch,
 *                                 blended by speed and movement direction on a
 *                                 single shared stride phase so feet stay synced
 *   2. one-shot clips             reload, vault, cover slide, hit reactions,
 *                                 each with a bone mask and in/out ramps
 *   3. additive aim layer         spine chain carries the full aim so both
 *                                 hands stay welded to the weapon
 *   4. procedural look-at         neck leads, head follows, limited to a cone
 *   5. recoil + flinch springs    critically damped, driven by events
 *   6. two-bone foot IK           against physics raycasts, with pelvis drop
 *   7. gear springs               pouches, dump bag and antenna lag the body
 */

/* ================================================================== */
/* clip format                                                         */
/* ================================================================== */

const LEG_CHAINS = [
  ['thighL', 'shinL', 'footL'],
  ['thighR', 'shinR', 'footR'],
];

/**
 * @typedef {{duration:number, loop:boolean, tracks:Object, absLegs:boolean}} ClipDef
 * Track values are [time, x, y, z] in degrees; time is normalised 0..1.
 */

function sampleTrack(keys, t) {
  const n = keys.length;
  if (n === 1) return keys[0];
  let i = 0;
  while (i < n - 1 && t > keys[i + 1][0]) i++;
  const a = keys[i];
  const b = keys[Math.min(n - 1, i + 1)];
  const span = b[0] - a[0];
  if (span <= 1e-6) return a;
  let u = (t - a[0]) / span;
  u = u * u * (3 - 2 * u);        // smoothstep between keys: C1 without the overshoot
  return [t, lerp(a[1], b[1], u), lerp(a[2], b[2], u), lerp(a[3], b[3], u)];
}

/**
 * Compile a clip: resample every track onto a fixed grid of quaternions so the
 * per-frame cost is a table lookup and an nlerp instead of curve evaluation.
 */
const RESOLUTION = 32;

class Clip {
  constructor(name, def) {
    this.name = name;
    this.duration = def.duration ?? 1;
    this.loop = def.loop !== false;
    this.bones = [];
    this.data = null;
    this.rootPos = null;
    this.mask = def.mask || null;

    const tracks = { ...def.tracks };

    // absolute leg pitch -> parent-relative
    if (def.absLegs) {
      for (const chain of LEG_CHAINS) {
        const [thigh, shank, foot] = chain;
        const tT = tracks[thigh];
        const tS = tracks[shank];
        const tF = tracks[foot];
        if (!tT && !tS && !tF) continue;
        const times = new Set();
        for (const tr of [tT, tS, tF]) if (tr) for (const k of tr) times.add(k[0]);
        const sorted = [...times].sort((a, b) => a - b);
        const outT = [], outS = [], outF = [];
        for (const time of sorted) {
          const kT = tT ? sampleTrack(tT, time) : [time, 0, 0, 0];
          const kS = tS ? sampleTrack(tS, time) : [time, 0, 0, 0];
          const kF = tF ? sampleTrack(tF, time) : [time, 0, 0, 0];
          outT.push([time, kT[1], kT[2], kT[3]]);
          outS.push([time, kS[1] - kT[1], kS[2], kS[3]]);
          outF.push([time, kF[1] - kS[1], kF[2], kF[3]]);
        }
        if (tT) tracks[thigh] = outT;
        if (tS) tracks[shank] = outS;
        if (tF) tracks[foot] = outF;
      }
    }

    const names = Object.keys(tracks).filter((n) => BONE_INDEX[n] !== undefined);
    this.bones = names.map((n) => BONE_INDEX[n]);
    this.data = new Float32Array(names.length * (RESOLUTION + 1) * 4);

    const e = new THREE.Euler(0, 0, 0, 'XYZ');
    const q = new THREE.Quaternion();
    for (let bi = 0; bi < names.length; bi++) {
      const keys = tracks[names[bi]];
      for (let s = 0; s <= RESOLUTION; s++) {
        const t = s / RESOLUTION;
        const k = sampleTrack(keys, t);
        e.set(k[1] * DEG, k[2] * DEG, k[3] * DEG);
        q.setFromEuler(e);
        const o = (bi * (RESOLUTION + 1) + s) * 4;
        this.data[o] = q.x; this.data[o + 1] = q.y; this.data[o + 2] = q.z; this.data[o + 3] = q.w;
      }
    }

    if (def.root) {
      this.rootPos = new Float32Array((RESOLUTION + 1) * 3);
      for (let s = 0; s <= RESOLUTION; s++) {
        const t = s / RESOLUTION;
        const k = sampleTrack(def.root, t);
        this.rootPos[s * 3] = k[1];
        this.rootPos[s * 3 + 1] = k[2];
        this.rootPos[s * 3 + 2] = k[3];
      }
    }
  }

  /** Accumulate this clip at normalised time `t` with `weight` into a Pose. */
  sample(pose, t, weight, maskSet = null) {
    if (weight <= 1e-4) return;
    const tt = this.loop ? (t % 1 + 1) % 1 : clamp01(t);
    const f = tt * RESOLUTION;
    const i0 = Math.min(RESOLUTION, Math.floor(f));
    const i1 = Math.min(RESOLUTION, i0 + 1);
    const u = f - i0;
    const stride = (RESOLUTION + 1) * 4;
    for (let bi = 0; bi < this.bones.length; bi++) {
      const bone = this.bones[bi];
      if (maskSet && !maskSet.has(bone)) continue;
      const base = bi * stride;
      pose.accumulateLerp(bone, this.data, base + i0 * 4, base + i1 * 4, u, weight);
    }
    pose.totalWeight += weight;
    if (this.rootPos) {
      const a = i0 * 3, b = i1 * 3;
      pose.rootOffset[0] += lerp(this.rootPos[a], this.rootPos[b], u) * weight;
      pose.rootOffset[1] += lerp(this.rootPos[a + 1], this.rootPos[b + 1], u) * weight;
      pose.rootOffset[2] += lerp(this.rootPos[a + 2], this.rootPos[b + 2], u) * weight;
    }
  }
}

/* ================================================================== */
/* pose                                                                */
/* ================================================================== */

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qc = new THREE.Quaternion();
const _ea = new THREE.Euler(0, 0, 0, 'XYZ');

export class Pose {
  constructor() {
    this.q = new Float32Array(BONE_COUNT * 4);
    this.w = new Float32Array(BONE_COUNT);
    this.rootOffset = new Float32Array(3);
    this.reset();
  }

  reset() {
    const q = this.q;
    for (let i = 0; i < BONE_COUNT; i++) {
      q[i * 4] = 0; q[i * 4 + 1] = 0; q[i * 4 + 2] = 0; q[i * 4 + 3] = 1;
    }
    this.w.fill(0);
    this.totalWeight = 0;
    this.rootOffset[0] = this.rootOffset[1] = this.rootOffset[2] = 0;
  }

  /**
   * Blend one bone toward the lerp of two keyframes. Weighted nlerp: with the
   * running weight as the denominator this converges to the correct weighted
   * mean regardless of how many clips contribute.
   */
  accumulateLerp(bone, data, o0, o1, u, weight) {
    // interpolate the two keys
    let x = data[o0], y = data[o0 + 1], z = data[o0 + 2], w = data[o0 + 3];
    let x1 = data[o1], y1 = data[o1 + 1], z1 = data[o1 + 2], w1 = data[o1 + 3];
    if (x * x1 + y * y1 + z * z1 + w * w1 < 0) { x1 = -x1; y1 = -y1; z1 = -z1; w1 = -w1; }
    x = x + (x1 - x) * u; y = y + (y1 - y) * u; z = z + (z1 - z) * u; w = w + (w1 - w) * u;
    const il = 1 / (Math.hypot(x, y, z, w) || 1);
    x *= il; y *= il; z *= il; w *= il;

    const total = this.w[bone] + weight;
    const t = weight / total;
    const o = bone * 4;
    let ax = this.q[o], ay = this.q[o + 1], az = this.q[o + 2], aw = this.q[o + 3];
    if (ax * x + ay * y + az * z + aw * w < 0) { x = -x; y = -y; z = -z; w = -w; }
    ax += (x - ax) * t; ay += (y - ay) * t; az += (z - az) * t; aw += (w - aw) * t;
    const l = 1 / (Math.hypot(ax, ay, az, aw) || 1);
    this.q[o] = ax * l; this.q[o + 1] = ay * l; this.q[o + 2] = az * l; this.q[o + 3] = aw * l;
    this.w[bone] = total;
  }

  /** Post-multiply a delta rotation onto a bone (applied in the parent frame). */
  addDelta(bone, dq, weight = 1) {
    if (weight <= 1e-5) return;
    const o = bone * 4;
    _qa.set(this.q[o], this.q[o + 1], this.q[o + 2], this.q[o + 3]);
    _qb.copy(dq);
    if (weight < 1) _qb.slerp(_qc.identity(), 1 - weight);
    _qa.premultiply(_qb);
    this.q[o] = _qa.x; this.q[o + 1] = _qa.y; this.q[o + 2] = _qa.z; this.q[o + 3] = _qa.w;
  }

  /** Euler-degree convenience wrapper around addDelta. */
  addEuler(bone, x, y, z, weight = 1) {
    if (x === 0 && y === 0 && z === 0) return;
    _ea.set(x * DEG, y * DEG, z * DEG);
    _qc.setFromEuler(_ea);
    this.addDelta(bone, _qc, weight);
  }

  /** Write the pose into a live bone array. */
  applyTo(bones) {
    for (let i = 0; i < BONE_COUNT; i++) {
      const o = i * 4;
      const b = bones[i];
      b.quaternion.set(this.q[o], this.q[o + 1], this.q[o + 2], this.q[o + 3]);
      b.position.copy(BIND_LOCAL[i]);
    }
    const inv = 1 / Math.max(1, this.totalWeight);
    bones[0].position.x += this.rootOffset[0] * inv;
    bones[0].position.y += this.rootOffset[1] * inv;
    bones[0].position.z += this.rootOffset[2] * inv;
  }

  copyFrom(other) {
    this.q.set(other.q);
    this.w.set(other.w);
    this.rootOffset.set(other.rootOffset);
  }
}

/* ================================================================== */
/* authored clips                                                      */
/* ================================================================== */

const CLIP_DEFS = {
  /* Idle is close to the bind pose; the life comes from breathing and sway. */
  idle: {
    duration: 5.2, loop: true,
    tracks: {
      pelvis: [[0, 0, 1.5, 0.8], [0.35, 0, -0.5, -0.9], [0.7, 0, -1.8, -0.4], [1, 0, 1.5, 0.8]],
      spine1: [[0, 0, -0.6, -0.4], [0.5, 0, 0.8, 0.5], [1, 0, -0.6, -0.4]],
      spine2: [[0, 1.0, -0.5, 0], [0.5, -0.8, 0.6, 0], [1, 1.0, -0.5, 0]],
      spine3: [[0, -0.8, -0.4, -0.3], [0.5, 0.6, 0.5, 0.4], [1, -0.8, -0.4, -0.3]],
      neck: [[0, 0.6, 0.8, 0], [0.5, -0.5, -1.0, 0], [1, 0.6, 0.8, 0]],
      head: [[0, 0.4, 1.4, -0.5], [0.3, -0.3, -0.8, 0.4], [0.65, 0.5, 1.0, 0.2], [1, 0.4, 1.4, -0.5]],
      upperArmR: [[0, 0.8, 0, 0], [0.5, -0.7, 0, 0.6], [1, 0.8, 0, 0]],
      upperArmL: [[0, 0.6, 0, 0], [0.5, -0.6, 0, -0.5], [1, 0.6, 0, 0]],
    },
    root: [[0, 0, 0, 0], [0.5, 0, -0.006, 0], [1, 0, 0, 0]],
  },

  /* Alert idle: weight forward, weapon up, tighter. */
  idleAlert: {
    duration: 3.4, loop: true,
    absLegs: true,
    tracks: {
      thighL: [[0, 6, 0, -1.5], [0.5, 4, 0, -1.5], [1, 6, 0, -1.5]],
      shinL: [[0, -4, 0, 0], [0.5, -6, 0, 0], [1, -4, 0, 0]],
      footL: [[0, 0, 0, 0], [1, 0, 0, 0]],
      thighR: [[0, -8, 0, 1.5], [0.5, -6, 0, 1.5], [1, -8, 0, 1.5]],
      shinR: [[0, -16, 0, 0], [0.5, -18, 0, 0], [1, -16, 0, 0]],
      footR: [[0, -2, 0, 0], [1, -2, 0, 0]],
      pelvis: [[0, 2, -6, 1.4], [0.5, 2, -4.5, 1.0], [1, 2, -6, 1.4]],
      spine1: [[0, -3, 2, 0], [0.5, -2.4, 1.5, 0], [1, -3, 2, 0]],
      spine2: [[0, -4, 2.5, 0], [0.5, -3, 2, 0], [1, -4, 2.5, 0]],
      spine3: [[0, -3, 1.5, -1], [0.5, -2, 1.2, -1], [1, -3, 1.5, -1]],
      head: [[0, 2, 0.6, 0], [0.5, 1, -0.6, 0], [1, 2, 0.6, 0]],
    },
    root: [[0, 0, -0.030, 0], [0.5, 0, -0.036, 0], [1, 0, -0.030, 0]],
  },

  walk: {
    duration: 1.0, loop: true, absLegs: true,
    tracks: {
      thighL: [[0, 25, 0, -2], [0.12, 15, 0, -2], [0.25, 5, 0, -1], [0.38, -8, 0, -1],
        [0.5, -18, 0, -1], [0.62, -12, 0, -2], [0.75, 5, 0, -3], [0.88, 20, 0, -3], [1, 25, 0, -2]],
      shinL: [[0, 20, 0, 0], [0.12, 4, 0, 0], [0.25, 0, 0, 0], [0.38, -8, 0, 0],
        [0.5, -25, 0, 0], [0.62, -55, 0, 0], [0.75, -30, 0, 0], [0.88, 8, 0, 0], [1, 20, 0, 0]],
      footL: [[0, 6, 0, 0], [0.12, -2, 0, 0], [0.25, 0, 0, 0], [0.38, 3, 0, 0],
        [0.5, -18, 0, 0], [0.62, -12, 0, 0], [0.75, 2, 0, 0], [0.88, 6, 0, 0], [1, 6, 0, 0]],
      thighR: [[0, -18, 0, 2], [0.12, -12, 0, 2], [0.25, 5, 0, 3], [0.38, 20, 0, 3],
        [0.5, 25, 0, 2], [0.62, 15, 0, 2], [0.75, 5, 0, 1], [0.88, -8, 0, 1], [1, -18, 0, 2]],
      shinR: [[0, -25, 0, 0], [0.12, -55, 0, 0], [0.25, -30, 0, 0], [0.38, 8, 0, 0],
        [0.5, 20, 0, 0], [0.62, 4, 0, 0], [0.75, 0, 0, 0], [0.88, -8, 0, 0], [1, -25, 0, 0]],
      footR: [[0, -18, 0, 0], [0.12, -12, 0, 0], [0.25, 2, 0, 0], [0.38, 6, 0, 0],
        [0.5, 6, 0, 0], [0.62, -2, 0, 0], [0.75, 0, 0, 0], [0.88, 3, 0, 0], [1, -18, 0, 0]],
      pelvis: [[0, 1, 5, -2.5], [0.25, 1, 0, 2.5], [0.5, 1, -5, 2.5], [0.75, 1, 0, -2.5], [1, 1, 5, -2.5]],
      spine1: [[0, -2, -2.5, 1], [0.5, -2, 2.5, -1], [1, -2, -2.5, 1]],
      spine2: [[0, -2, -2, 1.2], [0.5, -2, 2, -1.2], [1, -2, -2, 1.2]],
      spine3: [[0, -1, -1.5, 0.8], [0.5, -1, 1.5, -0.8], [1, -1, -1.5, 0.8]],
      neck: [[0, 1, 1, -0.6], [0.5, 1, -1, 0.6], [1, 1, 1, -0.6]],
      head: [[0, 0, 1.5, -0.5], [0.5, 0, -1.5, 0.5], [1, 0, 1.5, -0.5]],
      clavicleR: [[0, 0, -1.5, 0], [0.5, 0, 1.5, 0], [1, 0, -1.5, 0]],
      clavicleL: [[0, 0, -1.5, 0], [0.5, 0, 1.5, 0], [1, 0, -1.5, 0]],
      upperArmR: [[0, -2, 0, 0], [0.5, 2, 0, 0], [1, -2, 0, 0]],
      upperArmL: [[0, 2, 0, 0], [0.5, -2, 0, 0], [1, 2, 0, 0]],
    },
    root: [[0, 0, -0.014, 0], [0.25, 0, 0.006, 0], [0.5, 0, -0.014, 0], [0.75, 0, 0.006, 0], [1, 0, -0.014, 0]],
  },

  run: {
    duration: 0.70, loop: true, absLegs: true,
    tracks: {
      thighL: [[0, 38, 0, -3], [0.12, 22, 0, -3], [0.25, 5, 0, -2], [0.38, -12, 0, -2],
        [0.5, -25, 0, -2], [0.62, -5, 0, -3], [0.75, 25, 0, -4], [0.88, 40, 0, -4], [1, 38, 0, -3]],
      shinL: [[0, 25, 0, 0], [0.12, -2, 0, 0], [0.25, -5, 0, 0], [0.38, -20, 0, 0],
        [0.5, -55, 0, 0], [0.62, -95, 0, 0], [0.75, -35, 0, 0], [0.88, 10, 0, 0], [1, 25, 0, 0]],
      footL: [[0, 2, 0, 0], [0.12, -8, 0, 0], [0.25, -5, 0, 0], [0.38, 0, 0, 0],
        [0.5, -28, 0, 0], [0.62, -18, 0, 0], [0.75, 5, 0, 0], [0.88, 4, 0, 0], [1, 2, 0, 0]],
      thighR: [[0, -25, 0, 3], [0.12, -5, 0, 3], [0.25, 25, 0, 4], [0.38, 40, 0, 4],
        [0.5, 38, 0, 3], [0.62, 22, 0, 3], [0.75, 5, 0, 2], [0.88, -12, 0, 2], [1, -25, 0, 3]],
      shinR: [[0, -55, 0, 0], [0.12, -95, 0, 0], [0.25, -35, 0, 0], [0.38, 10, 0, 0],
        [0.5, 25, 0, 0], [0.62, -2, 0, 0], [0.75, -5, 0, 0], [0.88, -20, 0, 0], [1, -55, 0, 0]],
      footR: [[0, -28, 0, 0], [0.12, -18, 0, 0], [0.25, 5, 0, 0], [0.38, 4, 0, 0],
        [0.5, 2, 0, 0], [0.62, -8, 0, 0], [0.75, -5, 0, 0], [0.88, 0, 0, 0], [1, -28, 0, 0]],
      pelvis: [[0, 4, 9, -4], [0.25, 4, 0, 4], [0.5, 4, -9, 4], [0.75, 4, 0, -4], [1, 4, 9, -4]],
      spine1: [[0, -6, -5, 2], [0.5, -6, 5, -2], [1, -6, -5, 2]],
      spine2: [[0, -6, -4, 2], [0.5, -6, 4, -2], [1, -6, -4, 2]],
      spine3: [[0, -4, -3, 1.5], [0.5, -4, 3, -1.5], [1, -4, -3, 1.5]],
      neck: [[0, 5, 2, -1], [0.5, 5, -2, 1], [1, 5, 2, -1]],
      head: [[0, 4, 3, -1], [0.5, 4, -3, 1], [1, 4, 3, -1]],
      clavicleR: [[0, -2, -4, 0], [0.5, -2, 4, 0], [1, -2, -4, 0]],
      clavicleL: [[0, -2, -4, 0], [0.5, -2, 4, 0], [1, -2, -4, 0]],
      upperArmR: [[0, -5, 0, 2], [0.5, 5, 0, 2], [1, -5, 0, 2]],
      upperArmL: [[0, 5, 0, -2], [0.5, -5, 0, -2], [1, 5, 0, -2]],
      lowerArmR: [[0, -4, 0, 0], [0.5, 4, 0, 0], [1, -4, 0, 0]],
      lowerArmL: [[0, 4, 0, 0], [0.5, -4, 0, 0], [1, 4, 0, 0]],
    },
    root: [[0, 0, -0.050, 0], [0.25, 0, 0.014, 0], [0.5, 0, -0.050, 0], [0.75, 0, 0.014, 0], [1, 0, -0.050, 0]],
  },

  back: {
    duration: 1.05, loop: true, absLegs: true,
    tracks: {
      thighL: [[0, -14, 0, -2], [0.25, 2, 0, -2], [0.5, 14, 0, -2], [0.75, 4, 0, -2], [1, -14, 0, -2]],
      shinL: [[0, -34, 0, 0], [0.25, -10, 0, 0], [0.5, -6, 0, 0], [0.75, -40, 0, 0], [1, -34, 0, 0]],
      footL: [[0, -10, 0, 0], [0.25, -2, 0, 0], [0.5, 4, 0, 0], [0.75, -6, 0, 0], [1, -10, 0, 0]],
      thighR: [[0, 14, 0, 2], [0.25, 4, 0, 2], [0.5, -14, 0, 2], [0.75, 2, 0, 2], [1, 14, 0, 2]],
      shinR: [[0, -6, 0, 0], [0.25, -40, 0, 0], [0.5, -34, 0, 0], [0.75, -10, 0, 0], [1, -6, 0, 0]],
      footR: [[0, 4, 0, 0], [0.25, -6, 0, 0], [0.5, -10, 0, 0], [0.75, -2, 0, 0], [1, 4, 0, 0]],
      pelvis: [[0, -2, 3, -2], [0.5, -2, -3, 2], [1, -2, 3, -2]],
      spine1: [[0, 2, -1.5, 0], [0.5, 2, 1.5, 0], [1, 2, -1.5, 0]],
      spine2: [[0, 2, -1.5, 0], [0.5, 2, 1.5, 0], [1, 2, -1.5, 0]],
      spine3: [[0, 1, -1, 0], [0.5, 1, 1, 0], [1, 1, -1, 0]],
    },
    root: [[0, 0, -0.018, 0], [0.25, 0, -0.006, 0], [0.5, 0, -0.018, 0], [0.75, 0, -0.006, 0], [1, 0, -0.018, 0]],
  },

  /* Side-step. Authored right; the left variant is mirrored at load. */
  strafeR: {
    duration: 0.86, loop: true, absLegs: true,
    tracks: {
      thighR: [[0, 4, 0, 14], [0.25, 2, 0, 22], [0.5, 6, 0, 8], [0.75, 8, 0, 2], [1, 4, 0, 14]],
      shinR: [[0, -12, 0, 0], [0.25, -30, 0, 0], [0.5, -10, 0, 0], [0.75, -18, 0, 0], [1, -12, 0, 0]],
      footR: [[0, -2, 0, -6], [0.25, -6, 0, -10], [0.5, 0, 0, -3], [0.75, 2, 0, 0], [1, -2, 0, -6]],
      thighL: [[0, 6, 0, 2], [0.25, 4, 0, -2], [0.5, 2, 0, 16], [0.75, 4, 0, 20], [1, 6, 0, 2]],
      shinL: [[0, -14, 0, 0], [0.25, -10, 0, 0], [0.5, -26, 0, 0], [0.75, -34, 0, 0], [1, -14, 0, 0]],
      footL: [[0, 0, 0, 2], [0.25, 2, 0, 4], [0.5, -4, 0, -4], [0.75, -6, 0, -8], [1, 0, 0, 2]],
      pelvis: [[0, 1, -3, -3], [0.5, 1, 3, 3], [1, 1, -3, -3]],
      spine1: [[0, -2, 1.5, 2], [0.5, -2, -1.5, -2], [1, -2, 1.5, 2]],
      spine2: [[0, -2, 1.5, 2], [0.5, -2, -1.5, -2], [1, -2, 1.5, 2]],
      spine3: [[0, -1, 1, 1], [0.5, -1, -1, -1], [1, -1, 1, 1]],
      head: [[0, 0, -2, 0], [0.5, 0, 2, 0], [1, 0, -2, 0]],
    },
    root: [[0, 0, -0.020, 0], [0.25, 0, -0.008, 0], [0.5, 0, -0.020, 0], [0.75, 0, -0.008, 0], [1, 0, -0.020, 0]],
  },

  crouchIdle: {
    duration: 4.0, loop: true, absLegs: true,
    tracks: {
      thighL: [[0, 46, 0, -8], [0.5, 44, 0, -8], [1, 46, 0, -8]],
      shinL: [[0, -50, 0, 0], [0.5, -52, 0, 0], [1, -50, 0, 0]],
      footL: [[0, 0, 0, 0], [1, 0, 0, 0]],
      thighR: [[0, 40, 0, 9], [0.5, 38, 0, 9], [1, 40, 0, 9]],
      shinR: [[0, -60, 0, 0], [0.5, -62, 0, 0], [1, -60, 0, 0]],
      footR: [[0, -4, 0, 0], [1, -4, 0, 0]],
      pelvis: [[0, 12, -4, 1], [0.5, 12.5, -3, 1], [1, 12, -4, 1]],
      spine1: [[0, -8, 2, 0], [0.5, -8.5, 1.5, 0], [1, -8, 2, 0]],
      spine2: [[0, -8, 2, 0], [0.5, -8.5, 1.5, 0], [1, -8, 2, 0]],
      spine3: [[0, -6, 1, 0], [0.5, -6, 1, 0], [1, -6, 1, 0]],
      neck: [[0, 10, 0, 0], [1, 10, 0, 0]],
      head: [[0, 8, 0.8, 0], [0.5, 8, -0.8, 0], [1, 8, 0.8, 0]],
    },
    root: [[0, 0, -0.275, 0.02], [0.5, 0, -0.280, 0.02], [1, 0, -0.275, 0.02]],
  },

  crouchWalk: {
    duration: 1.15, loop: true, absLegs: true,
    tracks: {
      thighL: [[0, 58, 0, -8], [0.25, 44, 0, -8], [0.5, 30, 0, -8], [0.75, 44, 0, -8], [1, 58, 0, -8]],
      shinL: [[0, -30, 0, 0], [0.25, -46, 0, 0], [0.5, -60, 0, 0], [0.75, -72, 0, 0], [1, -30, 0, 0]],
      footL: [[0, -4, 0, 0], [0.25, -2, 0, 0], [0.5, -14, 0, 0], [0.75, -6, 0, 0], [1, -4, 0, 0]],
      thighR: [[0, 30, 0, 9], [0.25, 44, 0, 9], [0.5, 58, 0, 9], [0.75, 44, 0, 9], [1, 30, 0, 9]],
      shinR: [[0, -60, 0, 0], [0.25, -72, 0, 0], [0.5, -30, 0, 0], [0.75, -46, 0, 0], [1, -60, 0, 0]],
      footR: [[0, -14, 0, 0], [0.25, -6, 0, 0], [0.5, -4, 0, 0], [0.75, -2, 0, 0], [1, -14, 0, 0]],
      pelvis: [[0, 12, 5, -3], [0.25, 12, 0, 3], [0.5, 12, -5, 3], [0.75, 12, 0, -3], [1, 12, 5, -3]],
      spine1: [[0, -9, -3, 1], [0.5, -9, 3, -1], [1, -9, -3, 1]],
      spine2: [[0, -9, -3, 1], [0.5, -9, 3, -1], [1, -9, -3, 1]],
      spine3: [[0, -6, -2, 1], [0.5, -6, 2, -1], [1, -6, -2, 1]],
      neck: [[0, 10, 0, 0], [1, 10, 0, 0]],
      head: [[0, 8, 1, 0], [0.5, 8, -1, 0], [1, 8, 1, 0]],
    },
    root: [[0, 0, -0.268, 0.02], [0.25, 0, -0.250, 0.02], [0.5, 0, -0.268, 0.02], [0.75, 0, -0.250, 0.02], [1, 0, -0.268, 0.02]],
  },

  /* ---- one-shots -------------------------------------------------- */

  /**
   * Reload. The right hand never leaves the grip — it cannot, the weapon is
   * bound to it — so the left arm does the whole job: drop the magazine, reach
   * the chest rig, insert, then slap the bolt release. 2.55 s.
   */
  reload: {
    duration: 2.55, loop: false,
    tracks: {
      upperArmL: [[0, 0, 0, 0], [0.10, 26, -14, -18], [0.22, 34, -18, -26], [0.36, 6, 24, -34],
        [0.5, 2, 28, -30], [0.66, 22, -6, -22], [0.80, 30, -12, -16], [0.92, 6, -2, -4], [1, 0, 0, 0]],
      lowerArmL: [[0, 0, 0, 0], [0.10, -14, 8, 0], [0.22, -26, 14, 0], [0.36, -46, -12, 0],
        [0.5, -50, -18, 0], [0.66, -24, 6, 0], [0.80, -12, 10, 0], [0.92, -4, 2, 0], [1, 0, 0, 0]],
      handL: [[0, 0, 0, 0], [0.22, 18, 0, -22], [0.36, -12, 0, 34], [0.5, -18, 0, 30],
        [0.66, 10, 0, -10], [0.8, 22, 0, -20], [1, 0, 0, 0]],
      spine2: [[0, 0, 0, 0], [0.3, -3, 6, 0], [0.55, -5, 8, 0], [0.8, -2, 4, 0], [1, 0, 0, 0]],
      spine3: [[0, 0, 0, 0], [0.3, -4, 8, 0], [0.55, -6, 10, 0], [0.8, -3, 5, 0], [1, 0, 0, 0]],
      neck: [[0, 0, 0, 0], [0.3, -6, -4, 0], [0.55, -8, -6, 0], [0.8, -4, -2, 0], [1, 0, 0, 0]],
      head: [[0, 0, 0, 0], [0.3, -8, -6, 0], [0.55, -10, -8, 0], [0.8, -5, -3, 0], [1, 0, 0, 0]],
      upperArmR: [[0, 0, 0, 0], [0.4, -3, 2, 0], [0.7, -4, 3, 0], [1, 0, 0, 0]],
    },
  },

  /** Dive into cover: plant, drop the shoulder, slide. */
  coverSlide: {
    duration: 1.05, loop: false, absLegs: true,
    tracks: {
      thighL: [[0, 0, 0, 0], [0.25, 55, 0, -10], [0.5, 74, 0, -16], [0.75, 62, 0, -12], [1, 8, 0, -2]],
      shinL: [[0, 0, 0, 0], [0.25, -20, 0, 0], [0.5, -30, 0, 0], [0.75, -40, 0, 0], [1, -6, 0, 0]],
      footL: [[0, 0, 0, 0], [0.5, -20, 0, 0], [1, 0, 0, 0]],
      thighR: [[0, 0, 0, 0], [0.25, 20, 0, 12], [0.5, 5, 0, 20], [0.75, -10, 0, 16], [1, -6, 0, 3]],
      shinR: [[0, 0, 0, 0], [0.25, -50, 0, 0], [0.5, -95, 0, 0], [0.75, -80, 0, 0], [1, -16, 0, 0]],
      footR: [[0, 0, 0, 0], [0.5, -30, 0, 0], [1, -2, 0, 0]],
      pelvis: [[0, 0, 0, 0], [0.3, 10, 12, 8], [0.55, 16, 16, 12], [0.8, 8, 10, 6], [1, 0, 0, 0]],
      spine1: [[0, 0, 0, 0], [0.5, -14, -8, -4], [1, 0, 0, 0]],
      spine2: [[0, 0, 0, 0], [0.5, -12, -8, -4], [1, 0, 0, 0]],
      spine3: [[0, 0, 0, 0], [0.5, -10, -6, -3], [1, 0, 0, 0]],
      upperArmR: [[0, 0, 0, 0], [0.5, -12, 6, 8], [1, 0, 0, 0]],
      upperArmL: [[0, 0, 0, 0], [0.5, -10, -8, -6], [1, 0, 0, 0]],
      head: [[0, 0, 0, 0], [0.5, 6, -8, 0], [1, 0, 0, 0]],
    },
    root: [[0, 0, 0, 0], [0.3, 0, -0.30, 0], [0.6, 0, -0.42, 0], [0.85, 0, -0.22, 0], [1, 0, 0, 0]],
  },

  /** Vault a low wall. */
  vault: {
    duration: 0.95, loop: false, absLegs: true,
    tracks: {
      thighL: [[0, 0, 0, 0], [0.2, 70, 0, -6], [0.45, 95, 0, -8], [0.7, 40, 0, -4], [1, 0, 0, 0]],
      shinL: [[0, 0, 0, 0], [0.2, -40, 0, 0], [0.45, -20, 0, 0], [0.7, -50, 0, 0], [1, -6, 0, 0]],
      footL: [[0, 0, 0, 0], [0.45, 10, 0, 0], [1, 0, 0, 0]],
      thighR: [[0, 0, 0, 0], [0.2, -20, 0, 8], [0.45, 30, 0, 14], [0.7, 80, 0, 8], [1, 0, 0, 0]],
      shinR: [[0, 0, 0, 0], [0.2, -60, 0, 0], [0.45, -85, 0, 0], [0.7, -55, 0, 0], [1, -10, 0, 0]],
      footR: [[0, 0, 0, 0], [0.45, -25, 0, 0], [1, -2, 0, 0]],
      pelvis: [[0, 0, 0, 0], [0.3, -12, 6, 0], [0.6, -6, 10, 0], [1, 0, 0, 0]],
      spine1: [[0, 0, 0, 0], [0.35, -20, -4, 0], [0.7, -10, -6, 0], [1, 0, 0, 0]],
      spine2: [[0, 0, 0, 0], [0.35, -18, -4, 0], [0.7, -8, -6, 0], [1, 0, 0, 0]],
      spine3: [[0, 0, 0, 0], [0.35, -14, -3, 0], [0.7, -6, -4, 0], [1, 0, 0, 0]],
      upperArmL: [[0, 0, 0, 0], [0.25, -40, 20, -20], [0.5, -20, 10, -10], [1, 0, 0, 0]],
      lowerArmL: [[0, 0, 0, 0], [0.25, -30, 0, 0], [0.5, -50, 0, 0], [1, 0, 0, 0]],
      head: [[0, 0, 0, 0], [0.4, -8, 0, 0], [1, 0, 0, 0]],
    },
    root: [[0, 0, 0, 0], [0.3, 0, 0.30, -0.10], [0.55, 0, 0.42, -0.20], [0.8, 0, 0.16, -0.10], [1, 0, 0, 0]],
  },

  /* Hit reactions, one per body region. Short, sharp, additive-ish. */
  hitHead: {
    duration: 0.55, loop: false,
    tracks: {
      head: [[0, 0, 0, 0], [0.12, -22, 14, -12], [0.35, 8, -5, 4], [1, 0, 0, 0]],
      neck: [[0, 0, 0, 0], [0.12, -14, 9, -8], [0.35, 5, -3, 2], [1, 0, 0, 0]],
      spine3: [[0, 0, 0, 0], [0.15, -8, 5, -4], [0.4, 3, -2, 1], [1, 0, 0, 0]],
      spine2: [[0, 0, 0, 0], [0.15, -5, 3, -2], [1, 0, 0, 0]],
    },
  },
  hitTorso: {
    duration: 0.62, loop: false,
    tracks: {
      spine1: [[0, 0, 0, 0], [0.12, 7, -3, 2], [0.4, -3, 1, -1], [1, 0, 0, 0]],
      spine2: [[0, 0, 0, 0], [0.12, 10, -5, 3], [0.4, -4, 2, -1], [1, 0, 0, 0]],
      spine3: [[0, 0, 0, 0], [0.12, 12, -6, 4], [0.4, -5, 2, -2], [1, 0, 0, 0]],
      neck: [[0, 0, 0, 0], [0.14, -10, 4, -3], [1, 0, 0, 0]],
      head: [[0, 0, 0, 0], [0.14, -12, 5, -4], [0.45, 4, -2, 1], [1, 0, 0, 0]],
      upperArmR: [[0, 0, 0, 0], [0.12, -14, 6, 8], [0.45, 4, 0, -2], [1, 0, 0, 0]],
      upperArmL: [[0, 0, 0, 0], [0.12, -12, -6, -8], [0.45, 3, 0, 2], [1, 0, 0, 0]],
      pelvis: [[0, 0, 0, 0], [0.15, 3, -2, 1], [1, 0, 0, 0]],
    },
  },
  hitArmR: {
    duration: 0.5, loop: false,
    tracks: {
      upperArmR: [[0, 0, 0, 0], [0.1, -26, 12, 16], [0.35, 6, -2, -4], [1, 0, 0, 0]],
      lowerArmR: [[0, 0, 0, 0], [0.1, -20, 0, 0], [0.35, 5, 0, 0], [1, 0, 0, 0]],
      clavicleR: [[0, 0, 0, 0], [0.1, -8, 5, 6], [1, 0, 0, 0]],
      spine3: [[0, 0, 0, 0], [0.12, 4, -6, 3], [1, 0, 0, 0]],
    },
  },
  hitArmL: {
    duration: 0.5, loop: false,
    tracks: {
      upperArmL: [[0, 0, 0, 0], [0.1, -26, -12, -16], [0.35, 6, 2, 4], [1, 0, 0, 0]],
      lowerArmL: [[0, 0, 0, 0], [0.1, -20, 0, 0], [0.35, 5, 0, 0], [1, 0, 0, 0]],
      clavicleL: [[0, 0, 0, 0], [0.1, -8, -5, -6], [1, 0, 0, 0]],
      spine3: [[0, 0, 0, 0], [0.12, 4, 6, -3], [1, 0, 0, 0]],
    },
  },
  hitLegs: {
    duration: 0.7, loop: false,
    tracks: {
      pelvis: [[0, 0, 0, 0], [0.14, 9, -4, -6], [0.45, -3, 1, 2], [1, 0, 0, 0]],
      spine1: [[0, 0, 0, 0], [0.14, -8, 2, 3], [1, 0, 0, 0]],
      spine2: [[0, 0, 0, 0], [0.14, -6, 2, 2], [1, 0, 0, 0]],
      thighR: [[0, 0, 0, 0], [0.16, 14, 0, 6], [0.5, -4, 0, -2], [1, 0, 0, 0]],
      shinR: [[0, 0, 0, 0], [0.16, -22, 0, 0], [0.5, 4, 0, 0], [1, 0, 0, 0]],
      head: [[0, 0, 0, 0], [0.18, -10, 0, 0], [1, 0, 0, 0]],
    },
    root: [[0, 0, 0, 0], [0.2, 0, -0.075, 0], [0.55, 0, -0.02, 0], [1, 0, 0, 0]],
  },
};

/** Mirror a clip across the sagittal plane. */
function mirrorDef(def) {
  const out = { duration: def.duration, loop: def.loop, absLegs: def.absLegs, root: null };
  out.tracks = {};
  for (const [name, keys] of Object.entries(def.tracks)) {
    let target = name;
    if (name.endsWith('L')) target = `${name.slice(0, -1)}R`;
    else if (name.endsWith('R')) target = `${name.slice(0, -1)}L`;
    out.tracks[target] = keys.map((k) => [k[0], k[1], -k[2], -k[3]]);
  }
  if (def.root) out.root = def.root.map((k) => [k[0], -k[1], k[2], k[3]]);
  return out;
}

CLIP_DEFS.strafeL = mirrorDef(CLIP_DEFS.strafeR);

export const CLIPS = {};
for (const [name, def] of Object.entries(CLIP_DEFS)) CLIPS[name] = new Clip(name, def);

/**
 * Shouldering the weapon is an additive offset rather than a clip: it has to
 * add to whatever the locomotion is doing, not average with it.
 * [bone, x, y, z] in degrees.
 */
const ADS_OFFSET = [
  ['upperArmR', -6, -2, 6], ['lowerArmR', 6, 4, 0],
  ['upperArmL', -4, 4, -6], ['lowerArmL', 8, -4, 0],
  ['clavicleR', -4, -3, 0], ['clavicleL', -2, 2, 0],
  ['neck', -2, -3, 0], ['head', -3, -4, 2], ['spine3', -2, -4, 0],
].map(([n, x, y, z]) => [BONE_INDEX[n], x, y, z]);

/** Bone masks for the one-shot layer. */
const UPPER_BODY = new Set(['spine1', 'spine2', 'spine3', 'neck', 'head',
  'clavicleL', 'clavicleR', 'upperArmL', 'upperArmR', 'lowerArmL', 'lowerArmR', 'handL', 'handR',
].map((n) => BONE_INDEX[n]));

const ALL_BONES = null;

/* ================================================================== */
/* animator                                                            */
/* ================================================================== */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
// _alignBone gets its own scratch: it is called with vectors that live in _v1.._v4
const _s1 = new THREE.Vector3();
const _s2 = new THREE.Vector3();
const _sq1 = new THREE.Quaternion();
const _sq2 = new THREE.Quaternion();
const _sq3 = new THREE.Quaternion();
const _sm = new THREE.Matrix4();
const _ik = {
  hip: new THREE.Vector3(), knee: new THREE.Vector3(), ankle: new THREE.Vector3(),
  target: new THREE.Vector3(), toTarget: new THREE.Vector3(), axis: new THREE.Vector3(),
  pole: new THREE.Vector3(), cur: new THREE.Vector3(), newKnee: new THREE.Vector3(),
  finalAnkle: new THREE.Vector3(), down: new THREE.Vector3(0, -1, 0), probe: new THREE.Vector3(),
};
const UP = new THREE.Vector3(0, 1, 0);

const IDX = {
  pelvis: BONE_INDEX.pelvis, spine1: BONE_INDEX.spine1, spine2: BONE_INDEX.spine2,
  spine3: BONE_INDEX.spine3, neck: BONE_INDEX.neck, head: BONE_INDEX.head,
  handR: BONE_INDEX.handR, handL: BONE_INDEX.handL,
  upperArmR: BONE_INDEX.upperArmR, upperArmL: BONE_INDEX.upperArmL,
  lowerArmR: BONE_INDEX.lowerArmR, lowerArmL: BONE_INDEX.lowerArmL,
  clavicleR: BONE_INDEX.clavicleR, clavicleL: BONE_INDEX.clavicleL,
  thighL: BONE_INDEX.thighL, shinL: BONE_INDEX.shinL, footL: BONE_INDEX.footL, toeL: BONE_INDEX.toeL,
  thighR: BONE_INDEX.thighR, shinR: BONE_INDEX.shinR, footR: BONE_INDEX.footR, toeR: BONE_INDEX.toeR,
  gearFrontL: BONE_INDEX.gearFrontL, gearFrontR: BONE_INDEX.gearFrontR,
  gearBack: BONE_INDEX.gearBack, gearAnt: BONE_INDEX.gearAnt,
  gearHipR: BONE_INDEX.gearHipR, gearHipL: BONE_INDEX.gearHipL,
};

const THIGH_LEN = BIND_POSITION[IDX.thighL].distanceTo(BIND_POSITION[IDX.shinL]);
const SHIN_LEN = BIND_POSITION[IDX.shinL].distanceTo(BIND_POSITION[IDX.footL]);
const ANKLE_HEIGHT = BIND_POSITION[IDX.footL].y;

export class Animator {
  /**
   * @param {CharacterInstance} character
   * @param {Object} game  used only for physics raycasts; every call is guarded
   */
  constructor(character, game) {
    this.character = character;
    this.game = game;
    this.bones = character.rig.bones;
    this.pose = new Pose();

    // locomotion state
    this.phase = Math.random();
    this.speed = 0;
    this.moveAngle = 0;         // radians, 0 = forward, +left
    this.crouch = 0;
    this.stance = 'stand';
    this.alertness = 0;         // 0 relaxed idle, 1 weapon-up idle
    this.aimBlend = 0;          // 0 carry, 1 shouldered

    // aim
    this.aimYaw = 0; this.aimPitch = 0;
    this._aimYaw = 0; this._aimPitch = 0;
    this.lookYaw = 0; this.lookPitch = 0;
    this._lookYaw = 0; this._lookPitch = 0;
    this.lookWeight = 0;

    // one-shot layer
    this.oneShots = [];

    // springs
    this.recoilPitch = new Spring(320, 0.55);
    this.recoilYaw = new Spring(280, 0.5);
    this.recoilPush = new Spring(240, 0.6);
    this.flinch = new Spring(180, 0.45);
    this.breath = 0;
    this.leanSpring = new Spring(90, 0.9);

    // foot IK
    this.ikEnabled = true;
    this.footY = [0, 0];
    this.footN = [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0)];
    this.pelvisDrop = 0;
    this._ikTimer = 0;

    // gear springs: [x,y,z] euler in degrees with velocity
    this.gear = [];
    for (let i = 0; i < 6; i++) this.gear.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 });
    this._lastVel = new THREE.Vector3();
    this._accel = new THREE.Vector3();

    this.time = Math.random() * 10;
    this.ragdoll = null;
    this.ragdollBlend = 0;
  }

  /* ---------------------------------------------------------------- */

  /** Queue a one-shot clip. */
  play(name, { weight = 1, speed = 1, fade = 0.12, mask = 'upper', priority = 0 } = {}) {
    const clip = CLIPS[name];
    if (!clip) return null;
    // a new one-shot on the same mask replaces an older, lower-priority one
    for (let i = this.oneShots.length - 1; i >= 0; i--) {
      const s = this.oneShots[i];
      if (s.name === name || (s.mask === mask && s.priority <= priority)) s.stopping = true;
    }
    const shot = {
      name, clip, t: 0, weight: 0, target: weight, speed, fade, priority,
      mask, maskSet: mask === 'upper' ? UPPER_BODY : ALL_BONES, stopping: false,
    };
    this.oneShots.push(shot);
    return shot;
  }

  stop(name) {
    for (const s of this.oneShots) if (s.name === name) s.stopping = true;
  }

  isPlaying(name) {
    return this.oneShots.some((s) => s.name === name && !s.stopping);
  }

  /** Weapon recoil impulse. */
  kick(power = 1) {
    this.recoilPitch.kick(9.5 * power);
    this.recoilYaw.kick((Math.random() - 0.5) * 6 * power);
    this.recoilPush.kick(-5.5 * power);
  }

  /** Damage flinch; `region` picks the reaction clip. */
  hitReact(region = 'torso', power = 1) {
    this.flinch.kick(6 * power);
    const map = { head: 'hitHead', torso: 'hitTorso', chest: 'hitTorso', arms: 'hitArmR', armR: 'hitArmR', armL: 'hitArmL', legs: 'hitLegs' };
    const name = map[region] || 'hitTorso';
    this.play(name, { weight: clamp01(0.55 + power * 0.45), fade: 0.05, mask: name === 'hitLegs' ? 'all' : 'upper', priority: 2 });
  }

  /* ---------------------------------------------------------------- */

  /**
   * @param {number} dt
   * @param {Object} state {speed, moveAngle, crouch, alertness, aimYaw, aimPitch,
   *                        lookYaw, lookPitch, lookWeight, aimBlend, grounded}
   */
  update(dt, state) {
    this.time += dt;
    const d = Math.min(dt, 0.1);

    if (state) {
      this.speed = state.speed ?? this.speed;
      this.moveAngle = state.moveAngle ?? this.moveAngle;
      this.crouch = state.crouch ?? this.crouch;
      this.alertness = state.alertness ?? this.alertness;
      this.aimYaw = state.aimYaw ?? this.aimYaw;
      this.aimPitch = state.aimPitch ?? this.aimPitch;
      this.lookYaw = state.lookYaw ?? this.lookYaw;
      this.lookPitch = state.lookPitch ?? this.lookPitch;
      this.lookWeight = state.lookWeight ?? this.lookWeight;
      this.aimBlend = state.aimBlend ?? this.aimBlend;
    }

    if (this.ragdollBlend >= 1) return;   // the ragdoll owns the skeleton now

    this._advancePhase(d);
    this._buildBasePose(d);
    this._updateOneShots(d);
    this._aimLayer(d);
    this._proceduralLayer(d);

    this.pose.applyTo(this.bones);
    this.bones[0].parent?.updateMatrixWorld(true);

    if (this.ikEnabled) this._footIK(d);
    this._gearSprings(d);
  }

  _advancePhase(d) {
    const stride = lerp(1.42, 2.35, clamp01((this.speed - 1.4) / 3.2));
    const crouchStride = 1.15;
    const s = lerp(stride, crouchStride, this.crouch);
    if (this.speed > 0.06) {
      this.phase += (this.speed / Math.max(0.4, s)) * d;
    } else {
      // ease the phase to a foot-down pose instead of freezing mid-stride
      const targetPhase = Math.round(this.phase * 2) / 2;
      this.phase += (targetPhase - this.phase) * (1 - Math.exp(-9 * d));
    }
    this.phase %= 1;
    if (this.phase < 0) this.phase += 1;
  }

  /** Directional locomotion blend, all clips sharing one stride phase. */
  _buildBasePose(d) {
    const pose = this.pose;
    pose.reset();

    const sp = this.speed;
    const moving = smoothstep(0.05, 0.65, sp);
    const runBlend = smoothstep(1.7, 3.5, sp);
    const ang = this.moveAngle;

    // directional lobes: forward, back, left, right
    const fwd = Math.max(0, Math.cos(ang));
    const back = Math.max(0, -Math.cos(ang));
    const left = Math.max(0, Math.sin(ang));
    const right = Math.max(0, -Math.sin(ang));
    const dirTotal = fwd + back + left + right || 1;

    const standing = 1 - this.crouch;
    const idleW = (1 - moving) * standing;
    const alert = clamp01(this.alertness);

    if (idleW > 1e-3) {
      CLIPS.idle.sample(pose, this.time / CLIPS.idle.duration, idleW * (1 - alert));
      CLIPS.idleAlert.sample(pose, this.time / CLIPS.idleAlert.duration, idleW * alert);
    }
    if (moving > 1e-3 && standing > 1e-3) {
      const w = moving * standing / dirTotal;
      if (fwd > 1e-3) {
        CLIPS.walk.sample(pose, this.phase, fwd * w * (1 - runBlend));
        CLIPS.run.sample(pose, this.phase, fwd * w * runBlend);
      }
      if (back > 1e-3) CLIPS.back.sample(pose, this.phase, back * w);
      if (left > 1e-3) CLIPS.strafeL.sample(pose, this.phase, left * w);
      if (right > 1e-3) CLIPS.strafeR.sample(pose, this.phase, right * w);
    }
    if (this.crouch > 1e-3) {
      CLIPS.crouchIdle.sample(pose, this.time / CLIPS.crouchIdle.duration, (1 - moving) * this.crouch);
      CLIPS.crouchWalk.sample(pose, this.phase, moving * this.crouch);
    }

    // weapon shouldering rides additively on top of everything
    const ads = clamp01(this.aimBlend);
    if (ads > 1e-3) {
      for (const [b, x, y, z] of ADS_OFFSET) pose.addEuler(b, x * ads, y * ads, z * ads);
    }
  }

  _updateOneShots(d) {
    for (let i = this.oneShots.length - 1; i >= 0; i--) {
      const s = this.oneShots[i];
      s.t += (d * s.speed) / s.clip.duration;
      const fadeRate = d / Math.max(0.01, s.fade);
      if (s.stopping || s.t >= 1) s.weight = Math.max(0, s.weight - fadeRate);
      else s.weight = Math.min(s.target, s.weight + fadeRate);
      // ease out over the last 15% so the pose returns instead of snapping
      const tail = s.t > 0.85 && !s.clip.loop ? 1 - (s.t - 0.85) / 0.15 : 1;
      const w = s.weight * clamp01(tail);
      if (w <= 1e-4 && (s.stopping || s.t >= 1)) { this.oneShots.splice(i, 1); continue; }
      // one-shots must dominate rather than average with the locomotion blend
      s.clip.sample(this.pose, s.t, w * 8, s.maskSet);
    }
  }

  /**
   * Aim layer. The whole spine chain carries the aim so that both hands — and
   * therefore the weapon welded to the right one — rotate about a single pivot
   * and never separate.
   */
  _aimLayer(d) {
    this._aimYaw = dampAngle(this._aimYaw, clamp(this.aimYaw, -1.4, 1.4), 11, d);
    this._aimPitch = damp(this._aimPitch, clamp(this.aimPitch, -0.95, 0.95), 12, d);

    const yaw = this._aimYaw / DEG;
    const pitch = this._aimPitch / DEG;
    const pose = this.pose;

    pose.addEuler(IDX.spine1, pitch * 0.20, yaw * 0.24, yaw * 0.03);
    pose.addEuler(IDX.spine2, pitch * 0.30, yaw * 0.34, yaw * 0.04);
    pose.addEuler(IDX.spine3, pitch * 0.50, yaw * 0.42, yaw * 0.05);
    // the head fights the spine so the eyes stay on the target, not the sky
    pose.addEuler(IDX.neck, -pitch * 0.14, -yaw * 0.06, 0);
    pose.addEuler(IDX.head, -pitch * 0.16, -yaw * 0.06, 0);
    // counter-rotate the hips a little so the stance does not twist off its feet
    pose.addEuler(IDX.pelvis, 0, yaw * 0.10, 0);

    // procedural look-at with a limit cone and a natural neck lead
    const lw = clamp01(this.lookWeight);
    if (lw > 1e-3) {
      this._lookYaw = dampAngle(this._lookYaw, clamp(this.lookYaw, -1.25, 1.25), 7.5, d);
      this._lookPitch = damp(this._lookPitch, clamp(this.lookPitch, -0.7, 0.7), 8.5, d);
      const ly = (this._lookYaw / DEG) * lw;
      const lp = (this._lookPitch / DEG) * lw;
      pose.addEuler(IDX.neck, lp * 0.38, ly * 0.34, ly * 0.06);
      pose.addEuler(IDX.head, lp * 0.62, ly * 0.66, -ly * 0.10);
    }
  }

  /** Breathing, recoil, flinch and lean. */
  _proceduralLayer(d) {
    const pose = this.pose;
    const t = this.time;

    // breathing: amplitude and rate rise with exertion
    const exert = clamp01(this.speed / 4.2) * 0.7 + this.alertness * 0.3;
    const rate = lerp(0.55, 1.9, exert);
    this.breath += d * rate;
    const br = Math.sin(this.breath * Math.PI * 2);
    const amp = lerp(0.7, 2.1, exert);
    pose.addEuler(IDX.spine1, -br * amp * 0.30, 0, 0);
    pose.addEuler(IDX.spine2, -br * amp * 0.35, 0, 0);
    pose.addEuler(IDX.spine3, -br * amp * 0.25, 0, 0);
    pose.addEuler(IDX.clavicleR, -br * amp * 0.5, 0, -br * amp * 0.35);
    pose.addEuler(IDX.clavicleL, -br * amp * 0.5, 0, br * amp * 0.35);

    // idle micro-sway, so a stationary enemy is never mathematically still
    const sway = wobble(t * 0.6, 3.1) * (1 - clamp01(this.speed)) * 0.8;
    pose.addEuler(IDX.pelvis, 0, sway * 0.6, sway * 0.4);
    pose.addEuler(IDX.spine2, sway * 0.2, -sway * 0.3, 0);
    pose.addEuler(IDX.head, wobble(t * 0.9, 7.7) * 0.7, wobble(t * 0.75, 1.4) * 0.9, 0);

    // recoil
    const rp = this.recoilPitch.update(d);
    const ry = this.recoilYaw.update(d);
    const rz = this.recoilPush.update(d);
    if (Math.abs(rp) > 0.01 || Math.abs(ry) > 0.01) {
      pose.addEuler(IDX.handR, rp * 0.55, ry * 0.5, 0);
      pose.addEuler(IDX.lowerArmR, rp * 0.30, ry * 0.2, 0);
      pose.addEuler(IDX.upperArmR, rp * 0.18, ry * 0.2, rz * 0.2);
      pose.addEuler(IDX.lowerArmL, rp * 0.22, -ry * 0.2, 0);
      pose.addEuler(IDX.upperArmL, rp * 0.12, -ry * 0.1, 0);
      pose.addEuler(IDX.spine3, rp * 0.16, ry * 0.12, 0);
      pose.addEuler(IDX.spine2, rp * 0.10, ry * 0.08, 0);
      pose.addEuler(IDX.neck, -rp * 0.14, 0, 0);
      pose.addEuler(IDX.head, -rp * 0.10, 0, 0);
    }

    // flinch under fire
    const fl = this.flinch.update(d);
    if (Math.abs(fl) > 0.01) {
      pose.addEuler(IDX.spine2, fl * 0.5, 0, fl * 0.2);
      pose.addEuler(IDX.spine3, fl * 0.4, 0, fl * 0.15);
      pose.addEuler(IDX.neck, fl * 0.7, 0, 0);
      pose.addEuler(IDX.head, fl * 0.6, 0, 0);
    }

    // lean into acceleration
    this.leanSpring.target = clamp(this.speed * 1.7 * Math.cos(this.moveAngle), -6, 9);
    const lean = this.leanSpring.update(d);
    pose.addEuler(IDX.spine1, -lean * 0.25, 0, 0);
    pose.addEuler(IDX.spine2, -lean * 0.20, 0, 0);
  }

  /* ---------------------------------------------------------------- */
  /* foot IK                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Two-bone IK per leg against the physics world, plus a pelvis drop so the
   * character straddles a step instead of doing the splits.
   */
  _footIK(d) {
    const physics = this.game?.physics;
    if (!physics?.raycast) return;
    const root = this.character.root;

    this._ikTimer -= d;
    const probe = this._ikTimer <= 0;
    if (probe) this._ikTimer = 0.06 + Math.random() * 0.03;

    const legs = [
      { thigh: IDX.thighL, shin: IDX.shinL, foot: IDX.footL, i: 0 },
      { thigh: IDX.thighR, shin: IDX.shinR, foot: IDX.footR, i: 1 },
    ];

    const scale = this.character.scale || 1;
    const maxLen = (THIGH_LEN + SHIN_LEN) * scale * 0.99;

    // Stance detection: a foot is only pulled *down* onto the ground while the
    // clip has it planted, otherwise the swing leg would drag along the floor.
    const moving = clamp01((this.speed - 0.15) / 0.5);
    const plantWindow = (ph) => {
      const p = ((ph % 1) + 1) % 1;
      return clamp01(smoothstep(-0.02, 0.06, p) * (1 - smoothstep(0.44, 0.56, p)));
    };
    legs[0].plant = lerp(1, plantWindow(this.phase), moving);
    legs[1].plant = lerp(1, plantWindow(this.phase + 0.5), moving);

    let drop = 0;
    for (const leg of legs) {
      const ankle = _ik.ankle.setFromMatrixPosition(this.bones[leg.foot].matrixWorld);
      if (probe) {
        _ik.probe.set(ankle.x, ankle.y + 0.55, ankle.z);
        const hit = physics.raycast(_ik.probe, _ik.down, 1.5, null);
        if (hit) {
          this.footY[leg.i] = hit.point.y;
          this.footN[leg.i].copy(hit.normal);
        } else {
          this.footY[leg.i] = ankle.y - ANKLE_HEIGHT * scale;
          this.footN[leg.i].set(0, 1, 0);
        }
      }
      // the hips only sink when a planted foot genuinely cannot reach the ground
      if (leg.plant > 0.15) {
        const hip = _ik.hip.setFromMatrixPosition(this.bones[leg.thigh].matrixWorld);
        _ik.target.set(ankle.x, this.footY[leg.i] + ANKLE_HEIGHT * scale, ankle.z);
        const stretch = _ik.target.distanceTo(hip) - maxLen;
        if (stretch > 0) drop = Math.min(drop, -stretch * leg.plant);
      }
    }

    this.pelvisDrop = damp(this.pelvisDrop, clamp(drop, -0.42, 0), 14, d);
    if (Math.abs(this.pelvisDrop) > 0.0015) {
      this.bones[0].position.y += this.pelvisDrop;
      this.bones[0].updateMatrixWorld(true);
    }

    for (const leg of legs) {
      const hipB = this.bones[leg.thigh];
      const kneeB = this.bones[leg.shin];
      const footB = this.bones[leg.foot];
      const hip = _ik.hip.setFromMatrixPosition(hipB.matrixWorld);
      const knee = _ik.knee.setFromMatrixPosition(kneeB.matrixWorld);
      const ankle = _ik.ankle.setFromMatrixPosition(footB.matrixWorld);

      const targetY = this.footY[leg.i] + ANKLE_HEIGHT * scale;
      // always lift a foot out of the ground; only pull one down while planted
      const delta = targetY - ankle.y;
      const w = delta > 0 ? 1 : leg.plant * clamp01(1 + delta / 0.16);
      if (w < 0.02) continue;
      const target = _ik.target.set(ankle.x, lerp(ankle.y, targetY, w), ankle.z);

      const L1 = THIGH_LEN * scale;
      const L2 = SHIN_LEN * scale;
      const toTarget = _ik.toTarget.copy(target).sub(hip);
      let dist = toTarget.length();
      const maxLen = (L1 + L2) * 0.995;
      const minLen = Math.abs(L1 - L2) + 0.02;
      if (dist > maxLen) { toTarget.multiplyScalar(maxLen / dist); dist = maxLen; }
      if (dist < minLen) { toTarget.multiplyScalar(minLen / Math.max(1e-4, dist)); dist = minLen; }

      // knee plane from the current pose keeps the animated knee direction
      const axis = _ik.axis.copy(toTarget).normalize();
      const cur = _ik.cur.copy(knee).sub(hip);
      const pole = _ik.pole.copy(cur).addScaledVector(axis, -cur.dot(axis));
      if (pole.lengthSq() < 1e-6) pole.set(0, 0, -1).addScaledVector(axis, axis.z);
      pole.normalize();

      const cosA = clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1);
      const a = Math.acos(cosA);
      const newKnee = _ik.newKnee.copy(hip)
        .addScaledVector(axis, Math.cos(a) * L1)
        .addScaledVector(pole, Math.sin(a) * L1);
      const finalAnkle = _ik.finalAnkle.copy(hip).add(toTarget);

      this._alignBone(hipB, hip, knee, newKnee);
      hipB.updateMatrixWorld(true);
      const knee2 = _ik.knee.setFromMatrixPosition(kneeB.matrixWorld);
      const ankle2 = _ik.ankle.setFromMatrixPosition(footB.matrixWorld);
      this._alignBone(kneeB, knee2, ankle2, finalAnkle);
      kneeB.updateMatrixWorld(true);

      // roll the foot onto the surface normal
      const n = this.footN[leg.i];
      if (n.y < 0.999 && w > 0.3) {
        _q1.setFromUnitVectors(UP, n);
        _q2.setFromRotationMatrix(_m1.extractRotation(footB.matrixWorld));
        _q3.copy(_q1).multiply(_q2);
        _q2.slerp(_q3, clamp01((w - 0.3) / 0.7) * 0.65);
        _q1.setFromRotationMatrix(_m1.extractRotation(footB.parent.matrixWorld));
        footB.quaternion.copy(_q1.invert()).multiply(_q2);
        footB.updateMatrixWorld(true);
      }
    }
    void root;
  }

  /** Rotate `bone` about its origin so `from` lands on `to` (swing only). */
  _alignBone(bone, origin, from, to) {
    _s1.copy(from).sub(origin);
    _s2.copy(to).sub(origin);
    if (_s1.lengthSq() < 1e-8 || _s2.lengthSq() < 1e-8) return;
    _s1.normalize(); _s2.normalize();
    if (_s1.dot(_s2) > 0.99999) return;
    _sq1.setFromUnitVectors(_s1, _s2);
    _sq2.setFromRotationMatrix(_sm.extractRotation(bone.matrixWorld));
    _sq3.copy(_sq1).multiply(_sq2);                    // world rotation after the swing
    _sq1.setFromRotationMatrix(_sm.extractRotation(bone.parent.matrixWorld)).invert();
    bone.quaternion.copy(_sq1).multiply(_sq3);
  }

  /* ---------------------------------------------------------------- */
  /* gear secondary motion                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Pouches, the dump bag and the antenna lag the body. Each gear bone is a
   * damped angular spring driven by the character's local-space acceleration —
   * accelerate forward and the pouches swing back, stop and they slap.
   */
  _gearSprings(d) {
    const root = this.character.root;
    const vel = this._agentVelocity || _v1.set(0, 0, 0);
    this._accel.copy(vel).sub(this._lastVel).multiplyScalar(1 / Math.max(1e-3, d));
    this._lastVel.copy(vel);
    this._accel.clampLength(0, 26);

    // into the character's frame
    _q1.copy(root.quaternion).invert();
    _v2.copy(this._accel).applyQuaternion(_q1);
    _v3.copy(vel).applyQuaternion(_q1);

    const bob = Math.sin(this.phase * Math.PI * 4) * clamp01(this.speed / 3) * 26;
    const specs = [
      { i: IDX.gearFrontL, k: 150, dmp: 0.55, ax: -0.75, az: 0.5, gy: 0 },
      { i: IDX.gearFrontR, k: 165, dmp: 0.55, ax: -0.70, az: -0.5, gy: 0 },
      { i: IDX.gearBack, k: 190, dmp: 0.6, ax: -0.5, az: 0.3, gy: 0 },
      { i: IDX.gearAnt, k: 26, dmp: 0.16, ax: -2.6, az: 1.9, gy: 0 },
      { i: IDX.gearHipR, k: 95, dmp: 0.42, ax: -1.25, az: -0.9, gy: 0 },
      { i: IDX.gearHipL, k: 105, dmp: 0.42, ax: -1.15, az: 0.9, gy: 0 },
    ];

    const steps = d > 1 / 50 ? 2 : 1;
    const h = d / steps;
    for (let gi = 0; gi < specs.length; gi++) {
      const s = specs[gi];
      const g = this.gear[gi];
      const isAnt = s.i === IDX.gearAnt;
      const tx = clamp(_v2.z * s.ax + (isAnt ? bob * 0.16 : bob * 0.05), -34, 34);
      const tz = clamp(-_v2.x * s.az * 1.1 + (isAnt ? wobble(this.time * 1.4, gi) * 3.5 : 0), -30, 30);
      const ty = clamp(_v3.x * 0.08 * s.az, -14, 14);
      const c = 2 * Math.sqrt(s.k) * s.dmp;
      for (let st = 0; st < steps; st++) {
        g.vx += ((tx - g.x) * s.k - g.vx * c) * h;
        g.vy += ((ty - g.y) * s.k - g.vy * c) * h;
        g.vz += ((tz - g.z) * s.k - g.vz * c) * h;
        g.x += g.vx * h; g.y += g.vy * h; g.z += g.vz * h;
      }
      const b = this.bones[s.i];
      _ea.set(g.x * DEG, g.y * DEG, g.z * DEG);
      b.quaternion.setFromEuler(_ea);
    }
  }

  /** Called by the agent each frame so the springs know how it is moving. */
  setVelocity(v) {
    this._agentVelocity = this._agentVelocity || new THREE.Vector3();
    this._agentVelocity.copy(v);
  }

  /* ---------------------------------------------------------------- */
  /* ragdoll handoff                                                   */
  /* ---------------------------------------------------------------- */

  /** Snapshot every bone's world matrix — the ragdoll starts from this pose. */
  captureWorldPose(out = []) {
    for (let i = 0; i < BONE_COUNT; i++) {
      out[i] = out[i] || new THREE.Vector3();
      out[i].setFromMatrixPosition(this.bones[i].matrixWorld);
    }
    return out;
  }
}

export { UPPER_BODY, IDX, THIGH_LEN, SHIN_LEN, ANKLE_HEIGHT };
