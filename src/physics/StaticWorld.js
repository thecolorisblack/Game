import * as THREE from 'three';
import { MeshBVH, CENTER, SAH, CONTAINED } from 'three-mesh-bvh';
import { surfaceIndexOf } from './Surfaces.js';
import {
  rayTriangle, rayBoxEnter, sweptSphereTriangle, triNormal,
  closestPointTriangle, triAreaSq, morton3,
} from './Geom.js';

/**
 * The static collision world.
 *
 * Level geometry arrives as an arbitrary pile of meshes and instanced meshes.
 * `build()` bakes every triangle into world space once, sorts them along a Morton
 * curve and splits them into a handful of BVH-accelerated chunks (~60k triangles
 * each). A raycast then costs one slab test per chunk plus a log-depth descent —
 * microseconds, not milliseconds.
 *
 * Alongside the positions we keep parallel per-triangle arrays:
 *   triObj[i]  -> index into `objects`  (which mesh the triangle came from)
 *   triSurf[i] -> surface id byte       (which material id to report on impact)
 *   triInst[i] -> instance index or -1  (for InstancedMesh statics)
 *
 * so a hit can be reported with the right surface and the right owning object
 * even though the render-time mesh boundaries are gone.
 */

const MAX_TRIANGLES = 1_500_000;
const CHUNK_TARGET = 60_000;
const MAX_CHUNKS = 16;

export class StaticWorld {
  constructor() {
    /** @type {Array<{object:THREE.Object3D, surface:number, layer:number}>} */
    this.entries = [];
    /** @type {THREE.Object3D[]} */
    this.objects = [];
    this.objIndex = new Map();
    this.objLayer = new Uint32Array(0);
    this.objSurface = new Uint8Array(0);

    this.chunks = [];
    this.bounds = new THREE.Box3();
    this.triangleCount = 0;
    this.built = false;
    this.dirty = false;
    this.buildMs = 0;

    // --- query scratch ----------------------------------------------------
    this._ro = new THREE.Vector3();
    this._rd = new THREE.Vector3();
    this._rinv = new THREE.Vector3();
    this._best = Infinity;
    this._bestTri = -1;
    this._bestChunk = null;
    this._chunk = null;
    this._backfaces = false;
    this._layerMask = 0xffffffff;
    this._objMask = new Uint8Array(0);
    this._maskedList = [];

    this._sweepR = 0;
    this._sweepN = new THREE.Vector3();
    this._sweepP = new THREE.Vector3();
    this._bestN = new THREE.Vector3();
    this._bestP = new THREE.Vector3();

    this._qbox = new THREE.Box3();
    this._ebox = new THREE.Box3();
    this._boxCb = null;

    this._order = new Int32Array(MAX_CHUNKS);
    this._orderT = new Float64Array(MAX_CHUNKS);
    this._orderCount = 0;

    this._tmpV = new THREE.Vector3();
    this._tmpN = new THREE.Vector3();
    this._mat = new THREE.Matrix4();
    this._nmat = new THREE.Matrix3();

    this.stats = { rayCalls: 0, triTests: 0, boxCalls: 0, sweepCalls: 0 };

    this._bindCallbacks();
  }

  /* ------------------------------------------------------------------ */
  /* registration                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Register an object (or a whole subtree) as static collision.
   * Safe to call before or after `build()`; a late call just marks the world
   * dirty and the next query rebuilds.
   */
  add(object, opts = {}) {
    if (!object) return;
    const surface = surfaceIndexOf(opts.surface || 'concrete');
    const layer = opts.layer === undefined ? 1 : opts.layer >>> 0;

    const push = (mesh) => {
      if (!mesh || !mesh.isMesh || !mesh.geometry) return;
      if (mesh.userData?.noCollide) return;
      if (this.objIndex.has(mesh)) {
        // re-registering: update the surface rather than duplicating triangles
        const i = this.objIndex.get(mesh);
        this.entries[i].surface = surface;
        this.entries[i].layer = layer;
        this.dirty = true;
        return;
      }
      const idx = this.entries.length;
      this.entries.push({ object: mesh, surface, layer });
      this.objIndex.set(mesh, idx);
      this.objects.push(mesh);
      this.dirty = true;
    };

    if (object.isMesh) push(object);
    else object.traverse?.(push);
  }

