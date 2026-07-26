import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * OPERATION BLACKOUT — procedural gun-part geometry toolkit.
 *
 * Everything a weapon is built from lives here. There are no imported meshes in
 * this project, so "modelling" means composing extrudes, lathes and swept
 * profiles in code — and the single thing that separates a AAA-looking firearm
 * from a WebGL demo is that *no surface is a bare box*. Every primitive in this
 * file emits a chamfer: `chamferBox` runs an ExtrudeGeometry bevel on all twelve
 * edges, `cylZ` breaks its end caps, rails are built as real combs of cleats and
 * M-LOK panels are extruded shapes with genuine cut-through holes.
 *
 * Three post-processes make the result read as metal:
 *   - `applyBoxUV`   consistent texel density across the whole weapon, taken in
 *                    part-local space so the PBR maps never swim when the
 *                    viewmodel moves through the world;
 *   - `bakeWear`     per-vertex edge-wear: vertices whose incident normals
 *                    disagree sit on a chamfer, so they get bare-metal vertex
 *                    colour above 1.0 and crevices get contact darkening;
 *   - `mergeParts`   one draw call per material per weapon.
 */

const _m4 = /* @__PURE__ */ new THREE.Matrix4();
const _q = /* @__PURE__ */ new THREE.Quaternion();
const _e = /* @__PURE__ */ new THREE.Euler();
const _v = /* @__PURE__ */ new THREE.Vector3();
const _s = /* @__PURE__ */ new THREE.Vector3();

/* ==================================================================== */
/* shapes                                                                */
/* ==================================================================== */

/** Rounded rectangle centred on the origin. The base primitive for everything. */
export function roundedRectShape(w, h, r) {
  const x = w * 0.5;
  const y = h * 0.5;
  r = Math.max(1e-5, Math.min(r, Math.min(x, y) * 0.99));
  const s = new THREE.Shape();
  s.moveTo(-x + r, -y);
  s.lineTo(x - r, -y);
  s.absarc(x - r, -y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x, y - r);
  s.absarc(x - r, y - r, r, 0, Math.PI / 2, false);
  s.lineTo(-x + r, y);
  s.absarc(-x + r, y - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-x, -y + r);
  s.absarc(-x + r, -y + r, r, Math.PI, Math.PI * 1.5, false);
  s.closePath();
  return s;
}

/** Rounded rectangle as a Path, for use as a hole inside another shape. */
export function roundedRectHole(cx, cy, w, h, r) {
  const x = w * 0.5;
  const y = h * 0.5;
  r = Math.max(1e-5, Math.min(r, Math.min(x, y) * 0.99));
  const p = new THREE.Path();
  p.moveTo(cx - x + r, cy - y);
  p.lineTo(cx + x - r, cy - y);
  p.absarc(cx + x - r, cy - y + r, r, -Math.PI / 2, 0, false);
  p.lineTo(cx + x, cy + y - r);
  p.absarc(cx + x - r, cy + y - r, r, 0, Math.PI / 2, false);
  p.lineTo(cx - x + r, cy + y);
  p.absarc(cx - x + r, cy + y - r, r, Math.PI / 2, Math.PI, false);
  p.lineTo(cx - x, cy - y + r);
  p.absarc(cx - x + r, cy - y + r, r, Math.PI, Math.PI * 1.5, false);
  p.closePath();
  return p;
}

/**
 * Annulus sector (a "bar" of a tube wall). Extruded along Z this is exactly one
 * strut of a birdcage flash hider or one cleat of a heat shield.
 */
export function annulusSectorShape(rOut, rIn, a0, a1, seg = 8) {
  const s = new THREE.Shape();
  s.absarc(0, 0, rOut, a0, a1, false);
  s.absarc(0, 0, rIn, a1, a0, true);
  s.closePath();
  s.curveSegments = seg;
  return s;
}

export function circleHole(cx, cy, r, seg = 12) {
  const p = new THREE.Path();
  p.absarc(cx, cy, Math.max(1e-5, r), 0, Math.PI * 2, true);
  p.curveSegments = seg;
  return p;
}

