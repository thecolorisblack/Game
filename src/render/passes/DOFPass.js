import * as THREE from 'three';
import { ScreenPass, makeRT } from './ScreenPass.js';
import { GLSL_MATH, GLSL_DEPTH, GLSL_BLUENOISE } from '../shaders/common.js';

/**
 * Depth of field with a real bokeh kernel.
 *
 * Circle-of-confusion follows the thin-lens relation (1 - focus/distance), so
 * the near field goes soft much faster than the far field exactly like a real
 * lens. The gather uses a golden-angle spiral remapped onto a *hexagonal*
 * aperture, which is what gives the highlight discs their flat-sided shape
 * instead of the mushy circles a gaussian produces.
 *
 * The viewmodel mask (alpha of the HDR buffer) forces CoC to zero, so aiming
 * down sight throws the world out of focus around a perfectly sharp weapon —
 * the whole point of ADS focus falloff.
 */

const DOF_PREPARE = /* glsl */`
precision highp float;
${GLSL_MATH}
${GLSL_DEPTH}

uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform vec2 uSrcTexel;
uniform float uFocusDistance;
uniform float uCocScale;
uniform float uNearScale;
uniform float uMaxBackground;
varying vec2 vUv;

// Thin-lens circle of confusion, normalised so the near field cannot run away.
// The raw relation (1 - focus/distance) is unbounded as distance -> 0, which is
// physically true but means anything at a quarter of the focus distance is
// completely destroyed. Compressing the negative side keeps the *shape* of the
// falloff while making hip-fire DoF a subtle depth cue rather than a smear.
float fxCoC( float dist, float focus, float scale, float nearScale ) {
  float raw = 1.0 - focus / max( 0.05, dist );
  float coc = raw >= 0.0 ? raw * scale
                         : ( raw / ( 1.0 - raw ) ) * scale * nearScale;
  return clamp( coc, -1.0, 1.0 );
}

float cocAt( vec2 uv ) {
  float raw = texture2D( tDepth, uv ).x;
  float dist = raw >= 0.9999 ? 1e5 : fxLinearDepth( raw );
  return fxCoC( dist, uFocusDistance, uCocScale, uNearScale );
}

void main() {
  // 2x2 box down to half res, keeping the most extreme CoC of the group so
  // thin near-field silhouettes do not vanish before the gather sees them.
  vec3 col = vec3( 0.0 );
  float coc = 0.0;
  float mask = 0.0;
  for ( int y = 0; y < 2; y++ ) {
    for ( int x = 0; x < 2; x++ ) {
      vec2 o = ( vec2( float( x ), float( y ) ) - 0.5 ) * uSrcTexel;
      vec4 s = texture2D( tScene, vUv + o );
      col += fxSafe( s.rgb );
      mask = max( mask, s.a );
      float c = cocAt( vUv + o );
      if ( abs( c ) > abs( coc ) ) coc = c;
    }
  }
  col *= 0.25;
  coc = mix( coc, 0.0, fxSat( mask ) );   // viewmodel is always in focus
  gl_FragColor = vec4( col, coc );
}
`;

const DOF_NEAR_DILATE = /* glsl */`
precision highp float;
${GLSL_MATH}
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform vec2 uDirection;
varying vec2 vUv;
// Near-field CoC has to grow *outwards* past the object's silhouette, otherwise
// an out-of-focus foreground gets a hard clipped edge instead of bleeding over
// the background. Separable max filter, run once per axis.
void main() {
  vec4 center = texture2D( tSrc, vUv );
  float near = max( 0.0, -center.a );
  for ( int i = 1; i <= 5; i++ ) {
    float f = float( i ) * 1.6;
    near = max( near, max( 0.0, -texture2D( tSrc, vUv + uDirection * uTexel * f ).a ) );
    near = max( near, max( 0.0, -texture2D( tSrc, vUv - uDirection * uTexel * f ).a ) );
  }
  float outCoc = near > abs( center.a ) ? -near : center.a;
  gl_FragColor = vec4( center.rgb, outCoc );
}
`;

