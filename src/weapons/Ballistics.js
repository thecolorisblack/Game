import * as THREE from 'three';
import { bus } from '../core/EventBus.js';

/**
 * Hitscan resolution: spread, penetration, characters, damage.
 *
 * A round is resolved in one pass:
 *   1. a spread cone deflects the muzzle direction (tighter when aiming, wider
 *      while moving or after a long burst);
 *   2. `physics.penetrationTrace` walks the round through the world and hands
 *      back every slab it crossed with the energy in and out, which is what
 *      makes wallbangs behave — a 5.56 through drywall keeps most of its damage,
 *      the same round through a concrete pillar does not come out at all;
 *   3. characters are intersected against the same segment and scored against
 *      whichever slab energy was current where they stood;
 *   4. damage falls off with distance on a per-weapon curve, is multiplied by
 *      the hit zone, and is reported over the bus.
 *
 * Everything here is optional-chained against physics/ai/vfx: if a dependency
 * is still a placeholder the shot degrades to a straight ray with no impact
 * rather than throwing inside the frame loop.
 */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _WORLD_UP = new THREE.Vector3(0, 1, 0);

export class Ballistics {
  constructor(game) {
    this.game = game;
    this.onTracer = null;        // fallback tracer sink, set by WeaponSystem
    this.debugLastShot = null;
    this._hits = [];
    this._impactPool = [];
  }

  /* ---------------------------------------------------------------- */
  /* public                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Resolve one trigger pull.
   *
   * @param {Object} weapon    a Weapon instance (reads damage/falloff/penetration)
   * @param {THREE.Vector3} origin  world-space muzzle line origin (the eye, not the barrel)
   * @param {THREE.Vector3} dir     unit forward
   * @param {Object} opts      {spread, pellets, isADS, hostile, source, tracerFrom, ignore}
   * @returns {{hits:number, kills:number, headshots:number}}
   */
  fire(weapon, origin, dir, opts = {}) {
    const pellets = Math.max(1, opts.pellets ?? weapon?.pellets ?? 1);
    const spread = Math.max(0, opts.spread ?? 0);
    let hits = 0;
    let kills = 0;
    let headshots = 0;

    for (let i = 0; i < pellets; i++) {
      const d = this._spreadDir(dir, spread, _v1);
      const r = this._traceOne(weapon, origin, d, opts);
      if (r.hit) hits++;
      if (r.kill) kills++;
      if (r.headshot) headshots++;
    }
    return { hits, kills, headshots };
  }

  /** Deflect `dir` inside a cone of half-angle `spread` (radians). */
  _spreadDir(dir, spread, out) {
    out.copy(dir);
    if (spread <= 1e-6) return out;
    _right.crossVectors(dir, _WORLD_UP);
    if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
    _right.normalize();
    _up.crossVectors(_right, dir).normalize();
    // sqrt keeps the distribution uniform over the disc rather than centre-heavy
    const r = Math.sqrt(Math.random()) * Math.tan(spread);
    const a = Math.random() * Math.PI * 2;
    out.addScaledVector(_right, Math.cos(a) * r).addScaledVector(_up, Math.sin(a) * r);
    return out.normalize();
  }

  /* ---------------------------------------------------------------- */
  /* one round                                                         */
  /* ---------------------------------------------------------------- */