/** Arbitrary convex/concave polygon in XY. `pts` is [[x,y], ...]. */
export function polyShape(pts) {
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  s.closePath();
  return s;
}

/* ==================================================================== */
/* primitives                                                            */
/* ==================================================================== */

/**
 * A box with every edge chamfered. Extruded along +Z and centred on the origin.
 * `opts.holes` accepts Paths (see roundedRectHole / circleHole) which become
 * real cut-through openings with their own bevelled lips.
 */
export function chamferBox(w, h, d, ch = 0.0012, opts = {}) {
  const c = Math.max(1e-5, Math.min(ch, Math.min(w, h, d) * 0.33));
  const shape = roundedRectShape(w, h, opts.round ?? c * 1.15);
  if (opts.holes) for (const hole of opts.holes) shape.holes.push(hole);
  const depth = Math.max(1e-5, d - c * 2);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: c,
    bevelSize: c,
    bevelOffset: 0,
    bevelSegments: opts.bevelSegments ?? 1,
    curveSegments: opts.curveSegments ?? 2,
    steps: opts.steps ?? 1,
  });
  g.translate(0, 0, -depth * 0.5);
  return g;
}

/** Extrude an arbitrary shape along +Z, chamfered, centred in Z. */
export function extrude(shape, d, ch = 0.0010, opts = {}) {
  const c = Math.max(1e-5, Math.min(ch, d * 0.33));
  const depth = Math.max(1e-5, d - c * 2);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: c,
    bevelSize: c,
    bevelOffset: 0,
    bevelSegments: opts.bevelSegments ?? 1,
    curveSegments: opts.curveSegments ?? 3,
    steps: opts.steps ?? 1,
  });
  g.translate(0, 0, -depth * 0.5);
  return g;
}

/**
 * Surface of revolution from a [[radius, axial], ...] profile.
 * `axis:'z'` (the default for gun parts) puts the axis down -Z/+Z.
 */
export function lathe(profile, segs = 22, opts = {}) {
  const pts = profile.map((p) => new THREE.Vector2(Math.max(2e-5, p[0]), p[1]));
  const g = new THREE.LatheGeometry(pts, segs, opts.phiStart ?? 0, opts.phiLength ?? Math.PI * 2);
  if (opts.axis !== 'y') g.rotateX(Math.PI * 0.5);
  return g;
}

/** Cylinder along Z with broken (chamfered) end caps. */
export function cylZ(r, len, segs = 20, ch = 0.0006) {
  const c = Math.min(ch, Math.min(r, len) * 0.4);
  const h = len * 0.5;
  return lathe([
    [2e-5, -h], [r - c, -h], [r, -h + c], [r, h - c], [r - c, h], [2e-5, h],
  ], segs, {});
}

/** Hollow tube along Z, open at both ends, with chamfered lips. */
export function tubeZ(rOut, rIn, len, segs = 22, ch = 0.0005) {
  const c = Math.min(ch, (rOut - rIn) * 0.45, len * 0.3);
  const h = len * 0.5;
  return lathe([
    [rIn, -h], [rOut - c, -h], [rOut, -h + c], [rOut, h - c], [rOut - c, h], [rIn, h],
    [rIn, h - c * 0.6], [rIn, -h + c * 0.6], [rIn, -h],
  ], segs, {});
}

/** Cone/taper along Z. */
export function taperZ(r0, r1, len, segs = 20, ch = 0.0004) {
  const h = len * 0.5;
  return lathe([
    [2e-5, -h], [r0 - ch, -h], [r0, -h + ch], [r1, h - ch], [r1 - ch, h], [2e-5, h],
  ], segs, {});
}

export function torusZ(r, tube, radial = 20, tubular = 8) {
  const g = new THREE.TorusGeometry(r, tube, tubular, radial);
  return g;
}

export function sphere(r, wSeg = 14, hSeg = 10) {
  return new THREE.SphereGeometry(r, wSeg, hSeg);
}

/** Capsule along Y (three's own, kept for hands/knuckles). */
export function capsuleY(r, len, cap = 6, radial = 10) {
  return new THREE.CapsuleGeometry(r, Math.max(1e-4, len), cap, radial);
}

