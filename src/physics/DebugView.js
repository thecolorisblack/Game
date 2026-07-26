import * as THREE from 'three';
import { BVHHelper } from 'three-mesh-bvh';

/**
 * Screenshot-diagnosable physics debug layer.
 *
 * Everything here is off by default and costs nothing until `setEnabled(true)`.
 * Enable with `?physics=debug` in the URL, `settings.physicsDebug`, or from the
 * console via `__GAME__.physics.setDebug(true)`.
 *
 * Draws: the BVH node boxes per chunk, the player capsule (with its ground
 * normal), every live debris body's bounds, ragdoll bones, and the last N
 * raycasts colour-coded by whether they hit.
 */

const MAX_RAYS = 256;
const MAX_BODIES = 512;

export class DebugView {
  constructor(physics) {
    this.physics = physics;
    this.enabled = false;
    this.group = null;
    this.bvhDepth = 12;
    this._built = false;
    this._rayCount = 0;
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (this.enabled && !this._built) this._build();
    if (this.group) this.group.visible = this.enabled;
  }

  _build() {
    const scene = this.physics.game?.scene;
    if (!scene) return;
    this._built = true;

    this.group = new THREE.Group();
    this.group.name = 'physics.debug';
    this.group.frustumCulled = false;
    this.group.matrixAutoUpdate = false;
    scene.add(this.group);

    // --- BVH ------------------------------------------------------------
    this.bvhGroup = new THREE.Group();
    this.bvhGroup.name = 'physics.debug.bvh';
    this.group.add(this.bvhGroup);
    this.rebuildBVH();

    // --- capsule --------------------------------------------------------
    this.capsule = new THREE.LineSegments(
      capsuleWireframe(1, 1),
      new THREE.LineBasicMaterial({ color: 0x33ff88, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    this.capsule.frustumCulled = false;
    this.capsule.renderOrder = 999;
    this.capsule.visible = false;
    this.group.add(this.capsule);

    // --- rays -----------------------------------------------------------
    this.rayGeo = new THREE.BufferGeometry();
    this.rayGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_RAYS * 6), 3));
    this.rayGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_RAYS * 6), 3));
    this.rayGeo.setDrawRange(0, 0);
    this.rays = new THREE.LineSegments(
      this.rayGeo,
      new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.85 }),
    );
    this.rays.frustumCulled = false;
    this.rays.renderOrder = 999;
    this.group.add(this.rays);

    // --- bodies ---------------------------------------------------------
    this.bodyGeo = new THREE.BufferGeometry();
    this.bodyGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_BODIES * 6 * 2 * 3), 3));
    this.bodyGeo.setDrawRange(0, 0);
    this.bodies = new THREE.LineSegments(
      this.bodyGeo,
      new THREE.LineBasicMaterial({ color: 0xffaa33, depthTest: false, transparent: true, opacity: 0.75 }),
    );
    this.bodies.frustumCulled = false;
    this.bodies.renderOrder = 999;
    this.group.add(this.bodies);

    // --- ragdolls -------------------------------------------------------
    this.dollGeo = new THREE.BufferGeometry();
    this.dollGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(2048 * 3), 3));
    this.dollGeo.setDrawRange(0, 0);
    this.dolls = new THREE.LineSegments(
      this.dollGeo,
      new THREE.LineBasicMaterial({ color: 0xff4488, depthTest: false, transparent: true, opacity: 0.95 }),
    );
    this.dolls.frustumCulled = false;
    this.dolls.renderOrder = 999;
    this.group.add(this.dolls);
  }

  rebuildBVH() {
    if (!this.bvhGroup) return;
    for (let i = this.bvhGroup.children.length - 1; i >= 0; i--) {
      const c = this.bvhGroup.children[i];
      this.bvhGroup.remove(c);
      c.dispose?.();
    }
    const chunks = this.physics.world.chunks;
    for (let i = 0; i < chunks.length; i++) {
      try {
        const helper = new BVHHelper(chunks[i].bvh, this.bvhDepth);
        helper.color.setHSL((i / Math.max(1, chunks.length)) * 0.7, 0.85, 0.55);
        helper.opacity = 0.32;
        helper.displayParents = false;
        helper.frustumCulled = false;
        helper.update?.();
        this.bvhGroup.add(helper);
      } catch (err) {
        // The helper is a nicety; never let it break the debug view.
        console.warn('[Physics] BVH helper failed', err);
      }
    }
  }

  /** Records a ray for this frame's overlay. */
  addRay(origin, dir, distance, hit) {
    if (!this.enabled || !this.rayGeo || this._rayCount >= MAX_RAYS) return;
    const i = this._rayCount++;
    const p = this.rayGeo.attributes.position.array;
    const c = this.rayGeo.attributes.color.array;
    const o = i * 6;
    p[o] = origin.x; p[o + 1] = origin.y; p[o + 2] = origin.z;
    p[o + 3] = origin.x + dir.x * distance;
    p[o + 4] = origin.y + dir.y * distance;
    p[o + 5] = origin.z + dir.z * distance;
    const r = hit ? 1 : 0.15, g = hit ? 0.25 : 0.65, b = hit ? 0.15 : 1;
    c[o] = r; c[o + 1] = g; c[o + 2] = b;
    c[o + 3] = r; c[o + 4] = g; c[o + 5] = b;
  }

  setCapsule(position, radius, height, normal) {
    if (!this.enabled || !this.capsule) return;
    this.capsule.visible = true;
    this.capsule.position.copy(position);
    this.capsule.scale.set(radius, height, radius);
    // Draw the reported ground/wall normal off the capsule's feet so a screenshot
    // shows *why* the controller thinks it is grounded (or is not).
    if (normal) {
      this._v.copy(position);
      this.addRay(this._v, normal, 0.9, true);
    }
  }

  update() {
    if (!this.enabled || !this._built) return;
    const phys = this.physics;

    // rays
    if (this.rayGeo) {
      this.rayGeo.setDrawRange(0, this._rayCount * 2);
      this.rayGeo.attributes.position.needsUpdate = true;
      this.rayGeo.attributes.color.needsUpdate = true;
      this._rayCount = 0;
    }

    // debris bodies as little crosses
    if (this.bodyGeo) {
      const arr = this.bodyGeo.attributes.position.array;
      const bodies = phys.solver.bodies;
      let w = 0;
      for (let i = 0; i < bodies.length && i < MAX_BODIES; i++) {
        const b = bodies[i];
        if (!b.alive) continue;
        const r = b.radius;
        const { x, y, z } = b.pos;
        const axes = [[r, 0, 0], [0, r, 0], [0, 0, r]];
        for (const a of axes) {
          arr[w++] = x - a[0]; arr[w++] = y - a[1]; arr[w++] = z - a[2];
          arr[w++] = x + a[0]; arr[w++] = y + a[1]; arr[w++] = z + a[2];
        }
      }
      this.bodyGeo.setDrawRange(0, w / 3);
      this.bodyGeo.attributes.position.needsUpdate = true;
    }

    // ragdoll skeletons
    if (this.dollGeo) {
      const arr = this.dollGeo.attributes.position.array;
      let w = 0;
      for (const rd of phys.ragdolls.ragdolls) {
        if (rd.disposed) continue;
        for (const l of rd.links) {
          if (w + 6 > arr.length) break;
          arr[w++] = rd.pos[l.a * 3]; arr[w++] = rd.pos[l.a * 3 + 1]; arr[w++] = rd.pos[l.a * 3 + 2];
          arr[w++] = rd.pos[l.b * 3]; arr[w++] = rd.pos[l.b * 3 + 1]; arr[w++] = rd.pos[l.b * 3 + 2];
        }
      }
      this.dollGeo.setDrawRange(0, w / 3);
      this.dollGeo.attributes.position.needsUpdate = true;
    }
  }

  dispose() {
    if (!this.group) return;
    this.group.parent?.remove(this.group);
    this.group.traverse((o) => {
      o.geometry?.dispose?.();
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else o.material?.dispose?.();
    });
    this.group = null;
    this._built = false;
  }
}

