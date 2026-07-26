import { bus } from '../core/EventBus.js';
import { Spring, moveTowards } from './Springs.js';

/**
 * Posture state machine and capsule/eye-height blending.
 *
 * Two separate quantities are animated here and they are deliberately *not* the
 * same curve:
 *
 *  - `height` is the collision capsule. It moves at a bounded rate because the
 *    character controller has to see a consistent capsule from one 120 Hz step
 *    to the next; a spring that overshoots would briefly push the capsule into
 *    a ceiling and pop the player.
 *  - `eyeHeight` is presentation. It runs on a stiff critically damped spring so
 *    dropping into a crouch has weight — a fast fall with a soft arrival —
 *    instead of the linear slide that instantly reads as "hobbyist FPS".
 *
 * Standing back up is gated on headroom, so crouching under a pipe and letting
 * go of the key does not teleport the player's head through the pipe.
 */

export const STANCE_DEFS = {
  stand: {
    capsule: 1.80, eye: 1.63,
    maxSpeed: 4.55, accel: 54, friction: 9.4,
    bob: 1.0, canJump: true, canSprint: true,
    downRate: 4.6, upRate: 3.6,
  },
  crouch: {
    capsule: 1.16, eye: 1.03,
    maxSpeed: 2.12, accel: 40, friction: 11.6,
    bob: 0.52, canJump: true, canSprint: false,
    downRate: 4.6, upRate: 3.6,
  },
  prone: {
    capsule: 0.60, eye: 0.42,
    maxSpeed: 0.92, accel: 22, friction: 13.5,
    bob: 0.26, canJump: false, canSprint: false,
    downRate: 2.4, upRate: 1.9,
  },
  slide: {
    capsule: 1.02, eye: 0.80,
    maxSpeed: 9.8, accel: 6, friction: 2.1,
    bob: 0.0, canJump: true, canSprint: false,
    downRate: 9.0, upRate: 5.5,
  },
  mantle: {
    capsule: 1.30, eye: 1.10,
    maxSpeed: 0, accel: 0, friction: 0,
    bob: 0.0, canJump: false, canSprint: false,
    downRate: 6.0, upRate: 4.0,
  },
  vault: {
    capsule: 1.16, eye: 1.05,
    maxSpeed: 0, accel: 0, friction: 0,
    bob: 0.0, canJump: false, canSprint: false,
    downRate: 8.0, upRate: 5.0,
  },
  dead: {
    capsule: 0.55, eye: 0.30,
    maxSpeed: 0, accel: 0, friction: 14,
    bob: 0.0, canJump: false, canSprint: false,
    downRate: 3.2, upRate: 2.0,
  },
};

/** The four ids other systems are allowed to switch on (ARCHITECTURE.md). */
const CANONICAL = {
  stand: 'stand', crouch: 'crouch', prone: 'crouch', slide: 'slide',
  mantle: 'air', vault: 'air', dead: 'crouch',
};

export class Stance {
  constructor(player) {
    this.player = player;

    this.name = 'stand';
    this.previous = 'stand';
    this.canonical = 'stand';

    const def = STANCE_DEFS.stand;
    this.height = def.capsule;
    this.eyeHeight = def.eye;
    this.eyeSpring = new Spring(24, 1.0, def.eye);

    // 0 = fully standing, 1 = fully at the target posture. Drives viewmodel
    // lowering and the HUD's stance pip.
    this.blend = 0;

    this.crouchHeld = false;
    this._lastEmitted = null;
    this._crushT = 0;
  }

  get def() { return STANCE_DEFS[this.name] || STANCE_DEFS.stand; }

  /** Height the capsule is heading toward, ignoring the current blend. */
  get targetHeight() { return this.def.capsule; }

  isLow() { return this.name === 'crouch' || this.name === 'prone' || this.name === 'slide'; }

  /**
   * Switch posture. Returns false when the change is refused (no headroom).
   * `force` skips the headroom test — used by the mantle, which has already
   * validated its landing volume.
   */
  set(name, force = false) {
    if (!STANCE_DEFS[name] || name === this.name) return true;
    const target = STANCE_DEFS[name].capsule;
    if (!force && target > this.height + 1e-3 && !this.hasHeadroom(target)) return false;
    this.previous = this.name;
    this.name = name;
    return true;
  }

  /** Sphere-cast the delta between the current and requested capsule tops. */
  hasHeadroom(targetHeight) {
    const p = this.player;
    const phys = p.game?.physics;
    const need = targetHeight - this.height;
    if (need <= 1e-3) return true;
    if (!phys?.sphereCast) return true;
    const r = p.radius;
    const from = p._scratchA.set(
      p.position.x,
      p.position.y + Math.max(r, this.height - r),
      p.position.z,
    );
    const hit = phys.sphereCast(from, p._up, r * 0.9, need + 0.05);
    return !hit;
  }

