import * as THREE from 'three';
import { clamp, clamp01, lerp, Rand } from './Util.js';

/**
 * Navigation for the AI.
 *
 * There is no authored navmesh — the level is generated at boot, so the grid is
 * *measured* from it: one downward ray per cell to find the standing surface,
 * one upward sphere sweep to prove a body fits, and a slope test on the hit
 * normal. That also cleanly rejects cells inside walls, where the upward sweep
 * starts in solid geometry and reports an immediate hit.
 *
 * On top of the grid:
 *   - A* with a binary heap, 8-connected, with a clearance penalty so agents
 *     stop shaving corners;
 *   - string-pulling against real line-of-sight rays for smoothing;
 *   - a cover-point set derived from cells that sit against geometry, each
 *     storing which directions it is protected from, so the behaviour layer can
 *     score cover against the player's *current* position rather than a
 *     designer's guess.
 */

const DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];
const DIR_COST = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

/** Eight compass directions used for the cover bitmask. */
const COVER_DIRS = [];
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * Math.PI * 2;
  COVER_DIRS.push(new THREE.Vector3(Math.sin(a), 0, Math.cos(a)));
}

export const FLAG_WALKABLE = 1;
export const FLAG_NEAR_WALL = 2;
export const FLAG_COVER = 4;
export const FLAG_INDOOR = 8;

export class NavGrid {
  constructor(game, opts = {}) {
    this.game = game;
    this.cell = opts.cell ?? 1.25;
    this.half = opts.half ?? 68;
    this.minX = -this.half;
    this.minZ = -this.half;
    this.size = Math.ceil((this.half * 2) / this.cell);
    this.count = this.size * this.size;

    this.flags = new Uint8Array(this.count);
    this.height = new Float32Array(this.count);
    this.clearance = new Uint8Array(this.count);     // distance to the nearest blocked cell, in cells
    this.occupancy = new Float32Array(this.count);   // decaying squadmate presence

    // A* scratch, reused between queries
    this.gScore = new Float32Array(this.count);
    this.fScore = new Float32Array(this.count);
    this.cameFrom = new Int32Array(this.count);
    this.stamp = new Int32Array(this.count);
    this.closed = new Uint8Array(this.count);
    this.heap = new Int32Array(this.count + 1);
    this.heapSize = 0;
    this.query = 0;

    this.coverPoints = [];
    this.coverGrid = new Map();
    this.coverCellSize = 6;
    this.ready = false;
    this.rand = new Rand(0x5EED17);
    this.stats = { cells: 0, walkable: 0, cover: 0, buildMs: 0, paths: 0, pathMs: 0 };

    this._down = new THREE.Vector3(0, -1, 0);
    this._up = new THREE.Vector3(0, 1, 0);
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
  }

  /* ================================================================ */
  /* build                                                             */
  /* ================================================================ */

  index(ix, iz) { return iz * this.size + ix; }
  inBounds(ix, iz) { return ix >= 0 && iz >= 0 && ix < this.size && iz < this.size; }
  cellX(ix) { return this.minX + (ix + 0.5) * this.cell; }
  cellZ(iz) { return this.minZ + (iz + 0.5) * this.cell; }
  toIX(x) { return Math.floor((x - this.minX) / this.cell); }
  toIZ(z) { return Math.floor((z - this.minZ) / this.cell); }

  /**
   * Sample the world into the grid. `yieldFn` is awaited every few rows so the
   * boot progress bar keeps painting under a software rasteriser.
   */
  async build(yieldFn) {
    const t0 = now();
    const physics = this.game?.physics;
    const world = this.game?.world;
    if (!physics?.raycast) { this.ready = false; return this; }

    const origin = new THREE.Vector3();
    const probe = new THREE.Vector3();
    let walkable = 0;

    for (let iz = 0; iz < this.size; iz++) {
      for (let ix = 0; ix < this.size; ix++) {
        const i = this.index(ix, iz);
        const x = this.cellX(ix);
        const z = this.cellZ(iz);
        const terrain = world?.heightAt ? world.heightAt(x, z) : 0;
        origin.set(x, terrain + 3.0, z);
        const hit = physics.raycast(origin, this._down, 6.0, null);
        if (!hit) { this.height[i] = terrain; continue; }
        if (hit.normal.y < 0.70) { this.height[i] = hit.point.y; continue; }
        this.height[i] = hit.point.y;
        // Does a body fit? The sweep starts clear of the floor by more than its
        // own radius — starting it inside the ground plane would report an
        // immediate hit and mark the whole map as blocked.
        probe.set(x, hit.point.y + 0.46, z);
        const blocked = physics.sphereCast
          ? physics.sphereCast(probe, this._up, 0.30, 1.15, null)
          : null;
        if (blocked) continue;
        this.flags[i] = FLAG_WALKABLE;
        walkable++;
      }
      if ((iz & 3) === 0 && yieldFn) await yieldFn();
    }

    this._computeClearance();
    await (yieldFn ? yieldFn() : null);
    await this._buildCover(yieldFn);

    this.stats.cells = this.count;
    this.stats.walkable = walkable;
    this.stats.cover = this.coverPoints.length;
    this.stats.buildMs = now() - t0;
    this.ready = walkable > 32;
    return this;
  }

