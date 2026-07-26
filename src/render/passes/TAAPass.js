import * as THREE from 'three';
import { ScreenPass, makeRT } from './ScreenPass.js';
import { GLSL_MATH, GLSL_CATMULL } from '../shaders/common.js';

/**
 * Temporal anti-aliasing with motion-vector reprojection, depth-dilated
 * velocity lookup, Catmull-Rom history resampling and YCoCg variance clipping.
 *
 * The jitter itself lives in PostFX (it has to be applied to the camera before
 * anything renders); this pass only consumes it. `reset()` drops the history,
 * which the capture harness calls on every teleport so screenshots are crisp
 * instead of smeared.
 */

const TAA_FRAG = /* glsl */`
precision highp float;
${GLSL_MATH}
${GLSL_CATMULL}

uniform sampler2D tCurrent;
uniform sampler2D tHistory;
uniform sampler2D tVelocity;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform vec2 uResolution;
uniform float uReset;
uniform float uFeedbackMin;
uniform float uFeedbackMax;
uniform float uVarianceGamma;
uniform float uSharpness;

varying vec2 vUv;

// Dilate the motion vector towards the closest surface in a 3x3 cross: silhouettes
// keep the foreground object's velocity instead of averaging with the background.
vec2 dilatedVelocity( vec2 uv, out float closestDepth ) {
  float bestZ = 1.0;
  vec2 bestUv = uv;
  for ( int y = -1; y <= 1; y++ ) {
    for ( int x = -1; x <= 1; x++ ) {
      vec2 o = vec2( float( x ), float( y ) ) * uTexel;
      float z = texture2D( tDepth, uv + o ).x;
      if ( z < bestZ ) { bestZ = z; bestUv = uv + o; }
    }
  }
  closestDepth = bestZ;
  return texture2D( tVelocity, bestUv ).xy;
}

vec3 clipToAABB( vec3 history, vec3 minC, vec3 maxC ) {
  vec3 center = 0.5 * ( maxC + minC );
  vec3 extent = 0.5 * ( maxC - minC ) + 1e-5;
  vec3 v = history - center;
  vec3 unit = v / extent;
  vec3 a = abs( unit );
  float ma = max( a.x, max( a.y, a.z ) );
  return ma > 1.0 ? center + v / ma : history;
}

void main() {
  vec4 current = texture2D( tCurrent, vUv );

  if ( uReset > 0.5 ) { gl_FragColor = current; return; }

  float closestDepth;
  vec2 velocity = dilatedVelocity( vUv, closestDepth );
  vec2 prevUv = vUv - velocity;

  vec4 history = fxCatmullRom( tHistory, prevUv, uResolution );
  history.rgb = fxSafe( history.rgb );

  // --- neighbourhood statistics in a tonemapped YCoCg space ----------------
  vec3 m1 = vec3( 0.0 ), m2 = vec3( 0.0 );
  vec3 nmin = vec3( 1e9 ), nmax = vec3( -1e9 );
  vec3 centerY = vec3( 0.0 );

  for ( int y = -1; y <= 1; y++ ) {
    for ( int x = -1; x <= 1; x++ ) {
      vec2 o = vec2( float( x ), float( y ) ) * uTexel;
      vec3 c = fxRGBToYCoCg( fxTonemapW( fxSafe( texture2D( tCurrent, vUv + o ).rgb ) ) );
      m1 += c;
      m2 += c * c;
      nmin = min( nmin, c );
      nmax = max( nmax, c );
      if ( x == 0 && y == 0 ) centerY = c;
    }
  }

  vec3 mean = m1 / 9.0;
  vec3 sigma = sqrt( max( vec3( 0.0 ), m2 / 9.0 - mean * mean ) );
  vec3 minC = max( nmin, mean - uVarianceGamma * sigma );
  vec3 maxC = min( nmax, mean + uVarianceGamma * sigma );

  vec3 histY = fxRGBToYCoCg( fxTonemapW( history.rgb ) );
  vec3 clipped = clipToAABB( histY, minC, maxC );

  // --- feedback weight ------------------------------------------------------
  float offScreen = any( lessThan( prevUv, vec2( 0.0 ) ) ) || any( greaterThan( prevUv, vec2( 1.0 ) ) ) ? 1.0 : 0.0;
  float velLen = length( velocity * uResolution );
  float motion = fxSat( velLen / 24.0 );

  // How far the history had to be pulled tells us how wrong it was.
  float rejection = fxSat( length( clipped - histY ) * 6.0 );

  float feedback = mix( uFeedbackMax, uFeedbackMin, max( motion, rejection ) );
  feedback *= 1.0 - offScreen;

  // The viewmodel is composited before TAA and carries no motion vectors; give
  // it a shorter history so weapon sway does not ghost across the screen.
  feedback = mix( feedback, min( feedback, 0.72 ), fxSat( current.a ) );

  vec3 resolvedY = mix( centerY, clipped, feedback );
  vec3 resolved = fxTonemapWInv( fxYCoCgToRGB( resolvedY ) );

  // Light temporal sharpen: TAA's box resolve loses a touch of acutance and
  // this recovers it without the ringing a post sharpen would add.
  if ( uSharpness > 0.0 ) {
    vec3 blur = vec3( 0.0 );
    blur += fxSafe( texture2D( tCurrent, vUv + vec2( uTexel.x, 0.0 ) ).rgb );
    blur += fxSafe( texture2D( tCurrent, vUv - vec2( uTexel.x, 0.0 ) ).rgb );
    blur += fxSafe( texture2D( tCurrent, vUv + vec2( 0.0, uTexel.y ) ).rgb );
    blur += fxSafe( texture2D( tCurrent, vUv - vec2( 0.0, uTexel.y ) ).rgb );
    blur *= 0.25;
    resolved += ( fxSafe( current.rgb ) - blur ) * uSharpness * ( 1.0 - motion );
  }

  gl_FragColor = vec4( max( vec3( 0.0 ), resolved ), current.a );
}
`;

