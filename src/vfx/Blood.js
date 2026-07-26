import * as THREE from 'three';
import { P } from './Profiles.js';
import { DECAL } from './Textures.js';
import { V, coneDirection, clamp, lodScale, TAU } from './Util.js';

/**
 * Blood.
 *
 * Three separate readings, because that is how it works on screen: an airborne
 * mist that catches the light for a fraction of a second, fat droplets that
 * arc and fall, and — the part players actually register — a *directional wall
 * spatter* found by tracing the bullet's continuation until it hits something,
 * plus a slowly spreading pool under a body.
 */

const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _n = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);

const rand = Math.random;
const rr = (a, b) => a + (b - a) * rand();

export class BloodFX {
  constructor(vfx) {
    this.vfx = vfx;
    this.game = vfx.game;
    this.spatterCooldown = 0;
  }

  /**
   * Impact spray.
   * @param {THREE.Vector3} point
   * @param {THREE.Vector3} normal  surface normal of the hit body
   * @param {THREE.Vector3} dir     incoming bullet direction
   * @param {number} q              quality/quantity multiplier
   */
  spray(point, normal, dir, q = 1) {
    const L = this.vfx.layers;
    if (!L?.blood) return;

    _n.copy(normal || UP);
    if (_n.lengthSq() < 1e-8) _n.set(0, 1, 0); else _n.normalize();
    _dir.copy(dir || _n).normalize();

    // Back-spray toward the shooter and a larger cone continuing through.
    const back = V.a.copy(_dir).negate();
    const through = V.b.copy(_dir);

    const mist = Math.round(7 * q) + 2;
    for (let i = 0; i < mist; i++) {
      const axis = rand() < 0.62 ? through : back;
      coneDirection(axis, 0.85, _v, rand, 1.2);
      const sp = rr(0.8, 3.4);
      const p = _p.copy(point).addScaledVector(_n, rr(0.0, 0.05));
      const s = rr(0.035, 0.085);
      L.blood.spawn(
        p.x, p.y, p.z, _v.x * sp, _v.y * sp, _v.z * sp, rr(0.35, 0.8),
        s, s * rr(3.2, 5.5), rand() * TAU, (rand() - 0.5) * 2.2,
        3.6, 0.25, 0,
        1, 1, 1, 0.85, P.BLOOD_MIST, (rand() * 6) | 0, 0, 0.5, rand(),
      );
    }

    const drops = Math.round(9 * q) + 3;
    for (let i = 0; i < drops; i++) {
      const axis = rand() < 0.72 ? through : back;
      coneDirection(axis, 1.05, _v, rand, 1.5);
      const sp = rr(2.0, 7.5);
      const p = _p.copy(point);
      const s = rr(0.012, 0.034);
      L.blood.spawn(
        p.x, p.y, p.z, _v.x * sp, _v.y * sp, _v.z * sp, rr(0.6, 1.3),
        s, s * 0.9, rand() * TAU, (rand() - 0.5) * 8,
        0.5, 1.05, 0,
        1, 1, 1, 1, P.BLOOD, 6 + ((rand() * 4) | 0), 0, 0.25, rand(),
      );
    }

    // A couple of ropey streaks for silhouette interest.
    for (let i = 0; i < Math.round(2 * q); i++) {
      coneDirection(through, 0.6, _v, rand, 1.2);
      const sp = rr(3, 8);
      L.blood.spawn(
        point.x, point.y, point.z, _v.x * sp, _v.y * sp, _v.z * sp, rr(0.5, 0.9),
        0.05, 0.09, rand() * TAU, (rand() - 0.5) * 5, 0.9, 0.9, 0,
        1, 1, 1, 1, P.BLOOD, 10 + ((rand() * 3) | 0), 0, 0.3, rand(),
      );
    }

    this.wallSpatter(point, _dir, q);
  }

