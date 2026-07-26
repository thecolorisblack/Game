import * as THREE from 'three';

/** PLACEHOLDER — replaced by the materials agent. */
export class Materials {
  constructor(game) { this.game = game; this.cache = new Map(); }
  async init() {
    this.cache.set('concrete', new THREE.MeshStandardMaterial({ color: 0x8b8880, roughness: 0.9, metalness: 0 }));
    this.cache.set('metal', new THREE.MeshStandardMaterial({ color: 0x6a6f75, roughness: 0.4, metalness: 1 }));
    this.cache.set('wood', new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.8, metalness: 0 }));
    this.cache.set('sand', new THREE.MeshStandardMaterial({ color: 0xc2ab84, roughness: 1, metalness: 0 }));
  }
  get(name) { return this.cache.get(name) ?? this.cache.get('concrete'); }
}
