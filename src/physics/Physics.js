import * as THREE from 'three';

/** PLACEHOLDER — replaced by the physics agent. */
export class Physics {
  constructor(game) {
    this.game = game;
    this.statics = [];
    this.surfaces = new WeakMap();
    this._ray = new THREE.Raycaster();
  }
  addStatic(mesh, opts = {}) { this.statics.push(mesh); this.surfaces.set(mesh, opts.surface || 'concrete'); }
  build() {}
  raycast(origin, dir, maxDist = 500) {
    this._ray.set(origin, dir);
    this._ray.far = maxDist;
    const hits = this._ray.intersectObjects(this.statics, true);
    if (!hits.length) return null;
    const h = hits[0];
    return {
      point: h.point, normal: h.face?.normal ?? new THREE.Vector3(0, 1, 0),
      distance: h.distance, object: h.object, surface: this.surfaces.get(h.object) || 'concrete',
    };
  }
  sphereCast(o, d, r, m) { return this.raycast(o, d, m); }
  capsuleMove(pos, delta) { return { position: pos.clone().add(delta), grounded: true, normal: new THREE.Vector3(0, 1, 0), hitWall: false }; }
  overlapSphere() { return []; }
}
