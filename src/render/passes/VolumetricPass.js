import * as THREE from 'three';
import { ScreenPass, makeRT } from './ScreenPass.js';
import { GLSL_MATH, GLSL_DEPTH, GLSL_BLUENOISE } from '../shaders/common.js';

/**
 * Volumetric light scattering — a real raymarch of the participating medium
 * against the sun's shadow map, not a radial screen blur.
 *
 * Marches world space from the eye to the depth buffer at quarter resolution
 * with a blue-noise start offset (banding in a god ray is the single most
 * obvious cheat there is), Henyey-Greenstein phase towards the sun and
 * exponential height fog. The shadow lookup understands both plain depth maps
 * and three's VSM moments, so soft shafts come out soft.
 */

const VOL_COMPUTE = /* glsl */`
precision highp float;
${GLSL_MATH}
${GLSL_DEPTH}
${GLSL_BLUENOISE}

uniform sampler2D tDepth;
uniform sampler2D tShadow;
uniform mat4 uShadowMatrix;
uniform mat4 uInvViewProj;
uniform vec3 uCameraPos;
uniform vec3 uSunDir;        // world space, pointing *towards* the sun
uniform vec3 uSunColor;      // pre-multiplied by intensity
uniform vec2 uResolution;
uniform float uHasShadow;
uniform float uIsVSM;
uniform float uShadowBias;
uniform float uDensity;
uniform float uHeightBase;
uniform float uHeightFalloff;
uniform float uAnisotropy;
uniform float uMaxDistance;
uniform float uIntensity;

varying vec2 vUv;

#ifndef VOL_STEPS
#define VOL_STEPS 32
#endif

float henyeyGreenstein( float cosTheta, float g ) {
  float g2 = g * g;
  float d = 1.0 + g2 - 2.0 * g * cosTheta;
  return ( 1.0 - g2 ) / ( 4.0 * FX_PI * max( 1e-4, d * sqrt( max( 1e-4, d ) ) ) );
}

float shadowVisibility( vec3 worldPos ) {
  if ( uHasShadow < 0.5 ) return 1.0;
  vec4 sc = uShadowMatrix * vec4( worldPos, 1.0 );
  sc.xyz /= max( 1e-6, sc.w );
  if ( sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0 || sc.z < 0.0 ) return 1.0;

  vec2 moments = texture2D( tShadow, sc.xy ).xy;
  float d = sc.z - uShadowBias - moments.x;
  if ( d <= 0.0 ) return 1.0;

  // VSM: Chebyshev upper bound gives the soft penumbra for free.
  float sd = max( moments.y, 2e-4 );
  float cheb = clamp( ( sd * sd ) / ( sd * sd + d * d ), 0.0, 1.0 );
  return mix( 0.0, cheb, uIsVSM );
}

void main() {
  float raw = texture2D( tDepth, vUv ).x;

  vec4 ndc = vec4( vUv * 2.0 - 1.0, raw * 2.0 - 1.0, 1.0 );
  vec4 wp = uInvViewProj * ndc;
  vec3 worldEnd = wp.xyz / wp.w;

  vec3 toEnd = worldEnd - uCameraPos;
  float dist = length( toEnd );
  vec3 dir = dist > 1e-4 ? toEnd / dist : vec3( 0.0, 0.0, -1.0 );
  dist = min( dist, uMaxDistance );

  float stepLen = dist / float( VOL_STEPS );
  float jitter = fxBlueNoise( vUv * uResolution, 2.0 );

  float cosTheta = dot( dir, uSunDir );
  float phase = henyeyGreenstein( cosTheta, uAnisotropy );

  vec3 scattered = vec3( 0.0 );
  float transmittance = 1.0;

  for ( int i = 0; i < VOL_STEPS; i++ ) {
    float t = ( float( i ) + jitter ) * stepLen;
    vec3 p = uCameraPos + dir * t;

    float h = exp( -max( 0.0, p.y - uHeightBase ) * uHeightFalloff );
    float density = uDensity * h;
    if ( density < 1e-6 ) continue;

    float vis = shadowVisibility( p );
    float sigma = density * stepLen;

    // Energy-conserving analytic integration over the segment.
    float attenuated = transmittance * ( 1.0 - exp( -sigma ) );
    scattered += uSunColor * phase * vis * attenuated;
    transmittance *= exp( -sigma );
    if ( transmittance < 0.01 ) break;
  }

  gl_FragColor = vec4( scattered * uIntensity, transmittance );
}
`;

