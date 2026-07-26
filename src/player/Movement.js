import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { STANCE_DEFS } from './Stance.js';
import { clamp01, easeOutCubic, smoothstep, damp } from './Springs.js';

/**
 * Ground/air locomotion, stance transitions, slide, mantle/vault, lean and
 * footstep cadence. Runs entirely inside `fixedUpdate` at 120 Hz so the feel is
 * identical at 30 fps and 240 fps.
 *
 * Design notes worth keeping:
 *
 *  - Acceleration is the Quake "add up to the shortfall along wish-dir" model
 *    with acceleration expressed in m/s^2. Ground friction uses a stop-speed
 *    floor so the last metre per second bleeds off fast and the player stops
 *    crisply instead of ice-skating.
 *  - Air movement keeps the classic strafe projection (you may only add speed up
 *    to a small cap along the wish direction) which is what makes mid-air
 *    corrections feel *earned*, plus a dot-weighted air-control term so holding
 *    forward still steers a jump the way a modern shooter expects.
 *  - Velocity is clipped against the wall normal returned by `capsuleMove` every
 *    step. Without that, a player running along a wall keeps re-injecting
 *    velocity into it, the controller keeps pushing back, and the camera buzzes
 *    at the step rate. Clipping is the difference between "slides along a wall"
 *    and "vibrates against a wall".
 *  - Footsteps and the camera's figure-eight bob share one gait phase driven by
 *    distance travelled, so the foot plant and the bottom of the bob are the
 *    same event by construction rather than by tuning two timers to agree.
 */

const UP = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);
const DEG = Math.PI / 180;

const TUNE = {
  radius: 0.34,

  sprintSpeed: 7.05,
  tacticalSpeed: 8.55,
  // With this friction model the terminal speed is accel/friction, so the pair
  // has to clear the tactical-sprint target or the wish speed is never reached.
  // Lower sprint friction also gives the sprint a longer glide than a walk.
  sprintAccel: 66,
  sprintFriction: 6.2,

  adsSpeedScale: 0.52,
  backSpeedScale: 0.80,
  strafeSpeedScale: 0.90,
  leanSpeedScale: 0.78,

  airAccel: 78,
  airWishCap: 1.55,      // classic strafe-accel projection cap (m/s)
  airControl: 5.2,       // dot-weighted steering authority
  airFriction: 0.12,

  jumpSpeed: 6.30,
  jumpCutMultiplier: 1.95,
  apexGravity: 0.66,     // hang time near the apex
  riseGravity: 0.94,
  fallGravity: 1.30,
  terminalVelocity: 58,

  coyoteTime: 0.13,
  jumpBuffer: 0.16,
  jumpCooldown: 0.10,

  slideEntrySpeed: 4.1,
  slideBoost: 8.9,
  slideMaxTime: 1.55,
  slideMinSpeed: 2.55,
  slideFriction: 1.15,
  slideSteer: 1.5,       // rad/s of steering authority while sliding
  slideCooldown: 0.42,
  slideSlopeGain: 12.0,

  mantleMinRise: 0.32,
  mantleMaxRise: 1.68,
  mantleReach: 0.98,

  stepSmoothMax: 0.62,

  slopeLimit: 47 * DEG,
  stepHeight: 0.46,

  fallDamageSpeed: 12.4,
  fallDeathSpeed: 26.0,
};

function applyFriction(vel, friction, dt, stopSpeed) {
  const speed = Math.hypot(vel.x, vel.z);
  if (speed < 1e-5) { vel.x = 0; vel.z = 0; return; }
  const control = speed < stopSpeed ? stopSpeed : speed;
  let ns = speed - control * friction * dt;
  if (ns < 0) ns = 0;
  const k = ns / speed;
  vel.x *= k; vel.z *= k;
}

function accelerate(vel, wish, wishSpeed, accel, dt) {
  const cur = vel.x * wish.x + vel.y * wish.y + vel.z * wish.z;
  const add = wishSpeed - cur;
  if (add <= 0) return;
  let a = accel * dt;
  if (a > add) a = add;
  vel.x += wish.x * a;
  vel.y += wish.y * a;
  vel.z += wish.z * a;
}

/** Crossing test for a phase that wraps in [0,1). */
function crossed(prev, next, mark) {
  if (next >= prev) return prev < mark && next >= mark;
  return prev < mark || next >= mark; // wrapped
}

