import * as THREE from 'three';
import { makeHitRecord } from './StaticWorld.js';
import { closestPointTriangle, triNormal, pointInTriangle, sweptSphereTriangle } from './Geom.js';
import { surfaceProps, surfaceName } from './Surfaces.js';

/**
 * Dynamic rigid bodies for debris, gibs and shell casings.
 *
 * This is deliberately a *small* solver: single-body-vs-world only, no body-body
 * contacts. That is what shipped shooters actually do for clutter — casings and
 * chunks never interact with each other, they interact with the level, and you
 * can then afford several hundred of them.
 *
 * Boxes are resolved through their 8 corners against the triangle soup, which is
 * what gives casings their characteristic tumble-and-clatter instead of the
 * sphere-slide you get from a bounding-sphere approximation. Inertia is treated
 * as isotropic (I = k m r^2) because for objects this small nobody can tell, and
 * it turns the impulse denominator into two dot products.
 */

const MAX_TRIS = 160;
const MAX_SPEED = 40;              // m/s; above this CCD cannot stay honest
const MAX_CONTACTS = 24;
const CORNERS = [
  [-1, -1, -1], [1, -1, -1], [-1, 1, -1], [1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1],
];

let _nextId = 1;

export class RigidBodySolver {
  constructor(world, opts = {}) {
    this.world = world;
    this.bodies = [];
    this.pool = [];
    this.maxBodies = opts.maxBodies ?? 512;
    this.gravity = new THREE.Vector3(0, opts.gravity ?? -18.5, 0);
    this.onImpact = null;               // global hook (audio/VFX)
    this.sleepLinear = 0.16;
    this.sleepAngular = 2.6;
    this.sleepDelay = 0.3;
    this.stats = { active: 0, sleeping: 0, contacts: 0 };

    // scratch
    this._box = new THREE.Box3();
    this._tri = new Float32Array(MAX_TRIS * 9);
    this._triSurf = new Uint8Array(MAX_TRIS);
    this._triObj = new Int32Array(MAX_TRIS);
    this._triN = new Float32Array(MAX_TRIS * 3);
    this._triCount = 0;

    this._cn = new Float32Array(MAX_CONTACTS * 3);
    this._cr = new Float32Array(MAX_CONTACTS * 3);
    this._cd = new Float32Array(MAX_CONTACTS);
    this._cs = new Uint8Array(MAX_CONTACTS);
    this._ck = new Int32Array(MAX_CONTACTS);
    this._contactCount = 0;

    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._c = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._q = new THREE.Vector3();
    this._corner = new THREE.Vector3();
    this._t1 = new THREE.Vector3();
    this._t2 = new THREE.Vector3();
    this._dq = new THREE.Quaternion();
    this._mat = new THREE.Matrix4();
    this._scaleOne = new THREE.Vector3(1, 1, 1);
    this._hit = makeHitRecord();
    this._prev = new THREE.Vector3();
    this._sweepHit = false;
    this._instanceDirty = new Set();
    this._viewPos = new THREE.Vector3();
    this._hasView = false;

    this._triOverflow = false;
    this._gatherCb = (tri, triIndex, chunk) => {
      if (this._triCount >= MAX_TRIS) { this._triOverflow = true; return true; }
      const i = this._triCount++;
      const o = i * 9;
      const t = this._tri;
      t[o] = tri.a.x; t[o + 1] = tri.a.y; t[o + 2] = tri.a.z;
      t[o + 3] = tri.b.x; t[o + 4] = tri.b.y; t[o + 5] = tri.b.z;
      t[o + 6] = tri.c.x; t[o + 7] = tri.c.y; t[o + 8] = tri.c.z;
      triNormal(tri.a, tri.b, tri.c, this._n);
      this._triN[i * 3] = this._n.x;
      this._triN[i * 3 + 1] = this._n.y;
      this._triN[i * 3 + 2] = this._n.z;
      this._triSurf[i] = chunk.triSurf[triIndex];
      this._triObj[i] = chunk.triObj[triIndex];
      return false;
    };
  }

  /* ------------------------------------------------------------------ */

