import * as THREE from 'three';
import { makeHitRecord } from './StaticWorld.js';
import { surfaceProps, surfaceName } from './Surfaces.js';

/**
 * Wallbang / penetration solver.
 *
 * A round is traced through the level as a sequence of entry/exit pairs. For each
 * slab we measure the real thickness along the flight path (not the wall's
 * nominal thickness — a shot through a corner at 70 degrees has to eat far more
 * material), take an energy toll from the surface table, and either continue or
 * stop. Surviving rounds get a small deflection that scales with how much energy
 * they lost, which is what makes deep wallbangs feel unreliable in a good way.
 *
 * Exit faces are found by re-casting with backface hits enabled; geometry that is
 * a single-sided plane (fences, sheet metal, decals-on-walls) has no exit face at
 * all, so we fall back to the surface's nominal `thin` value.
 */

const MAX_SEGMENTS = 8;
const MAX_SLAB = 2.0;      // metres of one continuous material we bother to trace

export class Ballistics {
  constructor(world) {
    this.world = world;
    this._hit = makeHitRecord();
    this._exit = makeHitRecord();
    this._o = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._tmp = new THREE.Vector3();

    // Reusable result graph: penetrationTrace is called once per pellet, so the
    // segment records are pooled and refilled rather than rebuilt.
    this._result = {
      segments: [],
      count: 0,
      energy: 1,
      stopped: false,
      distance: 0,
      endPoint: new THREE.Vector3(),
      endDir: new THREE.Vector3(),
      firstHit: null,
    };
    for (let i = 0; i < MAX_SEGMENTS; i++) {
      this._result.segments.push({
        entryPoint: new THREE.Vector3(),
        entryNormal: new THREE.Vector3(),
        exitPoint: new THREE.Vector3(),
        exitNormal: new THREE.Vector3(),
        hasExit: false,
        thickness: 0,
        effectiveThickness: 0,
        surface: 'concrete',
        surfaceId: 0,
        object: null,
        instanceId: -1,
        distance: 0,
        energyIn: 1,
        energyOut: 0,
        penetrated: false,
        ricochet: false,
      });
    }
  }

