import * as THREE from 'three';
import {
  sweep, roundedBox, shellPlate, ribbon, tube, transform, projectUV, rigid, autoSkin, PartSet,
} from './Mesh.js';
import { BIND_POSITION, BONE_INDEX, Rig } from './Skeleton.js';
import { Rand, lerp, clamp01, TAU } from './Util.js';

/**
 * The operator model.
 *
 * Built once per kit at boot and shared by every enemy that wears that kit —
 * geometry and materials are immutable, only the bone hierarchy is per-instance.
 *
 * The construction rule throughout: geometry follows the skeleton. Limbs are
 * swept along the real bone segments with per-station skin weights, gear is
 * placed against real joint positions and bound rigidly to the bone (or to one
 * of the six spring-driven gear bones) it should follow. Nothing is eyeballed
 * in a modelling package because there is no modelling package.
 */

export const M = { CLOTH: 0, GEAR: 1, POLY: 2, STEEL: 3, LEATHER: 4, SKIN: 5, GLASS: 6 };

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const J = (name) => BIND_POSITION[BONE_INDEX[name]];

/**
 * The weapon's bore line in bind space, and the muzzle point on it. Every
 * weapon part is laid out from these, and the AI reads the muzzle back out to
 * spawn flashes and trace shots, so the two can never drift apart.
 */
export const WEAPON_BORE = { x: 0.145, y: 1.296 };
export const WEAPON_MUZZLE = new THREE.Vector3(WEAPON_BORE.x, WEAPON_BORE.y, -0.995);

/* ------------------------------------------------------------------ */
/* kits                                                                */
/* ------------------------------------------------------------------ */

export const KITS = [
  {
    id: 'assault',
    camo: 'arid',
    gear: 0x4a4438, poly: 0x3b3d38, steel: 0x51555a, leather: 0x2b2621, skin: 0xa9805f,
    helmet: 'fast', face: 'balaclava', goggles: true, antenna: true, dump: true, grenade: true,
  },
  {
    id: 'recon',
    camo: 'olive',
    gear: 0x3e4234, poly: 0x2f312c, steel: 0x484c50, leather: 0x231f1b, skin: 0x8f6647,
    helmet: 'fast', face: 'shemagh', goggles: false, antenna: false, dump: true, grenade: false,
  },
  {
    id: 'heavy',
    camo: 'urban',
    gear: 0x35373a, poly: 0x26282b, steel: 0x5b6066, leather: 0x1e1c1b, skin: 0xc09070,
    helmet: 'mich', face: 'balaclava', goggles: true, antenna: true, dump: false, grenade: true,
  },
];

/* ------------------------------------------------------------------ */
/* weight ramps                                                        */
/* ------------------------------------------------------------------ */

/** Interpolate an authored weight table at parameter s. */
function weightRamp(s, table) {
  let i = 0;
  while (i < table.length - 1 && s > table[i + 1][0]) i++;
  const a = table[i];
  const b = table[Math.min(table.length - 1, i + 1)];
  if (a === b || b[0] === a[0]) return a[1].map((e) => [e[0], e[1]]);
  const t = clamp01((s - a[0]) / (b[0] - a[0]));
  const acc = new Map();
  for (const [n, w] of a[1]) acc.set(n, (acc.get(n) || 0) + w * (1 - t));
  for (const [n, w] of b[1]) acc.set(n, (acc.get(n) || 0) + w * t);
  return [...acc.entries()].filter((e) => e[1] > 1e-4).sort((x, y) => y[1] - x[1]).slice(0, 4);
}

/**
 * Stations along a polyline of joints, subdivided, with the arc-length
 * parameter handed to a profile callback.
 */
function chainStations(points, subdiv, profile) {
  const pts = [];
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    lengths.push(lengths[i - 1] + points[i].distanceTo(points[i - 1]));
  }
  const total = lengths[lengths.length - 1] || 1;
  for (let i = 0; i < points.length - 1; i++) {
    const n = subdiv[i] ?? 3;
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const p = new THREE.Vector3().lerpVectors(points[i], points[i + 1], t);
      const s = (lengths[i] + (lengths[i + 1] - lengths[i]) * t) / total;
      pts.push({ p, s });
    }
  }
  pts.push({ p: points[points.length - 1].clone(), s: 1 });
  return pts.map(({ p, s }) => ({ p, ...profile(s, p) }));
}

/* ------------------------------------------------------------------ */
/* body pieces                                                         */
/* ------------------------------------------------------------------ */

function buildTorso(parts, kit, rand) {
  // --- jacket -------------------------------------------------------
  const spine = [
    V(0.000, 0.845, 0.030),   // jacket hem, below the belt
    V(0.000, 0.930, 0.014),
    V(0.000, 1.030, 0.004),
    V(0.000, 1.130, -0.004),
    V(0.000, 1.240, -0.014),
    V(0.000, 1.345, -0.022),
    V(0.000, 1.430, -0.022),
  ];
  const prof = [
    [0.170, 0.128], [0.163, 0.120], [0.150, 0.112], [0.156, 0.116],
    [0.172, 0.124], [0.186, 0.128], [0.150, 0.112],
  ];
  const bonesTable = [
    [0.00, [['pelvis', 1]]],
    [0.16, [['pelvis', 1]]],
    [0.32, [['pelvis', 0.55], ['spine1', 0.45]]],
    [0.50, [['spine1', 0.6], ['spine2', 0.4]]],
    [0.68, [['spine2', 0.65], ['spine3', 0.35]]],
    [0.86, [['spine3', 0.9], ['spine2', 0.1]]],
    [1.00, [['spine3', 0.85], ['neck', 0.15]]],
  ];
  const stations = [];
  for (let i = 0; i < spine.length; i++) {
    const sub = i < spine.length - 1 ? 3 : 1;
    for (let k = 0; k < (i === spine.length - 1 ? 1 : sub); k++) {
      const t = k / sub;
      const p = new THREE.Vector3().lerpVectors(spine[i], spine[Math.min(spine.length - 1, i + 1)], t);
      const rx = lerp(prof[i][0], prof[Math.min(prof.length - 1, i + 1)][0], t);
      const ry = lerp(prof[i][1], prof[Math.min(prof.length - 1, i + 1)][1], t);
      const s = (i + t) / (spine.length - 1);
      // cloth folds: a small radial ripple that reads as bunched fabric
      const fold = 1 + Math.sin(s * 22 + 1.7) * 0.012 + Math.sin(s * 41) * 0.006;
      stations.push({
        p, rx: rx * fold, ry: ry * fold, n: 2.55,
        oy: -0.008 - s * 0.006,
        bones: weightRamp(s, bonesTable),
      });
    }
  }
  parts.add(sweep(stations, { sides: 22, capStart: true, capEnd: true, hint: V(1, 0, 0) }), M.CLOTH);

  // --- deltoid caps: what actually gives a soldier square shoulders ---
  for (const side of [1, -1]) {
    const n = side > 0 ? 'R' : 'L';
    const sh = J(`upperArm${n}`);
    const cap = roundedBox(0.125, 0.150, 0.140, 0.055, 2);
    transform(cap, { pos: V(sh.x + side * 0.006, sh.y + 0.012, sh.z + 0.004), rot: [0, 0, -side * 0.16] });
    projectUV(cap, 1);
    autoSkin(cap, [[`upperArm${n}`, 1.5], [`clavicle${n}`, 0.8], ['spine3', 0.45]], { falloff: 0.13 });
    parts.add(cap, M.CLOTH);
  }

  // --- collar -------------------------------------------------------
  const collar = sweep([
    { p: V(0, 1.408, -0.024), rx: 0.088, ry: 0.080, n: 2.3 },
    { p: V(0, 1.452, -0.026), rx: 0.083, ry: 0.076, n: 2.3 },
    { p: V(0, 1.478, -0.028), rx: 0.089, ry: 0.082, n: 2.3 },
  ], { sides: 16, hint: V(1, 0, 0) });
  autoSkin(collar, [['neck', 1.2], ['spine3', 1]], { falloff: 0.09 });
  parts.add(collar, M.CLOTH);

  // --- belt ---------------------------------------------------------
  const belt = sweep([
    { p: V(0, 0.918, 0.012), rx: 0.163, ry: 0.122, n: 2.6 },
    { p: V(0, 0.958, 0.010), rx: 0.166, ry: 0.125, n: 2.6 },
  ], { sides: 20, hint: V(1, 0, 0) });
  rigid(belt, [['pelvis', 1]]);
  parts.add(belt, M.GEAR);
  const buckle = roundedBox(0.055, 0.042, 0.022, 0.008, 1);
  transform(buckle, { pos: V(0, 0.938, -0.132) });
  projectUV(buckle, 1);
  rigid(buckle, [['pelvis', 1]]);
  parts.add(buckle, M.STEEL);
}

