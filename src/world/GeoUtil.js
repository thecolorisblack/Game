import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Geometry primitives and batching for the level generator.
 *
 * Two rules drive everything in here:
 *
 * 1. **No perfectly sharp edges.** A 90-degree corner has zero width, so it
 *    never catches a specular highlight and the silhouette reads as a
 *    programmer box. `bevelBox` chamfers all twelve edges, which costs 44
 *    triangles instead of 12 and is the single cheapest thing that makes
 *    procedural architecture stop looking procedural.
 *
 * 2. **UVs are metres.** Every generator writes texture coordinates in world
 *    units, and the material is asked for with `scale = 1 / tileMeters`. That
 *    way a wall built from nine separate boxes still tiles continuously, and
 *    the same material can be dropped on a kerb and a minaret without anyone
 *    hand-authoring UVs.
 *
 * Everything is merged before it reaches the scene: `Batcher` collects
 * transformed geometry per (material, spatial chunk) and emits one mesh per
 * bucket, `InstanceBatcher` does the same for repeated props via InstancedMesh.
 */

/* ------------------------------------------------------------------ */
/* attribute plumbing                                                  */
/* ------------------------------------------------------------------ */

const KEEP = ['position', 'normal', 'uv'];

/**
 * Make a geometry safe to merge: exactly position/normal/uv, always indexed.
 * three's primitives already satisfy most of this; user geometry and
 * ExtrudeGeometry do not.
 */
export function normalizeGeo(geo) {
  for (const name of Object.keys(geo.attributes)) {
    if (!KEEP.includes(name)) geo.deleteAttribute(name);
  }
  if (!geo.attributes.normal) geo.computeVertexNormals();
  if (!geo.attributes.uv) {
    const n = geo.attributes.position.count;
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  if (!geo.index) {
    const n = geo.attributes.position.count;
    const arr = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) arr[i] = i;
    geo.setIndex(new THREE.BufferAttribute(arr, 1));
  }
  geo.clearGroups();
  return geo;
}

/** Multiply an existing 0..1 UV set into metres. */
export function scaleUV(geo, su, sv = su, ou = 0, ov = 0) {
  const uv = geo.attributes.uv;
  if (!uv) return geo;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * su + ou, uv.getY(i) * sv + ov);
  }
  uv.needsUpdate = true;
  return geo;
}

/** Planar-project UVs from world position, picking the axis per triangle normal. */
export function triplanarUV(geo, scale = 1, offset = [0, 0, 0]) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + offset[0];
    const y = pos.getY(i) + offset[1];
    const z = pos.getZ(i) + offset[2];
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    let u, v;
    if (ny >= nx && ny >= nz) { u = x; v = z; }
    else if (nx >= nz) { u = z; v = y; }
    else { u = x; v = y; }
    uv[i * 2] = u * scale;
    uv[i * 2 + 1] = v * scale;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/* ------------------------------------------------------------------ */
/* chamfered box                                                       */
/* ------------------------------------------------------------------ */

/**
 * Axis-aligned box with all twelve edges chamfered, centred on the origin.
 *
 * @param {number} w,h,d      full extents in metres
 * @param {number} bevel      chamfer width; clamped to 32% of the shortest edge
 * @param {object} opts       { uvOffset:[x,y,z], uvScale }
 */
