import * as THREE from 'three';

/**
 * Allocation-free geometric kernels.
 *
 * Every function here uses module-scope scratch vectors and never allocates, so
 * they are safe to call tens of thousands of times per frame (the weapon system
 * fires one penetration trace per pellet, the character controller runs several
 * hundred triangle tests per fixed step). The trade-off is that they are *not*
 * reentrant: never call one from inside the callback of another.
 */

export const EPS = 1e-9;

const _e1 = /* @__PURE__ */ new THREE.Vector3();
const _e2 = /* @__PURE__ */ new THREE.Vector3();
const _pv = /* @__PURE__ */ new THREE.Vector3();
const _tv = /* @__PURE__ */ new THREE.Vector3();
const _qv = /* @__PURE__ */ new THREE.Vector3();
const _ab = /* @__PURE__ */ new THREE.Vector3();
const _ac = /* @__PURE__ */ new THREE.Vector3();
const _ap = /* @__PURE__ */ new THREE.Vector3();
const _bp = /* @__PURE__ */ new THREE.Vector3();
const _cp = /* @__PURE__ */ new THREE.Vector3();
const _m = /* @__PURE__ */ new THREE.Vector3();
const _tmp = /* @__PURE__ */ new THREE.Vector3();
const _tmp2 = /* @__PURE__ */ new THREE.Vector3();

/** Geometric face normal following three.js winding: (b-a) x (c-a), normalised. */
export function triNormal(a, b, c, out) {
  _e1.subVectors(b, a);
  _e2.subVectors(c, a);
  out.crossVectors(_e1, _e2);
  const l = out.length();
  if (l > EPS) out.multiplyScalar(1 / l);
  else out.set(0, 1, 0);
  return out;
}

/** Unnormalised twice-area of a triangle; used to reject degenerate faces. */
export function triAreaSq(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  return nx * nx + ny * ny + nz * nz;
}

/**
 * Moller-Trumbore. Returns the ray parameter t (>0 means in front) or -1 on miss.
 * With `backfaces` false only front faces (CCW as seen by the ray) are hit, which
 * is what you want for bullets so they never catch the inside of a wall shell.
 */
export function rayTriangle(o, d, a, b, c, backfaces) {
  _e1.subVectors(b, a);
  _e2.subVectors(c, a);
  _pv.crossVectors(d, _e2);
  const det = _e1.dot(_pv);
  if (backfaces) {
    if (det > -EPS && det < EPS) return -1;
  } else if (det < EPS) {
    return -1;
  }
  const inv = 1 / det;
  _tv.subVectors(o, a);
  const u = _tv.dot(_pv) * inv;
  if (u < -1e-6 || u > 1.000001) return -1;
  _qv.crossVectors(_tv, _e1);
  const v = d.dot(_qv) * inv;
  if (v < -1e-6 || u + v > 1.000001) return -1;
  return _e2.dot(_qv) * inv;
}

/** Barycentric containment test for a point already known to lie on the plane. */
export function pointInTriangle(p, a, b, c) {
  _ab.subVectors(b, a);
  _ac.subVectors(c, a);
  _ap.subVectors(p, a);
  const d00 = _ab.dot(_ab);
  const d01 = _ab.dot(_ac);
  const d11 = _ac.dot(_ac);
  const d20 = _ap.dot(_ab);
  const d21 = _ap.dot(_ac);
  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < 1e-18) return false;
  const inv = 1 / denom;
  const v = (d11 * d20 - d01 * d21) * inv;
  const w = (d00 * d21 - d01 * d20) * inv;
  return v >= -1e-5 && w >= -1e-5 && v + w <= 1.00001;
}

/** Ericson, Real-Time Collision Detection s5.1.5. Writes the closest point to `out`. */
export function closestPointTriangle(p, a, b, c, out) {
  _ab.subVectors(b, a);
  _ac.subVectors(c, a);
  _ap.subVectors(p, a);
  const d1 = _ab.dot(_ap);
  const d2 = _ac.dot(_ap);
  if (d1 <= 0 && d2 <= 0) return out.copy(a);

  _bp.subVectors(p, b);
  const d3 = _ab.dot(_bp);
  const d4 = _ac.dot(_bp);
  if (d3 >= 0 && d4 <= d3) return out.copy(b);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return out.copy(a).addScaledVector(_ab, v);
  }

  _cp.subVectors(p, c);
  const d5 = _ab.dot(_cp);
  const d6 = _ac.dot(_cp);
  if (d6 >= 0 && d5 <= d6) return out.copy(c);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return out.copy(a).addScaledVector(_ac, w);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return out.copy(b).addScaledVector(_tmp.subVectors(c, b), w);
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return out.copy(a).addScaledVector(_ab, v).addScaledVector(_ac, w);
}

