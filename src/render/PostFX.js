import * as THREE from 'three';

import { ScreenPass, makeRT } from './passes/ScreenPass.js';
import { GBufferPass } from './passes/GBufferPass.js';
import { TAAPass } from './passes/TAAPass.js';
import { GTAOPass } from './passes/GTAOPass.js';
import { SSRPass } from './passes/SSRPass.js';
import { VolumetricPass } from './passes/VolumetricPass.js';
import { BloomPass } from './passes/BloomPass.js';
import { DOFPass } from './passes/DOFPass.js';
import { MotionBlurPass } from './passes/MotionBlurPass.js';
import { CompositePass } from './passes/CompositePass.js';
import { createBlueNoiseTexture, BLUE_NOISE_SIZE } from './passes/BlueNoise.js';
import { createLUTTexture, LUT_SIZE } from './passes/ColorLUT.js';
import { GLSL_MATH } from './shaders/common.js';

/**
 * Frame composition for Operation Blackout.
 *
 * This class owns every `renderer.render()` call in the game. The chain is:
 *
 *   g-buffer (normal + roughness + motion vectors + depth, MRT)
 *   HDR world pass (RGBA16F)                 viewmodel pass (RGBA16F, layer 1)
 *   GTAO -> bilateral -> multi-bounce apply
 *   SSR (mip pyramid, roughness cone) -> Fresnel apply
 *   volumetric raymarch vs. the sun shadow map -> bilateral add
 *   viewmodel composite (alpha becomes the "never blur me" mask)
 *   TAA (Halton jitter, dilated reprojection, YCoCg variance clipping)
 *   motion blur (tile/neighbour max reconstruction)
 *   depth of field (hexagonal bokeh gather)
 *   bloom (Karis downsample pyramid + tent upsample)
 *   composite at native res: CA, AgX/ACES, CDL grade, 32^3 LUT, vignette,
 *                            luminance-weighted grain, ordered dither
 *   contrast-adaptive sharpen -> canvas
 *
 * Everything is switchable from `game.settings` and every stage degrades to a
 * pass-through if the system it depends on is missing.
 */

const VIEWMODEL_COMPOSITE = /* glsl */`
precision highp float;
${GLSL_MATH}
uniform sampler2D tScene;
uniform sampler2D tView;
varying vec2 vUv;
void main() {
  vec4 s = texture2D( tScene, vUv );
  vec4 v = texture2D( tView, vUv );
  float a = fxSat( v.a );
  // Alpha carries forward as the viewmodel mask: DoF and motion blur read it
  // to keep the weapon perfectly sharp no matter what the world is doing.
  gl_FragColor = vec4( mix( fxSafe( s.rgb ), fxSafe( v.rgb ), a ), a );
}
`;

const DEBUG_VIEW = /* glsl */`
precision highp float;
${GLSL_MATH}
uniform sampler2D tSrc;
uniform vec4 uParams;   // mode, scale, near, far
varying vec2 vUv;
void main() {
  vec4 t = texture2D( tSrc, vUv );
  int mode = int( uParams.x );
  vec3 c;
  if ( mode == 1 ) c = t.xyz * 0.5 + 0.5;                     // view normals
  else if ( mode == 2 ) c = vec3( t.x, t.y, t.w );            // roughness / misc
  else if ( mode == 3 ) c = vec3( abs( t.xy ) * 40.0, 0.0 );  // velocity
  else if ( mode == 4 ) {                                     // linear depth
    float z = ( 2.0 * uParams.z * uParams.w ) /
              ( uParams.w + uParams.z - ( t.x * 2.0 - 1.0 ) * ( uParams.w - uParams.z ) );
    c = vec3( fract( z * 0.02 ) * 0.5 + z / 200.0 );
  }
  else if ( mode == 5 ) c = vec3( t.x );                      // AO
  else c = t.rgb * uParams.y;                                 // raw colour
  gl_FragColor = vec4( fxLinearToSRGB( max( vec3( 0.0 ), c ) ), 1.0 );
}
`;

const DEBUG_MODES = { raw: 0, normal: 1, roughness: 2, velocity: 3, depth: 4, ao: 5 };

const QUALITY = {
  low:    { aoSlices: 2, aoSteps: 4, ssrSteps: 12, volSteps: 16, dofTaps: 16, mbTaps: 7 },
  medium: { aoSlices: 2, aoSteps: 5, ssrSteps: 16, volSteps: 24, dofTaps: 24, mbTaps: 9 },
  high:   { aoSlices: 3, aoSteps: 6, ssrSteps: 20, volSteps: 32, dofTaps: 32, mbTaps: 13 },
  ultra:  { aoSlices: 3, aoSteps: 8, ssrSteps: 28, volSteps: 40, dofTaps: 48, mbTaps: 15 },
};

