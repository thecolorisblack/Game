import * as THREE from 'three';
import { P } from './Profiles.js';
import { Rng, V, coneDirection, clamp, lodScale, TAU } from './Util.js';

/**
 * Persistent smoke: the distant burning columns that give a skyline depth, and
 * on-demand smoke screens (grenades, burning wrecks, lingering firefight haze).
 *
 * These emit into a dedicated long-life layer so a smoke grenade can never
 * starve the transient impact budget, and they throttle themselves by distance
 * and view direction — a column 300 m behind you costs nothing.
 */
export class SmokeSystem {
  constructor(vfx, layer) {
    this.vfx = vfx;
    this.game = vfx.game;
    this.layer = layer;
    this.time = 0;
    this.columns = [];
    this.emitters = [];
    this.rng = new Rng(20260726);
    this.enabled = true;
  }

  /**
   * Scatter a few burning columns around the level. Called once, after the
   * world exists so the ground probe has something to hit.
   */
  placeColumns(count = 4, { minDist = 110, maxDist = 300 } = {}) {
    const phys = this.game?.physics;
    const origin = this.game?.camera?.position || ZERO;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU + this.rng.range(-0.5, 0.5);
      const d = this.rng.range(minDist, maxDist);
      const x = origin.x + Math.cos(a) * d;
      const z = origin.z + Math.sin(a) * d;
      let y = 0;
      if (phys?.raycast) {
        try {
          PROBE.set(x, origin.y + 180, z);
          const hit = phys.raycast(PROBE, DOWN, 400);
          if (hit) y = hit.point.y;
        } catch (e) { /* world not built yet */ }
      }
      this.columns.push({
        position: new THREE.Vector3(x, y + 1.5, z),
        radius: this.rng.range(2.2, 4.5),
        rate: this.rng.range(0.40, 0.70),
        rise: this.rng.range(2.2, 4.2),
        life: this.rng.range(12, 18),
        tint: this.rng.range(0.75, 1.15),
        accum: this.rng.float() * 2,
      });
    }
    return this.columns;
  }

  /**
   * A deployed smoke screen.
   * @param {THREE.Vector3} position
   * @param {Object} o {radius, duration, rate, rise, color, dense}
   */
  screen(position, o = {}) {
    const e = {
      position: position.clone(),
      radius: o.radius ?? 3.5,
      duration: o.duration ?? 14,
      age: 0,
      rate: o.rate ?? 14,
      rise: o.rise ?? 1.1,
      life: o.life ?? 9,
      accum: 0,
      r: o.color?.r ?? 1, g: o.color?.g ?? 1, b: o.color?.b ?? 1,
      profile: o.profile ?? P.SMOKE_LIGHT,
      spread: o.spread ?? 1.2,
    };
    this.emitters.push(e);
    return e;
  }

  /** A short, dense wisp — weapon muzzles, hot barrels, burning debris. */
  wisp(position, direction, { count = 2, scale = 1, profile = P.SMOKE_DARK, alpha = 0.5 } = {}) {
    const layer = this.layer;
    if (!layer) return;
    const dir = V.a.copy(direction || UP).normalize();
    for (let i = 0; i < count; i++) {
      coneDirection(dir, 0.9, V.b, Math.random, 1.2);
      const sp = 0.4 + Math.random() * 1.1;
      const s0 = 0.05 * scale;
      layer.spawn(
        position.x, position.y, position.z,
        V.b.x * sp, V.b.y * sp + 0.35, V.b.z * sp,
        1.4 + Math.random() * 2.2,
        s0, s0 * (5 + Math.random() * 5), Math.random() * TAU, (Math.random() - 0.5) * 0.7,
        1.5, -0.05, 0,
        1, 1, 1, alpha, profile, 0, 63, 1.6, Math.random(),
      );
    }
  }

  update(dt) {
    if (!this.enabled || !this.layer) return;
    this.time += dt;
    const cam = this.game?.camera;

    for (let i = 0; i < this.columns.length; i++) {
      const c = this.columns[i];
      const lod = lodScale(cam, c.position, 60, 340);
      if (lod < 0.26) { c.accum = 0; continue; }
      c.accum += dt * c.rate * lod;
      while (c.accum >= 1) {
        c.accum -= 1;
        this._columnPuff(c);
      }
    }

    for (let i = this.emitters.length - 1; i >= 0; i--) {
      const e = this.emitters[i];
      e.age += dt;
      if (e.age > e.duration) { this.emitters.splice(i, 1); continue; }
      const ramp = Math.min(1, e.age / 0.8) * (1 - Math.max(0, (e.age - (e.duration - 2.5)) / 2.5));
      e.accum += dt * e.rate * Math.max(0, ramp) * this.vfx.quality;
      while (e.accum >= 1) {
        e.accum -= 1;
        this._screenPuff(e);
      }
    }
  }

  _columnPuff(c) {
    const a = Math.random() * TAU;
    const r = Math.sqrt(Math.random()) * c.radius;
    const px = c.position.x + Math.cos(a) * r;
    const pz = c.position.z + Math.sin(a) * r;
    const rise = c.rise * (0.7 + Math.random() * 0.6);
    const s0 = c.radius * (0.7 + Math.random() * 0.6);
    this.layer.spawn(
      px, c.position.y, pz,
      (Math.random() - 0.5) * 1.4 + 0.6, rise, (Math.random() - 0.5) * 1.4 + 0.3,
      c.life * (0.75 + Math.random() * 0.5),
      s0, s0 * (3.0 + Math.random() * 2), Math.random() * TAU, (Math.random() - 0.5) * 0.14,
      0.16, -0.03, 0,
      c.tint, c.tint * 0.98, c.tint * 0.95, 0.5,
      P.SMOKE_DARK, 0, 63, 6.0, Math.random(),
    );
  }

  _screenPuff(e) {
    const a = Math.random() * TAU;
    const r = Math.sqrt(Math.random()) * e.radius;
    const px = e.position.x + Math.cos(a) * r;
    const pz = e.position.z + Math.sin(a) * r;
    const py = e.position.y + Math.random() * e.radius * 0.5;
    const s0 = e.radius * (0.25 + Math.random() * 0.25);
    coneDirection(UP, e.spread, V.a, Math.random, 0.9);
    const sp = 0.5 + Math.random() * 1.4;
    this.layer.spawn(
      px, py, pz,
      V.a.x * sp, e.rise + V.a.y * sp * 0.5, V.a.z * sp,
      e.life * (0.7 + Math.random() * 0.6),
      s0, s0 * (2.6 + Math.random() * 2.0), Math.random() * TAU, (Math.random() - 0.5) * 0.5,
      0.5, -0.02, 0,
      e.r, e.g, e.b, 0.9, e.profile, 0, 63, 2.4, Math.random(),
    );
  }

  clear() {
    this.emitters.length = 0;
    for (const c of this.columns) c.accum = 0;
  }
}

const UP = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);
const DOWN = /* @__PURE__ */ new THREE.Vector3(0, -1, 0);
const ZERO = /* @__PURE__ */ new THREE.Vector3();
const PROBE = /* @__PURE__ */ new THREE.Vector3();