/* ==================================================================== */
/* transforms                                                            */
/* ==================================================================== */

/**
 * Position / rotate / scale a geometry in place.
 * `{ p:[x,y,z], r:[rx,ry,rz], s:number|[x,y,z] }`
 */
export function place(g, opts = {}) {
  if (opts.s !== undefined) {
    const s = opts.s;
    if (typeof s === 'number') g.scale(s, s, s);
    else g.scale(s[0], s[1], s[2]);
  }
  if (opts.r) {
    g.rotateZ(opts.r[2] || 0);
    g.rotateY(opts.r[1] || 0);
    g.rotateX(opts.r[0] || 0);
  }
  if (opts.p) g.translate(opts.p[0] || 0, opts.p[1] || 0, opts.p[2] || 0);
  return g;
}

/** Convenience: build then place in one expression. */
export function at(g, x, y, z) { g.translate(x, y, z); return g; }

/** Mirror across X (for symmetric left/right details). */
export function mirrorX(g) {
  const c = g.clone();
  c.scale(-1, 1, 1);
  const idx = c.getIndex();
  if (idx) {
    const a = idx.array;
    for (let i = 0; i < a.length; i += 3) { const t = a[i]; a[i] = a[i + 2]; a[i + 2] = t; }
    idx.needsUpdate = true;
  } else {
    const pos = c.attributes.position.array;
    const nrm = c.attributes.normal?.array;
    for (let i = 0; i < pos.length; i += 9) {
      for (let k = 0; k < 3; k++) {
        let t = pos[i + k]; pos[i + k] = pos[i + 6 + k]; pos[i + 6 + k] = t;
        if (nrm) { t = nrm[i + k]; nrm[i + k] = nrm[i + 6 + k]; nrm[i + 6 + k] = t; }
      }
    }
  }
  return c;
}

/**
 * Bend a geometry about the X axis as a function of Z — used to give magazines
 * their real curve instead of the straight blocks most web FPS ship.
 */
export function bendZ(g, curvature, pivotZ = 0) {
  if (!curvature) return g;
  const R = 1 / curvature;
  const pos = g.attributes.position;
  const nrm = g.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i), z = pos.getZ(i);
    const th = (z - pivotZ) * curvature;
    const c = Math.cos(th), s = Math.sin(th);
    pos.setZ(i, pivotZ + (R - y) * s);
    pos.setY(i, R - (R - y) * c);
    if (nrm) {
      const ny = nrm.getY(i), nz = nrm.getZ(i);
      nrm.setY(i, ny * c + nz * s);
      nrm.setZ(i, -ny * s + nz * c);
    }
  }
  pos.needsUpdate = true;
  if (nrm) nrm.needsUpdate = true;
  return g;
}

/* ==================================================================== */
/* composite gun parts                                                   */
/* ==================================================================== */

/**
 * MIL-STD-1913 rail: a continuous base bar plus a comb of trapezoid cleats.
 * The gaps between cleats *are* the slots — no fake normal-mapped rail here.
 * Built along Z, sitting on y=0, centred on x=0.
 */
export function picatinnyRail(length, opts = {}) {
  const width = opts.width ?? 0.0211;
  const pitch = opts.pitch ?? 0.0100;
  const slot = opts.slot ?? 0.0052;
  const baseH = opts.baseH ?? 0.0034;
  const cleatH = opts.cleatH ?? 0.0058;
  const topW = opts.topW ?? width * 0.70;
  const parts = [];

  // base bar (dovetail: slightly narrower at the bottom)
  const base = extrude(polyShape([
    [-width * 0.46, 0], [width * 0.46, 0],
    [width * 0.5, baseH * 0.55], [width * 0.5, baseH],
    [-width * 0.5, baseH], [-width * 0.46, baseH * 0.55],
  ]), length, 0.0006, { curveSegments: 1 });
  parts.push(base);

  const cleatLen = Math.max(0.0018, pitch - slot);
  const n = Math.max(1, Math.floor(length / pitch));
  const start = -length * 0.5 + (length - (n - 1) * pitch) * 0.5;
  const cleatShape = polyShape([
    [-width * 0.5, 0], [width * 0.5, 0],
    [topW * 0.5, cleatH * 0.78], [topW * 0.5, cleatH],
    [-topW * 0.5, cleatH], [-topW * 0.5, cleatH * 0.78],
  ]);
  for (let i = 0; i < n; i++) {
    const c = extrude(cleatShape, cleatLen, 0.0005, { curveSegments: 1 });
    c.translate(0, baseH, start + i * pitch);
    parts.push(c);
  }
  const g = mergeParts(parts);
  g.translate(0, 0, opts.z ?? 0);
  return g;
}

