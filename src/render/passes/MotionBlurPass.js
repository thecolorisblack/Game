import * as THREE from 'three';
import { ScreenPass, makeRT } from './ScreenPass.js';
import { GLSL_MATH, GLSL_DEPTH, GLSL_BLUENOISE } from '../shaders/common.js';

/**
 * Velocity-buffer motion blur — McGuire et al. 2012 reconstruction filter.
 *
 * Tile-max / neighbour-max pyramid finds the dominant motion in each 16x16
 * tile so a fast object smears *outside* its own silhouette (the thing that
 * separates real motion blur from a directional blur applied per pixel), and
 * the depth-aware foreground/background classification stops a sprinting enemy
 * from dragging the wall behind him along.
 *
 * Because the velocity buffer contains per-object motion as well as camera
 * motion, this covers both. The viewmodel is excluded via the alpha mask: a
 * blurred weapon during a fast turn reads as a broken frame, not as cinema.
 */

const TILE_MAX = /* glsl */`
precision highp float;
uniform sampler2D tVelocity;
uniform vec2 uTexel;
uniform float uScale;     // how many source texels per output texel
varying vec2 vUv;

void main() {
  vec2 best = vec2( 0.0 );
  float bestLen = -1.0;
  int n = int( uScale );
  for ( int y = 0; y < 8; y++ ) {
    if ( y >= n ) break;
    for ( int x = 0; x < 8; x++ ) {
      if ( x >= n ) break;
      vec2 uv = vUv + ( vec2( float( x ), float( y ) ) - uScale * 0.5 + 0.5 ) * uTexel;
      vec2 v = texture2D( tVelocity, uv ).xy;
      float l = dot( v, v );
      if ( l > bestLen ) { bestLen = l; best = v; }
    }
  }
  gl_FragColor = vec4( best, 0.0, 1.0 );
}
`;

const NEIGHBOR_MAX = /* glsl */`
precision highp float;
uniform sampler2D tTile;
uniform vec2 uTexel;
varying vec2 vUv;

void main() {
  vec2 best = vec2( 0.0 );
  float bestLen = -1.0;
  for ( int y = -1; y <= 1; y++ ) {
    for ( int x = -1; x <= 1; x++ ) {
      vec2 v = texture2D( tTile, vUv + vec2( float( x ), float( y ) ) * uTexel ).xy;
      float l = dot( v, v );
      if ( l > bestLen ) { bestLen = l; best = v; }
    }
  }
  gl_FragColor = vec4( best, 0.0, 1.0 );
}
`;

const RECONSTRUCT = /* glsl */`
precision highp float;
${GLSL_MATH}
${GLSL_DEPTH}
${GLSL_BLUENOISE}

uniform sampler2D tScene;
uniform sampler2D tVelocity;
uniform sampler2D tNeighborMax;
uniform sampler2D tDepth;
uniform vec2 uResolution;
uniform vec2 uTexel;
uniform float uStrength;
uniform float uMaxRadius;   // pixels
varying vec2 vUv;

#ifndef MB_TAPS
#define MB_TAPS 13
#endif

float softDepthCompare( float za, float zb ) {
  return fxSat( 1.0 - ( za - zb ) / 0.35 );
}
float cone( float dist, float len ) {
  return fxSat( 1.0 - dist / max( 1e-4, len ) );
}
float cylinder( float dist, float len ) {
  return 1.0 - smoothstep( 0.95 * len, 1.05 * len, dist );
}

void main() {
  vec4 scene = texture2D( tScene, vUv );

  vec2 nMax = texture2D( tNeighborMax, vUv ).xy * uStrength;
  vec2 nMaxPx = nMax * uResolution;
  float nMaxLen = length( nMaxPx );

  if ( nMaxLen < 1.0 || scene.a > 0.5 ) { gl_FragColor = scene; return; }

  if ( nMaxLen > uMaxRadius ) { nMax *= uMaxRadius / nMaxLen; nMaxLen = uMaxRadius; }

  vec2 vCenter = texture2D( tVelocity, vUv ).xy * uStrength;
  float vCenterLen = max( 0.5, length( vCenter * uResolution ) );
  float zCenter = fxLinearDepth( texture2D( tDepth, vUv ).x );

  float jitter = fxBlueNoise( vUv * uResolution, 1.0 ) - 0.5;

  vec3 sum = scene.rgb * ( 1.0 / float( MB_TAPS ) );
  float wsum = 1.0 / float( MB_TAPS );

  for ( int i = 0; i < MB_TAPS; i++ ) {
    if ( i == ( MB_TAPS / 2 ) ) continue;

    float t = mix( -1.0, 1.0, ( float( i ) + jitter + 0.5 ) / float( MB_TAPS ) );
    vec2 offset = nMax * t * 0.5;
    vec2 uv = vUv + offset;
    if ( uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0 ) continue;

    float distPx = length( offset * uResolution );

    float zSample = fxLinearDepth( texture2D( tDepth, uv ).x );
    vec2 vSample = texture2D( tVelocity, uv ).xy * uStrength;
    float vSampleLen = max( 0.5, length( vSample * uResolution ) );

    float fg = softDepthCompare( zCenter, zSample );   // sample is in front
    float bg = softDepthCompare( zSample, zCenter );   // sample is behind

    float w = fg * cone( distPx, vSampleLen )
            + bg * cone( distPx, vCenterLen )
            + cylinder( distPx, vSampleLen ) * cylinder( distPx, vCenterLen ) * 2.0;

    vec4 s = texture2D( tScene, uv );
    w *= 1.0 - s.a;   // never drag the viewmodel into the world blur

    sum += fxSafe( s.rgb ) * w;
    wsum += w;
  }

  gl_FragColor = vec4( sum / max( 1e-4, wsum ), scene.a );
}
`;