export function bevelBox(w, h, d, bevel = 0.018, opts = {}) {
  const half = [w * 0.5, h * 0.5, d * 0.5];
  const e = Math.max(0, Math.min(bevel, Math.min(w, h, d) * 0.32));
  const off = opts.uvOffset || ZERO3;
  const us = opts.uvScale ?? 1;

  if (e <= 1e-5) return plainBox(w, h, d, off, us);

  const pos = [], nrm = [], uvs = [], idx = [];

  const uvFor = (p, axis) => {
    if (axis === 0) return [(p[2] + off[2]) * us, (p[1] + off[1]) * us];
    if (axis === 1) return [(p[0] + off[0]) * us, (p[2] + off[2]) * us];
    return [(p[0] + off[0]) * us, (p[1] + off[1]) * us];
  };

  const push = (verts, n, axis) => {
    const base = pos.length / 3;
    for (const p of verts) {
      pos.push(p[0], p[1], p[2]);
      nrm.push(n[0], n[1], n[2]);
      const t = uvFor(p, axis);
      uvs.push(t[0], t[1]);
    }
    // Auto-orient: compare the winding normal against the intended normal so
    // no generator below has to reason about handedness.
    const a = verts[0], b = verts[1], c = verts[2];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const flip = (cx * n[0] + cy * n[1] + cz * n[2]) < 0;
    if (verts.length === 3) {
      if (flip) idx.push(base, base + 2, base + 1); else idx.push(base, base + 1, base + 2);
    } else if (flip) {
      idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    } else {
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  };

  const inset = [half[0] - e, half[1] - e, half[2] - e];

  // six faces
  for (let k = 0; k < 3; k++) {
    const u = (k + 1) % 3, v = (k + 2) % 3;
    for (const s of [-1, 1]) {
      const n = [0, 0, 0]; n[k] = s;
      const verts = [];
      for (const [su, sv] of QUAD) {
        const p = [0, 0, 0];
        p[k] = s * half[k]; p[u] = su * inset[u]; p[v] = sv * inset[v];
        verts.push(p);
      }
      push(verts, n, k);
    }
  }

  // twelve edges
  for (let k1 = 0; k1 < 3; k1++) {
    for (let k2 = k1 + 1; k2 < 3; k2++) {
      const k3 = 3 - k1 - k2;
      for (const s1 of [-1, 1]) {
        for (const s2 of [-1, 1]) {
          const n = [0, 0, 0];
          n[k1] = s1 * Math.SQRT1_2; n[k2] = s2 * Math.SQRT1_2;
          const mk = (a1, a2, a3) => {
            const p = [0, 0, 0];
            p[k1] = a1; p[k2] = a2; p[k3] = a3;
            return p;
          };
          const verts = [
            mk(s1 * half[k1], s2 * inset[k2], -inset[k3]),
            mk(s1 * half[k1], s2 * inset[k2], inset[k3]),
            mk(s1 * inset[k1], s2 * half[k2], inset[k3]),
            mk(s1 * inset[k1], s2 * half[k2], -inset[k3]),
          ];
          push(verts, n, half[k1] >= half[k2] ? k2 : k1);
        }
      }
    }
  }

  // eight corners
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const n = [sx * 0.5774, sy * 0.5774, sz * 0.5774];
        const verts = [
          [sx * half[0], sy * inset[1], sz * inset[2]],
          [sx * inset[0], sy * half[1], sz * inset[2]],
          [sx * inset[0], sy * inset[1], sz * half[2]],
        ];
        push(verts, n, 1);
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

const QUAD = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
const ZERO3 = [0, 0, 0];

/** 12-triangle box for collision proxies and geometry the player never nears. */
export function plainBox(w, h, d, off = ZERO3, us = 1) {
  const g = new THREE.BoxGeometry(w, h, d);
  const pos = g.attributes.position, nor = g.attributes.normal;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + off[0], y = pos.getY(i) + off[1], z = pos.getZ(i) + off[2];
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i));
    if (nx > 0.5) uv.setXY(i, z * us, y * us);
    else if (ny > 0.5) uv.setXY(i, x * us, z * us);
    else uv.setXY(i, x * us, y * us);
  }
  uv.needsUpdate = true;
  return g;
}

/* ------------------------------------------------------------------ */
/* revolved / swept primitives                                         */
/* ------------------------------------------------------------------ */

export function cylinderGeo(rTop, rBot, h, seg = 12, openEnded = false) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, openEnded);
  const r = (rTop + rBot) * 0.5;
  scaleUV(g, 2 * Math.PI * r, h);
  return normalizeGeo(g);
}

