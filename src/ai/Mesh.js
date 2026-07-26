import * as THREE from 'three';
import { BONE_INDEX, BIND_POSITION, CHILDREN, PARENT } from './Skeleton.js';
import { clamp01, lerp, TAU } from './Util.js';

/**
 * Geometry kit for the operator model.
 *
 * Everything is authored directly in bind-pose world space so the mesh and the
 * skeleton can never disagree: limbs are swept along the actual bone segments,
 * gear is placed relative to the actual joint positions.
 *
 * Three skinning strategies, each used where it is exactly right:
 *   sweep()      carries per-station bone weights, so a sleeve's weights are
 *                authored along its length instead of guessed afterwards;
 *   rigid()      binds a whole part to one bone (pouches, plates, the rifle);
 *   autoSkin()   distance-to-bone-segment falloff, for organic bits like the
 *                head and hands where a swept parameterisation is awkward.
 */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();

/* ================================================================== */
/* primitive builders                                                  */
/* ================================================================== */

/**
 * Swept tube with per-station elliptical/superelliptical cross sections and
 * parallel-transported frames.
 *
 * @param {Array} stations  [{p:Vector3, rx, ry, n?, ox?, oy?, roll?, bones?}]
 * @param {Object} opts     {sides, capStart, capEnd, hint:Vector3, uvScale}
 */