  _acquire() {
    const b = this.pool.pop();
    if (b) return b;
    return {
      id: 0, alive: false, sleeping: false, shape: 'sphere',
      pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      quat: new THREE.Quaternion(), angVel: new THREE.Vector3(),
      half: new THREE.Vector3(0.02, 0.02, 0.02),
      radius: 0.03, mass: 0.02, invMass: 50, invInertia: 0,
      restitution: 0.35, friction: 0.6, drag: 0.02, angularDrag: 0.4,
      gravityScale: 1, lifetime: 0, age: 0, sleepTimer: 0,
      object: null, instanced: null, surface: 'metal', group: '',
      onImpact: null, onSleep: null, onExpire: null,
      ccd: true, impactCooldown: 0, _dtAccum: 0, _phase: 0, _stride: 1,
      restSurface: null, userData: null,
    };
  }

  /**
   * @param {Object} o see Physics.spawnDebris for the documented option set
   * @returns {Object} body handle
   */
  spawn(o = {}) {
    if (this.bodies.length >= this.maxBodies) this._evict();
    const b = this._acquire();
    b.id = _nextId++;
    b.alive = true;
    b.sleeping = false;
    b.shape = o.shape || (o.size ? 'box' : 'sphere');
    b.pos.copy(o.position || o.pos || _zero);
    b.vel.copy(o.velocity || o.vel || _zero);
    if (o.quaternion) b.quat.copy(o.quaternion);
    else b.quat.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
    b.angVel.copy(o.angularVelocity || o.spin || _zero);

    if (b.shape === 'box') {
      const s = o.size;
      if (s === undefined) b.half.set(0.02, 0.02, 0.05);
      else if (typeof s === 'number') b.half.set(s * 0.5, s * 0.5, s * 0.5);
      else b.half.set((s.x ?? 0.04) * 0.5, (s.y ?? 0.04) * 0.5, (s.z ?? 0.04) * 0.5);
      b.radius = b.half.length();
    } else {
      b.radius = o.radius ?? 0.05;
      b.half.set(b.radius, b.radius, b.radius);
    }

    b.mass = Math.max(1e-4, o.mass ?? (b.shape === 'box' ? 0.012 : 0.05));
    b.invMass = 1 / b.mass;
    // isotropic inertia: 0.4 m r^2 for a sphere, 0.28 m r^2 for a box-ish shell
    const k = b.shape === 'box' ? 0.28 : 0.4;
    b.invInertia = 1 / Math.max(1e-7, k * b.mass * b.radius * b.radius);

    b.restitution = o.restitution ?? (b.shape === 'box' ? 0.34 : 0.28);
    b.friction = o.friction ?? 0.55;
    b.drag = o.drag ?? 0.06;
    b.angularDrag = o.angularDrag ?? 0.5;
    b.gravityScale = o.gravityScale ?? 1;
    b.lifetime = o.lifetime ?? 0;
    b.age = 0;
    b.sleepTimer = 0;
    b.object = o.object || o.mesh || null;
    b.instanced = o.instanced || null;
    b.surface = o.surface || 'metal';
    b.group = o.group || '';
    b.onImpact = o.onImpact || null;
    b.onSleep = o.onSleep || null;
    b.onExpire = o.onExpire || null;
    b.ccd = o.ccd !== false;
    b.impactCooldown = 0;
    b._dtAccum = 0;
    b._stride = 1;
    b._phase = (this.bodies.length & 3);
    b.restSurface = null;
    b.userData = o.userData || null;

    if (b.object) {
      b.object.position.copy(b.pos);
      b.object.quaternion.copy(b.quat);
      b.object.visible = true;
    }
    this.bodies.push(b);
    return b;
  }

  remove(body) {
    if (!body || !body.alive) return;
    body.alive = false;
  }

  clear() {
    for (const b of this.bodies) {
      b.alive = false;
      if (b.object) b.object.visible = false;
      this.pool.push(b);
    }
    this.bodies.length = 0;
  }