  /**
   * Total capsule height that fits between the feet and whatever is overhead.
   * A sphere of radius 0.9r swept up from the bottom cap: if it stops after
   * `d`, the ceiling sits at feet + 1.9r + d, which is the tallest capsule that
   * fits (its top cap has radius r).
   */
  ceilingRoom(limit = STANCE_DEFS.stand.capsule) {
    const p = this.player;
    const phys = p.game?.physics;
    if (!phys?.sphereCast) return limit;
    const r = p.radius;
    const from = p._scratchA.set(p.position.x, p.position.y + r, p.position.z);
    const hit = phys.sphereCast(from, p._up, r * 0.9, limit);
    if (!hit) return limit;
    return Math.max(STANCE_DEFS.prone.capsule, r * 1.9 + hit.distance);
  }

  /** Advance the height blends. Called from Movement at fixed rate. */
  step(dt) {
    // Crush guard, throttled to 20 Hz. Spawning or teleporting a standing
    // capsule into a crawlspace otherwise wedges it between the floor and the
    // ceiling, and the depenetration pass happily squeezes it through the
    // floor. Shrinking on contact is always the safe resolution.
    this._crushT -= dt;
    if (this._crushT <= 0) {
      const room = this.ceilingRoom(this.height + 0.05);
      // While a violation is live, re-check every step: 50 ms of a capsule
      // wedged against a ceiling is long enough for depenetration to squeeze it
      // through the floor.
      this._crushT = room < this.height - 0.02 ? 0 : 0.05;
      if (room < this.height - 0.02) {
        this.height = Math.max(STANCE_DEFS.prone.capsule, room);
        if (room < STANCE_DEFS.crouch.capsule - 0.02) {
          if (this.name !== 'prone' && this.name !== 'dead') this.name = 'prone';
        } else if (this.name === 'stand') {
          this.name = 'crouch';
        }
      }
    }

    // Capsule: rate limited, and never grows into geometry.
    const target = this.def.capsule;
    if (target > this.height) {
      const room = this._headroomAllowance(target);
      this.height = moveTowards(this.height, Math.min(target, room), this.def.upRate * dt);
    } else {
      this.height = moveTowards(this.height, target, this.def.downRate * dt);
    }

    // Eyes: stiff critically damped spring, plus a small extra lag while the
    // capsule is still travelling so the head trails the body a touch.
    const eyeTarget = this.def.eye;
    this.eyeSpring.freq = this.name === 'prone' ? 15 : 24;
    this.eyeHeight = this.eyeSpring.step(dt, eyeTarget);
    // Never let the eye poke out through the top of the capsule.
    const ceil = Math.max(0.22, this.height - 0.08);
    if (this.eyeHeight > ceil) this.eyeHeight = ceil;

    const standH = STANCE_DEFS.stand.capsule;
    this.blend = Math.min(1, Math.max(0, (standH - this.height) / (standH - STANCE_DEFS.prone.capsule)));

    this._syncCanonical();
  }

  _headroomAllowance(target) {
    const phys = this.player.game?.physics;
    if (!phys?.sphereCast) return target;
    const p = this.player;
    const r = p.radius;
    const need = target - this.height;
    if (need <= 1e-3) return target;
    const from = p._scratchA.set(
      p.position.x,
      p.position.y + Math.max(r, this.height - r),
      p.position.z,
    );
    const hit = phys.sphereCast(from, p._up, r * 0.9, need + 0.06);
    if (!hit) return target;
    return Math.max(STANCE_DEFS.prone.capsule, this.height + Math.max(0, hit.distance - 0.02));
  }

  _syncCanonical() {
    const p = this.player;
    let canon = CANONICAL[this.name] || 'stand';
    if (!p.grounded && canon !== 'slide' && this.name !== 'dead') canon = 'air';
    const changed = canon !== this.canonical || this.name !== this._lastEmitted;
    this.canonical = canon;
    if (!changed) return;
    this._lastEmitted = this.name;
    bus.emit('player:stance', {
      stance: canon,
      raw: this.name,
      height: this.height,
      eyeHeight: this.eyeHeight,
      blend: this.blend,
    });
  }

  /** Snap everything, used on spawn and respawn. */
  snap(name = 'stand') {
    this.name = STANCE_DEFS[name] ? name : 'stand';
    this.previous = this.name;
    const def = this.def;
    this.height = def.capsule;
    this.eyeHeight = def.eye;
    this.eyeSpring.reset(def.eye);
    this.blend = 0;
    this._lastEmitted = null;
    this._crushT = 0;   // re-evaluate headroom on the very next step
  }
}
