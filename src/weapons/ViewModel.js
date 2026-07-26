import * as THREE from 'three';
import { Spring, Spring3, Ease, clamp01, damp, fbm1 } from './Anim.js';
import { buildHand } from './models/Hands.js';
import { MuzzleFX } from './Effects.js';

/**
 * The viewmodel rig: everything that happens on layer 1.
 *
 * The transform stack is deliberately layered rather than baked, because that
 * is what lets sway, bob and recoil be *additive* on top of whatever base pose
 * the state machine is holding:
 *
 *   rigRoot      camera transform (so viewmodel space == world space)
 *    └ swayNode    additive: look-lag sway, walk bob, breathing
 *       └ poseNode   base pose (hip / ads / sprint / air) + overlay clip offset
 *          └ recoilNode  additive: recoil springs, landing impulse
 *             └ slot       the weapon model + both hands
 *
 * Every layer is spring-driven. There is not a single `lerp(a, b, 0.2)` in the
 * hot path: a lerp has no memory of velocity, so it cannot overshoot, cannot
 * settle, and always reads as UI easing rather than as a heavy object being
 * moved by a person.
 */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();

/** Channels a clip may drive. Anything absent decays back to zero. */
const CHANNELS = [
  'pos.x', 'pos.y', 'pos.z', 'rot.x', 'rot.y', 'rot.z',
  'mag.x', 'mag.y', 'mag.z', 'mag.rx', 'mag.ry', 'mag.rz', 'mag.v',
  'bolt.z', 'bolt.rz', 'charge.z', 'slide.z', 'hammer.rx', 'dust.rz', 'trigger.rx',
  'lh.x', 'lh.y', 'lh.z', 'lh.rx', 'lh.ry', 'lh.rz',
];

export class ViewModel {
  constructor(game, palette) {
    this.game = game;
    this.palette = palette;
    this.weapon = null;
    this.hold = false;
    this.time = 0;

    /* ---- rig ---- */
    const vs = game.engine.viewScene;
    this.rigRoot = new THREE.Group();
    this.rigRoot.name = 'viewmodelRig';
    this.rigRoot.matrixAutoUpdate = true;
    this.swayNode = new THREE.Group();
    this.poseNode = new THREE.Group();
    this.recoilNode = new THREE.Group();
    this.slot = new THREE.Group();
    this.slot.name = 'weaponSlot';
    this.rigRoot.add(this.swayNode);
    this.swayNode.add(this.poseNode);
    this.poseNode.add(this.recoilNode);
    this.recoilNode.add(this.slot);
    vs.add(this.rigRoot);
    // ARCHITECTURE.md calls the viewmodel pass "layer 1", but Engine's
    // viewCamera is constructed with only layer 0 enabled — so enable 1 on the
    // camera and *add* it to the rig rather than replacing layer 0. That way
    // the rig renders whichever layer mask the render module settles on.
    game.engine.viewCamera.layers.enable(1);
    for (const n of [this.rigRoot, this.swayNode, this.poseNode, this.recoilNode, this.slot]) {
      n.layers.enable(1);
    }

    /* ---- springs ---- */
    this.posSpring = new Spring3(430, 1.0);
    this.rotSpring = new Spring3(400, 1.0);
    this.swayPos = new Spring3(88, 0.62);
    this.swayRot = new Spring3(74, 0.58);
    this.recoilPos = new Spring3(340, 0.60);
    this.recoilRot = new Spring3(300, 0.52);
    this.landSpring = new Spring(150, 0.55);
    this.triggerPull = new Spring(220, 0.9);
    this.dustOpen = new Spring(90, 0.8);

    this.bobPhase = 0;
    this.bobAmount = 0;
    this.bobPos = new THREE.Vector3();
    this.bobRot = new THREE.Vector3();
    this._cycleOffset = 0;
    this._lastFireTime = -10;
    this.sprintAmount = 0;
    this.adsAmount = 0;

    /* ---- clip state ---- */
    this.clip = null;
    this.clipName = '';
    this.clipTime = 0;
    this.clipPrev = 0;
    this.clipSpeed = 1;
    this.onClipEvent = null;
    this.onClipEnd = null;
    this.ch = Object.create(null);
    this.chSmooth = Object.create(null);
    for (const c of CHANNELS) { this.ch[c] = 0; this.chSmooth[c] = 0; }
    this.ch['mag.v'] = 1;
    this.chSmooth['mag.v'] = 1;

    /* ---- fire cycle ---- */
    this.cycleT = -1;
    this.cycleDur = 0.07;
    this.cycleTravel = 0.03;

    /* ---- hands ---- */
    this.rightPose = 'grip';
    this.leftPose = 'support';
    this.leftHandNode = new THREE.Group();
    this.leftHandNode.name = 'leftHandNode';

    /* ---- fx ---- */
    this.muzzle = null;
    /** Capture mode: hold the flash at peak even while the rig keeps settling. */
    this.flashHold = false;

    this._basePose = { pos: new THREE.Vector3(), rot: new THREE.Vector3() };
    this._partBase = null;
    this._supportPos = new THREE.Vector3();
    this._supportQuat = new THREE.Quaternion();
  }

