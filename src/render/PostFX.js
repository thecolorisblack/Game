import * as THREE from 'three';

/** PLACEHOLDER — replaced by the render agent. Direct forward render, no effects. */
export class PostFX {
  constructor(game) { this.game = game; }
  async init() {
    this.game.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.game.renderer.toneMappingExposure = 1.0;
    this.game.renderer.outputColorSpace = THREE.SRGBColorSpace;
  }
  async precompile() {
    this.game.renderer.compile(this.game.scene, this.game.engine.camera);
  }
  resetHistory() {}
  render() {
    const { renderer, engine } = this.game;
    renderer.clear();
    renderer.render(engine.scene, engine.camera);
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(engine.viewScene, engine.viewCamera);
    renderer.autoClear = true;
  }
}