export class Movement {
  constructor(player) {
    this.player = player;
    this.game = player.game;
    this.tune = TUNE;

    this.velocity = player.velocity;
    this.grounded = false;
    this.wasGrounded = false;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.groundSurface = 'concrete';
    this.groundSlope = 0;
    this.hitWall = false;
    this.wallNormal = new THREE.Vector3();

    this.coyote = 0;
    this.jumpBufferT = 0;
    this.jumpCooldownT = 0;
    this.airTime = 0;
    this.fallSpeed = 0;
    this.lastLandImpact = 0;

    this.sprinting = false;
    this.tactical = false;
    this._sprintTapTime = -10;
    this._sprintLatch = false;

    this.slide = {
      active: false, t: 0, cooldown: 0,
      dir: new THREE.Vector3(0, 0, -1),
      entrySpeed: 0, lateral: 0,
    };

    this.mantle = {
      active: false, t: 0, duration: 0, kind: 'mantle', progress: 0,
      start: new THREE.Vector3(), end: new THREE.Vector3(),
      dir: new THREE.Vector3(), rise: 0, exitSpeed: 0, arc: 0,
    };
    this._mantleProbeT = 0;

    this.lean = 0;
    this.leanTarget = 0;
    this.leanOffset = 0;
    this.leanAllowed = 0;

    this.gaitPhase = 0;
    this.strideLength = 1.7;
    this.foot = 0;
    this.distanceTravelled = 0;
    this.stepsTaken = 0;

    this.speed = 0;
    this.horizontalSpeed = 0;
    // Speed we were carrying when we hit something. Wall clipping zeroes the
    // real velocity on contact, so the vault/mantle gates need the pre-impact
    // number or you can never vault anything you actually ran into.
    this.approachSpeed = 0;
    this.speedRatio = 0;
    this.moveInput = new THREE.Vector2();
    this.wishDir = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, -1);
    this.right = new THREE.Vector3(1, 0, 0);

    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._v4 = new THREE.Vector3();
    this._downV = new THREE.Vector3(0, -1, 0);
    this._delta = new THREE.Vector3();
    this._prevPos = new THREE.Vector3();
    this._moveOpts = {
      stepUp: true, snapToGround: true, wasGrounded: true,
      slopeLimit: TUNE.slopeLimit, stepHeight: TUNE.stepHeight,
    };
    this._lastEdgeFrame = -1;
    this._stickyWallT = 0;
  }

  /* ================================================================== */
  /* main step                                                           */
  /* ================================================================== */

  fixedUpdate(dt) {
    const p = this.player;
    const stance = p.stanceCtrl;

    this._updateBasis();

    // Edge-triggered input is latched once per rendered frame; a frame that
    // runs three fixed steps must not fire three jumps.
    const frame = this.game?.time?.frame ?? 0;
    const firstStep = this._lastEdgeFrame !== frame;
    this._lastEdgeFrame = frame;

    const io = this._readIntent(firstStep);
    this.moveInput.set(io.x, io.y);

    this.slide.cooldown = Math.max(0, this.slide.cooldown - dt);
    this.jumpCooldownT = Math.max(0, this.jumpCooldownT - dt);
    this._mantleProbeT = Math.max(0, this._mantleProbeT - dt);
    if (io.jumpPressed) this.jumpBufferT = TUNE.jumpBuffer;
    else this.jumpBufferT = Math.max(0, this.jumpBufferT - dt);

    // --- scripted: the harness owns the camera, so mirror its transform back
    // into the player state and skip simulation entirely.
    if (p.scripted) {
      this._followCamera();
      stance.step(dt);
      p.eyeHeight = stance.eyeHeight;
      this._publish();
      return;
    }

    // --- mantle owns the transform while it runs -------------------------
    if (this.mantle.active) {
      this._stepMantle(dt);
      stance.step(dt);
      p.eyeHeight = stance.eyeHeight;
      this._publish();
      return;
    }

    this._updateStanceIntent(io, dt);
    this._updateSprint(io, dt);
    this._updateSlide(io, dt);

    // --- jump / mantle ---------------------------------------------------
    if (this.jumpBufferT > 0 && this.jumpCooldownT <= 0) {
      if (this._tryMantle(io)) {
        this.jumpBufferT = 0;
      } else if ((this.grounded || this.coyote > 0) && stance.def.canJump) {
        this._doJump(io);
      }
    } else if (io.wishMag > 0.2 && this.grounded && this.hitWall
               && this.approachSpeed > 3.2 && this._mantleProbeT <= 0) {
      // Auto-vault: sprinting into a low obstacle carries you over it.
      this._mantleProbeT = 0.18;
      this._tryMantle(io, true);
    }
    if (this.mantle.active) {
      stance.step(dt);
      p.eyeHeight = stance.eyeHeight;
      this._publish();
      return;
    }

    // --- integrate velocity ----------------------------------------------
    this._buildWishDir(io);
    if (this.grounded) this._groundMove(io, dt);
    else this._airMove(io, dt);

    this._applyGravity(io, dt);

    // --- collide and move -------------------------------------------------
    stance.step(dt);
    p.eyeHeight = stance.eyeHeight;
    this._collideAndMove(dt);

    // --- derived state ----------------------------------------------------
    this._updateLean(dt);
    this._updateGait(dt);
    this._publish();
  }

  /* ================================================================== */
  /* input                                                               */
  /* ================================================================== */

  _readIntent(firstStep) {
    const input = this.game?.input;
    const playing = this.game?.state === 'playing';
    const io = {
      x: 0, y: 0, wishMag: 0,
      jumpHeld: false, jumpPressed: false,
      crouchHeld: false, crouchPressed: false,
      pronePressed: false,
      sprintHeld: false, sprintPressed: false,
      leanLeft: false, leanRight: false,
    };
    if (!input || !playing) return io;

    const axes = input.moveAxes();
    io.x = axes.x; io.y = axes.y;
    io.wishMag = Math.min(1, Math.hypot(axes.x, axes.y));
    io.jumpHeld = input.action('jump');
    io.crouchHeld = input.action('crouch');
    io.sprintHeld = input.action('sprint');
    io.leanLeft = input.action('leanLeft');
    io.leanRight = input.action('leanRight');
    if (firstStep) {
      io.jumpPressed = input.actionPressed('jump');
      io.crouchPressed = input.actionPressed('crouch');
      io.sprintPressed = input.actionPressed('sprint');
      io.pronePressed = input.actionPressed('prone');
    }
    return io;
  }

  _updateBasis() {
    const yaw = this.player.yaw;
    const s = Math.sin(yaw), c = Math.cos(yaw);
    this.forward.set(-s, 0, -c);
    this.right.set(c, 0, -s);
  }

  /** Scripted mode: derive player state from the harness-owned camera. */
  _followCamera() {
    const cam = this.game?.camera;
    if (!cam) return;
    const p = this.player;
    p.position.set(cam.position.x, cam.position.y - p.stanceCtrl.eyeHeight, cam.position.z);
    p.yaw = cam.rotation.y;
    p.pitch = cam.rotation.x;
    this.velocity.set(0, 0, 0);
    this.grounded = true;
    this.horizontalSpeed = 0;
    this.speed = 0;
    this.speedRatio = 0;
    this.sprinting = false;
    this.tactical = false;
  }

  /* ================================================================== */
  /* stances                                                             */
  /* ================================================================== */

  _updateStanceIntent(io, dt) {
    const stance = this.player.stanceCtrl;
    if (stance.name === 'dead') return;

    stance.crouchHeld = io.crouchHeld;

    if (io.pronePressed) {
      if (stance.name === 'prone') stance.set('crouch');
      else if (this.grounded) stance.set('prone');
      return;
    }

    if (stance.name === 'slide') return; // handled by the slide logic

    if (stance.name === 'prone') {
      // Any crouch or jump press brings you back up one level — and consumes
      // the press, so getting up out of prone is never also a jump.
      if (io.crouchPressed || io.jumpPressed) {
        stance.set('crouch');
        this.jumpBufferT = 0;
      }
      return;
    }

    if (io.crouchHeld) {
      if (stance.name !== 'crouch') stance.set('crouch');
    } else if (stance.name === 'crouch') {
      stance.set('stand'); // silently refused while there is no headroom
    }
  }

  /* ================================================================== */
  /* sprint                                                             */
  /* ================================================================== */

  _updateSprint(io, dt) {
    const p = this.player;
    const stance = p.stanceCtrl;
    const vitals = p.vitals;
    const now = this.game?.time?.now ?? 0;

    if (io.sprintPressed) {
      if (now - this._sprintTapTime < 0.34) this._sprintLatch = true;
      this._sprintTapTime = now;
    }

    const wantsForward = io.y > 0.35 && io.wishMag > 0.4;
    const allowed = io.sprintHeld
      && wantsForward
      && !p.ads
      && !stance.isLow()
      && stance.def.canSprint
      && (vitals ? vitals.canSprint && vitals.stamina > 1 : true)
      && !this.slide.active;

    this.sprinting = allowed && (this.horizontalSpeed > 1.0 || io.wishMag > 0.5);
    if (!this.sprinting) this._sprintLatch = false;

    const staminaOk = vitals ? vitals.stamina > 12 : true;
    this.tactical = this.sprinting && this._sprintLatch && staminaOk
      && this.horizontalSpeed > 3.0;

    p.sprinting = this.sprinting;
    p.tacticalSprint = this.tactical;
  }

  /* ================================================================== */
  /* slide                                                              */
  /* ================================================================== */

  _updateSlide(io, dt) {
    const s = this.slide;
    const p = this.player;
    const stance = p.stanceCtrl;

    if (!s.active) {
      const canEnter = io.crouchPressed
        && this.grounded
        && !p.ads
        && this.horizontalSpeed >= TUNE.slideEntrySpeed
        && s.cooldown <= 0
        && stance.name !== 'prone';
      if (canEnter) this._startSlide();
      return;
    }

    s.t += dt;

    // Steering: you may curve the slide, but only by rotating the existing
    // momentum, never by adding to it. That keeps the slide a commitment.
    if (Math.abs(io.x) > 0.05) {
      const turn = -io.x * TUNE.slideSteer * dt;
      const cs = Math.cos(turn), sn = Math.sin(turn);
      const vx = this.velocity.x, vz = this.velocity.z;
      this.velocity.x = vx * cs - vz * sn;
      this.velocity.z = vx * sn + vz * cs;
      s.lateral = damp(s.lateral, io.x, 8, dt);
    } else {
      s.lateral = damp(s.lateral, 0, 6, dt);
    }

    // Slope: downhill accelerates, uphill scrubs speed hard.
    if (this.grounded) {
      const n = this.groundNormal;
      const slopeDot = -(n.x * this.velocity.x + n.z * this.velocity.z);
      const gain = slopeDot * TUNE.slideSlopeGain * dt;
      const hs = Math.hypot(this.velocity.x, this.velocity.z) || 1e-4;
      this.velocity.x += (this.velocity.x / hs) * gain;
      this.velocity.z += (this.velocity.z / hs) * gain;

      const uphill = slopeDot < -0.02;
      applyFriction(this.velocity, TUNE.slideFriction * (uphill ? 3.4 : 1), dt, 0.5);
    }

    const speed = Math.hypot(this.velocity.x, this.velocity.z);

    let end = null;
    if (io.jumpPressed && (this.grounded || this.coyote > 0)) end = 'jump';
    else if (s.t > TUNE.slideMaxTime) end = 'timeout';
    else if (speed < TUNE.slideMinSpeed) end = 'slow';
    else if (!io.crouchHeld && s.t > 0.22) end = 'cancel';
    else if (!this.grounded && s.t > 0.30) end = 'air';

    if (end) this._endSlide(end, io);
  }

  _startSlide() {
    const s = this.slide;
    const stance = this.player.stanceCtrl;
    const hs = Math.hypot(this.velocity.x, this.velocity.z);
    s.active = true;
    s.t = 0;
    s.entrySpeed = hs;
    s.lateral = 0;
    s.dir.set(this.velocity.x, 0, this.velocity.z);
    if (s.dir.lengthSq() > 1e-6) s.dir.normalize(); else s.dir.copy(this.forward);

    // Momentum boost, but only up to the boost ceiling: entering a slide from
    // a bunny-hop must not be faster than entering it from a clean sprint.
    const boosted = Math.min(TUNE.slideBoost, Math.max(hs * 1.16, TUNE.slideBoost * 0.86));
    this.velocity.x = s.dir.x * boosted;
    this.velocity.z = s.dir.z * boosted;

    stance.set('slide', true);
    this.player.rig?.slideStart?.(boosted);
    this.player.vitals?.spendStamina?.(8);
  }

  _endSlide(reason, io) {
    const s = this.slide;
    const stance = this.player.stanceCtrl;
    s.active = false;
    s.cooldown = TUNE.slideCooldown;

    if (reason === 'jump') {
      // Slide-hop: keep the horizontal momentum, pay a small tax.
      this.velocity.x *= 0.94;
      this.velocity.z *= 0.94;
      stance.set('stand') || stance.set('crouch', true);
      this._doJump(io, 0.96);
      return;
    }

    const wantCrouch = io.crouchHeld || reason === 'slow';
    if (wantCrouch) {
      stance.set('crouch', true);
    } else if (!stance.set('stand')) {
      stance.set('crouch', true);
    }

    if (reason === 'cancel') {
      // Slide cancel: standing up early trades a little speed for the ability
      // to shoot immediately. Cap at sprint speed so it is not a free boost.
      const hs = Math.hypot(this.velocity.x, this.velocity.z);
      const cap = TUNE.sprintSpeed * 1.02;
      if (hs > cap) {
        const k = cap / hs;
        this.velocity.x *= k; this.velocity.z *= k;
      }
      this.player.rig?.slideCancel?.();
    }
  }

  /* ================================================================== */
  /* jump                                                               */
  /* ================================================================== */

  _doJump(io, scale = 1) {
    const p = this.player;
    const stance = p.stanceCtrl;

    if (stance.name === 'prone') { stance.set('crouch'); return; }
    if (stance.name === 'crouch' && !stance.set('stand')) return; // no headroom

    let speed = TUNE.jumpSpeed * scale;
    if (stance.name === 'crouch') speed *= 0.86;
    const stam = p.vitals?.stamina ?? 100;
    if (stam < 20) speed *= 0.88;

    this.velocity.y = Math.max(this.velocity.y, 0) + speed;
    this.grounded = false;
    this.coyote = 0;
    this.jumpBufferT = 0;
    this.jumpCooldownT = TUNE.jumpCooldown;
    this.airTime = 0;
    this.fallSpeed = 0;
    this._jumpHeld = true;

    p.vitals?.spendStamina?.(7);
    p.rig?.jumpImpulse?.(speed / TUNE.jumpSpeed);
  }

  _applyGravity(io, dt) {
    if (this.grounded && this.velocity.y <= 0.01) return;
    const g = this.game?.physics?.gravity ?? -18.5;
    const vy = this.velocity.y;

    let mult;
    if (vy > 0.85) mult = io.jumpHeld ? TUNE.riseGravity : TUNE.jumpCutMultiplier;
    else if (vy > -0.85) mult = TUNE.apexGravity;   // apex hang: the "float"
    else mult = TUNE.fallGravity;                   // then a decisive fall

    this.velocity.y += g * mult * dt;
    if (this.velocity.y < -TUNE.terminalVelocity) this.velocity.y = -TUNE.terminalVelocity;
  }

  /* ================================================================== */
  /* acceleration                                                        */
  /* ================================================================== */

  _buildWishDir(io) {
    const w = this.wishDir;
    w.set(0, 0, 0);
    if (io.wishMag < 1e-3) return;
    w.addScaledVector(this.forward, io.y).addScaledVector(this.right, io.x);
    const len = w.length();
    if (len > 1e-5) w.multiplyScalar(1 / len); else w.set(0, 0, 0);
  }

  _wishSpeed(io) {
    const p = this.player;
    const stance = p.stanceCtrl;
    let base = stance.def.maxSpeed;

    if (stance.name === 'stand') {
      if (this.tactical) base = TUNE.tacticalSpeed;
      else if (this.sprinting) base = TUNE.sprintSpeed;
    }

    // Directional penalties: backpedalling and pure strafing are slower, which
    // is what makes peeking a corner a decision rather than a formality.
    if (!this.sprinting) {
      if (io.y < -0.2) base *= TUNE.backSpeedScale;
      else if (Math.abs(io.y) < 0.25 && Math.abs(io.x) > 0.4) base *= TUNE.strafeSpeedScale;
    }
    if (p.ads) base *= stance.name === 'crouch' ? TUNE.adsSpeedScale * 1.18 : TUNE.adsSpeedScale;
    if (Math.abs(this.lean) > 0.05) base *= 1 - (1 - TUNE.leanSpeedScale) * Math.abs(this.lean);

    const stam = p.vitals?.stamina ?? 100;
    if (stam < 12) base *= 0.90 + 0.10 * (stam / 12);

    return base * io.wishMag;
  }

  _groundMove(io, dt) {
    const stance = this.player.stanceCtrl;
    if (this.slide.active) return; // slide runs its own friction model

    // Align the wish direction with the ground plane so climbing a ramp does
    // not bleed speed into the surface.
    const w = this.wishDir;
    if (w.lengthSq() > 1e-6 && this.groundNormal.y > 0.2) {
      const d = w.dot(this.groundNormal);
      w.addScaledVector(this.groundNormal, -d);
      const l = w.length();
      if (l > 1e-5) w.multiplyScalar(1 / l);
    }

    let friction = stance.def.friction;
    let accel = stance.def.accel;
    if (this.sprinting) { friction = TUNE.sprintFriction; accel = TUNE.sprintAccel; }
    if (io.wishMag < 0.05) friction *= 1.25;   // stop harder with no input

    // The stop-speed floor makes the last metre per second bleed off fast, but
    // it has to scale with the stance: a flat 2.1 floor drains more per step
    // than a prone crawl can ever accelerate, and the player never moves.
    const stopSpeed = Math.min(2.1, stance.def.maxSpeed * 0.5);
    applyFriction(this.velocity, friction, dt, stopSpeed);
    if (w.lengthSq() > 1e-6) accelerate(this.velocity, w, this._wishSpeed(io), accel, dt);
  }

  _airMove(io, dt) {
    const w = this.wishDir;
    const v = this.velocity;

    if (TUNE.airFriction > 0) applyFriction(v, TUNE.airFriction, dt, 0.6);
    if (w.lengthSq() < 1e-6) return;

    const wishSpeed = this._wishSpeed(io);

    // Classic strafe projection: you may only close the gap up to a small cap,
    // so air speed comes from *aiming* the wish vector, not from holding a key.
    accelerate(v, w, Math.min(wishSpeed, TUNE.airWishCap), TUNE.airAccel, dt);

    // Dot-weighted air control: steer the existing horizontal velocity toward
    // the wish direction without changing its magnitude.
    const vy = v.y;
    v.y = 0;
    const speed = v.length();
    if (speed > 0.35) {
      v.multiplyScalar(1 / speed);
      const dot = v.dot(w);
      if (dot > 0) {
        const k = TUNE.airControl * dot * dot * dt * (0.4 + 0.6 * Math.abs(io.y));
        v.x = v.x + w.x * k;
        v.z = v.z + w.z * k;
        const l = Math.hypot(v.x, v.z);
        if (l > 1e-5) { v.x /= l; v.z /= l; }
      }
      v.multiplyScalar(speed);
    }
    v.y = vy;

    // Soft ceiling so chained hops cannot compound forever.
    const hs = Math.hypot(v.x, v.z);
    const cap = TUNE.tacticalSpeed * 1.22;
    if (hs > cap) {
      const k = Math.max(0, 1 - (hs - cap) * 1.4 * dt);
      v.x *= k; v.z *= k;
    }
  }

  /* ================================================================== */
  /* collide + move                                                      */
  /* ================================================================== */

  _collideAndMove(dt) {
    const p = this.player;
    const phys = this.game?.physics;
    const stance = p.stanceCtrl;

    this._prevPos.copy(p.position);

    const preSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.approachSpeed = Math.max(preSpeed, this.approachSpeed - dt * 9);

    // Pre-clip against the wall we were already touching. Clipping only *after*
    // the move is not enough: acceleration re-injects roughly accel*dt of
    // velocity into the wall every step, the capsule penetrates by that much,
    // and depenetration shoves it back — a few millimetres of buzz at 120 Hz,
    // which is exactly the shimmer you see when a bad controller hugs geometry.
    //
    // The memory has to be sticky. A capsule resting exactly on the skin
    // distance reports no contact on some steps, so `hitWall` flickers; without
    // the timer the clip drops out every other step and the buzz comes back at
    // half the frequency instead of disappearing. Clipping only ever removes
    // motion *into* the plane, so holding it for a moment after separating is
    // free — walking away has a positive dot and is untouched.
    this._stickyWallT = Math.max(0, this._stickyWallT - dt);
    if (this._stickyWallT > 0 && this.wallNormal.lengthSq() > 1e-6) {
      const n = this.wallNormal;   // horizontal by construction
      const into = this.velocity.x * n.x + this.velocity.z * n.z;
      if (into < 0) {
        this.velocity.x -= n.x * into;
        this.velocity.z -= n.z * into;
      }
    }

    this._delta.copy(this.velocity).multiplyScalar(dt);

    this.wasGrounded = this.grounded;
    const justJumped = this.velocity.y > 0.6;

    if (!phys?.capsuleMove) {
      // Physics not up yet: integrate against an implicit ground plane so the
      // player never falls out of the world while another module boots.
      p.position.add(this._delta);
      if (p.position.y <= 0) { p.position.y = 0; this.grounded = true; }
      else this.grounded = false;
      this.groundNormal.set(0, 1, 0);
      this.hitWall = false;
    } else {
      const o = this._moveOpts;
      o.wasGrounded = this.wasGrounded;
      o.stepUp = !this.slide.active;
      o.snapToGround = !justJumped;
      o.slopeLimit = TUNE.slopeLimit;
      o.stepHeight = this.slide.active ? 0.20 : TUNE.stepHeight;

      let res = null;
      try {
        res = phys.capsuleMove(p.position, this._delta, p.radius, stance.height, o);
      } catch (err) {
        if (!this._loggedMoveError) {
          this._loggedMoveError = true;
          console.warn('[Player] capsuleMove failed; falling back to free movement', err);
        }
      }

      if (res && res.position) {
        p.position.copy(res.position);
        this.grounded = !!res.grounded;
        this.hitWall = !!res.hitWall;
        if (res.normal) this.groundNormal.copy(this.grounded ? res.normal : UP);
        // Keep the last *real* wall normal, and only a real one:
        //  - a capsule resting on the skin distance produces contacts on only
        //    every second or third step, so blindly copying the zero vector on
        //    the quiet steps throws away what the anti-buzz clip needs;
        //  - the controller also flags near-vertical normals (the underside of
        //    a box flush with the floor, a step edge) as "wall". Clipping
        //    against those does nothing for lateral buzz and would fight
        //    gravity, so only steep-enough faces are remembered.
        const wn = res.wallNormal;
        if (wn && Math.abs(wn.y) < 0.5 && (wn.x * wn.x + wn.z * wn.z) > 1e-6) {
          this.wallNormal.set(wn.x, 0, wn.z).normalize();
          this._stickyWallT = 0.15;
        } else if (!this.hitWall && this._stickyWallT <= 0) {
          this.wallNormal.set(0, 0, 0);
        }
        this.groundSlope = res.slope ?? 0;
        if (res.groundSurface) this.groundSurface = res.groundSurface;
      } else {
        p.position.add(this._delta);
        this.grounded = false;
        this.hitWall = false;
      }
    }

    // Clip velocity into the wall plane. This is what removes the buzz when
    // running along geometry: without it we keep re-driving into the surface.
    if (this._stickyWallT > 0 && this.wallNormal.lengthSq() > 1e-6) {
      const n = this.wallNormal;
      const into = this.velocity.x * n.x + this.velocity.z * n.z;
      if (into < 0) {
        this.velocity.x -= n.x * into;
        this.velocity.z -= n.z * into;
      }
    }

    // Ground contact bookkeeping.
    if (this.grounded) {
      if (!this.wasGrounded) this._onLand();
      if (this.velocity.y < 0) {
        // Keep a token downward bias so we stay glued to ramps.
        this.velocity.y = -0.6;
      }
      // Steep-but-walkable slopes: shed the component that drives into the hill.
      if (this.groundNormal.y < 0.999) {
        const n = this.groundNormal;
        const into = this.velocity.x * n.x + this.velocity.y * n.y + this.velocity.z * n.z;
        if (into < 0) {
          this.velocity.x -= n.x * into;
          this.velocity.y -= n.y * into;
          this.velocity.z -= n.z * into;
        }
      }
      this.coyote = TUNE.coyoteTime;
      this.airTime = 0;
      this.fallSpeed = 0;
    } else {
      this.coyote = Math.max(0, this.coyote - dt);
      this.airTime += dt;
      const fall = -this.velocity.y;
      if (fall > this.fallSpeed) this.fallSpeed = fall;
      if (this.airTime > 0.12 && this.player.stanceCtrl.name === 'slide') {
        // fell off the end of a slide
        if (this.slide.active) this._endSlide('air', { crouchHeld: false, jumpPressed: false });
      }
    }

    // Step-up smoothing: the controller can raise the capsule up to a stair
    // riser in one step, which strobes the view unless the camera lags it out.
    // A step-up can land on a frame where `wasGrounded` briefly flickered, so
    // gate on "not deliberately going up" (i.e. not a jump) rather than on the
    // previous ground state.
    const dy = p.position.y - this._prevPos.y;
    if (this.grounded && dy > 0.010 && dy < TUNE.stepSmoothMax
        && this.velocity.y <= 0.2 && !this.mantle.active) {
      p.rig?.addStepOffset?.(dy);
    }

    const dx = p.position.x - this._prevPos.x;
    const dz = p.position.z - this._prevPos.z;
    const moved = Math.hypot(dx, dz);
    this.distanceTravelled += moved;
    this._lastMoved = moved;

    this.horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.speed = this.velocity.length();
  }

  _onLand() {
    const p = this.player;
    const raw = this.fallSpeed;
    const impact = clamp01((raw - 2.0) / 14.0);
    this.lastLandImpact = impact;

    p.rig?.landImpulse?.(impact, this.velocity, raw);

    bus.emit('player:land', {
      impact,
      speed: raw,
      surface: this.groundSurface,
      position: p.position.clone(),
      hard: raw > 9,
    });

    if (impact > 0.35) {
      bus.emit('camera:shake', {
        amplitude: 0.16 + impact * 0.5,
        frequency: 24,
        duration: 0.18 + impact * 0.22,
        direction: { x: 0, y: -1, z: 0 },
      });
    }

    if (raw > TUNE.fallDamageSpeed) {
      const over = raw - TUNE.fallDamageSpeed;
      const dmg = raw >= TUNE.fallDeathSpeed ? 200 : Math.min(96, Math.pow(over, 1.55) * 4.4);
      p.vitals?.damage?.(dmg, null, { type: 'fall' });
    }

    // A landing counts as a footfall for cadence purposes.
    if (raw > 1.2) this._emitFootstep(Math.min(1, 0.55 + impact), true);
    this.gaitPhase = 0;
  }

  /* ================================================================== */
  /* mantle / vault                                                      */
  /* ================================================================== */

  /**
   * Probe for a ledge in front of the player and, if one fits, start the
   * animated climb. Returns true when a mantle was started.
   *
   * Three probes: a forward wall hit to find the face, a downward ray past that
   * face to find the top, and two clearance spheres to prove the body fits up
   * there. Anything less and you get the classic "mantled into a wall" bug.
   */
  _tryMantle(io, autoVaultOnly = false) {
    const p = this.player;
    const phys = this.game?.physics;
    if (!phys?.raycast || this.mantle.active) return false;
    if (p.stanceCtrl.name === 'prone' || p.stanceCtrl.name === 'dead') return false;
    if (this.velocity.y > 4.2) return false;
    if (this.airTime > 0.85 && !this.grounded) return false;

    const fwd = this._v.copy(this.forward);
    // Bias the reach direction toward the movement input so you can mantle a
    // ledge you are strafing along without snapping the camera to it.
    if (io && io.wishMag > 0.3 && this.wishDir.lengthSq() > 1e-6) {
      fwd.lerp(this.wishDir, 0.45);
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-6) fwd.copy(this.forward); else fwd.normalize();
    }

    const feet = p.position.y;
    const origin = this._v2;
    let wall = null;

    for (const h of [0.42, 0.85, 1.28, 1.62]) {
      if (h > TUNE.mantleMaxRise + 0.1) break;
      origin.set(p.position.x, feet + h, p.position.z);
      const hit = phys.raycast(origin, fwd, TUNE.mantleReach);
      if (!hit) continue;
      if (Math.abs(hit.normal.y) > 0.55) continue;         // that is a floor/ceiling
      if (hit.normal.dot(fwd) > -0.30) continue;           // facing away from us
      wall = hit;
      break;
    }
    if (!wall) return false;

    // Look for the top surface a little past the face.
    const px = wall.point.x + fwd.x * 0.34;
    const pz = wall.point.z + fwd.z * 0.34;
    const probeTop = feet + TUNE.mantleMaxRise + 0.45;
    origin.set(px, probeTop, pz);
    const down = this._downV;
    const top = phys.raycast(origin, down, TUNE.mantleMaxRise + 0.75);
    if (!top) return false;
    if (top.normal.y < 0.60) return false;                 // not standable

    const rise = top.point.y - feet;
    if (rise < TUNE.mantleMinRise || rise > TUNE.mantleMaxRise) return false;

    // Is there a body-sized volume up there?
    const landX = px + fwd.x * 0.22;
    const landZ = pz + fwd.z * 0.22;
    const landY = top.point.y + 0.02;
    if (!this._clearAt(landX, landY, landZ, STANCE_DEFS.crouch.capsule)) return false;

    // Thin obstacle with a drop on the far side => vault straight over it.
    let kind = 'mantle';
    let exitSpeed = 0;
    if (rise <= 1.18) {
      origin.set(landX + fwd.x * 0.75, landY + 0.35, landZ + fwd.z * 0.75);
      const beyond = phys.raycast(origin, down, 2.4);
      const drop = beyond ? (landY - beyond.point.y) : 2.4;
      const carried = Math.max(this.horizontalSpeed, this.approachSpeed);
      if (drop > 0.45 && carried > 2.6) {
        kind = 'vault';
        exitSpeed = Math.max(3.4, Math.min(carried * 1.02, TUNE.sprintSpeed));
      }
    }
    if (autoVaultOnly && kind !== 'vault') return false;

    const m = this.mantle;
    m.active = true;
    m.t = 0;
    m.kind = kind;
    m.rise = rise;
    m.progress = 0;
    m.start.copy(p.position);
    m.dir.set(fwd.x, 0, fwd.z).normalize();
    m.exitSpeed = exitSpeed;

    if (kind === 'vault') {
      m.end.set(landX + fwd.x * 0.62, landY, landZ + fwd.z * 0.62);
      m.duration = 0.36 + rise * 0.10;
      m.arc = 0.10;
    } else {
      m.end.set(landX + fwd.x * 0.16, landY, landZ + fwd.z * 0.16);
      // Tall ledges take visibly longer: the climb has to look like effort.
      m.duration = 0.34 + smoothstep(0.3, 1.7, rise) * 0.44;
      m.arc = 0.06 + rise * 0.05;
    }

    this.velocity.set(0, 0, 0);
    this.grounded = false;
    this.slide.active = false;
    p.stanceCtrl.set(kind, true);
    p.rig?.mantleStart?.(kind, rise, m.duration);
    bus.emit('camera:shake', { amplitude: 0.10, frequency: 15, duration: 0.16 });
    return true;
  }

  /** Two clearance spheres proving a crouched body fits at (x,y,z). */
  _clearAt(x, y, z, height) {
    const phys = this.game?.physics;
    if (!phys?.overlapSphere) return true;
    const r = this.player.radius * 0.86;
    const probe = this._v4;
    probe.set(x, y + r + 0.03, z);
    if (phys.overlapSphere(probe, r).length) return false;
    probe.set(x, y + Math.max(height - r, r + 0.1), z);
    if (phys.overlapSphere(probe, r).length) return false;
    return true;
  }

  _stepMantle(dt) {
    const m = this.mantle;
    const p = this.player;
    m.t += dt;
    const t = clamp01(m.t / m.duration);
    m.progress = t;

    // Up first, then across. The vertical curve finishes at ~70% of the
    // horizontal one, which reads as pulling yourself over the lip.
    const vy = easeOutCubic(clamp01(t * 1.42));
    const hz = smoothstep(m.kind === 'vault' ? 0.10 : 0.26, 1.0, t);

    p.position.x = m.start.x + (m.end.x - m.start.x) * hz;
    p.position.z = m.start.z + (m.end.z - m.start.z) * hz;
    p.position.y = m.start.y + (m.end.y - m.start.y) * vy + Math.sin(t * Math.PI) * m.arc;

    if (t >= 1) {
      m.active = false;
      p.position.copy(m.end);
      if (m.kind === 'vault') {
        this.velocity.set(m.dir.x * m.exitSpeed, -0.8, m.dir.z * m.exitSpeed);
        this.grounded = false;
        this.airTime = 0;
        this.fallSpeed = 0;
      } else {
        this.velocity.set(m.dir.x * 1.35, 0, m.dir.z * 1.35);
        this.grounded = true;
        this.coyote = TUNE.coyoteTime;
      }
      const stance = p.stanceCtrl;
      if (!stance.set('stand')) stance.set('crouch', true);
      p.rig?.mantleEnd?.(m.kind);
      this.jumpCooldownT = 0.12;
      this.player.vitals?.spendStamina?.(m.kind === 'vault' ? 9 : 15);
    }
  }

  /* ================================================================== */
  /* lean                                                                */
  /* ================================================================== */

  _updateLean(dt) {
    const p = this.player;
    const io = { l: false, r: false };
    const input = this.game?.input;
    if (input && this.game?.state === 'playing' && !p.scripted) {
      io.l = input.action('leanLeft');
      io.r = input.action('leanRight');
    }

    let target = (io.r ? 1 : 0) - (io.l ? 1 : 0);
    if (this.sprinting || this.slide.active || this.mantle.active
        || p.stanceCtrl.name === 'prone' || p.stanceCtrl.name === 'dead') target = 0;

    // Capsule-aware: sweep a sphere sideways from the eye and stop the lean at
    // whatever it finds, so you cannot peek your head through a wall.
    const maxOffset = 0.42;
    let allowed = maxOffset;
    if (target !== 0) {
      const phys = this.game?.physics;
      if (phys?.sphereCast) {
        const dir = this._v.copy(this.right).multiplyScalar(Math.sign(target));
        const eye = this._v2.set(
          p.position.x, p.position.y + p.stanceCtrl.eyeHeight - 0.06, p.position.z,
        );
        const hit = phys.sphereCast(eye, dir, 0.15, maxOffset + 0.26);
        if (hit) allowed = Math.max(0, hit.distance - 0.12);
      }
    }
    this.leanAllowed = allowed;

    // The requested lean eases in; the collision clamp bites immediately so
    // brushing a wall stops the head without a rubber-band.
    this.leanTarget = damp(this.leanTarget, target, 9.5, dt);
    const clamped = Math.max(-allowed, Math.min(allowed, this.leanTarget * maxOffset));
    this.leanOffset = damp(this.leanOffset, clamped, 16, dt);
    this.lean = this.leanOffset / maxOffset;
    p.lean = this.lean;
    p.leanOffset = this.leanOffset;
  }

  /* ================================================================== */
  /* gait + footsteps                                                    */
  /* ================================================================== */

  _updateGait(dt) {
    const p = this.player;
    const stance = p.stanceCtrl;
    const hs = this.horizontalSpeed;

    // Stride grows with speed but sub-linearly: you take longer *and* faster
    // steps as you speed up, which is what a real gait does.
    let stride = 1.16 + hs * 0.135;
    if (stance.name === 'crouch') stride *= 0.74;
    else if (stance.name === 'prone') stride *= 0.5;
    if (p.ads) stride *= 0.92;
    this.strideLength = stride;

    const moving = this.grounded && hs > 0.55
      && !this.slide.active && !this.mantle.active && this._lastMoved > 1e-4;

    if (!moving) {
      // Ease the phase to the nearest foot-down rather than freezing mid-swing.
      const nearest = this.gaitPhase < 0.25 ? 0 : this.gaitPhase < 0.75 ? 0.5 : 1;
      this.gaitPhase = damp(this.gaitPhase, nearest, 7, dt);
      if (this.gaitPhase >= 0.9999) this.gaitPhase = 0;
      return;
    }

    const prev = this.gaitPhase;
    const advance = (this._lastMoved) / (stride * 2); // one cycle = two steps
    let next = prev + advance;
    while (next >= 1) next -= 1;
    this.gaitPhase = next;

    if (crossed(prev, next, 0)) { this.foot = 0; this._emitFootstep(1, false); }
    if (crossed(prev, next, 0.5)) { this.foot = 1; this._emitFootstep(1, false); }
  }

  _emitFootstep(strength, isLanding) {
    const p = this.player;
    const stance = p.stanceCtrl;

    let surface = this.groundSurface;
    if (!surface) {
      const phys = this.game?.physics;
      surface = phys?.groundSurfaceAt?.(p.position) || 'concrete';
    }

    const running = this.sprinting || this.horizontalSpeed > 4.6;
    let volume = strength * (running ? 1.0 : 0.72);
    if (stance.name === 'crouch') volume *= 0.42;
    else if (stance.name === 'prone') volume *= 0.26;
    if (p.ads) volume *= 0.8;

    this.stepsTaken++;
    p.rig?.footPlant?.(volume, this.foot);

    bus.emit('player:footstep', {
      surface,
      running,
      position: p.position.clone(),
      foot: this.foot === 0 ? 'left' : 'right',
      volume,
      speed: this.horizontalSpeed,
      stance: stance.canonical,
      landing: !!isLanding,
    });
  }

  /* ================================================================== */

  _publish() {
    const p = this.player;
    p.grounded = this.grounded;
    p.speed = this.horizontalSpeed;
    const ref = this.tactical ? TUNE.tacticalSpeed : TUNE.sprintSpeed;
    this.speedRatio = clamp01(this.horizontalSpeed / ref);
    p.speedRatio = this.speedRatio;
    p.sliding = this.slide.active;
    p.mantling = this.mantle.active;
    p.groundSurface = this.groundSurface;
    p.airTime = this.airTime;
  }

  /** External impulse (explosions, launchers). */
  addImpulse(v) {
    if (this.mantle.active) {
      this.mantle.active = false;
      this.player.stanceCtrl.set('stand', true);
    }
    this.velocity.add(v);
    if (v.y > 0.5) { this.grounded = false; this.coyote = 0; }
  }

  reset(position, yaw) {
    this.velocity.set(0, 0, 0);
    this.grounded = false;
    this.wasGrounded = false;
    this.coyote = 0;
    this.jumpBufferT = 0;
    this.airTime = 0;
    this.fallSpeed = 0;
    this.slide.active = false;
    this.slide.cooldown = 0;
    this.mantle.active = false;
    this._stickyWallT = 0;
    this.hitWall = false;
    this.wallNormal.set(0, 0, 0);
    this.approachSpeed = 0;
    this.sprinting = false;
    this.tactical = false;
    this.lean = 0; this.leanTarget = 0; this.leanOffset = 0;
    this.gaitPhase = 0;
    this.horizontalSpeed = 0;
    this.speed = 0;
    if (position) this.player.position.copy(position);
    if (yaw !== undefined) this.player.yaw = yaw;
    // The destination may be a crawlspace; make the stance re-measure at once.
    if (this.player.stanceCtrl) this.player.stanceCtrl._crushT = 0;
    this._updateBasis();
  }
}

export { TUNE as MOVEMENT_TUNING };