export function sweep(stations, opts = {}) {
  const sides = opts.sides ?? 12;
  const N = stations.length;
  if (N < 2) return null;
  const cols = sides + 1;

  // --- frames -------------------------------------------------------
  const tangents = [];
  for (let i = 0; i < N; i++) {
    const a = stations[Math.max(0, i - 1)].p;
    const b = stations[Math.min(N - 1, i + 1)].p;
    const t = new THREE.Vector3().subVectors(b, a);
    if (t.lengthSq() < 1e-12) t.set(0, 1, 0);
    tangents.push(t.normalize());
  }
  const hint = (opts.hint ? opts.hint.clone() : new THREE.Vector3(1, 0, 0));
  const axX = [];
  const axY = [];
  let px = hint.clone().addScaledVector(tangents[0], -hint.dot(tangents[0]));
  if (px.lengthSq() < 1e-8) {
    // the hint was parallel to the tangent: fall back to the forward axis
    px.set(0, 0, -1).addScaledVector(tangents[0], -tangents[0].z * -1);
    if (px.lengthSq() < 1e-8) px.set(0, 1, 0).addScaledVector(tangents[0], -tangents[0].y);
  }
  px.normalize();
  for (let i = 0; i < N; i++) {
    if (i > 0) {
      // minimal rotation from the previous tangent to this one
      _q.setFromUnitVectors(tangents[i - 1], tangents[i]);
      px.applyQuaternion(_q).normalize();
    }
    const py = new THREE.Vector3().crossVectors(tangents[i], px).normalize();
    axX.push(px.clone());
    axY.push(py);
  }

  // --- vertices -----------------------------------------------------
  const vertCount = N * cols + (opts.capStart ? 1 : 0) + (opts.capEnd ? 1 : 0);
  const pos = new Float32Array(vertCount * 3);
  const uv = new Float32Array(vertCount * 2);
  const ring = new Int32Array(vertCount);       // station index per vertex
  let vi = 0;
  let vLen = 0;
  const vDist = new Float32Array(N);
  for (let i = 1; i < N; i++) {
    vLen += stations[i].p.distanceTo(stations[i - 1].p);
    vDist[i] = vLen;
  }

  for (let i = 0; i < N; i++) {
    const s = stations[i];
    const rx = s.rx ?? 0.05;
    const ry = s.ry ?? rx;
    const n = s.n ?? 2;
    const roll = s.roll ?? 0;
    const ox = s.ox ?? 0;
    const oy = s.oy ?? 0;
    const circ = Math.PI * (rx + ry);
    for (let j = 0; j <= sides; j++) {
      const a = (j / sides) * TAU + roll;
      let cx = Math.cos(a);
      let cy = Math.sin(a);
      if (n !== 2) {
        const e = 2 / n;
        cx = Math.sign(cx) * Math.pow(Math.abs(cx), e);
        cy = Math.sign(cy) * Math.pow(Math.abs(cy), e);
      }
      const lx = cx * rx + ox;
      const ly = cy * ry + oy;
      const X = axX[i], Y = axY[i], P = s.p;
      pos[vi * 3] = P.x + X.x * lx + Y.x * ly;
      pos[vi * 3 + 1] = P.y + X.y * lx + Y.y * ly;
      pos[vi * 3 + 2] = P.z + X.z * lx + Y.z * ly;
      uv[vi * 2] = (j / sides) * circ;
      uv[vi * 2 + 1] = vDist[i];
      ring[vi] = i;
      vi++;
    }
  }

  const idx = [];
  for (let i = 0; i < N - 1; i++) {
    for (let j = 0; j < sides; j++) {
      const a = i * cols + j;
      const b = a + 1;
      const c = (i + 1) * cols + j;
      const d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }

  if (opts.capStart) {
    const ci = vi;
    const s = stations[0];
    pos[vi * 3] = s.p.x + axX[0].x * (s.ox ?? 0) + axY[0].x * (s.oy ?? 0);
    pos[vi * 3 + 1] = s.p.y + axX[0].y * (s.ox ?? 0) + axY[0].y * (s.oy ?? 0);
    pos[vi * 3 + 2] = s.p.z + axX[0].z * (s.ox ?? 0) + axY[0].z * (s.oy ?? 0);
    uv[vi * 2] = 0; uv[vi * 2 + 1] = -0.02;
    ring[vi] = 0;
    vi++;
    for (let j = 0; j < sides; j++) idx.push(ci, j + 1, j);
  }
  if (opts.capEnd) {
    const ci = vi;
    const s = stations[N - 1];
    const base = (N - 1);
    pos[vi * 3] = s.p.x + axX[base].x * (s.ox ?? 0) + axY[base].x * (s.oy ?? 0);
    pos[vi * 3 + 1] = s.p.y + axX[base].y * (s.ox ?? 0) + axY[base].y * (s.oy ?? 0);
    pos[vi * 3 + 2] = s.p.z + axX[base].z * (s.ox ?? 0) + axY[base].z * (s.oy ?? 0);
    uv[vi * 2] = 0; uv[vi * 2 + 1] = vLen + 0.02;
    ring[vi] = N - 1;
    vi++;
    const o = (N - 1) * cols;
    for (let j = 0; j < sides; j++) idx.push(ci, o + j, o + j + 1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  weldSeamNormals(geo, N, cols);

  // per-station skin weights, if the caller authored them
  if (stations.some((s) => s.bones)) {
    const skinIndex = new Uint16Array(vertCount * 4);
    const skinWeight = new Float32Array(vertCount * 4);
    for (let v = 0; v < vertCount; v++) {
      const s = stations[ring[v]];
      writeWeights(skinIndex, skinWeight, v, s.bones || []);
    }
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  }
  return geo;
}

/** Average the duplicated seam column so a swept tube has no lighting split. */
function weldSeamNormals(geo, rings, cols) {
  const n = geo.attributes.normal.array;
  const sides = cols - 1;
  for (let i = 0; i < rings; i++) {
    const a = (i * cols) * 3;
    const b = (i * cols + sides) * 3;
    const nx = n[a] + n[b], ny = n[a + 1] + n[b + 1], nz = n[a + 2] + n[b + 2];
    const l = Math.hypot(nx, ny, nz) || 1;
    n[a] = n[b] = nx / l;
    n[a + 1] = n[b + 1] = ny / l;
    n[a + 2] = n[b + 2] = nz / l;
  }
  geo.attributes.normal.needsUpdate = true;
}

/**
 * Rounded box built by pushing a low-density sphere out to the box corners:
 * real bevels, correct normals, 64–200 triangles depending on `seg`.
 */
export function roundedBox(w, h, d, r, seg = 1) {
  r = Math.min(r, w * 0.5, h * 0.5, d * 0.5);
  const hx = Math.max(1e-4, w * 0.5 - r);
  const hy = Math.max(1e-4, h * 0.5 - r);
  const hz = Math.max(1e-4, d * 0.5 - r);
  const lon = 4 * (seg + 1);
  const lat = 2 * (seg + 1);
  const pos = [];
  const nor = [];
  const uv = [];
  for (let iy = 0; iy <= lat; iy++) {
    const vAng = (iy / lat) * Math.PI;
    for (let ix = 0; ix <= lon; ix++) {
      const uAng = (ix / lon) * TAU;
      const nx = Math.sin(vAng) * Math.cos(uAng);
      const ny = Math.cos(vAng);
      const nz = Math.sin(vAng) * Math.sin(uAng);
      pos.push(nx * r + Math.sign(nx) * hx * (Math.abs(nx) > 1e-6 ? 1 : 0),
        ny * r + Math.sign(ny) * hy * (Math.abs(ny) > 1e-6 ? 1 : 0),
        nz * r + Math.sign(nz) * hz * (Math.abs(nz) > 1e-6 ? 1 : 0));
      nor.push(nx, ny, nz);
      uv.push(ix / lon, iy / lat);
    }
  }
  const idx = [];
  for (let iy = 0; iy < lat; iy++) {
    for (let ix = 0; ix < lon; ix++) {
      const a = iy * (lon + 1) + ix;
      const b = a + 1;
      const c = a + lon + 1;
      const dd = c + 1;
      if (iy !== 0) idx.push(a, b, c);
      if (iy !== lat - 1) idx.push(b, dd, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

/**
 * Curved armour plate / patch: a section of a cylinder shell with rounded
 * corners and thickness. Used for the plate carrier, knee pads and the helmet
 * accessories where a flat box would read as cardboard.
 */
export function shellPlate({
  radius = 0.20, arc = 1.5, height = 0.30, thickness = 0.022,
  segU = 10, segV = 6, cornerX = 0.25, cornerY = 0.18, taper = 0.0,
}) {
  const pos = [];
  const nor = [];
  const uv = [];
  const idx = [];
  const rings = segV + 1;
  const cols = segU + 1;
  const push = (rOff, flip) => {
    const base = pos.length / 3;
    for (let iv = 0; iv <= segV; iv++) {
      const v = iv / segV;
      const y = (v - 0.5) * height;
      // rounded silhouette: shrink the arc at the top and bottom
      const shrinkY = 1 - Math.pow(Math.abs(v - 0.5) * 2, 4) * cornerY;
      for (let iu = 0; iu <= segU; iu++) {
        const u = iu / segU;
        const a = (u - 0.5) * arc * shrinkY;
        const shrink = 1 - Math.pow(Math.abs(u - 0.5) * 2, 5) * cornerX;
        const yy = y * shrink - taper * Math.pow(Math.abs(u - 0.5) * 2, 2) * height * 0.5;
        const rr = radius + rOff;
        const nx = Math.sin(a), nz = -Math.cos(a);
        pos.push(nx * rr, yy, nz * rr);
        nor.push(flip ? -nx : nx, 0, flip ? -nz : nz);
        uv.push(a * radius, yy);
      }
    }
    for (let iv = 0; iv < segV; iv++) {
      for (let iu = 0; iu < segU; iu++) {
        const a = base + iv * cols + iu;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        if (flip) idx.push(a, b, c, b, d, c);
        else idx.push(a, c, b, b, c, d);
      }
    }
    return base;
  };
  const outer = push(thickness * 0.5, false);
  const inner = push(-thickness * 0.5, true);
  // rim: stitch the two shells around the border
  const border = [];
  for (let iu = 0; iu <= segU; iu++) border.push([outer + iu, inner + iu]);
  for (let iv = 0; iv <= segV; iv++) border.push([outer + iv * cols + segU, inner + iv * cols + segU]);
  for (let iu = segU; iu >= 0; iu--) border.push([outer + segV * cols + iu, inner + segV * cols + iu]);
  for (let iv = segV; iv >= 0; iv--) border.push([outer + iv * cols, inner + iv * cols]);
  for (let i = 0; i < border.length - 1; i++) {
    const [o0, i0] = border[i];
    const [o1, i1] = border[i + 1];
    idx.push(o0, o1, i0, o1, i1, i0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Flat ribbon along a path — straps, slings, laces, seams. */
export function ribbon(points, width, thickness = 0.004, upHint = null) {
  const stations = points.map((p, i) => ({ p: p.clone ? p.clone() : new THREE.Vector3().fromArray(p), rx: width * 0.5, ry: thickness * 0.5, n: 3.2 }));
  return sweep(stations, { sides: 6, capStart: true, capEnd: true, hint: upHint || new THREE.Vector3(0, 1, 0) });
}

/** Tapered capsule between two points: fingers, antenna, buckles, tube stock. */
export function tube(a, b, r0, r1 = r0, sides = 8, opts = {}) {
  const A = a.clone ? a : new THREE.Vector3().fromArray(a);
  const B = b.clone ? b : new THREE.Vector3().fromArray(b);
  const steps = opts.steps ?? 2;
  const stations = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    stations.push({
      p: new THREE.Vector3().lerpVectors(A, B, t),
      rx: lerp(r0, r1, t), ry: lerp(r0, r1, t), n: opts.n ?? 2,
    });
  }
  return sweep(stations, { sides, capStart: opts.capStart !== false, capEnd: opts.capEnd !== false, hint: opts.hint });
}

/** Lathe a 2-D profile around Y. `profile` is [[r, y], ...]. */
export function lathe(profile, segments = 16, phiStart = 0, phiLength = TAU) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(1e-4, r), y));
  const geo = new THREE.LatheGeometry(pts, segments, phiStart, phiLength);
  return geo;
}

/* ================================================================== */
/* transforms + UVs                                                    */
/* ================================================================== */

export function transform(geo, { pos, rot, quat, scale, pivot } = {}) {
  _m.identity();
  const m = new THREE.Matrix4();
  const q = quat ? quat.clone() : new THREE.Quaternion();
  if (rot) q.setFromEuler(rot.isEuler ? rot : new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ'));
  const s = scale === undefined ? new THREE.Vector3(1, 1, 1)
    : (typeof scale === 'number' ? new THREE.Vector3(scale, scale, scale)
      : (scale.isVector3 ? scale : new THREE.Vector3().fromArray(scale)));
  const p = pos ? (pos.isVector3 ? pos : new THREE.Vector3().fromArray(pos)) : new THREE.Vector3();
  if (pivot) {
    const pv = pivot.isVector3 ? pivot : new THREE.Vector3().fromArray(pivot);
    m.makeTranslation(-pv.x, -pv.y, -pv.z);
    geo.applyMatrix4(m);
    m.compose(p.clone().add(pv), q, s);
  } else {
    m.compose(p, q, s);
  }
  geo.applyMatrix4(m);
  return geo;
}

/**
 * Dominant-axis planar UVs in metres. Every part ends up at the same texel
 * density, which is what keeps camo scale consistent from boot to helmet.
 */
export function projectUV(geo, scale = 1, offset = 0) {
  const p = geo.attributes.position.array;
  const n = geo.attributes.normal ? geo.attributes.normal.array : null;
  const count = geo.attributes.position.count;
  const uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    let ax = 0, ay = 0, az = 0;
    if (n) { ax = Math.abs(n[i * 3]); ay = Math.abs(n[i * 3 + 1]); az = Math.abs(n[i * 3 + 2]); }
    else { ax = 1; }
    let u, v;
    if (ax >= ay && ax >= az) { u = z; v = y; }
    else if (ay >= az) { u = x; v = z; }
    else { u = x; v = y; }
    uv[i * 2] = u * scale + offset;
    uv[i * 2 + 1] = v * scale + offset;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/* ================================================================== */
/* skinning                                                            */
/* ================================================================== */

function writeWeights(skinIndex, skinWeight, v, bones) {
  let total = 0;
  for (let k = 0; k < 4; k++) {
    const entry = bones[k];
    if (!entry) { skinIndex[v * 4 + k] = 0; skinWeight[v * 4 + k] = 0; continue; }
    const name = Array.isArray(entry) ? entry[0] : entry;
    const w = Array.isArray(entry) ? entry[1] : 1;
    skinIndex[v * 4 + k] = BONE_INDEX[name] ?? 0;
    skinWeight[v * 4 + k] = w;
    total += w;
  }
  if (total <= 1e-6) { skinWeight[v * 4] = 1; total = 1; }
  for (let k = 0; k < 4; k++) skinWeight[v * 4 + k] /= total;
}

/** Bind a whole part to one bone (or a fixed blend of up to four). */
export function rigid(geo, bones) {
  const list = Array.isArray(bones) ? bones : [[bones, 1]];
  const count = geo.attributes.position.count;
  const si = new Uint16Array(count * 4);
  const sw = new Float32Array(count * 4);
  for (let v = 0; v < count; v++) writeWeights(si, sw, v, list);
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  return geo;
}

function segmentDistance(px, py, pz, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = px - a.x, apy = py - a.y, apz = pz - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > 1e-9 ? (apx * abx + apy * aby + apz * abz) / len2 : 0;
  t = clamp01(t);
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Distance-to-bone-segment skinning restricted to a candidate set.
 * @param {Array<string|[string,number]>} candidates bone names, optional bias
 */
export function autoSkin(geo, candidates, opts = {}) {
  const falloff = opts.falloff ?? 0.085;
  const power = opts.power ?? 1;
  const count = geo.attributes.position.count;
  const p = geo.attributes.position.array;
  const si = new Uint16Array(count * 4);
  const sw = new Float32Array(count * 4);

  const segs = candidates.map((c) => {
    const name = Array.isArray(c) ? c[0] : c;
    const bias = Array.isArray(c) ? c[1] : 1;
    const i = BONE_INDEX[name];
    const a = BIND_POSITION[i];
    // the segment runs to the mean of the children, or a stub along the parent
    let b;
    if (CHILDREN[i].length) {
      b = new THREE.Vector3();
      for (const c2 of CHILDREN[i]) b.add(BIND_POSITION[c2]);
      b.multiplyScalar(1 / CHILDREN[i].length);
    } else {
      const pi = PARENT[i];
      b = pi >= 0
        ? new THREE.Vector3().subVectors(a, BIND_POSITION[pi]).multiplyScalar(0.5).add(a)
        : a.clone().add(new THREE.Vector3(0, 0.08, 0));
    }
    return { index: i, a, b, bias };
  });

  const w = new Float64Array(segs.length);
  for (let v = 0; v < count; v++) {
    const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
    let sum = 0;
    for (let s = 0; s < segs.length; s++) {
      const d = segmentDistance(x, y, z, segs[s].a, segs[s].b);
      const t = d / falloff;
      const ww = Math.exp(-t * t * power) * segs[s].bias;
      w[s] = ww;
      sum += ww;
    }
    if (sum < 1e-9) {
      // fall back to the nearest candidate outright
      let best = 0, bd = Infinity;
      for (let s = 0; s < segs.length; s++) {
        const d = segmentDistance(x, y, z, segs[s].a, segs[s].b);
        if (d < bd) { bd = d; best = s; }
      }
      w.fill(0); w[best] = 1; sum = 1;
    }
    // top four
    const order = [0, 1, 2, 3];
    const idxs = [-1, -1, -1, -1];
    const vals = [0, 0, 0, 0];
    for (let s = 0; s < segs.length; s++) {
      const val = w[s];
      for (let k = 0; k < 4; k++) {
        if (val > vals[k]) {
          for (let m2 = 3; m2 > k; m2--) { vals[m2] = vals[m2 - 1]; idxs[m2] = idxs[m2 - 1]; }
          vals[k] = val; idxs[k] = s;
          break;
        }
      }
    }
    let tot = vals[0] + vals[1] + vals[2] + vals[3];
    if (tot <= 1e-9) { vals[0] = 1; tot = 1; idxs[0] = Math.max(0, idxs[0]); }
    for (let k = 0; k < 4; k++) {
      si[v * 4 + k] = idxs[k] >= 0 ? segs[idxs[k]].index : 0;
      sw[v * 4 + k] = idxs[k] >= 0 ? vals[k] / tot : 0;
    }
    void order;
  }
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  return geo;
}

/* ================================================================== */
/* assembly                                                            */
/* ================================================================== */

/**
 * Collects parts, merges them per material and emits one indexed geometry with
 * draw groups in material order — one SkinnedMesh, one skeleton update, one
 * draw call per surface family.
 */
export class PartSet {
  constructor(materials) {
    this.materials = materials;   // array of THREE.Material
    this.buckets = materials.map(() => []);
  }

  /** @param {number} materialIndex index into the material array */
  add(geo, materialIndex) {
    if (!geo) return this;
    if (!geo.attributes.uv) projectUV(geo, 1);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (!geo.attributes.skinIndex) rigid(geo, 'pelvis');
    if (!geo.index) {
      const n = geo.attributes.position.count;
      const idx = new Uint32Array(n);
      for (let i = 0; i < n; i++) idx[i] = i;
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    this.buckets[materialIndex].push(geo);
    return this;
  }

  build() {
    const groups = [];
    let vertexOffset = 0;
    let indexOffset = 0;
    const positions = [];
    const normals = [];
    const uvs = [];
    const skinIndices = [];
    const skinWeights = [];
    const indices = [];

    for (let mi = 0; mi < this.buckets.length; mi++) {
      const list = this.buckets[mi];
      const start = indexOffset;
      for (const g of list) {
        const p = g.attributes.position.array;
        const n = g.attributes.normal.array;
        const u = g.attributes.uv.array;
        const si = g.attributes.skinIndex.array;
        const sw = g.attributes.skinWeight.array;
        const idx = g.index.array;
        const vc = g.attributes.position.count;
        for (let i = 0; i < vc * 3; i++) { positions.push(p[i]); normals.push(n[i]); }
        for (let i = 0; i < vc * 2; i++) uvs.push(u[i]);
        for (let i = 0; i < vc * 4; i++) { skinIndices.push(si[i]); skinWeights.push(sw[i]); }
        for (let i = 0; i < idx.length; i++) indices.push(idx[i] + vertexOffset);
        vertexOffset += vc;
        indexOffset += idx.length;
        g.dispose();
      }
      groups.push({ start, count: indexOffset - start, materialIndex: mi });
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
    geo.setIndex(new THREE.BufferAttribute(
      vertexOffset > 65535 ? new Uint32Array(indices) : new Uint16Array(indices), 1));
    for (const g of groups) if (g.count > 0) geo.addGroup(g.start, g.count, g.materialIndex);

    // A skinned bounding volume must survive the most extreme pose we animate.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.95, 0), 1.55);
    geo.boundingBox = new THREE.Box3(
      new THREE.Vector3(-0.9, -0.25, -1.0), new THREE.Vector3(0.9, 2.1, 0.9));
    return geo;
  }
}

export { _v, _v2, _v3 };