function buildPlateCarrier(parts, kit, rand) {
  // --- front and back plates ---------------------------------------
  const front = shellPlate({ radius: 0.205, arc: 1.42, height: 0.375, thickness: 0.030, segU: 12, segV: 8, cornerX: 0.28, cornerY: 0.22 });
  transform(front, { pos: V(0, 1.212, 0.052) });
  projectUV(front, 1);
  rigid(front, [['spine2', 0.45], ['spine3', 0.55]]);
  parts.add(front, M.GEAR);

  const back = shellPlate({ radius: 0.205, arc: 1.38, height: 0.385, thickness: 0.030, segU: 12, segV: 8, cornerX: 0.28, cornerY: 0.20 });
  transform(back, { pos: V(0, 1.215, -0.085), rot: [0, Math.PI, 0] });
  projectUV(back, 1);
  rigid(back, [['spine2', 0.4], ['spine3', 0.6]]);
  parts.add(back, M.GEAR);

  // --- cummerbund ---------------------------------------------------
  const cb = sweep([
    { p: V(0, 1.058, -0.004), rx: 0.196, ry: 0.140, n: 2.8 },
    { p: V(0, 1.108, -0.008), rx: 0.200, ry: 0.144, n: 2.8 },
    { p: V(0, 1.152, -0.012), rx: 0.196, ry: 0.140, n: 2.8 },
  ], { sides: 22, hint: V(1, 0, 0) });
  autoSkin(cb, [['spine1', 1], ['spine2', 1.2], ['pelvis', 0.5]], { falloff: 0.14 });
  parts.add(cb, M.GEAR);

  // --- shoulder straps ---------------------------------------------
  for (const side of [1, -1]) {
    const n = side > 0 ? 'R' : 'L';
    const strap = ribbon([
      V(side * 0.078, 1.372, -0.163),
      V(side * 0.092, 1.420, -0.120),
      V(side * 0.104, 1.452, -0.040),
      V(side * 0.100, 1.442, 0.040),
      V(side * 0.082, 1.372, 0.108),
    ], 0.082, 0.016, V(0, 0, -1));
    autoSkin(strap, [['spine3', 1.4], [`clavicle${n}`, 0.8], ['spine2', 0.4]], { falloff: 0.16 });
    parts.add(strap, M.GEAR);

    const pad = roundedBox(0.098, 0.030, 0.115, 0.014, 2);
    transform(pad, { pos: V(side * 0.100, 1.452, -0.010), rot: [0, 0, -side * 0.12] });
    projectUV(pad, 1);
    rigid(pad, [['spine3', 0.75], [`clavicle${n}`, 0.25]]);
    parts.add(pad, M.GEAR);
  }

  // --- front magazine pouches --------------------------------------
  const pouchX = [-0.108, -0.004, 0.100];
  for (let i = 0; i < 3; i++) {
    const bone = pouchX[i] < 0 ? 'gearFrontL' : 'gearFrontR';
    const body = roundedBox(0.086, 0.155, 0.062, 0.013, 2);
    const yaw = -pouchX[i] * 1.5;
    transform(body, { pos: V(pouchX[i], 1.098, -0.196 + Math.abs(pouchX[i]) * 0.14), rot: [0.06, yaw, 0] });
    projectUV(body, 1);
    rigid(body, [[bone, 0.85], ['spine2', 0.15]]);
    parts.add(body, M.GEAR);

    const flap = roundedBox(0.090, 0.052, 0.020, 0.008, 1);
    transform(flap, { pos: V(pouchX[i], 1.176, -0.212 + Math.abs(pouchX[i]) * 0.14), rot: [0.42, yaw, 0] });
    projectUV(flap, 1);
    rigid(flap, [[bone, 0.85], ['spine2', 0.15]]);
    parts.add(flap, M.GEAR);

    // exposed magazine lip: reads as loaded kit rather than solid blocks
    const mag = roundedBox(0.026, 0.040, 0.058, 0.005, 1);
    transform(mag, { pos: V(pouchX[i], 1.186, -0.192 + Math.abs(pouchX[i]) * 0.14), rot: [0.06, yaw, 0] });
    projectUV(mag, 1);
    rigid(mag, [[bone, 0.85], ['spine2', 0.15]]);
    parts.add(mag, M.POLY);
  }

  // --- admin / utility pouches -------------------------------------
  const admin = roundedBox(0.128, 0.086, 0.042, 0.012, 2);
  transform(admin, { pos: V(-0.030, 1.268, -0.196), rot: [-0.12, 0.10, 0] });
  projectUV(admin, 1);
  rigid(admin, [['gearFrontL', 0.6], ['spine3', 0.4]]);
  parts.add(admin, M.GEAR);

  const util = roundedBox(0.060, 0.100, 0.070, 0.014, 2);
  transform(util, { pos: V(-0.176, 1.120, -0.060), rot: [0, -0.5, 0] });
  projectUV(util, 1);
  rigid(util, [['gearFrontL', 0.5], ['spine2', 0.5]]);
  parts.add(util, M.GEAR);

  // --- radio on the back, the antenna that breaks the silhouette ----
  const radio = roundedBox(0.092, 0.150, 0.060, 0.012, 2);
  transform(radio, { pos: V(0.052, 1.240, 0.150), rot: [0, 0.12, 0.06] });
  projectUV(radio, 1);
  rigid(radio, [['gearBack', 0.85], ['spine3', 0.15]]);
  parts.add(radio, M.GEAR);

  if (kit.antenna) {
    const ant = sweep([
      { p: V(0.062, 1.312, 0.166), rx: 0.008, ry: 0.008, bones: [['gearBack', 1]] },
      { p: V(0.070, 1.400, 0.178), rx: 0.006, ry: 0.006, bones: [['gearBack', 0.8], ['gearAnt', 0.2]] },
      { p: V(0.078, 1.500, 0.190), rx: 0.005, ry: 0.005, bones: [['gearBack', 0.45], ['gearAnt', 0.55]] },
      { p: V(0.086, 1.610, 0.196), rx: 0.004, ry: 0.004, bones: [['gearAnt', 0.85], ['gearBack', 0.15]] },
      { p: V(0.094, 1.712, 0.192), rx: 0.003, ry: 0.003, bones: [['gearAnt', 1]] },
      { p: V(0.100, 1.790, 0.180), rx: 0.002, ry: 0.002, bones: [['gearAnt', 1]] },
    ], { sides: 5, capStart: true, capEnd: true, hint: V(1, 0, 0) });
    parts.add(ant, M.POLY);
  }

  // --- grenade ------------------------------------------------------
  if (kit.grenade) {
    const gren = roundedBox(0.056, 0.086, 0.056, 0.026, 2);
    transform(gren, { pos: V(-0.140, 1.238, -0.150), rot: [0, 0, 0.2] });
    projectUV(gren, 1);
    rigid(gren, [['gearFrontL', 0.7], ['spine3', 0.3]]);
    parts.add(gren, M.POLY);
    const lever = roundedBox(0.010, 0.062, 0.014, 0.004, 1);
    transform(lever, { pos: V(-0.166, 1.244, -0.152), rot: [0, 0, 0.2] });
    projectUV(lever, 1);
    rigid(lever, [['gearFrontL', 0.7], ['spine3', 0.3]]);
    parts.add(lever, M.STEEL);
  }

  // --- IFAK on the belt line ---------------------------------------
  const ifak = roundedBox(0.110, 0.082, 0.058, 0.012, 2);
  transform(ifak, { pos: V(-0.108, 1.010, 0.128), rot: [0, -0.2, 0] });
  projectUV(ifak, 1);
  rigid(ifak, [['gearBack', 0.4], ['pelvis', 0.6]]);
  parts.add(ifak, M.GEAR);

  // --- dump pouch, hanging and swinging on the hip bone -------------
  if (kit.dump) {
    const bag = sweep([
      { p: V(0.196, 0.960, 0.040), rx: 0.064, ry: 0.048, n: 2.6, bones: [['gearHipR', 1]] },
      { p: V(0.200, 0.900, 0.046), rx: 0.076, ry: 0.058, n: 2.6, bones: [['gearHipR', 1]] },
      { p: V(0.202, 0.836, 0.050), rx: 0.070, ry: 0.054, n: 2.6, bones: [['gearHipR', 1]] },
      { p: V(0.200, 0.800, 0.048), rx: 0.048, ry: 0.036, n: 2.6, bones: [['gearHipR', 1]] },
    ], { sides: 14, capStart: true, capEnd: true, hint: V(0, 0, -1) });
    parts.add(bag, M.GEAR);
  }

  // --- sling: shoulder to weapon, weighted across both ---------------
  const sling = sweep([
    { p: V(-0.104, 1.446, -0.030), rx: 0.021, ry: 0.005, n: 3.4, bones: [['spine3', 1]] },
    { p: V(-0.070, 1.372, -0.150), rx: 0.020, ry: 0.005, n: 3.4, bones: [['spine3', 0.9], ['spine2', 0.1]] },
    { p: V(-0.010, 1.318, -0.270), rx: 0.019, ry: 0.005, n: 3.4, bones: [['spine3', 0.55], ['handR', 0.45]] },
    { p: V(0.070, 1.288, -0.390), rx: 0.018, ry: 0.005, n: 3.4, bones: [['handR', 0.9], ['spine3', 0.1]] },
    { p: V(0.119, 1.278, -0.468), rx: 0.017, ry: 0.005, n: 3.4, bones: [['handR', 1]] },
  ], { sides: 6, capStart: true, capEnd: true, hint: V(0, 1, 0) });
  parts.add(sling, M.LEATHER);

  // --- shoulder patch (subdued IR flag) -----------------------------
  const patch = shellPlate({ radius: 0.075, arc: 1.1, height: 0.052, thickness: 0.004, segU: 5, segV: 3, cornerX: 0.1, cornerY: 0.1 });
  transform(patch, { pos: V(0.196, 1.330, -0.010), rot: [0, -1.35, 0.1] });
  projectUV(patch, 1);
  rigid(patch, [['upperArmR', 1]]);
  parts.add(patch, M.POLY);
}