  _traceOne(weapon, origin, dir, opts) {
    const game = this.game;
    const maxDist = weapon?.range ?? 320;
    const result = { hit: false, kill: false, headshot: false, end: null };

    // ---- 1. world penetration -------------------------------------
    let segments = null;
    let stopDistance = maxDist;
    let trace = null;
    try {
      trace = game.physics?.penetrationTrace?.(origin, dir, maxDist, {
        power: weapon?.penetration ?? 1,
        ignore: opts.ignore ?? null,
      });
    } catch (err) {
      trace = null;
    }
    if (trace && trace.count > 0) {
      segments = [];
      for (let i = 0; i < trace.count; i++) {
        const s = trace.segments[i];
        if (!s) continue;
        // physics/Ballistics.js segment schema
        const entry = s.entryPoint ?? s.entry ?? s.point ?? null;
        const exit = s.hasExit === false ? null : (s.exitPoint ?? s.exit ?? null);
        const entryDistance = s.distance ?? (entry ? entry.distanceTo(origin) : 0);
        segments.push({
          entry: entry ? entry.clone() : null,
          exit: exit ? exit.clone() : null,
          normal: (s.entryNormal ?? s.normal ?? _WORLD_UP).clone(),
          exitNormal: s.exitNormal ? s.exitNormal.clone() : null,
          surface: s.surface ?? 'concrete',
          object: s.object ?? null,
          energyIn: s.energyIn ?? 1,
          energyOut: s.energyOut ?? 0,
          entryDistance,
          exitDistance: exit ? entryDistance + entry.distanceTo(exit) : -1,
          thickness: s.thickness ?? 0,
        });
      }
      if (trace.stopped) stopDistance = trace.distance ?? maxDist;
      else stopDistance = maxDist;
    } else if (!trace) {
      // physics missing or failed: fall back to a plain ray
      const hit = this._safeRay(origin, dir, maxDist, opts.ignore);
      if (hit) {
        segments = [{
          entry: hit.point.clone(), exit: null, normal: hit.normal.clone(), exitNormal: null,
          surface: hit.surface ?? 'concrete', object: hit.object ?? null,
          energyIn: 1, energyOut: 0,
          entryDistance: hit.distance, exitDistance: hit.distance, thickness: 0,
        }];
        stopDistance = hit.distance;
      }
    }

    // ---- 2. characters --------------------------------------------
    const charHit = this._traceCharacters(origin, dir, maxDist, opts);

    // energy that remains where the character stands
    let energy = 1;
    if (charHit && segments) {
      for (const s of segments) {
        if (s.exitDistance > 0 && s.exitDistance < charHit.distance) energy = s.energyOut;
        else if (s.entryDistance < charHit.distance && s.exitDistance <= 0) energy = 0;
      }
    }

    const blockedBefore = segments && segments.length
      ? this._blockedAt(segments, charHit ? charHit.distance : Infinity)
      : false;

    // ---- 3. impacts ------------------------------------------------
    const impactLimit = charHit ? charHit.distance : Infinity;
    let lastPoint = null;
    if (segments) {
      for (const s of segments) {
        if (s.entryDistance > impactLimit) break;
        if (s.entry) {
          lastPoint = s.entry;
          this._emitImpact(s.entry, s.normal, s.surface, s.object, dir);
        }
        // matched exit spall on a through-and-through
        if (s.exit && s.energyOut > 0.02 && s.exitDistance <= impactLimit) {
          this._emitImpact(s.exit, s.exitNormal || s.normal, s.surface, s.object, dir);
        }
        if (s.energyOut <= 0.02) break;
      }
    }

    // ---- 4. damage --------------------------------------------------
    if (charHit && !blockedBefore && energy > 0.05) {
      const dmg = this._damageFor(weapon, charHit, energy);
      const headshot = charHit.part === 'head';
      const killed = this._applyDamage(charHit, dmg, headshot, dir, weapon);
      this._emitImpact(charHit.point, charHit.normal, 'flesh', charHit.object || charHit.enemy, dir);
      bus.emit('damage:dealt', {
        target: charHit.enemy,
        amount: dmg,
        headshot,
        point: charHit.point.clone(),
      });
      if (!opts.hostile) bus.emit('hitmarker', { headshot, kill: killed });
      result.hit = true;
      result.kill = killed;
      result.headshot = headshot;
      lastPoint = charHit.point;
    }

    // ---- 5. whizby (hostile rounds passing the player) ---------------
    if (opts.hostile) this._whizby(origin, dir, Math.min(stopDistance, maxDist));

    // ---- 6. tracer ---------------------------------------------------
    const endPoint = lastPoint
      ? _v4.copy(lastPoint)
      : _v4.copy(origin).addScaledVector(dir, Math.min(stopDistance, maxDist));
    result.end = endPoint.clone();
    this._tracer(opts.tracerFrom || origin, result.end, weapon, opts);
    this.debugLastShot = { origin: origin.clone(), dir: dir.clone(), end: result.end };
    return result;
  }