/** Halton( base ) — low-discrepancy, the standard TAA jitter source. */
function halton( index, base ) {
  let f = 1, r = 0, i = index;
  while ( i > 0 ) {
    f /= base;
    r += f * ( i % base );
    i = Math.floor( i / base );
  }
  return r;
}

export class TAAPass {

  constructor( sampleCount = 16 ) {
    this.sampleCount = sampleCount;
    this.sequence = [];
    for ( let i = 1; i <= sampleCount; i++ ) {
      this.sequence.push( new THREE.Vector2( halton( i, 2 ) - 0.5, halton( i, 3 ) - 0.5 ) );
    }
    this.index = 0;
    this.needsReset = true;

    this.pass = new ScreenPass( TAA_FRAG, {
      tCurrent: { value: null },
      tHistory: { value: null },
      tVelocity: { value: null },
      tDepth: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uResolution: { value: new THREE.Vector2() },
      uReset: { value: 1 },
      uFeedbackMin: { value: 0.62 },
      uFeedbackMax: { value: 0.955 },
      uVarianceGamma: { value: 1.25 },
      uSharpness: { value: 0.14 },
    }, { name: 'taa' } );

    this.history = [ null, null ];
    this._ping = 0;
  }

  setSize( w, h ) {
    for ( let i = 0; i < 2; i++ ) {
      this.history[ i ]?.dispose();
      this.history[ i ] = makeRT( w, h, { name: `taaHistory${i}` } );
    }
    this.pass.uniforms.uTexel.value.set( 1 / w, 1 / h );
    this.pass.uniforms.uResolution.value.set( w, h );
    this.needsReset = true;
  }

  reset() { this.needsReset = true; }

  /** Sub-pixel offset for the current frame, in pixels. */
  jitter( out, spread = 1.0 ) {
    const s = this.sequence[ this.index % this.sequence.length ];
    out.set( s.x * spread, s.y * spread );
    return out;
  }

  advance() { this.index = ( this.index + 1 ) % this.sequence.length; }

  /**
   * @returns {THREE.WebGLRenderTarget} the resolved frame (also the new history)
   */
  render( renderer, colorTexture, velocityTexture, depthTexture ) {
    const dst = this.history[ this._ping ];
    const src = this.history[ this._ping ^ 1 ];

    const u = this.pass.uniforms;
    u.tCurrent.value = colorTexture;
    u.tHistory.value = src.texture;
    u.tVelocity.value = velocityTexture;
    u.tDepth.value = depthTexture;
    u.uReset.value = this.needsReset ? 1 : 0;

    this.pass.render( renderer, dst );

    this.needsReset = false;
    this._ping ^= 1;
    return dst;
  }

  dispose() {
    this.pass.dispose();
    this.history[ 0 ]?.dispose();
    this.history[ 1 ]?.dispose();
  }

}