/* ------------------------------------------------------------------ */

function buildArms(parts, kit, rand) {
  for (const side of [1, -1]) {
    const n = side > 0 ? 'R' : 'L';
    const shoulder = J(`upperArm${n}`);
    const elbow = J(`lowerArm${n}`);
    const wrist = J(`hand${n}`);

    const table = [
      [0.00, [[`upperArm${n}`, 0.7], [`clavicle${n}`, 0.3]]],
      [0.18, [[`upperArm${n}`, 1]]],
      [0.42, [[`upperArm${n}`, 0.85], [`lowerArm${n}`, 0.15]]],
      [0.52, [[`upperArm${n}`, 0.5], [`lowerArm${n}`, 0.5]]],
      [0.62, [[`lowerArm${n}`, 0.9], [`upperArm${n}`, 0.1]]],
      [0.88, [[`lowerArm${n}`, 1]]],
      [1.00, [[`lowerArm${n}`, 0.55], [`hand${n}`, 0.45]]],
    ];

    const stations = chainStations([shoulder, elbow, wrist], [6, 6], (s) => {
      // upper arm tapers into the elbow, forearm swells then tapers to the cuff
      let r;
      if (s < 0.5) r = lerp(0.066, 0.050, s / 0.5);
      else r = lerp(0.052, 0.036, (s - 0.5) / 0.5) + Math.sin((s - 0.5) * 3.4) * 0.010;
      // sleeve bunching: three fold rings above the elbow, one at the cuff
      const fold = 1 + Math.sin(s * 34 + 0.8) * 0.028 * Math.exp(-Math.pow((s - 0.45) * 3.2, 2))
                     + Math.sin(s * 26) * 0.010;
      const cuff = s > 0.94 ? 1.14 : 1;
      return {
        rx: r * fold * cuff, ry: r * fold * cuff * 1.06, n: 2.2,
        bones: weightRamp(s, table),
      };
    });
    parts.add(sweep(stations, { sides: 14, capStart: true, capEnd: false, hint: V(0, 0, -1) }), M.CLOTH);

    // elbow pad
    const mid = new THREE.Vector3().copy(elbow);
    const dir = new THREE.Vector3().subVectors(elbow, shoulder).normalize();
    const pad = shellPlate({ radius: 0.062, arc: 1.5, height: 0.115, thickness: 0.012, segU: 6, segV: 5, cornerX: 0.25, cornerY: 0.3 });
    const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), dir);
    const back = new THREE.Vector3().crossVectors(dir, V(side, 0, 0)).normalize();
    const yaw = Math.atan2(back.x, back.z) + Math.PI;
    transform(pad, { quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)).premultiply(q), pos: mid });
    projectUV(pad, 1);
    rigid(pad, [[`upperArm${n}`, 0.55], [`lowerArm${n}`, 0.45]]);
    parts.add(pad, M.POLY);

    buildHand(parts, kit, n, side);
  }
}

