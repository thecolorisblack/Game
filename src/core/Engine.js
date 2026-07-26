import * as THREE from 'three';

/**
 * Owns the WebGL context, the render targets and the main camera.
 *
 * Rendering deliberately happens into an HDR float target owned by PostFX rather
 * than straight to the default framebuffer: every downstream effect (bloom,
 * exposure, grading) needs scene-referred values well above 1.0.
 */
export class Engine {
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,          // TAA/SMAA in PostFX handles this; MSAA can't resolve HDR well
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.renderer.debug.checkShaderErrors = true;
    this.renderer.autoClear = true;
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.toneMapping = THREE.NoToneMapping;      // done in PostFX
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // PostFX writes sRGB
    this.renderer.info.autoReset = false;

    this.maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();

    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = true;

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 2200);
    this.camera.rotation.order = 'YXZ';
    this.camera.layers.enable(0);

    // Layer 1 is the first-person viewmodel: rendered by a second camera with a
    // tight near plane so hands/weapon never clip into world geometry.
    this.viewCamera = new THREE.PerspectiveCamera(55, 1, 0.005, 12);
    this.viewCamera.rotation.order = 'YXZ';
    this.viewScene = new THREE.Scene();

    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.renderScale = 1.0;
    this.width = 1;
    this.height = 1;

    this._resizeHandlers = new Set();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  onResize(fn) { this._resizeHandlers.add(fn); return () => this._resizeHandlers.delete(fn); }

  resize() {
    const w = Math.max(2, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(2, this.canvas.clientHeight || window.innerHeight);
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);

    const aspect = w / h;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = aspect;
    this.viewCamera.updateProjectionMatrix();

    for (const fn of this._resizeHandlers) fn(w, h, this.bufferWidth, this.bufferHeight);
  }

  get bufferWidth() { return Math.max(2, Math.floor(this.width * this.pixelRatio * this.renderScale)); }
  get bufferHeight() { return Math.max(2, Math.floor(this.height * this.pixelRatio * this.renderScale)); }

  /**
   * Horizontal FOV is what players actually tune; three stores vertical FOV, so
   * convert through the current aspect to keep a 16:9 "80 FOV" honest at 21:9.
   */
  setHorizontalFov(hfovDeg) {
    const hfov = THREE.MathUtils.degToRad(hfovDeg);
    const vfov = 2 * Math.atan(Math.tan(hfov / 2) / this.camera.aspect);
    this.camera.fov = THREE.MathUtils.radToDeg(vfov);
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.renderer.dispose();
  }
}
