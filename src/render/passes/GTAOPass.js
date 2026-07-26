import * as THREE from 'three';
import { ScreenPass, makeRT } from './ScreenPass.js';
import { GLSL_MATH, GLSL_DEPTH, GLSL_BLUENOISE } from '../shaders/common.js';

/**
 * Ground-Truth Ambient Occlusion (Jimenez et al., SIGGRAPH 2016).
 *
 * Horizon-based slice integration with the correct cosine-weighted arc
 * integral — not a hemisphere point-sampling estimator like SAO/SSAO, which
 * is why contact darkening here has the right falloff instead of the flat
 * "dirty" ring those produce. Runs at half resolution, blue-noise randomised
 * per pixel and per frame so TAA integrates the remaining noise away, then a
 * depth+normal aware bilateral blur and a bilateral upsample.
 *
 * Application is multi-bounce (Jimenez's GTAOMultiBounce) and weighted towards
 * *indirect* light only: surfaces facing the key light keep their direct
 * contribution instead of being uniformly muddied.
 */

const AO_COMPUTE = /* glsl */`
precision highp float;
${GLSL_MATH}
${GLSL_DEPTH}
${GLSL_BLUENOISE}

uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform vec2 uResolution;   // AO resolution
uniform vec2 uTexel;        // 1 / AO resolution
uniform float uRadius;      // world units
uniform float uThickness;
uniform float uProjScale;   // pixels per world unit at 1 unit depth
uniform float uDistanceFade;
uniform float uPlaneBias;

varying vec2 vUv;

#ifndef AO_SLICES
#define AO_SLICES 3
#endif
#ifndef AO_STEPS
#define AO_STEPS 6
#endif

// Marches one side of a slice and returns the maximum horizon cosine found.
float scanHorizon( vec3 P, vec3 N, vec3 V, vec2 omega, float sideSign, float radiusPixels, float stepNoise ) {
  // Depth buffers quantise, so a large flat surface reconstructs as a shallow
  // staircase. Without a tangent-plane bias GTAO reads every step edge as an
  // occluder and paints concentric bands across the floor.
  float planeBias = uPlaneBias * max( 0.4, -P.z );
  float cHorizon = -1.0;
  for ( int st = 0; st < AO_STEPS; st++ ) {
    float t = ( float( st ) + stepNoise ) / float( AO_STEPS );
    // Mild power bias: pure t^2 clusters everything at the contact point and
    // leaves the outer radius sampled once, which reads as concentric bands on
    // a large flat surface. 1.5 keeps contact detail without the ringing.
    t = t * sqrt( t );
    vec2 sUv = vUv + sideSign * t * radiusPixels * omega * uTexel;
    if ( sUv.x < 0.0 || sUv.y < 0.0 || sUv.x > 1.0 || sUv.y > 1.0 ) break;

    float sRaw = texture2D( tDepth, sUv ).x;
    if ( sRaw >= 0.9999 ) continue;

    vec3 sP = fxViewPos( sUv, sRaw );
    vec3 ds = sP - P;
    float dl = length( ds );
    if ( dl < 1e-4 ) continue;
    if ( dot( ds, N ) < planeBias ) continue;

    float cosH = dot( ds, V ) / dl;
    // Thin-object heuristic: past the radius a sample stops occluding, so a
    // distant wall behind a railing does not swallow the whole hemisphere.
    float falloff = fxSat( ( dl - uRadius * 0.6 ) / max( 1e-3, uRadius * uThickness ) );
    cosH = mix( cosH, cHorizon, falloff );
    cHorizon = max( cHorizon, cosH );
  }
  return cHorizon;
}

void main() {
  float raw = texture2D( tDepth, vUv ).x;
  if ( raw >= 0.9999 ) { gl_FragColor = vec4( 1.0, 1e4, 0.0, 1.0 ); return; }

  vec3 P = fxViewPos( vUv, raw );
  float viewDist = -P.z;
  vec4 nr = texture2D( tNormal, vUv );
  vec3 N = normalize( nr.xyz );
  vec3 V = normalize( -P );

  vec2 frag = vUv * uResolution;
  vec4 noise = fxBlueNoise4( frag );
  float dirNoise = fract( noise.x + uNoiseParams.z );
  float stepNoise = fract( noise.y + uNoiseParams.z * 1.6180339887 );

  // Screen-space radius of the world-space sampling sphere.
  float radiusPixels = uRadius * uProjScale / max( 0.35, viewDist );
  radiusPixels = min( radiusPixels, uResolution.x * 0.11 );
  if ( radiusPixels < 1.2 ) { gl_FragColor = vec4( 1.0, viewDist, 0.0, 1.0 ); return; }

  float visibility = 0.0;
  const float sliceStep = FX_PI / float( AO_SLICES );

  for ( int s = 0; s < AO_SLICES; s++ ) {
    float phi = ( float( s ) + dirNoise ) * sliceStep;
    vec2 omega = vec2( cos( phi ), sin( phi ) );
    vec3 dirV = vec3( omega, 0.0 );

    vec3 orthoDir = dirV - dot( dirV, V ) * V;
    vec3 axis = cross( dirV, V );
    vec3 projN = N - axis * dot( N, axis );
    float projNLen = length( projN );
    if ( projNLen < 1e-4 ) continue;

    float cosN = clamp( dot( projN, V ) / projNLen, -1.0, 1.0 );
    float n = sign( dot( orthoDir, projN ) ) * acos( cosN );

    // Decorrelate the step offset per slice, otherwise every slice samples the
    // same radii and their horizons quantise together into visible rings.
    float sliceNoise = fract( stepNoise + float( s ) * 0.6180339887 );
    float cNeg = scanHorizon( P, N, V, omega, -1.0, radiusPixels, sliceNoise );
    float cPos = scanHorizon( P, N, V, omega,  1.0, radiusPixels, fract( sliceNoise + 0.5 ) );

    float h0 = n + max( -acos( clamp( cNeg, -1.0, 1.0 ) ) - n, -0.5 * FX_PI );
    float h1 = n + min(  acos( clamp( cPos, -1.0, 1.0 ) ) - n,  0.5 * FX_PI );

    // Cosine-weighted arc integral over the visible horizon span.
    float inner = ( -cos( 2.0 * h0 - n ) + cos( n ) + 2.0 * h0 * sin( n ) )
                + ( -cos( 2.0 * h1 - n ) + cos( n ) + 2.0 * h1 * sin( n ) );
    visibility += projNLen * 0.25 * inner;
  }

  visibility /= float( AO_SLICES );
  visibility = fxSat( visibility );

  // Fade out with distance: at 120 m the half-res radius is sub-pixel anyway.
  visibility = mix( visibility, 1.0, fxSat( viewDist / uDistanceFade ) );

  gl_FragColor = vec4( visibility, viewDist, 0.0, 1.0 );
}
`;