/** Gloved hand curled around a grip. */
function buildHand(parts, kit, n, side) {
  const wrist = J(`hand${n}`);
  const forearm = J(`lowerArm${n}`);
  const axis = new THREE.Vector3().subVectors(wrist, forearm).normalize();
  // grip axis: the rifle runs along −Z, so fingers curl about it
  const gripAxis = V(0, 0, -1);
  const up = new THREE.Vector3().crossVectors(gripAxis, axis).normalize();
  if (up.lengthSq() < 0.1) up.set(0, 1, 0);
  const across = new THREE.Vector3().crossVectors(axis, up).normalize();

  const palmCenter = wrist.clone().addScaledVector(axis, 0.038);
  const palm = roundedBox(0.052, 0.098, 0.086, 0.022, 2);
  const m = new THREE.Matrix4().makeBasis(across, axis, up);
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  transform(palm, { pos: palmCenter, quat: q });
  projectUV(palm, 1);
  rigid(palm, [[`hand${n}`, 0.9], [`lowerArm${n}`, 0.1]]);
  parts.add(palm, M.LEATHER);

  // four fingers curling around the grip, plus the thumb over the top
  for (let f = 0; f < 4; f++) {
    const t = (f - 1.5) * 0.024;
    const base = palmCenter.clone().addScaledVector(gripAxis, t).addScaledVector(axis, 0.030).addScaledVector(up, -0.014);
    const mid = base.clone().addScaledVector(up, -0.030).addScaledVector(axis, 0.014);
    const tip = mid.clone().addScaledVector(up, -0.018).addScaledVector(axis, -0.026);
    const fg = sweep([
      { p: base, rx: 0.0125, ry: 0.0125 },
      { p: mid, rx: 0.0115, ry: 0.0115 },
      { p: tip, rx: 0.0095, ry: 0.0095 },
    ], { sides: 6, capStart: true, capEnd: true, hint: across });
    rigid(fg, [[`hand${n}`, 1]]);
    parts.add(fg, M.LEATHER);
  }
  const thumbBase = palmCenter.clone().addScaledVector(gripAxis, side * 0.030).addScaledVector(axis, 0.012);
  const thumbTip = thumbBase.clone().addScaledVector(gripAxis, -side * 0.026).addScaledVector(axis, 0.042).addScaledVector(up, -0.010);
  const th = tube(thumbBase, thumbTip, 0.014, 0.011, 6);
  rigid(th, [[`hand${n}`, 1]]);
  parts.add(th, M.LEATHER);

  // knuckle guard
  const guard = roundedBox(0.048, 0.030, 0.070, 0.010, 1);
  transform(guard, { pos: palmCenter.clone().addScaledVector(up, 0.040).addScaledVector(axis, 0.014), quat: q });
  projectUV(guard, 1);
  rigid(guard, [[`hand${n}`, 1]]);
  parts.add(guard, M.POLY);

  // cuff over the wrist
  const cuff = sweep([
    { p: wrist.clone().addScaledVector(axis, -0.040), rx: 0.042, ry: 0.040, n: 2.4 },
    { p: wrist.clone().addScaledVector(axis, -0.008), rx: 0.046, ry: 0.044, n: 2.4 },
  ], { sides: 12, hint: across });
  rigid(cuff, [[`hand${n}`, 0.5], [`lowerArm${n}`, 0.5]]);
  parts.add(cuff, M.LEATHER);
}

/* ------------------------------------------------------------------ */

function buildLegs(parts, kit, rand) {
  for (const side of [1, -1]) {
    const n = side > 0 ? 'R' : 'L';
    const hip = J(`thigh${n}`);
    const knee = J(`shin${n}`);
    const ankle = J(`foot${n}`);
    const toe = J(`toe${n}`);

    const table = [
      [0.00, [[`thigh${n}`, 0.8], ['pelvis', 0.2]]],
      [0.20, [[`thigh${n}`, 1]]],
      [0.44, [[`thigh${n}`, 0.85], [`shin${n}`, 0.15]]],
      [0.53, [[`thigh${n}`, 0.5], [`shin${n}`, 0.5]]],
      [0.62, [[`shin${n}`, 0.9], [`thigh${n}`, 0.1]]],
      [0.92, [[`shin${n}`, 1]]],
      [1.00, [[`shin${n}`, 0.7], [`foot${n}`, 0.3]]],
    ];

    const stations = chainStations([hip, knee, ankle], [7, 7], (s) => {
      let rx;
      if (s < 0.52) rx = lerp(0.104, 0.082, s / 0.52);
      else rx = lerp(0.083, 0.062, (s - 0.52) / 0.48) + Math.sin((s - 0.52) * 3.0) * 0.012;
      // cargo-trouser bagginess plus blousing above the boot
      const bag = 1 + Math.sin(s * 19 + 2.1) * 0.020 + Math.sin(s * 33) * 0.010;
      const blouse = s > 0.88 ? 1 + (s - 0.88) * 1.6 : 1;
      return {
        rx: rx * bag * blouse, ry: rx * bag * blouse * 1.05, n: 2.35,
        oy: s < 0.52 ? 0 : 0.006,
        bones: weightRamp(s, table),
      };
    });
    parts.add(sweep(stations, { sides: 16, capStart: true, capEnd: true, hint: V(1, 0, 0) }), M.CLOTH);

    // cargo pocket on the outer thigh
    const thighDir = new THREE.Vector3().subVectors(knee, hip).normalize();
    const pocketPos = hip.clone().addScaledVector(thighDir, 0.20).add(V(side * 0.082, 0, -0.020));
    const pocket = roundedBox(0.052, 0.155, 0.118, 0.016, 2);
    transform(pocket, { pos: pocketPos, rot: [0.05, 0, side * 0.04] });
    projectUV(pocket, 1);
    rigid(pocket, [[`thigh${n}`, 1]]);
    parts.add(pocket, M.CLOTH);
    const flap = roundedBox(0.056, 0.040, 0.122, 0.010, 1);
    transform(flap, { pos: pocketPos.clone().add(V(0, 0.086, 0)), rot: [0.05, 0, side * 0.04] });
    projectUV(flap, 1);
    rigid(flap, [[`thigh${n}`, 1]]);
    parts.add(flap, M.CLOTH);

    // knee pad
    const kneeDir = new THREE.Vector3().subVectors(knee, hip).normalize();
    const pad = shellPlate({ radius: 0.090, arc: 1.55, height: 0.165, thickness: 0.016, segU: 7, segV: 6, cornerX: 0.22, cornerY: 0.26 });
    const qq = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), kneeDir);
    transform(pad, { pos: knee.clone().addScaledVector(kneeDir, 0.010), quat: qq });
    projectUV(pad, 1);
    rigid(pad, [[`thigh${n}`, 0.55], [`shin${n}`, 0.45]]);
    parts.add(pad, M.POLY);

    // knee pad straps
    for (const t of [-0.055, 0.062]) {
      const c = knee.clone().addScaledVector(kneeDir, t);
      const strap = sweep([
        { p: c.clone().add(V(0, 0, -0.075)), rx: 0.024, ry: 0.006, n: 3 },
        { p: c.clone().add(V(side * 0.075, 0, 0)), rx: 0.024, ry: 0.006, n: 3 },
        { p: c.clone().add(V(0, 0, 0.070)), rx: 0.024, ry: 0.006, n: 3 },
      ], { sides: 6, capStart: true, capEnd: true, hint: V(0, 1, 0) });
      rigid(strap, [[`thigh${n}`, 0.5], [`shin${n}`, 0.5]]);
      parts.add(strap, M.GEAR);
    }

    buildBoot(parts, kit, n, side, ankle, toe);
  }
}

