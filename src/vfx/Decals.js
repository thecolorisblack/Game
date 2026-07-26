import * as THREE from 'three';
import { V, clamp, saturate, smoothstep, perpendicular, TAU } from './Util.js';

/**
 * Projected decal system.
 *
 * A decal is not a quad stuck to a wall — it is the receiving geometry itself,
 * clipped to an oriented box and re-UV'd. Triangles come straight out of the
 * physics BVH in world space, so a bullet hole shot into the corner of a pillar
 * wraps around both faces, follows a stairwell nosing and never z-fights.
 *
 * Every decal in the level lives in **one** buffer geometry and therefore one
 * draw call. Slots are a fixed-size vertex range each; retired slots collapse
 * to degenerate triangles. The pool honours `settings.decalBudget` with an
 * age + distance weighted LRU and cross-fades the replacement in so eviction
 * never pops.
 */

const TRIS_PER_SLOT = 22;
const VERTS_PER_SLOT = TRIS_PER_SLOT * 3;
const MAX_CLIP = 12;

export class DecalSystem {
  constructor(game, atlas) {
    this.game = game;
    this.atlas = atlas;
    this.tiles = atlas?.tiles ?? 4;
    this.capacity = 0;
    this.slots = [];
    this.mesh = null;

    this._box = new THREE.Box3();
    this._basis = new THREE.Matrix4();
    this._tri = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this._triN = new THREE.Vector3();
    this._polyA = [];
    this._polyB = [];
    for (let i = 0; i < MAX_CLIP + 8; i++) {
      this._polyA.push(new THREE.Vector3());
      this._polyB.push(new THREE.Vector3());
    }
    this._dirtyMin = Infinity;
    this._dirtyMax = -Infinity;
    this._growing = [];
    this._collectCb = null;
    this._time = 0;
    this._writeVerts = 0;

    this._buildMaterial();
    this.setCapacity(game?.settings?.decalBudget ?? 128);
  }

  /* ---------------------------------------------------------------- setup */

  _buildMaterial() {
    const mat = new THREE.MeshStandardMaterial({
      name: 'vfxDecals',
      map: this.atlas?.albedo ?? null,
      normalMap: this.atlas?.normal ?? null,
      roughnessMap: this.atlas?.orm ?? null,
      metalnessMap: this.atlas?.orm ?? null,
      roughness: 1.0,
      metalness: 1.0,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      vertexColors: true,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
      alphaTest: 0.0,
      normalScale: new THREE.Vector2(1.25, 1.25),
      premultipliedAlpha: false,
      toneMapped: true,
    });
    this.material = mat;
  }

  setCapacity(n) {
    n = clamp(n | 0, 16, 1024);
    if (n === this.capacity) return;
    this.capacity = n;

    const verts = n * VERTS_PER_SLOT;
    const geo = new THREE.BufferGeometry();
    this.position = new Float32Array(verts * 3);
    this.normal = new Float32Array(verts * 3);
    this.uv = new Float32Array(verts * 2);
    this.color = new Float32Array(verts * 4);
    geo.setAttribute('position', new THREE.BufferAttribute(this.position, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.normal, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.color, 4).setUsage(THREE.DynamicDrawUsage));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const old = this.mesh;
    const parent = old?.parent;
    if (old) { parent?.remove(old); old.geometry.dispose(); }
    this.geometry = geo;

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = 2;
    mesh.userData.postfxIgnore = true;
    this.mesh = mesh;
    (parent || this.game?.scene)?.add(mesh);

    this.slots = new Array(n);
    for (let i = 0; i < n; i++) {
      this.slots[i] = {
        index: i, used: false, birth: 0, life: 30, fadeIn: 0.1, fadeOut: 2.5,
        alpha: 0, target: 1, verts: 0, permanent: false,
        pos: new THREE.Vector3(), r: 0.2, g: 0, b: 0, tint: new THREE.Color(1, 1, 1),
        grow: 0, growRate: 0, base: null,
      };
    }
    this._growing.length = 0;
    this._dirtyMin = Infinity;
    this._dirtyMax = -Infinity;
  }