const DOF_GATHER = /* glsl */`
precision highp float;
${GLSL_MATH}
${GLSL_BLUENOISE}

uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform vec2 uResolution;
uniform float uMaxRadius;   // in half-res pixels
uniform float uBokehBias;
varying vec2 vUv;

#ifndef DOF_TAPS
#define DOF_TAPS 40
#endif

const float GOLDEN_ANGLE = 2.39996323;

// Maps the unit circle onto a regular hexagon: r(theta) for a hexagon with
// flat-to-flat radius 1. This is the aperture blade shape.
float hexRadius( float theta ) {
  float t = mod( theta, FX_PI / 3.0 ) - FX_PI / 6.0;
  return 0.8660254 / max( 0.5, cos( t ) );
}

void main() {
  vec4 center = texture2D( tSrc, vUv );
  float centerCoc = center.a;
  float radius = abs( centerCoc ) * uMaxRadius;

  if ( radius < 0.75 ) { gl_FragColor = vec4( center.rgb, centerCoc ); return; }

  float noise = fxBlueNoise( vUv * uResolution, 3.0 );
  float angleOffset = noise * FX_TAU;

  vec3 accum = center.rgb;
  float wsum = 1.0;

  for ( int i = 0; i < DOF_TAPS; i++ ) {
    float fi = float( i ) + 0.5;
    float theta = fi * GOLDEN_ANGLE + angleOffset;
    float r = sqrt( fi / float( DOF_TAPS ) );
    // Push samples towards the rim: real bokeh is brighter at the edge of the
    // disc than in the middle (the "donut" a fast lens produces).
    r = mix( r, pow( r, 0.65 ), uBokehBias );
    vec2 dir = vec2( cos( theta ), sin( theta ) ) * hexRadius( theta );
    vec2 offset = dir * r * radius;

    vec4 s = texture2D( tSrc, vUv + offset * uTexel );
    float tapRadius = abs( s.a ) * uMaxRadius;
    float dist = length( offset );

    // A tap only bleeds onto us if its own CoC reaches this far, and a
    // background tap may never bleed over a foreground pixel.
    float w = fxSat( tapRadius - dist + 1.0 );
    if ( s.a > 0.0 && centerCoc < 0.0 ) w = 0.0;

    accum += fxSafe( s.rgb ) * w;
    wsum += w;
  }

  gl_FragColor = vec4( accum / max( 1e-4, wsum ), centerCoc );
}
`;

const DOF_COMPOSITE = /* glsl */`
precision highp float;
${GLSL_MATH}
${GLSL_DEPTH}

uniform sampler2D tScene;
uniform sampler2D tBokeh;
uniform sampler2D tDepth;
uniform vec2 uBokehTexel;
uniform float uFocusDistance;
uniform float uCocScale;
uniform float uNearScale;
uniform float uMaxBackground;
uniform float uStrength;
varying vec2 vUv;

// Thin-lens circle of confusion, normalised so the near field cannot run away.
// The raw relation (1 - focus/distance) is unbounded as distance -> 0, which is
// physically true but means anything at a quarter of the focus distance is
// completely destroyed. Compressing the negative side keeps the *shape* of the
// falloff while making hip-fire DoF a subtle depth cue rather than a smear.
float fxCoC( float dist, float focus, float scale, float nearScale ) {
  float raw = 1.0 - focus / max( 0.05, dist );
  float coc = raw >= 0.0 ? raw * scale
                         : ( raw / ( 1.0 - raw ) ) * scale * nearScale;
  return clamp( coc, -1.0, 1.0 );
}

void main() {
  vec4 scene = texture2D( tScene, vUv );

  float raw = texture2D( tDepth, vUv ).x;
  float dist = raw >= 0.9999 ? 1e5 : fxLinearDepth( raw );
  float coc = fxCoC( dist, uFocusDistance, uCocScale, uNearScale );
  coc = mix( coc, 0.0, fxSat( scene.a ) );

  // 4-tap tent upsample of the half-res bokeh buffer.
  vec3 blurred = vec3( 0.0 );
  blurred += texture2D( tBokeh, vUv + vec2( -0.5, -0.5 ) * uBokehTexel ).rgb;
  blurred += texture2D( tBokeh, vUv + vec2(  0.5, -0.5 ) * uBokehTexel ).rgb;
  blurred += texture2D( tBokeh, vUv + vec2( -0.5,  0.5 ) * uBokehTexel ).rgb;
  blurred += texture2D( tBokeh, vUv + vec2(  0.5,  0.5 ) * uBokehTexel ).rgb;
  blurred *= 0.25;

  float mixAmount = fxSat( smoothstep( 0.10, 0.58, abs( coc ) ) * uStrength );
  gl_FragColor = vec4( mix( fxSafe( scene.rgb ), blurred, mixAmount ), scene.a );
}
`;