const DEFAULTS = {
  bloom: true,
  bloomIntensity: 0.052,
  bloomThreshold: 1.05,
  bloomKnee: 0.62,
  bloomRadius: 1.0,
  tonemap: 'agx',           // 'agx' | 'aces' | 'reinhard'
  agxPunch: 0.22,
  lut: true,
  lutLook: 'blackout',
  lutStrength: 0.8,
  grade: true,
  contrast: 1.06,
  saturation: 1.05,
  aoIntensity: 1.0,
  aoRadius: 1.2,
  aoPower: 1.55,
  ssrIntensity: 1.0,
  volumetricDensity: 0.022,
  volumetricIntensity: 1.0,
  motionBlurAmount: 0.55,
  dofStrength: 1.0,
  dofAperture: 0.20,
  dofAdsAperture: 1.0,
  taaJitterSpread: 1.0,
};

export class PostFX {

  constructor( game ) {
    this.game = game;
    this.ready = false;
    this.failed = false;
    this._failCount = 0;

    // --- state carried between frames ---------------------------------------
    this._prevViewProj = new THREE.Matrix4();
    this._unjitteredProj = new THREE.Matrix4();
    this._unjitteredViewProj = new THREE.Matrix4();
    this._viewProj = new THREE.Matrix4();
    this._invViewProj = new THREE.Matrix4();
    this._jitter = new THREE.Vector2();
    this._sunDirWorld = new THREE.Vector3( 0.4, 0.8, 0.3 );
    this._sunDirView = new THREE.Vector3( 0, 1, 0 );
    this._sunColor = new THREE.Vector3( 1, 0.95, 0.86 );
    this._tmpColor = new THREE.Color();

    this._damage = 0;
    this._deathFade = 0;
    this._focus = 14;
    this._focusTarget = 14;
    this._flash = 0;
    this._flashDecay = 3;
    this._flashColor = new THREE.Vector3( 1, 0.98, 0.94 );

    this.width = 0;
    this.height = 0;
    this.outWidth = 0;
    this.outHeight = 0;

    this.options = { ...DEFAULTS };
  }

  // ==========================================================================
  // lifecycle
  // ==========================================================================

  async init() {
    const { renderer, engine } = this.game;

    // The chain does its own tone mapping and sRGB encode at the very end.
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.autoClear = false;
    renderer.autoClearColor = true;
    renderer.autoClearDepth = true;

    this.blueNoise = createBlueNoiseTexture();
    this.lut = createLUTTexture( this.options.lutLook );

    this.gbuffer = new GBufferPass( this.game );
    this.taa = new TAAPass( 16 );
    this.gtao = new GTAOPass();
    this.ssr = new SSRPass();
    this.volumetric = new VolumetricPass();
    this.bloom = new BloomPass();
    this.dof = new DOFPass();
    this.motionBlur = new MotionBlurPass();
    this.finalPass = new CompositePass();

    this.viewComposite = new ScreenPass( VIEWMODEL_COMPOSITE, {
      tScene: { value: null },
      tView: { value: null },
    }, { name: 'viewComposite' } );

    this.debugPass = new ScreenPass( DEBUG_VIEW, {
      tSrc: { value: null },
      uParams: { value: new THREE.Vector4( 0, 1, 0.05, 2200 ) },
    }, { name: 'debugView' } );

    /**
     * Set to one of 'raw' | 'normal' | 'roughness' | 'velocity' | 'depth' | 'ao'
     * to blit that intermediate buffer to the screen instead of the graded
     * frame. Intended for other systems' debug overlays and for tuning.
     */
    this.debug = null;
    this._quality = null;
    this._applyQuality();

    this._passesWithNoise = [
      this.gtao.compute, this.ssr.trace, this.volumetric.compute,
      this.dof.gather, this.motionBlur.reconstruct, this.finalPass.composite,
    ];
    for ( const p of this._passesWithNoise ) {
      if ( p.uniforms.tBlueNoise ) p.uniforms.tBlueNoise.value = this.blueNoise;
      if ( p.uniforms.uNoiseParams ) p.uniforms.uNoiseParams.value.x = 1 / BLUE_NOISE_SIZE;
    }
    this.finalPass.composite.uniforms.tLUT.value = this.lut;
    this.finalPass.composite.uniforms.uLutSize.value = LUT_SIZE;

    this._allocate();
    this._unsubResize = engine.onResize( () => this._allocate() );
    this._bindEvents();

    this.ready = true;
  }