  /** Chamfer distance transform: how many cells to the nearest obstruction. */
  _computeClearance() {
    const s = this.size;
    const c = this.clearance;
    c.fill(255);
    for (let i = 0; i < this.count; i++) if (!(this.flags[i] & FLAG_WALKABLE)) c[i] = 0;
    for (let iz = 0; iz < s; iz++) {
      for (let ix = 0; ix < s; ix++) {
        const i = iz * s + ix;
        let m = c[i];
        if (ix > 0) m = Math.min(m, c[i - 1] + 1);
        if (iz > 0) m = Math.min(m, c[i - s] + 1);
        if (ix > 0 && iz > 0) m = Math.min(m, c[i - s - 1] + 1);
        if (ix < s - 1 && iz > 0) m = Math.min(m, c[i - s + 1] + 1);
        c[i] = Math.min(255, m);
      }
    }
    for (let iz = s - 1; iz >= 0; iz--) {
      for (let ix = s - 1; ix >= 0; ix--) {
        const i = iz * s + ix;
        let m = c[i];
        if (ix < s - 1) m = Math.min(m, c[i + 1] + 1);
        if (iz < s - 1) m = Math.min(m, c[i + s] + 1);
        if (ix < s - 1 && iz < s - 1) m = Math.min(m, c[i + s + 1] + 1);
        if (ix > 0 && iz < s - 1) m = Math.min(m, c[i + s - 1] + 1);
        c[i] = Math.min(255, m);
      }
    }
    for (let i = 0; i < this.count; i++) {
      if ((this.flags[i] & FLAG_WALKABLE) && this.clearance[i] <= 1) this.flags[i] |= FLAG_NEAR_WALL;
    }
  }

  /**
   * Cover points: walkable cells against geometry, tagged with the directions
   * they are protected from at chest and crouch height.
   */
  async _buildCover(yieldFn) {
    const physics = this.game?.physics;
    if (!physics?.raycast) return;
    const from = new THREE.Vector3();
    let processed = 0;

    for (let iz = 1; iz < this.size - 1; iz++) {
      for (let ix = 1; ix < this.size - 1; ix++) {
        const i = this.index(ix, iz);
        if (!(this.flags[i] & FLAG_NEAR_WALL)) continue;
        const x = this.cellX(ix);
        const z = this.cellZ(iz);
        const y = this.height[i];

        let standMask = 0;
        let crouchMask = 0;
        for (let d = 0; d < 8; d++) {
          const dir = COVER_DIRS[d];
          from.set(x, y + 1.25, z);
          if (physics.raycast(from, dir, 1.45, null)) standMask |= (1 << d);
          from.set(x, y + 0.62, z);
          if (physics.raycast(from, dir, 1.45, null)) crouchMask |= (1 << d);
        }
        processed++;
        if (!crouchMask) continue;

        const point = {
          position: new THREE.Vector3(x, y, z),
          standMask, crouchMask,
          ix, iz, index: i,
          claimedBy: null,
          lastUsed: -999,
        };
        this.flags[i] |= FLAG_COVER;
        this.coverPoints.push(point);
        const key = this._coverKey(x, z);
        let bucket = this.coverGrid.get(key);
        if (!bucket) { bucket = []; this.coverGrid.set(key, bucket); }
        bucket.push(point);
      }
      if ((iz & 7) === 0 && yieldFn && processed > 0) await yieldFn();
    }
  }