export class DOFPass {

  constructor() {
    const projU = () => ( {
      uInvProjection: { value: new THREE.Matrix4() },
      uProjection: { value: new THREE.Matrix4() },
      uProjParams: { value: new THREE.Vector4( 0.05, 2200, 20, 1 / 2200 ) },
    } );

    this.prepare = new ScreenPass( DOF_PREPARE, {
      tScene: { value: null },
      tDepth: { value: null },
      uSrcTexel: { value: new THREE.Vector2() },
      uFocusDistance: { value: 12 },
      uCocScale: { value: 0.6 },
      uNearScale: { value: 1.8 },
      uMaxBackground: { value: 0.85 },
      ...projU(),
    }, { name: 'dofPrepare' } );

    this.dilate = new ScreenPass( DOF_NEAR_DILATE, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uDirection: { value: new THREE.Vector2( 1, 0 ) },
    }, { name: 'dofDilate' } );

    this.gather = new ScreenPass( DOF_GATHER, {
      tSrc: { value: null },
      tBlueNoise: { value: null },
      uNoiseParams: { value: new THREE.Vector4( 1 / 64, 0, 0, 0 ) },
      uTexel: { value: new THREE.Vector2() },
      uResolution: { value: new THREE.Vector2() },
      uMaxRadius: { value: 16 },
      uBokehBias: { value: 0.55 },
    }, { name: 'dofGather', defines: { DOF_TAPS: 40 } } );

    this.composite = new ScreenPass( DOF_COMPOSITE, {
      tScene: { value: null },
      tBokeh: { value: null },
      tDepth: { value: null },
      uBokehTexel: { value: new THREE.Vector2() },
      uFocusDistance: { value: 12 },
      uCocScale: { value: 0.6 },
      uNearScale: { value: 1.8 },
      uMaxBackground: { value: 0.85 },
      uStrength: { value: 1 },
      ...projU(),
    }, { name: 'dofComposite' } );

    this.rtA = null;
    this.rtB = null;
  }

  setQuality( taps ) { this.gather.define( 'DOF_TAPS', taps ); }

  setSize( w, h ) {
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.rtA = makeRT( w, h, { name: 'dofA' } );
    this.rtB = makeRT( w, h, { name: 'dofB' } );
    this.dilate.uniforms.uTexel.value.set( 1 / w, 1 / h );
    this.gather.uniforms.uTexel.value.set( 1 / w, 1 / h );
    this.gather.uniforms.uResolution.value.set( w, h );
    this.composite.uniforms.uBokehTexel.value.set( 1 / w, 1 / h );
  }

  /** Keeps the focus/CoC parameters of the prepare and composite passes in sync. */
  setFocus( focusDistance, cocScale, nearScale, maxBackground ) {
    for ( const p of [ this.prepare, this.composite ] ) {
      p.uniforms.uFocusDistance.value = focusDistance;
      p.uniforms.uCocScale.value = cocScale;
      p.uniforms.uNearScale.value = nearScale;
      p.uniforms.uMaxBackground.value = maxBackground;
    }
  }

  dispose() {
    this.prepare.dispose();
    this.dilate.dispose();
    this.gather.dispose();
    this.composite.dispose();
    this.rtA?.dispose();
    this.rtB?.dispose();
  }

}