  /**
   * Compiles every program in the chain before the first interactive frame.
   * A shader hitch on the first shot fired is the most obvious "web demo"
   * tell there is, so this deliberately runs the *real* pipeline twice with
   * every effect forced on rather than warming a subset.
   */
  async precompile() {
    if ( ! this.ready ) return;
    const { renderer, engine, scene } = this.game;

    try {
      renderer.compile( scene, engine.camera );
      renderer.compile( engine.viewScene, engine.viewCamera );
    } catch ( e ) { /* placeholder world, nothing to compile */ }

    const s = this.game.settings;
    const saved = {};
    for ( const k of [ 'taa', 'ssao', 'ssr', 'volumetrics', 'dof', 'motionBlur' ] ) {
      saved[ k ] = s[ k ];
      s[ k ] = true;
    }
    const savedTonemap = this.options.tonemap;

    try {
      for ( const mode of [ 'agx', 'aces', 'reinhard' ] ) {
        this.options.tonemap = mode;
        this.render( 1 / 60 );
      }
    } catch ( e ) {
      console.warn( '[PostFX] precompile pass failed', e );
    }

    this.options.tonemap = savedTonemap;
    for ( const k of Object.keys( saved ) ) s[ k ] = saved[ k ];
    this.resetHistory();
    await null;
  }

  /**
   * Second-order responses the post chain owns rather than the HUD: a close
   * explosion washes the sensor out, taking damage desaturates and bruises the
   * periphery, dying drains the frame. All of it is frame composition, so it
   * belongs here and not in a DOM overlay.
   */
  _bindEvents() {
    const bus = this.game.bus;
    if ( ! bus?.on ) return;

    bus.on( 'explosion', ( e ) => {
      try {
        const cam = this.game.engine.camera;
        const d = e?.position ? cam.position.distanceTo( e.position ) : 8;
        const power = e?.power ?? 1;
        const radius = e?.radius ?? 6;
        const amount = THREE.MathUtils.clamp( power * radius / ( 4 + d * d ), 0, 6 );
        if ( amount > 0.02 ) this.flash( amount, 5.5, { r: 1, g: 0.86, b: 0.62 } );
      } catch ( err ) { /* malformed payload from another system */ }
    } );

    bus.on( 'damage:taken', ( e ) => {
      const amt = THREE.MathUtils.clamp( ( e?.amount ?? 10 ) / 55, 0.08, 0.6 );
      this._damage = Math.min( 1, this._damage + amt );
    } );

    bus.on( 'player:died', () => { this._damage = 1; this._deathFade = 1; } );

    bus.on( 'state', ( e ) => {
      if ( e?.next === 'playing' && e?.prev !== 'paused' ) {
        this._damage = 0;
        this._deathFade = 0;
        this.resetHistory();
      }
    } );
  }

  /** Scales sample counts with `settings.preset` without touching resolution. */
  _applyQuality() {
    const preset = this.game.settings.preset;
    if ( preset === this._quality ) return;
    this._quality = preset;
    const q = QUALITY[ preset ] || QUALITY.high;
    this.gtao.setQuality( q.aoSlices, q.aoSteps );
    this.ssr.setQuality( q.ssrSteps );
    this.volumetric.setQuality( q.volSteps );
    this.dof.setQuality( q.dofTaps );
    this.motionBlur.setQuality( q.mbTaps );
  }

  /** Drop all temporal state. The capture harness calls this on every teleport. */
  resetHistory() {
    this.taa?.reset();
    this.gbuffer?.reset();
    this._resetMatrices = true;
  }

  dispose() {
    this._unsubResize?.();
    for ( const p of [ this.gbuffer, this.taa, this.gtao, this.ssr, this.volumetric,
      this.bloom, this.dof, this.motionBlur, this.finalPass, this.viewComposite, this.debugPass ] ) p?.dispose();
    for ( const rt of [ this.gbufferRT, this.hdrA, this.hdrB, this.viewRT, this.ldrRT ] ) rt?.dispose();
    this.blueNoise?.dispose();
    this.lut?.dispose();
    this.ready = false;
  }

  // ==========================================================================
  // public API for other systems
  // ==========================================================================

  /** Focus distance in metres; pass null to return to automatic centre focus. */
  setFocusDistance( metres ) { this._manualFocus = metres; }

  /** Screen flash (flashbangs, close explosions). `color` is linear RGB. */
  flash( intensity = 4, decay = 3, color = null ) {
    this._flash = Math.max( this._flash, intensity );
    this._flashDecay = decay;
    if ( color ) this._flashColor.set( color.r ?? color.x ?? 1, color.g ?? color.y ?? 1, color.b ?? color.z ?? 1 );
  }