function buildBoot(parts, kit, n, side, ankle, toe) {
  const x = ankle.x;
  const heel = V(x, 0.052, ankle.z + 0.058);
  const arch = V(x, 0.046, ankle.z - 0.010);
  const ball = V(x, 0.044, toe.z + 0.018);
  const tip = V(x, 0.036, toe.z - 0.062);

  const boot = sweep([
    { p: V(x, 0.208, ankle.z + 0.010), rx: 0.056, ry: 0.062, n: 2.6, bones: [['shin' + n, 0.85], ['foot' + n, 0.15]] },
    { p: V(x, 0.150, ankle.z + 0.014), rx: 0.058, ry: 0.064, n: 2.8, bones: [['shin' + n, 0.55], ['foot' + n, 0.45]] },
    { p: V(x, 0.100, ankle.z + 0.026), rx: 0.058, ry: 0.070, n: 3.0, bones: [['foot' + n, 0.95], ['shin' + n, 0.05]] },
    { p: heel, rx: 0.056, ry: 0.078, n: 3.4, bones: [['foot' + n, 1]] },
  ], { sides: 12, capStart: true, capEnd: false, hint: V(1, 0, 0) });
  parts.add(boot, M.LEATHER);

  // the foot itself, swept nose-down from heel to toe with a boxy section
  const foot = sweep([
    { p: heel.clone().add(V(0, 0.020, 0.004)), rx: 0.048, ry: 0.052, n: 3.4, bones: [['foot' + n, 1]] },
    { p: arch, rx: 0.052, ry: 0.048, n: 3.6, bones: [['foot' + n, 1]] },
    { p: ball, rx: 0.052, ry: 0.044, n: 3.8, bones: [['foot' + n, 0.55], ['toe' + n, 0.45]] },
    { p: tip, rx: 0.043, ry: 0.034, n: 3.6, bones: [['toe' + n, 1]] },
  ], { sides: 12, capStart: true, capEnd: true, hint: V(1, 0, 0) });
  parts.add(foot, M.LEATHER);

  // sole: a flat slab with a lugged edge
  const sole = sweep([
    { p: heel.clone().add(V(0, -0.026, 0.012)), rx: 0.049, ry: 0.016, n: 5, bones: [['foot' + n, 1]] },
    { p: arch.clone().add(V(0, -0.030, 0)), rx: 0.053, ry: 0.018, n: 5, bones: [['foot' + n, 1]] },
    { p: ball.clone().add(V(0, -0.030, 0)), rx: 0.054, ry: 0.017, n: 5, bones: [['foot' + n, 0.5], ['toe' + n, 0.5]] },
    { p: tip.clone().add(V(0, -0.020, 0.004)), rx: 0.044, ry: 0.014, n: 5, bones: [['toe' + n, 1]] },
  ], { sides: 10, capStart: true, capEnd: true, hint: V(1, 0, 0) });
  parts.add(sole, M.POLY);

  // laces
  for (let i = 0; i < 4; i++) {
    const t = 0.06 + i * 0.038;
    const y = 0.078 + i * 0.036;
    const z = ankle.z + 0.028 - i * 0.014;
    const lace = tube(V(x - 0.040, y, z - 0.014), V(x + 0.040, y + 0.010, z + 0.006), 0.0055, 0.0055, 5);
    rigid(lace, [['foot' + n, 0.7], ['shin' + n, 0.3]]);
    parts.add(lace, M.GEAR);
    void t;
  }
}

/* ------------------------------------------------------------------ */

