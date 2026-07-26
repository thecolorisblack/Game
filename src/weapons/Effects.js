import * as THREE from 'three';
import { lathe, mergeParts, applyBoxUV, flatColor } from './models/Parts.js';

/**
 * First-person weapon effects: muzzle flash, propellant smoke, ejected brass,
 * dropped magazines and a fallback tracer pool.
 *
 * Everything is generated in code — the flash and smoke textures are written
 * straight into DataTextures at boot, the brass is a lathed case with a real rim
 * and primer, and the flash contributes actual light both to the viewmodel
 * (a point light inside the viewmodel scene, which is what makes the hands and
 * the receiver pop on every shot) and to the world.
 */

/* ==================================================================== */
/* procedural textures                                                   */
/* ==================================================================== */

function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return (a + (b - a) * ux) + ((c - a) + (a - b - c + d) * ux) * uy;
}

function fbm2(x, y, oct = 4) {
  let v = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { v += vnoise(x * f, y * f) * a; f *= 2.07; a *= 0.5; }
  return v;
}

/** Star-burst muzzle flash: hot white core, six-ray flare, orange falloff. */
export function makeFlashTexture(size = 128) {
  const d = new Uint8Array(size * size * 4);
  const c = (size - 1) * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c;
      const dy = (y - c) / c;
      const r = Math.hypot(dx, dy);
      const th = Math.atan2(dy, dx);
      let v = Math.exp(-r * r * 11.0) * 1.35;
      v += Math.exp(-r * r * 46.0) * 1.1;
      // rays
      let rays = 0;
      for (let k = 0; k < 3; k++) {
        const phase = k * 1.0472;
        rays += Math.pow(Math.max(0, Math.abs(Math.cos(th * 3 + phase))), 34) * 0.55;
      }
      v += rays * Math.exp(-r * 3.4);
      // irregular edge so two consecutive shots never look identical
      v *= 0.82 + 0.36 * fbm2(dx * 3.5 + 11, dy * 3.5 + 7, 3);
      v = Math.max(0, Math.min(1.6, v));
      const a = Math.min(1, v);
      const warm = Math.min(1, r * 1.5);
      const i = (y * size + x) * 4;
      d[i] = Math.min(255, v * 255);
      d[i + 1] = Math.min(255, v * (1 - warm * 0.42) * 255);
      d[i + 2] = Math.min(255, v * (1 - warm * 0.86) * 255);
      d[i + 3] = a * 255;
    }
  }
  const t = new THREE.DataTexture(d, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  t.name = 'muzzleFlash';
  return t;
}

/** Soft turbulent puff, alpha only in the red channel + alpha. */
export function makeSmokeTexture(size = 96) {
  const d = new Uint8Array(size * size * 4);
  const c = (size - 1) * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c;
      const dy = (y - c) / c;
      const r = Math.hypot(dx, dy);
      let n = fbm2(dx * 2.2 + 3.1, dy * 2.2 + 5.7, 4);
      n = 0.35 + n * 0.85;
      let a = Math.max(0, 1 - r) ** 1.7 * n;
      a = Math.max(0, Math.min(1, a * 1.5));
      const i = (y * size + x) * 4;
      const lum = 200 + 40 * n;
      d[i] = lum; d[i + 1] = lum; d[i + 2] = lum;
      d[i + 3] = a * 255;
    }
  }
  const t = new THREE.DataTexture(d, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  t.name = 'muzzleSmoke';
  return t;
}

/* ==================================================================== */
/* muzzle flash + smoke                                                  */
/* ==================================================================== */

const SMOKE_COUNT = 14;

