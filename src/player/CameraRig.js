import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { noise1, noise2, hash01 } from './Noise.js';
import { Spring, Smoothed, damp, clamp01, easeOutCubic } from './Springs.js';

/**
 * Everything between "where the player is" and "what the camera sees".
 *
 * Runs in `lateUpdate` so it composes on top of movement, world streaming and
 * anything else that moved this frame. The layering is deliberate and additive:
 *
 *   base aim        yaw/pitch from the mouse, integrated at render rate
 * + aim recoil      moves your point of aim, recovers to the original point
 * + view recoil     visual-only bounce (mostly on the viewmodel, a third on cam)
 * + gait bob        figure-eight, phase-locked to the footstep cadence
 * + landing/steps   springs fed by impacts and stair risers
 * + sway            spring lag behind mouse motion
 * + breathing       low-frequency drift that grows when winded, held under ADS
 * + trauma shake    additive Perlin noise, quadratic decay, optional bias
 *
 * Every channel is a spring or a noise field, never a fixed tween, so two
 * events arriving in the same frame simply add instead of fighting.
 */

const DEG = Math.PI / 180;
const MAX_PITCH = 87 * DEG;

const TUNE = {
  // bob
  bobX: 0.0330, bobY: 0.0235, bobZ: 0.0125,
  bobRoll: 1.05 * DEG, bobPitch: 0.36 * DEG, bobYaw: 0.52 * DEG,
  bobAdsScale: 0.26,

  // sway
  swayGain: 0.0225, swayMax: 0.052, swayFreq: 13, swayDamping: 0.85,
  swayCameraShare: 0.22,

  // lean
  leanRoll: 13.5 * DEG, leanDrop: 0.052,

  // strafe tilt
  strafeRoll: 0.62 * DEG,

  // recoil
  aimRecoilHold: 0.105,
  aimRecoilDecay: 8.5,
  aimRecoilMaxPitch: 0.34,
  aimRecoilMaxYaw: 0.20,
  viewRecoilCameraShare: 0.34,

  // breathing
  breathBase: 0.00135,
  breathWinded: 0.0092,
  breathAdsScale: 0.30,

  // fov
  sprintFov: 5.5, tacticalFov: 6.5, slideFov: 7.0, speedFov: 1.05,
  fovSmoothIn: 0.085, fovSmoothOut: 0.145,

  // shake
  // Perlin RMS is ~0.38, so the nominal scale has to be well above the peak
  // deflection you actually want to see.
  shakeRot: 4.6 * DEG, shakePos: 0.046, shakeMaxRot: 8.5 * DEG,
};

let SHAKE_SEED = 0;

export class CameraRig {
  constructor(player) {
    this.player = player;
    this.game = player.game;
    this.tune = TUNE;

    // --- aim ------------------------------------------------------------
    this.lookDelta = new THREE.Vector2();
    this._lookVel = new THREE.Vector2();

    // --- sway -----------------------------------------------------------
    this.swayX = new Spring(TUNE.swayFreq, TUNE.swayDamping);
    this.swayY = new Spring(TUNE.swayFreq, TUNE.swayDamping);
    this.sway = { x: 0, y: 0 };
    this.swayPos = new THREE.Vector3();

    // --- recoil ---------------------------------------------------------
    this.aimPitch = new Spring(30, 0.92);
    this.aimYaw = new Spring(28, 0.95);
    this._aimTargetPitch = 0;
    this._aimTargetYaw = 0;
    this._recoilHold = 99;
    this.viewPitch = new Spring(38, 0.52);
    this.viewYaw = new Spring(34, 0.55);
    this.viewRoll = new Spring(30, 0.50);
    this.kick = new Spring(42, 0.58);
    this.viewKick = { pitch: 0, yaw: 0, roll: 0, z: 0 };
    this.recoilAim = { pitch: 0, yaw: 0 };
    this.shotsFired = 0;

    // --- impacts --------------------------------------------------------
    this.landY = new Spring(26, 0.60);
    this.landPitch = new Spring(23, 0.62);
    this.landRoll = new Spring(19, 0.66);
    this.footY = new Spring(46, 0.72);
    this.stepSmooth = 0;

    // --- flinch / death -------------------------------------------------
    this.flinchPitch = new Spring(24, 0.55);
    this.flinchYaw = new Spring(22, 0.58);
    this.deathT = 0;
    this.deathRoll = 0;
    this.dying = false;

    // --- shake ----------------------------------------------------------
    this.shakes = [];
    this.trauma = 0;
    this.concussion = 0;
    this._shakeRot = new THREE.Vector3();
    this._shakePos = new THREE.Vector3();

    // --- breathing ------------------------------------------------------
    this.breathT = Math.random() * 40;
    this.breath = { pitch: 0, yaw: 0, y: 0 };
    this.holdBreath = 0;

    // --- bob ------------------------------------------------------------
    this.bobAmp = 0;
    this.bob = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 };

