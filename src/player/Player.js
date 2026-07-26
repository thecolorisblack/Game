import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { Stance } from './Stance.js';
import { Movement } from './Movement.js';
import { CameraRig } from './CameraRig.js';
import { Vitals } from './Vitals.js';

/**
 * OPERATION BLACKOUT — the operator.
 *
 * This class is deliberately thin: it owns the authoritative transform and the
 * public surface other modules code against, and delegates the actual work to
 * four collaborators.
 *
 *   Stance      posture state machine, capsule + eye height blending
 *   Movement    120 Hz locomotion, slide/mantle/vault/lean, footstep cadence
 *   Vitals      health, regeneration, stamina, death
 *   CameraRig   sway, bob, recoil, shake, breathing, FOV — everything visual
 *
 * Tick split:
 *   fixedUpdate  simulation, always 1/120, only while state === 'playing'
 *   update       look input (render rate, so the mouse is never quantised)
 *   lateUpdate   camera composition, after every other system has moved
 *
 * `scripted` hands the camera transform to the capture harness: input reading
 * and camera writes stop, everything else keeps running so the viewmodel, HUD
 * and audio still see a live player.
 */
export class Player {
  constructor(game) {
    this.game = game;

    // --- authoritative transform (position is the capsule's FEET) --------
    this.position = new THREE.Vector3(0, 0, 0);
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.radius = 0.34;
    this.eyeHeight = 1.63;

    // --- published state --------------------------------------------------
    this.scripted = false;
    this.grounded = false;
    this.speed = 0;
    this.speedRatio = 0;
    this.ads = false;
    this.sprinting = false;
    this.tacticalSprint = false;
    this.sliding = false;
    this.mantling = false;
    this.lean = 0;
    this.leanOffset = 0;
    this.airTime = 0;
    this.groundSurface = 'concrete';
    this.spawnPoint = { position: new THREE.Vector3(), yaw: 0 };

    // --- scratch shared with the collaborators ---------------------------
    this._up = new THREE.Vector3(0, 1, 0);
    this._down = new THREE.Vector3(0, -1, 0);
    this._scratchA = new THREE.Vector3();

    this.stanceCtrl = new Stance(this);
    this.vitals = new Vitals(this);
    this.movement = new Movement(this);
    this.rig = new CameraRig(this);

    this._onState = (e) => {
      if (!e) return;
      if (e.next === 'playing' && e.prev === 'dead') this.respawn();
    };
  }

  /* ================================================================== */
  /* lifecycle                                                           */
  /* ================================================================== */

  async init() {
    const input = this.game?.input;
    if (input?.bindings) {
      // Additive only — never remove another module's binding. `next` is also
      // bound to KeyQ by the weapon switcher; both fire, which is intended.
      const b = input.bindings;
      if (!b.leanLeft) b.leanLeft = ['KeyQ'];
      if (!b.leanRight) b.leanRight = ['KeyE'];
      if (!b.prone) b.prone = ['KeyZ'];
    }

    const spawn = this._findSpawn();
    this.spawnPoint.position.copy(spawn.position);
    this.spawnPoint.yaw = spawn.yaw;

    this.position.copy(spawn.position);
    this.yaw = spawn.yaw;
    this.pitch = 0;
    this.stanceCtrl.snap('stand');
    this.eyeHeight = this.stanceCtrl.eyeHeight;

    this.vitals.init();
    this.rig.init();

    bus.on('state', this._onState);

    // Put the camera somewhere sane before the first rendered frame so the
    // boot screenshot is never a black void.
    this.rig.lateUpdate(0);
    return this;
  }

  dispose() {
    bus.off('state', this._onState);
    this.vitals.dispose();
    this.rig.dispose();
  }

  /* ================================================================== */
  /* tick                                                                */
  /* ================================================================== */

  fixedUpdate(dt) {
    try {
      this.movement.fixedUpdate(dt);
    } catch (err) {
      if (!this._loggedFixed) {
        this._loggedFixed = true;
        console.error('[Player] fixedUpdate failed', err);
      }
    }
  }

  update(dt) {
    try {
      this._resolveAds();
      this.rig.update(dt);
      this.vitals.update(dt);
    } catch (err) {
      if (!this._loggedUpdate) {
        this._loggedUpdate = true;
        console.error('[Player] update failed', err);
      }
    }
  }

  lateUpdate(dt) {
    try {
      this.rig.lateUpdate(dt);
    } catch (err) {
      if (!this._loggedLate) {
        this._loggedLate = true;
        console.error('[Player] lateUpdate failed', err);
      }
    }
  }

  _resolveAds() {
    const w = this.game?.weapons;
    let ads = w?.isADS;
    if (ads === undefined) ads = w?.isAds;
    if (ads === undefined) ads = w?.ads;
    if (ads === undefined) {
      const input = this.game?.input;
      ads = !!(input?.ads && this.game?.state === 'playing');
    }
    if (!this.vitals.alive || this.mantling || this.sliding) ads = false;
    this.ads = !!ads;
  }

  /* ================================================================== */
  /* public API — other modules code against everything below            */
  /* ================================================================== */

  /** Canonical stance id: 'stand' | 'crouch' | 'slide' | 'air'. */
  get stance() { return this.stanceCtrl.canonical; }

  /** Detailed posture: stand/crouch/prone/slide/mantle/vault/dead. */
  get posture() { return this.stanceCtrl.name; }

  get stanceBlend() { return this.stanceCtrl.blend; }
  get capsuleHeight() { return this.stanceCtrl.height; }