export class MuzzleFX {
  /**
   * @param {THREE.Scene} viewScene   the layer-1 viewmodel scene
   * @param {THREE.Scene} worldScene  for the world-side flash light
   */
  constructor(viewScene, worldScene, opts = {}) {
    this.viewScene = viewScene;
    this.worldScene = worldScene;
    this.time = 0;
    this.flashT = -1;
    this.flashLife = 0.055;
    this.scale = 1;
    this.held = false;

    const flashTex = opts.flashTexture || makeFlashTexture();
    const smokeTex = opts.smokeTexture || makeSmokeTexture();
    this.flashTex = flashTex;
    this.smokeTex = smokeTex;

    this.flashMat = new THREE.MeshBasicMaterial({
      map: flashTex, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: false, toneMapped: true, side: THREE.DoubleSide,
      color: new THREE.Color(6.5, 4.2, 2.0),
    });
    this.coneMat = new THREE.MeshBasicMaterial({
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      depthTest: false, toneMapped: true, side: THREE.DoubleSide,
      color: new THREE.Color(4.0, 2.2, 0.85), opacity: 0.9,
    });

    // group is parented to the weapon's muzzle socket by the viewmodel
    this.group = new THREE.Group();
    this.group.name = 'muzzleFlash';
    this.group.visible = false;
    this.group.frustumCulled = false;

    const quad = new THREE.PlaneGeometry(1, 1);
    this.billboard = new THREE.Mesh(quad, this.flashMat);
    this.billboard.frustumCulled = false;
    this.billboard.renderOrder = 20;
    this.group.add(this.billboard);

    // two crossed quads down the bore give the flash volume from the side
    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(quad, this.flashMat);
      m.rotation.set(i === 0 ? 0 : Math.PI * 0.5, Math.PI * 0.5, 0);
      m.position.z = -0.03;
      m.frustumCulled = false;
      m.renderOrder = 19;
      this.group.add(m);
      if (i === 0) this.side1 = m; else this.side2 = m;
    }

    // forward cone: the actual jet of burning propellant
    const cone = new THREE.ConeGeometry(0.055, 0.16, 12, 1, true);
    cone.rotateX(-Math.PI * 0.5);
    cone.translate(0, 0, -0.075);
    this.cone = new THREE.Mesh(cone, this.coneMat);
    this.cone.frustumCulled = false;
    this.cone.renderOrder = 18;
    this.group.add(this.cone);

    // viewmodel-side flash light: this is what lights the hands
    // NB: never toggle `visible` on these. three keys its shader programs on
    // the light count, so switching a light off and on again recompiles every
    // material in the scene — mid-firefight. Drive intensity instead.
    this.viewLight = new THREE.PointLight(0xffb066, 0, 2.6, 2.0);
    this.viewLight.castShadow = false;
    this.group.add(this.viewLight);

    // world-side flash light, so the muzzle actually illuminates the level
    this.worldLight = new THREE.PointLight(0xffa855, 0, 12, 2.0);
    this.worldLight.castShadow = false;
    worldScene?.add(this.worldLight);