  remove(object) {
    if (!object) return;
    const drop = (mesh) => {
      const i = this.objIndex.get(mesh);
      if (i === undefined) return;
      this.entries[i] = null;
      this.objIndex.delete(mesh);
      this.dirty = true;
    };
    if (object.isMesh) drop(object);
    else object.traverse?.(drop);
    if (this.dirty) {
      this.entries = this.entries.filter(Boolean);
      this.objects = this.entries.map((e) => e.object);
      this.objIndex.clear();
      for (let i = 0; i < this.entries.length; i++) this.objIndex.set(this.entries[i].object, i);
    }
  }

  clear() {
    this.disposeChunks();
    this.entries.length = 0;
    this.objects.length = 0;
    this.objIndex.clear();
    this.built = false;
    this.dirty = false;
  }

  disposeChunks() {
    for (const c of this.chunks) c.geometry?.dispose?.();
    this.chunks.length = 0;
    this.triangleCount = 0;
  }

  /* ------------------------------------------------------------------ */
  /* baking                                                              */
  /* ------------------------------------------------------------------ */

  build() {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    this.disposeChunks();

    this.objects = this.entries.map((e) => e.object);
    this.objIndex.clear();
    for (let i = 0; i < this.objects.length; i++) this.objIndex.set(this.objects[i], i);

    const n = this.objects.length;
    this.objLayer = new Uint32Array(n);
    this.objSurface = new Uint8Array(n);
    this._objMask = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      this.objLayer[i] = this.entries[i].layer;
      this.objSurface[i] = this.entries[i].surface;
    }

    // Pass 1: count triangles so the typed arrays can be sized exactly.
    let total = 0;
    let hasInstanced = false;
    for (const e of this.entries) {
      const mesh = e.object;
      const geo = mesh.geometry;
      const pos = geo?.attributes?.position;
      if (!pos) continue;
      const tris = ((geo.index ? geo.index.count : pos.count) / 3) | 0;
      const inst = mesh.isInstancedMesh ? mesh.count : 1;
      if (mesh.isInstancedMesh) hasInstanced = true;
      total += tris * inst;
    }
    if (total <= 0) {
      this.built = true;
      this.dirty = false;
      this.bounds.makeEmpty();
      this.buildMs = 0;
      return this;
    }
    if (total > MAX_TRIANGLES) {
      console.warn(`[Physics] static world has ${total} triangles; clamping to ${MAX_TRIANGLES}`);
      total = MAX_TRIANGLES;
    }

    const positions = new Float32Array(total * 9);
    const triObj = new Uint32Array(total);
    const triSurf = new Uint8Array(total);
    const triInst = hasInstanced ? new Int32Array(total) : null;

    // Pass 2: transform every triangle into world space.
    let w = 0;
    const bounds = this.bounds.makeEmpty();
    const m = this._mat;
    const v = this._tmpV;
    const ax = new Float64Array(9);

    for (let ei = 0; ei < this.entries.length; ei++) {
      const e = this.entries[ei];
      const mesh = e.object;
      const geo = mesh.geometry;
      const pos = geo?.attributes?.position;
      if (!pos) continue;
      const index = geo.index;
      const triCount = ((index ? index.count : pos.count) / 3) | 0;
      const instCount = mesh.isInstancedMesh ? mesh.count : 1;

      // Parents may not have been flushed yet (World builds before the first
      // render), so walk up and update ancestors explicitly.
      mesh.updateWorldMatrix(true, false);

      for (let inst = 0; inst < instCount; inst++) {
        if (mesh.isInstancedMesh) {
          mesh.getMatrixAt(inst, m);
          m.premultiply(mesh.matrixWorld);
        } else {
          m.copy(mesh.matrixWorld);
        }
        const me = m.elements;

        for (let t = 0; t < triCount; t++) {
          if (w >= total) break;
          for (let k = 0; k < 3; k++) {
            const vi = index ? index.getX(t * 3 + k) : t * 3 + k;
            const px = pos.getX(vi), py = pos.getY(vi), pz = pos.getZ(vi);
            const x = me[0] * px + me[4] * py + me[8] * pz + me[12];
            const y = me[1] * px + me[5] * py + me[9] * pz + me[13];
            const z = me[2] * px + me[6] * py + me[10] * pz + me[14];
            ax[k * 3] = x; ax[k * 3 + 1] = y; ax[k * 3 + 2] = z;
          }
          // Drop needle triangles: they generate garbage normals and cost time.
          if (triAreaSq(ax[0], ax[1], ax[2], ax[3], ax[4], ax[5], ax[6], ax[7], ax[8]) < 1e-14) continue;

          const o = w * 9;
          for (let k = 0; k < 9; k++) positions[o + k] = ax[k];
          triObj[w] = ei;
          triSurf[w] = e.surface;
          if (triInst) triInst[w] = mesh.isInstancedMesh ? inst : -1;
          v.set(ax[0], ax[1], ax[2]); bounds.expandByPoint(v);
          v.set(ax[3], ax[4], ax[5]); bounds.expandByPoint(v);
          v.set(ax[6], ax[7], ax[8]); bounds.expandByPoint(v);
          w++;
        }
      }
    }

