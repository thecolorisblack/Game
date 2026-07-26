import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { StaticWorld, makeHitRecord } from './StaticWorld.js';
import { CharacterController } from './CharacterController.js';
import { RigidBodySolver } from './RigidBodies.js';
import { RagdollSolver } from './Ragdoll.js';
import { Ballistics } from './Ballistics.js';
import { DebugView } from './DebugView.js';
import { surfaceName, surfaceProps, SURFACE_IDS } from './Surfaces.js';

/**
 * OPERATION BLACKOUT — collision and physics.
 *
 * Everything in the game that needs to know "is something there" comes through
 * this object. It owns:
 *
 *   - a chunked, BVH-accelerated static triangle soup baked from the level
 *     (`addStatic` + `build`), with per-triangle surface ids so a bullet knows it
 *     hit sheet metal and not concrete;
 *   - allocation-free ray and swept-sphere queries;
 *   - a capsule character controller with slide, slope limits and step-up;
 *   - a small rigid-body solver for casings, gibs and debris;
 *   - Verlet ragdolls the AI can drop on death;
 *   - a penetration tracer for wallbangs.
 *
 * Contract surface (fixed by ARCHITECTURE.md):
 *   addStatic(mesh, {surface})            build()
 *   raycast(origin, dir, maxDist, opts)   sphereCast(origin, dir, radius, maxDist)
 *   capsuleMove(pos, delta, radius, height)
 *   overlapSphere(center, radius)
 *
 * Everything else on this class is additive and optional-chaining friendly.
 */
export class Physics {
  constructor(game) {
    this.game = game;

    this.world = new StaticWorld();
    this.controller = new CharacterController(this.world);
    this.solver = new RigidBodySolver(this.world);
    this.ragdolls = new RagdollSolver(this.world);
    this.ballistics = new Ballistics(this.world);
    this.debugView = new DebugView(this);

    this.gravity = -18.5;
    this.enabled = true;
    this.debug = false;

    this._hit = makeHitRecord();
    this._hit2 = makeHitRecord();
    this._dir = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._down = new THREE.Vector3(0, -1, 0);
    this._box = new THREE.Box3();
    this._overlapOut = [];
    this._overlapSeen = new Set();

    this.stats = {
      triangles: 0, chunks: 0, buildMs: 0,
      rays: 0, sweeps: 0, overlaps: 0,
      bodies: 0, sleeping: 0, ragdolls: 0,
      fixedMs: 0,
    };

    this._overlapCb = (tri, triIndex, chunk) => {
      const oi = chunk.triObj[triIndex];
      if (this._overlapSeen.has(oi)) return false;
      // exact sphere-vs-triangle before we accept the object
      if (!triangleIntersectsSphere(tri, this._sphereC, this._sphereR)) return false;
      this._overlapSeen.add(oi);
      const obj = this.world.objects[oi];
      if (obj) this._overlapOut.push(obj);
      return false;
    };
    this._sphereC = new THREE.Vector3();
    this._sphereR = 1;

    this._onExplosion = (e) => {
      if (!e || !e.position) return;
      this.applyExplosion(e.position, e.radius ?? 6, e.power ?? 14);
    };
    bus.on('explosion', this._onExplosion);

    this.solver.onImpact = (body, point, normal, speed, surface) => {
      bus.emit('debris:impact', { body, point, normal, speed, surface });
    };

    this._readDebugFlag();
  }

  /** `main.js` registers us without awaiting init(); this is here for symmetry. */
  async init() {
    this._readDebugFlag();
    return this;
  }

  /** Scratch normalised copy of a direction, for the debug overlay only. */
  _normDir(dir) {
    this._dir.copy(dir);
    const l = this._dir.lengthSq();
    if (l > 1e-12 && Math.abs(l - 1) > 1e-6) this._dir.multiplyScalar(1 / Math.sqrt(l));
    return this._dir;
  }