  /* ================================================================ */
  /* boot                                                              */
  /* ================================================================ */

  init() {
    this._buildLights();
    this._buildEnvironment();

    this.handRight = buildHand(this.palette, { side: 'right', forearm: 0.30 });
    this.handLeft = buildHand(this.palette, { side: 'left', forearm: 0.30 });
    this.handRight.setPose('grip');
    this.handLeft.setPose('support');
    for (const h of [this.handRight, this.handLeft]) {
      h.root.traverse((o) => { o.layers.enable(1); o.frustumCulled = false; });
    }
    this.leftHandNode.add(this.handLeft.root);
    this.leftHandNode.layers.enable(1);

    this.muzzle = new MuzzleFX(this.game.engine.viewScene, this.game.scene);
    this.muzzle.group.traverse((o) => o.layers.enable(1));
    for (const s of this.muzzle.smoke) s.layers.enable(1);
    return this;
  }

  /**
   * Three-point camera-relative rig. Viewmodel lighting is deliberately *not*
   * the world's lighting: a first-person weapon has to stay readable in a dark
   * interior and not blow out at noon, so it gets its own key/fill/rim that
   * follows the camera, tinted toward whatever the world sun is doing.
   */
  _buildLights() {
    const key = new THREE.DirectionalLight(0xfff0dd, 2.6);
    key.position.set(-0.55, 0.85, 0.42);
    key.castShadow = false;
    const fill = new THREE.DirectionalLight(0x8fb4d8, 0.85);
    fill.position.set(0.75, -0.15, 0.55);
    const rim = new THREE.DirectionalLight(0xbcd6ff, 1.5);
    rim.position.set(0.35, 0.42, -0.90);
    const amb = new THREE.HemisphereLight(0x9fb6d0, 0x2a2622, 0.75);
    this.lights = { key, fill, rim, amb };
    for (const l of [key, fill, rim, amb]) {
      l.layers.enable(1);
      this.rigRoot.add(l);
      if (l.target) { l.target.position.set(0, 0, -1); this.rigRoot.add(l.target); }
    }
  }