export function tubeGeo(points, radius, radial = 5, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => (p.isVector3 ? p : new THREE.Vector3(p[0], p[1], p[2]))), closed);
  const len = curve.getLength();
  const seg = Math.max(4, Math.min(96, Math.round(len * 1.6)));
  const g = new THREE.TubeGeometry(curve, seg, radius, radial, closed);
  scaleUV(g, len, 2 * Math.PI * radius);
  return normalizeGeo(g);
}

export function sphereGeo(r, w = 12, h = 8) {
  const g = new THREE.SphereGeometry(r, w, h);
  scaleUV(g, 2 * Math.PI * r, Math.PI * r);
  return normalizeGeo(g);
}

export function latheGeo(points, seg = 14) {
  const g = new THREE.LatheGeometry(points.map((p) => new THREE.Vector2(p[0], p[1])), seg);
  let maxR = 0.2;
  for (const p of points) maxR = Math.max(maxR, p[0]);
  scaleUV(g, 2 * Math.PI * maxR, maxR * 2);
  return normalizeGeo(g);
}

export function torusGeo(r, tube, rSeg = 6, tSeg = 16) {
  const g = new THREE.TorusGeometry(r, tube, rSeg, tSeg);
  scaleUV(g, 2 * Math.PI * r, 2 * Math.PI * tube);
  return normalizeGeo(g);
}

/**
 * A hanging cable. Catenary approximated by a parabola, which is within a few
 * millimetres over the spans used here and far cheaper to evaluate.
 */
export function catenaryPoints(a, b, sag, n = 10) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t - sag * 4 * t * (1 - t);
    const z = a.z + (b.z - a.z) * t;
    pts.push(new THREE.Vector3(x, y, z));
  }
  return pts;
}

/* ------------------------------------------------------------------ */
/* cloth                                                               */
/* ------------------------------------------------------------------ */

/**
 * A sagging fabric panel in the XZ plane (canopies, tarpaulins). Sag is
 * strongest mid-span and the surface carries a little high-frequency wrinkle so
 * the specular breaks up instead of reading as a flat card.
 */
export function clothGeo(w, d, opts = {}) {
  const sx = opts.segX ?? 8, sz = opts.segZ ?? 6;
  const sag = opts.sag ?? 0.12;
  const wrinkle = opts.wrinkle ?? 0.018;
  const tiltZ = opts.tilt ?? 0;
  const g = new THREE.PlaneGeometry(w, d, sx, sz);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const u = (x / w) + 0.5, v = (z / d) + 0.5;
    const bow = Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
    const wr = Math.sin(u * 21.7 + v * 3.1) * Math.cos(v * 17.3) * wrinkle;
    pos.setY(i, -sag * bow + wr + tiltZ * v);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  scaleUV(g, w, d);
  return normalizeGeo(g);
}

/**
 * A wall-mounted awning: leaves the facade horizontally, curves down and out,
 * and ends in a scalloped valance. Built in local space with the wall at z=0
 * and the awning extending toward +z.
 */
export function awningGeo(w, depth, drop, opts = {}) {
  const segX = opts.segX ?? 10, segZ = opts.segZ ?? 6;
  const g = new THREE.PlaneGeometry(w, depth, segX, segZ);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i) + depth * 0.5;      // 0 at wall .. depth at edge
    const t = z / depth;
    const scallop = Math.sin((x / w + 0.5) * Math.PI * (opts.scallops ?? 5)) * 0.05 * Math.pow(t, 6);
    const sagX = Math.cos((x / w) * Math.PI) * 0.05 * t;
    pos.setY(i, -drop * t * t - scallop - sagX);
    pos.setZ(i, z);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  scaleUV(g, w, depth);
  return normalizeGeo(g);
}

/**
 * Alpha-tested foliage card: a quad bowed around its vertical axis so it never
 * disappears edge-on and catches a gradient across its width.
 */