    // --- misc -----------------------------------------------------------
    this.strafeTilt = 0;
    this.slideRoll = 0;
    this.mantleBlend = 0;
    this._mantleKind = null;
    this.fov = 90;
    this.fovSmooth = new Smoothed(90);
    this.fovPunch = new Spring(18, 0.55);
    this._lastAppliedFov = -1;
    this._lastAspect = -1;

    this.time = 0;

    this._fwd = new THREE.Vector3(0, 0, -1);
    this._right = new THREE.Vector3(1, 0, 0);
    this._tmp = new THREE.Vector3();

    this._onShake = (e) => {
      if (!e) return;
      this.addShake(e.amplitude ?? 0.3, e.frequency ?? 20, e.duration ?? 0.35, e.direction);
    };
  }

  init() {
    bus.on('camera:shake', this._onShake);
    const s = this.game?.settings;
    this.fov = s?.fov ?? 90;
    this.fovSmooth.reset(this.fov);
    this._applyFov(this.fov, true);
  }

  dispose() { bus.off('camera:shake', this._onShake); }

  /* ================================================================== */
  /* public API                                                          */
  /* ================================================================== */

  /**
   * Weapon recoil. Angles are radians by default; anything larger than 0.35 is
   * assumed to be degrees, because no single shot kicks 20 degrees.
   *
   * @param {{pitch?:number, yaw?:number, roll?:number, kick?:number,
   *          units?:'rad'|'deg', aim?:number, visual?:number}} o
   */
  addRecoil(o) {
    if (!o) return;
    const conv = (v) => {
      const n = Number(v) || 0;
      if (o.units === 'deg') return n * DEG;
      if (o.units === 'rad') return n;
      return Math.abs(n) > 0.35 ? n * DEG : n;
    };
    const pitch = conv(o.pitch);
    const yaw = conv(o.yaw);
    const roll = conv(o.roll);
    const kick = Number(o.kick) || 0;
    const aimScale = o.aim ?? 1;
    const visScale = o.visual ?? 1;

    // The aim component climbs and holds, then recovers to the *original*
    // point of aim. Mouse corrections apply to the base angles and therefore
    // survive the recovery, which is exactly the COD contract.
    this._aimTargetPitch = THREE.MathUtils.clamp(
      this._aimTargetPitch + pitch * 0.66 * aimScale,
      -TUNE.aimRecoilMaxPitch, TUNE.aimRecoilMaxPitch,
    );
    this._aimTargetYaw = THREE.MathUtils.clamp(
      this._aimTargetYaw + yaw * 0.66 * aimScale,
      -TUNE.aimRecoilMaxYaw, TUNE.aimRecoilMaxYaw,
    );
    this._recoilHold = 0;

    // Visual bounce: snappier, underdamped, and mostly consumed by the
    // viewmodel so the crosshair stays honest.
    this.viewPitch.impulseForPeak(pitch * 0.58 * visScale);
    this.viewYaw.impulseForPeak(yaw * 0.86 * visScale);
    this.viewRoll.impulseForPeak((roll || yaw * 1.6) * visScale);
    this.kick.impulseForPeak(kick * visScale);

    this.shotsFired++;
    if (pitch > 0.004) {
      this.addShake(Math.min(0.22, pitch * 5.2 + 0.03), 30, 0.11);
    }
  }

  /**
   * Additive trauma shake.
   * @param {number} amplitude 0..1-ish
   * @param {number} frequency Hz of the underlying noise
   * @param {number} duration  seconds
   * @param {THREE.Vector3|{x,y,z}} [direction] world-space bias; a position far
   *        from the player is interpreted as "shake away from there".
   */
  addShake(amplitude, frequency = 20, duration = 0.35, direction = null) {
    const amp = Math.max(0, Number(amplitude) || 0);
    if (amp <= 1e-4) return;
    if (this.shakes.length > 12) this.shakes.shift();

    let dir = null;
    if (direction && direction.x !== undefined) {
      this._tmp.set(direction.x, direction.y ?? 0, direction.z);
      const len = this._tmp.length();
      if (len > 2.5) {
        // Looks like a world position: bias away from it.
        this._tmp.sub(this.player.position);
        if (this._tmp.lengthSq() > 1e-6) this._tmp.normalize();
      } else if (len > 1e-4) {
        this._tmp.multiplyScalar(1 / len);
      }
      dir = this._tmp.clone();
    }

    this.shakes.push({
      amp: Math.min(1.6, amp),
      freq: Math.max(1, Number(frequency) || 20),
      dur: Math.max(0.04, Number(duration) || 0.35),
      t: 0,
      dir,
      seed: (SHAKE_SEED++ % 251) * 17.31 + hash01(SHAKE_SEED) * 90,
    });
  }

  /** Convenience for systems that only have a magnitude. */
  addTrauma(amount) { this.addShake(amount, 22, 0.4); }

  /** Called when the character controller lifts the capsule onto a stair. */
  addStepOffset(dy) {
    this.stepSmooth = Math.max(-0.55, this.stepSmooth - dy);
  }

  landImpulse(impact, velocity, rawSpeed) {
    const i = clamp01(impact);
    this.landY.impulseForPeak(-(0.045 + i * 0.135));
    this.landPitch.impulseForPeak(0.9 * DEG + i * 4.6 * DEG);
    const lateral = velocity
      ? (velocity.x * this._right.x + velocity.z * this._right.z) : 0;
    this.landRoll.impulseForPeak(-lateral * 0.0022 - (Math.random() - 0.5) * i * 1.4 * DEG);
    this.fovPunch.impulseForPeak(-1.2 - i * 3.4);
    this.footY.reset(0);
  }

  footPlant(strength, foot) {
    const s = clamp01(strength);
    // A hair of asymmetry between feet: perfectly symmetrical bob reads robotic.
    const bias = foot === 0 ? 1.0 : 0.88;
    this.footY.impulseForPeak(-0.0062 * s * bias);
    this.viewRoll.impulseForPeak((foot === 0 ? -1 : 1) * 0.11 * DEG * s);
  }

  jumpImpulse(scale = 1) {
    this.landY.impulseForPeak(0.028 * scale);
    this.landPitch.impulseForPeak(-1.1 * DEG * scale);
    this.fovPunch.impulseForPeak(0.9 * scale);
  }

  slideStart(speed) {
    this.landY.impulseForPeak(-0.035);
    this.landPitch.impulseForPeak(1.7 * DEG);
    this.fovPunch.impulseForPeak(2.6);
    this.addShake(0.16, 18, 0.22);
  }

  slideCancel() {
    this.landY.impulseForPeak(0.016);
    this.landPitch.impulseForPeak(-0.9 * DEG);
  }

  mantleStart(kind, rise, duration) {
    this._mantleKind = kind;
    this.viewPitch.impulseForPeak(-2.2 * DEG);
    this.viewRoll.impulseForPeak((Math.random() < 0.5 ? -1 : 1) * 1.4 * DEG);
    this.fovPunch.impulseForPeak(kind === 'vault' ? 2.2 : -1.4);
  }

  mantleEnd(kind) {
    this._mantleKind = null;
    this.landY.impulseForPeak(-0.03);
    this.landPitch.impulseForPeak(1.4 * DEG);
    this.addShake(0.14, 20, 0.18);
  }

  damageFlinch(fraction, dir, type) {
    const f = clamp01(fraction) + 0.06;
    // Kick away from the shooter so the flinch reads as directional.
    let lateral = 0;
    if (dir && dir.lengthSq && dir.lengthSq() > 1e-6) {
      lateral = dir.x * this._right.x + dir.z * this._right.z;
    } else {
      lateral = Math.random() * 2 - 1;
    }
    this.flinchPitch.impulseForPeak((1.6 + f * 7.5) * DEG);
    this.flinchYaw.impulseForPeak(-lateral * (1.0 + f * 5.0) * DEG);
    this.viewRoll.impulseForPeak(lateral * (0.8 + f * 3.0) * DEG);
    this.addShake(0.20 + f * 0.75, 27, 0.20 + f * 0.25, dir);
  }

  concuss(amount) {
    this.concussion = Math.min(1, this.concussion + clamp01(amount));
  }

  death(dir) {
    this.dying = true;
    this.deathT = 0;
    const side = dir && dir.lengthSq && dir.lengthSq() > 1e-6
      ? Math.sign(dir.x * this._right.x + dir.z * this._right.z || 1) : 1;
    this._deathSide = side || 1;
  }

  reset() {
    this.dying = false;
    this.deathT = 0;
    this.deathRoll = 0;
    this.shakes.length = 0;
    this.trauma = 0;
    this.concussion = 0;
    this.stepSmooth = 0;
    this._aimTargetPitch = 0;
    this._aimTargetYaw = 0;
    this.aimPitch.reset(); this.aimYaw.reset();
    this.viewPitch.reset(); this.viewYaw.reset(); this.viewRoll.reset();
    this.kick.reset();
    this.landY.reset(); this.landPitch.reset(); this.landRoll.reset();
    this.footY.reset();
    this.flinchPitch.reset(); this.flinchYaw.reset();
    this.swayX.reset(); this.swayY.reset();
    this.bobAmp = 0;
    this.fovPunch.reset();
  }

  /* ================================================================== */
  /* per-frame                                                           */
  /* ================================================================== */

  /** Look input. Read at render rate so the mouse is never quantised to 120 Hz. */
  update(dt) {
    const p = this.player;
    const input = this.game?.input;
    const settings = this.game?.settings;
    this.lookDelta.set(0, 0);
    if (!input) return;

    if (settings) input.invertY = !!settings.invertY;

    const active = !p.scripted
      && this.game?.state === 'playing'
      && p.vitals?.alive !== false;

    if (!active) {
      input.consumeLook(); // drain so resuming does not snap the view
      return;
    }

    let scale = settings?.sensitivity ?? 1;
    if (p.ads) scale *= input.adsSensitivityScale ?? 0.72;
    // Slower turn while sprinting flat-out reads as weight, not sluggishness.
    if (p.tacticalSprint) scale *= 0.90;

    const look = input.consumeLook(scale);
    if (!Number.isFinite(look.yaw) || !Number.isFinite(look.pitch)) return;

    p.yaw += look.yaw;
    if (p.yaw > Math.PI) p.yaw -= Math.PI * 2;
    else if (p.yaw < -Math.PI) p.yaw += Math.PI * 2;

    // Recoil already displaces the view; clamp the *composed* pitch so pulling
    // down against recoil at the ceiling of travel still works.
    const composed = p.pitch - look.pitch;
    p.pitch = THREE.MathUtils.clamp(composed, -MAX_PITCH - this.aimPitch.value, MAX_PITCH - this.aimPitch.value);

    this.lookDelta.set(look.yaw, look.pitch);
  }

  lateUpdate(dt) {
    const d = Math.min(Math.max(dt || 0, 0), 0.1);
    this.time += d;

    const p = this.player;
    const mv = p.movement;
    const stance = p.stanceCtrl;
    const cam = this.game?.camera;

    const yaw = p.yaw;
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    this._fwd.set(-sy, 0, -cy);
    this._right.set(cy, 0, -sy);

    this._stepRecoil(d);
    this._stepSway(d);
    this._stepBob(d, mv, stance);
    this._stepBreathing(d);
    this._stepShake(d);
    this._stepImpacts(d, mv);
    this._stepFov(d, mv);

    if (!cam) return;

    // The harness owns the transform in scripted mode; every channel above is
    // still live so the viewmodel and HUD keep animating.
    if (p.scripted) {
      this._syncViewCamera(cam);
      return;
    }

    this._compose(cam, d, mv, stance);
    this._syncViewCamera(cam);
  }

  /* ------------------------------------------------------------------ */

  _stepRecoil(dt) {
    this._recoilHold += dt;
    if (this._recoilHold > TUNE.aimRecoilHold) {
      const k = Math.exp(-TUNE.aimRecoilDecay * dt);
      this._aimTargetPitch *= k;
      this._aimTargetYaw *= k;
      if (Math.abs(this._aimTargetPitch) < 1e-5) this._aimTargetPitch = 0;
      if (Math.abs(this._aimTargetYaw) < 1e-5) this._aimTargetYaw = 0;
    }
    this.aimPitch.step(dt, this._aimTargetPitch);
    this.aimYaw.step(dt, this._aimTargetYaw);
    this.recoilAim.pitch = this.aimPitch.value;
    this.recoilAim.yaw = this.aimYaw.value;

    this.viewKick.pitch = this.viewPitch.step(dt, 0);
    this.viewKick.yaw = this.viewYaw.step(dt, 0);
    this.viewKick.roll = this.viewRoll.step(dt, 0);
    this.viewKick.z = this.kick.step(dt, 0);
  }

  _stepSway(dt) {
    const inv = 1 / Math.max(dt, 1e-4);
    // Exponentially averaged angular velocity: raw per-frame deltas are far too
    // spiky to drive a spring directly.
    this._lookVel.x = damp(this._lookVel.x, this.lookDelta.x * inv, 20, dt);
    this._lookVel.y = damp(this._lookVel.y, this.lookDelta.y * inv, 20, dt);

    const g = TUNE.swayGain;
    const m = TUNE.swayMax;
    const tx = THREE.MathUtils.clamp(-this._lookVel.x * g, -m, m);
    const ty = THREE.MathUtils.clamp(this._lookVel.y * g, -m, m);

    // ADS pins the weapon to the eye: sway collapses but never fully vanishes.
    const adsScale = this.player.ads ? 0.30 : 1;
    this.sway.x = this.swayX.step(dt, tx * adsScale);
    this.sway.y = this.swayY.step(dt, ty * adsScale);
    this.swayPos.set(this.sway.x * 0.16, this.sway.y * 0.12, 0);
  }

  _stepBob(dt, mv, stance) {
    const p = this.player;
    const speedRatio = mv ? mv.speedRatio : 0;
    const grounded = mv ? mv.grounded : true;

    let target = grounded ? Math.pow(clamp01(speedRatio), 0.85) : 0;
    target *= stance?.def?.bob ?? 1;
    if (p.ads) target *= TUNE.bobAdsScale;
    if (mv?.slide?.active) target = 0;
    if (mv?.mantle?.active) target = 0;
    target *= 1 - 0.45 * Math.abs(mv?.lean ?? 0);

    // Amplitude eases so stopping fades the bob out instead of cutting it.
    this.bobAmp = damp(this.bobAmp, target, target > this.bobAmp ? 7 : 5.5, dt);

    const phase = (mv ? mv.gaitPhase : 0) * Math.PI * 2;
    const a = this.bobAmp;
    const s1 = Math.sin(phase);
    const c2 = Math.cos(phase * 2);
    const s2 = Math.sin(phase * 2);

    // Lemniscate: lateral at gait frequency, vertical at twice it, so each of
    // the two footfalls per cycle gets its own dip. A plain sine wave is the
    // single most recognisable "web FPS" tell there is.
    this.bob.x = s1 * TUNE.bobX * a;
    this.bob.y = -c2 * TUNE.bobY * a - 0.5 * TUNE.bobY * a;
    this.bob.z = s2 * TUNE.bobZ * a;
    this.bob.roll = s1 * TUNE.bobRoll * a;
    this.bob.pitch = -c2 * TUNE.bobPitch * a;
    this.bob.yaw = s1 * TUNE.bobYaw * a;

    // Strafe tilt: lean into lateral motion, tiny but it sells the weight.
    const strafeTarget = (mv && mv.grounded)
      ? -(mv.velocity.x * this._right.x + mv.velocity.z * this._right.z) * 0.09 : 0;
    this.strafeTilt = damp(this.strafeTilt, strafeTarget, 6, dt);

    // Slide roll: bank into the slide direction.
    const slideTarget = mv?.slide?.active ? (mv.slide.lateral * 4.6 * DEG + 5.6 * DEG) : 0;
    this.slideRoll = damp(this.slideRoll, slideTarget, 9, dt);

    // Mantle pose: dip and roll through the climb.
    const m = mv?.mantle;
    const mTarget = m?.active ? Math.sin(clamp01(m.progress) * Math.PI) : 0;
    this.mantleBlend = damp(this.mantleBlend, mTarget, 12, dt);
  }

  _stepBreathing(dt) {
    const p = this.player;
    const winded = p.vitals?.windedness ?? 0;
    const critical = p.vitals?.criticality ?? 0;

    const rate = 0.82 + winded * 1.55 + critical * 0.5;
    this.breathT += dt * rate;

    // Two incommensurate sines plus a slow noise drift: never repeats visibly.
    const b1 = Math.sin(this.breathT * 2.05);
    const b2 = Math.sin(this.breathT * 1.31 + 1.73);
    const drift = noise1(this.time * 0.14 + 5.5);
    const drift2 = noise1(this.time * 0.11 + 41.2);

    // Holding your breath while aiming: the drift shrinks and slows, but the
    // longer you hold the more it creeps back.
    const adsHold = p.ads ? 1 : 0;
    this.holdBreath = damp(this.holdBreath, adsHold, p.ads ? 6 : 3, dt);
    const holdScale = 1 - this.holdBreath * (1 - TUNE.breathAdsScale) * (1 - winded * 0.45);

    let amp = (TUNE.breathBase + winded * TUNE.breathWinded + critical * 0.0026) * holdScale;
    if (!p.grounded) amp *= 0.55;

    this.breath.pitch = (b1 * 0.65 + drift * 0.55) * amp;
    this.breath.yaw = (b2 * 0.8 + drift2 * 0.6) * amp * 1.25;
    this.breath.y = b1 * amp * 0.34;
  }

  _stepShake(dt) {
    this._shakeRot.set(0, 0, 0);
    this._shakePos.set(0, 0, 0);
    this.trauma = 0;
    if (this.concussion > 0) this.concussion = Math.max(0, this.concussion - dt * 0.55);

    const list = this.shakes;
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      s.t += dt;
      if (s.t >= s.dur) { list.splice(i, 1); continue; }

      // Quadratic decay: the tail is short, the punch is not.
      const life = 1 - s.t / s.dur;
      const trauma = s.amp * life * life;
      this.trauma = Math.max(this.trauma, trauma);

      const t = this.time * s.freq + s.seed;
      const nx = noise1(t);
      const ny = noise1(t + 37.11);
      const nz = noise2(t * 0.63, s.seed * 0.19);

      this._shakeRot.x += nx * trauma * TUNE.shakeRot;
      this._shakeRot.y += ny * trauma * TUNE.shakeRot;
      this._shakeRot.z += nz * trauma * TUNE.shakeRot * 0.75;

      this._shakePos.x += ny * trauma * TUNE.shakePos;
      this._shakePos.y += nx * trauma * TUNE.shakePos;
      this._shakePos.z += nz * trauma * TUNE.shakePos * 0.5;

      // Directional bias: an explosion to your left should push the view right,
      // not just rattle it symmetrically.
      if (s.dir) {
        const lat = s.dir.x * this._right.x + s.dir.z * this._right.z;
        const fwd = s.dir.x * this._fwd.x + s.dir.z * this._fwd.z;
        const bias = trauma * 0.55;
        this._shakeRot.y -= lat * bias * TUNE.shakeRot * 1.4;
        this._shakeRot.x -= s.dir.y * bias * TUNE.shakeRot * 1.4;
        this._shakePos.x -= lat * bias * TUNE.shakePos * 1.8;
        this._shakePos.z -= fwd * bias * TUNE.shakePos * 1.2;
      }
    }

    // Concussion adds a slow, wide wobble on top of any impulse shakes.
    if (this.concussion > 0.001) {
      const c = this.concussion;
      this._shakeRot.x += noise1(this.time * 2.1 + 11) * c * 1.7 * DEG;
      this._shakeRot.y += noise1(this.time * 1.7 + 88) * c * 2.1 * DEG;
      this._shakeRot.z += noise1(this.time * 1.3 + 51) * c * 2.6 * DEG;
    }

    const m = TUNE.shakeMaxRot;
    this._shakeRot.x = THREE.MathUtils.clamp(this._shakeRot.x, -m, m);
    this._shakeRot.y = THREE.MathUtils.clamp(this._shakeRot.y, -m, m);
    this._shakeRot.z = THREE.MathUtils.clamp(this._shakeRot.z, -m, m);
  }

  _stepImpacts(dt, mv) {
    this.landY.step(dt, 0);
    this.landPitch.step(dt, 0);
    this.landRoll.step(dt, 0);
    this.footY.step(dt, 0);
    this.flinchPitch.step(dt, 0);
    this.flinchYaw.step(dt, 0);
    this.fovPunch.step(dt, 0);

    // Stair smoothing: a fast but not instantaneous catch-up.
    this.stepSmooth = damp(this.stepSmooth, 0, 10, dt);
    if (Math.abs(this.stepSmooth) < 1e-4) this.stepSmooth = 0;

    if (this.dying) {
      this.deathT += dt;
      const t = easeOutCubic(clamp01(this.deathT / 1.35));
      this.deathRoll = t * (this._deathSide || 1) * 62 * DEG;
    } else if (this.deathRoll !== 0) {
      this.deathRoll = damp(this.deathRoll, 0, 6, dt);
      if (Math.abs(this.deathRoll) < 1e-4) this.deathRoll = 0;
    }
  }

  _stepFov(dt, mv) {
    const s = this.game?.settings;
    const base = s?.fov ?? 90;
    const p = this.player;

    let target = base;
    let smooth = TUNE.fovSmoothOut;

    const adsFovRaw = this.game?.weapons?.adsFov;
    if (p.ads && Number.isFinite(adsFovRaw) && adsFovRaw > 0) {
      // Accept either an absolute horizontal FOV or a multiplier of the base.
      target = adsFovRaw < 5 ? base * adsFovRaw : adsFovRaw;
      smooth = TUNE.fovSmoothIn;
    } else if (p.ads) {
      target = base * 0.78;                 // sane default until weapons lands
      smooth = TUNE.fovSmoothIn;
    } else if (mv) {
      if (mv.sprinting) target += TUNE.sprintFov + (mv.tactical ? TUNE.tacticalFov : 0);
      if (mv.slide?.active) target += TUNE.slideFov;
      target += THREE.MathUtils.clamp(mv.horizontalSpeed - 4.6, 0, 4.5) * TUNE.speedFov;
      smooth = mv.sprinting || mv.slide?.active ? 0.20 : TUNE.fovSmoothOut;
    }

    this.fovSmooth.step(target, smooth, dt);
    this.fov = this.fovSmooth.value + this.fovPunch.value;
    if (!p.scripted) this._applyFov(this.fov);
  }

  _applyFov(fov, force = false) {
    const eng = this.game?.engine;
    if (!eng?.setHorizontalFov) return;
    const aspect = eng.camera?.aspect ?? 1;
    if (!force && Math.abs(fov - this._lastAppliedFov) < 0.008
        && Math.abs(aspect - this._lastAspect) < 1e-4) return;
    this._lastAppliedFov = fov;
    this._lastAspect = aspect;
    eng.setHorizontalFov(THREE.MathUtils.clamp(fov, 30, 140));
  }

  /* ------------------------------------------------------------------ */

  _compose(cam, dt, mv, stance) {
    const p = this.player;

    const lean = mv ? mv.lean : 0;
    const leanOffset = mv ? mv.leanOffset : 0;

    // --- position -------------------------------------------------------
    const eyeY = stance.eyeHeight
      + this.stepSmooth
      + this.landY.value
      + this.footY.value
      + this.bob.y
      + this.breath.y
      + this._shakePos.y
      - Math.abs(lean) * TUNE.leanDrop
      - this.mantleBlend * 0.11;

    const lateral = leanOffset
      + this.bob.x
      + this._shakePos.x
      + this.swayPos.x
      + this.sway.x * 0.10;

    const forward = this.bob.z
      + this._shakePos.z
      - this.viewKick.z * TUNE.viewRecoilCameraShare
      - this.mantleBlend * 0.05;

    cam.position.set(
      p.position.x + this._right.x * lateral + this._fwd.x * forward,
      p.position.y + eyeY,
      p.position.z + this._right.z * lateral + this._fwd.z * forward,
    );

    // --- rotation -------------------------------------------------------
    const share = TUNE.viewRecoilCameraShare;
    let pitch = p.pitch
      + this.aimPitch.value
      + this.viewKick.pitch * share
      + this.bob.pitch
      + this.breath.pitch
      + this.sway.y * TUNE.swayCameraShare
      + this.landPitch.value
      + this.flinchPitch.value
      + this._shakeRot.x
      + this.mantleBlend * 3.5 * DEG;

    let camYaw = p.yaw
      + this.aimYaw.value
      + this.viewKick.yaw * share
      + this.bob.yaw
      + this.breath.yaw
      + this.sway.x * TUNE.swayCameraShare
      + this.flinchYaw.value
      + this._shakeRot.y;

    const roll = -lean * TUNE.leanRoll
      + this.bob.roll
      + this.strafeTilt * TUNE.strafeRoll
      + this.viewKick.roll * share
      + this.landRoll.value
      + this._shakeRot.z
      - this.slideRoll
      + this.deathRoll;

    pitch = THREE.MathUtils.clamp(pitch, -MAX_PITCH - 0.06, MAX_PITCH + 0.06);

    cam.rotation.order = 'YXZ';
    cam.rotation.set(pitch, camYaw, roll);

    this.composedPitch = pitch;
    this.composedYaw = camYaw;
    this.composedRoll = roll;
  }

  /**
   * Keep the viewmodel camera glued to the world camera. It has its own tight
   * near plane and its own FOV (owned by the weapons module); only the
   * transform is ours, and only because everything else in the frame depends
   * on it being exact.
   */
  _syncViewCamera(cam) {
    const vc = this.game?.engine?.viewCamera;
    if (!vc) return;
    vc.position.copy(cam.position);
    vc.rotation.order = cam.rotation.order;
    vc.rotation.copy(cam.rotation);
    vc.updateMatrixWorld();
  }

  /* ================================================================== */

  /** World-space forward the crosshair is actually looking down. */
  getAimDirection(out = new THREE.Vector3()) {
    const cam = this.game?.camera;
    if (cam) return out.set(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
    const p = this.player;
    const pitch = p.pitch + this.aimPitch.value;
    const yaw = p.yaw + this.aimYaw.value;
    const cp = Math.cos(pitch);
    return out.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp).normalize();
  }

  /** Aim excluding bob/sway/shake — for AI cone checks and debug reticles. */
  getStableAimDirection(out = new THREE.Vector3()) {
    const p = this.player;
    const pitch = THREE.MathUtils.clamp(p.pitch + this.aimPitch.value, -MAX_PITCH, MAX_PITCH);
    const yaw = p.yaw + this.aimYaw.value;
    const cp = Math.cos(pitch);
    return out.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp).normalize();
  }
}

export { TUNE as CAMERA_TUNING };
