import * as THREE from 'three';
import { P } from './Profiles.js';
import { DECAL } from './Textures.js';
import { V, coneDirection, reflectScatter, perpendicular, lodScale, clamp, TAU } from './Util.js';

/**
 * Surface-driven impact effects.
 *
 * One `bullet:impact` fans out into six or seven simultaneous systems — a
 * sub-millisecond flash, a puff whose colour comes from the material, solid
 * fragments that tumble and fall, sparks that stretch along their velocity,
 * a projected hole that dents the wall, and for metal a real light. The exact
 * mix per surface id is the whole point: concrete must powder, metal must
 * spark and ring, wood must splinter, sand must plume, glass must fall.
 */

const _n = new THREE.Vector3();
const _d = new THREE.Vector3();
const _r = new THREE.Vector3();
const _t = new THREE.Vector3();
const _b = new THREE.Vector3();
const _p = new THREE.Vector3();
const _v = new THREE.Vector3();

const rand = Math.random;
const rr = (a, b) => a + (b - a) * rand();

export class ImpactFX {
  constructor(vfx) {
    this.vfx = vfx;
    this.game = vfx.game;
    this._decalToggle = 0;
  }

  /**
   * @param {Object} o {point, normal, surface, dir, scale, object}
   */
  spawn(o) {
    if (!o?.point) return;
    const L = this.vfx.layers;
    if (!L) return;

    _n.copy(o.normal || UP);
    if (_n.lengthSq() < 1e-8) _n.set(0, 1, 0); else _n.normalize();
    _d.copy(o.dir || _n).normalize().negate();          // outgoing-ish
    if (o.dir) reflectScatter(o.dir, _n, 0.22, _r);
    else _r.copy(_n);

    const surface = (o.surface || 'concrete').toLowerCase();
    const lod = lodScale(this.game.camera, o.point, 14, 110);
    const scale = (o.scale ?? 1) * this.vfx.quality;
    const q = lod * scale;

    switch (surface) {
      case 'metal': this.metal(o.point, _n, _r, q); break;
      case 'wood': this.wood(o.point, _n, _r, q); break;
      case 'sand': this.granular(o.point, _n, _r, q, 1); break;
      case 'dirt': this.granular(o.point, _n, _r, q, 0); break;
      case 'glass': this.glass(o.point, _n, _r, q); break;
      case 'water': this.water(o.point, _n, _r, q); break;
      case 'flesh': this.flesh(o.point, _n, o.dir, q); break;
      case 'fabric': this.fabric(o.point, _n, _r, q); break;
      case 'foliage': this.foliage(o.point, _n, _r, q); break;
      default: this.concrete(o.point, _n, _r, q); break;
    }
  }

  /* ---------------------------------------------------------------- shared */

  /** The sub-frame white pop every impact starts with. */
  flash(point, normal, size, intensity = 1) {
    const L = this.vfx.layers;
    if (!L.spark) return;
    const p = _p.copy(point).addScaledVector(normal, size * 0.35);
    L.spark.spawn(
      p.x, p.y, p.z, normal.x * 0.4, normal.y * 0.4, normal.z * 0.4, 0.055,
      size, size * 2.4, rand() * TAU, 0, 0, 0, 0,
      intensity, intensity * 0.92, intensity * 0.8, 1, P.FLASH, 7, 0, 0.4, rand(),
    );
  }

