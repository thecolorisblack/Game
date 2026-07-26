import * as THREE from 'three';
import { ScreenPass, makeRT } from './ScreenPass.js';
import { GLSL_MATH } from '../shaders/common.js';

/**
 * Physically-scaled bloom: the Call of Duty: Advanced Warfare / Jimenez
 * "next generation post processing" chain — a progressive 13-tap downsample
 * pyramid with a partial Karis average on the first mip, then a 9-tap tent
 * upsample accumulated back up the pyramid.
 *
 * A single wide gaussian gives you a glow. This gives you the smooth,
 * energy-preserving falloff that a real lens produces: a tiny tight core, a
 * long dim skirt, and no octave banding when a muzzle flash sweeps the frame.
 *
 * The threshold runs in scene-referred space with a soft knee, so only pixels
 * that are genuinely brighter than the exposure key bloom — not everything
 * that happens to be pale.
 */

const COMMON_HEAD = /* glsl */`
precision highp float;
${GLSL_MATH}
uniform sampler2D tSrc;
uniform vec2 uTexel;     // texel size of the SOURCE texture
varying vec2 vUv;
`;

const PREFILTER = /* glsl */`
${COMMON_HEAD}
uniform vec4 uThreshold;  // threshold, knee, 2*knee, 0.25/knee
uniform float uClamp;

vec3 fetch( vec2 o ) {
  return min( fxSafe( texture2D( tSrc, vUv + o * uTexel ).rgb ), vec3( uClamp ) );
}
float karisWeight( vec3 c ) { return 1.0 / ( 1.0 + fxLuma( c ) ); }

void main() {
  // 13-tap "downsample with partial Karis average" — the average is applied
  // per 2x2 group so a single hot pixel cannot dominate the mip.
  vec3 a = fetch( vec2( -2.0,  2.0 ) );
  vec3 b = fetch( vec2(  0.0,  2.0 ) );
  vec3 c = fetch( vec2(  2.0,  2.0 ) );
  vec3 d = fetch( vec2( -2.0,  0.0 ) );
  vec3 e = fetch( vec2(  0.0,  0.0 ) );
  vec3 f = fetch( vec2(  2.0,  0.0 ) );
  vec3 g = fetch( vec2( -2.0, -2.0 ) );
  vec3 h = fetch( vec2(  0.0, -2.0 ) );
  vec3 i = fetch( vec2(  2.0, -2.0 ) );
  vec3 j = fetch( vec2( -1.0,  1.0 ) );
  vec3 k = fetch( vec2(  1.0,  1.0 ) );
  vec3 l = fetch( vec2( -1.0, -1.0 ) );
  vec3 m = fetch( vec2(  1.0, -1.0 ) );

  vec3 g0 = ( j + k + l + m ) * 0.25;
  vec3 g1 = ( a + b + d + e ) * 0.25;
  vec3 g2 = ( b + c + e + f ) * 0.25;
  vec3 g3 = ( d + e + g + h ) * 0.25;
  vec3 g4 = ( e + f + h + i ) * 0.25;

  float w0 = karisWeight( g0 ) * 0.5;
  float w1 = karisWeight( g1 ) * 0.125;
  float w2 = karisWeight( g2 ) * 0.125;
  float w3 = karisWeight( g3 ) * 0.125;
  float w4 = karisWeight( g4 ) * 0.125;

  vec3 col = ( g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4 )
           / max( 1e-5, w0 + w1 + w2 + w3 + w4 );

  // Soft-knee threshold, scene referred.
  float br = fxMax3( col );
  float soft = br - uThreshold.x + uThreshold.y;
  soft = clamp( soft, 0.0, uThreshold.z );
  soft = soft * soft * uThreshold.w;
  float contribution = max( soft, br - uThreshold.x ) / max( br, 1e-5 );

  gl_FragColor = vec4( col * contribution, 1.0 );
}
`;

const DOWNSAMPLE = /* glsl */`
${COMMON_HEAD}
vec3 fetch( vec2 o ) { return fxSafe( texture2D( tSrc, vUv + o * uTexel ).rgb ); }
void main() {
  vec3 a = fetch( vec2( -2.0,  2.0 ) );
  vec3 b = fetch( vec2(  0.0,  2.0 ) );
  vec3 c = fetch( vec2(  2.0,  2.0 ) );
  vec3 d = fetch( vec2( -2.0,  0.0 ) );
  vec3 e = fetch( vec2(  0.0,  0.0 ) );
  vec3 f = fetch( vec2(  2.0,  0.0 ) );
  vec3 g = fetch( vec2( -2.0, -2.0 ) );
  vec3 h = fetch( vec2(  0.0, -2.0 ) );
  vec3 i = fetch( vec2(  2.0, -2.0 ) );
  vec3 j = fetch( vec2( -1.0,  1.0 ) );
  vec3 k = fetch( vec2(  1.0,  1.0 ) );
  vec3 l = fetch( vec2( -1.0, -1.0 ) );
  vec3 m = fetch( vec2(  1.0, -1.0 ) );

  vec3 col = e * 0.125;
  col += ( a + c + g + i ) * 0.03125;
  col += ( b + d + f + h ) * 0.0625;
  col += ( j + k + l + m ) * 0.125;
  gl_FragColor = vec4( col, 1.0 );
}
`;

