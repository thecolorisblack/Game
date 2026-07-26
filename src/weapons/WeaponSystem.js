import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { Weapon } from './Weapon.js';
import { WEAPONS } from './Loadout.js';
import { ViewModel } from './ViewModel.js';
import { Ballistics } from './Ballistics.js';
import { ShellSystem, TracerFallback } from './Effects.js';
import { buildPalette } from './models/Palette.js';
import { Ease, clamp01 } from './Anim.js';

/**
 * OPERATION BLACKOUT — weapons.
 *
 * Owns four procedurally modelled firearms, the first-person viewmodel rig that
 * animates them, the hitscan solver that resolves what they hit, and the brass,
 * flash and smoke they throw off doing it.
 *
 * Contract surface (fixed by ARCHITECTURE.md):
 *   init() / fixedUpdate(dt) / update(dt, time) / lateUpdate(dt)
 *   debugPose(name) / debugFire(n) / adsFov
 * Events emitted: weapon:fire, weapon:dryfire, weapon:reload, weapon:switch,
 *   weapon:ammo, bullet:impact, bullet:whizby, damage:dealt, hitmarker,
 *   camera:shake.
 *
 * Everything reached for outside this module (player, physics, vfx, ai, audio)
 * is optional-chained: a placeholder dependency degrades the shot, it never
 * throws inside the frame loop.
 */

const HORIZONTAL_REF_ASPECT = 16 / 9;

