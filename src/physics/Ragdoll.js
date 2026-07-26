import * as THREE from 'three';
import { closestPointTriangle, triNormal } from './Geom.js';
import { surfaceProps } from './Surfaces.js';

/**
 * Articulated Verlet ragdolls.
 *
 * Position-based dynamics rather than a full rigid-body chain: one particle per
 * joint, distance constraints for the bones, cone constraints for the joint
 * limits, and a Gauss-Seidel relaxation pass. This is what most shipped shooters
 * actually use for death animations — it is unconditionally stable, it never
 * explodes when a body ends up inside geometry, and 20 particles x 8 iterations
 * costs a few microseconds.
 *
 * The AI system owns the skeleton; we only need joint positions, a parent index
 * and a radius. Per-bone orientations are derived from the bone direction with a
 * temporally-stable roll reference so limbs do not spin around their own axis.
 */

const MAX_PARTICLES = 32;
const MAX_TRIS_PP = 10;
const SUBSTEP = 1 / 120;
const MAX_SUBSTEP_TRAVEL = 34 * SUBSTEP;

export class RagdollSolver {
  constructor(world, opts = {}) {
    this.world = world;
    this.ragdolls = [];
    this.gravity = new THREE.Vector3(0, opts.gravity ?? -17.0, 0);
    this.maxRagdolls = opts.maxRagdolls ?? 12;
    this.stats = { count: 0, awake: 0 };
  }

  create(bones, opts = {}) {
    if (this.ragdolls.length >= this.maxRagdolls) {
      // retire the oldest settled doll first, else the oldest outright
      let idx = this.ragdolls.findIndex((r) => r.settled);
      if (idx < 0) idx = 0;
      this.ragdolls[idx].dispose();
    }
    const rd = new Ragdoll(this, bones, opts);
    this.ragdolls.push(rd);
    return rd;
  }

  step(dt) {
    let awake = 0;
    for (let i = this.ragdolls.length - 1; i >= 0; i--) {
      const rd = this.ragdolls[i];
      if (rd.disposed) { this.ragdolls.splice(i, 1); continue; }
      if (rd.autoStep && rd.enabled) {
        rd.update(dt);
        if (!rd.settled) awake++;
      }
    }
    this.stats.count = this.ragdolls.length;
    this.stats.awake = awake;
  }

  clear() {
    for (const r of this.ragdolls) r.disposed = true;
    this.ragdolls.length = 0;
  }
}

/* -------------------------------------------------------------------- */

const _v = /* @__PURE__ */ new THREE.Vector3();
const _v2 = /* @__PURE__ */ new THREE.Vector3();
const _v3 = /* @__PURE__ */ new THREE.Vector3();
const _a = /* @__PURE__ */ new THREE.Vector3();
const _b = /* @__PURE__ */ new THREE.Vector3();
const _c = /* @__PURE__ */ new THREE.Vector3();
const _n = /* @__PURE__ */ new THREE.Vector3();
const _p = /* @__PURE__ */ new THREE.Vector3();
const _box = /* @__PURE__ */ new THREE.Box3();
const _side = /* @__PURE__ */ new THREE.Vector3();
const _fwd = /* @__PURE__ */ new THREE.Vector3();
const _m = /* @__PURE__ */ new THREE.Matrix4();