  _readDebugFlag() {
    let on = !!this.game?.settings?.physicsDebug;
    try {
      if (typeof location !== 'undefined' && /(^|[?&])physics=debug/.test(location.search)) on = true;
    } catch { /* non-browser */ }
    if (on) this.setDebug(true);
  }

  /* ================================================================== */
  /* static world                                                        */
  /* ================================================================== */

  /**
   * Register level geometry. Accepts a Mesh, an InstancedMesh, a Group (every
   * mesh below it is registered) or an array of any of those.
   * @param {THREE.Object3D|Array} object
   * @param {{surface?:string, layer?:number}} [opts]
   */
  addStatic(object, opts = {}) {
    if (Array.isArray(object)) {
      for (const o of object) this.world.add(o, opts);
      return;
    }
    this.world.add(object, opts);
  }

  removeStatic(object) { this.world.remove(object); }

  /** Bakes every registered mesh into world-space BVH chunks. Called by World. */
  build() {
    this.world.build();
    this.stats.triangles = this.world.triangleCount;
    this.stats.chunks = this.world.chunks.length;
    this.stats.buildMs = this.world.buildMs;
    if (this.debug) this.debugView.rebuildBVH();
    return this;
  }

  _ensureBuilt() {
    if (this.world.dirty || !this.world.built) this.build();
  }

  /** Surface id string registered for a mesh, or null. */
  surfaceOf(object) {
    const i = this.world.objIndex.get(object);
    if (i === undefined) return null;
    return surfaceName(this.world.entries[i].surface);
  }

  /* ================================================================== */
  /* queries                                                             */
  /* ================================================================== */

  /**
   * Closest hit along a ray.
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} dir      does not need to be normalised
   * @param {number} [maxDist=500]
   * @param {Object} [opts] {ignore:Object3D|Object3D[], layerMask:number, backfaces:boolean}
   * @returns {{point:THREE.Vector3, normal:THREE.Vector3, distance:number,
   *            object:THREE.Object3D, surface:string, surfaceId:number,
   *            faceIndex:number, instanceId:number, backface:boolean}|null}
   *
   * The traversal itself allocates nothing; only the returned record does. Use
   * `raycastInto()` in loops where even that matters.
   */
  raycast(origin, dir, maxDist = 500, opts = null) {
    if (!origin || !dir) return null;
    this._ensureBuilt();
    this.stats.rays++;
    const found = this.world.rayFirst(origin, dir, maxDist, opts, this._hit);
    if (this.debug) this.debugView.addRay(origin, this._normDir(dir), found ? this._hit.distance : maxDist, found);
    if (!found) return null;
    return cloneHit(this._hit);
  }

  /**
   * Zero-allocation raycast. `target` must come from `physics.createHit()`.
   * @returns {boolean} whether anything was hit
   */
  raycastInto(target, origin, dir, maxDist = 500, opts = null) {
    this._ensureBuilt();
    this.stats.rays++;
    const found = this.world.rayFirst(origin, dir, maxDist, opts, target);
    if (found) target.surface = surfaceName(target.surfaceId);
    return found;
  }

  /** A reusable hit record for `raycastInto` / `sphereCastInto`. */
  createHit() {
    const h = makeHitRecord();
    h.surface = 'concrete';
    return h;
  }

  /** True if the segment a->b is unobstructed. Cheapest visibility test we have. */
  lineOfSight(a, b, opts = null) {
    this._ensureBuilt();
    this._dir.subVectors(b, a);
    const d = this._dir.length();
    if (d < 1e-5) return true;
    this._dir.multiplyScalar(1 / d);
    this.stats.rays++;
    return !this.world.rayFirst(a, this._dir, d - 1e-3, opts, this._hit2);
  }

  /** Swept sphere. Same result shape as `raycast`. */
  sphereCast(origin, dir, radius = 0.15, maxDist = 100, opts = null) {
    if (!origin || !dir) return null;
    this._ensureBuilt();
    this.stats.sweeps++;
    if (!this.world.sphereSweep(origin, dir, radius, maxDist, opts, this._hit)) return null;
    return cloneHit(this._hit);
  }