  /**
   * Trace the bullet's continuation and paint a directional spatter where it
   * lands. This is the single most legible blood cue in a shooter.
   */
  wallSpatter(point, dir, q = 1, maxDist = 4.5) {
    if (this.spatterCooldown > 0) return null;
    const phys = this.game?.physics;
    if (!phys?.raycast) return null;
    _v.copy(dir);
    if (_v.lengthSq() < 1e-8) return null;
    _v.normalize();
    const origin = _p.copy(point).addScaledVector(_v, 0.05);
    let hit = null;
    try { hit = phys.raycast(origin, _v, maxDist); } catch (e) { hit = null; }
    if (!hit) {
      // Nothing behind the target: try the floor, which catches most misses.
      try { hit = phys.raycast(origin, DOWN, 2.6); } catch (e) { hit = null; }
      if (!hit) return null;
    }
    if (hit.surface === 'water') return null;

    this.spatterCooldown = 0.05;
    const dist = hit.distance || 1;
    const size = clamp(rr(0.35, 0.62) * (1 + dist * 0.22) * (0.7 + q * 0.4), 0.25, 1.4);
    return this.vfx.decals?.spawn({
      point: hit.point,
      normal: hit.normal,
      dir: _v,
      tile: rand() < 0.55 ? DECAL.BLOOD_A : DECAL.BLOOD_B,
      size,
      depth: size * 0.6,
      life: 120,
      opacity: clamp(0.7 + q * 0.25, 0.4, 1),
      color: BLOOD_TINT,
      fadeIn: 0.05,
      flipU: rand() < 0.5,
    });
  }

  /**
   * Pool under a corpse: starts as a point and spreads over several seconds.
   */
  pool(position, { radius = 0.75, grow = 5.5, life = 240 } = {}) {
    const phys = this.game?.physics;
    let point = position;
    let normal = UP;
    if (phys?.raycast) {
      _p.copy(position);
      _p.y += 0.6;
      let hit = null;
      try { hit = phys.raycast(_p, DOWN, 3.2); } catch (e) { hit = null; }
      if (hit) { point = hit.point; normal = hit.normal; }
    }
    return this.vfx.decals?.spawn({
      point, normal,
      tile: DECAL.BLOOD_POOL,
      size: radius * 2,
      depth: radius * 0.9,
      life,
      opacity: 0.92,
      color: BLOOD_TINT,
      grow,
      fadeIn: 0.4,
    });
  }

  /**
   * Kill flourish: a heavier gush plus drips down whatever is behind.
   */
  gush(point, dir, { headshot = false, q = 1 } = {}) {
    const L = this.vfx.layers;
    if (!L?.blood) return;
    const lod = lodScale(this.game.camera, point, 12, 70);
    const n = Math.round((headshot ? 22 : 13) * q * lod);
    _dir.copy(dir || UP).normalize();
    for (let i = 0; i < n; i++) {
      coneDirection(_dir, headshot ? 1.15 : 0.85, _v, rand, 1.1);
      const sp = rr(1.5, headshot ? 9 : 6);
      const s = rr(0.02, 0.075);
      L.blood.spawn(
        point.x, point.y, point.z, _v.x * sp, _v.y * sp, _v.z * sp, rr(0.5, 1.2),
        s, s * rr(1.4, 3.0), rand() * TAU, (rand() - 0.5) * 6,
        1.6, 0.8, 0,
        1, 1, 1, 1, rand() < 0.45 ? P.BLOOD_MIST : P.BLOOD,
        rand() < 0.45 ? (rand() * 6) | 0 : 6 + ((rand() * 4) | 0), 0, 0.35, rand(),
      );
    }
    if (headshot) {
      this.spatterCooldown = 0;
      this.wallSpatter(point, _dir, q * 1.6, 6);
    }
  }

  update(dt) {
    if (this.spatterCooldown > 0) this.spatterCooldown -= dt;
  }
}

const UP = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);
const BLOOD_TINT = /* @__PURE__ */ new THREE.Color(1.0, 0.85, 0.85);