  /**
   * A tiny procedural environment probe. Metal without an env map reads as
   * plastic no matter how good the roughness map is; this bakes a sky/ground
   * gradient with a sun into a PMREM once, at boot.
   */
  _buildEnvironment() {
    const renderer = this.game.renderer;
    const W = 128;
    const H = 64;
    const data = new Float32Array(W * H * 4);
    const sunDir = new THREE.Vector3(-0.45, 0.62, 0.64).normalize();
    const d = new THREE.Vector3();
    for (let y = 0; y < H; y++) {
      const theta = (y + 0.5) / H * Math.PI;
      for (let x = 0; x < W; x++) {
        const phi = (x + 0.5) / W * Math.PI * 2;
        d.set(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi));
        const up = THREE.MathUtils.clamp(d.y, -1, 1);
        let r, g, b;
        if (up >= 0) {
          const t = Math.pow(up, 0.55);
          r = 0.16 + 0.24 * (1 - t); g = 0.26 + 0.26 * (1 - t); b = 0.52 + 0.30 * (1 - t);
          const sun = Math.max(0, d.dot(sunDir));
          const disc = Math.pow(sun, 900) * 90 + Math.pow(sun, 26) * 1.4;
          r += disc * 1.05; g += disc * 0.92; b += disc * 0.74;
        } else {
          const t = Math.pow(-up, 0.7);
          r = 0.11 + 0.05 * t; g = 0.10 + 0.045 * t; b = 0.088 + 0.038 * t;
        }
        const i = (y * W + x) * 4;
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 1;
      }
    }
    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.NoColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    this._envSource = tex;
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileEquirectangularShader();
      this._envTarget = pmrem.fromEquirectangular(tex);
      this.game.engine.viewScene.environment = this._envTarget.texture;
      this.game.engine.viewScene.environmentIntensity = 1.0;
      pmrem.dispose();
    } catch (err) {
      console.warn('[Weapons] viewmodel environment probe unavailable', err);
    }
  }

  /** Adopt the world's environment map if the render module publishes one. */
  syncEnvironment() {
    const world = this.game.scene?.environment;
    const vs = this.game.engine.viewScene;
    if (world && world !== this._adoptedEnv) {
      this._adoptedEnv = world;
      vs.environment = world;
      vs.environmentIntensity = this.game.scene.environmentIntensity ?? 1;
    }
  }

  /* ================================================================ */
  /* weapon binding                                                    */
  /* ================================================================ */

  setWeapon(weapon, opts = {}) {
    if (this.weapon === weapon) return;
    const prev = this.weapon;
    if (prev?.model) {
      prev.model.root.visible = false;
      if (prev.model.root.parent === this.slot) this.slot.remove(prev.model.root);
      this.muzzle?.detach();
      if (this.handRight?.root.parent) this.handRight.root.parent.remove(this.handRight.root);
      if (this.leftHandNode.parent) this.leftHandNode.parent.remove(this.leftHandNode);
    }
    this.weapon = weapon;
    if (!weapon?.model) return;
    const m = weapon.model;
    m.root.visible = true;
    m.root.traverse((o) => { o.layers.enable(1); });
    this.slot.add(m.root);

    // hands ride the weapon so they inherit every layer of motion for free
    if (m.sockets.grip) m.sockets.grip.add(this.handRight.root);
    m.root.add(this.leftHandNode);
    if (m.sockets.support) {
      this._supportPos.copy(m.sockets.support.position);
      this._supportQuat.copy(m.sockets.support.quaternion);
    } else {
      this._supportPos.set(0, 0, 0);
      this._supportQuat.identity();
    }
    this.leftHandNode.position.copy(this._supportPos);
    this.leftHandNode.quaternion.copy(this._supportQuat);

    // cache the rest transforms of every animated part
    const p = m.parts || {};
    this._partBase = {
      magazine: p.magazine ? p.magazine.position.clone() : null,
      magazineRot: p.magazine ? p.magazine.rotation.clone() : null,
      bolt: p.bolt ? p.bolt.position.clone() : null,
      charging: p.charging ? p.charging.position.clone() : null,
      slide: p.slide ? p.slide.position.clone() : null,
      hammer: p.hammer ? p.hammer.rotation.clone() : null,
      trigger: p.trigger ? p.trigger.rotation.clone() : null,
      dust: p.dustCover ? p.dustCover.rotation.clone() : null,
    };

    this.muzzle?.attach(m.sockets.muzzle, weapon.def.flashPower ?? 1);
    this.cycleTravel = weapon.def.boltBack ?? 0.03;
    this.cycleDur = Math.min(0.085, Math.max(0.035, weapon.shotInterval * 0.72));

    // aim each forearm back toward its shoulder; the wrist is the skeleton
    // root, so this never disturbs the grip the socket just established
    const fa = m.forearm || { right: [0.28, 0.62, 0], left: [0.55, -0.85, 0] };
    this.handRight.setForearm(fa.right[0], fa.right[1], fa.right[2]);
    this.handLeft.setForearm(fa.left[0], fa.left[1], fa.left[2]);

    this.leftPose = 'support';
    this.rightPose = 'grip';
    this.handLeft.setPose('support');
    this.handRight.setPose('grip');

    this.resetChannels();
    if (opts.instant) {
      const pose = weapon.def.poses.hip;
      this.posSpring.set(pose.pos[0], pose.pos[1], pose.pos[2]);
      this.rotSpring.set(pose.rot[0], pose.rot[1], pose.rot[2]);
    }
  }

  resetChannels() {
    for (const c of CHANNELS) { this.ch[c] = 0; this.chSmooth[c] = 0; }
    this.ch['mag.v'] = 1;
    this.chSmooth['mag.v'] = 1;
    this.clip = null;
    this.clipName = '';
    this.cycleT = -1;
  }

  /* ================================================================ */
  /* clips                                                             */
  /* ================================================================ */

  playClip(name, opts = {}) {
    const clip = this.weapon?.clips?.[name];
    if (!clip) return false;
    this.clip = clip;
    this.clipName = name;
    this.clipTime = 0;
    this.clipPrev = -1;
    this.clipSpeed = opts.speed ?? 1;
    return true;
  }

  stopClip() { this.clip = null; this.clipName = ''; }

  get clipProgress() {
    if (!this.clip) return 1;
    return clamp01(this.clipTime / this.clip.duration);
  }

  /** Jump a clip to a fixed point and freeze it — used by the capture harness. */
  scrubClip(name, t) {
    if (!this.playClip(name)) return false;
    this.clipTime = this.clip.duration * clamp01(t);
    this.clipPrev = this.clipTime;
    this.clip.sample(this.clipTime, this.ch);
    for (const c of CHANNELS) this.chSmooth[c] = this.ch[c] ?? (c === 'mag.v' ? 1 : 0);
    return true;
  }

  /* ================================================================ */
  /* impulses                                                          */
  /* ================================================================ */

  /**
   * Visual recoil kick. Separate from the camera recoil the player receives —
   * the weapon moves further and recovers faster than the view does, which is
   * what sells the weapon as a physical object being held.
   */
  onFire(weapon, adsAmount) {
    const k = weapon.def.recoil.kick;
    const ads = clamp01(adsAmount);
    const s = THREE.MathUtils.lerp(1, 0.55, ads);
    const rnd = (a) => (Math.random() * 2 - 1) * a;
    this.recoilPos.impulse(
      (rnd(k.back * 0.35) - k.back * 0.12) * 10 * s,
      (k.up + rnd(k.up * 0.4)) * 11 * s,
      (k.back + rnd(k.back * 0.35)) * 16 * s,
    );
    this.recoilRot.impulse(
      -(k.pitch + rnd(k.pitch * 0.3)) * 13 * s,
      (rnd(k.yaw)) * 12 * s,
      (rnd(k.roll) + k.roll * 0.35) * 11 * s,
    );
    this.triggerPull.impulse(9);
    this.cycleT = 0;
    this.dustOpen.target = 1;
    this._lastFireTime = this.time;
  }

  onDryFire() {
    this.triggerPull.impulse(7);
    this.recoilPos.impulse(0, 0, 0.22);
  }

  onLand(impact) {
    const a = THREE.MathUtils.clamp(impact ?? 1, 0, 3);
    this.landSpring.impulse(-a * 0.9);
    this.recoilRot.impulse(a * 1.4, 0, 0);
  }

  /* ================================================================ */
  /* per-frame                                                         */
  /* ================================================================ */

  /**
   * @param {number} dt
   * @param {Object} ctx {adsAmount, speed, maxSpeed, sprinting, grounded, stance,
   *                      look:{yaw,pitch}, triggerHeld, firing}
   */
  update(dt, ctx) {
    const adt = this.hold ? 0 : dt;
    this.time += adt;
    const w = this.weapon;
    if (!w?.model) return;

    this.adsAmount = clamp01(ctx.adsAmount ?? 0);

    this._advanceClip(adt);
    this._basePoseFor(adt, w, ctx);
    this._bob(adt, ctx);
    this._sway(adt, ctx);
    this._recoil(adt);
    this._cycle(adt, ctx);
    this._applyChannels(adt, w);
    this._hands(dt, ctx);
    this._optic(dt);

    this.muzzle.held = this.hold || this.flashHold;
    this.muzzle.update(dt, this.game.engine.viewCamera);
  }

  _advanceClip(dt) {
    if (!this.clip) {
      // ease every channel home so an interrupted clip never pops
      for (const c of CHANNELS) {
        const rest = c === 'mag.v' ? 1 : 0;
        this.ch[c] = rest;
      }
      return;
    }
    this.clipPrev = this.clipTime;
    this.clipTime += dt * this.clipSpeed;
    for (const c of CHANNELS) this.ch[c] = c === 'mag.v' ? 1 : 0;
    this.clip.sample(this.clipTime, this.ch);
    if (this.clipPrev >= 0) {
      this.clip.fireEvents(this.clipPrev, this.clipTime, (name, data) => {
        if (name === 'lh') { this.leftPose = data; return; }
        if (name === 'rh') { this.rightPose = data; return; }
        this.onClipEvent?.(name, data, this.clipName);
      });
    }
    if (this.clipTime >= this.clip.duration) {
      const done = this.clipName;
      this.clip = null;
      this.clipName = '';
      this.onClipEnd?.(done);
    }
  }

  _basePoseFor(dt, w, ctx) {
    const P = w.def.poses;
    const ads = this.adsAmount;
    const adsE = Ease.smoother(ads);
    const hip = P.hip, aim = P.ads;

    // hip -> ads
    let px = THREE.MathUtils.lerp(hip.pos[0], aim.pos[0], adsE);
    let py = THREE.MathUtils.lerp(hip.pos[1], aim.pos[1], adsE);
    let pz = THREE.MathUtils.lerp(hip.pos[2], aim.pos[2], adsE);
    let rx = THREE.MathUtils.lerp(hip.rot[0], aim.rot[0], adsE);
    let ry = THREE.MathUtils.lerp(hip.rot[1], aim.rot[1], adsE);
    let rz = THREE.MathUtils.lerp(hip.rot[2], aim.rot[2], adsE);

    // sprint overrides the hip pose, never the aim pose
    const wantSprint = ctx.sprinting && ads < 0.02 && !this.clip;
    this.sprintAmount = damp(this.sprintAmount, wantSprint ? 1 : 0, wantSprint ? 9 : 13, Math.max(1e-4, dt));
    const stance = ctx.stance;
    const sp = (stance === 'slide' && P.slide) ? P.slide : P.sprint;
    if (this.sprintAmount > 0.001) {
      const t = Ease.smooth(this.sprintAmount);
      px = THREE.MathUtils.lerp(px, sp.pos[0], t);
      py = THREE.MathUtils.lerp(py, sp.pos[1], t);
      pz = THREE.MathUtils.lerp(pz, sp.pos[2], t);
      rx = THREE.MathUtils.lerp(rx, sp.rot[0], t);
      ry = THREE.MathUtils.lerp(ry, sp.rot[1], t);
      rz = THREE.MathUtils.lerp(rz, sp.rot[2], t);
    }
    // airborne: the weapon trails the body
    if (ctx.grounded === false && P.air) {
      const t = 0.55 * (1 - ads);
      px = THREE.MathUtils.lerp(px, P.air.pos[0], t);
      py = THREE.MathUtils.lerp(py, P.air.pos[1], t);
      pz = THREE.MathUtils.lerp(pz, P.air.pos[2], t);
      rx = THREE.MathUtils.lerp(rx, P.air.rot[0], t);
      ry = THREE.MathUtils.lerp(ry, P.air.rot[1], t);
      rz = THREE.MathUtils.lerp(rz, P.air.rot[2], t);
    }

    // clip offsets ride on top of the base pose
    px += this.chSmooth['pos.x'];
    py += this.chSmooth['pos.y'];
    pz += this.chSmooth['pos.z'];
    rx += this.chSmooth['rot.x'];
    ry += this.chSmooth['rot.y'];
    rz += this.chSmooth['rot.z'];

    // ADS wants to be exact, so stiffen the spring as the sights come up
    const k = THREE.MathUtils.lerp(340, 760, this.adsAmount);
    this.posSpring.k = k;
    this.rotSpring.k = k * 0.92;
    this.posSpring.setTarget(px, py, pz);
    this.rotSpring.setTarget(rx, ry, rz);

    const p = this.posSpring.update(dt);
    const r = this.rotSpring.update(dt);
    this.poseNode.position.copy(p);
    this.poseNode.rotation.set(r.x, r.y, r.z);
  }

  _sway(dt, ctx) {
    const look = ctx.look || { yaw: 0, pitch: 0 };
    const inv = 1 / Math.max(1e-3, dt || 1e-3);
    const yawRate = THREE.MathUtils.clamp(look.yaw * inv, -14, 14);
    const pitchRate = THREE.MathUtils.clamp(look.pitch * inv, -12, 12);
    const g = (1 - this.adsAmount * 0.62);

    // breathing: a slow figure-of-eight with noise so it never loops audibly
    const t = this.time;
    const bx = (Math.sin(t * 0.62) * 0.0016 + fbm1(t * 0.31) * 0.0022) * g;
    const by = (Math.sin(t * 1.24 + 1.1) * 0.0012 + fbm1(t * 0.27 + 9) * 0.0016) * g;
    const brx = (Math.sin(t * 0.58 + 0.4) * 0.0075 + fbm1(t * 0.24 + 3) * 0.0090) * g;
    const bry = (Math.sin(t * 0.41) * 0.0090 + fbm1(t * 0.19 + 17) * 0.0110) * g;
    // scoped weapons wobble more: the magnification amplifies the same hand shake
    const scopeMul = 1 + (this.weapon?.def.scoped ? this.adsAmount * 2.6 : 0);

    this.swayPos.setTarget(
      (-yawRate * 0.0085) * g + bx,
      (-pitchRate * 0.0060) * g + by,
      0,
    );
    this.swayRot.setTarget(
      (pitchRate * 0.055) * g + brx * scopeMul,
      (yawRate * 0.070) * g + bry * scopeMul,
      (-yawRate * 0.048) * g,
    );
    const sp = this.swayPos.update(dt);
    const sr = this.swayRot.update(dt);

    const land = this.landSpring.update(dt);

    this.swayNode.position.set(sp.x + this.bobPos.x, sp.y + this.bobPos.y + land * 0.055, sp.z + this.bobPos.z);
    this.swayNode.rotation.set(sr.x + this.bobRot.x, sr.y + this.bobRot.y, sr.z + this.bobRot.z);
  }

  _bob(dt, ctx) {
    if (!this.bobPos) { this.bobPos = new THREE.Vector3(); this.bobRot = new THREE.Vector3(); }
    const speed = ctx.speed ?? 0;
    const maxSpeed = ctx.maxSpeed ?? 5.4;
    const norm = THREE.MathUtils.clamp(speed / maxSpeed, 0, 1.35);
    const grounded = ctx.grounded !== false;
    const target = grounded ? norm : 0;
    this.bobAmount = damp(this.bobAmount, target, 7, dt);

    const rate = ctx.sprinting ? 11.5 : 8.6;
    this.bobPhase += dt * rate * (0.35 + norm * 0.85);

    const amp = this.bobAmount * (1 - this.adsAmount * 0.80) * (ctx.sprinting ? 1.75 : 1.0);
    const s = Math.sin(this.bobPhase);
    const c = Math.cos(this.bobPhase * 2);
    this.bobPos.set(
      s * 0.0125 * amp,
      (-Math.abs(c) * 0.0080 + 0.0035) * amp,
      Math.sin(this.bobPhase * 2 + 0.8) * 0.0055 * amp,
    );
    this.bobRot.set(
      c * 0.0140 * amp,
      s * 0.0180 * amp,
      -s * 0.0260 * amp,
    );
  }

  _recoil(dt) {
    // The springs are driven by impulses, so the amplitude that reaches the
    // node is velocity/omega — roughly 2-3 cm of travel and 3-5 degrees of
    // pitch for a rifle, which is what a real viewmodel kick measures.
    const p = this.recoilPos.update(dt);
    const r = this.recoilRot.update(dt);
    this.recoilNode.position.copy(p);
    this.recoilNode.rotation.set(r.x, r.y, r.z);
  }

  /** Bolt / slide reciprocation driven by the fire beat rather than a clip. */
  _cycle(dt, ctx) {
    if (this.cycleT >= 0) {
      if (!this.hold) this.cycleT += dt;
      const u = clamp01(this.cycleT / this.cycleDur);
      const held = this.hold ? 0.42 : u;
      const travel = held < 0.42
        ? Ease.outQuart(held / 0.42)
        : 1 - Ease.inOutCubic((held - 0.42) / 0.58);
      this._cycleOffset = travel * this.cycleTravel;
      if (u >= 1 && !this.hold) { this.cycleT = -1; this._cycleOffset = 0; }
    } else {
      this._cycleOffset = 0;
    }
    const firingRecently = this.time - (this._lastFireTime ?? -10) < 1.6;
    this.dustOpen.target = firingRecently || this.weapon?.mag < this.weapon?.magSize ? 1 : 0;
    this.dustOpen.update(dt);
    this.triggerPull.target = ctx.triggerHeld ? 1 : 0;
    this.triggerPull.update(dt);
  }

  _applyChannels(dt, w) {
    // channel smoothing: a clip that is cut short decays rather than snapping
    const lambda = 30;
    for (const c of CHANNELS) {
      const rest = c === 'mag.v' ? 1 : 0;
      const target = this.ch[c] ?? rest;
      this.chSmooth[c] = this.hold ? target : damp(this.chSmooth[c], target, lambda, dt || 1e-3);
    }

    const parts = w.model.parts || {};
    const base = this._partBase || {};

    if (parts.magazine && base.magazine) {
      parts.magazine.position.set(
        base.magazine.x + this.chSmooth['mag.x'],
        base.magazine.y + this.chSmooth['mag.y'],
        base.magazine.z + this.chSmooth['mag.z'],
      );
      parts.magazine.rotation.set(
        base.magazineRot.x + this.chSmooth['mag.rx'],
        base.magazineRot.y + this.chSmooth['mag.ry'],
        base.magazineRot.z + this.chSmooth['mag.rz'],
      );
      parts.magazine.visible = this.chSmooth['mag.v'] > 0.5;
    }
    if (parts.bolt && base.bolt) {
      parts.bolt.position.z = base.bolt.z + this.chSmooth['bolt.z'] + this._cycleOffset;
      parts.bolt.rotation.z = this.chSmooth['bolt.rz'];
    }
    if (parts.charging && base.charging) {
      parts.charging.position.z = base.charging.z + this.chSmooth['charge.z'];
    }
    if (parts.slide && base.slide) {
      parts.slide.position.z = base.slide.z + this.chSmooth['slide.z'] + this._cycleOffset;
    }
    if (parts.hammer && base.hammer) {
      const c = this._cycleOffset / Math.max(1e-4, this.cycleTravel);
      parts.hammer.rotation.x = base.hammer.x + this.chSmooth['hammer.rx'] - c * 1.0;
    }
    if (parts.trigger && base.trigger) {
      parts.trigger.rotation.x = base.trigger.x + this.chSmooth['trigger.rx'] + this.triggerPull.value * 0.30;
    }
    if (parts.dustCover && base.dust) {
      parts.dustCover.rotation.z = base.dust.z + this.chSmooth['dust.rz'] - this.dustOpen.value * 1.85;
    }

    // support hand offset, authored in weapon space
    this.leftHandNode.position.set(
      this._supportPos.x + this.chSmooth['lh.x'],
      this._supportPos.y + this.chSmooth['lh.y'],
      this._supportPos.z + this.chSmooth['lh.z'],
    );
    _e.set(this.chSmooth['lh.rx'], this.chSmooth['lh.ry'], this.chSmooth['lh.rz'], 'XYZ');
    _q.setFromEuler(_e);
    this.leftHandNode.quaternion.copy(this._supportQuat).premultiply(_q);
  }

  _hands(dt, ctx) {
    const firing = this.triggerPull.value > 0.35 || this._cycleOffset > 1e-4;
    const rp = firing ? 'gripFire' : this.rightPose;
    const rate = clamp01((dt || 0.016) * 16);
    this.handRight.applyPose(rp, rate);
    this.handLeft.applyPose(this.leftPose, clamp01((dt || 0.016) * 12));
  }

  _optic(dt) {
    const optic = this.weapon?.model?.optic;
    if (!optic) return;
    if (optic.type === 'scope' && optic.uniforms) {
      const a = this.adsAmount;
      optic.uniforms.uActive.value = damp(optic.uniforms.uActive.value, a > 0.15 ? 1 : 0, 14, dt || 0.016);
      optic.uniforms.uShadow.value = 1 - Ease.smooth(clamp01((a - 0.35) / 0.5));
      optic.uniforms.uReticle.value = a > 0.05 ? 1 : 0.35;
    }
    if (optic.setBrightness) {
      // a red dot gets noticeably brighter as the eye comes behind it
      optic.setBrightness(THREE.MathUtils.lerp(5.0, 11.0, this.adsAmount));
    }
  }

  /**
   * Render the world through a magnified optic. Called from the weapon system's
   * lateUpdate, before PostFX owns the frame; the render target is restored
   * immediately so the main chain is unaffected.
   */
  renderScope(renderer, worldScene) {
    const optic = this.weapon?.model?.optic;
    if (!optic || optic.type !== 'scope' || !optic.render) return false;
    if (this.adsAmount < 0.12) return false;
    optic.render(renderer, worldScene, this.game.engine.viewCamera, optic.magnification);
    return true;
  }

  /* ================================================================ */
  /* frame anchoring                                                   */
  /* ================================================================ */

  /**
   * Pin the rig (and the viewmodel camera) to the world camera. Doing this in
   * lateUpdate, after the player controller has finished, means viewmodel space
   * and world space share an origin — which is what lets the ejection port hand
   * a world-space position straight to the physics solver.
   */
  anchor(camera, viewCamera) {
    this.rigRoot.position.copy(camera.position);
    this.rigRoot.quaternion.copy(camera.quaternion);
    viewCamera.position.copy(camera.position);
    viewCamera.quaternion.copy(camera.quaternion);
    this.rigRoot.updateMatrixWorld(true);
  }

  /** World-space transform of a socket on the current weapon. */
  socketWorld(name, outPos, outQuat) {
    const s = this.weapon?.model?.sockets?.[name];
    if (!s) return false;
    s.updateWorldMatrix(true, false);
    if (outPos) outPos.setFromMatrixPosition(s.matrixWorld);
    if (outQuat) outQuat.setFromRotationMatrix(s.matrixWorld);
    return true;
  }

  dispose() {
    this.muzzle?.dispose();
    this._envTarget?.dispose?.();
    this._envSource?.dispose?.();
    this.rigRoot.parent?.remove(this.rigRoot);
  }
}