/**
 * Unit capsule wireframe: radius 1, height 1, origin at the feet. Scaled
 * non-uniformly at draw time, which distorts the caps slightly — acceptable for
 * a debug overlay and keeps this to one static buffer.
 */
function capsuleWireframe(radius, height) {
  const pts = [];
  const seg = 24;
  const rings = [0.08, 0.5, 0.92];
  for (const yr of rings) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      pts.push(Math.cos(a0) * radius, yr * height, Math.sin(a0) * radius);
      pts.push(Math.cos(a1) * radius, yr * height, Math.sin(a1) * radius);
    }
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const x = Math.cos(a) * radius, z = Math.sin(a) * radius;
    pts.push(x, 0.08 * height, z, x, 0.92 * height, z);
  }
  // vertical arcs for the caps
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI;
    const cx = Math.cos(a), cz = Math.sin(a);
    for (let i = 0; i < 8; i++) {
      const t0 = (i / 8) * Math.PI * 0.5;
      const t1 = ((i + 1) / 8) * Math.PI * 0.5;
      pts.push(cx * Math.cos(t0) * radius, 0.08 * height - Math.sin(t0) * 0.08 * height, cz * Math.cos(t0) * radius);
      pts.push(cx * Math.cos(t1) * radius, 0.08 * height - Math.sin(t1) * 0.08 * height, cz * Math.cos(t1) * radius);
      pts.push(cx * Math.cos(t0) * radius, 0.92 * height + Math.sin(t0) * 0.08 * height, cz * Math.cos(t0) * radius);
      pts.push(cx * Math.cos(t1) * radius, 0.92 * height + Math.sin(t1) * 0.08 * height, cz * Math.cos(t1) * radius);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return geo;
}
