import * as THREE from 'three';

/** PLACEHOLDER — replaced by the weapons agent. */
export class WeaponSystem {
  constructor(game) { this.game = game; }
  async init() {
    const g = new THREE.BoxGeometry(0.07, 0.12, 0.62);
    const m = new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.45, metalness: 0.8 });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.position.set(0.16, -0.15, -0.42);
    this.game.engine.viewScene.add(this.mesh);
    this.game.engine.viewScene.add(new THREE.HemisphereLight(0xbfd4e8, 0x2a2622, 1.4));
  }
  debugPose() {}
  debugFire() {}
  update() {
    const { camera, viewCamera } = this.game.engine;
    viewCamera.position.copy(camera.position);
    viewCamera.quaternion.copy(camera.quaternion);
  }
}