const AO_BLUR = /* glsl */`
precision highp float;
${GLSL_MATH}

uniform sampler2D tAO;
uniform vec2 uDirection;   // texel-sized step
uniform float uDepthSigma;
varying vec2 vUv;

void main() {
  vec2 center = texture2D( tAO, vUv ).xy;
  float centerDepth = center.y;
  if ( centerDepth > 9000.0 ) { gl_FragColor = vec4( center, 0.0, 1.0 ); return; }

  const float weights[ 4 ] = float[ 4 ]( 0.2911, 0.2360, 0.1259, 0.0442 );

  // Tolerance scales with distance: at 80 m a 0.3 m depth step is the same
  // surface, at 1 m it is a different object.
  float sigma = uDepthSigma * ( 0.35 + centerDepth * 0.055 );
  float inv2s2 = 1.0 / ( 2.0 * sigma * sigma );

  float sum = center.x * weights[ 0 ];
  float wsum = weights[ 0 ];

  for ( int i = 1; i < 4; i++ ) {
    float fi = float( i );
    for ( int s = 0; s < 2; s++ ) {
      vec2 uv = vUv + uDirection * fi * ( s == 0 ? 1.0 : -1.0 );
      vec2 t = texture2D( tAO, uv ).xy;
      float dz = t.y - centerDepth;
      float w = weights[ i ] * exp( -dz * dz * inv2s2 );
      sum += t.x * w;
      wsum += w;
    }
  }

  gl_FragColor = vec4( sum / max( 1e-4, wsum ), centerDepth, 0.0, 1.0 );
}
`;

