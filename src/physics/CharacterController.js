import * as THREE from 'three';
import { makeHitRecord } from './StaticWorld.js';
import { closestSegmentTriangle, triNormal } from './Geom.js';
import { surfaceName } from './Surfaces.js';

/**
 * Capsule-vs-triangle character collision.
 *
 * Design notes, because this is the part that decides whether the game feels like
 * Modern Warfare or like a physics demo:
 *
 *  - Motion is **substepped** so no single integration step advances the capsule
 *    more than 40% of its radius. Combined with depenetration this makes tunnelling
 *    impossible at any speed: after a substep the capsule is still overlapping the
 *    plane it just crossed, so the push-out has something to bite on.
 *  - Push-out direction is chosen from the *pre-move* side of the triangle plane,
 *    never from the post-move closest-point direction. Without that, a capsule that
 *    crossed a thin wall would be pushed out the wrong side and pop through.
 *  - Slope handling is explicit: anything steeper than `slopeLimit` is treated as a
 *    wall (its normal is flattened) so the player slides off instead of stair-
 *    climbing a 70 degree pile of rubble.
 *  - Step-up probes forward for the surface that is blocking us and, if its top
 *    is inside the step budget and the capsule fits up there, raises the capsule
 *    onto it and continues the move from that height. Lift-move-drop cannot work
 *    when the per-frame delta is smaller than the capsule radius, which at 120 Hz
 *    it always is.
 *
 * Position convention: `position` is the capsule's **feet** (its lowest point).
 * The capsule's inner segment therefore runs from y+radius to y+height-radius.
 * Pass `{ origin: 'center' }` in opts if your character stores its centre instead.
 */

const MAX_CONTACTS = 96;

export class CharacterController {
  constructor(world, opts = {}) {
    this.world = world;
    this.slopeLimit = opts.slopeLimit ?? THREE.MathUtils.degToRad(46);
    this.stepHeight = opts.stepHeight ?? 0.45;
    this.skin = opts.skin ?? 0.008;
    this.maxSubstepFraction = opts.maxSubstepFraction ?? 0.4;
    this.maxSubsteps = opts.maxSubsteps ?? 24;
    this.depenetrationIterations = opts.depenetrationIterations ?? 4;
    this.snapDistance = opts.snapDistance ?? 0.42;

    this._cosSlope = Math.cos(this.slopeLimit);

    // contact pool (flat arrays; never reallocated)
    this._cn = new Float32Array(MAX_CONTACTS * 3);   // normal
    this._cp = new Float32Array(MAX_CONTACTS * 3);   // point
    this._cd = new Float32Array(MAX_CONTACTS);       // depth
    this._co = new Int32Array(MAX_CONTACTS);         // object index
    this._cs = new Uint8Array(MAX_CONTACTS);         // surface id
    this._contactCount = 0;

    this._pos = new THREE.Vector3();
    this._start = new THREE.Vector3();
    this._delta = new THREE.Vector3();
    this._sub = new THREE.Vector3();
    this._accum = new THREE.Vector3();
    this._segA = new THREE.Vector3();
    this._segB = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._pTri = new THREE.Vector3();
    this._pSeg = new THREE.Vector3();
    this._box = new THREE.Box3();
    this._down = new THREE.Vector3(0, -1, 0);
    this._up = new THREE.Vector3(0, 1, 0);
    this._groundNormal = new THREE.Vector3(0, 1, 0);
    this._wallNormal = new THREE.Vector3();
    this._probe = makeHitRecord();
    this._stepPos = new THREE.Vector3();
    this._flatPos = new THREE.Vector3();
    this._tmp = new THREE.Vector3();

    // Bound once: forEachTriangleInBox is on the hot path.
    this._gatherCb = (tri, triIndex, chunk) => {
      if (this._contactCount >= MAX_CONTACTS) return true;
      triNormal(tri.a, tri.b, tri.c, this._n);
      const dist = closestSegmentTriangle(
        this._segA, this._segB, tri.a, tri.b, tri.c, this._n, this._pTri, this._pSeg,
      );
      const r = this._gatherRadius;
      if (dist >= r) return false;

      // Which side of the plane were we on before the move? That is the side we
      // are allowed to be pushed out towards.
      const side = this._n.dot(this._sideTmp.subVectors(this._sideRef, tri.a)) >= 0 ? 1 : -1;
      let nx, ny, nz, depth;
      if (dist > 1e-6) {
        nx = (this._pSeg.x - this._pTri.x) / dist;
        ny = (this._pSeg.y - this._pTri.y) / dist;
        nz = (this._pSeg.z - this._pTri.z) / dist;
        const align = (nx * this._n.x + ny * this._n.y + nz * this._n.z) * side;
        if (align < 0) {
          // We ended up on the far side of the face: push back the way we came.
          nx = this._n.x * side; ny = this._n.y * side; nz = this._n.z * side;
          const sd = nx * (this._pSeg.x - this._pTri.x)
                   + ny * (this._pSeg.y - this._pTri.y)
                   + nz * (this._pSeg.z - this._pTri.z);
          depth = r - sd;
        } else {
          depth = r - dist;
        }
      } else {
        nx = this._n.x * side; ny = this._n.y * side; nz = this._n.z * side;
        depth = r;
      }

      const i = this._contactCount++;
      this._cn[i * 3] = nx; this._cn[i * 3 + 1] = ny; this._cn[i * 3 + 2] = nz;
      this._cp[i * 3] = this._pTri.x; this._cp[i * 3 + 1] = this._pTri.y; this._cp[i * 3 + 2] = this._pTri.z;
      this._cd[i] = depth;
      this._co[i] = chunk.triObj[triIndex];
      this._cs[i] = chunk.triSurf[triIndex];
      return false;
    };
    this._gatherRadius = 0.4;
    this._sideRef = new THREE.Vector3();
    this._sideTmp = new THREE.Vector3();
    this._stepNormal = new THREE.Vector3(0, 1, 0);
    this._dirN = new THREE.Vector3();
    this._stepSurface = -1;
    this._stepObject = null;
    this._steppedThisMove = false;
  }