  /** Swap the creative LUT at runtime (e.g. night vision). */
  setLook( look ) {
    if ( look === this.options.lutLook ) return;
    this.options.lutLook = look;
    this.lut?.dispose();
    this.lut = createLUTTexture( look );
    this.finalPass.composite.uniforms.tLUT.value = this.lut;
  }

  // ==========================================================================
  // allocation
  // ==========================================================================

  _allocate() {
    const { engine, renderer } = this.game;

    const w = Math.max( 2, engine.bufferWidth );
    const h = Math.max( 2, engine.bufferHeight );
    const ow = Math.max( 2, Math.round( engine.width * engine.pixelRatio ) );
    const oh = Math.max( 2, Math.round( engine.height * engine.pixelRatio ) );

    if ( w === this.width && h === this.height && ow === this.outWidth && oh === this.outHeight ) return;

    this.width = w; this.height = h;
    this.outWidth = ow; this.outHeight = oh;

    const half = ( v ) => Math.max( 2, Math.ceil( v / 2 ) );
    const quarter = ( v ) => Math.max( 2, Math.ceil( v / 4 ) );

    this.gbufferRT?.dispose();
    this.gbufferRT = null;
    try {
      const depth = new THREE.DepthTexture( w, h );
      depth.format = THREE.DepthFormat;
      depth.type = THREE.UnsignedIntType;
      depth.minFilter = THREE.NearestFilter;
      depth.magFilter = THREE.NearestFilter;
      depth.generateMipmaps = false;

      this.gbufferRT = new THREE.WebGLRenderTarget( w, h, {
        count: 2,
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: true,
        stencilBuffer: false,
        generateMipmaps: false,
        depthTexture: depth,
      } );
      for ( const t of this.gbufferRT.textures ) t.colorSpace = THREE.NoColorSpace;
      this.gbufferRT.textures[ 0 ].name = 'gNormalRoughness';
      this.gbufferRT.textures[ 1 ].name = 'gVelocity';
      this.hasGBuffer = true;
    } catch ( e ) {
      console.warn( '[PostFX] MRT g-buffer unavailable; geometric effects disabled', e );
      this.hasGBuffer = false;
    }

    this.hdrA?.dispose();
    this.hdrB?.dispose();
    this.viewRT?.dispose();
    this.ldrRT?.dispose();

    this.hdrA = makeRT( w, h, { name: 'hdrA' } );
    this.hdrB = makeRT( w, h, { name: 'hdrB' } );
    this.viewRT = makeRT( w, h, { name: 'viewmodel', depthBuffer: true } );
    this.ldrRT = makeRT( ow, oh, {
      name: 'ldr', type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false,
    } );

    this.taa.setSize( w, h );
    this.gtao.setSize( half( w ), half( h ) );
    this.ssr.setSize( half( w ), half( h ) );
    this.volumetric.setSize( quarter( w ), quarter( h ) );
    this.dof.setSize( half( w ), half( h ) );
    this.motionBlur.setSize( w, h );
    this.bloom.setSize( w, h, Math.max( 2, this._bloomLevels() ) );
    this.finalPass.setSize( ow, oh );

    this.dof.prepare.uniforms.uSrcTexel.value.set( 1 / w, 1 / h );

    renderer.setRenderTarget( null );
    this.resetHistory();
  }

  _bloomLevels() {
    const s = this.game.settings;
    const n = ( s.bloomLevels ?? 6 ) | 0;
    if ( n <= 0 ) return 0;               // 0 genuinely means "no bloom"
    return Math.max( 2, Math.min( 8, n ) );
  }

  // ==========================================================================
  // per-frame
  // ==========================================================================

  _opt( key ) {
    const s = this.game.settings;
    return s[ key ] !== undefined ? s[ key ] : this.options[ key ];
  }

  _syncSize() {
    const { engine } = this.game;
    const wanted = THREE.MathUtils.clamp( this.game.settings.renderScale ?? 1, 0.4, 2 );
    if ( Math.abs( ( engine.renderScale ?? 1 ) - wanted ) > 1e-4 ) {
      engine.renderScale = wanted;
      this._allocate();
    } else if ( engine.bufferWidth !== this.width || engine.bufferHeight !== this.height ) {
      this._allocate();
    }
  }

  _updateSun() {
    const sun = this.game.world?.sun || this.game.world?.sunLight || null;
    if ( sun && sun.isLight ) {
      const target = sun.target?.position || _zero;
      this._sunDirWorld.copy( sun.position ).sub( target );
      if ( this._sunDirWorld.lengthSq() < 1e-6 ) this._sunDirWorld.set( 0, 1, 0 );
      this._sunDirWorld.normalize();
      const c = sun.color || _white;
      const i = sun.intensity ?? 1;
      this._sunColor.set( c.r * i, c.g * i, c.b * i );
      this._sun = sun;
    } else {
      this._sun = null;
      this._sunColor.set( 0.9, 0.85, 0.78 );
    }
    this._sunDirView.copy( this._sunDirWorld )
      .transformDirection( this.game.engine.camera.matrixWorldInverse );
  }

