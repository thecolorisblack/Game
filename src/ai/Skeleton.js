import * as THREE from 'three';

/**
 * The operator rig.
 *
 * 22 deformation bones (pelvis, three spine joints, neck, head, both clavicles,
 * arms, legs and toes) plus six gear bones that exist only so pouches, the dump
 * bag and the radio antenna can lag the body under spring dynamics.
 *
 * Two deliberate choices make everything downstream simpler:
 *
 *  1. The bind pose is the *combat carry* pose, not a T-pose. A rifleman spends
 *     99% of the time within a few degrees of it, so linear blend skinning never
 *     has to extrapolate far and shoulders/elbows keep their volume.
 *  2. Every bone's bind rotation is identity, so a bone's local axes are the
 *     character's axes: +X right, +Y up, −Z forward. "Swing the thigh forward"
 *     is a positive rotation about X on every limb, which is what lets the clip
 *     format below be plain euler triplets and additive layers compose by
 *     multiplication without per-bone axis bookkeeping.
 *
 * Joint positions are world-space metres in the bind pose, feet on y=0, and are
 * the single source of truth: the mesh builder sweeps geometry along exactly
 * these segments.
 */

/** name, parent, bind world position, capsule-ish radius used for skin weights. */
export const JOINTS = [
  ['pelvis',    null,       [0.000, 0.960,  0.010], 0.135],
  ['spine1',    'pelvis',   [0.000, 1.075,  0.004], 0.130],
  ['spine2',    'spine1',   [0.000, 1.190, -0.006], 0.140],
  ['spine3',    'spine2',   [0.000, 1.310, -0.020], 0.150],
  ['neck',      'spine3',   [0.000, 1.440, -0.026], 0.062],
  ['head',      'neck',     [0.000, 1.530, -0.016], 0.105],

  // The arms are posed on the weapon: right hand on the pistol grip, left hand
  // under the handguard, elbows where a shooter's actually are. Every weapon
  // coordinate in Character.js is derived from these two wrist positions.
  ['clavicleR', 'spine3',   [0.048, 1.418, -0.014], 0.062],
  ['upperArmR', 'clavicleR', [0.176, 1.405, -0.012], 0.058],
  ['lowerArmR', 'upperArmR', [0.325, 1.175, -0.115], 0.050],
  ['handR',     'lowerArmR', [0.148, 1.214, -0.308], 0.046],

  ['clavicleL', 'spine3',   [-0.048, 1.418, -0.014], 0.062],
  ['upperArmL', 'clavicleL', [-0.176, 1.405, -0.012], 0.058],
  ['lowerArmL', 'upperArmL', [-0.069, 1.268, -0.244], 0.050],
  ['handL',     'lowerArmL', [ 0.115, 1.258, -0.455], 0.046],

  ['thighR',    'pelvis',   [ 0.098, 0.930,  0.006], 0.085],
  ['shinR',     'thighR',   [ 0.106, 0.498,  0.014], 0.068],
  ['footR',     'shinR',    [ 0.108, 0.092,  0.062], 0.055],
  ['toeR',      'footR',    [ 0.108, 0.030, -0.098], 0.045],

  ['thighL',    'pelvis',   [-0.098, 0.930,  0.006], 0.085],
  ['shinL',     'thighL',   [-0.106, 0.498, -0.052], 0.068],
  ['footL',     'shinL',    [-0.108, 0.092,  0.004], 0.055],
  ['toeL',      'footL',    [-0.108, 0.030, -0.156], 0.045],

  // --- gear bones: spring-driven, no clip ever touches them -----------
  ['gearFrontL', 'spine3',  [-0.098, 1.145, -0.150], 0.075],
  ['gearFrontR', 'spine3',  [ 0.115, 1.150, -0.140], 0.070],
  ['gearBack',   'spine3',  [ 0.000, 1.235,  0.135], 0.090],
  ['gearAnt',    'spine3',  [ 0.092, 1.760,  0.185], 0.030],
  ['gearHipR',   'pelvis',  [ 0.185, 0.905,  0.055], 0.075],
  ['gearHipL',   'pelvis',  [-0.185, 0.905,  0.045], 0.070],
];

export const BONE_INDEX = (() => {
  const m = Object.create(null);
  JOINTS.forEach((j, i) => { m[j[0]] = i; });
  return m;
})();