  sphereCastInto(target, origin, dir, radius, maxDist, opts = null) {
    this._ensureBuilt();
    this.stats.sweeps++;
    const found = this.world.sphereSweep(origin, dir, radius, maxDist, opts, target);
    if (found) target.surface = surfaceName(target.surfaceId);
    return found;
  }

  /**
   * Every static object whose geometry intersects the sphere.
   * @returns {THREE.Object3D[]} a fresh array (safe to keep)
   */
  overlapSphere(center, radius) {
    this._ensureBuilt();
    this.stats.overlaps++;
    this._overlapOut.length = 0;
    this._overlapSeen.clear();
    if (!this.world.built || this.world.triangleCount === 0) return [];
    this._sphereC.copy(center);
    this._sphereR = radius;
    this._box.min.set(center.x - radius, center.y - radius, center.z - radius);
    this._box.max.set(center.x + radius, center.y + radius, center.z + radius);
    this.world.forEachTriangleInBox(this._box, this._overlapCb);
    return this._overlapOut.slice();
  }

  /**
   * Explosion/melee helper: the closest point on static geometry inside a sphere,
   * which is what you want for "did the blast actually reach this cover".
   * @returns {{point:THREE.Vector3, normal:THREE.Vector3, distance:number, surface:string}|null}
   */
  closestSurface(center, radius = 2) {
    this._ensureBuilt();
    if (!this.world.built) return null;
    let best = radius;
    let bestSurf = 0;
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    this._box.min.set(center.x - radius, center.y - radius, center.z - radius);
    this._box.max.set(center.x + radius, center.y + radius, center.z + radius);
    this.world.forEachTriangleInBox(this._box, (tri, triIndex, chunk) => {
      tri.closestPointToPoint(center, tmp);
      const d = tmp.distanceTo(center);
      if (d < best) {
        best = d;
        p.copy(tmp);
        bestSurf = chunk.triSurf[triIndex];
        n.copy(center).sub(tmp);
        if (n.lengthSq() > 1e-10) n.normalize(); else n.set(0, 1, 0);
      }
      return false;
    });
    if (best >= radius) return null;
    return { point: p, normal: n, distance: best, surface: surfaceName(bestSurf) };
  }

  /** Ground surface id under a position — handy for `player:footstep`. */
  groundSurfaceAt(position, maxDist = 2.2) {
    this._ensureBuilt();
    this._tmp.copy(position).y += 0.15;
    if (!this.world.rayFirst(this._tmp, this._down, maxDist, null, this._hit2)) return null;
    return surfaceName(this._hit2.surfaceId);
  }

  /* ================================================================== */
  /* character                                                           */
  /* ================================================================== */

  /**
   * Move a capsule through the world with slide, step-up and a ground probe.
   *
   * `position` is the capsule's **feet** (its lowest point) unless you pass
   * `{origin:'center'}`. `height` is the total capsule height including the caps.
   *
   * @param {THREE.Vector3} position
   * @param {THREE.Vector3} delta      desired displacement for this step
   * @param {number} [radius=0.35]
   * @param {number} [height=1.8]
   * @param {Object} [opts] {origin, stepUp, snapToGround, wasGrounded, slopeLimit,
   *                         stepHeight, ignore, layerMask}
   * @returns {{position:THREE.Vector3, grounded:boolean, normal:THREE.Vector3,
   *            hitWall:boolean, steppedUp:boolean, slope:number,
   *            wallNormal:THREE.Vector3, groundSurface:string|null,
   *            groundObject:THREE.Object3D|null, groundDistance:number}}
   */
  capsuleMove(position, delta, radius = 0.35, height = 1.8, opts = null) {
    this._ensureBuilt();
    const res = this.controller.move(position, delta, radius, height, opts, null);
    if (this.debug) {
      this.debugView.setCapsule(
        opts?.origin === 'center'
          ? this._tmp.copy(res.position).setY(res.position.y - height * 0.5)
          : res.position,
        radius, height, res.normal,
      );
    }
    return res;
  }