  /* --------------------------------------------------------------- spawn */

  /**
   * Project a decal.
   *
   * @param {Object} o
   *   point      THREE.Vector3 impact point (world)
   *   normal     THREE.Vector3 surface normal (world)
   *   tile       atlas tile index (see DECAL in Textures.js)
   *   size       decal diameter in metres
   *   depth      projection box depth (defaults to size * 0.75)
   *   rotation   roll around the normal; random when omitted
   *   life       seconds before it starts fading (Infinity for permanent)
   *   color      THREE.Color multiplier
   *   opacity    peak alpha
   *   grow       seconds to grow from a point to full size (blood pools)
   *   dir        incoming direction; biases the projection basis so directional
   *              art (spatter, drips) points the right way
   * @returns {Object|null} the slot
   */
  spawn(o) {
    if (!this.capacity || !o?.point || !o?.normal) return null;
    const slot = this._acquire(o.point);
    if (!slot) return null;

    const size = Math.max(0.02, o.size ?? 0.24);
    const depth = Math.max(0.02, o.depth ?? size * 0.8);
    const n = V.a.copy(o.normal);
    if (n.lengthSq() < 1e-8) n.set(0, 1, 0); else n.normalize();

    // Basis: z = surface normal, x/y span the projection plane. A directional
    // hint (bullet direction) aligns +y with the spray so spatter art reads.
    let t;
    if (o.dir) {
      t = V.b.copy(o.dir).addScaledVector(n, -o.dir.dot(n));
      if (t.lengthSq() < 1e-6) t = perpendicular(n, V.b);
      else t.normalize();
    } else {
      const roll = o.rotation ?? Math.random() * TAU;
      const p = perpendicular(n, V.b);
      const q = V.c.crossVectors(n, p);
      t = V.b.copy(p).multiplyScalar(Math.cos(roll)).addScaledVector(q, Math.sin(roll)).normalize();
    }
    const b = V.c.crossVectors(n, t).normalize();

    slot.used = true;
    slot.birth = this._time;
    slot.life = o.life ?? 45;
    slot.permanent = o.life === Infinity;
    slot.fadeIn = o.fadeIn ?? 0.08;
    slot.fadeOut = o.fadeOut ?? Math.min(4, (slot.life || 1) * 0.25);
    slot.alpha = 0;
    slot.target = clamp(o.opacity ?? 1, 0, 1);
    slot.pos.copy(o.point);
    slot.tint.set(o.color ? o.color.r : 1, o.color ? o.color.g : 1, o.color ? o.color.b : 1);
    slot.grow = o.grow ? 0 : 1;
    slot.growRate = o.grow ? 1 / Math.max(0.05, o.grow) : 0;

    const tile = (o.tile ?? 0) % (this.tiles * this.tiles);
    const built = this._project(slot, o.point, t, b, n, size, depth, tile, o.flipU === true);
    if (!built) { slot.used = false; return null; }

    if (slot.growRate > 0) {
      if (!slot.base) slot.base = new Float32Array(VERTS_PER_SLOT * 3);
      const off = slot.index * VERTS_PER_SLOT * 3;
      slot.base.set(this.position.subarray(off, off + VERTS_PER_SLOT * 3));
      if (this._growing.indexOf(slot) < 0) this._growing.push(slot);
    } else if (slot.base) {
      const i = this._growing.indexOf(slot);
      if (i >= 0) this._growing.splice(i, 1);
    }

    this._writeColor(slot);
    return slot;
  }