  /**
   * Puff of powdered material. `spread` biases the cone: 0 hugs the surface
   * normal, 1 sprays into a hemisphere.
   */
  puff(layer, point, normal, count, o = {}) {
    if (!layer || count <= 0) return;
    const profile = o.profile ?? P.DUST_CONCRETE;
    const frames = o.frames ?? 15;
    const soft = o.soft ?? 0.85;
    for (let i = 0; i < count; i++) {
      coneDirection(normal, o.spread ?? 0.9, _v, rand, o.bias ?? 1.1);
      const speed = rr(o.speed0 ?? 0.6, o.speed1 ?? 2.4);
      const p = _p.copy(point).addScaledVector(normal, rr(0.01, 0.06))
        .addScaledVector(_v, rr(0, 0.05));
      const s0 = rr(o.size0 ?? 0.05, (o.size0 ?? 0.05) * 2.1);
      const s1 = s0 * rr(o.growth0 ?? 4, o.growth1 ?? 8);
      layer.spawn(
        p.x, p.y, p.z, _v.x * speed, _v.y * speed, _v.z * speed,
        rr(o.life0 ?? 0.7, o.life1 ?? 1.5),
        s0, s1, rand() * TAU, (rand() - 0.5) * (o.spin ?? 1.4),
        o.drag ?? 3.0, o.gravity ?? 0.12, 0,
        o.r ?? 1, o.g ?? 1, o.b ?? 1, o.alpha ?? 1,
        // Flipbooks play from frame 0: the animation *is* the puff's life.
        profile, o.frame0 ?? 0, frames, soft, rand(),
      );
    }
  }

  /** Solid fragments: chips, splinters, shards, leaves. */
  fragments(point, normal, refl, count, o = {}) {
    const layer = this.vfx.layers.chip;
    if (!layer || count <= 0) return;
    const tile0 = o.tile0 ?? 0, tileN = o.tileN ?? 6;
    for (let i = 0; i < count; i++) {
      coneDirection(refl, o.spread ?? 0.75, _v, rand, 1.0);
      const speed = rr(o.speed0 ?? 2.5, o.speed1 ?? 8);
      const p = _p.copy(point).addScaledVector(normal, 0.02);
      const s = rr(o.size0 ?? 0.016, o.size1 ?? 0.05);
      layer.spawn(
        p.x, p.y, p.z, _v.x * speed, _v.y * speed, _v.z * speed,
        rr(o.life0 ?? 0.8, o.life1 ?? 1.8),
        s, s * (o.shrink ?? 0.9), rand() * TAU, (rand() - 0.5) * (o.spin ?? 26),
        o.drag ?? 0.35, o.gravity ?? 1.0, 0,
        o.r ?? 1, o.g ?? 1, o.b ?? 1, 1,
        o.profile ?? P.CHIP, tile0 + ((rand() * tileN) | 0), 0, 0.2, rand(),
      );
    }
  }

  /** Sparks: additive, velocity-stretched, gravity-bound, bouncing off nothing. */
  sparks(point, normal, refl, count, o = {}) {
    const layer = this.vfx.layers.spark;
    if (!layer || count <= 0) return;
    for (let i = 0; i < count; i++) {
      coneDirection(refl, o.spread ?? 0.8, _v, rand, o.bias ?? 1.6);
      const speed = rr(o.speed0 ?? 3.5, o.speed1 ?? 12);
      const p = _p.copy(point).addScaledVector(normal, 0.015);
      const s = rr(o.size0 ?? 0.010, o.size1 ?? 0.022);
      layer.spawn(
        p.x, p.y, p.z, _v.x * speed, _v.y * speed, _v.z * speed,
        rr(o.life0 ?? 0.28, o.life1 ?? 0.85),
        s, s * 0.55, 0, 0,
        o.drag ?? 0.9, o.gravity ?? 0.85, o.stretch ?? 0.055,
        o.r ?? 1, o.g ?? 1, o.b ?? 1, 1,
        o.profile ?? P.SPARK, o.tile ?? ((rand() * 4) | 0), 0, 0.25, rand(),
      );
    }
  }

  decal(point, normal, tile, size, opts = {}) {
    this.vfx.decals?.spawn({
      point, normal, tile, size,
      depth: opts.depth ?? size * 0.9,
      life: opts.life ?? 55,
      opacity: opts.opacity ?? 1,
      color: opts.color,
      dir: opts.dir,
      grow: opts.grow,
      fadeIn: opts.fadeIn,
    });
  }

  /* --------------------------------------------------------------- recipes */