export class Ragdoll {
  constructor(solver, boneDefs, opts = {}) {
    this.solver = solver;
    this.world = solver.world;
    this.enabled = true;
    this.autoStep = opts.autoStep !== false;
    this.disposed = false;
    this.settled = false;
    this.iterations = opts.iterations ?? 6;
    this.damping = opts.damping ?? 0.992;
    this.friction = opts.friction ?? 0.72;
    this.bounce = opts.bounce ?? 0.05;
    this.selfCollide = opts.selfCollide !== false;
    this.gravityScale = opts.gravityScale ?? 1;
    this.axis = (opts.axis || new THREE.Vector3(0, 1, 0)).clone().normalize();
    this._accum = 0;
    this._restTimer = 0;
    this.age = 0;

    const defs = normaliseBones(boneDefs, opts);
    const n = Math.min(defs.length, MAX_PARTICLES);

    this.count = n;
    this.pos = new Float32Array(n * 3);
    this.prev = new Float32Array(n * 3);
    this.invMass = new Float32Array(n);
    this.radius = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.names = new Array(n);

    this.bones = new Array(n);
    for (let i = 0; i < n; i++) {
      const d = defs[i];
      this.pos[i * 3] = d.position.x;
      this.pos[i * 3 + 1] = d.position.y;
      this.pos[i * 3 + 2] = d.position.z;
      this.prev[i * 3] = d.position.x - (d.velocity?.x || 0) * SUBSTEP;
      this.prev[i * 3 + 1] = d.position.y - (d.velocity?.y || 0) * SUBSTEP;
      this.prev[i * 3 + 2] = d.position.z - (d.velocity?.z || 0) * SUBSTEP;
      this.invMass[i] = d.pinned ? 0 : 1 / Math.max(0.05, d.mass ?? 1);
      this.radius[i] = d.radius ?? 0.09;
      this.parent[i] = d.parent;
      this.names[i] = d.name || `bone${i}`;
      this.bones[i] = {
        index: i,
        name: d.name || `bone${i}`,
        parent: d.parent,
        position: new THREE.Vector3().copy(d.position),
        quaternion: new THREE.Quaternion(),
        _basis: new THREE.Quaternion(),
        length: 0,
        radius: this.radius[i],
      };
    }

    // If the caller's bones point down a local axis other than +Y, fold the
    // correction into the published quaternion so `applyTo` just works.
    this._axisFix = null;
    if (Math.abs(this.axis.y - 1) > 1e-4) {
      this._axisFix = new THREE.Quaternion().setFromUnitVectors(this.axis, _yAxis);
    }

    // --- constraints ------------------------------------------------------
    this.links = [];          // {a,b,rest,stiff}
    this.cones = [];          // {p,c,g,cos}  child, parent, grandparent
    for (let i = 0; i < n; i++) {
      const p = this.parent[i];
      if (p < 0 || p >= n) continue;
      const rest = dist(this.pos, i, p);
      if (rest < 1e-5) continue;
      this.links.push({ a: i, b: p, rest, stiff: 1 });
      this.bones[i].length = rest;
      const g = this.parent[p];
      if (g >= 0 && g < n) {
        // skip-link keeps the chain from folding flat on itself
        const r2 = dist(this.pos, i, g);
        if (r2 > 1e-4) this.links.push({ a: i, b: g, rest: r2, stiff: opts.skipStiffness ?? 0.35 });
        // Joint limits are relative to the REST pose, not to the parent bone
        // direction. A shoulder sits ~90 degrees off the spine, so an absolute
        // cone about the parent bone would be violated the moment the doll is
        // created and would pump energy into the solver forever.
        const limit = defs[i].limit ?? (opts.coneLimit ?? THREE.MathUtils.degToRad(55));
        _v.set(this.pos[p * 3] - this.pos[g * 3],
          this.pos[p * 3 + 1] - this.pos[g * 3 + 1],
          this.pos[p * 3 + 2] - this.pos[g * 3 + 2]);
        _v2.set(this.pos[i * 3] - this.pos[p * 3],
          this.pos[i * 3 + 1] - this.pos[p * 3 + 1],
          this.pos[i * 3 + 2] - this.pos[p * 3 + 2]);
        if (_v.lengthSq() > 1e-10 && _v2.lengthSq() > 1e-10) {
          const restAngle = Math.acos(THREE.MathUtils.clamp(
            _v.normalize().dot(_v2.normalize()), -1, 1,
          ));
          this.cones.push({
            c: i, p, g,
            hi: Math.min(Math.PI, restAngle + limit),
            lo: Math.max(0, restAngle - limit),
          });
        }
      }
    }
    // Extra shape links between siblings (shoulders/hips) so the torso keeps volume.
    const childrenOf = new Map();
    for (let i = 0; i < n; i++) {
      const p = this.parent[i];
      if (p < 0) continue;
      if (!childrenOf.has(p)) childrenOf.set(p, []);
      childrenOf.get(p).push(i);
    }
    for (const [, kids] of childrenOf) {
      for (let i = 0; i < kids.length; i++) {
        for (let j = i + 1; j < kids.length; j++) {
          const r = dist(this.pos, kids[i], kids[j]);
          if (r > 1e-4) this.links.push({ a: kids[i], b: kids[j], rest: r, stiff: opts.siblingStiffness ?? 0.5 });
        }
      }
    }
    this.childrenOf = childrenOf;

    // self-collision pairs: everything that is not directly connected
    this.pairs = [];
    if (this.selfCollide) {
      const linked = new Set();
      for (const l of this.links) linked.add(l.a * MAX_PARTICLES + l.b);
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (linked.has(i * MAX_PARTICLES + j) || linked.has(j * MAX_PARTICLES + i)) continue;
          this.pairs.push(i, j);
        }
      }
    }

    this.center = new THREE.Vector3();
    this.side = new Float32Array(n * 3);      // position at the start of the substep
    this.side.set(this.pos);
    this._tbuf = new Float32Array(n * MAX_TRIS_PP * 9);
    this._tnrm = new Float32Array(n * MAX_TRIS_PP * 3);
    this._tmu = new Float32Array(n * MAX_TRIS_PP);
    this._tcount = new Int32Array(n);
    this._collided = new Uint8Array(n);
    this._contactCb = null;
    this._buildContactCallback();
    this._updateBones(true);
  }

  /* -------------------------------------------------------------- */

  _buildContactCallback() {
    // Collision triangles are gathered ONCE per substep per particle and reused
    // across all relaxation iterations. Querying the BVH inside the iteration
    // loop costs 6x more for no accuracy: the particles barely move between
    // iterations.
    this._contactCb = (tri, triIndex, chunk) => {
      const i = this._ci;
      const n = this._tcount[i];
      if (n >= MAX_TRIS_PP) return true;
      const k = i * MAX_TRIS_PP + n;
      const o = k * 9;
      const t = this._tbuf;
      t[o] = tri.a.x; t[o + 1] = tri.a.y; t[o + 2] = tri.a.z;
      t[o + 3] = tri.b.x; t[o + 4] = tri.b.y; t[o + 5] = tri.b.z;
      t[o + 6] = tri.c.x; t[o + 7] = tri.c.y; t[o + 8] = tri.c.z;
      _a.set(t[o], t[o + 1], t[o + 2]);
      _b.set(t[o + 3], t[o + 4], t[o + 5]);
      _c.set(t[o + 6], t[o + 7], t[o + 8]);
      triNormal(_a, _b, _c, _n);
      this._tnrm[k * 3] = _n.x;
      this._tnrm[k * 3 + 1] = _n.y;
      this._tnrm[k * 3 + 2] = _n.z;
      this._tmu[k] = surfaceProps(chunk.triSurf[triIndex]).friction;
      this._tcount[i] = n + 1;
      return false;
    };
  }

  /** One BVH query per particle per substep. */
  _gatherWorld() {
    const world = this.world;
    for (let i = 0; i < this.count; i++) {
      this._tcount[i] = 0;
      if (this.invMass[i] === 0) continue;
      const r = this.radius[i] + 0.02;
      const x = this.pos[i * 3], y = this.pos[i * 3 + 1], z = this.pos[i * 3 + 2];
      const px = this.side[i * 3], py = this.side[i * 3 + 1], pz = this.side[i * 3 + 2];
      _box.min.set(Math.min(x, px) - r, Math.min(y, py) - r, Math.min(z, pz) - r);
      _box.max.set(Math.max(x, px) + r, Math.max(y, py) + r, Math.max(z, pz) + r);
      this._ci = i;
      world.forEachTriangleInBox(_box, this._contactCb);
    }
  }

  /** Advance the simulation. Safe to call with any dt; internally fixed-step. */
  update(dt) {
    if (this.disposed || !this.enabled) return;
    // Settled dolls stop simulating entirely — a corpse lying on the floor costs
    // nothing until something wakes it (applyImpulse / addVelocity / wake()).
    if (this.settled) { this.age += dt; this._accum = 0; return; }
    this.age += dt;
    this._accum += Math.min(dt, 0.1);
    let guard = 0;
    while (this._accum >= SUBSTEP && guard < 8) {
      this._accum -= SUBSTEP;
      guard++;
      this._integrate(SUBSTEP);
      this._gatherWorld();
      for (let it = 0; it < this.iterations; it++) {
        this._solveLinks();
        this._solveCones();
        if (this.selfCollide && (it & 1) === 0) this._solveSelf();
        this._solveWorld();
      }
    }
    if (guard > 0) this._updateBones(false);
  }

  _integrate(dt) {
    const g = this.solver.gravity;
    const gy = g.y * this.gravityScale * dt * dt;
    const gx = g.x * this.gravityScale * dt * dt;
    const gz = g.z * this.gravityScale * dt * dt;
    const d = this.damping;
    let moved = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.invMass[i] === 0) continue;
      const i3 = i * 3;
      const vx = (this.pos[i3] - this.prev[i3]) * d;
      const vy = (this.pos[i3 + 1] - this.prev[i3 + 1]) * d;
      const vz = (this.pos[i3 + 2] - this.prev[i3 + 2]) * d;
      this.prev[i3] = this.pos[i3];
      this.prev[i3 + 1] = this.pos[i3 + 1];
      this.prev[i3 + 2] = this.pos[i3 + 2];
      this.side[i3] = this.pos[i3];
      this.side[i3 + 1] = this.pos[i3 + 1];
      this.side[i3 + 2] = this.pos[i3 + 2];
      // Clamp per-substep travel: a limb moving faster than ~34 m/s cannot be
      // resolved reliably against the world and looks like a glitch anyway.
      let dx = vx + gx, dy = vy + gy, dz = vz + gz;
      const sp = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (sp > MAX_SUBSTEP_TRAVEL) {
        const k = MAX_SUBSTEP_TRAVEL / sp;
        dx *= k; dy *= k; dz *= k;
        this.prev[i3] = this.pos[i3] - dx;
        this.prev[i3 + 1] = this.pos[i3 + 1] - dy;
        this.prev[i3 + 2] = this.pos[i3 + 2] - dz;
      }
      this.pos[i3] += dx;
      this.pos[i3 + 1] += dy;
      this.pos[i3 + 2] += dz;
      moved += Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
    }
    this._restTimer = moved < 0.0016 * this.count ? this._restTimer + dt : 0;
    this.settled = this._restTimer > 0.6;
  }

  _solveLinks() {
    const pos = this.pos, im = this.invMass;
    for (let k = 0; k < this.links.length; k++) {
      const l = this.links[k];
      const a = l.a * 3, b = l.b * 3;
      const dx = pos[b] - pos[a];
      const dy = pos[b + 1] - pos[a + 1];
      const dz = pos[b + 2] - pos[a + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 1e-6) continue;
      const wa = im[l.a], wb = im[l.b];
      const w = wa + wb;
      if (w === 0) continue;
      const diff = ((d - l.rest) / d) * l.stiff;
      const kx = dx * diff, ky = dy * diff, kz = dz * diff;
      const fa = wa / w, fb = wb / w;
      pos[a] += kx * fa; pos[a + 1] += ky * fa; pos[a + 2] += kz * fa;
      pos[b] -= kx * fb; pos[b + 1] -= ky * fb; pos[b + 2] -= kz * fb;
    }
  }

  /**
   * Cone limit: the bone (child - parent) may not deviate from the parent bone
   * direction (parent - grandparent) by more than the joint's half angle. We fix
   * violations by rotating the child onto the cone surface, weighted by mass so
   * a pinned parent stays put.
   */
  _solveCones() {
    const pos = this.pos, im = this.invMass;
    for (let k = 0; k < this.cones.length; k++) {
      const cn = this.cones[k];
      const c3 = cn.c * 3, p3 = cn.p * 3, g3 = cn.g * 3;
      _v.set(pos[p3] - pos[g3], pos[p3 + 1] - pos[g3 + 1], pos[p3 + 2] - pos[g3 + 2]);
      const pl = _v.length();
      if (pl < 1e-6) continue;
      _v.multiplyScalar(1 / pl);
      _v2.set(pos[c3] - pos[p3], pos[c3 + 1] - pos[p3 + 1], pos[c3 + 2] - pos[p3 + 2]);
      const cl = _v2.length();
      if (cl < 1e-6) continue;
      _v3.copy(_v2).multiplyScalar(1 / cl);
      const angle = Math.acos(THREE.MathUtils.clamp(_v.dot(_v3), -1, 1));
      let target;
      if (angle > cn.hi) target = cn.hi;
      else if (angle < cn.lo) target = cn.lo;
      else continue;

      // rotate the parent direction by `target` towards the child: that is the
      // nearest point on the allowed cone band.
      _n.crossVectors(_v, _v3);
      const nl = _n.length();
      if (nl < 1e-6) continue;
      _n.multiplyScalar(1 / nl);
      _v3.copy(_v).applyAxisAngle(_n, target).multiplyScalar(cl);
      // target position for the child, then split the correction by mass
      const dxT = pos[p3] + _v3.x - pos[c3];
      const dyT = pos[p3 + 1] + _v3.y - pos[c3 + 1];
      const dzT = pos[p3 + 2] + _v3.z - pos[c3 + 2];
      const wc = im[cn.c], wp = im[cn.p];
      const w = wc + wp;
      if (w === 0) continue;
      const s = 0.35;                      // relaxation factor: hard cone snaps ring
      const fc = (wc / w) * s;
      const fp = (wp / w) * s * 0.25;      // the parent yields a little, not fully
      pos[c3] += dxT * fc;
      pos[c3 + 1] += dyT * fc;
      pos[c3 + 2] += dzT * fc;
      pos[p3] -= dxT * fp;
      pos[p3 + 1] -= dyT * fp;
      pos[p3 + 2] -= dzT * fp;
    }
  }

  _solveSelf() {
    const pos = this.pos, im = this.invMass, rad = this.radius;
    for (let k = 0; k < this.pairs.length; k += 2) {
      const i = this.pairs[k], j = this.pairs[k + 1];
      const i3 = i * 3, j3 = j * 3;
      const dx = pos[j3] - pos[i3];
      const dy = pos[j3 + 1] - pos[i3 + 1];
      const dz = pos[j3 + 2] - pos[i3 + 2];
      const minD = (rad[i] + rad[j]) * 0.85;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= minD * minD || d2 < 1e-10) continue;
      const d = Math.sqrt(d2);
      const w = im[i] + im[j];
      if (w === 0) continue;
      const diff = ((d - minD) / d) * 0.5;
      const kx = dx * diff, ky = dy * diff, kz = dz * diff;
      const fi = im[i] / w, fj = im[j] / w;
      pos[i3] += kx * fi; pos[i3 + 1] += ky * fi; pos[i3 + 2] += kz * fi;
      pos[j3] -= kx * fj; pos[j3 + 1] -= ky * fj; pos[j3 + 2] -= kz * fj;
    }
  }

  /**
   * Sphere-vs-triangle depenetration for every particle against the cached
   * triangles, with the push direction taken from the side of the plane the
   * particle was on at the start of the substep. Using the current position
   * instead lets a fast-moving limb that punched through a floor get "resolved"
   * downwards, and the corpse sinks out of the level.
   */
  _solveWorld() {
    if (!this.world || !this.world.built) return;
    for (let i = 0; i < this.count; i++) {
      const tc = this._tcount[i];
      if (tc === 0) continue;
      const i3 = i * 3;
      const r = this.radius[i];
      for (let j = 0; j < tc; j++) {
        const k = i * MAX_TRIS_PP + j;
        const o = k * 9;
        const t = this._tbuf;
        _a.set(t[o], t[o + 1], t[o + 2]);
        _b.set(t[o + 3], t[o + 4], t[o + 5]);
        _c.set(t[o + 6], t[o + 7], t[o + 8]);
        _n.set(this._tnrm[k * 3], this._tnrm[k * 3 + 1], this._tnrm[k * 3 + 2]);
        const side = _n.dot(_v3.set(
          this.side[i3] - _a.x, this.side[i3 + 1] - _a.y, this.side[i3 + 2] - _a.z,
        )) >= 0 ? 1 : -1;

        _v.set(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2]);
        closestPointTriangle(_v, _a, _b, _c, _p);
        _v2.subVectors(_v, _p);
        const d = _v2.length();
        const crossed = _v2.dot(_n) * side < 0;
        if (d >= r && !crossed) continue;
        let push;
        if (crossed || d <= 1e-6) {
          _v2.copy(_n).multiplyScalar(side);
          push = r - _v2.dot(_v3.subVectors(_v, _p));
        } else {
          _v2.multiplyScalar(1 / d);
          push = r - d;
        }
        if (push <= 0) continue;
        this.pos[i3] += _v2.x * push;
        this.pos[i3 + 1] += _v2.y * push;
        this.pos[i3 + 2] += _v2.z * push;
        // The correction itself must not become velocity: in Verlet, moving `pos`
        // without moving `prev` turns penetration depth into launch speed, which
        // is why naive PBD ragdolls detonate when they land badly.
        this.prev[i3] += _v2.x * push;
        this.prev[i3 + 1] += _v2.y * push;
        this.prev[i3 + 2] += _v2.z * push;

        // Friction: drag the previous position towards the current one along the
        // contact tangent so sliding bleeds off — this is what stops corpses from
        // skating across the floor.
        const vx = this.pos[i3] - this.prev[i3];
        const vy = this.pos[i3 + 1] - this.prev[i3 + 1];
        const vz = this.pos[i3 + 2] - this.prev[i3 + 2];
        const vn = vx * _v2.x + vy * _v2.y + vz * _v2.z;
        const tx = vx - _v2.x * vn, ty = vy - _v2.y * vn, tz = vz - _v2.z * vn;
        const mu = Math.min(1, this.friction * (this._tmu[k] || 1));
        this.prev[i3] += tx * mu;
        this.prev[i3 + 1] += ty * mu;
        this.prev[i3 + 2] += tz * mu;
        if (vn < 0) {
          this.prev[i3] += _v2.x * vn * (1 + this.bounce);
          this.prev[i3 + 1] += _v2.y * vn * (1 + this.bounce);
          this.prev[i3 + 2] += _v2.z * vn * (1 + this.bounce);
        }
        this._collided[i] = 1;
      }
    }
  }

  /* -------------------------------------------------------------- */

  _updateBones(initial) {
    const n = this.count;
    this.center.set(0, 0, 0);
    for (let i = 0; i < n; i++) {
      const bone = this.bones[i];
      bone.position.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
      this.center.add(bone.position);
    }
    if (n > 0) this.center.multiplyScalar(1 / n);

    for (let i = 0; i < n; i++) {
      const bone = this.bones[i];
      const kids = this.childrenOf.get(i);
      // Direction: towards the first child, else away from the parent.
      if (kids && kids.length) {
        _fwd.copy(this.bones[kids[0]].position).sub(bone.position);
      } else if (this.parent[i] >= 0) {
        _fwd.copy(bone.position).sub(this.bones[this.parent[i]].position);
      } else {
        _fwd.set(0, 1, 0);
      }
      const l = _fwd.length();
      if (l < 1e-5) { _fwd.set(0, 1, 0); } else { _fwd.multiplyScalar(1 / l); }

      // Roll reference: reuse the previous frame's side vector so the limb does
      // not spin about its own axis between frames.
      if (initial) _side.set(1, 0, 0);
      else _side.set(1, 0, 0).applyQuaternion(bone._basis);
      _v.copy(_side).addScaledVector(_fwd, -_side.dot(_fwd));
      if (_v.lengthSq() < 1e-8) {
        _v.set(0, 0, 1).addScaledVector(_fwd, -_fwd.z);
        if (_v.lengthSq() < 1e-8) _v.set(1, 0, 0);
      }
      _v.normalize();
      _v2.crossVectors(_v, _fwd);          // right-handed: x cross y = z
      _m.makeBasis(_v, _fwd, _v2);
      bone._basis.setFromRotationMatrix(_m);
      bone.quaternion.copy(bone._basis);
      if (this._axisFix) bone.quaternion.multiply(this._axisFix);
    }
  }

  /* -------------------------------------------------------------- */
  /* public                                                          */
  /* -------------------------------------------------------------- */

  /** Kick the doll: used for bullet hits and explosions. */
  applyImpulse(point, impulse, radius = 0.6) {
    const r2 = radius * radius;
    for (let i = 0; i < this.count; i++) {
      if (this.invMass[i] === 0) continue;
      const dx = this.pos[i * 3] - point.x;
      const dy = this.pos[i * 3 + 1] - point.y;
      const dz = this.pos[i * 3 + 2] - point.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const f = (1 - Math.sqrt(d2) / radius) * this.invMass[i] * SUBSTEP;
      this.prev[i * 3] -= impulse.x * f;
      this.prev[i * 3 + 1] -= impulse.y * f;
      this.prev[i * 3 + 2] -= impulse.z * f;
    }
    this.wake();
  }

  /** Uniform velocity kick (e.g. the corpse inherits the runner's momentum). */
  addVelocity(v) {
    for (let i = 0; i < this.count; i++) {
      this.prev[i * 3] -= v.x * SUBSTEP;
      this.prev[i * 3 + 1] -= v.y * SUBSTEP;
      this.prev[i * 3 + 2] -= v.z * SUBSTEP;
    }
    this.wake();
  }

  /** Force the doll back into simulation after it has settled. */
  wake() {
    this._restTimer = 0;
    this.settled = false;
  }

  /** Copies bone transforms into a matrix (world space). */
  getBoneMatrix(index, target) {
    const b = this.bones[index];
    if (!b) return target.identity();
    return target.compose(b.position, b.quaternion, _one);
  }

  /** Writes bone transforms onto an array/map of Object3Ds keyed by index or name. */
  applyTo(objects) {
    if (!objects) return;
    for (let i = 0; i < this.count; i++) {
      const o = Array.isArray(objects) ? objects[i] : objects[this.names[i]];
      if (!o) continue;
      o.position.copy(this.bones[i].position);
      o.quaternion.copy(this.bones[i].quaternion);
    }
  }

  boneByName(name) {
    const i = this.names.indexOf(name);
    return i >= 0 ? this.bones[i] : null;
  }

  dispose() {
    this.disposed = true;
    this.enabled = false;
  }
}