  _acquire(point) {
    const slots = this.slots;
    for (let i = 0; i < slots.length; i++) if (!slots[i].used) return slots[i];
    // Everything is live: evict on age, weighted by distance so the decal you
    // are standing in front of survives longer than one across the map.
    const cam = this.game?.camera?.position;
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s.permanent && slots.length > 8) continue;
      const age = this._time - s.birth;
      const d = cam ? s.pos.distanceTo(cam) : 0;
      const score = age + d * 0.35;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    if (!best) best = slots[0];
    const gi = this._growing.indexOf(best);
    if (gi >= 0) this._growing.splice(gi, 1);
    return best;
  }

  /* ------------------------------------------------------------ projection */

  _project(slot, center, tx, ty, tz, size, depth, tile, flipU) {
    const hx = size * 0.5, hy = size * 0.5, hz = depth * 0.5;
    const base = slot.index * VERTS_PER_SLOT;
    this._writeVerts = 0;
    this._slotBase = base;
    this._hx = hx; this._hy = hy; this._hz = hz;
    this._tile = tile;
    this._flipU = flipU;
    this._cx = center.x; this._cy = center.y; this._cz = center.z;
    this._tx = tx; this._ty = ty; this._tz = tz;

    const phys = this.game?.physics;
    const world = phys?.world;
    const r = Math.sqrt(hx * hx + hy * hy + hz * hz);
    let got = 0;

    if (world?.built && typeof world.forEachTriangleInBox === 'function') {
      this._box.min.set(center.x - r, center.y - r, center.z - r);
      this._box.max.set(center.x + r, center.y + r, center.z + r);
      if (!this._collectCb) this._collectCb = (tri) => this._clipTriangle(tri);
      try {
        world.forEachTriangleInBox(this._box, this._collectCb);
      } catch (e) { /* BVH mid-rebuild; fall through to the quad */ }
      got = this._writeVerts;
    }

    if (got < 3) {
      this._quadFallback(center, tx, ty, tz, hx, hy);
      got = this._writeVerts;
    }

    // Degenerate the tail of the slot.
    for (let i = this._writeVerts; i < VERTS_PER_SLOT; i++) {
      const o = (base + i) * 3;
      this.position[o] = 0; this.position[o + 1] = -9999; this.position[o + 2] = 0;
      this.normal[o] = 0; this.normal[o + 1] = 1; this.normal[o + 2] = 0;
      const u = (base + i) * 2;
      this.uv[u] = 0; this.uv[u + 1] = 0;
    }
    slot.verts = this._writeVerts;
    this._markDirty(slot.index);
    return got >= 3;
  }

  /** Sutherland–Hodgman clip of one world triangle against the decal box. */
  _clipTriangle(tri) {
    if (this._writeVerts >= VERTS_PER_SLOT - 3) return true;   // slot full: stop

    const a = tri.a, b = tri.b, c = tri.c;
    // world -> decal space
    const A = this._polyA[0], B = this._polyA[1], C = this._polyA[2];
    this._toLocal(a, A); this._toLocal(b, B); this._toLocal(c, C);

    const hx = this._hx, hy = this._hy, hz = this._hz;
    // Fast reject: entirely outside one slab.
    if ((A.x > hx && B.x > hx && C.x > hx) || (A.x < -hx && B.x < -hx && C.x < -hx)) return false;
    if ((A.y > hy && B.y > hy && C.y > hy) || (A.y < -hy && B.y < -hy && C.y < -hy)) return false;
    if ((A.z > hz && B.z > hz && C.z > hz) || (A.z < -hz && B.z < -hz && C.z < -hz)) return false;

    // Backface / grazing reject in decal space (+z is the surface normal).
    const ux = B.x - A.x, uy = B.y - A.y, uz = B.z - A.z;
    const vx = C.x - A.x, vy = C.y - A.y, vz = C.z - A.z;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nl < 1e-9) return false;
    nx /= nl; ny /= nl; nz /= nl;
    if (nz < 0.2) return false;

    let src = this._polyA, dst = this._polyB;
    let n = 3;
    n = clipAxis(src, n, dst, 0, 1, hx); if (n < 3) return false;
    let tmp = src; src = dst; dst = tmp;
    n = clipAxis(src, n, dst, 0, -1, hx); if (n < 3) return false;
    tmp = src; src = dst; dst = tmp;
    n = clipAxis(src, n, dst, 1, 1, hy); if (n < 3) return false;
    tmp = src; src = dst; dst = tmp;
    n = clipAxis(src, n, dst, 1, -1, hy); if (n < 3) return false;
    tmp = src; src = dst; dst = tmp;
    n = clipAxis(src, n, dst, 2, 1, hz); if (n < 3) return false;
    tmp = src; src = dst; dst = tmp;
    n = clipAxis(src, n, dst, 2, -1, hz); if (n < 3) return false;
    tmp = src; src = dst; dst = tmp;

    // Fan triangulate.
    const wn = V.d.set(
      this._tx.x * nx + this._ty.x * ny + this._tz.x * nz,
      this._tx.y * nx + this._ty.y * ny + this._tz.y * nz,
      this._tx.z * nx + this._ty.z * ny + this._tz.z * nz,
    );
    for (let i = 1; i < n - 1; i++) {
      if (this._writeVerts >= VERTS_PER_SLOT - 3) return true;
      this._emit(src[0], wn, nz);
      this._emit(src[i], wn, nz);
      this._emit(src[i + 1], wn, nz);
    }
    return false;
  }

  _toLocal(p, out) {
    const dx = p.x - this._cx, dy = p.y - this._cy, dz = p.z - this._cz;
    out.set(
      dx * this._tx.x + dy * this._tx.y + dz * this._tx.z,
      dx * this._ty.x + dy * this._ty.y + dz * this._ty.z,
      dx * this._tz.x + dy * this._tz.y + dz * this._tz.z,
    );
  }

  _emit(local, worldNormal, facing) {
    const i = this._slotBase + this._writeVerts;
    const o = i * 3, u = i * 2;
    // Lift along the surface normal: enough to clear the receiving polygon,
    // small enough not to visibly float at grazing angles.
    const lift = 0.0035 + this._hz * 0.012;
    this.position[o] = this._cx + this._tx.x * local.x + this._ty.x * local.y + this._tz.x * (local.z + lift);
    this.position[o + 1] = this._cy + this._tx.y * local.x + this._ty.y * local.y + this._tz.y * (local.z + lift);
    this.position[o + 2] = this._cz + this._tx.z * local.x + this._ty.z * local.y + this._tz.z * (local.z + lift);
    this.normal[o] = worldNormal.x;
    this.normal[o + 1] = worldNormal.y;
    this.normal[o + 2] = worldNormal.z;

    const tiles = this.tiles;
    const col = this._tile % tiles;
    const row = Math.floor(this._tile / tiles);
    let su = local.x / (this._hx * 2) + 0.5;
    const sv = local.y / (this._hy * 2) + 0.5;
    if (this._flipU) su = 1 - su;
    this.uv[u] = (col + clamp(su, 0.001, 0.999)) / tiles;
    this.uv[u + 1] = 1 - (row + clamp(1 - sv, 0.001, 0.999)) / tiles;
    this._writeVerts++;
  }

  _quadFallback(center, tx, ty, tz, hx, hy) {
    const pts = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, -hy], [hx, hy], [-hx, hy]];
    const wn = V.d.copy(tz);
    for (let i = 0; i < 6; i++) {
      const p = this._polyA[0].set(pts[i][0], pts[i][1], 0);
      this._emit(p, wn, 1);
    }
  }

  /* ---------------------------------------------------------------- update */

  _writeColor(slot) {
    const a = slot.alpha * slot.target;
    const base = slot.index * VERTS_PER_SLOT;
    const col = this.color;
    const r = slot.tint.r, g = slot.tint.g, b = slot.tint.b;
    for (let i = 0; i < VERTS_PER_SLOT; i++) {
      const o = (base + i) * 4;
      col[o] = r; col[o + 1] = g; col[o + 2] = b; col[o + 3] = a;
    }
    this._markDirty(slot.index);
  }

  _markDirty(index) {
    if (index < this._dirtyMin) this._dirtyMin = index;
    if (index > this._dirtyMax) this._dirtyMax = index;
  }

  update(dt, time) {
    this._time = time;
    const slots = this.slots;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (!s.used) continue;
      const age = time - s.birth;
      let a = s.alpha;
      if (age < s.fadeIn) a = age / Math.max(1e-4, s.fadeIn);
      else if (!s.permanent && age > s.life - s.fadeOut) {
        a = saturate((s.life - age) / Math.max(1e-4, s.fadeOut));
        if (a <= 0.001) { s.used = false; a = 0; }
      } else a = 1;
      if (Math.abs(a - s.alpha) > 0.003 || (a === 0 && s.alpha !== 0)) {
        s.alpha = a;
        this._writeColor(s);
      }
    }

    // Growth animation (blood pools spreading). Scaling the projected mesh
    // about its centre is exact for the flat surfaces pools land on.
    for (let i = this._growing.length - 1; i >= 0; i--) {
      const s = this._growing[i];
      if (!s.used || !s.base) { this._growing.splice(i, 1); continue; }
      s.grow = Math.min(1, s.grow + dt * s.growRate);
      const k = smoothstep(s.grow) * 0.92 + 0.08;
      const off = s.index * VERTS_PER_SLOT * 3;
      const cx = s.pos.x, cy = s.pos.y, cz = s.pos.z;
      for (let v = 0; v < VERTS_PER_SLOT; v++) {
        const o = off + v * 3;
        if (s.base[o - off + 1] === -9999) continue;
        this.position[o] = cx + (s.base[v * 3] - cx) * k;
        this.position[o + 1] = cy + (s.base[v * 3 + 1] - cy) * k;
        this.position[o + 2] = cz + (s.base[v * 3 + 2] - cz) * k;
      }
      this._markDirty(s.index);
      if (s.grow >= 1) this._growing.splice(i, 1);
    }

    if (this._dirtyMax >= this._dirtyMin) {
      const first = this._dirtyMin * VERTS_PER_SLOT;
      const count = (this._dirtyMax - this._dirtyMin + 1) * VERTS_PER_SLOT;
      const attrs = this.geometry.attributes;
      for (const key of ['position', 'normal', 'uv', 'color']) {
        const attr = attrs[key];
        const size = attr.itemSize;
        if (typeof attr.clearUpdateRanges === 'function') {
          attr.clearUpdateRanges();
          attr.addUpdateRange(first * size, count * size);
        } else if (attr.updateRange) {
          attr.updateRange.offset = first * size;
          attr.updateRange.count = count * size;
        }
        attr.needsUpdate = true;
      }
      this._dirtyMin = Infinity;
      this._dirtyMax = -Infinity;
    }
  }

  clear() {
    for (const s of this.slots) { s.used = false; s.alpha = 0; }
    this.color.fill(0);
    this.position.fill(0);
    this._growing.length = 0;
    for (const key of ['position', 'color']) {
      const a = this.geometry.attributes[key];
      if (typeof a.clearUpdateRanges === 'function') a.clearUpdateRanges();
      a.needsUpdate = true;
    }
    this._dirtyMin = Infinity;
    this._dirtyMax = -Infinity;
  }

  stats() {
    let used = 0;
    for (const s of this.slots) if (s.used) used++;
    return { used, capacity: this.capacity };
  }

  dispose() {
    this.geometry?.dispose();
    this.material?.dispose();
    this.mesh?.parent?.remove(this.mesh);
  }
}

/* -------------------------------------------------------------------------- */

/** Clip polygon `src[0..n)` against `sign * axis <= limit`, into `dst`. */
function clipAxis(src, n, dst, axis, sign, limit) {
  const key = axis === 0 ? 'x' : axis === 1 ? 'y' : 'z';
  let out = 0;
  for (let i = 0; i < n; i++) {
    const a = src[i];
    const b = src[(i + 1) % n];
    const da = sign * a[key] - limit;
    const db = sign * b[key] - limit;
    const ain = da <= 0, bin = db <= 0;
    if (ain) { if (out < dst.length) dst[out++].copy(a); }
    if (ain !== bin) {
      const t = da / (da - db);
      if (out < dst.length) {
        dst[out++].set(
          a.x + (b.x - a.x) * t,
          a.y + (b.y - a.y) * t,
          a.z + (b.z - a.z) * t,
        );
      }
    }
  }
  return out;
}