/** Macrotask yield — cheaper than rAF under a software rasteriser. */
function yieldFrame() {
  if (typeof MessageChannel === 'function') {
    return new Promise((resolve) => {
      const mc = new MessageChannel();
      mc.port1.onmessage = () => { mc.port1.close(); resolve(); };
      mc.port2.postMessage(0);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export class WeaponSystem {
  constructor(game) {
    this.game = game;

    this.weapons = [];
    this.index = 0;
    this.weapon = null;
    this.pending = null;

    /** Current world-camera horizontal FOV in degrees (contract field). */
    this.adsFov = game.settings?.fov ?? 90;
    this.adsAmount = 0;
    this.isADS = false;

    this.state = 'idle';           // idle | reloading | switching | melee | inspecting | cycling
    this.now = 0;
    this.enabled = true;

    this._adsTarget = 0;
    this._adsForced = -1;          // debug override, -1 = off
    this._baseHFov = this.adsFov;
    this._lastAppliedHFov = -1;
    this._fovApplied = false;
    this._debugFrame = -1000;
    this._hold = false;

    this._prevYaw = 0;
    this._prevPitch = 0;
    this._look = { yaw: 0, pitch: 0 };

    this._recoilApplied = { pitch: 0, yaw: 0 };
    this._fallbackRecoil = false;

    this._shotsSinceTracer = 0;
    this._magDrops = [];
    this._magDropIndex = 0;

    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._muzzleWorld = new THREE.Vector3();
    this._apparent = new THREE.Vector3();

    this._unsub = [];
  }

  /* ================================================================ */
  /* boot                                                              */
  /* ================================================================ */

  async init() {
    const game = this.game;
    this.palette = buildPalette(game);

    this.viewmodel = new ViewModel(game, this.palette);
    this.viewmodel.init();
    this.viewmodel.onClipEvent = (name, data, clip) => this._onClipEvent(name, data, clip);
    this.viewmodel.onClipEnd = (name) => this._onClipEnd(name);

    this.ballistics = new Ballistics(game);
    this.shells = new ShellSystem(game, this.palette);
    this.tracers = new TracerFallback(game.scene, 28);
    this.ballistics.onTracer = (a, b, cfg) => this.tracers.spawn(a, b, cfg);

    for (const def of WEAPONS) {
      const w = new Weapon(game, def, this.palette);
      try {
        w.build();
      } catch (err) {
        console.error(`[Weapons] failed to build "${def.id}"`, err);
        continue;
      }
      this.weapons.push(w);
      // Yield between weapons so the boot bar keeps painting; each one is a
      // few hundred extrudes and merges.
      await yieldFrame();
    }
    if (!this.weapons.length) {
      console.error('[Weapons] no weapons built');
      return this;
    }

    this.equip(0, { instant: true });

    this._unsub.push(bus.on('player:land', (e) => this.viewmodel.onLand(e?.impact ?? 1)));
    this._unsub.push(bus.on('state', ({ next }) => {
      if (next !== 'playing') this._releaseHold(false);
    }));

    // A single warm frame so the first real shot never compiles a shader.
    try {
      game.renderer.compile(game.engine.viewScene, game.engine.viewCamera);
    } catch (err) { /* software GL can refuse; harmless */ }

    this._emitAmmo();
    return this;
  }

  /* ================================================================ */
  /* loadout                                                           */
  /* ================================================================ */

  get current() { return this.weapon; }

  ammoState() { return this.weapon ? this.weapon.ammoState() : { mag: 0, reserve: 0, max: 0 }; }

  /** @param {number|string} which slot index or weapon id */
  equip(which, opts = {}) {
    if (this._hold) this._releaseHold(false);
    const target = typeof which === 'string'
      ? this.weapons.find((w) => w.id === which)
      : this.weapons[((which % this.weapons.length) + this.weapons.length) % this.weapons.length];
    if (!target || target === this.weapon) return false;
    if (opts.instant || !this.weapon) {
      this._finishSwitch(target, opts);
      return true;
    }
    if (this.state === 'switching') return false;
    this.pending = target;
    this.state = 'switching';
    this._cancelReloadVisuals();
    this.viewmodel.playClip('switchOut');
    return true;
  }

  _finishSwitch(target, opts = {}) {
    const from = this.weapon?.id ?? null;
    this.weapon = target;
    this.index = this.weapons.indexOf(target);
    this.viewmodel.setWeapon(target, opts);
    this.pending = null;
    bus.emit('weapon:switch', { from, to: target.id });
    this._emitAmmo();
  }

  nextWeapon() { this.equip((this.index + 1) % this.weapons.length); }
  prevWeapon() { this.equip((this.index - 1 + this.weapons.length) % this.weapons.length); }

  toggleFireMode() {
    if (!this.weapon) return null;
    const mode = this.weapon.cycleFireMode();
    bus.emit('weapon:firemode', { weapon: this.weapon.id, mode });
    return mode;
  }

  get busy() {
    return this.state === 'reloading' || this.state === 'switching'
      || this.state === 'melee' || this.state === 'cycling';
  }

  /* ================================================================ */
  /* actions                                                           */
  /* ================================================================ */

  startReload() {
    if (this._hold) this._releaseHold(false);
    const w = this.weapon;
    if (!w || this.busy || !w.canReload) return false;
    const empty = w.needsEmptyReload;
    this.state = 'reloading';
    this._reloadEmpty = empty;
    this.viewmodel.playClip(empty ? 'reloadEmpty' : 'reload');
    bus.emit('weapon:reload', { weapon: w.id, tactical: !empty });
    return true;
  }

  cancelReload() {
    if (this.state !== 'reloading') return;
    this.viewmodel.stopClip();
    this.viewmodel.leftPose = 'support';
    this.state = 'idle';
  }

  _cancelReloadVisuals() {
    this.viewmodel.stopClip();
    this.viewmodel.leftPose = 'support';
  }

  inspect() {
    if (this.busy || this.state === 'inspecting') return false;
    if (!this.viewmodel.playClip('inspect')) return false;
    this.state = 'inspecting';
    return true;
  }

  melee() {
    if (this._hold) this._releaseHold(false);
    if (this.busy) return false;
    if (!this.viewmodel.playClip('melee')) return false;
    this.state = 'melee';
    return true;
  }

  /* ================================================================ */
  /* firing                                                            */
  /* ================================================================ */

  _tryFire(pressed, held, ctx) {
    const w = this.weapon;
    if (!w) return;
    if (this.state === 'inspecting' && (pressed || held)) {
      this.viewmodel.stopClip();
      this.state = 'idle';
    }
    if (this.busy) return;
    if (!w.wantsToFire(this.now, pressed, held)) return;
    if (w.mag <= 0) {
      if (pressed) this._dryFire();
      return;
    }
    this.fireOnce(ctx);
  }

  _dryFire() {
    const w = this.weapon;
    if (!w) return;
    w.nextFireAt = this.now + 0.25;
    this.viewmodel.onDryFire();
    bus.emit('weapon:dryfire', { weapon: w.id });
    // dry-firing is the game telling you to reload; oblige if the player holds it
    if (w.canReload && (this.game.settings?.autoReload ?? true)) this.startReload();
  }

  /**
   * One round out of the barrel: ballistics, recoil, brass, flash, events.
   * @param {Object} ctx  the frame context from `_buildContext`
   * @param {Object} opts {capture:boolean} — capture mode stages the visuals
   *                      for a still frame instead of simulating them
   */
  fireOnce(ctx, opts = {}) {
    const w = this.weapon;
    if (!w) return false;
    if (!w.consume(this.now)) return false;

    const camera = this.game.camera;
    const ads = this.adsAmount;

    // --- direction ------------------------------------------------
    const origin = this._v.copy(camera.position);
    const dir = this._v2.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
    const spread = w.spread({
      adsAmount: ads, speed: ctx.speed, grounded: ctx.grounded, crouched: ctx.stance === 'crouch',
    });

    // --- tracer origin: where the muzzle *appears* to be on screen ---
    const tracerFrom = this._apparentMuzzlePosition(this._apparent);
    this._shotsSinceTracer++;
    const every = w.def.tracerEvery ?? 3;
    const wantTracer = every <= 1 || (this._shotsSinceTracer % every) === 0;

    // --- resolve ----------------------------------------------------
    this.ballistics.fire(w, origin, dir, {
      spread,
      isADS: ads > 0.5,
      tracerFrom: tracerFrom || origin,
      tracer: wantTracer,
      hostile: false,
    });

    // --- viewmodel + camera recoil ----------------------------------
    this.viewmodel.onFire(w, ads);
    const kick = w.recoilStep(ads);
    this._applyCameraRecoil(kick);

    // --- muzzle flash ------------------------------------------------
    this.viewmodel.socketWorld('muzzle', this._muzzleWorld, null);
    this.viewmodel.muzzle.flash(w.def.flashPower ?? 1, this._muzzleWorld);
    if (opts.capture) {
      this.viewmodel.flashHold = true;
      this.viewmodel.muzzle.held = true;
      this.viewmodel.muzzle.prime(0.20);
    }

    // --- brass --------------------------------------------------------
    if (!w.def.boltAction) this._ejectShell(opts.capture ? { manual: true, stagger: opts.stagger ?? 0 } : null);

    // --- shake + events ------------------------------------------------
    const sh = w.def.recoil.shake;
    if (sh) {
      bus.emit('camera:shake', {
        amplitude: sh.amplitude * (1 - ads * 0.45),
        frequency: sh.frequency,
        duration: sh.duration,
      });
    }
    bus.emit('weapon:fire', {
      weapon: w.id,
      origin: origin.clone(),
      dir: dir.clone(),
      spread,
      isADS: ads > 0.5,
    });
    this._emitAmmo();

    // --- manual actions ---------------------------------------------
    if (w.def.boltAction && !opts.capture) {
      this.state = 'cycling';
      this.viewmodel.playClip('boltCycle');
    }
    return true;
  }

  _applyCameraRecoil(kick) {
    const player = this.game.player;
    const pitch = THREE.MathUtils.degToRad(kick.pitch);
    const yaw = THREE.MathUtils.degToRad(kick.yaw);
    if (player && typeof player.addRecoil === 'function') {
      try {
        player.addRecoil(pitch, yaw);
        return;
      } catch (err) { /* fall through to the local integrator */ }
    }
    // Player module has not landed its recoil API yet: drive the look angles
    // directly and recover them ourselves so aiming still fights back.
    this._fallbackRecoil = true;
    this._recoilApplied.pitch += pitch;
    this._recoilApplied.yaw += yaw;
    if (player) {
      if (typeof player.pitch === 'number') player.pitch = THREE.MathUtils.clamp(player.pitch + pitch, -1.5, 1.5);
      if (typeof player.yaw === 'number') player.yaw += yaw;
    }
  }

  _recoverFallbackRecoil(dt) {
    if (!this._fallbackRecoil) return;
    const w = this.weapon;
    const rate = (w?.def.recoil.recovery ?? 8) * dt;
    const retain = w?.def.recoil.retain ?? 0.12;
    const player = this.game.player;
    const step = (key, sign) => {
      const applied = this._recoilApplied[key];
      if (Math.abs(applied) < 1e-5) return;
      const keep = applied * retain;
      const back = (applied - keep) * Math.min(1, rate);
      this._recoilApplied[key] -= back;
      if (player && typeof player[key] === 'number') player[key] -= back * sign;
    };
    step('pitch', 1);
    step('yaw', 1);
  }

  _ejectShell(captureOpts) {
    const w = this.weapon;
    if (!w?.model?.sockets?.eject) return;
    const pos = new THREE.Vector3();
    this.viewmodel.socketWorld('eject', pos, null);
    w.model.root.getWorldQuaternion(this._q);
    const vel = new THREE.Vector3().fromArray(w.def.ejectVelocity || [2.8, 1.6, -0.3]);
    vel.applyQuaternion(this._q);
    vel.x += (Math.random() - 0.5) * 0.6;
    vel.y += (Math.random() - 0.5) * 0.5;
    vel.z += (Math.random() - 0.5) * 0.6;
    const pv = this.game.player?.velocity;
    if (pv && !captureOpts) vel.add(pv);

    if (captureOpts) {
      // stage the case mid-flight so a frozen frame still shows brass in the air
      const t = 0.055 + (captureOpts.stagger ?? 0) * 0.075;
      pos.addScaledVector(vel, t);
      pos.y -= 0.5 * 9.8 * t * t;
      this.shells.eject(pos, vel, { scale: w.def.shellScale ?? 1, manual: true });
      return;
    }
    this.shells.eject(pos, vel, { scale: w.def.shellScale ?? 1 });
  }

  /**
   * The muzzle is drawn by a camera with a different FOV to the world, so its
   * geometric position is not where the player sees it. Project through the
   * viewmodel camera and unproject through the world camera to get the point
   * that lines up on screen — otherwise every tracer starts visibly off-barrel.
   */
  _apparentMuzzlePosition(out) {
    const w = this.weapon;
    if (!w?.model?.sockets?.muzzle) return null;
    const engine = this.game.engine;
    const vc = engine.viewCamera;
    const wc = engine.camera;
    const s = w.model.sockets.muzzle;
    s.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(s.matrixWorld);
    const dist = out.distanceTo(vc.position);
    vc.updateMatrixWorld();
    wc.updateMatrixWorld();
    out.project(vc);
    out.unproject(wc);
    out.sub(wc.position);
    if (out.lengthSq() < 1e-8) return null;
    out.normalize().multiplyScalar(Math.max(0.15, dist)).add(wc.position);
    return out;
  }

  /* ================================================================ */
  /* hostile fire (used by the AI module)                              */
  /* ================================================================ */

  /**
   * Resolve a shot fired *at* the player by someone else. Runs the same
   * ballistics path, so enemy rounds penetrate the same walls yours do and the
   * near-miss crack comes out of one place.
   */
  hostileFire(origin, dir, opts = {}) {
    const w = opts.weapon || this.weapons[0];
    if (!w) return null;
    const proxy = {
      damage: opts.damage ?? 18,
      falloff: opts.falloff ?? w.falloff,
      multipliers: opts.multipliers ?? w.multipliers,
      penetration: opts.penetration ?? w.penetration,
      range: opts.range ?? w.range,
      pellets: opts.pellets ?? 1,
      def: w.def,
      tracerColor: 0xff7a3a,
    };
    return this.ballistics.fire(proxy, origin, dir, {
      spread: opts.spread ?? 0.02,
      hostile: true,
      tracerFrom: opts.tracerFrom || origin,
      exclude: opts.shooter ?? null,
      ignore: opts.ignore ?? null,
    });
  }

  /* ================================================================ */
  /* clip callbacks                                                    */
  /* ================================================================ */

  _onClipEvent(name, data, clip) {
    const w = this.weapon;
    switch (name) {
      case 'magRelease':
        break;
      case 'magDrop':
        this._dropMagazine();
        break;
      case 'magNew':
        break;
      case 'magSeated':
        if (w) { w.refill(); this._emitAmmo(); }
        break;
      case 'chargePull':
        break;
      case 'boltRelease':
      case 'boltForward':
        if (w) w.chambered = true;
        this.viewmodel.recoilPos.impulse(0, 0, 0.45);
        break;
      case 'boltBack':
        if (w?.def.boltAction) this._ejectShell(this._hold ? { manual: true } : null);
        break;
      case 'meleeHit':
        this._meleeHit();
        break;
      default:
        break;
    }
  }

  _onClipEnd(name) {
    if (name === 'switchOut') {
      if (this.pending) this._finishSwitch(this.pending);
      this.viewmodel.playClip('switchIn');
      return;
    }
    if (name === 'switchIn') { this.state = 'idle'; return; }
    if (name === 'reload' || name === 'reloadEmpty') {
      // safety net: if the seat event was skipped by a frame spike, top up now
      if (this.weapon && this.weapon.mag < this.weapon.magSize && this.weapon.reserve > 0) {
        this.weapon.refill();
        this._emitAmmo();
      }
      this.state = 'idle';
      return;
    }
    if (name === 'boltCycle') { this.state = 'idle'; return; }
    if (name === 'melee' || name === 'inspect') { this.state = 'idle'; }
  }

  _meleeHit() {
    const camera = this.game.camera;
    const origin = this._v.copy(camera.position);
    const dir = this._v2.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const range = 2.1;
    const hit = this.ballistics._traceCharacters(origin, dir, range, {});
    if (hit) {
      const dmg = 135;
      this.ballistics._applyDamage(hit, dmg, false, dir, this.weapon);
      bus.emit('damage:dealt', { target: hit.enemy, amount: dmg, headshot: false, point: hit.point.clone() });
      bus.emit('hitmarker', { headshot: false, kill: (hit.enemy?.health ?? 1) <= 0 });
      bus.emit('camera:shake', { amplitude: 0.05, frequency: 20, duration: 0.16 });
      return;
    }
    const wall = this.game.physics?.raycast?.(origin, dir, range) ?? null;
    if (wall) {
      bus.emit('bullet:impact', {
        point: wall.point.clone(), normal: wall.normal.clone(),
        surface: wall.surface ?? 'concrete', object: wall.object ?? null, dir: dir.clone(),
      });
    }
  }

  /**
   * Hand the discarded magazine to the physics solver so it bounces off the
   * floor instead of vanishing the instant it leaves the magwell.
   */
  _dropMagazine() {
    const w = this.weapon;
    const magNode = w?.model?.parts?.magazine;
    if (!magNode) return;
    let drop = this._magDrops[this._magDropIndex];
    if (!drop || drop.userData.weapon !== w.id) {
      if (drop) drop.parent?.remove(drop);
      drop = new THREE.Group();
      drop.userData.weapon = w.id;
      for (const child of magNode.children) {
        if (!child.isMesh) continue;
        const m = new THREE.Mesh(child.geometry, child.material);
        m.castShadow = false;
        m.receiveShadow = false;
        m.frustumCulled = true;
        drop.add(m);
      }
      this._magDrops[this._magDropIndex] = drop;
      this.game.scene?.add(drop);
    }
    this._magDropIndex = (this._magDropIndex + 1) % 3;

    magNode.updateWorldMatrix(true, false);
    drop.position.setFromMatrixPosition(magNode.matrixWorld);
    drop.quaternion.setFromRotationMatrix(magNode.matrixWorld);
    drop.visible = true;

    const vel = new THREE.Vector3(0, -1.4, 0);
    w.model.root.getWorldQuaternion(this._q);
    vel.applyQuaternion(this._q);
    const pv = this.game.player?.velocity;
    if (pv) vel.add(pv);
    try {
      this.game.physics?.spawnDebris?.({
        object: drop,
        position: drop.position.clone(),
        quaternion: drop.quaternion.clone(),
        velocity: vel,
        angularVelocity: new THREE.Vector3(
          (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9,
        ),
        shape: 'box',
        size: { x: 0.032, y: 0.19, z: 0.028 },
        mass: 0.16,
        restitution: 0.22,
        friction: 0.6,
        lifetime: 16,
        surface: 'metal',
      });
    } catch (err) {
      drop.visible = false;
    }
  }

  /* ================================================================ */
  /* frame                                                             */
  /* ================================================================ */

  update(dt, time) {
    if (!this.weapon) return;
    const clamped = Math.min(0.06, Math.max(0, dt || 0));
    this.now += clamped;

    const ctx = this._buildContext(clamped);

    if (this.game.state === 'playing' && this.enabled) {
      // Any real input ends a capture freeze; the harness never sends one, so
      // a posed frame stays posed for as long as it is being photographed.
      if (this._hold && this._playerActive()) this._releaseHold(false);
      if (!this._hold) this._handleInput(ctx);
    }

    // ADS ramp: per-weapon time in and a faster time out, sprint locks it out
    this._updateADS(clamped, ctx);
    ctx.adsAmount = this.adsAmount;

    this.weapon.decay(clamped);
    this._recoverFallbackRecoil(clamped);

    try {
      this.viewmodel.update(clamped, ctx);
    } catch (err) {
      if (!this._vmError) {
        this._vmError = true;
        console.error('[Weapons] viewmodel update failed', err);
      }
    }

    this.shells.update(clamped);
    this.tracers.update(clamped, this.game.camera);

    if ((time?.frame ?? 0) % 45 === 0) this.viewmodel.syncEnvironment();
  }

  /**
   * Only *input* ends a capture freeze. Deliberately not camera motion or
   * velocity: `Capture.pose` teleports the camera and leaves the player's
   * velocity where it was, and either of those would unfreeze the frame the
   * harness is about to photograph.
   */
  _playerActive() {
    const input = this.game.input;
    if (!input) return false;
    if (input.fire || input.ads) return true;
    if (input.down?.size > 0) return true;
    if (input.buttons?.size > 0) return true;
    return false;
  }

  _buildContext(dt) {
    const player = this.game.player;
    const camera = this.game.camera;
    const input = this.game.input;

    // Look delta is measured off the camera rather than the raw mouse, because
    // the player controller drains the input queue before we run.
    const yaw = camera.rotation.y;
    const pitch = camera.rotation.x;
    let dy = yaw - this._prevYaw;
    if (dy > Math.PI) dy -= Math.PI * 2;
    else if (dy < -Math.PI) dy += Math.PI * 2;
    this._look.yaw = dy;
    this._look.pitch = pitch - this._prevPitch;
    this._prevYaw = yaw;
    this._prevPitch = pitch;

    const vel = player?.velocity;
    let speed = 0;
    if (vel) speed = Math.hypot(vel.x ?? 0, vel.z ?? 0);
    const moving = speed > 0.6 || (input?.moveAxes && Math.hypot(...Object.values(input.moveAxes())) > 0.2);
    const sprinting = player?.sprinting ?? (!!input?.action?.('sprint') && moving && speed > 3.0);

    return {
      dt,
      speed,
      maxSpeed: player?.runSpeed ?? 5.4,
      sprinting: !!sprinting,
      grounded: player?.grounded ?? true,
      stance: player?.stance ?? 'stand',
      look: this._look,
      adsAmount: this.adsAmount,
      triggerHeld: !!this.game.input?.fire && this.game.state === 'playing',
    };
  }

  _handleInput(ctx) {
    const input = this.game.input;
    if (!input) return;

    if (input.actionPressed('reload')) this.startReload();
    if (input.actionPressed('melee')) this.melee();
    if (input.actionPressed('next')) this.nextWeapon();
    if (input.keyPressed('KeyB')) this.toggleFireMode();
    if (input.keyPressed('KeyH')) this.inspect();
    for (let i = 0; i < Math.min(9, this.weapons.length); i++) {
      if (input.keyPressed(`Digit${i + 1}`)) this.equip(i);
    }
    if (input.mouse?.wheel) {
      if (input.mouse.wheel > 0) this.nextWeapon();
      else this.prevWeapon();
    }

    const pressed = !!input.firePressed;
    const held = !!input.fire;
    if (!held) this.weapon.releaseTrigger();
    this._tryFire(pressed, held, ctx);
  }

  _updateADS(dt, ctx) {
    const w = this.weapon;
    let want = 0;
    if (this._adsForced >= 0) {
      want = this._adsForced;
    } else if (this.game.state === 'playing' && this.enabled) {
      const held = !!this.game.input?.ads;
      const blocked = this.state === 'switching' || this.state === 'melee'
        || (ctx.sprinting && this.adsAmount < 0.02);
      want = held && !blocked ? 1 : 0;
      if (held && this.state === 'inspecting') { this.viewmodel.stopClip(); this.state = 'idle'; }
    }
    this._adsTarget = want;
    const inTime = w?.def.adsTime ?? 0.22;
    const outTime = Math.max(0.06, inTime * 0.78);
    const rate = dt / (want > this.adsAmount ? inTime : outTime);
    if (this._adsForced >= 0 && dt === 0) {
      this.adsAmount = want;
    } else {
      this.adsAmount = want > this.adsAmount
        ? Math.min(want, this.adsAmount + rate)
        : Math.max(want, this.adsAmount - rate);
    }
    this.isADS = this.adsAmount > 0.5;
  }

  lateUpdate(dt) {
    if (!this.weapon) return;
    const engine = this.game.engine;
    const camera = this.game.camera;

    this.viewmodel.anchor(camera, engine.viewCamera);
    this._updateFov();

    // A magnified optic needs a second view of the world. Guarded, low
    // resolution, and only while the shooter is actually behind the glass.
    if (this.game.settings?.preset !== 'low') {
      try {
        this.viewmodel.renderScope(this.game.renderer, this.game.scene);
      } catch (err) {
        if (!this._scopeError) {
          this._scopeError = true;
          console.warn('[Weapons] scope render failed; disabling', err);
        }
      }
    }
  }

  /**
   * ADS zoom. The base FOV is whatever the camera is already using, sampled
   * while the sights are down, so this never fights the settings menu or the
   * capture harness's per-shot framing.
   */
  _updateFov() {
    const engine = this.game.engine;
    const camera = this.game.camera;
    const settings = this.game.settings;
    const hfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) * camera.aspect);
    const observed = THREE.MathUtils.radToDeg(hfov);

    const w = this.weapon;
    const a = Ease.smooth(clamp01(this.adsAmount));

    if (this.adsAmount <= 0.0015) {
      if (this._fovApplied) {
        engine.setHorizontalFov(this._baseHFov);
        this._lastAppliedHFov = this._baseHFov;
        this._fovApplied = false;
      } else {
        this._baseHFov = observed;
      }
      this.adsFov = this._baseHFov;
    } else {
      // somebody else moved the FOV out from under us (menu, capture harness)
      if (this._fovApplied && Math.abs(observed - this._lastAppliedHFov) > 0.05
        && (this.game.time?.frame ?? 0) - this._debugFrame > 2) {
        this._baseHFov = observed;
      }
      const target = this._baseHFov * THREE.MathUtils.lerp(1, w?.def.adsZoom ?? 0.8, a);
      engine.setHorizontalFov(target);
      this._lastAppliedHFov = target;
      this._fovApplied = true;
      this.adsFov = target;
    }

    // viewmodel FOV: authored horizontally, converted for the vertical camera
    const vm = settings?.viewmodelFov ?? 60;
    const vmH = THREE.MathUtils.degToRad(vm * THREE.MathUtils.lerp(1, 0.86, a));
    const aspect = engine.viewCamera.aspect || HORIZONTAL_REF_ASPECT;
    const vmV = 2 * Math.atan(Math.tan(vmH * 0.5) / aspect);
    const deg = THREE.MathUtils.radToDeg(vmV);
    if (Math.abs(engine.viewCamera.fov - deg) > 0.01) {
      engine.viewCamera.fov = deg;
      engine.viewCamera.updateProjectionMatrix();
    }
  }

  _emitAmmo() {
    if (!this.weapon) return;
    const s = this.weapon.ammoState();
    bus.emit('weapon:ammo', s);
  }

  /* ================================================================ */
  /* capture hooks                                                     */
  /* ================================================================ */

  /**
   * Freeze the viewmodel in a named pose so a still frame is composable.
   * Called by `Capture.pose` for the weapon-hero and ADS shots.
   */
  debugPose(name = 'inspect') {
    this._debugFrame = this.game.time?.frame ?? 0;
    this._releaseHold(true);
    this._syncLookHistory();
    if (!this.weapon) return false;
    const ctx = this._buildContext(0);
    this._baseHFov = this._currentHFov();

    switch (name) {
      case 'ads':
      case 'aim': {
        this._adsForced = 1;
        this.adsAmount = 1;
        this.isADS = true;
        const p = this.weapon.def.poses.ads;
        this.viewmodel.posSpring.set(p.pos[0], p.pos[1], p.pos[2]);
        this.viewmodel.rotSpring.set(p.rot[0], p.rot[1], p.rot[2]);
        this.viewmodel.resetChannels();
        break;
      }
      case 'hip':
      case 'idle': {
        this._adsForced = 0;
        this.adsAmount = 0;
        const p = this.weapon.def.poses.hip;
        this.viewmodel.posSpring.set(p.pos[0], p.pos[1], p.pos[2]);
        this.viewmodel.rotSpring.set(p.rot[0], p.rot[1], p.rot[2]);
        this.viewmodel.resetChannels();
        break;
      }
      case 'sprint': {
        this._adsForced = 0;
        this.adsAmount = 0;
        const p = this.weapon.def.poses.sprint;
        this.viewmodel.posSpring.set(p.pos[0], p.pos[1], p.pos[2]);
        this.viewmodel.rotSpring.set(p.rot[0], p.rot[1], p.rot[2]);
        this.viewmodel.sprintAmount = 1;
        this.viewmodel.resetChannels();
        break;
      }
      case 'reload': {
        this._adsForced = 0;
        this.adsAmount = 0;
        this.state = 'reloading';
        this.viewmodel.scrubClip('reload', 0.52);
        break;
      }
      case 'inspect':
      default: {
        this._adsForced = 0;
        this.adsAmount = 0;
        this.state = 'inspecting';
        // 0.44 is the beat where the receiver is turned into the key light and
        // the ejection side, optic and magazine are all readable at once
        this.viewmodel.scrubClip('inspect', 0.44);
        break;
      }
    }

    // settle the rig so the frozen frame is the pose, not the transition
    this.viewmodel.hold = false;
    for (let i = 0; i < 6; i++) this.viewmodel.update(1 / 60, { ...ctx, adsAmount: this.adsAmount });
    this.viewmodel.anchor(this.game.camera, this.game.engine.viewCamera);
    this._updateFov();
    this.viewmodel.hold = true;
    this._hold = true;
    return true;
  }

  /**
   * Fire `n` rounds immediately and stage the result for a still frame: flash
   * held at peak, brass in the air, smoke mid-life, weapon at the top of its
   * recoil arc.
   */
  debugFire(n = 1) {
    this._debugFrame = this.game.time?.frame ?? 0;
    if (!this.weapon) return false;
    this._syncLookHistory();
    const wasForced = this._adsForced;
    this._releaseHold(true);
    if (wasForced >= 0) { this._adsForced = wasForced; this.adsAmount = wasForced; }

    const ctx = this._buildContext(0);
    ctx.adsAmount = this.adsAmount;
    const w = this.weapon;
    this.state = 'idle';
    this.viewmodel.hold = false;

    const rounds = Math.max(1, Math.min(12, n | 0));
    for (let i = 0; i < rounds; i++) {
      if (w.mag <= 0) w.refill();
      this.now += w.shotInterval;
      w.nextFireAt = 0;
      this.fireOnce(ctx, { capture: true, stagger: rounds - 1 - i });
      if (i < rounds - 1) {
        // advance the rig between rounds so the recoil actually accumulates
        this.viewmodel.update(Math.min(0.05, w.shotInterval), ctx);
      }
    }

    // let the springs express the kick, then freeze everything
    for (let i = 0; i < 6; i++) this.viewmodel.update(0.014, ctx);
    this.viewmodel.anchor(this.game.camera, this.game.engine.viewCamera);
    this._updateFov();
    this.viewmodel.hold = true;
    this.viewmodel.muzzle.held = true;
    this._hold = true;
    return true;
  }

  /** Swallow the camera jump `Capture.pose` makes, so sway does not whip. */
  _syncLookHistory() {
    const camera = this.game.camera;
    this._prevYaw = camera.rotation.y;
    this._prevPitch = camera.rotation.x;
    this._look.yaw = 0;
    this._look.pitch = 0;
    this.viewmodel?.swayPos.set(0, 0, 0);
    this.viewmodel?.swayRot.set(0, 0, 0);
  }

  _currentHFov() {
    const camera = this.game.camera;
    const h = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) * camera.aspect);
    return THREE.MathUtils.radToDeg(h);
  }

  /** Leave capture mode and hand control back to the player. */
  _releaseHold(keepPose) {
    this._hold = false;
    this._adsForced = -1;
    // Put the camera FOV back where we found it *before* anyone re-samples the
    // base, or a second debug pose would zoom the already-zoomed value.
    if (this._fovApplied) {
      try { this.game.engine.setHorizontalFov(this._baseHFov); } catch (err) { /* no engine yet */ }
      this._lastAppliedHFov = this._baseHFov;
      this._fovApplied = false;
    }
    this.adsAmount = 0;
    this.isADS = false;
    if (this.viewmodel) {
      this.viewmodel.hold = false;
      this.viewmodel.flashHold = false;
      if (this.viewmodel.muzzle) {
        this.viewmodel.muzzle.held = false;
        if (!keepPose) this.viewmodel.muzzle.clear();
      }
    }
    if (!keepPose) {
      this.state = 'idle';
      this.viewmodel?.stopClip();
      this.shells?.releaseManual();
    }
  }

  /* ================================================================ */

  dispose() {
    for (const off of this._unsub) off?.();
    this._unsub.length = 0;
    this.viewmodel?.dispose();
    this.shells?.dispose();
    this.tracers?.dispose();
    for (const w of this.weapons) w.dispose();
    for (const d of this._magDrops) d?.parent?.remove(d);
  }
}