function buildHead(parts, kit, rand) {
  const head = J('head');

  // --- neck ---------------------------------------------------------
  const neck = sweep([
    { p: V(0, 1.388, -0.024), rx: 0.062, ry: 0.058, bones: [['spine3', 0.5], ['neck', 0.5]] },
    { p: V(0, 1.452, -0.022), rx: 0.058, ry: 0.055, bones: [['neck', 1]] },
    { p: V(0, 1.500, -0.020), rx: 0.060, ry: 0.058, bones: [['neck', 0.6], ['head', 0.4]] },
  ], { sides: 12, hint: V(1, 0, 0) });
  parts.add(neck, M.SKIN);

  // --- skull --------------------------------------------------------
  const skull = roundedBox(0.152, 0.198, 0.196, 0.074, 3);
  transform(skull, { pos: V(head.x, head.y + 0.058, head.z - 0.004), scale: V(1, 1, 1.04) });
  projectUV(skull, 1);
  autoSkin(skull, [['head', 2.0], ['neck', 0.5]], { falloff: 0.16 });
  parts.add(skull, M.SKIN);

  // --- jaw / chin ---------------------------------------------------
  const jaw = roundedBox(0.116, 0.086, 0.126, 0.034, 2);
  transform(jaw, { pos: V(head.x, head.y - 0.018, head.z - 0.030), rot: [0.10, 0, 0] });
  projectUV(jaw, 1);
  autoSkin(jaw, [['head', 2.0], ['neck', 0.4]], { falloff: 0.16 });
  parts.add(jaw, M.SKIN);

  // --- nose + brow, so the profile is not a featureless egg ---------
  const nose = roundedBox(0.030, 0.048, 0.044, 0.012, 1);
  transform(nose, { pos: V(head.x, head.y + 0.028, head.z - 0.098), rot: [0.30, 0, 0] });
  projectUV(nose, 1);
  rigid(nose, [['head', 1]]);
  parts.add(nose, M.SKIN);

  const brow = roundedBox(0.132, 0.026, 0.050, 0.012, 1);
  transform(brow, { pos: V(head.x, head.y + 0.068, head.z - 0.082), rot: [-0.16, 0, 0] });
  projectUV(brow, 1);
  rigid(brow, [['head', 1]]);
  parts.add(brow, M.SKIN);

  // --- lower face cover --------------------------------------------
  if (kit.face === 'balaclava') {
    const mask = roundedBox(0.130, 0.108, 0.140, 0.040, 2);
    transform(mask, { pos: V(head.x, head.y - 0.016, head.z - 0.026), rot: [0.08, 0, 0] });
    projectUV(mask, 1);
    autoSkin(mask, [['head', 2.0], ['neck', 0.5]], { falloff: 0.17 });
    parts.add(mask, M.GEAR);
  } else if (kit.face === 'shemagh') {
    const scarf = sweep([
      { p: V(0, 1.474, -0.030), rx: 0.098, ry: 0.092, n: 2.4, bones: [['head', 0.8], ['neck', 0.2]] },
      { p: V(0, 1.428, -0.030), rx: 0.108, ry: 0.100, n: 2.4, bones: [['neck', 0.7], ['head', 0.3]] },
      { p: V(0, 1.386, -0.026), rx: 0.116, ry: 0.106, n: 2.4, bones: [['neck', 0.6], ['spine3', 0.4]] },
      { p: V(0.006, 1.348, -0.018), rx: 0.112, ry: 0.100, n: 2.4, bones: [['spine3', 0.9], ['neck', 0.1]] },
    ], { sides: 16, capStart: false, capEnd: true, hint: V(1, 0, 0) });
    parts.add(scarf, M.GEAR);
    // a tail of cloth over the shoulder
    const tail = ribbon([
      V(0.070, 1.372, 0.020), V(0.118, 1.330, 0.060), V(0.146, 1.262, 0.078), V(0.150, 1.196, 0.062),
    ], 0.090, 0.010, V(1, 0, 0));
    rigid(tail, [['spine3', 0.85], ['neck', 0.15]]);
    parts.add(tail, M.GEAR);
  }

  // --- helmet -------------------------------------------------------
  buildHelmet(parts, kit, head);

  // --- headset ------------------------------------------------------
  for (const side of [1, -1]) {
    const cup = roundedBox(0.034, 0.084, 0.070, 0.016, 2);
    transform(cup, { pos: V(side * 0.090, head.y + 0.012, head.z + 0.004) });
    projectUV(cup, 1);
    rigid(cup, [['head', 1]]);
    parts.add(cup, M.POLY);
  }
  const mic = sweep([
    { p: V(0.086, head.y - 0.006, head.z - 0.020), rx: 0.005, ry: 0.005, bones: [['head', 1]] },
    { p: V(0.070, head.y - 0.030, head.z - 0.070), rx: 0.0045, ry: 0.0045, bones: [['head', 1]] },
    { p: V(0.042, head.y - 0.042, head.z - 0.098), rx: 0.004, ry: 0.004, bones: [['head', 1]] },
  ], { sides: 5, capStart: true, capEnd: false, hint: V(0, 1, 0) });
  parts.add(mic, M.POLY);
  const micHead = roundedBox(0.020, 0.016, 0.016, 0.006, 1);
  transform(micHead, { pos: V(0.036, head.y - 0.045, head.z - 0.106) });
  projectUV(micHead, 1);
  rigid(micHead, [['head', 1]]);
  parts.add(micHead, M.POLY);
}

/**
 * Ballistic helmet: two shells (outer and liner) whose lower edge follows a
 * real cut — high over the ears, a brow line at the front, longer at the nape —
 * so it does not read as a bowl.
 */
function buildHelmet(parts, kit, head) {
  const cx = head.x, cy = head.y + 0.052, cz = head.z - 0.004;
  const rx = kit.helmet === 'mich' ? 0.116 : 0.112;
  const ry = 0.108;
  const rz = kit.helmet === 'mich' ? 0.128 : 0.124;
  const lon = 24, lat = 8;
  const highCut = kit.helmet === 'fast';

  const pos = [];
  const idx = [];
  const build = (offset, flip) => {
    const base = pos.length / 3;
    for (let iv = 0; iv <= lat; iv++) {
      for (let iu = 0; iu <= lon; iu++) {
        const u = (iu / lon) * TAU;
        // lower edge angle per longitude: front brow, high ear cut, low nape
        const front = Math.cos(u);          // −Z direction weight
        const sideAbs = Math.abs(Math.sin(u));
        let vMax = 1.36;                    // radians of polar angle at the rim
        vMax -= front * 0.16;
        vMax -= sideAbs * (highCut ? 0.30 : 0.16);
        const v = (iv / lat) * vMax;
        const sv = Math.sin(v), cv = Math.cos(v);
        const nx = sv * Math.sin(u);
        const ny = cv;
        const nz = -sv * Math.cos(u);
        pos.push(cx + nx * (rx + offset), cy + ny * (ry + offset), cz + nz * (rz + offset));
      }
    }
    for (let iv = 0; iv < lat; iv++) {
      for (let iu = 0; iu < lon; iu++) {
        const a = base + iv * (lon + 1) + iu;
        const b = a + 1;
        const c = a + lon + 1;
        const d = c + 1;
        if (flip) idx.push(a, c, b, b, c, d);
        else idx.push(a, b, c, b, d, c);
      }
    }
    return base;
  };
  const outer = build(0.010, false);
  const inner = build(-0.006, true);
  // rim
  for (let iu = 0; iu < lon; iu++) {
    const o0 = outer + lat * (lon + 1) + iu;
    const o1 = o0 + 1;
    const i0 = inner + lat * (lon + 1) + iu;
    const i1 = i0 + 1;
    idx.push(o0, o1, i0, o1, i1, i0);
  }
  const shell = new THREE.BufferGeometry();
  shell.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  shell.setIndex(idx);
  shell.computeVertexNormals();
  projectUV(shell, 1);
  rigid(shell, [['head', 1]]);
  parts.add(shell, M.POLY);

  // helmet cover seams
  for (const ang of [-0.55, 0, 0.55]) {
    const pts = [];
    for (let i = 0; i <= 6; i++) {
      const v = 0.15 + (i / 6) * 1.05;
      const u = ang;
      pts.push(V(
        cx + Math.sin(v) * Math.sin(u) * (rx + 0.012),
        cy + Math.cos(v) * (ry + 0.012),
        cz - Math.sin(v) * Math.cos(u) * (rz + 0.012),
      ));
    }
    const seam = ribbon(pts, 0.014, 0.005, V(0, 1, 0));
    rigid(seam, [['head', 1]]);
    parts.add(seam, M.GEAR);
  }

  // NVG shroud + mount
  const shroud = roundedBox(0.058, 0.020, 0.052, 0.008, 1);
  transform(shroud, { pos: V(cx, cy + 0.070, cz - 0.108), rot: [0.42, 0, 0] });
  projectUV(shroud, 1);
  rigid(shroud, [['head', 1]]);
  parts.add(shroud, M.POLY);
  const arm = roundedBox(0.020, 0.052, 0.020, 0.006, 1);
  transform(arm, { pos: V(cx, cy + 0.098, cz - 0.118), rot: [0.30, 0, 0] });
  projectUV(arm, 1);
  rigid(arm, [['head', 1]]);
  parts.add(arm, M.STEEL);

  // side rails
  for (const side of [1, -1]) {
    const rail = roundedBox(0.012, 0.026, 0.150, 0.005, 1);
    transform(rail, { pos: V(cx + side * (rx + 0.014), cy + 0.010, cz - 0.006), rot: [0, 0, side * 0.12] });
    projectUV(rail, 1);
    rigid(rail, [['head', 1]]);
    parts.add(rail, M.POLY);
  }

  // counterweight pouch at the nape
  const cw = roundedBox(0.104, 0.070, 0.052, 0.020, 2);
  transform(cw, { pos: V(cx, cy + 0.030, cz + rz + 0.014), rot: [-0.25, 0, 0] });
  projectUV(cw, 1);
  rigid(cw, [['head', 1]]);
  parts.add(cw, M.GEAR);

  // chin strap
  for (const side of [1, -1]) {
    const strap = ribbon([
      V(cx + side * (rx + 0.004), cy - 0.020, cz - 0.030),
      V(cx + side * 0.070, cy - 0.080, cz - 0.046),
      V(cx + side * 0.034, cy - 0.128, cz - 0.052),
      V(cx, cy - 0.140, cz - 0.048),
    ], 0.020, 0.005, V(0, 0, -1));
    rigid(strap, [['head', 1]]);
    parts.add(strap, M.GEAR);
  }

  // goggles, pushed up on the shell
  if (kit.goggles) {
    const band = sweep([
      V(cx - rx - 0.014, cy + 0.030, cz + 0.020),
      V(cx - rx * 0.6, cy + 0.062, cz - rz * 0.85),
      V(cx, cy + 0.070, cz - rz - 0.012),
      V(cx + rx * 0.6, cy + 0.062, cz - rz * 0.85),
      V(cx + rx + 0.014, cy + 0.030, cz + 0.020),
      V(cx + rx * 0.5, cy + 0.020, cz + rz * 0.8),
      V(cx, cy + 0.016, cz + rz + 0.010),
      V(cx - rx * 0.5, cy + 0.020, cz + rz * 0.8),
      V(cx - rx - 0.014, cy + 0.030, cz + 0.020),
    ].map((p) => ({ p, rx: 0.016, ry: 0.006, n: 3.2, bones: [['head', 1]] })), { sides: 6, hint: V(0, 1, 0) });
    parts.add(band, M.GEAR);

    const frame = shellPlate({ radius: 0.118, arc: 1.28, height: 0.070, thickness: 0.024, segU: 9, segV: 4, cornerX: 0.22, cornerY: 0.30 });
    transform(frame, { pos: V(cx, cy + 0.066, cz + 0.006) });
    projectUV(frame, 1);
    rigid(frame, [['head', 1]]);
    parts.add(frame, M.GEAR);

    const lens = shellPlate({ radius: 0.112, arc: 1.16, height: 0.050, thickness: 0.006, segU: 9, segV: 3, cornerX: 0.22, cornerY: 0.30 });
    transform(lens, { pos: V(cx, cy + 0.066, cz + 0.006) });
    projectUV(lens, 1);
    rigid(lens, [['head', 1]]);
    parts.add(lens, M.GLASS);
  }
}