  /* ================================================================== */
  /* ballistics                                                          */
  /* ================================================================== */

  /**
   * Walk a round through thin geometry for wallbang support.
   *
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} dir
   * @param {number} [maxDist=250]
   * @param {Object} [opts] {power:number (1 = 5.56 rifle), minEnergy, ignore, layerMask}
   * @returns {{segments:Array, count:number, energy:number, stopped:boolean,
   *            distance:number, endPoint:THREE.Vector3, endDir:THREE.Vector3}}
   *
   * The result object is **reused between calls** — read it or copy out of it
   * before tracing again. Each segment carries entry/exit points and normals, the
   * measured thickness, the surface id and the energy in/out, which is everything
   * VFX needs to spawn matched entry and exit decals.
   */
  penetrationTrace(origin, dir, maxDist = 250, opts = null) {
    this._ensureBuilt();
    this.stats.rays++;
    return this.ballistics.trace(origin, dir, maxDist, opts);
  }

  /* ================================================================== */
  /* dynamics                                                            */
  /* ================================================================== */

  /**
   * Spawn one or more dynamic bodies.
   *
   * @param {Object} opts
   *   position         THREE.Vector3
   *   velocity         THREE.Vector3 (base velocity)
   *   speed / spread   scalar speed and cone half-angle used when count > 1
   *   count            number of bodies (default 1)
   *   shape            'box' | 'sphere'
   *   size             number | {x,y,z} for boxes
   *   radius           for spheres
   *   mass, restitution, friction, drag, angularDrag, gravityScale
   *   lifetime         seconds before the body retires (0 = forever)
   *   object           an Object3D whose transform we drive
   *   instanced        {mesh, index, scale} to drive one InstancedMesh slot
   *   onImpact(body, point, normal, speed, surface)
   *   onExpire(body)   / onSleep(body)
   * @returns {Array<Object>} the spawned bodies
   */
  spawnDebris(opts = {}) {
    const count = Math.max(1, opts.count || 1);
    const out = [];
    const base = opts.velocity || opts.vel;
    for (let i = 0; i < count; i++) {
      const o = count === 1 ? opts : { ...opts };
      if (count > 1) {
        const spread = opts.spread ?? 0.6;
        const speed = opts.speed ?? (base ? base.length() : 3);
        this._dir.set(
          (Math.random() * 2 - 1) * spread,
          (Math.random() * 2 - 1) * spread + 0.35,
          (Math.random() * 2 - 1) * spread,
        );
        if (base) this._dir.add(this._tmp.copy(base).normalize());
        this._dir.normalize().multiplyScalar(speed * (0.65 + Math.random() * 0.7));
        o.velocity = this._dir.clone();
        if (opts.position) {
          o.position = opts.position.clone().add(
            new THREE.Vector3(
              (Math.random() - 0.5) * (opts.jitter ?? 0.08),
              (Math.random() - 0.5) * (opts.jitter ?? 0.08),
              (Math.random() - 0.5) * (opts.jitter ?? 0.08),
            ),
          );
        }
        o.angularVelocity = new THREE.Vector3(
          (Math.random() - 0.5) * 34, (Math.random() - 0.5) * 34, (Math.random() - 0.5) * 34,
        );
        if (Array.isArray(opts.objects)) o.object = opts.objects[i] || null;
      }
      out.push(this.solver.spawn(o));
    }
    this.stats.bodies = this.solver.bodies.length;
    return out;
  }

  /** Convenience preset: a brass case with rifle-ish mass and a hard clatter. */
  spawnShell(opts = {}) {
    return this.solver.spawn({
      shape: 'box',
      size: opts.size || { x: 0.0095, y: 0.0095, z: 0.045 },
      mass: opts.mass ?? 0.011,
      restitution: opts.restitution ?? 0.42,
      friction: opts.friction ?? 0.35,
      angularDrag: opts.angularDrag ?? 0.25,
      drag: opts.drag ?? 0.05,
      lifetime: opts.lifetime ?? 14,
      surface: 'metal',
      ...opts,
    });
  }

