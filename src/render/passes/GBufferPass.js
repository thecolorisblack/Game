import * as THREE from 'three';

/**
 * Depth + view-normal + roughness + motion-vector prepass.
 *
 * One MRT draw over the world scene produces everything the rest of the chain
 * needs to reason about geometry:
 *   attachment 0 : rgb = view-space normal, a = per-object roughness
 *   attachment 1 : rg  = screen-space motion vector (UV units), b = coverage
 *   depth        : sampled by AO / SSR / volumetrics / DoF / motion blur
 *
 * Motion vectors are computed from *unjittered* view-projection matrices so
 * TAA's own sub-pixel jitter never leaks into reprojection, while gl_Position
 * uses the jittered camera so depth and normals line up with the colour pass
 * exactly.
 *
 * Previous world matrices are tracked per object (id -> Matrix4) and pushed
 * through `material.onBeforeRender`, which fires before the uniform upload —
 * `uniformsNeedUpdate` forces three to re-upload for every draw even though
 * `scene.overrideMaterial` keeps the material identity constant.
 */

const GBUFFER_VERT = /* glsl */`
#include <common>
#include <batching_pars_vertex>
#include <skinning_pars_vertex>

uniform mat4 uPrevModelMatrix;
uniform mat4 uCurViewProj;
uniform mat4 uPrevViewProj;

varying vec3 vViewNormal;
varying vec4 vCurClip;
varying vec4 vPrevClip;

void main() {
  #include <batching_vertex>
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  #include <project_vertex>

  vViewNormal = transformedNormal;

  vec4 objPos = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    objPos = batchingMatrix * objPos;
  #endif
  #ifdef USE_INSTANCING
    objPos = instanceMatrix * objPos;
  #endif

  vec4 worldPos = modelMatrix * objPos;
  vCurClip  = uCurViewProj  * worldPos;
  vPrevClip = uPrevViewProj * ( uPrevModelMatrix * objPos );
}
`;

const GBUFFER_FRAG = /* glsl */`
layout( location = 1 ) out vec4 gVelocity;

uniform vec2 uMatParams; // roughness, metalness

varying vec3 vViewNormal;
varying vec4 vCurClip;
varying vec4 vPrevClip;

void main() {
  vec3 n = normalize( vViewNormal );
  if ( gl_FrontFacing == false ) n = -n;

  gl_FragColor = vec4( n, uMatParams.x );

  vec2 cur = vCurClip.xy  / max( 1e-6, abs( vCurClip.w  ) ) * sign( vCurClip.w  + 1e-9 );
  vec2 prv = vPrevClip.xy / max( 1e-6, abs( vPrevClip.w ) ) * sign( vPrevClip.w + 1e-9 );
  vec2 velocity = ( cur - prv ) * 0.5;

  // A vertex behind the previous eye plane produces garbage; clamp rather than
  // letting a NaN poison the TAA history for the whole tile.
  if ( vPrevClip.w <= 0.0 || any( greaterThan( abs( velocity ), vec2( 0.75 ) ) ) ) velocity = vec2( 0.0 );

  gVelocity = vec4( velocity, 1.0, uMatParams.y );
}
`;

export class GBufferPass {

  constructor( game ) {
    this.game = game;

    this.material = new THREE.ShaderMaterial( {
      name: 'gbuffer',
      vertexShader: GBUFFER_VERT,
      fragmentShader: GBUFFER_FRAG,
      uniforms: {
        uPrevModelMatrix: { value: new THREE.Matrix4() },
        uCurViewProj: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uMatParams: { value: new THREE.Vector2( 0.5, 0.0 ) },
      },
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
      lights: false,
    } );

    this._prev = new Map();      // object.id -> { m: Matrix4, seen: frame }
    this._hidden = [];
    this._collected = [];
    this._frame = 0;
    this._identity = new THREE.Matrix4();
    this._reset = true;

    const self = this;
    this.material.onBeforeRender = function ( renderer, scene, camera, geometry, object ) {
      const rec = self._prev.get( object.id );
      this.uniforms.uPrevModelMatrix.value.copy( rec && ! self._reset ? rec.m : object.matrixWorld );

      let mat = object.material;
      if ( Array.isArray( mat ) ) mat = mat[ 0 ];
      const p = this.uniforms.uMatParams.value;
      p.x = mat && mat.roughness !== undefined ? mat.roughness : 0.72;
      p.y = mat && mat.metalness !== undefined ? mat.metalness : 0.0;

      // Forces WebGLRenderer to re-upload custom uniforms per draw call even
      // though the material id has not changed (scene.overrideMaterial).
      this.uniformsNeedUpdate = true;
    };
  }