  /**
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} dir              normalised
   * @param {number} maxDist
   * @param {Object} [opts] {power=1, ignore, layerMask, maxSegments, minEnergy=0.06}
   * @returns {Object} the shared trace result (copy anything you keep)
   */
  trace(origin, dir, maxDist = 200, opts = null) {
    const res = this._result;
    res.count = 0;
    res.stopped = false;
    res.distance = 0;
    res.firstHit = null;
    const power = opts?.power ?? 1;
    const minEnergy = opts?.minEnergy ?? 0.06;
    const maxSegments = Math.min(MAX_SEGMENTS, opts?.maxSegments ?? MAX_SEGMENTS);
    let energy = 1;

    this._o.copy(origin);
    this._d.copy(dir).normalize();
    res.endPoint.copy(this._o);
    res.endDir.copy(this._d);

    let travelled = 0;
    const world = this.world;

    for (let s = 0; s < maxSegments; s++) {
      const remaining = maxDist - travelled;
      if (remaining <= 0.001) break;
      if (!world.rayFirst(this._o, this._d, remaining, opts, this._hit)) {
        res.endPoint.copy(this._o).addScaledVector(this._d, remaining);
        res.distance = maxDist;
        break;
      }

      const seg = res.segments[res.count];
      const props = surfaceProps(this._hit.surfaceId);
      seg.entryPoint.copy(this._hit.point);
      seg.entryNormal.copy(this._hit.normal);
      seg.surfaceId = this._hit.surfaceId;
      seg.surface = surfaceName(this._hit.surfaceId);
      seg.object = this._hit.object;
      seg.instanceId = this._hit.instanceId;
      seg.distance = travelled + this._hit.distance;
      seg.energyIn = energy;
      seg.ricochet = false;
      if (res.count === 0) res.firstHit = seg;

      travelled += this._hit.distance;
      res.distance = travelled;
      res.endPoint.copy(this._hit.point);

      // --- grazing ricochet -------------------------------------------------
      const cosIncidence = Math.abs(this._d.dot(this._hit.normal));
      if (cosIncidence < props.ricochetCos && energy > 0.35 && !props.shatters) {
        seg.ricochet = true;
        seg.hasExit = false;
        seg.thickness = 0;
        seg.effectiveThickness = 0;
        energy *= 0.55;
        seg.energyOut = energy;
        seg.penetrated = false;
        res.count++;
        // reflect and continue from just off the surface
        this._d.reflect(this._hit.normal).normalize();
        jitter(this._d, 0.03 * (1 - cosIncidence));
        this._o.copy(this._hit.point).addScaledVector(this._hit.normal, 0.004);
        if (energy < minEnergy) { res.stopped = true; break; }
        continue;
      }

      // --- find the exit face ----------------------------------------------
      this._tmp.copy(this._hit.point).addScaledVector(this._d, 0.0015);
      let thickness = -1;
      let hasExit = false;
      const slab = Math.min(MAX_SLAB, remaining - this._hit.distance);
      let searched = 0;
      for (let k = 0; k < 4 && searched < slab; k++) {
        if (!world.rayFirst(this._tmp, this._d, slab - searched, _backfaceOpts(opts), this._exit)) break;
        searched += this._exit.distance;
        if (this._exit.backface) {
          hasExit = true;
          thickness = searched + 0.0015;   // the offset we started the sub-cast at
          seg.exitPoint.copy(this._exit.point);
          seg.exitNormal.copy(this._exit.normal);
          break;
        }
        // A front face inside the slab: another object butted against this one.
        this._tmp.copy(this._exit.point).addScaledVector(this._d, 0.0015);
        searched += 0.0015;
      }
      if (!hasExit) {
        thickness = props.thin;
        seg.exitPoint.copy(this._hit.point).addScaledVector(this._d, thickness);
        seg.exitNormal.copy(this._hit.normal).multiplyScalar(-1);
      }
      seg.hasExit = hasExit;
      seg.thickness = thickness;

      // Oblique shots have to chew through more material than the wall is thick.
      const eff = thickness / Math.max(0.2, cosIncidence);
      seg.effectiveThickness = eff;

      const cost = props.entryCost + eff / (props.maxPen * Math.max(0.05, power));
      energy -= cost;
      if (energy <= minEnergy) {
        energy = Math.max(0, energy);
        seg.energyOut = energy;
        seg.penetrated = false;
        res.count++;
        res.stopped = true;
        res.endPoint.copy(this._hit.point).addScaledVector(this._d, Math.min(thickness, 0.05));
        break;
      }

      seg.energyOut = energy;
      seg.penetrated = true;
      res.count++;

      // Exit: deflect proportionally to the energy lost in the slab.
      const lost = seg.energyIn - energy;
      jitter(this._d, Math.min(0.035, lost * 0.09));
      this._o.copy(seg.exitPoint).addScaledVector(this._d, 0.002);
      travelled += Math.min(thickness, MAX_SLAB);
      res.endPoint.copy(this._o);
      res.endDir.copy(this._d);
    }

    res.energy = energy;
    res.endDir.copy(this._d);
    return res;
  }
}

let _seed = 0x9e3779b9;
function rand() {
  // xorshift: deterministic, no allocation, no Math.random cadence coupling
  _seed ^= _seed << 13; _seed |= 0;
  _seed ^= _seed >>> 17;
  _seed ^= _seed << 5; _seed |= 0;
  return (_seed >>> 0) / 4294967296;
}

function jitter(dir, amount) {
  if (amount <= 0) return;
  dir.x += (rand() * 2 - 1) * amount;
  dir.y += (rand() * 2 - 1) * amount;
  dir.z += (rand() * 2 - 1) * amount;
  dir.normalize();
}

let _bfCache = null;
function _backfaceOpts(opts) {
  if (!_bfCache) _bfCache = { backfaces: true, ignore: null, layerMask: 0xffffffff };
  _bfCache.ignore = opts?.ignore || null;
  _bfCache.layerMask = opts?.layerMask ?? 0xffffffff;
  return _bfCache;
}