  _blockedAt(segments, distance) {
    // a round is blocked if it ran out of energy before reaching `distance`
    for (const s of segments) {
      if (s.entryDistance < distance && s.energyOut <= 0.02) {
        if (s.exitDistance <= 0 || s.exitDistance < distance) return true;
      }
    }
    return false;
  }

  _safeRay(origin, dir, maxDist, ignore) {
    try {
      return this.game.physics?.raycast?.(origin, dir, maxDist, ignore ? { ignore } : null) ?? null;
    } catch (err) {
      return null;
    }
  }

  _emitImpact(point, normal, surface, object, dir) {
    if (!point) return;
    bus.emit('bullet:impact', {
      point: point.clone(),
      normal: (normal || _WORLD_UP).clone(),
      surface: surface || 'concrete',
      object: object || null,
      dir: dir.clone(),
    });
  }

  /* ---------------------------------------------------------------- */
  /* characters                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Segment-vs-character test. Prefers an AI-provided hitscan API; otherwise
   * approximates every enemy as a body capsule plus a head sphere, which is
   * exactly what the hitboxes would be anyway.
   */
  _traceCharacters(origin, dir, maxDist, opts) {
    const ai = this.game.ai;
    if (!ai) return null;

    // 1. proper API if the AI module offers one
    try {
      if (typeof ai.hitscan === 'function') {
        const r = ai.hitscan(origin, dir, maxDist, opts);
        if (r && r.point) {
          return {
            enemy: r.enemy ?? r.target ?? null,
            object: r.object ?? null,
            point: r.point.clone ? r.point.clone() : new THREE.Vector3().copy(r.point),
            normal: r.normal ? new THREE.Vector3().copy(r.normal) : _v3.copy(dir).negate().clone(),
            distance: r.distance ?? origin.distanceTo(r.point),
            part: r.part ?? 'body',
            multiplier: r.multiplier ?? null,
          };
        }
        return null;
      }
    } catch (err) { /* fall through to the geometric path */ }

    const list = Array.isArray(ai.enemies) ? ai.enemies
      : Array.isArray(ai.agents) ? ai.agents : null;
    if (!list || !list.length) return null;

    let best = null;
    for (const e of list) {
      if (!e || e === opts.exclude) continue;
      if (e.alive === false || e.dead === true) continue;
      if (typeof e.health === 'number' && e.health <= 0) continue;
      const base = this._enemyOrigin(e, _v1);
      if (!base) continue;
      if (base.distanceToSquared(origin) > (maxDist + 4) * (maxDist + 4)) continue;

      const height = e.height ?? 1.78;
      const radius = e.radius ?? 0.30;

      // explicit hitboxes win if the AI publishes them
      if (Array.isArray(e.hitboxes) && e.hitboxes.length) {
        for (const hb of e.hitboxes) {
          const c = hb.center ?? hb.position;
          if (!c) continue;
          const d = raySphere(origin, dir, c, hb.radius ?? 0.18, maxDist);
          if (d !== null && (!best || d < best.distance)) {
            best = this._mkHit(e, origin, dir, d, hb.part ?? 'body', hb.multiplier ?? null, c);
          }
        }
        continue;
      }

      // head first: a smaller target that should win ties
      _v2.set(base.x, base.y + height - 0.135, base.z);
      let d = raySphere(origin, dir, _v2, 0.125, maxDist);
      if (d !== null && (!best || d < best.distance)) {
        best = this._mkHit(e, origin, dir, d, 'head', null, _v2);
      }
      // torso + legs capsule
      _v2.set(base.x, base.y + radius + 0.02, base.z);
      _v3.set(base.x, base.y + height - 0.26, base.z);
      d = rayCapsule(origin, dir, _v2, _v3, radius, maxDist);
      if (d !== null && (!best || d < best.distance)) {
        const p = _v4.copy(origin).addScaledVector(dir, d);
        const rel = (p.y - base.y) / Math.max(0.1, height);
        const part = rel > 0.72 ? 'chest' : rel > 0.42 ? 'body' : 'legs';
        best = this._mkHit(e, origin, dir, d, part, null, null);
      }
    }
    return best;
  }