const UPSAMPLE = /* glsl */`
${COMMON_HEAD}
uniform float uRadius;
uniform float uWeight;
void main() {
  vec2 r = uTexel * uRadius;
  vec3 col = texture2D( tSrc, vUv + vec2( -r.x,  r.y ) ).rgb * 1.0;
  col += texture2D( tSrc, vUv + vec2(  0.0,  r.y ) ).rgb * 2.0;
  col += texture2D( tSrc, vUv + vec2(  r.x,  r.y ) ).rgb * 1.0;
  col += texture2D( tSrc, vUv + vec2( -r.x,  0.0 ) ).rgb * 2.0;
  col += texture2D( tSrc, vUv ).rgb * 4.0;
  col += texture2D( tSrc, vUv + vec2(  r.x,  0.0 ) ).rgb * 2.0;
  col += texture2D( tSrc, vUv + vec2( -r.x, -r.y ) ).rgb * 1.0;
  col += texture2D( tSrc, vUv + vec2(  0.0, -r.y ) ).rgb * 2.0;
  col += texture2D( tSrc, vUv + vec2(  r.x, -r.y ) ).rgb * 1.0;
  gl_FragColor = vec4( fxSafe( col ) * ( 1.0 / 16.0 ) * uWeight, 1.0 );
}
`;

export class BloomPass {

  constructor() {
    this.prefilter = new ScreenPass( PREFILTER, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: new THREE.Vector4( 1.15, 0.65, 1.3, 0.25 / 0.65 ) },
      uClamp: { value: 48 },
    }, { name: 'bloomPrefilter' } );

    this.down = new ScreenPass( DOWNSAMPLE, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
    }, { name: 'bloomDown' } );

    this.up = new ScreenPass( UPSAMPLE, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 1.0 },
      uWeight: { value: 1.0 },
    }, { name: 'bloomUp', blending: THREE.AdditiveBlending } );

    this.mips = [];
    this.levels = 6;
    this._w = 1;
    this._h = 1;
  }

  setThreshold( threshold, knee ) {
    const k = Math.max( 1e-3, knee );
    this.prefilter.uniforms.uThreshold.value.set( threshold, k, 2 * k, 0.25 / k );
  }

  setSize( w, h, levels ) {
    this._w = w; this._h = h;
    this.levels = Math.max( 2, Math.min( 8, levels | 0 ) );
    for ( const m of this.mips ) m.dispose();
    this.mips = [];
    let mw = w, mh = h;
    for ( let i = 0; i < this.levels; i++ ) {
      mw = Math.max( 2, mw >> 1 );
      mh = Math.max( 2, mh >> 1 );
      this.mips.push( makeRT( mw, mh, { name: `bloom${i}` } ) );
      if ( mw <= 4 || mh <= 4 ) break;
    }
    this.levels = this.mips.length;
  }

  /**
   * @returns {THREE.WebGLRenderTarget} mip 0 — the accumulated bloom, half res
   */
  render( renderer, sourceTexture, radius = 1.0 ) {
    const mips = this.mips;
    if ( ! mips.length ) return null;

    this.prefilter.uniforms.tSrc.value = sourceTexture;
    this.prefilter.uniforms.uTexel.value.set( 1 / this._w, 1 / this._h );
    this.prefilter.render( renderer, mips[ 0 ] );

    for ( let i = 1; i < mips.length; i++ ) {
      const src = mips[ i - 1 ];
      this.down.uniforms.tSrc.value = src.texture;
      this.down.uniforms.uTexel.value.set( 1 / src.width, 1 / src.height );
      this.down.render( renderer, mips[ i ] );
    }

    this.up.uniforms.uRadius.value = radius;
    for ( let i = mips.length - 1; i > 0; i-- ) {
      const src = mips[ i ];
      this.up.uniforms.tSrc.value = src.texture;
      this.up.uniforms.uTexel.value.set( 1 / src.width, 1 / src.height );
      // Slightly under-weight the widest octaves so the halo stays a skirt,
      // not a fog bank over the whole image.
      this.up.uniforms.uWeight.value = 1.0;
      this.up.render( renderer, mips[ i - 1 ] );
    }

    return mips[ 0 ];
  }

  dispose() {
    this.prefilter.dispose();
    this.down.dispose();
    this.up.dispose();
    for ( const m of this.mips ) m.dispose();
  }

}