    this.triangleCount = w;
    if (w === 0) {
      this.built = true;
      this.dirty = false;
      this.buildMs = 0;
      return this;
    }

    // --- spatial chunking -------------------------------------------------
    const chunkCount = Math.max(1, Math.min(MAX_CHUNKS, Math.round(w / CHUNK_TARGET) || 1));
    let order = null;
    if (chunkCount > 1) {
      // Morton-order the triangles by centroid so each chunk stays compact.
      const size = this._tmpN.set(
        Math.max(1e-4, bounds.max.x - bounds.min.x),
        Math.max(1e-4, bounds.max.y - bounds.min.y),
        Math.max(1e-4, bounds.max.z - bounds.min.z),
      );
      const keys = new Float64Array(w);
      for (let i = 0; i < w; i++) {
        const o = i * 9;
        const cx = (positions[o] + positions[o + 3] + positions[o + 6]) / 3;
        const cy = (positions[o + 1] + positions[o + 4] + positions[o + 7]) / 3;
        const cz = (positions[o + 2] + positions[o + 5] + positions[o + 8]) / 3;
        const qx = Math.min(1023, Math.max(0, ((cx - bounds.min.x) / size.x * 1023) | 0));
        const qy = Math.min(1023, Math.max(0, ((cy - bounds.min.y) / size.y * 1023) | 0));
        const qz = Math.min(1023, Math.max(0, ((cz - bounds.min.z) / size.z * 1023) | 0));
        // pack (code, index) into one double: code < 2^30, index < 2^21
        keys[i] = morton3(qx, qy, qz) * 2097152 + i;
      }
      keys.sort();
      order = new Uint32Array(w);
      for (let i = 0; i < w; i++) order[i] = keys[i] % 2097152;
    }

    const per = Math.ceil(w / chunkCount);
    for (let ci = 0; ci < chunkCount; ci++) {
      const start = ci * per;
      const end = Math.min(w, start + per);
      const count = end - start;
      if (count <= 0) continue;

      const cpos = new Float32Array(count * 9);
      const cObj = new Uint32Array(count);
      const cSurf = new Uint8Array(count);
      const cInst = triInst ? new Int32Array(count) : null;
      for (let i = 0; i < count; i++) {
        const src = order ? order[start + i] : start + i;
        const so = src * 9, dofs = i * 9;
        for (let k = 0; k < 9; k++) cpos[dofs + k] = positions[so + k];
        cObj[i] = triObj[src];
        cSurf[i] = triSurf[src];
        if (cInst) cInst[i] = triInst[src];
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(cpos, 3));
      // SAH pays for itself on small sets; on huge ones the build cost shows up
      // in the loading bar, so fall back to the centroid split.
      const bvh = new MeshBVH(geometry, {
        strategy: count <= 40_000 ? SAH : CENTER,
        targetLeafSize: 8,
        maxDepth: 40,
        indirect: true,
        verbose: false,
      });
      geometry.computeBoundingBox();

      this.chunks.push({
        geometry,
        bvh,
        pos: cpos,
        triObj: cObj,
        triSurf: cSurf,
        triInst: cInst,
        count,
        box: geometry.boundingBox.clone(),
      });
    }