  _mkHit(enemy, origin, dir, distance, part, multiplier, centre) {
    const point = new THREE.Vector3().copy(origin).addScaledVector(dir, distance);
    const normal = centre
      ? point.clone().sub(centre).normalize()
      : new THREE.Vector3(-dir.x, -dir.y, -dir.z);
    if (!Number.isFinite(normal.x) || normal.lengthSq() < 1e-6) normal.set(-dir.x, -dir.y, -dir.z);
    return {
      enemy,
      object: enemy.root ?? enemy.object ?? enemy.mesh ?? null,
      point, normal, distance, part, multiplier,
    };
  }

  _enemyOrigin(e, out) {
    const p = e.position ?? e.root?.position ?? e.object?.position ?? e.mesh?.position;
    if (!p) return null;
    out.set(p.x, p.y, p.z);
    // some rigs publish the eye/centre rather than the feet
    if (e.originIsCentre === true) out.y -= (e.height ?? 1.78) * 0.5;
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* damage                                                            */
  /* ---------------------------------------------------------------- */

  _damageFor(weapon, hit, energy) {
    const base = weapon?.damage ?? 30;
    const falloff = this.falloffAt(weapon, hit.distance);
    const zone = hit.multiplier ?? this.zoneMultiplier(weapon, hit.part);
    return base * falloff * zone * THREE.MathUtils.clamp(energy, 0, 1);
  }

  /** Piecewise-linear damage curve, `[[metres, multiplier], ...]`. */
  falloffAt(weapon, distance) {
    const curve = weapon?.falloff;
    if (!curve || !curve.length) return 1;
    if (distance <= curve[0][0]) return curve[0][1];
    for (let i = 1; i < curve.length; i++) {
      if (distance <= curve[i][0]) {
        const a = curve[i - 1];
        const b = curve[i];
        const t = (distance - a[0]) / Math.max(1e-4, b[0] - a[0]);
        return a[1] + (b[1] - a[1]) * t;
      }
    }
    return curve[curve.length - 1][1];
  }

  zoneMultiplier(weapon, part) {
    const m = weapon?.multipliers;
    if (m && m[part] !== undefined) return m[part];
    switch (part) {
      case 'head': return 1.9;
      case 'chest': return 1.1;
      case 'legs': return 0.82;
      case 'arms': return 0.85;
      default: return 1.0;
    }
  }

  _applyDamage(hit, amount, headshot, dir, weapon) {
    const e = hit.enemy;
    if (!e) return false;
    const info = {
      amount, headshot, point: hit.point, direction: dir.clone(),
      part: hit.part, weapon: weapon?.id ?? null, source: 'player',
    };
    try {
      if (typeof e.applyDamage === 'function') e.applyDamage(amount, info);
      else if (typeof e.damage === 'function') e.damage(amount, info);
      else if (typeof e.takeDamage === 'function') e.takeDamage(amount, info);
      else if (typeof this.game.ai?.damage === 'function') this.game.ai.damage(e, amount, info);
      else if (typeof e.health === 'number') e.health -= amount;
    } catch (err) {
      console.warn('[Weapons] damage handler threw', err);
    }
    const dead = (typeof e.health === 'number' && e.health <= 0)
      || e.alive === false || e.dead === true;
    return !!dead;
  }

  /* ---------------------------------------------------------------- */
  /* presentation                                                      */
  /* ---------------------------------------------------------------- */

  _tracer(from, to, weapon, opts) {
    if (opts.tracer === false) return;
    const vfx = this.game.vfx;
    const cfg = {
      width: weapon?.tracerWidth ?? 0.028,
      speed: weapon?.tracerSpeed ?? 780,
      color: opts.hostile ? (weapon?.tracerColorHostile ?? 0xff6a2a) : (weapon?.tracerColor ?? 0xffd08a),
      intensity: weapon?.tracerIntensity ?? 3.2,
      hostile: !!opts.hostile,
    };
    try {
      if (vfx) {
        if (typeof vfx.tracer === 'function') { vfx.tracer(from, to, cfg); return; }
        if (typeof vfx.spawnTracer === 'function') { vfx.spawnTracer(from, to, cfg); return; }
        if (typeof vfx.addTracer === 'function') { vfx.addTracer(from, to, cfg); return; }
        if (typeof vfx.bulletTracer === 'function') { vfx.bulletTracer(from, to, cfg); return; }
      }
    } catch (err) { /* vfx is someone else's module; never let it kill the shot */ }
    this.onTracer?.(from, to, cfg);
  }

  /** Emit `bullet:whizby` when a hostile round passes close to the player. */
  _whizby(origin, dir, length) {
    const cam = this.game.camera;
    if (!cam) return;
    _v1.copy(cam.position).sub(origin);
    const along = THREE.MathUtils.clamp(_v1.dot(dir), 0, length);
    _v2.copy(origin).addScaledVector(dir, along);
    const d = _v2.distanceTo(cam.position);
    if (d < 3.2 && along > 1.0) bus.emit('bullet:whizby', { distance: d });
  }
}

/* ==================================================================== */
/* geometry helpers                                                      */
/* ==================================================================== */

const _oc = new THREE.Vector3();

/** Nearest positive ray-sphere hit distance, or null. */
export function raySphere(origin, dir, centre, radius, maxDist) {
  _oc.copy(origin).sub(centre);
  const b = _oc.dot(dir);
  const c = _oc.lengthSq() - radius * radius;
  if (c > 0 && b > 0) return null;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = -b - sq;
  if (t < 0) t = -b + sq;
  if (t < 0 || t > maxDist) return null;
  return t;
}

const _ba = new THREE.Vector3();
const _oa = new THREE.Vector3();

/**
 * Ray vs capsule (segment a->b with radius r). Solves the infinite-cylinder
 * quadratic then falls back to the end caps, which is enough precision for a
 * humanoid torso and costs a handful of dot products.
 */
export function rayCapsule(origin, dir, a, b, r, maxDist) {
  _ba.copy(b).sub(a);
  _oa.copy(origin).sub(a);
  const baba = _ba.dot(_ba);
  const bard = _ba.dot(dir);
  const baoa = _ba.dot(_oa);
  const rdoa = dir.dot(_oa);
  const oaoa = _oa.dot(_oa);

  const A = baba - bard * bard;
  const B = baba * rdoa - baoa * bard;
  const C = baba * oaoa - baoa * baoa - r * r * baba;

  if (Math.abs(A) > 1e-9) {
    const h = B * B - A * C;
    if (h >= 0) {
      const t = (-B - Math.sqrt(h)) / A;
      const y = baoa + t * bard;
      if (y > 0 && y < baba && t >= 0 && t <= maxDist) return t;
    }
  }
  // caps
  const t1 = raySphere(origin, dir, a, r, maxDist);
  const t2 = raySphere(origin, dir, b, r, maxDist);
  if (t1 !== null && t2 !== null) return Math.min(t1, t2);
  return t1 !== null ? t1 : t2;
}
