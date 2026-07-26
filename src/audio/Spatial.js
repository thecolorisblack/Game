/**
 * OPERATION BLACKOUT — 3D voice pool, air, occlusion and environment routing.
 *
 * Every diegetic one-shot in the game goes through here. A voice is a small
 * pre-built node chain that is recycled rather than rebuilt, because building a
 * PannerNode per gunshot at 760 rpm allocates faster than the GC likes.
 *
 *   src ─ gain ─ lowpass ─ panner(HRTF) ─ bus
 *          ├─ sendNear ─ [interior|stairwell|street] convolvers ─ verb bus
 *          └─ sendFar  ─ distant convolver ───────────────────────┘
 *
 * The lowpass carries two independent jobs multiplied together:
 *
 *   air absorption — high frequencies are lost to distance, and this single
 *   cue does more for perceived range than the gain rolloff does;
 *   occlusion      — a raycast from ear to source through `game.physics`; if
 *   geometry is in the way the voice is ducked and dulled, and the reverb send
 *   is *raised*, because a sound you hear through a wall is nearly all room.
 *
 * Reverb is sent pre-panner (mono) on purpose: a room's late field is not
 * directional, and spatialising it collapses the illusion the moment you turn
 * your head.
 */

import * as THREE from 'three';
import { buildIR, SPACES, SPACE_IDS } from './Impulse.js';

const NEAR_SPACES = ['interior', 'stairwell', 'street'];

/* ==================================================================== */

function setPos(node, x, y, z, ctx) {
  if (node.positionX) {
    const t = ctx.currentTime;
    node.positionX.setValueAtTime(x, t);
    node.positionY.setValueAtTime(y, t);
    node.positionZ.setValueAtTime(z, t);
  } else if (node.setPosition) {
    node.setPosition(x, y, z);
  }
}

class Voice {
  constructor(ctx, spatial, hrtf) {
    this.ctx = ctx;
    this.spatial = spatial;
    this.input = ctx.createGain();
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 20000;
    this.lp.Q.value = 0.35;

    if (spatial) {
      this.panner = ctx.createPanner();
      this.panner.panningModel = hrtf ? 'HRTF' : 'equalpower';
      this.panner.distanceModel = 'inverse';
      this.panner.refDistance = 3.5;
      this.panner.rolloffFactor = 1.05;
      this.panner.maxDistance = 420;
      this.output = this.panner;
    } else {
      this.pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      this.output = this.pan || this.lp;
    }

    this.sendNear = ctx.createGain();
    this.sendNear.gain.value = 0;
    this.sendFar = ctx.createGain();
    this.sendFar.gain.value = 0;

    this.input.connect(this.lp);
    if (this.pan) this.lp.connect(this.pan);
    else if (this.panner) this.lp.connect(this.panner);
    this.input.connect(this.sendNear);
    this.input.connect(this.sendFar);

    this.src = null;
    this.busNode = null;
    this.free = true;
    this.expire = 0;
    this.wallExpire = 0;
    this.startedAt = 0;
  }

  connectSends(nearIn, farIn) {
    this.sendNear.connect(nearIn);
    this.sendFar.connect(farIn);
  }
}

/* ==================================================================== */

export class SpatialField {
  constructor(engine) {
    this.engine = engine;
    this.game = engine.game;
    this.ctx = engine.ctx;
    this.mixer = engine.mixer;

    this.voices3d = [];
    this.voices2d = [];
    this.max3d = 44;
    this.max2d = 22;

    this.irs = null;
    this.convolvers = {};
    this.spaceGain = {};
    this.spaceWeights = { interior: 0, stairwell: 0, street: 1 };
    this.spaceTarget = { interior: 0, stairwell: 0, street: 1 };
    this.farWeight = 0.35;

    this.listenerPos = new THREE.Vector3();
    this._prevListener = new THREE.Vector3();
    this._fwd = new THREE.Vector3(0, 0, -1);
    this._up = new THREE.Vector3(0, 1, 0);
    this._dir = new THREE.Vector3();
    this._tmp = new THREE.Vector3();

    this._occCache = new Map();
    this._occBudget = 0;
    this._occKeyScale = 1.4;

    this.airDistance = 46;      // metres for one octave-ish of HF loss
    this.hrtf = true;
    this.active = 0;
  }

  /* ------------------------------------------------------------------ */

