import * as THREE from 'three';
import { Rng, Pool, V, Q, clamp, smoothstep, TAU } from './Util.js';

/**
 * Muzzle flash.
 *
 * Not a billboard: each rig is a real star of tapered ribbons plus a flared
 * gas cone and a concussion ring, all in scene-referred HDR so the bloom
 * pyramid does the blowout for us. Over the ~55 ms it lives it plays a
 * two-stage curve — the primary detonation, then the unburnt propellant
 * igniting outside the barrel — with a camera-facing glow card on top and a
 * pooled PointLight (owned by VFX) throwing real light on the walls.
 *
 * Four geometry variants are baked at boot and picked at random per shot so
 * consecutive shots never stamp the identical shape.
 */

function buildFlashGeometry(rng, { blades = 6, length = 1, spread = 0.42 } = {}) {
  const pos = [];
  const col = [];
  const SEG = 7;

  const push = (p, c) => {
    pos.push(p.x, p.y, p.z);
    col.push(c.x, c.y, c.z);
  };

  const d = new THREE.Vector3();
  const planeN = new THREE.Vector3();
  const wAxis = new THREE.Vector3();
  const Z = new THREE.Vector3(0, 0, 1);
  const radial = new THREE.Vector3();
  const a0 = new THREE.Vector3(), a1 = new THREE.Vector3();
  const b0 = new THREE.Vector3(), b1 = new THREE.Vector3();
  const cA = new THREE.Vector3(), cB = new THREE.Vector3();

  const hot = new THREE.Vector3(1.0, 0.94, 0.80);
  const mid = new THREE.Vector3(1.0, 0.58, 0.18);
  const tip = new THREE.Vector3(0.55, 0.14, 0.02);

  const bladeColor = (s, out) => {
    // Base is near-white, the body is sodium orange, the tip falls off to black
    // so the additive ribbon has no hard edge.
    const fade = Math.pow(1 - s, 1.35);
    if (s < 0.35) out.copy(hot).lerp(mid, s / 0.35);
    else out.copy(mid).lerp(tip, (s - 0.35) / 0.65);
    out.multiplyScalar(fade * (0.85 + 0.3 * (1 - s)));
    return out;
  };

  for (let i = 0; i < blades; i++) {
    const theta = (i / blades) * TAU + rng.gauss() * 0.22;
    const tilt = spread * (0.35 + rng.float() * 1.1);
    const L = length * (0.55 + rng.float() * 0.85);
    const W = length * (0.10 + rng.float() * 0.12);
    const curl = rng.gauss() * 0.5;

    radial.set(Math.cos(theta), Math.sin(theta), 0);
    d.copy(Z).multiplyScalar(Math.cos(tilt)).addScaledVector(radial, Math.sin(tilt)).normalize();
    planeN.crossVectors(Z, radial);
    if (planeN.lengthSq() < 1e-8) planeN.set(0, 1, 0);
    planeN.normalize();
    wAxis.crossVectors(planeN, d).normalize();

    for (let s = 0; s < SEG; s++) {
      const s0 = s / SEG, s1 = (s + 1) / SEG;
      const w0 = W * Math.pow(1 - s0, 0.55) * (0.35 + 0.65 * Math.sin(Math.min(1, s0 * 3.2) * Math.PI * 0.5));
      const w1 = W * Math.pow(1 - s1, 0.55) * (0.35 + 0.65 * Math.sin(Math.min(1, s1 * 3.2) * Math.PI * 0.5));
      const c0 = L * s0, c1 = L * s1;
      // slight banana curl so blades are not dead straight
      a0.copy(d).multiplyScalar(c0).addScaledVector(radial, curl * c0 * c0 * 0.35);
      a1.copy(d).multiplyScalar(c1).addScaledVector(radial, curl * c1 * c1 * 0.35);
      b0.copy(a0).addScaledVector(wAxis, w0 * 0.5);
      b1.copy(a0).addScaledVector(wAxis, -w0 * 0.5);
      const b2 = V.a.copy(a1).addScaledVector(wAxis, w1 * 0.5);
      const b3 = V.b.copy(a1).addScaledVector(wAxis, -w1 * 0.5);
      bladeColor(s0, cA);
      bladeColor(s1, cB);
      push(b0, cA); push(b1, cA); push(b2, cB);
      push(b1, cA); push(b3, cB); push(b2, cB);
    }
  }

  // Gas cone: a stubby flared funnel right at the crown.
  {
    const R = length * 0.30, L = length * 0.42;
    const N = 16;
    const apex = new THREE.Vector3(0, 0, -length * 0.04);
    const cApex = new THREE.Vector3(1.0, 0.92, 0.78).multiplyScalar(1.0);
    const cRim = new THREE.Vector3(0.9, 0.32, 0.06).multiplyScalar(0.28);
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU, b = ((i + 1) / N) * TAU;
      const p1 = V.a.set(Math.cos(a) * R, Math.sin(a) * R, L);
      const p2 = V.b.set(Math.cos(b) * R, Math.sin(b) * R, L);
      push(apex, cApex); push(p1, cRim); push(p2, cRim);
    }
  }

  // Concussion ring: flat annulus at the crown, sells brakes and compensators.
  {
    const R0 = length * 0.16, R1 = length * 0.52;
    const N = 24;
    const cIn = new THREE.Vector3(1.0, 0.80, 0.52).multiplyScalar(0.85);
    const cOut = new THREE.Vector3(0.8, 0.25, 0.05).multiplyScalar(0.0);
    const z = length * 0.03;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU, b = ((i + 1) / N) * TAU;
      const wob0 = 1 + rng.gauss() * 0.10, wob1 = 1 + rng.gauss() * 0.10;
      const i0 = V.a.set(Math.cos(a) * R0, Math.sin(a) * R0, z);
      const i1 = V.b.set(Math.cos(b) * R0, Math.sin(b) * R0, z);
      const o0 = V.c.set(Math.cos(a) * R1 * wob0, Math.sin(a) * R1 * wob0, z);
      const o1 = V.d.set(Math.cos(b) * R1 * wob1, Math.sin(b) * R1 * wob1, z);
      push(i0, cIn); push(o0, cOut); push(o1, cOut);
      push(i0, cIn); push(o1, cOut); push(i1, cIn);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return geo;
}