  get health() { return this.vitals.health; }
  set health(v) { this.vitals.health = Math.max(0, Math.min(this.vitals.maxHealth, v)); }
  get maxHealth() { return this.vitals.maxHealth; }
  get stamina() { return this.vitals.stamina; }
  get maxStamina() { return this.vitals.maxStamina; }
  get alive() { return this.vitals.alive; }
  get windedness() { return this.vitals.windedness; }
  get criticality() { return this.vitals.criticality; }

  get camera() { return this.game?.camera ?? null; }
  get isMoving() { return this.speed > 0.35; }
  get fov() { return this.rig.fov; }

  /** Eye position in world space (the camera's base, before rig offsets). */
  getEyePosition(out = new THREE.Vector3()) {
    return out.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  /** Where shots originate: the actual composed camera position. */
  getAimOrigin(out = new THREE.Vector3()) {
    const cam = this.game?.camera;
    if (cam) return out.copy(cam.position);
    return this.getEyePosition(out);
  }

  /** Where the crosshair points, including aim recoil. */
  getAimDirection(out = new THREE.Vector3()) { return this.rig.getAimDirection(out); }

  /** Aim excluding bob/sway/shake, for AI checks that must not jitter. */
  getStableAimDirection(out = new THREE.Vector3()) { return this.rig.getStableAimDirection(out); }

  /**
   * Weapon recoil hook.
   * @param {{pitch?:number, yaw?:number, roll?:number, kick?:number,
   *          units?:'rad'|'deg', aim?:number, visual?:number}} o
   */
  addRecoil(o) { this.rig.addRecoil(o); }

  /** Additive trauma shake; also reachable through the `camera:shake` event. */
  addShake(amplitude, frequency, duration, direction) {
    this.rig.addShake(amplitude, frequency, duration, direction);
  }

  /** Velocity impulse — explosions, launch pads, scripted pushes. */
  addImpulse(v) { this.movement.addImpulse(v); }

  /** @see Vitals#damage */
  damage(amount, from, meta) { return this.vitals.damage(amount, from, meta); }
  applyDamage(a, f, m) { return this.vitals.damage(a, f, m); }
  takeDamage(a, f, m) { return this.vitals.damage(a, f, m); }
  heal(a) { return this.vitals.heal(a); }

  teleport(position, yaw) {
    if (position) this.position.copy(position);
    if (yaw !== undefined) this.yaw = yaw;
    this.velocity.set(0, 0, 0);
    this.movement.reset(position, yaw);
    this.rig.reset();
  }

  setSpawn(position, yaw = 0) {
    this.spawnPoint.position.copy(position);
    this.spawnPoint.yaw = yaw;
  }

  respawn() {
    if (this._respawning) return this;
    this._respawning = true;
    const spawn = this._findSpawn();
    this.vitals.reset();
    this.stanceCtrl.snap('stand');
    this.movement.reset(spawn.position, spawn.yaw);
    this.pitch = 0;
    this.eyeHeight = this.stanceCtrl.eyeHeight;
    this.rig.reset();
    this.ads = false;
    if (this.game?.state === 'dead') this.game.setState('playing');
    bus.emit('player:spawn', { position: spawn.position.clone(), yaw: spawn.yaw });
    this._respawning = false;
    return this;
  }

  /** Everything a HUD or debug overlay might want, in one allocation-free-ish call. */
  getState(out = {}) {
    const mv = this.movement;
    out.position = this.position;
    out.velocity = this.velocity;
    out.speed = this.speed;
    out.speedRatio = this.speedRatio;
    out.health = this.vitals.health;
    out.maxHealth = this.vitals.maxHealth;
    out.stamina = this.vitals.stamina;
    out.maxStamina = this.vitals.maxStamina;
    out.alive = this.vitals.alive;
    out.regenerating = this.vitals.regenActive;
    out.criticality = this.vitals.criticality;
    out.windedness = this.vitals.windedness;
    out.stance = this.stanceCtrl.canonical;
    out.posture = this.stanceCtrl.name;
    out.grounded = mv.grounded;
    out.sprinting = mv.sprinting;
    out.tactical = mv.tactical;
    out.sliding = mv.slide.active;
    out.mantling = mv.mantle.active;
    out.lean = mv.lean;
    out.ads = this.ads;
    out.fov = this.rig.fov;
    out.surface = this.groundSurface;
    out.steps = mv.stepsTaken;
    out.distance = mv.distanceTravelled;
    return out;
  }

  /* ================================================================== */

  _findSpawn() {
    const out = { position: new THREE.Vector3(-3, 0, 52), yaw: 0 };
    const points = this.game?.world?.getSpawnPoints?.('player');
    const s = Array.isArray(points) && points.length ? points[0] : null;
    if (s) {
      if (Array.isArray(s.position)) out.position.fromArray(s.position);
      else if (s.position) out.position.copy(s.position);
      if (Number.isFinite(s.yaw)) out.yaw = s.yaw;
    } else if (this.spawnPoint.position.lengthSq() > 0) {
      out.position.copy(this.spawnPoint.position);
      out.yaw = this.spawnPoint.yaw;
    }

    const h = this.game?.world?.heightAt?.(out.position.x, out.position.z);
    if (Number.isFinite(h)) out.position.y = Math.max(out.position.y, h + 0.05);

    // Settle onto whatever the physics world actually says is there.
    const phys = this.game?.physics;
    if (phys?.raycast) {
      const origin = this._scratchA.set(out.position.x, out.position.y + 3.5, out.position.z);
      try {
        const hit = phys.raycast(origin, this._down, 14);
        if (hit) out.position.y = hit.point.y + 0.02;
      } catch { /* world not built yet */ }
    }
    return out;
  }
}

export default Player;