export const BONE_COUNT = JOINTS.length;
export const GEAR_BONES = ['gearFrontL', 'gearFrontR', 'gearBack', 'gearAnt', 'gearHipR', 'gearHipL'];

/** Bind-pose world positions as Vector3s, shared and never mutated. */
export const BIND_POSITION = JOINTS.map((j) => new THREE.Vector3(j[2][0], j[2][1], j[2][2]));

/** Parent index per bone (−1 for the root). */
export const PARENT = JOINTS.map((j) => (j[1] === null ? -1 : BONE_INDEX[j[1]]));

/** Local bind offset of each bone from its parent. */
export const BIND_LOCAL = JOINTS.map((j, i) => {
  const p = PARENT[i];
  const v = BIND_POSITION[i].clone();
  if (p >= 0) v.sub(BIND_POSITION[p]);
  return v;
});

/** Children lists, useful for the ragdoll direction mapping. */
export const CHILDREN = JOINTS.map(() => []);
PARENT.forEach((p, i) => { if (p >= 0) CHILDREN[p].push(i); });

export const EYE_HEIGHT = 1.62;
export const STAND_HEIGHT = 1.82;

/* ------------------------------------------------------------------ */

/**
 * One instance of the rig: a fresh Bone hierarchy plus a Skeleton that shares
 * the pre-computed inverse bind matrices with every other instance.
 */
let SHARED_INVERSES = null;

export class Rig {
  constructor() {
    this.bones = new Array(BONE_COUNT);
    for (let i = 0; i < BONE_COUNT; i++) {
      const b = new THREE.Bone();
      b.name = JOINTS[i][0];
      b.position.copy(BIND_LOCAL[i]);
      b.matrixAutoUpdate = true;
      this.bones[i] = b;
    }
    for (let i = 0; i < BONE_COUNT; i++) {
      const p = PARENT[i];
      if (p >= 0) this.bones[p].add(this.bones[i]);
    }
    this.root = this.bones[0];
    this.root.updateMatrixWorld(true);

    if (!SHARED_INVERSES) {
      SHARED_INVERSES = this.bones.map((b) => new THREE.Matrix4().copy(b.matrixWorld).invert());
    }
    this.skeleton = new THREE.Skeleton(this.bones, SHARED_INVERSES.map((m) => m.clone()));
    this.byName = Object.create(null);
    for (let i = 0; i < BONE_COUNT; i++) this.byName[JOINTS[i][0]] = this.bones[i];
  }

  bone(name) { return this.byName[name] || null; }
  index(name) { return BONE_INDEX[name]; }

  /** Reset every bone to the bind pose. */
  resetToBind() {
    for (let i = 0; i < BONE_COUNT; i++) {
      const b = this.bones[i];
      b.position.copy(BIND_LOCAL[i]);
      b.quaternion.identity();
      b.scale.set(1, 1, 1);
    }
  }

  dispose() {
    this.skeleton.dispose?.();
  }
}

/**
 * The bone subsets each mesh part may be weighted to. Restricting the candidate
 * set per part is what stops the chest from bleeding into the upper arms in a
 * tight bind pose, which is the classic procedural-skinning failure.
 */
export const WEIGHT_SETS = {
  head: ['head', 'neck', 'spine3'],
  neck: ['neck', 'head', 'spine3'],
  torso: ['pelvis', 'spine1', 'spine2', 'spine3', 'neck', 'clavicleL', 'clavicleR'],
  chestRigid: ['spine3', 'spine2'],
  armR: ['clavicleR', 'upperArmR', 'lowerArmR', 'handR', 'spine3'],
  armL: ['clavicleL', 'upperArmL', 'lowerArmL', 'handL', 'spine3'],
  handR: ['handR', 'lowerArmR'],
  handL: ['handL', 'lowerArmL'],
  legR: ['pelvis', 'thighR', 'shinR', 'footR', 'toeR'],
  legL: ['pelvis', 'thighL', 'shinL', 'footL', 'toeL'],
  footR: ['footR', 'toeR', 'shinR'],
  footL: ['footL', 'toeL', 'shinL'],
  hips: ['pelvis', 'spine1', 'thighL', 'thighR'],
};