    this.built = true;
    this.dirty = false;
    this.buildMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    return this;
  }

  /* ------------------------------------------------------------------ */
  /* query plumbing                                                      */
  /* ------------------------------------------------------------------ */

  _bindCallbacks() {
    // Bound once so the hot path never allocates a closure.
    this._cbRayOrder = (box) => rayBoxEnter(box, this._ro, this._rinv);
    this._cbRayBounds = (box, isLeaf, score) => score < this._best;
    this._cbRayTri = (tri, triIndex) => {
      const chunk = this._chunk;
      const oi = chunk.triObj[triIndex];
      if (this._objMask[oi] !== 0) return false;
      if ((this.objLayer[oi] & this._layerMask) === 0) return false;
      const t = rayTriangle(this._ro, this._rd, tri.a, tri.b, tri.c, this._backfaces);
      if (t > 1e-5 && t < this._best) {
        this._best = t;
        this._bestTri = triIndex;
        this._bestChunk = chunk;
      }
      return false;
    };

    this._cbSweepOrder = (box) => {
      this._ebox.copy(box).expandByScalar(this._sweepR);
      return rayBoxEnter(this._ebox, this._ro, this._rinv);
    };
    this._cbSweepBounds = (box, isLeaf, score) => score < this._best;
    this._cbSweepTri = (tri, triIndex) => {
      const chunk = this._chunk;
      const oi = chunk.triObj[triIndex];
      if (this._objMask[oi] !== 0) return false;
      if ((this.objLayer[oi] & this._layerMask) === 0) return false;
      triNormal(tri.a, tri.b, tri.c, this._tmpN);
      const t = sweptSphereTriangle(
        this._ro, this._rd, this._sweepR, this._best,
        tri.a, tri.b, tri.c, this._tmpN, this._sweepN, this._sweepP,
      );
      if (t >= 0 && t < this._best) {
        this._best = t;
        this._bestTri = triIndex;
        this._bestChunk = chunk;
        this._bestN.copy(this._sweepN);
        this._bestP.copy(this._sweepP);
      }
      return false;
    };

    this._cbBoxBounds = (box) => {
      if (!box.intersectsBox(this._qbox)) return false;
      return this._qbox.containsBox(box) ? CONTAINED : true;
    };
    this._cbBoxTri = (tri, triIndex) => this._boxCb(tri, triIndex, this._chunk) === true;
  }

  /** Applies opts.ignore / opts.layerMask / opts.backfaces to the query state. */
  _beginFilter(opts) {
    this._backfaces = !!(opts && opts.backfaces);
    this._layerMask = (opts && opts.layerMask !== undefined) ? (opts.layerMask >>> 0) : 0xffffffff;
    const ignore = opts && opts.ignore;
    if (ignore) {
      const list = Array.isArray(ignore) ? ignore : [ignore];
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        if (!o) continue;
        const idx = this.objIndex.get(o);
        if (idx !== undefined) {
          this._objMask[idx] = 1;
          this._maskedList.push(idx);
        } else if (o.traverse) {
          o.traverse((child) => {
            const ci = this.objIndex.get(child);
            if (ci !== undefined) { this._objMask[ci] = 1; this._maskedList.push(ci); }
          });
        }
      }
    }
  }

  _endFilter() {
    const l = this._maskedList;
    for (let i = 0; i < l.length; i++) this._objMask[l[i]] = 0;
    l.length = 0;
  }

  /** Orders chunks front-to-back along the current ray. */
  _orderChunks(pad) {
    const n = this.chunks.length;
    let c = 0;
    for (let i = 0; i < n && c < MAX_CHUNKS; i++) {
      this._ebox.copy(this.chunks[i].box);
      if (pad > 0) this._ebox.expandByScalar(pad);
      const t = rayBoxEnter(this._ebox, this._ro, this._rinv);
      if (t < this._best) {
        // insertion sort; there are at most 16 of these
        let j = c++;
        while (j > 0 && this._orderT[j - 1] > t) {
          this._orderT[j] = this._orderT[j - 1];
          this._order[j] = this._order[j - 1];
          j--;
        }
        this._orderT[j] = t;
        this._order[j] = i;
      }
    }
    this._orderCount = c;
  }

  _setRay(origin, dir, maxDist) {
    this._ro.copy(origin);
    this._rd.copy(dir);
    const lsq = this._rd.lengthSq();
    if (lsq < 1e-12) return false;
    if (Math.abs(lsq - 1) > 1e-6) this._rd.multiplyScalar(1 / Math.sqrt(lsq));
    this._rinv.set(1 / this._rd.x, 1 / this._rd.y, 1 / this._rd.z);
    this._best = maxDist;
    this._bestTri = -1;
    this._bestChunk = null;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* public queries                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Closest ray hit. Returns true and fills `hit` (a plain object that is reused
   * by the caller) or returns false. Zero allocations either way.
   */
  rayFirst(origin, dir, maxDist, opts, hit) {
    this.stats.rayCalls++;
    if (!this.built || this.chunks.length === 0) return false;
    if (!this._setRay(origin, dir, maxDist)) return false;

    this._beginFilter(opts);
    this._orderChunks(0);
    for (let i = 0; i < this._orderCount; i++) {
      if (this._orderT[i] >= this._best) break;
      const chunk = this.chunks[this._order[i]];
      this._chunk = chunk;
      chunk.bvh.shapecast({
        boundsTraverseOrder: this._cbRayOrder,
        intersectsBounds: this._cbRayBounds,
        intersectsTriangle: this._cbRayTri,
      });
    }
    this._endFilter();

    if (!this._bestChunk) return false;
    this._fillHit(hit, this._bestChunk, this._bestTri, this._best, null, null);
    return true;
  }

  /** True if anything at all blocks the segment. Cheaper than a full raycast. */
  rayAny(origin, dir, maxDist, opts) {
    return this.rayFirst(origin, dir, maxDist, opts, _throwaway);
  }

  /** Swept sphere. Same contract as `rayFirst`. */
  sphereSweep(origin, dir, radius, maxDist, opts, hit) {
    this.stats.sweepCalls++;
    if (!this.built || this.chunks.length === 0) return false;
    if (!this._setRay(origin, dir, maxDist)) return false;
    this._sweepR = Math.max(1e-4, radius);

    this._beginFilter(opts);
    this._orderChunks(this._sweepR);
    for (let i = 0; i < this._orderCount; i++) {
      if (this._orderT[i] >= this._best) break;
      const chunk = this.chunks[this._order[i]];
      this._chunk = chunk;
      chunk.bvh.shapecast({
        boundsTraverseOrder: this._cbSweepOrder,
        intersectsBounds: this._cbSweepBounds,
        intersectsTriangle: this._cbSweepTri,
      });
    }
    this._endFilter();

    if (!this._bestChunk) return false;
    this._fillHit(hit, this._bestChunk, this._bestTri, this._best, this._bestN, this._bestP);
    return true;
  }

  /**
   * Visit every triangle whose chunk overlaps `box`.
   * cb(triangle, triIndex, chunk) -> return true to stop the traversal.
   */
  forEachTriangleInBox(box, cb) {
    this.stats.boxCalls++;
    if (!this.built) return;
    this._qbox.copy(box);
    this._boxCb = cb;
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i];
      if (!chunk.box.intersectsBox(box)) continue;
      this._chunk = chunk;
      chunk.bvh.shapecast({
        intersectsBounds: this._cbBoxBounds,
        intersectsTriangle: this._cbBoxTri,
      });
    }
    this._boxCb = null;
  }

  /** Surface id byte for a baked triangle. */
  surfaceOfTriangle(chunk, triIndex) { return chunk.triSurf[triIndex]; }

  /** Reads a baked triangle's vertices into three vectors. */
  readTriangle(chunk, triIndex, a, b, c) {
    const p = chunk.pos, o = triIndex * 9;
    a.set(p[o], p[o + 1], p[o + 2]);
    b.set(p[o + 3], p[o + 4], p[o + 5]);
    c.set(p[o + 6], p[o + 7], p[o + 8]);
  }

  _fillHit(hit, chunk, triIndex, distance, normal, point) {
    const oi = chunk.triObj[triIndex];
    hit.distance = distance;
    hit.faceIndex = triIndex;
    hit.object = this.objects[oi] || null;
    hit.surfaceId = chunk.triSurf[triIndex];
    hit.instanceId = chunk.triInst ? chunk.triInst[triIndex] : -1;
    hit.chunk = chunk;
    if (point) hit.point.copy(point);
    else hit.point.copy(this._ro).addScaledVector(this._rd, distance);
    if (normal) {
      hit.normal.copy(normal);
      hit.backface = false;
    } else {
      const p = chunk.pos, o = triIndex * 9;
      const ux = p[o + 3] - p[o], uy = p[o + 4] - p[o + 1], uz = p[o + 5] - p[o + 2];
      const vx = p[o + 6] - p[o], vy = p[o + 7] - p[o + 1], vz = p[o + 8] - p[o + 2];
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      const facing = nx * this._rd.x + ny * this._rd.y + nz * this._rd.z;
      hit.backface = facing > 0;
      hit.normal.set(nx, ny, nz);
      hit.geoNormal?.set(nx, ny, nz);
      if (facing > 0) hit.normal.multiplyScalar(-1);
    }
    return hit;
  }
}

/** Shared sink for boolean-only queries. */
const _throwaway = {
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  geoNormal: new THREE.Vector3(),
  distance: 0, object: null, surfaceId: 0, faceIndex: -1, instanceId: -1,
  chunk: null, backface: false,
};

/** Factory for the reusable hit record used all over this module. */
export function makeHitRecord() {
  return {
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    geoNormal: new THREE.Vector3(),
    distance: 0,
    object: null,
    surfaceId: 0,
    faceIndex: -1,
    instanceId: -1,
    chunk: null,
    backface: false,
  };
}

export { closestPointTriangle };