  init() {
    const ctx = this.ctx;
    const preset = this.game?.settings?.preset;
    this.hrtf = preset !== 'low';

    // --- reverb returns -------------------------------------------------
    this.verbReturn = ctx.createGain();
    this.verbReturn.gain.value = 1;
    this.verbReturn.connect(this.mixer.bus('verb'));

    this.nearIn = ctx.createGain();
    this.farIn = ctx.createGain();
    this.nearIn.gain.value = 1;
    this.farIn.gain.value = 1;

    // Impulse responses are built off the boot path (see AudioEngine); a
    // convolver with no buffer is simply silent until its room arrives.
    this.irs = {};

    for (const id of SPACE_IDS) {
      const conv = ctx.createConvolver();
      conv.normalize = false;
      const g = ctx.createGain();
      g.gain.value = id === 'street' ? 1 : 0;
      // A gentle HF trim on every return keeps the procedural tails from
      // sounding like white noise sprayed over the mix.
      const tone = ctx.createBiquadFilter();
      tone.type = 'highshelf';
      tone.frequency.value = 4200;
      tone.gain.value = -5;
      conv.connect(tone);
      tone.connect(g);
      g.connect(this.verbReturn);
      this.convolvers[id] = conv;
      this.spaceGain[id] = g;
      if (id === 'distant') this.farIn.connect(conv);
      else this.nearIn.connect(conv);
    }

    // --- voices ---------------------------------------------------------
    for (let i = 0; i < this.max3d; i++) {
      const v = new Voice(ctx, true, this.hrtf);
      v.connectSends(this.nearIn, this.farIn);
      this.voices3d.push(v);
    }
    for (let i = 0; i < this.max2d; i++) {
      const v = new Voice(ctx, false, false);
      v.connectSends(this.nearIn, this.farIn);
      this.voices2d.push(v);
    }

    // --- listener defaults ----------------------------------------------
    const l = ctx.listener;
    if (l) {
      if (l.forwardX) {
        const t = ctx.currentTime;
        l.forwardX.setValueAtTime(0, t); l.forwardY.setValueAtTime(0, t); l.forwardZ.setValueAtTime(-1, t);
        l.upX.setValueAtTime(0, t); l.upY.setValueAtTime(1, t); l.upZ.setValueAtTime(0, t);
      } else if (l.setOrientation) {
        l.setOrientation(0, 0, -1, 0, 1, 0);
      }
    }
    return this;
  }