  /** Called by PostFX.resetHistory() — next frame reports zero motion. */
  reset() {
    this._reset = true;
    this._prev.clear();
  }

  /**
   * Masks non-opaque objects out of the prepass by zeroing their layer mask
   * rather than their `visible` flag: `projectObject` skips a layer-masked
   * object but still walks its children, so an opaque child of a transparent
   * parent keeps contributing depth.
   */
  _collect( scene ) {
    const list = this._collected;
    const hidden = this._hidden;
    list.length = 0;
    hidden.length = 0;

    scene.traverseVisible( ( o ) => {
      const renderable = o.isMesh || o.isSkinnedMesh || o.isInstancedMesh || o.isBatchedMesh;
      if ( ! renderable ) {
        // Points / Lines / Sprites are always effects — keep them out of the
        // geometric buffers so AO and SSR do not chew holes in the world.
        if ( o.isPoints || o.isLine || o.isSprite ) {
          hidden.push( o, o.layers.mask );
          o.layers.mask = 0;
        }
        return;
      }
      let mat = o.material;
      if ( Array.isArray( mat ) ) mat = mat[ 0 ];
      const skip = o.userData.postfxIgnore === true
        || ! mat
        || mat.transparent === true
        || mat.wireframe === true
        || mat.depthWrite === false
        || mat.colorWrite === false;
      if ( skip ) {
        hidden.push( o, o.layers.mask );
        o.layers.mask = 0;
        return;
      }
      list.push( o );
    } );

    return list;
  }

  _restore() {
    const hidden = this._hidden;
    for ( let i = 0; i < hidden.length; i += 2 ) hidden[ i ].layers.mask = hidden[ i + 1 ];
    hidden.length = 0;
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} target MRT target (count 2) with a depth texture
   * @param {THREE.Camera} camera jittered world camera
   * @param {THREE.Matrix4} curViewProj unjittered
   * @param {THREE.Matrix4} prevViewProj unjittered, previous frame
   */
  render( renderer, target, scene, camera, curViewProj, prevViewProj ) {
    this._frame++;

    const u = this.material.uniforms;
    u.uCurViewProj.value.copy( curViewProj );
    u.uPrevViewProj.value.copy( this._reset ? curViewProj : prevViewProj );

    const list = this._collect( scene );

    const prevOverride = scene.overrideMaterial;
    const prevAutoUpdate = renderer.shadowMap.autoUpdate;
    const prevClear = renderer.getClearColor( _tmpColor );
    const prevAlpha = renderer.getClearAlpha();

    renderer.shadowMap.autoUpdate = false;   // shadows belong to the colour pass
    scene.overrideMaterial = this.material;
    renderer.setClearColor( 0x000000, 0 );
    renderer.setRenderTarget( target );
    renderer.clear( true, true, false );

    try {
      renderer.render( scene, camera );
    } catch ( e ) {
      console.warn( '[PostFX] g-buffer pass failed', e );
    }

    scene.overrideMaterial = prevOverride;
    renderer.shadowMap.autoUpdate = prevAutoUpdate;
    renderer.setClearColor( prevClear, prevAlpha );

    this._restore();

    // Stash this frame's world matrices for next frame's motion vectors.
    const frame = this._frame;
    for ( let i = 0; i < list.length; i++ ) {
      const o = list[ i ];
      let rec = this._prev.get( o.id );
      if ( ! rec ) { rec = { m: new THREE.Matrix4(), seen: frame }; this._prev.set( o.id, rec ); }
      rec.m.copy( o.matrixWorld );
      rec.seen = frame;
    }
    if ( ( frame & 127 ) === 0 ) {
      for ( const [ id, rec ] of this._prev ) if ( frame - rec.seen > 240 ) this._prev.delete( id );
    }

    this._reset = false;
  }

  dispose() {
    this.material.dispose();
    this._prev.clear();
  }

}

const _tmpColor = new THREE.Color();