/* ------------------------------------------------------------------ */
/* weapon                                                              */
/* ------------------------------------------------------------------ */

/**
 * A carbine, rigid-bound to the right hand. Detailed enough that the
 * silhouette reads as a specific weapon at 25 m: railed handguard, red dot on
 * a riser, angled foregrip, curved magazine, collapsible stock.
 */
function buildWeapon(parts, kit) {
  const bx = WEAPON_BORE.x;
  const by = WEAPON_BORE.y;
  const box = (w, h, d, r, x, y, z, rot, mat, seg = 1) => {
    const g = roundedBox(w, h, d, r, seg);
    transform(g, { pos: V(x, y, z), rot: rot || [0, 0, 0] });
    projectUV(g, 1);
    rigid(g, [['handR', 1]]);
    parts.add(g, mat);
    return g;
  };

  // --- lower receiver, magazine well and grip ----------------------
  box(0.052, 0.096, 0.200, 0.010, bx, by - 0.038, -0.395, null, M.STEEL, 2);
  // upper receiver
  box(0.050, 0.054, 0.200, 0.010, bx, by + 0.022, -0.400, null, M.STEEL, 2);
  // top rail: ten machined segments from the charging handle to the gas block
  for (let i = 0; i < 10; i++) {
    box(0.044, 0.008, 0.014, 0.002, bx, by + 0.052, -0.320 - i * 0.026, null, M.STEEL);
  }

  // handguard: octagonal, railed, running from the receiver to the gas block
  const hg = sweep([
    { p: V(bx, by, -0.470), rx: 0.031, ry: 0.031, n: 5 },
    { p: V(bx, by, -0.580), rx: 0.030, ry: 0.030, n: 5 },
    { p: V(bx, by, -0.720), rx: 0.028, ry: 0.028, n: 5 },
    { p: V(bx, by, -0.830), rx: 0.026, ry: 0.026, n: 5 },
  ], { sides: 12, capStart: false, capEnd: true, hint: V(1, 0, 0) });
  rigid(hg, [['handR', 1]]);
  parts.add(hg, M.POLY);
  for (let i = 0; i < 9; i++) {
    box(0.038, 0.007, 0.016, 0.002, bx, by + 0.032, -0.500 - i * 0.032, null, M.POLY);
  }
  for (const side of [1, -1]) {
    for (let i = 0; i < 4; i++) {
      box(0.008, 0.030, 0.062, 0.002, bx + side * 0.031, by - 0.002, -0.520 - i * 0.075, null, M.POLY);
    }
  }

  // barrel, gas block, muzzle brake
  const barrel = tube(V(bx, by, -0.800), V(bx, by, -0.945), 0.0115, 0.0105, 10);
  rigid(barrel, [['handR', 1]]);
  parts.add(barrel, M.STEEL);
  box(0.028, 0.036, 0.030, 0.004, bx, by + 0.008, -0.812, null, M.STEEL);
  const brake = tube(V(bx, by, -0.945), V(bx, by, -0.995), 0.0175, 0.0165, 10);
  rigid(brake, [['handR', 1]]);
  parts.add(brake, M.STEEL);
  for (let i = 0; i < 3; i++) {
    box(0.040, 0.008, 0.006, 0.002, bx, by, -0.955 - i * 0.014, null, M.STEEL);
  }

  // magazine: curved, hanging from the well just ahead of the grip
  const mag = sweep([
    { p: V(bx, by - 0.074, -0.428), rx: 0.017, ry: 0.038, n: 4.5 },
    { p: V(bx, by - 0.150, -0.436), rx: 0.017, ry: 0.038, n: 4.5 },
    { p: V(bx, by - 0.230, -0.452), rx: 0.017, ry: 0.038, n: 4.5 },
    { p: V(bx, by - 0.288, -0.466), rx: 0.016, ry: 0.036, n: 4.5 },
  ], { sides: 10, capStart: false, capEnd: true, hint: V(1, 0, 0) });
  rigid(mag, [['handR', 1]]);
  parts.add(mag, M.POLY);

  // pistol grip: runs through the right palm by construction
  const grip = sweep([
    { p: V(bx - 0.004, by - 0.048, -0.338), rx: 0.021, ry: 0.028, n: 3.2 },
    { p: V(bx - 0.002, by - 0.100, -0.318), rx: 0.023, ry: 0.030, n: 3.2 },
    { p: V(bx + 0.001, by - 0.151, -0.290), rx: 0.020, ry: 0.026, n: 3.2 },
  ], { sides: 10, capStart: false, capEnd: true, hint: V(1, 0, 0) });
  rigid(grip, [['handR', 1]]);
  parts.add(grip, M.POLY);
  // trigger guard
  const guard = sweep([
    { p: V(bx, by - 0.046, -0.352), rx: 0.006, ry: 0.006 },
    { p: V(bx, by - 0.078, -0.372), rx: 0.005, ry: 0.005 },
    { p: V(bx, by - 0.070, -0.404), rx: 0.005, ry: 0.005 },
    { p: V(bx, by - 0.040, -0.410), rx: 0.006, ry: 0.006 },
  ], { sides: 6, capStart: true, capEnd: true, hint: V(1, 0, 0) });
  rigid(guard, [['handR', 1]]);
  parts.add(guard, M.STEEL);

  // buffer tube, collapsible stock, cheek riser, buttplate
  const buffer = tube(V(bx, by + 0.006, -0.292), V(bx, by + 0.010, -0.135), 0.017, 0.017, 10);
  rigid(buffer, [['handR', 1]]);
  parts.add(buffer, M.STEEL);
  box(0.046, 0.072, 0.112, 0.012, bx, by - 0.006, -0.178, null, M.POLY, 2);
  box(0.040, 0.026, 0.088, 0.008, bx, by + 0.040, -0.186, [0.05, 0, 0], M.POLY);
  box(0.048, 0.106, 0.024, 0.008, bx, by - 0.012, -0.124, [0.09, 0, 0], M.POLY);

  // optic: riser, body, two lenses, killflash shade
  box(0.036, 0.030, 0.052, 0.006, bx, by + 0.056, -0.418, null, M.STEEL);
  box(0.046, 0.048, 0.098, 0.010, bx, by + 0.090, -0.420, null, M.POLY, 2);
  const lensFront = tube(V(bx, by + 0.090, -0.466), V(bx, by + 0.090, -0.474), 0.019, 0.019, 12);
  rigid(lensFront, [['handR', 1]]);
  parts.add(lensFront, M.GLASS);
  const lensRear = tube(V(bx, by + 0.090, -0.370), V(bx, by + 0.090, -0.374), 0.018, 0.018, 12);
  rigid(lensRear, [['handR', 1]]);
  parts.add(lensRear, M.GLASS);
  const shade = sweep([
    { p: V(bx, by + 0.090, -0.474), rx: 0.023, ry: 0.023, n: 2 },
    { p: V(bx, by + 0.090, -0.506), rx: 0.024, ry: 0.024, n: 2 },
  ], { sides: 12, hint: V(1, 0, 0) });
  rigid(shade, [['handR', 1]]);
  parts.add(shade, M.POLY);

  // angled foregrip ahead of the support hand
  const fg = sweep([
    { p: V(bx, by - 0.030, -0.612), rx: 0.019, ry: 0.019, n: 3 },
    { p: V(bx, by - 0.080, -0.646), rx: 0.017, ry: 0.017, n: 3 },
    { p: V(bx, by - 0.114, -0.680), rx: 0.015, ry: 0.015, n: 3 },
  ], { sides: 8, capStart: false, capEnd: true, hint: V(1, 0, 0) });
  rigid(fg, [['handR', 1]]);
  parts.add(fg, M.POLY);

  // charging handle, ejection port cover, laser unit, sling loop
  box(0.058, 0.014, 0.020, 0.004, bx, by + 0.044, -0.296, null, M.STEEL);
  box(0.010, 0.036, 0.070, 0.004, bx + 0.028, by + 0.020, -0.400, null, M.STEEL);
  box(0.034, 0.030, 0.048, 0.006, bx - 0.030, by + 0.020, -0.600, null, M.POLY);
  const laserLens = tube(V(bx - 0.030, by + 0.020, -0.624), V(bx - 0.030, by + 0.020, -0.628), 0.008, 0.008, 8);
  rigid(laserLens, [['handR', 1]]);
  parts.add(laserLens, M.GLASS);
  box(0.026, 0.014, 0.014, 0.004, bx - 0.026, by - 0.020, -0.470, null, M.STEEL);
}