export class MuzzleFlash {
  constructor(game, { glowTexture, count = 5 } = {}) {
    this.game = game;
    this.time = 0;
    this.variants = [];
    const rng = new Rng(3571);
    for (let i = 0; i < 4; i++) {
      this.variants.push(buildFlashGeometry(rng, {
        blades: 5 + (i % 3), length: 1, spread: 0.34 + i * 0.06,
      }));
    }

    this.flareGeometry = new THREE.PlaneGeometry(1, 1);
    this.glowTexture = glowTexture;

    this.pool = new Pool(count, () => {
      const petalMat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        fog: false,
        toneMapped: false,
      });
      const petals = new THREE.Mesh(this.variants[0], petalMat);
      // Baked geometry with a real bounding sphere, so this culls normally.
      petals.frustumCulled = true;
      petals.castShadow = petals.receiveShadow = false;
      petals.visible = false;
      petals.renderOrder = 18;
      petals.userData.postfxIgnore = true;

      const flareMat = new THREE.MeshBasicMaterial({
        map: glowTexture || null,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        fog: false,
        toneMapped: false,
      });
      const flare = new THREE.Mesh(this.flareGeometry, flareMat);
      flare.frustumCulled = true;
      flare.castShadow = flare.receiveShadow = false;
      flare.visible = false;
      flare.renderOrder = 19;
      flare.userData.postfxIgnore = true;

      return {
        petals, flare, petalMat, flareMat,
        alive: false, age: 0, life: 0.055, scale: 1, viewmodel: false,
        roll: 0, hue: new THREE.Vector3(1, 0.86, 0.62), index: -1,
      };
    });
    this.pool.forEach((r, i) => { r.index = i; });
  }

  /**
   * @param {Object} o
   *  position  THREE.Vector3 world (or viewmodel-space) muzzle point
   *  direction THREE.Vector3 barrel axis
   *  scale     metres; 0.28 is a rifle, 0.5 a shotgun, 0.16 a pistol
   *  viewmodel put it in the first-person pass rather than the world
   *  intensity brightness multiplier
   *  color     {r,g,b} tint (suppressed weapons run cooler and redder)
   */
  fire(o = {}) {
    const rig = this.pool.acquire();
    if (!rig) return null;
    const scene = o.viewmodel ? this.game.engine?.viewScene : this.game.scene;
    if (!scene) return null;

    if (rig.petals.parent !== scene) { scene.add(rig.petals); scene.add(rig.flare); }

    const geo = this.variants[(Math.random() * this.variants.length) | 0];
    rig.petals.geometry = geo;

    const dir = V.a.copy(o.direction || FORWARD);
    if (dir.lengthSq() < 1e-8) dir.set(0, 0, -1); else dir.normalize();
    Q.a.setFromUnitVectors(FORWARD_Z, dir);
    rig.roll = Math.random() * TAU;
    Q.b.setFromAxisAngle(FORWARD_Z, rig.roll);
    Q.a.multiply(Q.b);

    rig.petals.position.copy(o.position || ORIGIN);
    rig.petals.quaternion.copy(Q.a);
    rig.flare.position.copy(rig.petals.position).addScaledVector(dir, (o.scale ?? 0.28) * 0.22);

    rig.alive = true;
    rig.age = 0;
    rig.life = o.life ?? 0.058;
    rig.scale = (o.scale ?? 0.28) * (0.86 + Math.random() * 0.3);
    rig.viewmodel = !!o.viewmodel;
    rig.intensity = (o.intensity ?? 1) * 9;
    const c = o.color;
    rig.hue.set(c ? c.r ?? 1 : 1, c ? c.g ?? 0.86 : 0.86, c ? c.b ?? 0.62 : 0.62);
    rig.petals.visible = true;
    rig.flare.visible = true;
    rig.petals.scale.setScalar(rig.scale * 0.5);
    this._apply(rig, 0);
    return rig;
  }

  _apply(rig, t) {
    // Two-stage brightness: hard detonation spike, then the gas flare.
    const decay = Math.exp(-t * 7.0);
    const secondary = 0.42 * Math.exp(-Math.pow((t - 0.36) / 0.17, 2));
    const I = rig.intensity * clamp(decay + secondary, 0, 2);

    const grow = 0.62 + 0.38 * smoothstep(t / 0.22);
    const stretch = 1 + t * 0.55;
    rig.petals.scale.set(rig.scale * grow, rig.scale * grow, rig.scale * grow * stretch);
    rig.petalMat.color.setRGB(rig.hue.x * I, rig.hue.y * I, rig.hue.z * I);

    const fI = I * (1 - t * 0.35) * 0.55;
    const fs = rig.scale * (1.6 + t * 2.6);
    rig.flare.scale.set(fs, fs, 1);
    rig.flareMat.color.setRGB(rig.hue.x * fI, rig.hue.y * fI * 0.96, rig.hue.z * fI * 0.9);
  }

  update(dt, camera, viewCamera) {
    this.time += dt;
    this.pool.forEach((rig, i, active) => {
      if (!rig.alive) return;
      rig.age += dt;
      const t = rig.age / rig.life;
      if (t >= 1) {
        rig.alive = false;
        rig.petals.visible = false;
        rig.flare.visible = false;
        this.pool.releaseIndex(i);
        return;
      }
      this._apply(rig, t);
      const cam = rig.viewmodel ? viewCamera : camera;
      if (cam) {
        rig.flare.quaternion.copy(cam.quaternion);
        rig.flare.rotateZ(rig.roll + this.time * 0.4);
      }
    });
  }

  clear() {
    this.pool.forEach((rig, i) => {
      rig.alive = false;
      rig.petals.visible = false;
      rig.flare.visible = false;
      this.pool.releaseIndex(i);
    });
  }

  dispose() {
    this.pool.forEach((rig) => {
      rig.petals.parent?.remove(rig.petals);
      rig.flare.parent?.remove(rig.flare);
      rig.petalMat.dispose();
      rig.flareMat.dispose();
    });
    for (const g of this.variants) g.dispose();
    this.flareGeometry.dispose();
  }
}

const FORWARD = /* @__PURE__ */ new THREE.Vector3(0, 0, -1);
const FORWARD_Z = /* @__PURE__ */ new THREE.Vector3(0, 0, 1);
const ORIGIN = /* @__PURE__ */ new THREE.Vector3();