const AO_APPLY = /* glsl */`
precision highp float;
${GLSL_MATH}
${GLSL_DEPTH}

uniform sampler2D tScene;
uniform sampler2D tAO;
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform vec2 uAOTexel;
uniform float uIntensity;
uniform float uPower;
uniform vec3 uSunDirView;
uniform float uDirectBias;
varying vec2 vUv;

// Jimenez 2016 — approximates the extra light an occluded point still receives
// after bouncing off its own albedo. Keeps AO from reading as grey paint.
vec3 multiBounce( float ao, vec3 albedo ) {
  vec3 a =  2.0404 * albedo - 0.3324;
  vec3 b = -4.7951 * albedo + 0.6417;
  vec3 c =  2.7552 * albedo + 0.6903;
  return max( vec3( ao ), ( ( ao * a + b ) * ao + c ) * ao );
}

void main() {
  vec4 scene = texture2D( tScene, vUv );
  float raw = texture2D( tDepth, vUv ).x;
  if ( raw >= 0.9999 ) { gl_FragColor = scene; return; }

  float centerDepth = fxLinearDepth( raw );

  // Depth-aware bilateral upsample from the half-res AO buffer.
  float sum = 0.0, wsum = 0.0;
  for ( int y = 0; y < 2; y++ ) {
    for ( int x = 0; x < 2; x++ ) {
      vec2 uv = vUv + ( vec2( float( x ), float( y ) ) - 0.5 ) * uAOTexel;
      vec2 t = texture2D( tAO, uv ).xy;
      float w = 1.0 / ( 1e-3 + abs( t.y - centerDepth ) * 4.0 );
      sum += t.x * w;
      wsum += w;
    }
  }
  float ao = fxSat( sum / max( 1e-4, wsum ) );
  ao = pow( ao, uPower );

  vec3 N = normalize( texture2D( tNormal, vUv ).xyz );

  // Only occlude what the sun is *not* already lighting: real GTAO multiplies
  // the indirect/ambient term, and dimming direct sunlight is the classic
  // "everything looks like it is under a tarpaulin" mistake.
  float ndl = fxSat( dot( N, uSunDirView ) );
  float indirect = mix( 1.0, 1.0 - ndl, uDirectBias );

  float applied = mix( 1.0, ao, fxSat( uIntensity * indirect ) );

  vec3 albedo = fxSat( scene.rgb / ( 1.0 + fxMax3( scene.rgb ) ) );
  gl_FragColor = vec4( scene.rgb * multiBounce( applied, albedo ), scene.a );
}
`;

export class GTAOPass {

  constructor() {
    this.compute = new ScreenPass( AO_COMPUTE, {
      tDepth: { value: null },
      tNormal: { value: null },
      tBlueNoise: { value: null },
      uNoiseParams: { value: new THREE.Vector4( 1 / 64, 0, 0, 0 ) },
      uResolution: { value: new THREE.Vector2() },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 1.15 },
      uThickness: { value: 0.9 },
      uProjScale: { value: 500 },
      uDistanceFade: { value: 90 },
      uPlaneBias: { value: 0.006 },
      uInvProjection: { value: new THREE.Matrix4() },
      uProjection: { value: new THREE.Matrix4() },
      uProjParams: { value: new THREE.Vector4( 0.05, 2200, 20, 1 / 2200 ) },
    }, { name: 'gtao', defines: { AO_SLICES: 3, AO_STEPS: 6 } } );

    this.blur = new ScreenPass( AO_BLUR, {
      tAO: { value: null },
      uDirection: { value: new THREE.Vector2() },
      uDepthSigma: { value: 0.9 },
    }, { name: 'gtaoBlur' } );

    this.apply = new ScreenPass( AO_APPLY, {
      tScene: { value: null },
      tAO: { value: null },
      tDepth: { value: null },
      tNormal: { value: null },
      uAOTexel: { value: new THREE.Vector2() },
      uIntensity: { value: 1.0 },
      uPower: { value: 1.35 },
      uSunDirView: { value: new THREE.Vector3( 0, 1, 0 ) },
      uDirectBias: { value: 0.4 },
      uInvProjection: { value: new THREE.Matrix4() },
      uProjection: { value: new THREE.Matrix4() },
      uProjParams: { value: new THREE.Vector4( 0.05, 2200, 20, 1 / 2200 ) },
    }, { name: 'gtaoApply' } );

    this.rtA = null;
    this.rtB = null;
    this.width = 1;
    this.height = 1;
  }

  setQuality( slices, steps ) {
    this.compute.define( 'AO_SLICES', slices );
    this.compute.define( 'AO_STEPS', steps );
  }

  setSize( w, h ) {
    this.width = Math.max( 1, w );
    this.height = Math.max( 1, h );
    this.rtA?.dispose();
    this.rtB?.dispose();
    const opts = { name: 'ao', format: THREE.RGBAFormat, type: THREE.HalfFloatType };
    this.rtA = makeRT( this.width, this.height, opts );
    this.rtB = makeRT( this.width, this.height, opts );
    this.compute.uniforms.uResolution.value.set( this.width, this.height );
    this.compute.uniforms.uTexel.value.set( 1 / this.width, 1 / this.height );
    this.apply.uniforms.uAOTexel.value.set( 1 / this.width, 1 / this.height );
  }

  /** @returns {THREE.WebGLRenderTarget} blurred AO (r = visibility, g = view depth) */
  computeAO( renderer ) {
    this.compute.render( renderer, this.rtA );

    const u = this.blur.uniforms;
    u.tAO.value = this.rtA.texture;
    u.uDirection.value.set( 1 / this.width, 0 );
    this.blur.render( renderer, this.rtB );

    u.tAO.value = this.rtB.texture;
    u.uDirection.value.set( 0, 1 / this.height );
    this.blur.render( renderer, this.rtA );

    return this.rtA;
  }

  dispose() {
    this.compute.dispose();
    this.blur.dispose();
    this.apply.dispose();
    this.rtA?.dispose();
    this.rtB?.dispose();
  }

}