export class MotionBlurPass {

  constructor() {
    this.tile = new ScreenPass( TILE_MAX, {
      tVelocity: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uScale: { value: 4 },
    }, { name: 'mbTile' } );

    this.neighbor = new ScreenPass( NEIGHBOR_MAX, {
      tTile: { value: null },
      uTexel: { value: new THREE.Vector2() },
    }, { name: 'mbNeighbor' } );

    this.reconstruct = new ScreenPass( RECONSTRUCT, {
      tScene: { value: null },
      tVelocity: { value: null },
      tNeighborMax: { value: null },
      tDepth: { value: null },
      tBlueNoise: { value: null },
      uNoiseParams: { value: new THREE.Vector4( 1 / 64, 0, 0, 0 ) },
      uResolution: { value: new THREE.Vector2() },
      uTexel: { value: new THREE.Vector2() },
      uStrength: { value: 0.5 },
      uMaxRadius: { value: 48 },
      uInvProjection: { value: new THREE.Matrix4() },
      uProjection: { value: new THREE.Matrix4() },
      uProjParams: { value: new THREE.Vector4( 0.05, 2200, 20, 1 / 2200 ) },
    }, { name: 'mbReconstruct', defines: { MB_TAPS: 13 } } );

    this.tileA = null;
    this.tileB = null;
    this.tileC = null;
    this.tileSize = 16;
  }

  setQuality( taps ) { this.reconstruct.define( 'MB_TAPS', taps ); }

  setSize( w, h ) {
    const opts = { name: 'mbTile' };
    const w1 = Math.max( 1, Math.ceil( w / 4 ) );
    const h1 = Math.max( 1, Math.ceil( h / 4 ) );
    const w2 = Math.max( 1, Math.ceil( w1 / 4 ) );
    const h2 = Math.max( 1, Math.ceil( h1 / 4 ) );

    this.tileA?.dispose();
    this.tileB?.dispose();
    this.tileC?.dispose();
    this.tileA = makeRT( w1, h1, opts );
    this.tileB = makeRT( w2, h2, opts );
    this.tileC = makeRT( w2, h2, opts );

    this.reconstruct.uniforms.uResolution.value.set( w, h );
    this.reconstruct.uniforms.uTexel.value.set( 1 / w, 1 / h );
    this._srcTexel = new THREE.Vector2( 1 / w, 1 / h );
    this._midTexel = new THREE.Vector2( 1 / w1, 1 / h1 );
    this._tileTexel = new THREE.Vector2( 1 / w2, 1 / h2 );
  }

  /** Builds tileMax -> tileMax -> neighbourMax and returns the neighbour target. */
  buildTiles( renderer, velocityTexture ) {
    const t = this.tile.uniforms;
    t.tVelocity.value = velocityTexture;
    t.uTexel.value.copy( this._srcTexel );
    t.uScale.value = 4;
    this.tile.render( renderer, this.tileA );

    t.tVelocity.value = this.tileA.texture;
    t.uTexel.value.copy( this._midTexel );
    this.tile.render( renderer, this.tileB );

    this.neighbor.uniforms.tTile.value = this.tileB.texture;
    this.neighbor.uniforms.uTexel.value.copy( this._tileTexel );
    this.neighbor.render( renderer, this.tileC );

    return this.tileC;
  }

  dispose() {
    this.tile.dispose();
    this.neighbor.dispose();
    this.reconstruct.dispose();
    this.tileA?.dispose();
    this.tileB?.dispose();
    this.tileC?.dispose();
  }

}