  concrete(point, n, refl, q) {
    this.flash(point, n, 0.05 * q, 0.9);
    this.puff(this.vfx.layers.dust, point, n, Math.round(5 * q) + 1, {
      profile: P.DUST_CONCRETE, spread: 0.85, speed0: 0.7, speed1: 2.8,
      size0: 0.05, growth0: 5, growth1: 9, life0: 0.8, life1: 1.7,
      drag: 3.2, gravity: 0.10, spin: 1.2,
    });
    // A second, wider puff that hugs the wall and drifts sideways: the halo
    // that makes concrete impacts read at distance.
    perpendicular(n, _t);
    _b.crossVectors(n, _t);
    const ring = Math.round(3 * q);
    for (let i = 0; i < ring; i++) {
      const a = (i / Math.max(1, ring)) * TAU + rand() * 0.9;
      _v.copy(_t).multiplyScalar(Math.cos(a)).addScaledVector(_b, Math.sin(a))
        .addScaledVector(n, 0.35).normalize();
      const sp = rr(0.9, 2.1);
      const p = _p.copy(point).addScaledVector(n, 0.02);
      this.vfx.layers.dust?.spawn(
        p.x, p.y, p.z, _v.x * sp, _v.y * sp, _v.z * sp, rr(0.9, 1.8),
        0.07, 0.44, rand() * TAU, (rand() - 0.5) * 1.1, 3.6, 0.05, 0,
        1, 1, 1, 0.75, P.DUST_CONCRETE, (rand() * 16) | 0, 15, 0.9, rand(),
      );
    }
    this.fragments(point, n, refl, Math.round(7 * q) + 2, {
      tile0: 0, tileN: 6, speed0: 2.2, speed1: 7.5, size0: 0.014, size1: 0.042,
      r: 0.95, g: 0.93, b: 0.9,
    });
    this.sparks(point, n, refl, Math.round(2 * q), {
      speed0: 2, speed1: 6, life0: 0.12, life1: 0.3, size0: 0.006, size1: 0.012,
      r: 0.8, g: 0.6, b: 0.4,
    });
    this.decal(point, n, this._decalToggle++ & 1 ? DECAL.HOLE_CONCRETE : DECAL.HOLE_CONCRETE_B,
      rr(0.16, 0.24), { life: 60 });
  }

  metal(point, n, refl, q) {
    this.flash(point, n, 0.06 * q, 1.6);
    this.sparks(point, n, refl, Math.round(16 * q) + 4, {
      spread: 0.85, speed0: 4, speed1: 14, life0: 0.3, life1: 0.9,
      size0: 0.009, size1: 0.02, stretch: 0.07, gravity: 0.9, drag: 0.7,
    });
    // Ricochet trail: a few fast, long-lived sparks that keep going along the
    // reflected vector and break into beads (atlas tile 2).
    this.sparks(point, n, refl, Math.round(4 * q) + 1, {
      spread: 0.18, speed0: 13, speed1: 26, life0: 0.5, life1: 1.1,
      size0: 0.011, size1: 0.02, stretch: 0.10, gravity: 0.6, drag: 0.35, tile: 2,
    });
    this.puff(this.vfx.layers.smoke, point, n, Math.round(1.5 * q), {
      profile: P.SMOKE_DARK, frames: 63, spread: 0.8, speed0: 0.5, speed1: 1.4,
      size0: 0.04, growth0: 4, growth1: 7, life0: 0.7, life1: 1.3, drag: 3.0,
      gravity: -0.06, alpha: 0.55,
    });
    this.fragments(point, n, refl, Math.round(2 * q), {
      tile0: 0, tileN: 6, speed0: 3, speed1: 8, size0: 0.008, size1: 0.02,
      r: 0.8, g: 0.82, b: 0.86,
    });
    this.vfx.lights?.flash(point, 2.6 * q + 0.6, 0.1, HOT_METAL, 2, 5.5);
    this.decal(point, n, rand() < 0.5 ? DECAL.HOLE_METAL : DECAL.HOLE_METAL_B,
      rr(0.09, 0.14), { life: 70 });
  }