  /** Centre-screen autofocus through the physics BVH; falls back to a fixed plane. */
  _updateFocus( dt ) {
    const g = this.game;
    let target = this._manualFocus;

    if ( target == null ) {
      target = 18;
      try {
        const cam = g.engine.camera;
        const dir = _tmpDir.set( 0, 0, -1 ).applyQuaternion( cam.quaternion );
        const hit = g.physics?.raycast?.( cam.position, dir, 220 );
        if ( hit && hit.distance > 0 ) target = hit.distance;
      } catch ( e ) { /* physics placeholder */ }
    }

    this._focusTarget = THREE.MathUtils.clamp( target, 0.25, 400 );
    // Critically damped-ish approach: a focus puller does not snap.
    const k = 1 - Math.exp( -dt * 7.5 );
    this._focus += ( this._focusTarget - this._focus ) * k;
  }

  _adsAmount() {
    const w = this.game.weapons;
    if ( ! w ) return 0;
    const v = w.adsAmount ?? w.adsBlend ?? w.ads ?? w.isADS;
    if ( typeof v === 'number' ) return THREE.MathUtils.clamp( v, 0, 1 );
    return v ? 1 : 0;
  }

  _applyJitter( camera, w, h, spread ) {
    this.taa.jitter( this._jitter, spread );
    const e = camera.projectionMatrix.elements;
    e[ 8 ] += ( this._jitter.x * 2 ) / w;
    e[ 9 ] += ( this._jitter.y * 2 ) / h;
    camera.projectionMatrixInverse.copy( camera.projectionMatrix ).invert();
  }

  _setProjUniforms( pass, camera ) {
    const u = pass.uniforms;
    if ( u.uInvProjection ) u.uInvProjection.value.copy( camera.projectionMatrixInverse );
    if ( u.uProjection ) u.uProjection.value.copy( camera.projectionMatrix );
    if ( u.uProjParams ) u.uProjParams.value.set( camera.near, camera.far, 1 / camera.near, 1 / camera.far );
  }

  _other( src ) { return src === this.hdrA ? this.hdrB : this.hdrA; }

  render( dt ) {
    if ( ! this.ready || this.failed ) { this._fallbackRender(); return; }
    try {
      this._renderChain( Math.min( 0.1, Math.max( 1e-4, dt || 1 / 60 ) ) );
      this._failCount = 0;
    } catch ( e ) {
      this._failCount++;
      console.error( '[PostFX] frame failed', e );
      // A throw between jitter and restore would otherwise leave the camera's
      // projection permanently skewed and drifting a little further each frame.
      try {
        const cam = this.game.engine.camera;
        cam.projectionMatrix.copy( this._unjitteredProj );
        cam.projectionMatrixInverse.copy( this._unjitteredProj ).invert();
        this.game.engine.viewCamera.updateProjectionMatrix();
      } catch ( e2 ) { /* nothing sane left to restore */ }
      if ( this._failCount > 8 ) {
        this.failed = true;
        console.error( '[PostFX] disabling post chain after repeated failures' );
      }
      try { this._fallbackRender(); } catch ( e2 ) { /* give up for this frame */ }
    }
  }

  _fallbackRender() {
    const { renderer, engine } = this.game;
    renderer.setRenderTarget( null );
    renderer.clear( true, true, false );
    renderer.render( engine.scene, engine.camera );
    renderer.clearDepth();
    renderer.render( engine.viewScene, engine.viewCamera );
  }