    /* ---- smoke ---- */
    this.smokeMat = new THREE.MeshBasicMaterial({
      map: smokeTex, transparent: true, depthWrite: false, depthTest: false,
      opacity: 0, toneMapped: true, side: THREE.DoubleSide,
      color: new THREE.Color(0.42, 0.42, 0.46),
    });
    this.smoke = [];
    for (let i = 0; i < SMOKE_COUNT; i++) {
      const m = new THREE.Mesh(quad, this.smokeMat.clone());
      m.visible = false;
      m.frustumCulled = false;
      m.renderOrder = 12;
      m.userData = { life: 0, maxLife: 1, vel: new THREE.Vector3(), spin: 0, size: 0.1 };
      viewScene.add(m);
      this.smoke.push(m);
    }
    this._smokeIdx = 0;
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
  }

  /** Attach the flash rig to a weapon's muzzle socket. */
  attach(socket, scale = 1) {
    if (!socket) return;
    socket.add(this.group);
    this.scale = scale;
  }

  detach() {
    this.group.parent?.remove(this.group);
    this.group.visible = false;
    this.viewLight.visible = false;
  }

  /**
   * Fire the flash.
   * @param {number} power  1 = rifle; scales size, light and smoke volume
   */
  flash(power = 1, worldPos = null) {
    this.flashT = 0;
    this.power = power;
    this.flashLife = 0.045 + 0.022 * power;
    this.group.visible = true;
    const roll = Math.random() * Math.PI * 2;
    this.billboard.rotation.z = roll;
    this.side1.rotation.x = roll * 0.5;
    this.side2.rotation.x = roll * 0.5 + Math.PI * 0.5;
    const s = (0.85 + Math.random() * 0.4) * power;
    this._flashScale = s;
    if (worldPos && this.worldLight) this.worldLight.position.copy(worldPos);
    this._worldLit = !!worldPos;
    this._spawnSmoke(power, worldPos);
  }

  _spawnSmoke(power, worldPos) {
    const n = Math.min(SMOKE_COUNT, 3 + Math.round(power * 3));
    const origin = worldPos || this._muzzleWorld();
    for (let i = 0; i < n; i++) {
      const m = this.smoke[this._smokeIdx];
      this._smokeIdx = (this._smokeIdx + 1) % SMOKE_COUNT;
      const fwd = this._forwardWorld(this._tmp2);
      m.position.copy(origin)
        .addScaledVector(fwd, 0.02 + Math.random() * 0.10 * power);
      m.position.x += (Math.random() - 0.5) * 0.035;
      m.position.y += (Math.random() - 0.5) * 0.035;
      m.position.z += (Math.random() - 0.5) * 0.035;
      const u = m.userData;
      u.maxLife = 0.55 + Math.random() * 0.75;
      u.life = u.maxLife;
      u.size = (0.055 + Math.random() * 0.075) * power;
      u.grow = 0.28 + Math.random() * 0.34;
      u.spin = (Math.random() - 0.5) * 2.2;
      u.vel.copy(fwd).multiplyScalar(1.2 + Math.random() * 2.0 * power);
      u.vel.x += (Math.random() - 0.5) * 0.7;
      u.vel.y += 0.25 + Math.random() * 0.5;
      u.vel.z += (Math.random() - 0.5) * 0.7;
      m.material.opacity = 0;
      m.rotation.z = Math.random() * Math.PI * 2;
      m.visible = true;
    }
  }

  /**
   * Push the live smoke forward in time without advancing the flash. The
   * capture harness freezes the frame the instant a shot is fired, and a puff
   * that has existed for zero seconds is invisible; this stages it mid-life.
   */
  prime(t) {
    const step = 0.02;
    let left = t;
    while (left > 0) {
      const dt = Math.min(step, left);
      left -= dt;
      for (const m of this.smoke) {
        if (!m.visible) continue;
        const u = m.userData;
        u.life -= dt;
        if (u.life <= 0) { m.visible = false; continue; }
        m.position.addScaledVector(u.vel, dt);
        u.vel.multiplyScalar(1 - Math.min(0.9, dt * 3.4));
        u.vel.y += dt * 0.35;
        m.rotation.z += u.spin * dt;
      }
    }
  }

  _muzzleWorld(out = new THREE.Vector3()) {
    this.group.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.group.matrixWorld);
  }

  _forwardWorld(out) {
    this.group.updateWorldMatrix(true, false);
    out.set(0, 0, -1).transformDirection(this.group.matrixWorld);
    return out;
  }

  /** @param {THREE.Camera} camera used to billboard the flash and the smoke */
  update(dt, camera) {
    this.time += dt;
    const held = this.held;

    // ---- flash ------------------------------------------------------
    if (this.flashT >= 0) {
      if (!held) this.flashT += dt;
      const t = Math.min(1, this.flashT / this.flashLife);
      if (t >= 1 && !held) {
        this.flashT = -1;
        this.group.visible = false;
        this.viewLight.intensity = 0;
        if (this.worldLight) this.worldLight.intensity = 0;
      } else {
        // fast attack, exponential decay — a real flash is not a linear fade
        const e = held ? 0.55 : (t < 0.18 ? t / 0.18 : Math.exp(-(t - 0.18) * 9.0));
        const s = this._flashScale * (0.55 + e * 0.75);
        this.billboard.scale.setScalar(0.30 * s);
        this.side1.scale.set(0.20 * s, 0.14 * s, 1);
        this.side2.scale.set(0.20 * s, 0.14 * s, 1);
        this.cone.scale.set(s * 0.9, s * 0.9, s * (0.7 + e * 0.9));
        this.flashMat.opacity = Math.min(1, e * 1.25);
        this.coneMat.opacity = Math.min(1, e * 0.85);
        this.viewLight.intensity = e * 26 * this.power;
        if (this.worldLight && this._worldLit) this.worldLight.intensity = e * 90 * this.power;
        if (camera) this.billboard.quaternion.copy(camera.quaternion).premultiply(
          this._invParent(this.billboard),
        );
      }
    }

    // ---- smoke ------------------------------------------------------
    for (const m of this.smoke) {
      if (!m.visible) continue;
      const u = m.userData;
      if (!held) {
        u.life -= dt;
        if (u.life <= 0) { m.visible = false; continue; }
        m.position.addScaledVector(u.vel, dt);
        u.vel.multiplyScalar(1 - Math.min(0.9, dt * 3.4));
        u.vel.y += dt * 0.35;
        m.rotation.z += u.spin * dt;
      }
      const age = 1 - u.life / u.maxLife;
      const size = u.size * (1 + age * u.grow * 4.0);
      m.scale.setScalar(size);
      m.material.opacity = Math.sin(Math.min(1, age * 3.2) * Math.PI * 0.5) * (1 - age) * 0.42;
      if (camera) m.quaternion.copy(camera.quaternion);
    }
  }

  _invParent(obj) {
    // billboard against the camera while living under the rotating muzzle socket
    const q = this._bbQ || (this._bbQ = new THREE.Quaternion());
    obj.parent?.updateWorldMatrix(true, false);
    if (obj.parent) {
      q.setFromRotationMatrix(obj.parent.matrixWorld).invert();
    } else q.identity();
    return q;
  }

  clear() {
    this.flashT = -1;
    this.group.visible = false;
    this.viewLight.intensity = 0;
    if (this.worldLight) this.worldLight.intensity = 0;
    for (const m of this.smoke) m.visible = false;
  }

  dispose() {
    this.clear();
    this.flashTex.dispose();
    this.smokeTex.dispose();
    this.flashMat.dispose();
    this.coneMat.dispose();
    for (const m of this.smoke) { m.material.dispose(); m.parent?.remove(m); }
    this.worldLight?.parent?.remove(this.worldLight);
  }
}