/**
 * Slab test returning the ray entry distance into `box`, or Infinity on a miss.
 * `invDir` must be the componentwise reciprocal of the (normalised) direction;
 * Infinity components are fine, the multiply/compare handles them correctly.
 */
export function rayBoxEnter(box, o, invDir) {
  const min = box.min, max = box.max;
  let tmin = (min.x - o.x) * invDir.x;
  let tmax = (max.x - o.x) * invDir.x;
  if (tmin > tmax) { const s = tmin; tmin = tmax; tmax = s; }

  let ty1 = (min.y - o.y) * invDir.y;
  let ty2 = (max.y - o.y) * invDir.y;
  if (ty1 > ty2) { const s = ty1; ty1 = ty2; ty2 = s; }
  if (ty1 > tmin) tmin = ty1;
  if (ty2 < tmax) tmax = ty2;
  if (tmin > tmax) return Infinity;

  let tz1 = (min.z - o.z) * invDir.z;
  let tz2 = (max.z - o.z) * invDir.z;
  if (tz1 > tz2) { const s = tz1; tz1 = tz2; tz2 = s; }
  if (tz1 > tmin) tmin = tz1;
  if (tz2 < tmax) tmax = tz2;
  if (tmin > tmax || tmax < 0) return Infinity;

  return tmin < 0 ? 0 : tmin;
}

/**
 * Exact swept-sphere against a triangle: the Minkowski sum of the triangle and a
 * sphere is the face slab plus three edge cylinders plus three vertex spheres, so
 * we test all seven pieces and keep the earliest root.
 *
 * @param {THREE.Vector3} o      sphere centre at t=0
 * @param {THREE.Vector3} d      unit direction
 * @param {number} r             sphere radius
 * @param {number} maxT          ignore hits beyond this distance
 * @param {THREE.Vector3} n      unit face normal (pass the cached one)
 * @param {THREE.Vector3} outN   receives the contact normal (surface -> centre)
 * @param {THREE.Vector3} outP   receives the contact point on the triangle
 * @returns {number} t in [0, maxT] or -1
 */
export function sweptSphereTriangle(o, d, r, maxT, a, b, c, n, outN, outP) {
  let best = -1;
  let limit = maxT;

  // --- face ---------------------------------------------------------------
  const sd = n.dot(o) - n.dot(a);           // signed distance of centre to plane
  const dn = n.dot(d);
  const sign = sd >= 0 ? 1 : -1;
  let tf = -1;
  if (sd * sign <= r) {
    tf = 0;                                  // already inside the slab
  } else if (dn * sign < -EPS) {
    tf = (sign * r - sd) / dn;
  }
  if (tf >= 0 && tf <= limit) {
    _tmp.copy(o).addScaledVector(d, tf).addScaledVector(n, -sign * r);
    if (pointInTriangle(_tmp, a, b, c)) {
      best = tf;
      limit = tf;
      outP.copy(_tmp);
      outN.copy(n).multiplyScalar(sign);
    }
  }

  const dd = d.dot(d);
  const r2 = r * r;

  // --- vertices -----------------------------------------------------------
  for (let i = 0; i < 3; i++) {
    const v = i === 0 ? a : (i === 1 ? b : c);
    _m.subVectors(o, v);
    const bq = _m.dot(d);
    const cq = _m.dot(_m) - r2;
    if (cq <= 0) {
      // already overlapping this vertex
      if (0 <= limit) {
        best = 0; limit = 0;
        outP.copy(v);
        outN.copy(_m);
        const l = outN.length();
        if (l > EPS) outN.multiplyScalar(1 / l); else outN.copy(n).multiplyScalar(sign);
      }
      continue;
    }
    if (bq >= 0) continue;                    // moving away
    const disc = bq * bq - dd * cq;
    if (disc < 0) continue;
    const t = (-bq - Math.sqrt(disc)) / dd;
    if (t >= 0 && t <= limit) {
      best = t; limit = t;
      outP.copy(v);
      outN.copy(o).addScaledVector(d, t).sub(v).multiplyScalar(1 / r);
    }
  }

  // --- edges --------------------------------------------------------------
  for (let i = 0; i < 3; i++) {
    const p0 = i === 0 ? a : (i === 1 ? b : c);
    const p1 = i === 0 ? b : (i === 1 ? c : a);
    _ab.subVectors(p1, p0);
    _m.subVectors(o, p0);
    const abab = _ab.dot(_ab);
    if (abab < 1e-16) continue;
    const abd = _ab.dot(d);
    const abm = _ab.dot(_m);
    const A = abab * dd - abd * abd;
    const C = abab * (_m.dot(_m) - r2) - abm * abm;
    if (A < 1e-14) continue;                  // parallel: covered by the vertices
    const B = abab * _m.dot(d) - abd * abm;
    if (C < 0) continue;                      // already overlapping: vertices/face caught it
    const disc = B * B - A * C;
    if (disc < 0) continue;
    const t = (-B - Math.sqrt(disc)) / A;
    if (t < 0 || t > limit) continue;
    const s = (abm + t * abd) / abab;
    if (s < 0 || s > 1) continue;             // off the end: the vertex test owns it
    best = t; limit = t;
    outP.copy(p0).addScaledVector(_ab, s);
    outN.copy(o).addScaledVector(d, t).sub(outP).multiplyScalar(1 / r);
  }

  return best;
}