  /**
   * @param {THREE.Vector3} position feet position
   * @param {THREE.Vector3} delta    desired displacement this step
   * @param {number} radius
   * @param {number} height          total capsule height
   * @param {Object} [opts]          {origin, stepUp, snapToGround, wasGrounded, slopeLimit, ignore, layerMask}
   * @param {Object} [out]           optional result object to write into
   */
  move(position, delta, radius, height, opts = null, out = null) {
    const world = this.world;
    const r = Math.max(0.04, radius);
    const h = Math.max(2 * r + 0.02, height);
    const centerOrigin = opts?.origin === 'center';
    const cosSlope = opts?.slopeLimit !== undefined ? Math.cos(opts.slopeLimit) : this._cosSlope;
    const stepHeight = opts?.stepHeight ?? this.stepHeight;
    const allowStep = opts?.stepUp !== false;
    const allowSnap = opts?.snapToGround !== false;
    const wasGrounded = opts?.wasGrounded !== false;

    const res = out || {
      position: new THREE.Vector3(),
      normal: new THREE.Vector3(0, 1, 0),
      wallNormal: new THREE.Vector3(),
      grounded: false, hitWall: false, steppedUp: false, slope: 0,
      groundSurface: null, groundObject: null, groundDistance: Infinity,
      contacts: 0, pushed: 0,
    };
    if (!res.position) res.position = new THREE.Vector3();
    if (!res.normal) res.normal = new THREE.Vector3(0, 1, 0);
    if (!res.wallNormal) res.wallNormal = new THREE.Vector3();

    // Work in feet space internally.
    this._pos.copy(position);
    if (centerOrigin) this._pos.y -= h * 0.5;

    if (!world.built || world.triangleCount === 0) {
      this._pos.add(delta);
      if (centerOrigin) this._pos.y += h * 0.5;
      res.position.copy(this._pos);
      res.normal.set(0, 1, 0);
      res.wallNormal.set(0, 0, 0);
      res.grounded = false;
      res.hitWall = false;
      res.steppedUp = false;
      res.slope = 0;
      res.groundSurface = null;
      res.groundObject = null;
      res.groundDistance = Infinity;
      res.contacts = 0;
      return res;
    }

    this._segLow = r;
    this._segHigh = h - r;
    this._radius = r;
    this._gatherRadius = r;
    this._opts = opts;

    this._groundNormal.set(0, 1, 0);
    this._wallNormal.set(0, 0, 0);
    this._grounded = false;
    this._hitWall = false;
    this._groundY = -Infinity;
    this._groundSurface = -1;
    this._groundObject = null;
    this._cosSlopeActive = cosSlope;
    this._totalContacts = 0;
    this._steppedThisMove = false;

    // Resolve any pre-existing overlap (spawned in a wall, world moved, ...).
    this._sideRef.copy(this._pos).addScaledVector(this._up, (this._segLow + this._segHigh) * 0.5);
    this._depenetrate(this._pos, 3, false);

    // --- substepped motion -------------------------------------------------
    this._delta.copy(delta);
    let len = this._delta.length();

    // A single step longer than the substep budget (teleport, explosion punt,
    // a frame spike) is clamped at the swept time of impact first, so the
    // substep loop below always starts from a provably reachable target.
    const maxSafe = this.maxSubsteps * r * this.maxSubstepFraction;
    if (len > maxSafe) {
      len = this._sweepClamp(len, r);
    }

    const steps = len > 1e-9
      ? Math.max(1, Math.min(this.maxSubsteps, Math.ceil(len / (r * this.maxSubstepFraction))))
      : 1;

    this._flatPos.copy(this._pos);
    this._start.copy(this._pos);

    for (let s = 0; s < steps; s++) {
      // `_delta` is the *remaining* path: depenetration projects it onto the
      // planes we touch, so the next substep takes an equal share of what is left
      // rather than of the original (already blocked) vector.
      this._sub.copy(this._delta).multiplyScalar(1 / (steps - s));
      this._delta.sub(this._sub);
      // pre-move reference point for plane-side decisions
      this._sideRef.copy(this._pos).addScaledVector(this._up, (this._segLow + this._segHigh) * 0.5);
      this._pos.add(this._sub);
      this._depenetrate(this._pos, this.depenetrationIterations, true);
    }

    this._flatPos.copy(this._pos);
    const flatContacts = this._totalContacts;

    // --- step up -----------------------------------------------------------
    let steppedUp = false;
    const horizLenSq = delta.x * delta.x + delta.z * delta.z;
    if (allowStep && this._hitWall && horizLenSq > 1e-8 && (wasGrounded || this._grounded)) {
      steppedUp = this._tryStepUp(delta, r, stepHeight, cosSlope);
    }

    // --- ground probe ------------------------------------------------------
    const descending = delta.y <= 1e-4;
    const probeDist = (wasGrounded && descending && allowSnap) ? this.snapDistance : (r * 0.12 + 0.02);
    this._probeGround(probeDist, cosSlope, wasGrounded && descending && allowSnap);

    res.position.copy(this._pos);
    if (centerOrigin) res.position.y += h * 0.5;
    res.grounded = this._grounded;
    res.normal.copy(this._grounded ? this._groundNormal : (this._hitWall ? this._wallNormal : this._up));
    if (!res.normal.lengthSq()) res.normal.set(0, 1, 0);
    res.wallNormal.copy(this._wallNormal);
    res.hitWall = this._hitWall;
    res.steppedUp = steppedUp;
    res.slope = this._grounded
      ? THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(this._groundNormal.y, -1, 1)))
      : 0;
    res.groundSurface = this._groundSurface >= 0 ? surfaceName(this._groundSurface) : null;
    res.groundObject = this._groundObject;
    res.groundDistance = this._groundDistance ?? Infinity;
    res.contacts = Math.max(flatContacts, this._totalContacts);
    return res;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Sweeps a ladder of spheres covering the capsule along the requested motion
   * and shortens `_delta` to the first impact. Returns the new length.
   */
  _sweepClamp(len, r) {
    this._dirN.copy(this._delta).multiplyScalar(1 / len);
    const segLen = this._segHigh - this._segLow;
    const n = Math.max(2, Math.ceil(segLen / (r * 0.8)) + 1);
    let allowed = len;
    for (let k = 0; k < n; k++) {
      const y = this._segLow + segLen * (k / (n - 1));
      this._tmp.set(this._pos.x, this._pos.y + y, this._pos.z);
      if (this.world.sphereSweep(this._tmp, this._dirN, r * 0.98, allowed, this._opts, this._probe)) {
        allowed = Math.min(allowed, Math.max(0, this._probe.distance - this.skin));
      }
    }
    if (allowed >= len) return len;                   // path is provably clear
    this._delta.multiplyScalar(allowed / len);
    return allowed;
  }

  /** Gathers contacts for the capsule sitting at `p` into the contact pool. */
  _gather(p) {
    this._contactCount = 0;
    const r = this._radius;
    this._segA.set(p.x, p.y + this._segLow, p.z);
    this._segB.set(p.x, p.y + this._segHigh, p.z);
    this._box.min.set(this._segA.x - r, this._segA.y - r, this._segA.z - r);
    this._box.max.set(this._segB.x + r, this._segB.y + r, this._segB.z + r);
    this._box.expandByScalar(this.skin * 2);
    this._gatherRadius = r + this.skin;
    this.world.forEachTriangleInBox(this._box, this._gatherCb);
    this._totalContacts += this._contactCount;
    return this._contactCount;
  }

  /**
   * Gauss-Seidel push-out. Each contact's remaining depth is reduced by whatever
   * previous contacts in the same pass already pushed us along its normal, which
   * keeps corners from double-counting and launching the player.
   */
  _depenetrate(p, iterations, classify) {
    const cos = this._cosSlopeActive;
    for (let iter = 0; iter < iterations; iter++) {
      const n = this._gather(p);
      if (n === 0) return iter;
      this._accum.set(0, 0, 0);
      let moved = 0;

      for (let i = 0; i < n; i++) {
        let nx = this._cn[i * 3], ny = this._cn[i * 3 + 1], nz = this._cn[i * 3 + 2];
        let depth = this._cd[i];
        if (depth <= 0) continue;

        if (classify) {
          if (ny >= cos) {
            if (ny > this._groundNormal.y || !this._grounded) {
              this._groundNormal.set(nx, ny, nz);
            }
            this._grounded = true;
            const gy = this._cp[i * 3 + 1];
            if (gy > this._groundY) {
              this._groundY = gy;
              this._groundSurface = this._cs[i];
              this._groundObject = this.world.objects[this._co[i]] || null;
            }
          } else if (ny > 0.3) {
            // A real surface that is too steep to walk: flatten its normal so the
            // player slides off instead of ratcheting up it. Near-vertical
            // contacts (ny <= 0.3) keep their true normal, which is what lets a
            // capsule ride over a kerb or a step edge naturally.
            const hl = Math.hypot(nx, nz);
            if (hl > 1e-4) {
              const scale = 1 / hl;
              depth *= Math.min(4, scale);
              nx *= scale; ny = 0; nz *= scale;
              this._hitWall = true;
              this._wallNormal.set(nx, 0, nz);
            }
          } else {
            this._hitWall = true;
            this._wallNormal.set(nx, ny, nz);
          }
        }

        // subtract what previous pushes already resolved for this contact
        const already = this._accum.x * nx + this._accum.y * ny + this._accum.z * nz;
        const need = depth + this.skin - already;
        if (need <= 0) continue;
        p.x += nx * need; p.y += ny * need; p.z += nz * need;
        this._accum.x += nx * need; this._accum.y += ny * need; this._accum.z += nz * need;
        moved += need;

        // Kill the component of the remaining path that drives into this plane.
        const into = this._delta.x * nx + this._delta.y * ny + this._delta.z * nz;
        if (into < 0) {
          this._delta.x -= nx * into;
          this._delta.y -= ny * into;
          this._delta.z -= nz * into;
        }
      }
      if (moved < 1e-5) return iter;
    }
    return iterations;
  }

  /**
   * Step-up by forward probe.
   *
   * Lift-move-drop cannot work with per-frame deltas smaller than the capsule
   * radius: the lifted capsule never gets far enough over the step to land on it
   * and the drop just puts it back inside the riser. So instead we look *ahead*
   * for the surface we are being blocked by, and if its top is inside the step
   * budget and the capsule fits there, we raise the capsule onto that height in
   * place and continue the move from up there. The character glides onto the step
   * over a few frames, which is exactly how stairs feel in a modern shooter.
   */
  _tryStepUp(delta, r, stepHeight, cosSlope) {
    const hx = delta.x, hz = delta.z;
    const hl = Math.hypot(hx, hz);
    if (hl < 1e-6) return false;
    const dx = hx / hl, dz = hz / hl;
    const feet = this._pos.y;
    const sx = -dz, sz = dx;

    let topY = -Infinity;
    let found = false;
    for (let k = -1; k <= 1; k++) {
      const ox = this._pos.x + dx * (r + 0.06) + sx * k * r * 0.55;
      const oz = this._pos.z + dz * (r + 0.06) + sz * k * r * 0.55;
      this._tmp.set(ox, feet + stepHeight + 0.25, oz);
      if (!this.world.sphereSweep(this._tmp, this._down, 0.02, stepHeight + 0.3, this._opts, this._probe)) continue;
      if (this._probe.normal.y < cosSlope) continue;
      const y = this._probe.point.y;
      if (y > feet + stepHeight + 1e-3) continue;
      if (y > topY) {
        topY = y;
        found = true;
        this._stepNormal.copy(this._probe.normal);
        this._stepSurface = this._probe.surfaceId;
        this._stepObject = this._probe.object;
      }
    }
    if (!found || topY <= feet + 0.015) return false;

    // Does the capsule actually fit with its feet on that surface?
    this._stepPos.set(this._pos.x, topY + this.skin, this._pos.z);
    this._sideRef.copy(this._stepPos).addScaledVector(this._up, (this._segLow + this._segHigh) * 0.5);
    if (this._gather(this._stepPos) > 0) {
      for (let i = 0; i < this._contactCount; i++) {
        if (this._cd[i] > this.skin * 3) return false;
      }
    }

    // Commit the lift, then spend whatever horizontal motion is left from up here.
    this._pos.copy(this._stepPos);
    this._delta.set(hx, 0, hz).multiplyScalar(Math.min(1, 0.5));
    const steps = Math.max(1, Math.min(this.maxSubsteps, Math.ceil(hl / (r * this.maxSubstepFraction))));
    for (let s = 0; s < steps; s++) {
      this._sub.copy(this._delta).multiplyScalar(1 / (steps - s));
      this._delta.sub(this._sub);
      this._sideRef.copy(this._pos).addScaledVector(this._up, (this._segLow + this._segHigh) * 0.5);
      this._pos.add(this._sub);
      this._depenetrate(this._pos, this.depenetrationIterations, false);
    }

    this._grounded = true;
    this._groundNormal.copy(this._stepNormal);
    this._groundSurface = this._stepSurface;
    this._groundObject = this._stepObject;
    this._steppedThisMove = true;
    return true;
  }

  /** Downward sphere sweep from the bottom cap; optionally snaps the capsule down. */
  _probeGround(distance, cosSlope, snap) {
    this._groundDistance = Infinity;
    const r = this._radius;
    const origin = this._tmp.set(this._pos.x, this._pos.y + r, this._pos.z);
    const opts = this._opts;
    if (!this.world.sphereSweep(origin, this._down, r * 0.94, distance + r * 0.06, opts, this._probe)) {
      return;
    }
    const gap = this._probe.distance - r * 0.06;
    this._groundDistance = Math.max(0, gap);
    if (this._probe.normal.y < cosSlope) return;

    if (!this._grounded || this._probe.normal.y > this._groundNormal.y) {
      this._groundNormal.copy(this._probe.normal);
    }
    this._grounded = true;
    if (this._groundSurface < 0 || snap) {
      this._groundSurface = this._probe.surfaceId;
      this._groundObject = this._probe.object;
    }

    if (snap && gap > 1e-4 && !this._steppedThisMove) {
      // Snapping down is only legal if we would actually fit down there —
      // otherwise a character mid-way onto a step gets yanked back into the riser.
      const y = this._pos.y;
      this._pos.y -= gap;
      this._sideRef.copy(this._pos).addScaledVector(this._up, (this._segLow + this._segHigh) * 0.5);
      if (this._gather(this._pos) > 0) {
        for (let i = 0; i < this._contactCount; i++) {
          if (this._cd[i] > this.skin * 3) { this._pos.y = y; return; }
        }
      }
    }
  }
}