const VOL_APPLY = /* glsl */`
precision highp float;
${GLSL_MATH}
${GLSL_DEPTH}

uniform sampler2D tScene;
uniform sampler2D tVolume;
uniform sampler2D tDepth;
uniform vec2 uVolTexel;
varying vec2 vUv;

void main() {
  vec4 scene = texture2D( tScene, vUv );
  float centerDepth = fxLinearDepth( texture2D( tDepth, vUv ).x );

  vec4 sum = vec4( 0.0 );
  float wsum = 0.0;
  for ( int y = 0; y < 2; y++ ) {
    for ( int x = 0; x < 2; x++ ) {
      vec2 uv = vUv + ( vec2( float( x ), float( y ) ) - 0.5 ) * uVolTexel;
      vec4 v = texture2D( tVolume, uv );
      float d = fxLinearDepth( texture2D( tDepth, uv ).x );
      float w = 1.0 / ( 1e-2 + abs( d - centerDepth ) * 0.6 );
      sum += v * w;
      wsum += w;
    }
  }
  vec4 vol = sum / max( 1e-4, wsum );

  gl_FragColor = vec4( scene.rgb + max( vec3( 0.0 ), vol.rgb ), scene.a );
}
`;

export class VolumetricPass {

  constructor() {
    this.compute = new ScreenPass( VOL_COMPUTE, {
      tDepth: { value: null },
      tShadow: { value: null },
      tBlueNoise: { value: null },
      uNoiseParams: { value: new THREE.Vector4( 1 / 64, 0, 0, 0 ) },
      uShadowMatrix: { value: new THREE.Matrix4() },
      uInvViewProj: { value: new THREE.Matrix4() },
      uCameraPos: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3( 0, 1, 0 ) },
      uSunColor: { value: new THREE.Vector3( 1, 0.95, 0.86 ) },
      uResolution: { value: new THREE.Vector2() },
      uHasShadow: { value: 0 },
      uIsVSM: { value: 1 },
      uShadowBias: { value: 0.0016 },
      uDensity: { value: 0.024 },
      uHeightBase: { value: 0 },
      uHeightFalloff: { value: 0.055 },
      uAnisotropy: { value: 0.74 },
      uMaxDistance: { value: 170 },
      uIntensity: { value: 1 },
      uInvProjection: { value: new THREE.Matrix4() },
      uProjection: { value: new THREE.Matrix4() },
      uProjParams: { value: new THREE.Vector4( 0.05, 2200, 20, 1 / 2200 ) },
    }, { name: 'volumetric', defines: { VOL_STEPS: 32 } } );

    this.apply = new ScreenPass( VOL_APPLY, {
      tScene: { value: null },
      tVolume: { value: null },
      tDepth: { value: null },
      uVolTexel: { value: new THREE.Vector2() },
      uInvProjection: { value: new THREE.Matrix4() },
      uProjection: { value: new THREE.Matrix4() },
      uProjParams: { value: new THREE.Vector4( 0.05, 2200, 20, 1 / 2200 ) },
    }, { name: 'volumetricApply' } );

    this.rt = null;
  }

  setQuality( steps ) { this.compute.define( 'VOL_STEPS', steps ); }

  setSize( w, h ) {
    this.rt?.dispose();
    this.rt = makeRT( w, h, { name: 'volumetric' } );
    this.compute.uniforms.uResolution.value.set( w, h );
    this.apply.uniforms.uVolTexel.value.set( 1 / w, 1 / h );
  }

  dispose() {
    this.compute.dispose();
    this.apply.dispose();
    this.rt?.dispose();
  }

}