/* ==================================================================== */
/* brass                                                                 */
/* ==================================================================== */

const SHELL_POOL = 26;

/** Lathed cartridge case with a rim, extractor groove and a primer. */
export function makeShellGeometry(calibre = 1) {
  const r = 0.0047 * calibre;
  const len = 0.0450 * calibre;
  const body = lathe([
    [2e-5, 0], [r * 1.10, 0], [r * 1.10, 0.0016], [r * 0.84, 0.0030],
    [r * 0.84, 0.0044], [r * 1.02, 0.0060], [r * 1.00, len * 0.62],
    [r * 0.86, len * 0.82], [r * 0.82, len], [r * 0.70, len], [r * 0.70, len - 0.0035],
    [2e-5, len - 0.0040],
  ], 14);
  const primer = lathe([[2e-5, 0.0004], [r * 0.42, 0.0004], [r * 0.42, 0.0011], [2e-5, 0.0011]], 10);
  const g = mergeParts([body, primer]);
  g.translate(0, 0, -len * 0.5);
  applyBoxUV(g, 12);
  flatColor(g, 1);
  return g;
}

export class ShellSystem {
  constructor(game, palette) {
    this.game = game;
    this.scene = game.scene;
    this.material = palette.brass;
    this.geometry = makeShellGeometry(1);
    this.pool = [];
    this.bodies = new Map();
    this._next = 0;
    this._manual = [];
    this._tmp = new THREE.Vector3();

    for (let i = 0; i < SHELL_POOL; i++) {
      const m = new THREE.Mesh(this.geometry, this.material);
      m.visible = false;
      m.castShadow = false;
      m.receiveShadow = false;
      m.frustumCulled = true;
      m.matrixAutoUpdate = true;
      this.scene?.add(m);
      this.pool.push(m);
    }
  }

  _take() {
    const m = this.pool[this._next];
    this._next = (this._next + 1) % this.pool.length;
    const prev = this.bodies.get(m);
    if (prev) { try { this.game.physics?.removeBody?.(prev); } catch { /* gone already */ } }
    this.bodies.delete(m);
    const idx = this._manual.indexOf(m);
    if (idx >= 0) this._manual.splice(idx, 1);
    return m;
  }