  removeBody(body) { this.solver.remove(body); }

  clearDebris() { this.solver.clear(); }

  /**
   * Build an articulated ragdoll the AI can drive.
   *
   * @param {Array} bones  one entry per joint:
   *        {name, position:Vector3, parent:index|name, radius, mass, limit, pinned}
   *        Vector3s, arrays and Object3D/Bone instances are also accepted.
   * @param {Object} [opts] {iterations, damping, friction, coneLimit, selfCollide,
   *                         autoStep, gravityScale, axis}
   * @returns {Ragdoll} handle with .update(dt), .bones[i].{position,quaternion},
   *          .applyImpulse(point, impulse, radius), .applyTo(objects), .dispose()
   */
  createRagdoll(bones, opts = {}) {
    this._ensureBuilt();
    const rd = this.ragdolls.create(bones, opts);
    this.stats.ragdolls = this.ragdolls.ragdolls.length;
    return rd;
  }

  /** Blast impulse against debris and ragdolls. Also fired by the `explosion` event. */
  applyExplosion(position, radius = 6, power = 14) {
    this.solver.applyRadialImpulse(position, radius, power);
    for (const rd of this.ragdolls.ragdolls) {
      if (rd.disposed || !rd.enabled) continue;
      if (rd.center.distanceToSquared(position) > (radius + 1.5) * (radius + 1.5)) continue;
      this._dir.copy(rd.center).sub(position);
      const d = this._dir.length() || 1e-3;
      const falloff = Math.max(0, 1 - d / radius);
      this._dir.multiplyScalar(1 / d).multiplyScalar(power * falloff * 1.6);
      this._dir.y += power * falloff * 0.8;
      rd.applyImpulse(position, this._dir, radius);
    }
  }

  /* ================================================================== */
  /* lifecycle                                                           */
  /* ================================================================== */

  fixedUpdate(dt) {
    if (!this.enabled) return;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    try {
      if (this.world.dirty) this.build();
      const cam = this.game?.camera;
      if (cam) this.solver.setViewPosition(cam.position);
      this.solver.step(dt);
      this.ragdolls.step(dt);
    } catch (err) {
      if (!this._loggedError) {
        this._loggedError = true;
        console.error('[Physics] fixedUpdate failed; physics disabled for this frame', err);
      }
    }
    this.stats.fixedMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    this.stats.bodies = this.solver.stats.active;
    this.stats.sleeping = this.solver.stats.sleeping;
    this.stats.ragdolls = this.ragdolls.ragdolls.length;
  }

  update() {
    if (this.debug) {
      try { this.debugView.update(); } catch (err) { console.warn('[Physics] debug view', err); }
    }
  }

  setDebug(on) {
    this.debug = !!on;
    this.debugView.setEnabled(this.debug);
    if (this.debug && this.world.built) this.debugView.rebuildBVH();
  }

  /** Everything a debug HUD might want, in one call. */
  report() {
    return {
      ...this.stats,
      surfaces: SURFACE_IDS,
      chunkTriangles: this.world.chunks.map((c) => c.count),
      objects: this.world.objects.length,
    };
  }

  dispose() {
    bus.off('explosion', this._onExplosion);
    this.solver.clear();
    this.ragdolls.clear();
    this.debugView.dispose();
    this.world.clear();
  }
}

/* -------------------------------------------------------------------- */

function cloneHit(h) {
  return {
    point: h.point.clone(),
    normal: h.normal.clone(),
    distance: h.distance,
    object: h.object,
    surface: surfaceName(h.surfaceId),
    surfaceId: h.surfaceId,
    faceIndex: h.faceIndex,
    instanceId: h.instanceId,
    backface: h.backface,
  };
}

const _sphereTmp = /* @__PURE__ */ new THREE.Vector3();
function triangleIntersectsSphere(tri, center, radius) {
  tri.closestPointToPoint(center, _sphereTmp);
  return _sphereTmp.distanceToSquared(center) <= radius * radius;
}

export { surfaceProps, surfaceName, SURFACE_IDS };
