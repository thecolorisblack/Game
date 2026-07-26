import * as THREE from 'three';

/** PLACEHOLDER — replaced by the player agent. */
export class Player {
  constructor(game) {
    this.game = game;
    this.position = new THREE.Vector3(4, 0, 8);
    this.velocity = new THREE.Vector3();
    this.eyeHeight = 1.65;
    this.yaw = 0; this.pitch = 0;
    this.health = 100;
    this.scripted = false;
  }
  async init() {}
  update(dt) {
    if (this.scripted) return;
    const look = this.game.input.consumeLook();
    this.yaw += look.yaw;
    this.pitch = THREE.MathUtils.clamp(this.pitch - look.pitch, -1.5, 1.5);
    const axes = this.game.input.moveAxes();
    const speed = 5.2 * dt;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.position.addScaledVector(fwd, axes.y * speed).addScaledVector(right, axes.x * speed);
    const cam = this.game.engine.camera;
    cam.position.copy(this.position).y += this.eyeHeight;
    cam.rotation.set(this.pitch, this.yaw, 0);
  }
}