  /** Drops the oldest sleeping body, or the oldest body if all are awake. */
  _evict() {
    let best = -1, bestAge = -1;
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      const score = b.age + (b.sleeping ? 1000 : 0);
      if (score > bestAge) { bestAge = score; best = i; }
    }
    if (best >= 0) this._retire(this.bodies[best]);
  }

  _retire(b) {
    b.alive = false;
    try { b.onExpire?.(b); } catch (e) { /* never let a callback kill the step */ }
    if (b.object) b.object.visible = false;
  }

  /** Wakes and pushes every body inside the blast sphere. */
  applyRadialImpulse(center, radius, power, upBias = 0.35) {
    const r2 = radius * radius;
    for (const b of this.bodies) {
      if (!b.alive) continue;
      const dx = b.pos.x - center.x, dy = b.pos.y - center.y, dz = b.pos.z - center.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2) || 1e-4;
      const falloff = 1 - d / radius;
      // `power` reads as a peak velocity in m/s, scaled a little by how light the
      // debris is. Treating it as a true impulse makes 11 g casings leave the map.
      const massScale = Math.min(2, Math.max(0.35, Math.sqrt(0.02 * b.invMass)));
      const j = Math.min(MAX_SPEED, power * falloff * falloff * massScale);
      b.vel.x += (dx / d) * j;
      b.vel.y += (dy / d) * j + j * upBias;
      b.vel.z += (dz / d) * j;
      b.angVel.x += (Math.random() - 0.5) * falloff * 40;
      b.angVel.y += (Math.random() - 0.5) * falloff * 40;
      b.angVel.z += (Math.random() - 0.5) * falloff * 40;
      b.sleeping = false;
      b.sleepTimer = 0;
    }
  }

  setViewPosition(v) {
    if (v) { this._viewPos.copy(v); this._hasView = true; }
  }

  /* ------------------------------------------------------------------ */

  step(dt) {
    const bodies = this.bodies;
    let write = 0;
    let active = 0, sleeping = 0;
    this.stats.contacts = 0;
    this._instanceDirty.clear();

    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (!b.alive) { this.pool.push(b); continue; }
      bodies[write++] = b;

      b.age += dt;
      if (b.lifetime > 0 && b.age >= b.lifetime) {
        this._retire(b);
        write--;
        this.pool.push(b);
        continue;
      }

      if (b.sleeping) { sleeping++; continue; }

      // Distance LOD: far clutter runs at a quarter rate with a proportionally
      // larger dt, which is exact for the integrator and 4x cheaper.
      if (this._hasView) {
        const d2 = b.pos.distanceToSquared(this._viewPos);
        b._stride = d2 > 2500 ? 4 : (d2 > 625 ? 2 : 1);
      } else {
        b._stride = 1;
      }
      b._dtAccum += dt;
      if (b._stride > 1) {
        b._phase++;
        if ((b._phase % b._stride) !== 0) continue;
      }
      const h = b._dtAccum;
      b._dtAccum = 0;

      active++;
      this._stepBody(b, Math.min(h, 1 / 30));
    }
    bodies.length = write;

    for (const mesh of this._instanceDirty) {
      if (mesh.instanceMatrix) mesh.instanceMatrix.needsUpdate = true;
    }

    this.stats.active = active;
    this.stats.sleeping = sleeping;
  }

  _stepBody(b, dt) {
    b.impactCooldown = Math.max(0, b.impactCooldown - dt);

    // integrate velocity
    b.vel.x += this.gravity.x * b.gravityScale * dt;
    b.vel.y += this.gravity.y * b.gravityScale * dt;
    b.vel.z += this.gravity.z * b.gravityScale * dt;
    const lin = Math.max(0, 1 - b.drag * dt);
    b.vel.multiplyScalar(lin);
    const ang = Math.max(0, 1 - b.angularDrag * dt);
    b.angVel.multiplyScalar(ang);
    const sp2 = b.vel.lengthSq();
    if (sp2 > MAX_SPEED * MAX_SPEED) b.vel.multiplyScalar(MAX_SPEED / Math.sqrt(sp2));

    // Continuous stepping: never advance more than half a body radius per
    // substep, so a corner is always still within reach of the face it crossed.
    const speed = b.vel.length();
    let steps = 1;
    if (b.ccd && speed * dt > b.radius * 0.5) {
      steps = Math.min(8, Math.ceil((speed * dt) / (b.radius * 0.9)));
    }
    const sdt = dt / steps;

    // ONE BVH query per body per step, covering the whole predicted sweep. The
    // substeps below reuse the cached triangles: querying per substep is the
    // difference between 300 bodies costing 0.6 ms and costing 2.5 ms.
    this._gatherFor(b, dt);

    for (let s = 0; s < steps; s++) {
      this._prev.copy(b.pos);
      this._sweepHit = false;
      const move = b.vel.length() * sdt;
      if (b.ccd && move > b.radius * 0.45) {
        // Even after substepping this is a long hop (grenade shrapnel): clamp the
        // move at the swept time of impact so nothing can pass through a wall.
        // The sweep runs against the triangles cached above, not the BVH — a
        // traversal per substep per body is what makes naive CCD unaffordable.
        this._t1.copy(b.vel).multiplyScalar(1 / Math.max(1e-6, b.vel.length()));
        let toi;
        if (this._triOverflow) {
          // Cached set was capped: fall back to a real BVH sweep so a fast body
          // in dense geometry still cannot pass through anything.
          toi = this.world.sphereSweep(b.pos, this._t1, b.radius * 0.8, move, null, this._hit)
            ? this._hit.distance : -1;
        } else {
          toi = this._sweepCached(b.pos, this._t1, b.radius * 0.8, move);
        }
        if (toi >= 0) {
          b.pos.addScaledVector(this._t1, Math.max(0, toi - 0.002));
          this._sweepHit = true;
        } else {
          b.pos.addScaledVector(b.vel, sdt);
        }
      } else {
        b.pos.addScaledVector(b.vel, sdt);
      }
      this._collide(b, sdt);
    }

    // Small dense objects get a huge angular response from tiny impulses; cap it
    // so casings spin fast but never strobe or destabilise the integrator.
    const w2 = b.angVel.lengthSq();
    if (w2 > 1600) b.angVel.multiplyScalar(40 / Math.sqrt(w2));

    // integrate orientation
    const w = b.angVel;
    if (w.lengthSq() > 1e-10) {
      this._dq.set(w.x * dt * 0.5, w.y * dt * 0.5, w.z * dt * 0.5, 0);
      this._dq.multiply(b.quat);
      b.quat.x += this._dq.x; b.quat.y += this._dq.y;
      b.quat.z += this._dq.z; b.quat.w += this._dq.w;
      b.quat.normalize();
    }

    // sleep
    if (b._contacted && b.vel.lengthSq() < this.sleepLinear * this.sleepLinear
        && b.angVel.lengthSq() < this.sleepAngular * this.sleepAngular) {
      b.sleepTimer += dt;
      if (b.sleepTimer > this.sleepDelay) {
        b.sleeping = true;
        b.vel.set(0, 0, 0);
        b.angVel.set(0, 0, 0);
        try { b.onSleep?.(b); } catch (e) { /* ignore */ }
      }
    } else {
      b.sleepTimer = 0;
    }

    this._sync(b);
  }

  _sync(b) {
    if (b.object) {
      b.object.position.copy(b.pos);
      b.object.quaternion.copy(b.quat);
    }
    if (b.instanced && b.instanced.mesh) {
      this._mat.compose(b.pos, b.quat, b.instanced.scale || this._scaleOne);
      b.instanced.mesh.setMatrixAt(b.instanced.index, this._mat);
      this._instanceDirty.add(b.instanced.mesh);
    }
  }

  /* ------------------------------------------------------------------ */

  /**
   * Swept sphere against the cached triangle set. Returns the time of impact in
   * metres, or -1. Fills `_hit.normal/point/surfaceId` on a hit.
   */
  _sweepCached(origin, dir, radius, maxDist) {
    let best = -1;
    let limit = maxDist;
    for (let i = 0; i < this._triCount; i++) {
      const o = i * 9, t = this._tri;
      this._a.set(t[o], t[o + 1], t[o + 2]);
      this._b.set(t[o + 3], t[o + 4], t[o + 5]);
      this._c.set(t[o + 6], t[o + 7], t[o + 8]);
      this._n.set(this._triN[i * 3], this._triN[i * 3 + 1], this._triN[i * 3 + 2]);
      const tt = sweptSphereTriangle(
        origin, dir, radius, limit, this._a, this._b, this._c, this._n, this._q, this._p,
      );
      if (tt >= 0 && tt < limit) {
        limit = tt;
        best = tt;
        this._hit.normal.copy(this._q);
        this._hit.point.copy(this._p);
        this._hit.surfaceId = this._triSurf[i];
      }
    }
    return best;
  }

  /** Collects the triangles the body could possibly touch during this step. */
  _gatherFor(b, dt) {
    this._triCount = 0;
    this._triOverflow = false;
    const world = this.world;
    if (!world.built || world.triangleCount === 0) return;
    const r = b.radius + 0.006;
    const ex = b.pos.x + b.vel.x * dt, ey = b.pos.y + b.vel.y * dt, ez = b.pos.z + b.vel.z * dt;
    this._box.min.set(Math.min(b.pos.x, ex) - r, Math.min(b.pos.y, ey) - r, Math.min(b.pos.z, ez) - r);
    this._box.max.set(Math.max(b.pos.x, ex) + r, Math.max(b.pos.y, ey) + r, Math.max(b.pos.z, ez) + r);
    world.forEachTriangleInBox(this._box, this._gatherCb);
  }

  _collide(b, dt) {
    b._contacted = false;
    if (this._triCount === 0 && !this._sweepHit) return;

    this._contactCount = 0;
    if (b.shape === 'box') this._boxContacts(b);
    else this._sphereContacts(b);

    // A swept stop with no overlap still has to bounce, otherwise fast debris
    // hovers a radius above the floor.
    if (this._contactCount === 0 && this._sweepHit) {
      this._addContact(this._hit.normal, this._hit.point, b.pos, 0, this._hit.surfaceId);
    }
    if (this._contactCount === 0) return;

    b._contacted = true;
    this.stats.contacts += this._contactCount;
    this._resolve(b, dt);
  }

  /**
   * Push direction always comes from the side of the plane the body was on
   * *before* this substep. Deriving it from the current position instead is the
   * classic bug that lets a fast body get pushed out the far side of a floor.
   */
  _side(i) {
    this._n.set(this._triN[i * 3], this._triN[i * 3 + 1], this._triN[i * 3 + 2]);
    return this._n.dot(this._t1.subVectors(this._prev, this._a)) >= 0 ? 1 : -1;
  }

  _sphereContacts(b) {
    for (let i = 0; i < this._triCount; i++) {
      const o = i * 9, t = this._tri;
      this._a.set(t[o], t[o + 1], t[o + 2]);
      this._b.set(t[o + 3], t[o + 4], t[o + 5]);
      this._c.set(t[o + 6], t[o + 7], t[o + 8]);
      const side = this._side(i);
      // Plane reject: the triangle lies in its plane, so a centre further from
      // the plane than the radius cannot touch it. One dot product kills most
      // of the candidate set before the expensive closest-point solve.
      const sdc = this._n.dot(this._t2.subVectors(b.pos, this._a)) * side;
      if (sdc > b.radius) continue;
      closestPointTriangle(b.pos, this._a, this._b, this._c, this._p);
      this._q.subVectors(b.pos, this._p);
      const d = this._q.length();
      const crossed = this._q.dot(this._n) * side < 0;
      if (d >= b.radius && !crossed) continue;
      let depth;
      if (crossed || d <= 1e-6) {
        this._q.copy(this._n).multiplyScalar(side);
        depth = b.radius - this._q.dot(this._t2.subVectors(b.pos, this._p));
      } else {
        this._q.multiplyScalar(1 / d);
        depth = b.radius - d;
      }
      if (depth <= 0) continue;
      this._addContact(this._q, this._p, b.pos, depth, this._triSurf[i]);
    }
  }

  _boxContacts(b) {
    const skin = 0.004;
    // Triangles outer, corners inner: the per-triangle side and plane-distance
    // rejects then cost one dot product for the whole body instead of eight.
    for (let i = 0; i < this._triCount; i++) {
      const o = i * 9, t = this._tri;
      this._a.set(t[o], t[o + 1], t[o + 2]);
      this._b.set(t[o + 3], t[o + 4], t[o + 5]);
      this._c.set(t[o + 6], t[o + 7], t[o + 8]);
      const side = this._side(i);
      const sdc = this._n.dot(this._t2.subVectors(b.pos, this._a)) * side;
      if (sdc > b.radius + skin) continue;

      for (let ci = 0; ci < 8; ci++) {
        const cr = CORNERS[ci];
        this._corner.set(b.half.x * cr[0], b.half.y * cr[1], b.half.z * cr[2])
          .applyQuaternion(b.quat).add(b.pos);
        this._n.set(this._triN[i * 3], this._triN[i * 3 + 1], this._triN[i * 3 + 2]);

        const sd = this._n.dot(this._t2.subVectors(this._corner, this._a)) * side;
        if (sd >= skin) continue;
        {
          // Corner is inside (or within the skin of) the plane: if it projects
          // into the triangle this is a face contact and we push along the normal.
          this._t2.copy(this._corner).addScaledVector(this._n, -sd * side);
          if (pointInTriangle(this._t2, this._a, this._b, this._c)) {
            this._q.copy(this._n).multiplyScalar(side);
            this._addContact(this._q, this._t2, b.pos, skin - sd, this._triSurf[i], ci + 1);
            continue;
          }
        }
        closestPointTriangle(this._corner, this._a, this._b, this._c, this._p);
        this._q.subVectors(this._corner, this._p);
        const d = this._q.length();
        const crossed = this._q.dot(this._n) * side < 0;
        if (d >= skin && !crossed) continue;
        let depth;
        if (crossed || d <= 1e-6) {
          this._q.copy(this._n).multiplyScalar(side);
          depth = skin - this._q.dot(this._t2.subVectors(this._corner, this._p));
        } else {
          this._q.multiplyScalar(1 / d);
          depth = skin - d;
        }
        if (depth <= 0) continue;
        this._addContact(this._q, this._p, b.pos, depth, this._triSurf[i], ci + 1);
      }
    }
  }

  _addContact(normal, point, center, depth, surf, key = 0) {
    if (this._contactCount >= MAX_CONTACTS) return;
    // Merge duplicates *per contact feature*: a floor made of two triangles must
    // not push the same corner twice, but the four corners of a resting box must
    // each keep their own contact or the body tips over its deepest corner.
    for (let i = 0; i < this._contactCount; i++) {
      if (this._ck[i] !== key) continue;
      const dot = this._cn[i * 3] * normal.x + this._cn[i * 3 + 1] * normal.y + this._cn[i * 3 + 2] * normal.z;
      if (dot > 0.995) {
        if (depth > this._cd[i]) {
          this._cd[i] = depth;
          this._cr[i * 3] = point.x - center.x;
          this._cr[i * 3 + 1] = point.y - center.y;
          this._cr[i * 3 + 2] = point.z - center.z;
          this._cs[i] = surf;
        }
        return;
      }
    }
    const i = this._contactCount++;
    this._cn[i * 3] = normal.x; this._cn[i * 3 + 1] = normal.y; this._cn[i * 3 + 2] = normal.z;
    this._cr[i * 3] = point.x - center.x;
    this._cr[i * 3 + 1] = point.y - center.y;
    this._cr[i * 3 + 2] = point.z - center.z;
    this._cd[i] = depth;
    this._cs[i] = surf;
    this._ck[i] = key;
  }

  _resolve(b) {
    const n = this._contactCount;
    let maxImpact = 0;
    let impactSurface = 0;
    let impactIdx = -1;

    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        const nx = this._cn[i * 3], ny = this._cn[i * 3 + 1], nz = this._cn[i * 3 + 2];
        const rx = this._cr[i * 3], ry = this._cr[i * 3 + 1], rz = this._cr[i * 3 + 2];

        // point velocity = v + w x r
        const vx = b.vel.x + (b.angVel.y * rz - b.angVel.z * ry);
        const vy = b.vel.y + (b.angVel.z * rx - b.angVel.x * rz);
        const vz = b.vel.z + (b.angVel.x * ry - b.angVel.y * rx);
        const vn = vx * nx + vy * ny + vz * nz;

        if (pass === 0) {
          // Baumgarte-style partial correction with a slop: correcting the full
          // depth every step is what makes resting boxes buzz.
          const depth = this._cd[i] - 0.0008;
          if (depth > 0) {
            const corr = Math.min(depth * 0.65, 0.05);
            b.pos.x += nx * corr; b.pos.y += ny * corr; b.pos.z += nz * corr;
          }
          if (-vn > maxImpact) { maxImpact = -vn; impactSurface = this._cs[i]; impactIdx = i; }
        }
        if (vn >= 0) continue;

        const props = surfaceProps(this._cs[i]);
        let e = b.restitution * (0.4 + 0.6 * props.restitution / 0.3);
        if (e > 0.85) e = 0.85;
        if (-vn < 0.9) e = 0;                    // stop micro-bouncing

        // r x n and the isotropic-inertia denominator
        const rnx = ry * nz - rz * ny;
        const rny = rz * nx - rx * nz;
        const rnz = rx * ny - ry * nx;
        const denom = b.invMass + b.invInertia * (rnx * rnx + rny * rny + rnz * rnz);
        const j = -(1 + e) * vn / denom;

        b.vel.x += nx * j * b.invMass;
        b.vel.y += ny * j * b.invMass;
        b.vel.z += nz * j * b.invMass;
        b.angVel.x += rnx * j * b.invInertia;
        b.angVel.y += rny * j * b.invInertia;
        b.angVel.z += rnz * j * b.invInertia;

        // friction along the tangential slip direction
        let tx = vx - nx * vn, ty = vy - ny * vn, tz = vz - nz * vn;
        const tl = Math.hypot(tx, ty, tz);
        if (tl > 1e-4) {
          tx /= tl; ty /= tl; tz /= tl;
          const rtx = ry * tz - rz * ty;
          const rty = rz * tx - rx * tz;
          const rtz = rx * ty - ry * tx;
          const denomT = b.invMass + b.invInertia * (rtx * rtx + rty * rty + rtz * rtz);
          let jt = -tl / denomT;
          const mu = b.friction * props.friction;
          const maxT = mu * j;
          if (jt < -maxT) jt = -maxT;
          b.vel.x += tx * jt * b.invMass;
          b.vel.y += ty * jt * b.invMass;
          b.vel.z += tz * jt * b.invMass;
          b.angVel.x += rtx * jt * b.invInertia;
          b.angVel.y += rty * jt * b.invInertia;
          b.angVel.z += rtz * jt * b.invInertia;
        }
      }
    }

    // Resting damping. An isotropic inertia tensor plus Gauss-Seidel corner
    // contacts leaves a small residual torque every step; without this a settled
    // casing hums in place forever and never sleeps.
    if (maxImpact < 0.8) {
      b.vel.multiplyScalar(0.90);
      b.angVel.multiplyScalar(0.80);
      // Kill the residual approach velocity against every supporting contact.
      // A body that sinks by g*dt^2 each step and is pushed back out again reads
      // as "moving" forever and never qualifies for sleep — especially at the
      // coarse dt used by the distance LOD.
      for (let i = 0; i < n; i++) {
        const nx = this._cn[i * 3], ny = this._cn[i * 3 + 1], nz = this._cn[i * 3 + 2];
        const vn = b.vel.x * nx + b.vel.y * ny + b.vel.z * nz;
        if (vn < 0) {
          b.vel.x -= nx * vn; b.vel.y -= ny * vn; b.vel.z -= nz * vn;
        }
      }
    }

    if (impactIdx >= 0 && maxImpact > 0.7 && b.impactCooldown <= 0) {
      b.impactCooldown = 0.05;
      b.restSurface = surfaceName(impactSurface);
      const px = b.pos.x + this._cr[impactIdx * 3];
      const py = b.pos.y + this._cr[impactIdx * 3 + 1];
      const pz = b.pos.z + this._cr[impactIdx * 3 + 2];
      this._p.set(px, py, pz);
      this._n.set(this._cn[impactIdx * 3], this._cn[impactIdx * 3 + 1], this._cn[impactIdx * 3 + 2]);
      try {
        b.onImpact?.(b, this._p, this._n, maxImpact, b.restSurface);
        this.onImpact?.(b, this._p, this._n, maxImpact, b.restSurface);
      } catch (e) { /* a bad listener must not kill the sim */ }
    }
  }
}

const _zero = /* @__PURE__ */ new THREE.Vector3();
