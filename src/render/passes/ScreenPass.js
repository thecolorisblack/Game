import * as THREE from 'three';
import { FULLSCREEN_VERT } from '../shaders/common.js';

/**
 * One fullscreen triangle, one scene, one camera — shared by every pass in the
 * chain. Swapping `material` on a single mesh keeps the renderer's state cache
 * warm and avoids ~20 scene graphs worth of per-frame bookkeeping.
 */
const _geometry = new THREE.BufferGeometry();
_geometry.setAttribute( 'position', new THREE.BufferAttribute( new Float32Array( [ -1, -1, 0, 3, -1, 0, -1, 3, 0 ] ), 3 ) );
_geometry.setAttribute( 'uv', new THREE.BufferAttribute( new Float32Array( [ 0, 0, 2, 0, 0, 2 ] ), 2 ) );
_geometry.boundingSphere = new THREE.Sphere( new THREE.Vector3(), 4 );

const _camera = new THREE.OrthographicCamera( -1, 1, 1, -1, 0, 1 );
const _mesh = new THREE.Mesh( _geometry, null );
_mesh.frustumCulled = false;
_mesh.matrixAutoUpdate = false;
const _scene = new THREE.Scene();
_scene.matrixWorldAutoUpdate = false;
_scene.add( _mesh );

export class ScreenPass {

  constructor( fragmentShader, uniforms = {}, options = {} ) {
    this.material = new THREE.ShaderMaterial( {
      name: options.name || 'fx',
      vertexShader: FULLSCREEN_VERT,
      fragmentShader,
      uniforms,
      defines: options.defines || {},
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      transparent: !! options.blending,
      blending: options.blending || THREE.NoBlending,
      premultipliedAlpha: false,
    } );
    if ( options.blending === THREE.CustomBlending ) {
      this.material.blendSrc = options.blendSrc ?? THREE.SrcAlphaFactor;
      this.material.blendDst = options.blendDst ?? THREE.OneMinusSrcAlphaFactor;
      this.material.blendEquation = THREE.AddEquation;
    }
    this.uniforms = this.material.uniforms;
    this.enabled = true;
  }

  set( name, value ) {
    const u = this.uniforms[ name ];
    if ( u !== undefined ) u.value = value;
    return this;
  }

  define( name, value ) {
    if ( this.material.defines[ name ] === value ) return this;
    this.material.defines[ name ] = value;
    this.material.needsUpdate = true;
    return this;
  }

  /** `target === null` renders to the canvas. */
  render( renderer, target = null, clearColor = false ) {
    _mesh.material = this.material;
    renderer.setRenderTarget( target );
    if ( clearColor ) renderer.clear( true, false, false );
    renderer.render( _scene, _camera );
  }

  dispose() { this.material.dispose(); }

}

export const HALF_FLOAT_RT = {
  type: THREE.HalfFloatType,
  format: THREE.RGBAFormat,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  wrapS: THREE.ClampToEdgeWrapping,
  wrapT: THREE.ClampToEdgeWrapping,
  depthBuffer: false,
  stencilBuffer: false,
  generateMipmaps: false,
};

export function makeRT( w, h, opts = {} ) {
  const rt = new THREE.WebGLRenderTarget( Math.max( 1, w | 0 ), Math.max( 1, h | 0 ), {
    ...HALF_FLOAT_RT,
    ...opts,
  } );
  rt.texture.colorSpace = THREE.NoColorSpace;
  rt.texture.name = opts.name || 'fxRT';
  return rt;
}
