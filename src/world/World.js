import * as THREE from 'three';

/** PLACEHOLDER — replaced by the world agent. */
export class World {
  constructor(game) { this.game = game; this.timeOfDay = 0.32; }
  async build() {
    const { scene } = this.game;
    scene.background = new THREE.Color(0x6b8299);
    scene.fog = new THREE.Fog(0x6b8299, 40, 400);

    const sun = new THREE.DirectionalLight(0xfff0dd, 3.2);
    sun.position.set(-40, 60, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -60; sun.shadow.camera.right = 60;
    sun.shadow.camera.top = 60; sun.shadow.camera.bottom = -60;
    sun.shadow.camera.far = 200;
    scene.add(sun);
    this.sun = sun;
    scene.add(new THREE.HemisphereLight(0x9fc0e0, 0x4a4034, 0.7));

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      this.game.materials.get('sand'),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    this.game.physics.addStatic(ground, { surface: 'sand' });

    for (let i = 0; i < 24; i++) {
      const w = 3 + (i % 5) * 1.5, h = 3 + (i % 7) * 1.2, d = 3 + (i % 3) * 2;
      const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.game.materials.get('concrete'));
      box.position.set(Math.sin(i * 2.4) * 30, h / 2, Math.cos(i * 1.7) * 30 - 10);
      box.castShadow = box.receiveShadow = true;
      scene.add(box);
      this.game.physics.addStatic(box, { surface: 'concrete' });
    }
    this.game.physics.build();
  }
  setTimeOfDay(t) { this.timeOfDay = t; }
  update() {}
}