  _coverKey(x, z) {
    return `${Math.floor(x / this.coverCellSize)},${Math.floor(z / this.coverCellSize)}`;
  }

  /* ================================================================ */
  /* queries                                                           */
  /* ================================================================ */

  isWalkable(ix, iz) {
    return this.inBounds(ix, iz) && (this.flags[this.index(ix, iz)] & FLAG_WALKABLE) !== 0;
  }

  /** Ground height at a world position; falls back to the terrain. */
  groundAt(x, z) {
    const ix = this.toIX(x);
    const iz = this.toIZ(z);
    if (!this.inBounds(ix, iz)) return this.game?.world?.heightAt?.(x, z) ?? 0;
    return this.height[this.index(ix, iz)];
  }

  /** Closest walkable cell centre to a world position, or null. */
  nearestWalkable(pos, maxCells = 6, out = new THREE.Vector3()) {
    const ix0 = this.toIX(pos.x);
    const iz0 = this.toIZ(pos.z);
    if (this.isWalkable(ix0, iz0)) {
      return out.set(this.cellX(ix0), this.height[this.index(ix0, iz0)], this.cellZ(iz0));
    }
    for (let r = 1; r <= maxCells; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const ix = ix0 + dx, iz = iz0 + dz;
          if (!this.isWalkable(ix, iz)) continue;
          return out.set(this.cellX(ix), this.height[this.index(ix, iz)], this.cellZ(iz));
        }
      }
    }
    return null;
  }

  /** A random reachable point within `radius` of `pos`. */
  randomPointNear(pos, radius, out = new THREE.Vector3()) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const a = this.rand.next() * Math.PI * 2;
      const r = radius * Math.sqrt(this.rand.next());
      const x = pos.x + Math.cos(a) * r;
      const z = pos.z + Math.sin(a) * r;
      const ix = this.toIX(x);
      const iz = this.toIZ(z);
      if (this.isWalkable(ix, iz) && this.clearance[this.index(ix, iz)] > 1) {
        return out.set(this.cellX(ix), this.height[this.index(ix, iz)], this.cellZ(iz));
      }
    }
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* A*                                                                */
  /* ---------------------------------------------------------------- */

  _heapPush(node) {
    const heap = this.heap;
    let i = ++this.heapSize;
    heap[i] = node;
    while (i > 1) {
      const p = i >> 1;
      if (this.fScore[heap[p]] <= this.fScore[heap[i]]) break;
      const t = heap[p]; heap[p] = heap[i]; heap[i] = t;
      i = p;
    }
  }

  _heapPop() {
    const heap = this.heap;
    const top = heap[1];
    heap[1] = heap[this.heapSize--];
    let i = 1;
    for (;;) {
      const l = i << 1;
      const r = l + 1;
      let best = i;
      if (l <= this.heapSize && this.fScore[heap[l]] < this.fScore[heap[best]]) best = l;
      if (r <= this.heapSize && this.fScore[heap[r]] < this.fScore[heap[best]]) best = r;
      if (best === i) break;
      const t = heap[best]; heap[best] = heap[i]; heap[i] = t;
      i = best;
    }
    return top;
  }

  /**
   * @param {THREE.Vector3} from
   * @param {THREE.Vector3} to
   * @param {{maxNodes?:number, avoid?:Array}} [opts]
   * @returns {THREE.Vector3[]|null} smoothed waypoints, or null
   */
  /** Called once per frame: caps how much A* the whole squad may spend. */
  beginFrame(budget = 3) { this.budget = budget; }

  findPath(from, to, opts = {}) {
    if (!this.ready) return null;
    if (this.budget !== undefined && this.budget <= 0 && !opts.force) return null;
    if (this.budget !== undefined) this.budget--;
    const t0 = now();
    const startV = this.nearestWalkable(from, 5, this._v);
    if (!startV) return null;
    const sx = this.toIX(startV.x), sz = this.toIZ(startV.z);
    const goalV = this.nearestWalkable(to, 8, this._v2);
    if (!goalV) return null;
    const gx = this.toIX(goalV.x), gz = this.toIZ(goalV.z);

    const start = this.index(sx, sz);
    const goal = this.index(gx, gz);
    if (start === goal) {
      this.stats.paths++;
      return [new THREE.Vector3(goalV.x, goalV.y, goalV.z)];
    }

    const q = ++this.query;
    this.heapSize = 0;
    const maxNodes = opts.maxNodes ?? 1500;
    const cell = this.cell;
    const hx = (a, b) => {
      const ax = a % this.size, az = (a / this.size) | 0;
      const bx = b % this.size, bz = (b / this.size) | 0;
      const dx = Math.abs(ax - bx), dz = Math.abs(az - bz);
      return (dx + dz) + (Math.SQRT2 - 2) * Math.min(dx, dz);
    };

    this.stamp[start] = q;
    this.closed[start] = 0;
    this.gScore[start] = 0;
    this.fScore[start] = hx(start, goal);
    this.cameFrom[start] = -1;
    this._heapPush(start);

    let expanded = 0;
    let found = false;
    let best = start;
    let bestH = this.fScore[start];

    while (this.heapSize > 0 && expanded < maxNodes) {
      const cur = this._heapPop();
      if (this.closed[cur] === 1 && this.stamp[cur] === q) continue;
      this.closed[cur] = 1;
      if (cur === goal) { found = true; break; }
      expanded++;

      const cx = cur % this.size;
      const cz = (cur / this.size) | 0;
      const curH = this.height[cur];

      for (let d = 0; d < 8; d++) {
        const nx = cx + DIRS[d][0];
        const nz = cz + DIRS[d][1];
        if (nx < 0 || nz < 0 || nx >= this.size || nz >= this.size) continue;
        const ni = nz * this.size + nx;
        if (!(this.flags[ni] & FLAG_WALKABLE)) continue;
        // no cutting diagonal corners through geometry
        if (d >= 4) {
          if (!(this.flags[cz * this.size + nx] & FLAG_WALKABLE)) continue;
          if (!(this.flags[nz * this.size + cx] & FLAG_WALKABLE)) continue;
        }
        const dh = this.height[ni] - curH;
        if (Math.abs(dh) > 0.55) continue;              // step limit

        let cost = DIR_COST[d] * cell;
        cost += Math.abs(dh) * 1.4;                      // climbing is expensive
        if (this.clearance[ni] <= 1) cost += cell * 0.85; // hug the middle of a lane
        else if (this.clearance[ni] === 2) cost += cell * 0.20;
        cost += this.occupancy[ni] * cell * 1.6;         // spread the squad out

        if (this.stamp[ni] !== q) {
          this.stamp[ni] = q;
          this.closed[ni] = 0;
          this.gScore[ni] = Infinity;
        }
        const tentative = this.gScore[cur] + cost;
        if (tentative < this.gScore[ni]) {
          this.cameFrom[ni] = cur;
          this.gScore[ni] = tentative;
          const h = hx(ni, goal) * cell;
          // weighted A*: ~3x fewer expansions for paths a metre or two longer,
          // which nobody can see and the smoother mostly removes anyway
          this.fScore[ni] = tentative + h * 1.18;
          if (h < bestH) { bestH = h; best = ni; }
          this._heapPush(ni);
        }
      }
    }

    const end = found ? goal : best;
    if (!found && bestH > 14) { this.stats.pathMs += now() - t0; return null; }

    const raw = [];
    let node = end;
    let guard = 0;
    while (node >= 0 && guard++ < 4096) {
      const ix = node % this.size;
      const iz = (node / this.size) | 0;
      raw.push(new THREE.Vector3(this.cellX(ix), this.height[node], this.cellZ(iz)));
      if (node === start) break;
      node = this.cameFrom[node];
      if (this.stamp[node] !== q) break;
    }
    raw.reverse();
    // Only the next stretch matters: agents repath as they advance, and
    // smoothing cost is what makes long paths expensive.
    if (raw.length > 26) raw.length = 26;
    const path = this.smooth(raw, raw.length < 26 ? to : null);
    this.stats.paths++;
    this.stats.pathMs += now() - t0;
    return path;
  }

  /**
   * String-pull the raw cell path: keep a waypoint only when the straight line
   * from the last kept point is actually blocked. Tests the grid first (cheap)
   * and confirms with a physics ray at torso height.
   */
  smooth(raw, finalTarget) {
    if (raw.length <= 2) {
      if (finalTarget && raw.length) raw[raw.length - 1].set(finalTarget.x, raw[raw.length - 1].y, finalTarget.z);
      return raw;
    }
    const out = [raw[0]];
    let anchor = 0;
    const reach = 10;                 // bounded look-ahead keeps this O(n)
    for (let i = 2; i < raw.length; i++) {
      if (i - anchor > reach || !this._segmentClear(raw[anchor], raw[i])) {
        out.push(raw[i - 1]);
        anchor = i - 1;
      }
    }
    out.push(raw[raw.length - 1]);
    if (finalTarget) {
      const last = out[out.length - 1];
      if (this._segmentClear(out.length > 1 ? out[out.length - 2] : out[0], finalTarget)) {
        last.set(finalTarget.x, this.groundAt(finalTarget.x, finalTarget.z), finalTarget.z);
      }
    }
    // drop the start point: the agent is already standing on it
    if (out.length > 1) out.shift();
    return out;
  }

  _segmentClear(a, b) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-4) return true;
    const steps = Math.ceil(dist / (this.cell * 0.6));
    let prevY = a.y;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = a.x + dx * t;
      const z = a.z + dz * t;
      const ix = this.toIX(x), iz = this.toIZ(z);
      if (!this.isWalkable(ix, iz)) return false;
      const i = this.index(ix, iz);
      if (this.clearance[i] <= 1) return false;
      if (Math.abs(this.height[i] - prevY) > 0.5) return false;
      prevY = this.height[i];
    }
    const physics = this.game?.physics;
    if (physics?.lineOfSight) {
      this._v.set(a.x, a.y + 1.05, a.z);
      this._v2.set(b.x, b.y + 1.05, b.z);
      if (!physics.lineOfSight(this._v, this._v2, null)) return false;
    }
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* dynamic occupancy                                                 */
  /* ---------------------------------------------------------------- */

  /** Squadmates stamp themselves in so A* routes around a taken lane. */
  stampOccupancy(pos, amount = 1) {
    const ix = this.toIX(pos.x);
    const iz = this.toIZ(pos.z);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!this.inBounds(ix + dx, iz + dz)) continue;
        const i = this.index(ix + dx, iz + dz);
        this.occupancy[i] = Math.min(3, this.occupancy[i] + amount * (dx || dz ? 0.4 : 1));
      }
    }
  }

  decayOccupancy(dt) {
    const k = Math.exp(-dt * 1.6);
    const o = this.occupancy;
    for (let i = 0; i < o.length; i++) if (o[i] > 0.001) o[i] *= k; else o[i] = 0;
  }

  /* ---------------------------------------------------------------- */
  /* cover                                                             */
  /* ---------------------------------------------------------------- */

  /** Every cover point within `radius` of `pos`. */
  coverNear(pos, radius, out = []) {
    out.length = 0;
    const r = Math.ceil(radius / this.coverCellSize);
    const cx = Math.floor(pos.x / this.coverCellSize);
    const cz = Math.floor(pos.z / this.coverCellSize);
    const r2 = radius * radius;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const bucket = this.coverGrid.get(`${cx + dx},${cz + dz}`);
        if (!bucket) continue;
        for (const p of bucket) {
          const ddx = p.position.x - pos.x;
          const ddz = p.position.z - pos.z;
          if (ddx * ddx + ddz * ddz <= r2) out.push(p);
        }
      }
    }
    return out;
  }

  /**
   * How well a cover point protects against a threat: 1 when the threat lies
   * exactly behind the covered arc at standing height, 0.5 when only crouching
   * helps, 0 when it is open.
   */
  coverQuality(point, threat) {
    const dx = threat.x - point.position.x;
    const dz = threat.z - point.position.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) return 0;
    const ang = Math.atan2(dx / len, dz / len);
    const slot = ((ang / (Math.PI * 2)) * 8 + 8) % 8;
    const i0 = Math.floor(slot) % 8;
    const i1 = (i0 + 1) % 8;
    const f = slot - Math.floor(slot);
    const s0 = (point.standMask >> i0) & 1;
    const s1 = (point.standMask >> i1) & 1;
    const c0 = (point.crouchMask >> i0) & 1;
    const c1 = (point.crouchMask >> i1) & 1;
    const stand = lerp(s0, s1, f);
    const crouch = lerp(c0, c1, f);
    return clamp01(stand * 0.65 + crouch * 0.35);
  }

  dispose() {
    this.coverPoints.length = 0;
    this.coverGrid.clear();
  }
}

function now() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }

export { COVER_DIRS };