  _renderChain( dt ) {
    const g = this.game;
    const { renderer, engine, settings } = g;
    const camera = engine.camera;
    const viewCamera = engine.viewCamera;

    this._syncSize();
    this._applyQuality();

    const w = this.width, h = this.height;
    const useTAA = settings.taa !== false && this.hasGBuffer;
    const useAO = settings.ssao !== false && this.hasGBuffer;
    const useSSR = settings.ssr === true && this.hasGBuffer;
    const useVol = settings.volumetrics === true;
    const useDOF = settings.dof !== false && this.hasGBuffer;
    const useMB = settings.motionBlur === true && this.hasGBuffer;
    const useBloom = this._opt( 'bloom' ) !== false && this._bloomLevels() > 0;

    // ---- camera matrices -----------------------------------------------------
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy( camera.matrixWorld ).invert();
    viewCamera.updateMatrixWorld();
    viewCamera.matrixWorldInverse.copy( viewCamera.matrixWorld ).invert();

    this._unjitteredProj.copy( camera.projectionMatrix );
    this._unjitteredViewProj.multiplyMatrices( this._unjitteredProj, camera.matrixWorldInverse );
    if ( this._resetMatrices ) {
      this._prevViewProj.copy( this._unjitteredViewProj );
      this._resetMatrices = false;
    }

    const spread = useTAA ? this._opt( 'taaJitterSpread' ) : 0;
    if ( spread > 0 ) {
      this._applyJitter( camera, w, h, spread );
      this._applyJitter( viewCamera, w, h, spread );
    }

    this._viewProj.multiplyMatrices( camera.projectionMatrix, camera.matrixWorldInverse );
    this._invViewProj.copy( this._viewProj ).invert();

    this._updateSun();
    this._updateFocus( dt );

    const noisePhase = ( this.taa.index * 0.6180339887498949 ) % 1;
    for ( const p of this._passesWithNoise ) {
      const u = p.uniforms.uNoiseParams;
      if ( u ) { u.value.y = this.taa.index; u.value.z = noisePhase; }
    }

    // ---- 1. g-buffer ---------------------------------------------------------
    if ( this.hasGBuffer ) {
      this.gbuffer.render( renderer, this.gbufferRT, engine.scene, camera,
        this._unjitteredViewProj, this._prevViewProj );
    }

    const depthTex = this.hasGBuffer ? this.gbufferRT.depthTexture : null;
    const normalTex = this.hasGBuffer ? this.gbufferRT.textures[ 0 ] : null;
    const velocityTex = this.hasGBuffer ? this.gbufferRT.textures[ 1 ] : null;

    // ---- 2. HDR world pass ---------------------------------------------------
    renderer.shadowMap.autoUpdate = true;
    renderer.setRenderTarget( this.hdrA );
    renderer.clear( true, true, false );
    renderer.render( engine.scene, camera );
    renderer.shadowMap.autoUpdate = false;

    // ---- 3. viewmodel pass ---------------------------------------------------
    const prevClear = renderer.getClearColor( this._tmpColor ).clone();
    const prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor( 0x000000, 0 );
    renderer.setRenderTarget( this.viewRT );
    renderer.clear( true, true, false );
    if ( engine.viewScene.children.length ) renderer.render( engine.viewScene, viewCamera );
    renderer.setClearColor( prevClear, prevAlpha );

    let src = this.hdrA;

    // ---- 4. ambient occlusion -----------------------------------------------
    if ( useAO ) {
      const c = this.gtao.compute;
      c.uniforms.tDepth.value = depthTex;
      c.uniforms.tNormal.value = normalTex;
      c.uniforms.uRadius.value = this._opt( 'aoRadius' );
      c.uniforms.uProjScale.value = 0.5 * camera.projectionMatrix.elements[ 5 ] * this.gtao.height;
      this._setProjUniforms( c, camera );

      const ao = this.gtao.computeAO( renderer );

      const a = this.gtao.apply;
      a.uniforms.tScene.value = src.texture;
      a.uniforms.tAO.value = ao.texture;
      a.uniforms.tDepth.value = depthTex;
      a.uniforms.tNormal.value = normalTex;
      a.uniforms.uIntensity.value = this._opt( 'aoIntensity' );
      a.uniforms.uPower.value = this._opt( 'aoPower' );
      a.uniforms.uSunDirView.value.copy( this._sunDirView );
      this._setProjUniforms( a, camera );

      const dst = this._other( src );
      a.render( renderer, dst );
      src = dst;
    }

    // ---- 5. screen space reflections ----------------------------------------
    if ( useSSR ) {
      this.ssr.buildPyramid( renderer, src.texture, w, h );

      const t = this.ssr.trace;
      t.uniforms.tDepth.value = depthTex;
      t.uniforms.tNormal.value = normalTex;
      this._setProjUniforms( t, camera );
      t.render( renderer, this.ssr.rt );

      const a = this.ssr.apply;
      a.uniforms.tScene.value = src.texture;
      a.uniforms.tSSR.value = this.ssr.rt.texture;
      a.uniforms.tDepth.value = depthTex;
      a.uniforms.tNormal.value = normalTex;
      a.uniforms.tMisc.value = velocityTex;
      a.uniforms.uIntensity.value = this._opt( 'ssrIntensity' );
      this._setProjUniforms( a, camera );

      const dst = this._other( src );
      a.render( renderer, dst );
      src = dst;
    }

    // ---- 6. volumetric scattering -------------------------------------------
    if ( useVol && depthTex ) {
      const c = this.volumetric.compute;
      const shadow = this._sun?.shadow;
      const shadowMap = shadow?.map?.texture || null;
      c.uniforms.tDepth.value = depthTex;
      c.uniforms.tShadow.value = shadowMap;
      c.uniforms.uHasShadow.value = shadowMap ? 1 : 0;
      c.uniforms.uIsVSM.value = renderer.shadowMap.type === THREE.VSMShadowMap ? 1 : 0;
      if ( shadow ) c.uniforms.uShadowMatrix.value.copy( shadow.matrix );
      c.uniforms.uInvViewProj.value.copy( this._invViewProj );
      c.uniforms.uCameraPos.value.setFromMatrixPosition( camera.matrixWorld );
      c.uniforms.uSunDir.value.copy( this._sunDirWorld );
      c.uniforms.uSunColor.value.copy( this._sunColor );
      c.uniforms.uDensity.value = this._opt( 'volumetricDensity' );
      c.uniforms.uIntensity.value = this._opt( 'volumetricIntensity' );
      c.uniforms.uHeightBase.value = ( g.world?.fogBase ?? 0 );
      this._setProjUniforms( c, camera );
      c.render( renderer, this.volumetric.rt );

      const a = this.volumetric.apply;
      a.uniforms.tScene.value = src.texture;
      a.uniforms.tVolume.value = this.volumetric.rt.texture;
      a.uniforms.tDepth.value = depthTex;
      this._setProjUniforms( a, camera );

      const dst = this._other( src );
      a.render( renderer, dst );
      src = dst;
    }

    // ---- 7. viewmodel composite (alpha becomes the exclusion mask) -----------
    {
      this.viewComposite.uniforms.tScene.value = src.texture;
      this.viewComposite.uniforms.tView.value = this.viewRT.texture;
      const dst = this._other( src );
      this.viewComposite.render( renderer, dst );
      src = dst;
    }

    // ---- 8. temporal anti-aliasing ------------------------------------------
    if ( useTAA ) {
      src = this.taa.render( renderer, src.texture, velocityTex, depthTex );
    }

    // ---- 9. motion blur ------------------------------------------------------
    if ( useMB && velocityTex ) {
      const tiles = this.motionBlur.buildTiles( renderer, velocityTex );
      const r = this.motionBlur.reconstruct;
      r.uniforms.tScene.value = src.texture;
      r.uniforms.tVelocity.value = velocityTex;
      r.uniforms.tNeighborMax.value = tiles.texture;
      r.uniforms.tDepth.value = depthTex;
      // Normalise to a 60 Hz shutter so a slow frame does not produce a smear.
      const shutter = this._opt( 'motionBlurAmount' ) * Math.min( 1, ( 1 / 60 ) / dt );
      r.uniforms.uStrength.value = shutter;
      this._setProjUniforms( r, camera );

      const dst = this._other( src );
      r.render( renderer, dst );
      src = dst;
    }

    // ---- 10. depth of field --------------------------------------------------
    if ( useDOF && depthTex ) {
      const ads = this._adsAmount();
      const aperture = THREE.MathUtils.lerp( this._opt( 'dofAperture' ), this._opt( 'dofAdsAperture' ), ads );
      this.dof.setFocus( this._focus, aperture, 1.9, 1.0 );
      this.dof.gather.uniforms.uMaxRadius.value = 9 + 11 * ads;

      const p = this.dof.prepare;
      p.uniforms.tScene.value = src.texture;
      p.uniforms.tDepth.value = depthTex;
      this._setProjUniforms( p, camera );
      p.render( renderer, this.dof.rtA );

      const d = this.dof.dilate;
      d.uniforms.tSrc.value = this.dof.rtA.texture;
      d.uniforms.uDirection.value.set( 1, 0 );
      d.render( renderer, this.dof.rtB );
      d.uniforms.tSrc.value = this.dof.rtB.texture;
      d.uniforms.uDirection.value.set( 0, 1 );
      d.render( renderer, this.dof.rtA );

      this.dof.gather.uniforms.tSrc.value = this.dof.rtA.texture;
      this.dof.gather.render( renderer, this.dof.rtB );

      const cpass = this.dof.composite;
      cpass.uniforms.tScene.value = src.texture;
      cpass.uniforms.tBokeh.value = this.dof.rtB.texture;
      cpass.uniforms.tDepth.value = depthTex;
      cpass.uniforms.uStrength.value = this._opt( 'dofStrength' );
      this._setProjUniforms( cpass, camera );

      const dst = this._other( src );
      cpass.render( renderer, dst );
      src = dst;
    }

    // ---- 11. bloom -----------------------------------------------------------
    let bloomTex = null;
    if ( useBloom ) {
      const wantLevels = this._bloomLevels();
      if ( this.bloom.levels !== wantLevels ) this.bloom.setSize( w, h, wantLevels );
      this.bloom.setThreshold( this._opt( 'bloomThreshold' ), this._opt( 'bloomKnee' ) );
      const result = this.bloom.render( renderer, src.texture, this._opt( 'bloomRadius' ) );
      bloomTex = result ? result.texture : null;
    }

    if ( this.debug ) {
      const mode = DEBUG_MODES[ this.debug ] ?? 0;
      const u = this.debugPass.uniforms.uParams.value;
      u.set( mode, 1, camera.near, camera.far );
      this.debugPass.uniforms.tSrc.value =
        this.debug === 'normal' || this.debug === 'roughness' ? normalTex
        : this.debug === 'velocity' ? velocityTex
        : this.debug === 'depth' ? depthTex
        : this.debug === 'ao' ? this.gtao.rtA.texture
        : src.texture;
      this.debugPass.render( renderer, null );
      if ( spread > 0 ) {
        camera.projectionMatrix.copy( this._unjitteredProj );
        camera.projectionMatrixInverse.copy( this._unjitteredProj ).invert();
        viewCamera.updateProjectionMatrix();
      }
      this._prevViewProj.copy( this._unjitteredViewProj );
      this.taa.advance();
      renderer.setRenderTarget( null );
      return;
    }

    // ---- 12. composite + grade ----------------------------------------------
    if ( this._flash > 0 ) {
      this._flash *= Math.exp( -this._flashDecay * dt );
      if ( this._flash < 0.002 ) this._flash = 0;
    }

    const cu = this.finalPass.composite.uniforms;
    cu.tScene.value = src.texture;
    cu.tBloom.value = bloomTex;
    cu.uExposure.value = settings.exposure ?? 1;
    cu.uBloomIntensity.value = this._opt( 'bloomIntensity' );
    cu.uChromatic.value = ( settings.chromaticAberration ?? 0.45 ) * 5.0;
    cu.uVignette.value = settings.vignette ?? 0.6;
    cu.uGrain.value = settings.filmGrain ?? 0.5;
    cu.uAgxPunch.value = this._opt( 'agxPunch' );
    cu.uLutStrength.value = this._opt( 'lut' ) === false ? 0 : this._opt( 'lutStrength' );
    cu.uContrast.value = this._opt( 'grade' ) === false ? 1 : this._opt( 'contrast' );
    cu.uSaturation.value = this._opt( 'grade' ) === false ? 1 : this._opt( 'saturation' );
    cu.uFlash.value = this._flash;
    cu.uFlashColor.value.copy( this._flashColor );

    if ( this._deathFade <= 0 && this._damage > 0 ) {
      this._damage = Math.max( 0, this._damage - dt * 0.85 );
    }
    cu.uDamage.value = Math.max( this._damage, this._deathFade );

    this.finalPass.composite.define( 'BLOOM_ENABLED', bloomTex ? 1 : 0 );
    this.finalPass.composite.define( 'LUT_ENABLED', this._opt( 'lut' ) === false ? 0 : 1 );
    this.finalPass.composite.define( 'TONEMAP_MODE', TONEMAP_MODES[ this._opt( 'tonemap' ) ] ?? 0 );

    const sharpen = settings.sharpen ?? 0.35;
    if ( sharpen > 0.001 ) {
      this.finalPass.composite.render( renderer, this.ldrRT );
      this.finalPass.cas.uniforms.tSrc.value = this.ldrRT.texture;
      this.finalPass.cas.uniforms.uSharpness.value = THREE.MathUtils.clamp( sharpen, 0, 1 );
      this.finalPass.cas.render( renderer, null );
    } else {
      this.finalPass.composite.render( renderer, null );
    }

    // ---- 13. restore camera state -------------------------------------------
    if ( spread > 0 ) {
      camera.projectionMatrix.copy( this._unjitteredProj );
      camera.projectionMatrixInverse.copy( this._unjitteredProj ).invert();
      viewCamera.updateProjectionMatrix();
    }
    this._prevViewProj.copy( this._unjitteredViewProj );
    this.taa.advance();
    renderer.setRenderTarget( null );
  }

  /** Runs after everything else so the composed frame is what other systems see. */
  update() {}

}

const TONEMAP_MODES = { agx: 0, aces: 1, reinhard: 2 };
const _zero = new THREE.Vector3();
const _white = new THREE.Color( 1, 1, 1 );
const _tmpDir = new THREE.Vector3();