  wood(point, n, refl, q) {
    this.flash(point, n, 0.045 * q, 0.7);
    this.fragments(point, n, refl, Math.round(9 * q) + 3, {
      tile0: 6, tileN: 4, speed0: 2.5, speed1: 8.5, size0: 0.018, size1: 0.06,
      spin: 34, life0: 1.0, life1: 2.2, r: 1, g: 0.92, b: 0.8,
    });
    this.puff(this.vfx.layers.dust, point, n, Math.round(3 * q) + 1, {
      profile: P.DUST_CONCRETE, spread: 0.8, speed0: 0.5, speed1: 2.0,
      size0: 0.045, growth0: 4, growth1: 7, life0: 0.6, life1: 1.2,
      r: 0.86, g: 0.68, b: 0.44, alpha: 0.8,
    });
    this.decal(point, n, DECAL.HOLE_WOOD, rr(0.14, 0.2), { life: 60 });
  }

  granular(point, n, refl, q, sandy) {
    this.puff(this.vfx.layers.dust, point, n, Math.round(7 * q) + 2, {
      profile: sandy ? P.DUST_SAND : P.DUST_CONCRETE,
      spread: 0.55, bias: 1.5, speed0: 1.2, speed1: 3.6,
      size0: 0.08, growth0: 6, growth1: 11, life0: 1.1, life1: 2.4,
      drag: 2.2, gravity: 0.35, spin: 0.9,
      r: sandy ? 1 : 0.72, g: sandy ? 1 : 0.66, b: sandy ? 1 : 0.58,
    });
    this.puff(this.vfx.layers.smoke, point, n, Math.round(2 * q), {
      profile: sandy ? P.DUST_SAND : P.SMOKE_LIGHT, frames: 63,
      spread: 0.75, speed0: 0.4, speed1: 1.4, size0: 0.12, growth0: 5, growth1: 9,
      life0: 1.6, life1: 3.2, drag: 1.6, gravity: 0.12, alpha: 0.55,
    });
    this.fragments(point, n, refl, Math.round(6 * q) + 2, {
      tile0: 0, tileN: 6, speed0: 2, speed1: 6.5, size0: 0.008, size1: 0.022,
      gravity: 1.2, drag: 0.9, life0: 0.6, life1: 1.1,
      r: sandy ? 1.05 : 0.6, g: sandy ? 0.88 : 0.5, b: sandy ? 0.6 : 0.4,
    });
    this.decal(point, n, DECAL.HOLE_SAND, rr(0.24, 0.36), { life: 40, opacity: 0.85 });
  }

  glass(point, n, refl, q) {
    this.flash(point, n, 0.05 * q, 1.2);
    this.fragments(point, n, refl, Math.round(12 * q) + 4, {
      tile0: 10, tileN: 3, speed0: 1.5, speed1: 6, size0: 0.014, size1: 0.05,
      spin: 20, gravity: 1.15, drag: 0.12, life0: 1.4, life1: 2.6,
      profile: P.GLASS, r: 1, g: 1, b: 1,
    });
    this.sparks(point, n, refl, Math.round(6 * q) + 2, {
      profile: P.SPARK_COOL, spread: 1.0, speed0: 2, speed1: 7,
      life0: 0.25, life1: 0.6, size0: 0.008, size1: 0.016, stretch: 0.03,
      tile: 4 + ((rand() * 3) | 0), r: 0.8, g: 0.95, b: 1.1,
    });
    this.puff(this.vfx.layers.dust, point, n, Math.round(1.5 * q), {
      profile: P.SMOKE_LIGHT, spread: 0.9, speed0: 0.4, speed1: 1.4,
      size0: 0.05, growth0: 3, growth1: 6, life0: 0.5, life1: 1.0, alpha: 0.4,
    });
    this.decal(point, n, rand() < 0.6 ? DECAL.GLASS_CRACK : DECAL.GLASS_HOLE,
      rr(0.3, 0.55), { life: 90, opacity: 0.9 });
  }