const _one = /* @__PURE__ */ new THREE.Vector3(1, 1, 1);
const _yAxis = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);

function dist(arr, i, j) {
  const dx = arr[i * 3] - arr[j * 3];
  const dy = arr[i * 3 + 1] - arr[j * 3 + 1];
  const dz = arr[i * 3 + 2] - arr[j * 3 + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Accepts a generous range of inputs so the AI system can hand us whatever it
 * has: plain objects, THREE.Bone/Object3D instances, Vector3s, arrays.
 */
function normaliseBones(input, opts) {
  const out = [];
  if (!input || !input.length) return out;
  const nameToIndex = new Map();

  for (let i = 0; i < input.length; i++) {
    const src = input[i];
    let name = src?.name;
    let position = null;
    let parent = -1;

    if (src?.isVector3) {
      position = src;
    } else if (Array.isArray(src)) {
      position = new THREE.Vector3(src[0] || 0, src[1] || 0, src[2] || 0);
    } else if (src?.isObject3D) {
      position = src.getWorldPosition(new THREE.Vector3());
    } else if (src) {
      const p = src.position || src.pos || src.point;
      if (p?.isVector3) position = p.clone();
      else if (Array.isArray(p)) position = new THREE.Vector3(p[0] || 0, p[1] || 0, p[2] || 0);
      else if (p) position = new THREE.Vector3(p.x || 0, p.y || 0, p.z || 0);
    }
    if (!position) position = new THREE.Vector3();
    if (name) nameToIndex.set(name, i);
    out.push({
      name: name || `bone${i}`,
      position,
      parent,
      radius: src?.radius,
      mass: src?.mass,
      limit: src?.limit !== undefined ? src.limit : undefined,
      pinned: !!src?.pinned,
      velocity: src?.velocity,
      _src: src,
    });
  }

  // resolve parents once every name is known
  for (let i = 0; i < out.length; i++) {
    const src = out[i]._src;
    let parent = -1;
    if (src && typeof src.parent === 'number') parent = src.parent;
    else if (src && typeof src.parent === 'string') parent = nameToIndex.has(src.parent) ? nameToIndex.get(src.parent) : -1;
    else if (src?.isObject3D && src.parent) {
      const pi = input.indexOf(src.parent);
      parent = pi >= 0 ? pi : -1;
    } else if (src && typeof src.parentName === 'string') {
      parent = nameToIndex.has(src.parentName) ? nameToIndex.get(src.parentName) : -1;
    } else if (opts?.chain) {
      parent = i - 1;
    }
    if (parent === i) parent = -1;
    out[i].parent = parent;
    delete out[i]._src;
  }
  return out;
}