  /**
   * Render one space's impulse response and hand it to its convolver. Called
   * one space per macrotask after boot so a 300 ms render never lands inside a
   * single frame.
   */
  buildSpaceIR(id) {
    const def = SPACES[id];
    if (!def || !this.convolvers[id]) return null;
    try {
      const buf = buildIR(this.ctx, def, { rms: 0.03 });
      this.irs[id] = buf;
      this.convolvers[id].buffer = buf;
      return buf;
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* environment                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Set the listener's acoustic environment. Accepts an id or a weight map;
   * weights are cross-faded so walking through a doorway is a slide, not a cut.
   */
  setEnvironment(env, far = null) {
    if (typeof env === 'string') {
      for (const id of NEAR_SPACES) this.spaceTarget[id] = id === env ? 1 : 0;
      if (!NEAR_SPACES.includes(env)) this.spaceTarget.street = 1;
    } else if (env) {
      let sum = 0;
      for (const id of NEAR_SPACES) sum += Math.max(0, env[id] || 0);
      if (sum <= 0) sum = 1;
      for (const id of NEAR_SPACES) this.spaceTarget[id] = Math.max(0, env[id] || 0) / sum;
    }
    if (far !== null) this.farWeight = Math.max(0, Math.min(1, far));
  }

  /** Dominant space id — used to pick the baked gunshot tail. */
  get environment() {
    let best = 'street';
    let bv = -1;
    for (const id of NEAR_SPACES) {
      if (this.spaceWeights[id] > bv) { bv = this.spaceWeights[id]; best = id; }
    }
    return best;
  }

  /** How enclosed the listener is, 0 (open street) .. 1 (tight room). */
  get enclosure() {
    return this.spaceWeights.interior * 1 + this.spaceWeights.stairwell * 0.85;
  }

  /* ------------------------------------------------------------------ */
  /* occlusion                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * 0 = clear line of sight, 1 = solid wall. Results are cached on a coarse
   * spatial grid for a short window; a firefight fires dozens of one-shots per
   * second from nearly the same places and re-casting for each is pure waste.
   */
  occlusion(x, y, z) {
    const phys = this.game?.physics;
    if (!phys?.raycast) return 0;

    const lp = this.listenerPos;
    const dx = x - lp.x;
    const dy = y - lp.y;
    const dz = z - lp.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1.2) return 0;

    const s = this._occKeyScale;
    const key = `${Math.round(x / s)},${Math.round(y / s)},${Math.round(z / s)}`;
    const now = this.engine.clock;
    const hit = this._occCache.get(key);
    if (hit && now - hit.t < 0.35 && this._prevListener.distanceToSquared(lp) < 0.6) {
      return hit.v;
    }
    if (this._occBudget <= 0) return hit ? hit.v : 0;
    this._occBudget--;

    this._dir.set(dx / dist, dy / dist, dz / dist);
    let occ = 0;
    try {
      const r = phys.raycast(lp, this._dir, dist - 0.35, null);
      if (r) {
        // Thicker-looking obstructions (a hit close to the listener with a lot
        // of distance still to travel) block more.
        const frac = r.distance / dist;
        occ = 0.55 + 0.45 * (1 - Math.abs(frac - 0.5) * 2) * 0.8;
        occ = Math.min(1, occ);
      }
    } catch {
      occ = 0;
    }
    this._occCache.set(key, { t: now, v: occ });
    if (this._occCache.size > 512) {
      // Cheap eviction: drop the oldest quarter.
      const cutoff = now - 0.35;
      for (const [k, e] of this._occCache) if (e.t < cutoff) this._occCache.delete(k);
    }
    return occ;
  }

  /* ------------------------------------------------------------------ */
  /* playback                                                            */
  /* ------------------------------------------------------------------ */

  _acquire(spatial) {
    const pool = spatial ? this.voices3d : this.voices2d;
    for (let i = 0; i < pool.length; i++) if (pool[i].free) return pool[i];
    // Steal the oldest.
    let best = pool[0];
    for (let i = 1; i < pool.length; i++) if (pool[i].startedAt < best.startedAt) best = pool[i];
    this._release(best, true);
    return best;
  }

  _release(v, stop) {
    if (v.src) {
      try { v.src.onended = null; if (stop) v.src.stop(); } catch { /* already stopped */ }
      try { v.src.disconnect(); } catch { /* ignore */ }
      v.src = null;
    }
    if (v.busNode) {
      try { v.output.disconnect(v.busNode); } catch { /* ignore */ }
      v.busNode = null;
    }
    v.free = true;
  }

  /**
   * Fire a buffer.
   *
   * opts: {
   *   position:Vector3|null, bus, volume, rate, delay, pan, spread,
   *   send, sendFar, occlude, refDistance, maxDistance, rolloff, loop,
   *   lowpass, airScale
   * }
   */
  play(buffer, opts = {}) {
    const ctx = this.ctx;
    if (!buffer || ctx.state !== 'running') return null;

    const pos = opts.position || null;
    const spatial = !!pos && opts.spatial !== false;
    const v = this._acquire(spatial);
    v.free = false;
    v.startedAt = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const rate = Math.max(0.06, opts.rate ?? 1);
    src.playbackRate.value = rate;
    if (opts.detune && src.detune) src.detune.value = opts.detune;
    if (opts.loop) { src.loop = true; if (opts.loopEnd) src.loopEnd = opts.loopEnd; }

    let vol = opts.volume ?? 1;
    let lpf = opts.lowpass ?? 20000;
    let sendNear = opts.send ?? 0.16;
    let sendFar = opts.sendFar ?? 0;

    if (spatial) {
      const p = v.panner;
      p.refDistance = opts.refDistance ?? 3.5;
      p.rolloffFactor = opts.rolloff ?? 1.05;
      p.maxDistance = opts.maxDistance ?? 420;
      setPos(p, pos.x, pos.y, pos.z, ctx);

      const dist = this.listenerPos.distanceTo(pos);
      // Air absorption. Halving every `airDistance` metres is aggressive on
      // paper and exactly right in practice for outdoor urban space.
      const air = 19000 * Math.pow(0.5, dist / (this.airDistance * (opts.airScale ?? 1)));
      lpf = Math.min(lpf, Math.max(420, air));

      if (opts.occlude !== false) {
        const occ = this.occlusion(pos.x, pos.y, pos.z);
        if (occ > 0.01) {
          vol *= 1 - 0.72 * occ;
          lpf = Math.min(lpf, 20000 * Math.pow(0.045, occ));
          // Muffled sources are heard through the room, not directly.
          sendNear = Math.min(1, sendNear + 0.5 * occ);
        }
      }
      // Distance decides how much of the far field answers.
      const farAmt = Math.min(1, Math.max(0, (dist - 16) / 60));
      sendFar = Math.max(sendFar, farAmt * this.farWeight);
      sendNear *= 1 + Math.min(1.6, dist / 22) * 0.9;
    } else if (v.pan) {
      v.pan.pan.value = Math.max(-1, Math.min(1, opts.pan ?? 0));
    }

    const now = ctx.currentTime;
    const when = now + Math.max(0, opts.delay ?? 0);
    v.input.gain.cancelScheduledValues(now);
    v.input.gain.setValueAtTime(Math.max(0.0001, vol), now);
    v.lp.frequency.cancelScheduledValues(now);
    v.lp.frequency.setValueAtTime(Math.max(120, Math.min(21000, lpf)), now);
    v.lp.Q.value = opts.q ?? 0.35;
    v.sendNear.gain.setValueAtTime(Math.max(0, sendNear) * (opts.verb ?? 1), now);
    v.sendFar.gain.setValueAtTime(Math.max(0, sendFar) * (opts.verb ?? 1), now);

    const busNode = this.mixer.bus(opts.bus || 'world');
    v.output.connect(busNode);
    v.busNode = busNode;

    src.connect(v.input);
    v.src = src;

    const dur = (buffer.duration / rate) + (opts.delay ?? 0);
    v.expire = when + dur + 0.25;
    v.wallExpire = (globalThis.performance?.now?.() ?? Date.now()) + (dur + 1.2) * 1000;

    src.onended = () => {
      if (v.src === src) this._release(v, false);
    };
    try {
      src.start(when);
    } catch {
      this._release(v, false);
      return null;
    }

    return {
      voice: v,
      source: src,
      gain: v.input.gain,
      filter: v.lp,
      stop: (fade = 0.02) => {
        if (v.src !== src) return;
        try {
          const t = ctx.currentTime;
          v.input.gain.cancelScheduledValues(t);
          v.input.gain.setTargetAtTime(0.0001, t, Math.max(0.005, fade) / 3);
          src.stop(t + fade + 0.02);
        } catch { /* already gone */ }
      },
    };
  }

  /* ------------------------------------------------------------------ */

  update(dt, camera) {
    const ctx = this.ctx;
    this._occBudget = 6;

    if (camera) {
      this._prevListener.copy(this.listenerPos);
      camera.getWorldPosition(this.listenerPos);
      this._fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
      this._up.set(0, 1, 0).applyQuaternion(camera.quaternion);

      const l = ctx.listener;
      if (l) {
        const t = ctx.currentTime;
        if (l.positionX) {
          // Ramping rather than stepping avoids zipper noise on fast turns.
          l.positionX.setTargetAtTime(this.listenerPos.x, t, 0.012);
          l.positionY.setTargetAtTime(this.listenerPos.y, t, 0.012);
          l.positionZ.setTargetAtTime(this.listenerPos.z, t, 0.012);
          l.forwardX.setTargetAtTime(this._fwd.x, t, 0.012);
          l.forwardY.setTargetAtTime(this._fwd.y, t, 0.012);
          l.forwardZ.setTargetAtTime(this._fwd.z, t, 0.012);
          l.upX.setTargetAtTime(this._up.x, t, 0.02);
          l.upY.setTargetAtTime(this._up.y, t, 0.02);
          l.upZ.setTargetAtTime(this._up.z, t, 0.02);
        } else {
          l.setPosition?.(this.listenerPos.x, this.listenerPos.y, this.listenerPos.z);
          l.setOrientation?.(this._fwd.x, this._fwd.y, this._fwd.z, this._up.x, this._up.y, this._up.z);
        }
      }
    }

    // Cross-fade environment weights.
    const k = 1 - Math.exp(-dt / 0.45);
    const now = ctx.currentTime;
    for (const id of NEAR_SPACES) {
      const w = this.spaceWeights[id] + (this.spaceTarget[id] - this.spaceWeights[id]) * k;
      this.spaceWeights[id] = w;
      try { this.spaceGain[id].gain.setTargetAtTime(w, now, 0.08); } catch { /* ignore */ }
    }
    try { this.spaceGain.distant?.gain.setTargetAtTime(this.farWeight, now, 0.12); } catch { /* ignore */ }

    // Reclaim voices whose `onended` never arrived (context suspended mid-play).
    const wall = globalThis.performance?.now?.() ?? Date.now();
    let active = 0;
    for (const pool of [this.voices3d, this.voices2d]) {
      for (const v of pool) {
        if (v.free) continue;
        active++;
        if (v.src && !v.src.loop && wall > v.wallExpire) this._release(v, true);
      }
    }
    this.active = active;
  }

  stopAll() {
    for (const pool of [this.voices3d, this.voices2d]) {
      for (const v of pool) if (!v.free) this._release(v, true);
    }
  }
}