/**
 * Closest points between two segments (Ericson s5.1.9). Writes onto `c1`/`c2`
 * and returns the squared distance.
 */
export function closestSegmentSegment(p1, q1, p2, q2, c1, c2) {
  _ab.subVectors(q1, p1);
  _ac.subVectors(q2, p2);
  _m.subVectors(p1, p2);
  const a = _ab.dot(_ab);
  const e = _ac.dot(_ac);
  const f = _ac.dot(_m);
  let s, t;
  if (a <= 1e-12 && e <= 1e-12) {
    c1.copy(p1); c2.copy(p2);
    return c1.distanceToSquared(c2);
  }
  if (a <= 1e-12) {
    s = 0;
    t = Math.min(1, Math.max(0, f / e));
  } else {
    const cc = _ab.dot(_m);
    if (e <= 1e-12) {
      t = 0;
      s = Math.min(1, Math.max(0, -cc / a));
    } else {
      const bb = _ab.dot(_ac);
      const denom = a * e - bb * bb;
      s = denom !== 0 ? Math.min(1, Math.max(0, (bb * f - cc * e) / denom)) : 0;
      t = (bb * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -cc / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (bb - cc) / a)); }
    }
  }
  c1.copy(p1).addScaledVector(_ab, s);
  c2.copy(p2).addScaledVector(_ac, t);
  return c1.distanceToSquared(c2);
}

/**
 * Closest point pair between a segment and a triangle. `outTri` gets the point on
 * the triangle, `outSeg` the point on the segment; returns the distance.
 *
 * Unlike the naive "test the three edges then the endpoints" version this also
 * handles the segment passing clean through the face, which matters when a
 * character is deeply embedded after a teleport or a big knockback.
 */
export function closestSegmentTriangle(s0, s1, a, b, c, n, outTri, outSeg) {
  // If the segment crosses the plane inside the triangle the true distance is 0.
  const d0 = n.dot(_tmp.subVectors(s0, a));
  const d1 = n.dot(_tmp.subVectors(s1, a));
  if ((d0 > 0) !== (d1 > 0)) {
    const t = d0 / (d0 - d1);
    _tmp2.copy(s0).lerp(s1, t);
    if (pointInTriangle(_tmp2, a, b, c)) {
      outTri.copy(_tmp2);
      outSeg.copy(_tmp2);
      return 0;
    }
  }

  let bestSq = Infinity;
  for (let i = 0; i < 3; i++) {
    const p0 = i === 0 ? a : (i === 1 ? b : c);
    const p1 = i === 0 ? b : (i === 1 ? c : a);
    const dsq = closestSegmentSegment(p0, p1, s0, s1, _pv, _qv);
    if (dsq < bestSq) { bestSq = dsq; outTri.copy(_pv); outSeg.copy(_qv); }
  }
  closestPointTriangle(s0, a, b, c, _pv);
  let dsq = _pv.distanceToSquared(s0);
  if (dsq < bestSq) { bestSq = dsq; outTri.copy(_pv); outSeg.copy(s0); }
  closestPointTriangle(s1, a, b, c, _pv);
  dsq = _pv.distanceToSquared(s1);
  if (dsq < bestSq) { bestSq = dsq; outTri.copy(_pv); outSeg.copy(s1); }

  return Math.sqrt(bestSq);
}

/** 10-bit-per-axis Morton code, used to order triangles for spatial chunking. */
export function morton3(x, y, z) {
  return (part1By2(x) << 2) | (part1By2(y) << 1) | part1By2(z);
}

function part1By2(v) {
  let n = v & 0x3ff;
  n = (n | (n << 16)) & 0x030000ff;
  n = (n | (n << 8)) & 0x0300f00f;
  n = (n | (n << 4)) & 0x030c30c3;
  n = (n | (n << 2)) & 0x09249249;
  return n;
}