/**
 * A flat M-LOK panel: extruded shape with genuine slot cut-outs (and optional
 * vent holes). Lives in the XZ plane, thickness along Y, centred on the origin.
 */
export function mlokPanel(length, width, thickness, opts = {}) {
  const slotW = opts.slotW ?? 0.0078;
  const slotL = opts.slotL ?? 0.032;
  const pitch = opts.pitch ?? 0.0435;
  const shape = roundedRectShape(width, length, opts.round ?? 0.0022);
  const n = Math.max(0, Math.floor((length - 0.018) / pitch));
  const span = (n - 1) * pitch;
  for (let i = 0; i < n; i++) {
    const z = -span * 0.5 + i * pitch;
    shape.holes.push(roundedRectHole(0, z, slotW, slotL, slotW * 0.49));
  }
  if (opts.vents) {
    for (let i = 0; i < n - 1; i++) {
      const z = -span * 0.5 + (i + 0.5) * pitch;
      shape.holes.push(circleHole(0, z, opts.ventR ?? 0.0032, 10));
    }
  }
  const g = extrude(shape, thickness, opts.ch ?? 0.0007, { curveSegments: 2 });
  // shape is authored in XY with length along Y; stand it up into XZ
  g.rotateX(-Math.PI * 0.5);
  return g;
}

/** A slotted quad-rail / heat-shield panel: parallel ribs with real gaps. */
export function slottedPanel(length, width, thickness, slots = 7, opts = {}) {
  const shape = roundedRectShape(width, length, 0.0018);
  const gapW = opts.slotW ?? width * 0.52;
  const gapL = opts.slotL ?? (length / slots) * 0.62;
  for (let i = 0; i < slots; i++) {
    const z = -length * 0.5 + (length / slots) * (i + 0.5);
    shape.holes.push(roundedRectHole(0, z, gapW, gapL, Math.min(gapW, gapL) * 0.4));
  }
  const g = extrude(shape, thickness, 0.0006, { curveSegments: 2 });
  g.rotateX(-Math.PI * 0.5);
  return g;
}

/**
 * Socket-head fastener, axis along Z, face at z=0. The head is a lathe cup so
 * the recess is real geometry rather than a coplanar decal that z-fights.
 */
export function screwZ(r = 0.0022, headH = 0.0011, shaft = 0.003) {
  const ri = r * 0.46;
  const head = lathe([
    [2e-5, -headH], [r, -headH], [r, -headH * 0.35], [r * 0.88, 0],
    [ri, 0], [ri, -headH * 0.55], [2e-5, -headH * 0.55],
  ], 12);
  const stem = cylZ(r * 0.55, shaft, 8, 0.0002);
  stem.translate(0, 0, -headH - shaft * 0.5);
  return mergeParts([head, stem]);
}

/** Hex bolt head, axis along Z. */
export function hexZ(r = 0.0028, h = 0.0022) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return extrude(polyShape(pts), h, 0.0004, { curveSegments: 1 });
}

/**
 * Finger-groove / knurl band on a cylinder: a lathe with a saw-tooth radial
 * profile, cheap and it catches the key light exactly like real knurling.
 */
export function knurlBand(r, len, ridges = 9, depth = 0.0006, segs = 18) {
  const prof = [];
  const step = len / ridges;
  prof.push([r - depth, -len * 0.5]);
  for (let i = 0; i < ridges; i++) {
    const z0 = -len * 0.5 + i * step;
    prof.push([r, z0 + step * 0.28]);
    prof.push([r, z0 + step * 0.56]);
    prof.push([r - depth, z0 + step * 0.92]);
  }
  prof.push([r - depth, len * 0.5]);
  return lathe(prof, segs, {});
}