  /**
   * Eject a case.
   * @param {THREE.Vector3} pos    world position of the ejection port
   * @param {THREE.Vector3} vel    world velocity
   * @param {Object} opts          {scale, manual:boolean, spin}
   */
  eject(pos, vel, opts = {}) {
    const m = this._take();
    m.position.copy(pos);
    m.quaternion.set(Math.random(), Math.random(), Math.random(), Math.random()).normalize();
    m.scale.setScalar(opts.scale ?? 1);
    m.visible = true;

    if (opts.manual) {
      // capture / freeze mode: no simulation, the case hangs where it was placed
      m.userData.manual = true;
      this._manual.push(m);
      return m;
    }
    m.userData.manual = false;

    const phys = this.game.physics;
    if (phys?.spawnShell) {
      try {
        const body = phys.spawnShell({
          object: m,
          position: pos.clone(),
          velocity: vel.clone(),
          angularVelocity: new THREE.Vector3(
            (Math.random() - 0.5) * 46, (Math.random() - 0.5) * 46, (Math.random() - 0.5) * 46,
          ),
          size: { x: 0.0095, y: 0.0095, z: 0.045 },
          lifetime: opts.lifetime ?? 12,
        });
        if (body) { this.bodies.set(m, body); return m; }
      } catch (err) { /* fall through to the local integrator */ }
    }
    // physics unavailable: integrate it ourselves so brass still flies
    m.userData.manual = false;
    m.userData.vel = vel.clone();
    m.userData.spin = new THREE.Vector3(
      (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30,
    );
    m.userData.life = 4;
    this._manual.push(m);
    m.userData.local = true;
    return m;
  }

  update(dt) {
    for (let i = this._manual.length - 1; i >= 0; i--) {
      const m = this._manual[i];
      if (!m.userData.local) continue;   // frozen capture shells: leave them be
      const u = m.userData;
      u.life -= dt;
      if (u.life <= 0) { m.visible = false; this._manual.splice(i, 1); continue; }
      u.vel.y -= 18.5 * dt;
      m.position.addScaledVector(u.vel, dt);
      m.rotateX(u.spin.x * dt);
      m.rotateY(u.spin.y * dt);
      m.rotateZ(u.spin.z * dt);
    }
  }

  /**
   * Turn frozen capture brass back into falling brass when the freeze ends,
   * so a posed screenshot does not leave cases hanging in mid-air.
   */
  releaseManual() {
    for (const m of this._manual) {
      if (m.userData.local) continue;
      m.userData.local = true;
      m.userData.vel = new THREE.Vector3(0, -0.6, 0);
      m.userData.spin = new THREE.Vector3(
        (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20,
      );
      m.userData.life = 1.6;
    }
  }

  clear() {
    for (const m of this.pool) {
      m.visible = false;
      const b = this.bodies.get(m);
      if (b) { try { this.game.physics?.removeBody?.(b); } catch { /* already gone */ } }
    }
    this.bodies.clear();
    this._manual.length = 0;
  }

  dispose() {
    this.clear();
    for (const m of this.pool) m.parent?.remove(m);
    this.geometry.dispose();
  }
}

/* ==================================================================== */
/* fallback tracers                                                      */
/* ==================================================================== */

/**
 * Used only when `game.vfx` publishes no tracer API. Keeps the combat frame
 * complete rather than depending on another module landing first.
 */
export class TracerFallback {
  constructor(scene, count = 24) {
    this.scene = scene;
    this.items = [];
    this._next = 0;
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0, 0.5, 0);   // pivot at the tail so scale.y is the length
    this.geometry = geo;
    this.material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(3.4, 2.1, 0.9),
      transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: true,
    });
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(geo, this.material.clone());
      m.visible = false;
      m.frustumCulled = false;
      m.renderOrder = 8;
      scene?.add(m);
      this.items.push(m);
    }
    this._dir = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  spawn(from, to, cfg = {}) {
    const m = this.items[this._next];
    this._next = (this._next + 1) % this.items.length;
    this._dir.copy(to).sub(from);
    const len = this._dir.length();
    if (len < 0.05) return;
    this._dir.multiplyScalar(1 / len);
    m.position.copy(from);
    this._q.setFromUnitVectors(this._up, this._dir);
    m.quaternion.copy(this._q);
    if (!m.userData.from) m.userData.from = new THREE.Vector3();
    m.userData.from.copy(from);
    m.userData.axis = (m.userData.axis || new THREE.Vector3()).copy(this._dir);
    m.userData.len = len;
    m.userData.speed = cfg.speed ?? 780;
    m.userData.t = 0;
    m.userData.width = cfg.width ?? 0.028;
    m.userData.trail = Math.min(len, 9 + len * 0.12);
    if (cfg.color !== undefined) m.material.color.set(cfg.color).multiplyScalar(cfg.intensity ?? 3.0);
    m.visible = true;
    m.scale.set(m.userData.width, 0.01, 1);
  }

  update(dt, camera) {
    for (const m of this.items) {
      if (!m.visible) continue;
      const u = m.userData;
      u.t += dt;
      const head = u.t * u.speed;
      if (head - u.trail > u.len) { m.visible = false; continue; }
      const tail = Math.max(0, head - u.trail);
      const shown = Math.min(head, u.len) - tail;
      if (shown <= 0) { m.visible = false; continue; }
      m.scale.set(u.width, shown, 1);
      // the quad's pivot is at its tail, so sliding it along the flight axis
      // is all that is needed to make the round travel
      m.position.copy(u.from).addScaledVector(u.axis, tail);
      m.material.opacity = Math.min(1, 1 - (tail / Math.max(1e-3, u.len)) * 0.6);
    }
  }

  dispose() {
    for (const m of this.items) { m.material.dispose(); m.parent?.remove(m); }
    this.geometry.dispose();
    this.material.dispose();
  }
}