export function cardGeo(w, h, bow = 0.16, segX = 3, segY = 3) {
  const g = new THREE.PlaneGeometry(w, h, segX, segY);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i) / w;
    const v = pos.getY(i) / h + 0.5;
    pos.setZ(i, -bow * (0.25 - u * u) * 4 * (0.35 + 0.65 * v));
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  g.translate(0, h * 0.5, 0);
  return normalizeGeo(g);
}

/* ------------------------------------------------------------------ */
/* extrusion                                                           */
/* ------------------------------------------------------------------ */

/**
 * Extrude a closed 2D profile along Z. Sides are flat-shaded per face, caps are
 * triangulated, and both cap rings are inset by `endBevel` so the extrusion has
 * a chamfered end rather than a razor edge. Jersey barriers, kerbstones,
 * I-beams, cornices and gutters all come out of here.
 *
 * @param {number[][]} profile counter-clockwise [x,y] pairs, not repeating the first
 */
export function extrudeProfile(profile, length, opts = {}) {
  const hz = length * 0.5;
  const bev = opts.endBevel ?? 0.02;
  const uvScale = opts.uvScale ?? 1;
  const n = profile.length;

  // centroid, used to inset the bevel ring
  let cx = 0, cy = 0;
  for (const p of profile) { cx += p[0]; cy += p[1]; }
  cx /= n; cy /= n;
  const inset = profile.map(([x, y]) => {
    const dx = x - cx, dy = y - cy;
    const l = Math.hypot(dx, dy) || 1;
    return [x - (dx / l) * bev, y - (dy / l) * bev];
  });

  const rings = [
    { pts: inset, z: -hz },
    { pts: profile, z: -hz + bev },
    { pts: profile, z: hz - bev },
    { pts: inset, z: hz },
  ];

  const pos = [], nrm = [], uvs = [], idx = [];
  const pushTri = (a, b, c) => idx.push(a, b, c);

  // cumulative perimeter for the U coordinate
  const peri = [0];
  for (let i = 0; i < n; i++) {
    const a = profile[i], b = profile[(i + 1) % n];
    peri.push(peri[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }

  for (let r = 0; r < rings.length - 1; r++) {
    const r0 = rings[r], r1 = rings[r + 1];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = [r0.pts[i][0], r0.pts[i][1], r0.z];
      const b = [r0.pts[j][0], r0.pts[j][1], r0.z];
      const c = [r1.pts[j][0], r1.pts[j][1], r1.z];
      const d = [r1.pts[i][0], r1.pts[i][1], r1.z];
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const base = pos.length / 3;
      const us = [peri[i], peri[j], peri[j], peri[i]];
      const vs = [r0.z, r0.z, r1.z, r1.z];
      for (let k = 0; k < 4; k++) {
        const p = [a, b, c, d][k];
        pos.push(p[0], p[1], p[2]);
        nrm.push(nx, ny, nz);
        uvs.push(us[k] * uvScale, vs[k] * uvScale);
      }
      pushTri(base, base + 1, base + 2);
      pushTri(base, base + 2, base + 3);
    }
  }

  // caps
  const contour = inset.map(([x, y]) => new THREE.Vector2(x, y));
  let faces = [];
  try { faces = THREE.ShapeUtils.triangulateShape(contour, []); } catch { faces = []; }
  for (const [zSign, ring] of [[-1, rings[0]], [1, rings[3]]]) {
    const base = pos.length / 3;
    for (let i = 0; i < n; i++) {
      pos.push(ring.pts[i][0], ring.pts[i][1], ring.z);
      nrm.push(0, 0, zSign);
      uvs.push(ring.pts[i][0] * uvScale, ring.pts[i][1] * uvScale);
    }
    for (const f of faces) {
      if (zSign < 0) pushTri(base + f[0], base + f[2], base + f[1]);
      else pushTri(base + f[0], base + f[1], base + f[2]);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

/**
 * Lumpy sphere — sandbags, rubble boulders, produce sacks. The deformation is
 * deterministic in the vertex index so a batch of them looks hand-packed rather
 * than instanced.
 */
export function blobGeo(r, w = 10, h = 7, amount = 0.22, seed = 1) {
  const g = new THREE.SphereGeometry(r, w, h);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = Math.sin(x * 5.1 + seed) * Math.cos(z * 4.3 - seed * 0.7) * Math.sin(y * 3.7 + seed * 1.3);
    const s = 1 + n * amount;
    pos.setXYZ(i, x * s, y * s, z * s);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  scaleUV(g, 2 * Math.PI * r, Math.PI * r);
  return normalizeGeo(g);
}

/* ------------------------------------------------------------------ */
/* heightfield                                                         */
/* ------------------------------------------------------------------ */

/**
 * Grid mesh in the XZ plane sampled from `fn(x,z)`. Normals are taken from the
 * analytic gradient of the same function rather than from face averaging, so a
 * road crown stays a crisp shading feature instead of a stairstep.
 */
export function heightfieldGeo(x0, z0, x1, z1, step, fn, uvScale = 1) {
  const nx = Math.max(1, Math.round((x1 - x0) / step));
  const nz = Math.max(1, Math.round((z1 - z0) / step));
  const vcount = (nx + 1) * (nz + 1);
  const pos = new Float32Array(vcount * 3);
  const nor = new Float32Array(vcount * 3);
  const uv = new Float32Array(vcount * 2);
  const dx = (x1 - x0) / nx, dz = (z1 - z0) / nz;
  const h = Math.min(dx, dz) * 0.5;

  let p = 0;
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = x0 + i * dx, z = z0 + j * dz;
      const y = fn(x, z);
      pos[p * 3] = x; pos[p * 3 + 1] = y; pos[p * 3 + 2] = z;
      const gx = (fn(x + h, z) - fn(x - h, z)) / (2 * h);
      const gz = (fn(x, z + h) - fn(x, z - h)) / (2 * h);
      const inv = 1 / Math.sqrt(gx * gx + gz * gz + 1);
      nor[p * 3] = -gx * inv; nor[p * 3 + 1] = inv; nor[p * 3 + 2] = -gz * inv;
      uv[p * 2] = x * uvScale; uv[p * 2 + 1] = z * uvScale;
      p++;
    }
  }

  const tri = nx * nz * 6;
  const idx = vcount > 65535 ? new Uint32Array(tri) : new Uint16Array(tri);
  let k = 0;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + nx + 1;
      const d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

/* ------------------------------------------------------------------ */
/* batching                                                            */
/* ------------------------------------------------------------------ */

/**
 * Collects transformed geometry and emits one merged mesh per
 * (material, cast-shadow, spatial chunk) bucket.
 *
 * Chunking matters twice over: it keeps frustum culling useful on a 140 m map,
 * and it bounds how much geometry a single cascade has to re-rasterise into its
 * shadow map. Chunks are deliberately coarse — a hundred 8 m chunks would cost
 * more in draw calls than they save in culled triangles.
 */
export class Batcher {
  constructor(opts = {}) {
    this.chunkSize = opts.chunkSize ?? 46;
    this.buckets = new Map();
    this.count = 0;
  }

  /**
   * @param {THREE.BufferGeometry} geo  source geometry (not retained)
   * @param {THREE.Matrix4|null} matrix world transform
   * @param {object} def { mat, surface, cast, receive, collide, tiling, chunk }
   */
  add(geo, matrix, def) {
    if (!geo) return;
    const g = geo.clone();
    normalizeGeo(g);
    if (matrix) g.applyMatrix4(matrix);

    let cx = 0, cz = 0;
    if (matrix) { cx = matrix.elements[12]; cz = matrix.elements[14]; }
    const cs = this.chunkSize;
    const chunk = def.chunk !== undefined
      ? def.chunk
      : `${Math.floor(cx / cs)}_${Math.floor(cz / cs)}`;

    const mat = def.mat || 'concrete';
    const collide = def.collide !== false;
    // Shadow casting is a property of the bucket, not of the key: splitting
    // casters from non-casters would double the draw calls to save a handful of
    // shadow-map triangles, which is the wrong trade at four cascades.
    // Collision *is* part of the key — a decorative sliver must never be able
    // to make a wall non-solid, nor a wire become something the player snags on.
    const key = `${mat}|${def.tiling ?? 1}|${collide ? 1 : 0}|${chunk}`;

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        mat, tiling: def.tiling ?? 1,
        cast: false, receive: false,
        surface: def.surface || 'concrete',
        collide,
        list: [],
      };
      this.buckets.set(key, bucket);
    }
    if (def.cast !== false) bucket.cast = true;
    if (def.receive !== false) bucket.receive = true;
    bucket.list.push(g);
    this.count++;
  }

  /** Merge, attach materials, register colliders. Returns the meshes created. */
  build(world, group) {
    const out = [];
    for (const [key, b] of this.buckets) {
      if (!b.list.length) continue;
      let merged = null;
      try {
        merged = b.list.length === 1 ? b.list[0] : mergeGeometries(b.list, false);
      } catch (err) {
        console.warn('[World] merge failed for', key, err);
      }
      if (b.list.length > 1) for (const g of b.list) g.dispose();
      b.list.length = 0;
      if (!merged) continue;

      merged.computeBoundingSphere();
      merged.computeBoundingBox();
      const mesh = new THREE.Mesh(merged, world.mat(b.mat, { tiling: b.tiling }));
      mesh.name = `world.${key}`;
      mesh.castShadow = b.cast;
      mesh.receiveShadow = b.receive;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.frustumCulled = true;
      (group || world.root).add(mesh);
      if (b.collide) world.game.physics?.addStatic?.(mesh, { surface: b.surface });
      out.push(mesh);
    }
    this.buckets.clear();
    return out;
  }
}

/**
 * InstancedMesh batching for repeated props. Used where the same geometry
 * appears dozens of times (foliage cards, debris, balusters, roof clutter) and
 * merging would multiply the vertex buffer for no culling benefit.
 */
export class InstanceBatcher {
  constructor() { this.groups = new Map(); }

  add(key, geo, matrix, def = {}) {
    let g = this.groups.get(key);
    if (!g) {
      g = { geo: normalizeGeo(geo.clone()), matrices: [], colors: [], def };
      this.groups.set(key, g);
    }
    g.matrices.push(matrix.clone());
    g.colors.push(def.color || null);
  }

  build(world, group) {
    const out = [];
    for (const [key, g] of this.groups) {
      const n = g.matrices.length;
      if (!n) continue;
      const mat = world.mat(g.def.mat || 'concrete', g.def.matOpts || { tiling: g.def.tiling ?? 1 });
      const mesh = new THREE.InstancedMesh(g.geo, mat, n);
      mesh.name = `inst.${key}`;
      let tinted = false;
      for (let i = 0; i < n; i++) {
        mesh.setMatrixAt(i, g.matrices[i]);
        if (g.colors[i]) { mesh.setColorAt(i, g.colors[i]); tinted = true; }
      }
      if (tinted && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = g.def.cast !== false;
      mesh.receiveShadow = g.def.receive !== false;
      mesh.frustumCulled = true;
      mesh.computeBoundingSphere();
      (group || world.root).add(mesh);
      if (g.def.collide === true) world.game.physics?.addStatic?.(mesh, { surface: g.def.surface || 'concrete' });
      out.push(mesh);
    }
    this.groups.clear();
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* transform helpers                                                   */
/* ------------------------------------------------------------------ */

export function trs(x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ'));
  m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy, sz));
  return m;
}

