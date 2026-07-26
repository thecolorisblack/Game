import * as THREE from 'three';
import { MODEL_BUILDERS } from './models/index.js';
import { buildClips } from './Loadout.js';

/**
 * One weapon: its procedural model, its ammunition state and its fire timing.
 *
 * Deliberately dumb about presentation — the viewmodel reads from here, never
 * the other way round — and deliberately smart about the numbers a shooter
 * actually feels: rate of fire measured in seconds per round rather than
 * frames, a spread cone assembled from stance + movement + accumulated bloom,
 * and a recoil pattern index that only resets after the trigger has been off
 * long enough.
 */
export class Weapon {
  constructor(game, def, palette) {
    this.game = game;
    this.def = def;
    this.id = def.id;
    this.name = def.name;
    this.displayName = def.displayName;
    this.className = def.className;
    this.palette = palette;

    /* --- stats mirrored for the ballistics module --- */
    this.damage = def.damage;
    this.falloff = def.falloff;
    this.multipliers = def.multipliers;
    this.penetration = def.penetration;
    this.range = def.range;
    this.pellets = def.pellets ?? 1;
    this.tracerColor = def.tracerColor;

    /* --- ammo --- */
    this.magSize = def.magSize;
    this.mag = def.magSize;
    this.reserve = def.reserve;
    this.chambered = true;

    /* --- fire control --- */
    this.fireModes = def.fireModes || ['semi'];
    this.modeIndex = 0;
    this.fireMode = this.fireModes[0];
    this.shotInterval = 60 / Math.max(1, def.rpm);
    this.nextFireAt = 0;
    this.burstRemaining = 0;
    this.burstCooldownUntil = 0;

    /* --- recoil / spread state --- */
    this.shotIndex = 0;
    this.lastShotAt = -10;
    this.bloom = 0;

    this.model = null;
    this.clips = buildClips(def);
    this.ready = false;
  }

  /* ---------------------------------------------------------------- */

  build() {
    const builder = MODEL_BUILDERS[this.def.model];
    if (!builder) {
      console.warn(`[Weapons] no model builder for "${this.def.model}"`);
      return this;
    }
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    this.model = builder(this.palette, this.def.modelOptions || {});
    this.model.root.visible = false;
    this.model.root.matrixAutoUpdate = true;
    this.buildMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    this.ready = true;
    return this;
  }

  /* ---------------------------------------------------------------- */
  /* fire control                                                      */
  /* ---------------------------------------------------------------- */

  get empty() { return this.mag <= 0; }
  get full() { return this.mag >= this.magSize; }
  get isAuto() { return this.fireMode === 'auto'; }
  get isBurst() { return this.fireMode === 'burst'; }

  /**
   * @param {number} now      seconds
   * @param {boolean} pressed trigger went down this frame
   * @param {boolean} held    trigger is down
   */
  wantsToFire(now, pressed, held) {
    if (now < this.nextFireAt) return false;
    if (this.fireMode === 'auto') return held;
    if (this.fireMode === 'burst') {
      if (this.burstRemaining > 0) return now >= this.nextFireAt;
      return pressed && now >= this.burstCooldownUntil;
    }
    return pressed;
  }

  /** Commit one round. Returns false if the chamber was empty. */
  consume(now) {
    if (this.mag <= 0) return false;
    this.mag--;
    this.nextFireAt = now + this.shotInterval;
    if (this.fireMode === 'burst') {
      if (this.burstRemaining <= 0) this.burstRemaining = (this.def.burstCount ?? 3);
      this.burstRemaining--;
      if (this.burstRemaining <= 0) {
        this.burstCooldownUntil = now + (this.def.burstDelay ?? 0.2);
        this.nextFireAt = this.burstCooldownUntil;
      }
    }
    // pattern index only advances while the string of fire continues
    if (now - this.lastShotAt > this.patternResetTime) this.shotIndex = 0;
    else this.shotIndex++;
    this.lastShotAt = now;
    const b = this.def.bloom || {};
    this.bloom = Math.min(b.max ?? 0.02, this.bloom + (b.perShot ?? 0.003));
    return true;
  }

  get patternResetTime() { return this.def.patternReset ?? Math.max(0.28, this.shotInterval * 2.6); }

  cycleFireMode() {
    if (this.fireModes.length < 2) return this.fireMode;
    this.modeIndex = (this.modeIndex + 1) % this.fireModes.length;
    this.fireMode = this.fireModes[this.modeIndex];
    this.burstRemaining = 0;
    return this.fireMode;
  }

  releaseTrigger() {
    if (this.fireMode !== 'burst') this.burstRemaining = 0;
  }

  /* ---------------------------------------------------------------- */
  /* spread + recoil                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Half-angle of the spread cone, radians.
   * @param {Object} ctx {adsAmount, speed, grounded, crouched}
   */
  spread(ctx) {
    const s = this.def.spread || {};
    const ads = THREE.MathUtils.clamp(ctx.adsAmount ?? 0, 0, 1);
    let cone = THREE.MathUtils.lerp(s.hip ?? 0.03, s.ads ?? 0.002, ads * ads);
    const speed = ctx.speed ?? 0;
    cone += (s.move ?? 0.02) * THREE.MathUtils.clamp(speed / 5.2, 0, 1.2) * (1 - ads * 0.55);
    if (ctx.grounded === false) cone += s.jump ?? 0.05;
    if (ctx.crouched) cone += s.crouch ?? -0.006;
    cone += this.bloom * (1 - ads * 0.4);
    return Math.max(0.00006, cone);
  }

  /** Per-shot recoil in degrees, straight off the designed pattern. */
  recoilStep(adsAmount = 0) {
    const r = this.def.recoil;
    const pat = r.pattern;
    const p = pat[Math.min(this.shotIndex, pat.length - 1)];
    const scale = THREE.MathUtils.lerp(1, r.adsScale ?? 0.75, adsAmount);
    const pitch = (p[0] + (Math.random() - 0.5) * (r.bloomPitch ?? 0.05)) * scale;
    const yaw = (p[1] + (Math.random() - 0.5) * (r.bloomYaw ?? 0.1)) * scale;
    return { pitch, yaw };
  }

  decay(dt) {
    const b = this.def.bloom || {};
    if (this.bloom > 0) {
      this.bloom = Math.max(0, this.bloom - (b.recover ?? 0.05) * dt);
    }
  }

  /* ---------------------------------------------------------------- */
  /* reloading                                                         */
  /* ---------------------------------------------------------------- */

  get needsEmptyReload() { return this.mag <= 0; }
  get canReload() { return this.reserve > 0 && this.mag < this.magSize; }

  /** Move rounds from the reserve into the magazine. */
  refill() {
    const want = this.magSize - this.mag;
    const take = Math.min(want, this.reserve);
    this.mag += take;
    this.reserve -= take;
    return take;
  }

  giveAmmo(rounds) {
    this.reserve = Math.min((this.def.maxReserve ?? this.def.reserve * 2), this.reserve + rounds);
  }

  ammoState() {
    return { mag: this.mag, reserve: this.reserve, max: this.magSize };
  }

  dispose() {
    const root = this.model?.root;
    if (!root) return;
    root.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) o.geometry?.dispose?.();
    });
    this.model.optic?.dispose?.();
  }
}