/* ------------------------------------------------------------------ */
/* asset assembly                                                      */
/* ------------------------------------------------------------------ */

/**
 * Build one shareable operator asset.
 * @returns {{geometry:THREE.BufferGeometry, materials:THREE.Material[], kit:Object}}
 */
export function buildOperatorAsset(textures, kit, seed = 1) {
  const rand = new Rand(seed);
  const materials = [
    textures.material('cloth', { camo: kit.camo, roughness: 0.98, name: `ai_cloth_${kit.id}` }),
    textures.material('gear', { color: kit.gear, roughness: 0.92, name: `ai_gear_${kit.id}` }),
    textures.material('polymer', { color: kit.poly, roughness: 0.62, name: `ai_poly_${kit.id}` }),
    textures.material('steel', { color: kit.steel, roughness: 0.46, metalness: 0.95, name: `ai_steel_${kit.id}` }),
    textures.material('leather', { color: kit.leather, roughness: 0.72, name: `ai_leather_${kit.id}` }),
    textures.material('skin', { color: kit.skin, roughness: 0.68, name: `ai_skin_${kit.id}` }),
    textures.glass(0x121c20, 0.62),
  ];

  const parts = new PartSet(materials);
  buildTorso(parts, kit, rand);
  buildPlateCarrier(parts, kit, rand);
  buildArms(parts, kit, rand);
  buildLegs(parts, kit, rand);
  buildHead(parts, kit, rand);
  buildWeapon(parts, kit);

  const geometry = parts.build();
  geometry.name = `operator_${kit.id}`;
  return { geometry, materials, kit };
}

/**
 * One enemy's renderable: a fresh rig plus a SkinnedMesh that shares the
 * asset's geometry and materials.
 */
export class CharacterInstance {
  constructor(asset, opts = {}) {
    this.asset = asset;
    this.rig = new Rig();
    this.root = new THREE.Group();
    this.root.name = 'enemy';
    this.root.add(this.rig.root);

    this.mesh = new THREE.SkinnedMesh(asset.geometry, asset.materials);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = true;
    this.mesh.matrixAutoUpdate = true;
    this.root.add(this.mesh);

    // Bind while the rig sits at the origin so bindMatrix stays identity and
    // the geometry's bind-space authoring is exactly what the skeleton expects.
    this.mesh.bind(this.rig.skeleton, new THREE.Matrix4());

    const s = opts.scale ?? 1;
    if (s !== 1) this.root.scale.setScalar(s);
    this.scale = s;
  }

  get bones() { return this.rig.bones; }

  setVisible(v) { this.root.visible = v; }

  dispose() {
    this.rig.dispose();
    this.root.removeFromParent();
  }
}