/** Longitudinal flutes cut into a barrel/tube — reads as machined steel. */
export function fluteRing(r, len, count = 6, depth = 0.0008, width = 0.28) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const g = new THREE.CylinderGeometry(depth, depth, len, 6, 1, false);
    g.rotateX(Math.PI * 0.5);
    g.scale(width * 4, 1, 1);
    g.translate(Math.cos(a) * r, Math.sin(a) * r, 0);
    parts.push(g);
  }
  return mergeParts(parts);
}

/* ==================================================================== */
/* uv / wear / merge                                                     */
/* ==================================================================== */

/**
 * Triplanar-style UV projection taken in local space. Constant texel density
 * over the whole weapon and — critically — stable while the viewmodel flies
 * through the world, which a world-space triplanar shader would not be.
 */
export function applyBoxUV(g, scale = 3.0, offset = 0) {
  const pos = g.attributes.position;
  let nrm = g.attributes.normal;
  if (!nrm) { g.computeVertexNormals(); nrm = g.attributes.normal; }
  const n = pos.count;
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const nx = Math.abs(nrm.getX(i));
    const ny = Math.abs(nrm.getY(i));
    const nz = Math.abs(nrm.getZ(i));
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let u, v;
    if (nx >= ny && nx >= nz) { u = z; v = y; }
    else if (ny >= nz) { u = x; v = z; }
    else { u = x; v = y; }
    uv[i * 2] = u * scale + offset;
    uv[i * 2 + 1] = v * scale + offset;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

function hash3(x, y, z) {
  let h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}

/**
 * Per-vertex edge wear + crevice darkening.
 *
 * A vertex sitting on a chamfer is one whose incident face normals disagree.
 * We gather normals by quantised position, measure the disagreement, gate it on
 * convexity (outward-facing corners wear, inward-facing ones collect grime) and
 * write the result to the colour attribute. Vertex colour is a multiplier, so
 * values above 1 on a dark parkerised finish read exactly as rubbed-through
 * bare steel — the single cheapest "this weapon has been carried" signal there
 * is.
 */
export function bakeWear(g, opts = {}) {
  const amount = opts.amount ?? 1;
  const gain = opts.gain ?? 1.75;
  const tint = new THREE.Color(opts.tint ?? 0xc9d2da);
  const dirt = opts.dirt ?? 0.42;
  const noiseScale = opts.noiseScale ?? 42;
  const pos = g.attributes.position;
  let nrm = g.attributes.normal;
  if (!nrm) { g.computeVertexNormals(); nrm = g.attributes.normal; }
  const n = pos.count;

  // centroid, used as the convexity reference
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += pos.getX(i); cy += pos.getY(i); cz += pos.getZ(i); }
  cx /= n; cy /= n; cz /= n;

  const map = new Map();
  const keys = new Array(n);
  const Q = 4000;
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos.getX(i) * Q)},${Math.round(pos.getY(i) * Q)},${Math.round(pos.getZ(i) * Q)}`;
    keys[i] = k;
    let e = map.get(k);
    if (!e) { e = { x: 0, y: 0, z: 0, c: 0 }; map.set(k, e); }
    e.x += nrm.getX(i); e.y += nrm.getY(i); e.z += nrm.getZ(i); e.c++;
  }
  for (const e of map.values()) {
    const l = Math.hypot(e.x, e.y, e.z) || 1;
    e.x /= l; e.y /= l; e.z /= l;
    // |average| < 1 exactly when the incident normals disagree
    e.spread = 1 - l / e.c;
  }

  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const e = map.get(keys[i]);
    const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
    const dx = px - cx, dy = py - cy, dz = pz - cz;
    const dl = Math.hypot(dx, dy, dz) || 1;
    const convex = (e.x * dx + e.y * dy + e.z * dz) / dl;
    const noise = 0.55 + 0.45 * hash3(px * noiseScale, py * noiseScale, pz * noiseScale);
    const stripe = 0.6 + 0.4 * hash3(px * 5.1, py * 4.3, pz * 3.7);

    let wear = smoothstep(0.02, 0.28, e.spread) * noise * stripe;
    wear *= smoothstep(-0.15, 0.55, convex);
    wear = Math.min(1, wear * amount);

    let grime = smoothstep(0.03, 0.30, e.spread) * smoothstep(0.25, -0.5, convex);
    grime = Math.min(1, grime * dirt);

    const k = 1 - grime * 0.55;
    col[i * 3] = (1 + wear * (tint.r * gain - 1)) * k;
    col[i * 3 + 1] = (1 + wear * (tint.g * gain - 1)) * k;
    col[i * 3 + 2] = (1 + wear * (tint.b * gain - 1)) * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
}

/** Flat colour attribute, for parts that should not be wear-baked. */
export function flatColor(g, c = 1) {
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  col.fill(c);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Strip a geometry down to the exact attribute set mergeParts expects. */
export function normalizeGeom(g) {
  let out = g.index ? g.toNonIndexed() : g;
  if (out === g && g.index) out = g.toNonIndexed();
  if (!out.attributes.normal) out.computeVertexNormals();
  if (!out.attributes.uv) applyBoxUV(out, 3.0);
  if (!out.attributes.color) flatColor(out, 1);
  for (const key of Object.keys(out.attributes)) {
    if (key !== 'position' && key !== 'normal' && key !== 'uv' && key !== 'color') {
      out.deleteAttribute(key);
    }
  }
  out.morphAttributes = {};
  out.clearGroups();
  return out;
}

/** Merge a list of geometries into one buffer — one draw call per material. */
export function mergeParts(list) {
  const clean = [];
  for (const g of list) {
    if (!g) continue;
    if (!g.attributes?.position?.count) continue;
    clean.push(normalizeGeom(g));
  }
  if (!clean.length) return new THREE.BufferGeometry();
  if (clean.length === 1) return clean[0];
  const merged = mergeGeometries(clean, false);
  if (!merged) return clean[0];
  for (const g of clean) if (g !== merged) g.dispose?.();
  return merged;
}

/**
 * A part bin: collect geometry per material key, then bake one mesh each.
 * Keeps weapon files declarative — `bin.add('steel', cylZ(...))`.
 */
export class PartBin {
  constructor() { this.groups = new Map(); }

  add(mat, ...geoms) {
    let list = this.groups.get(mat);
    if (!list) this.groups.set(mat, (list = []));
    for (const g of geoms) if (g) list.push(g);
    return this;
  }

  /** add(), applying a `place()` transform to each geometry first. */
  addAt(mat, xform, ...geoms) {
    for (const g of geoms) if (g) this.add(mat, place(g, xform));
    return this;
  }

  /** Fold another bin (usually a sub-assembly factory) into this one. */
  absorb(other, xform) {
    if (!other) return this;
    for (const [mat, list] of other.groups) {
      for (const g of list) this.add(mat, xform ? place(g, xform) : g);
    }
    return this;
  }

  get empty() { return this.groups.size === 0; }

  /** @returns {Array<{material:string, geometry:THREE.BufferGeometry}>} */
  bake(opts = {}) {
    const out = [];
    for (const [mat, list] of this.groups) {
      const g = mergeParts(list);
      if (!g.attributes.position?.count) continue;
      applyBoxUV(g, opts.uvScale ?? 3.0);
      const w = opts.wear?.[mat] ?? opts.wear?.default ?? null;
      if (w) bakeWear(g, w);
      g.computeBoundingSphere();
      out.push({ material: mat, geometry: g });
    }
    return out;
  }
}

/* ==================================================================== */
/* misc                                                                  */
/* ==================================================================== */

/** An empty transform node used as a socket (muzzle, eject port, hand grip). */
export function socket(name, p = [0, 0, 0], r = [0, 0, 0]) {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(p[0], p[1], p[2]);
  o.rotation.set(r[0], r[1], r[2]);
  o.matrixAutoUpdate = true;
  return o;
}

export function triangleCount(g) {
  return (g.index ? g.index.count : g.attributes.position.count) / 3;
}

export { _m4, _q, _e, _v, _s };