  water(point, n, refl, q) {
    // Vertical column: fast, narrow, gravity-bound, growing as it climbs.
    const up = _t.set(0, 1, 0);
    for (let i = 0; i < Math.round(5 * q) + 2; i++) {
      coneDirection(up, 0.32, _v, rand, 1.8);
      const sp = rr(2.6, 6.5);
      this.vfx.layers.dust?.spawn(
        point.x + rr(-0.03, 0.03), point.y + 0.01, point.z + rr(-0.03, 0.03),
        _v.x * sp, _v.y * sp, _v.z * sp, rr(0.5, 0.95),
        0.05, 0.30, rand() * TAU, (rand() - 0.5) * 1.5, 1.6, 1.0, 0,
        1, 1, 1, 0.9, P.WATER, (rand() * 16) | 0, 15, 0.5, rand(),
      );
    }
    // Crown of droplets, additive so they glint against the sky.
    this.sparks(point, up, up, Math.round(10 * q) + 3, {
      profile: P.WATER, spread: 0.75, speed0: 2, speed1: 6.5, gravity: 1.0,
      drag: 0.25, life0: 0.5, life1: 1.0, size0: 0.010, size1: 0.028,
      stretch: 0.02, tile: 10 + ((rand() * 2) | 0), r: 0.8, g: 0.9, b: 1.0,
    });
    // Foam ring hugging the surface.
    this.puff(this.vfx.layers.dust, point, up, Math.round(3 * q) + 1, {
      profile: P.WATER, spread: 1.45, speed0: 0.8, speed1: 2.2,
      size0: 0.06, growth0: 4, growth1: 7, life0: 0.6, life1: 1.1,
      drag: 3.5, gravity: 0.25, alpha: 0.6,
    });
    this.decal(point, up, DECAL.DUST_RING, rr(0.35, 0.6), {
      life: 1.6, fadeIn: 0.05, opacity: 0.45, color: WATER_TINT,
    });
  }

  flesh(point, n, dir, q) {
    this.vfx.blood?.spray(point, n, dir, q);
  }

  fabric(point, n, refl, q) {
    this.puff(this.vfx.layers.dust, point, n, Math.round(4 * q) + 1, {
      profile: P.SMOKE_LIGHT, spread: 0.9, speed0: 0.5, speed1: 1.8,
      size0: 0.05, growth0: 4, growth1: 8, life0: 0.6, life1: 1.3, alpha: 0.7,
    });
    this.fragments(point, n, refl, Math.round(4 * q), {
      tile0: 13, tileN: 3, speed0: 1.5, speed1: 4.5, size0: 0.01, size1: 0.03,
      gravity: 0.7, drag: 1.4, r: 0.8, g: 0.78, b: 0.74,
    });
    this.decal(point, n, DECAL.HOLE_SOFT, rr(0.09, 0.14), { life: 45, opacity: 0.85 });
  }

  foliage(point, n, refl, q) {
    this.fragments(point, n, refl, Math.round(7 * q) + 2, {
      tile0: 13, tileN: 3, speed0: 1.5, speed1: 5, size0: 0.02, size1: 0.06,
      gravity: 0.55, drag: 1.6, spin: 14, life0: 1.4, life1: 2.6, profile: P.FOLIAGE,
    });
    this.puff(this.vfx.layers.dust, point, n, Math.round(2 * q), {
      profile: P.FOLIAGE, spread: 1.0, speed0: 0.4, speed1: 1.4,
      size0: 0.05, growth0: 3, growth1: 5, life0: 0.5, life1: 0.9, alpha: 0.5,
    });
  }
}

const UP = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);
const HOT_METAL = /* @__PURE__ */ new THREE.Color(1.0, 0.62, 0.26);
const WATER_TINT = /* @__PURE__ */ new THREE.Color(0.75, 0.85, 0.95);
