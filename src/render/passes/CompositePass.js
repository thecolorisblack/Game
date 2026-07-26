import * as THREE from 'three';
import { ScreenPass } from './ScreenPass.js';
import { GLSL_MATH, GLSL_TONEMAP, GLSL_LUT, GLSL_BLUENOISE } from '../shaders/common.js';

/**
 * Final image assembly, run at native resolution so grain, chromatic
 * aberration and the dither are all pixel-exact regardless of render scale.
 *
 *   HDR + bloom  ->  natural vignette (linear, cos^4)  ->  exposure
 *                ->  AgX / ACES  ->  ASC-CDL grade  ->  sRGB
 *                ->  32^3 look LUT  ->  film grain  ->  ordered dither
 *
 * Chromatic aberration samples the combined HDR three times with a radially
 * increasing offset (real lateral CA scales with the square of image height,
 * which is why the centre of frame stays clean).
 */

const COMPOSITE = /* glsl */`
precision highp float;
${GLSL_MATH}
${GLSL_TONEMAP}
${GLSL_LUT}
${GLSL_BLUENOISE}

uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tLUT;
uniform vec2 uResolution;
uniform float uExposure;
uniform float uBloomIntensity;
uniform float uChromatic;
uniform float uVignette;
uniform float uGrain;
uniform float uAspect;
uniform float uLutSize;
uniform float uLutStrength;
uniform float uAgxPunch;
uniform vec3 uLift;
uniform vec3 uGamma;
uniform vec3 uGain;
uniform float uContrast;
uniform float uSaturation;
uniform float uFlash;      // additive screen flash (flashbang / muzzle wash)
uniform vec3 uFlashColor;
uniform float uDamage;     // 0..1 hurt/near-death response

varying vec2 vUv;

#ifndef TONEMAP_MODE
#define TONEMAP_MODE 0
#endif

vec3 sampleCombined( vec2 uv ) {
  vec3 c = fxSafe( texture2D( tScene, uv ).rgb );
  #if BLOOM_ENABLED
    c += fxSafe( texture2D( tBloom, uv ).rgb ) * uBloomIntensity;
  #endif
  return c;
}

void main() {
  vec2 d = vUv - 0.5;
  float r2 = dot( d * vec2( uAspect, 1.0 ), d * vec2( uAspect, 1.0 ) );

  vec3 hdr;
  if ( uChromatic > 0.0001 ) {
    // uChromatic is in *pixels of separation at the frame corner*, so the look
    // is identical at 1080p and 4K instead of scaling with the buffer.
    vec2 off = d * r2 * ( uChromatic / uResolution );
    hdr.r = sampleCombined( vUv + off * 1.00 ).r;
    hdr.g = sampleCombined( vUv ).g;
    hdr.b = sampleCombined( vUv - off * 1.00 ).b;
  } else {
    hdr = sampleCombined( vUv );
  }

  hdr += uFlashColor * uFlash;

  // --- natural vignette, applied to *light* before the tone curve ----------
  if ( uVignette > 0.0001 ) {
    float r = length( d * vec2( uAspect, 1.0 ) ) * 1.41421356;
    float falloff = pow( cos( min( 1.35, r * 0.80 ) ), 4.0 );
    hdr *= mix( 1.0, falloff, uVignette );
  }

  hdr *= uExposure;

  // --- tone mapping ---------------------------------------------------------
  vec3 col;
  #if TONEMAP_MODE == 1
    col = tonemapACES( hdr );
  #elif TONEMAP_MODE == 2
    col = hdr / ( 1.0 + fxLuma( hdr ) );
  #else
    col = tonemapAgX( hdr, uAgxPunch );
  #endif

  // --- primary grade, still linear -----------------------------------------
  col = fxLiftGammaGain( col, uLift, uGamma, uGain );
  col = fxContrast( col, uContrast, 0.18 );
  col = fxSaturation( col, uSaturation );

  // --- display encode + creative LUT ---------------------------------------
  vec3 disp = fxLinearToSRGB( col );
  #if LUT_ENABLED
    disp = mix( disp, fxSampleLUT( tLUT, disp, uLutSize ), uLutStrength );
  #endif

  // --- film grain -----------------------------------------------------------
  if ( uGrain > 0.0001 ) {
    vec2 frag = vUv * uResolution;
    vec4 n = fxBlueNoise4( frag );
    // Two decorrelated samples -> triangular PDF, which is what real film
    // grain looks like; a single uniform sample reads as digital noise.
    vec3 g = vec3(
      fract( n.x + uNoiseParams.z ) + fract( n.z + uNoiseParams.z * 1.618034 ) - 1.0,
      fract( n.y + uNoiseParams.z * 0.7548777 ) + fract( n.w + uNoiseParams.z * 1.324718 ) - 1.0,
      fract( n.z + uNoiseParams.z * 1.220744 ) + fract( n.x + uNoiseParams.z * 0.5698403 ) - 1.0
    );
    float l = fxLuma( disp );
    // Silver-halide response: densest in the mid tones, nearly absent in the
    // clipped highlights and crushed blacks.
    float response = 1.0 - abs( l * 2.0 - 1.0 );
    response = response * response * 0.85 + 0.15;
    disp += g * ( uGrain * 0.055 * response ) * vec3( 1.0, 0.94, 1.06 );
  }

  // --- damage response ------------------------------------------------------
  // Adrenal tunnel vision: desaturate globally, bruise the periphery. Done
  // after the LUT so it reads the same under every look.
  if ( uDamage > 0.001 ) {
    float r = length( d * vec2( uAspect, 1.0 ) ) * 1.41421356;
    float edge = smoothstep( 0.30, 1.05, r ) * uDamage;
    disp = mix( disp, vec3( fxLuma( disp ) ), uDamage * 0.5 );
    disp = mix( disp, vec3( 0.32, 0.015, 0.01 ), edge * 0.75 );
  }

  // --- 8-bit ordered dither -------------------------------------------------
  float dither = ( fxBlueNoise( vUv * uResolution, 1.0 ) - 0.5 ) * ( 1.0 / 255.0 );
  gl_FragColor = vec4( clamp( disp + dither, 0.0, 1.0 ), 1.0 );
}
`;

const CAS = /* glsl */`
precision highp float;
${GLSL_MATH}
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uSharpness;
varying vec2 vUv;

// AMD FidelityFX Contrast Adaptive Sharpening — sharpens flat-contrast areas
// hard and high-contrast edges barely at all, so it never rings.
void main() {
  vec3 a = texture2D( tSrc, vUv + vec2( -uTexel.x, -uTexel.y ) ).rgb;
  vec3 b = texture2D( tSrc, vUv + vec2(  0.0,     -uTexel.y ) ).rgb;
  vec3 c = texture2D( tSrc, vUv + vec2(  uTexel.x, -uTexel.y ) ).rgb;
  vec3 dd = texture2D( tSrc, vUv + vec2( -uTexel.x, 0.0 ) ).rgb;
  vec3 e = texture2D( tSrc, vUv ).rgb;
  vec3 f = texture2D( tSrc, vUv + vec2(  uTexel.x, 0.0 ) ).rgb;
  vec3 g = texture2D( tSrc, vUv + vec2( -uTexel.x,  uTexel.y ) ).rgb;
  vec3 h = texture2D( tSrc, vUv + vec2(  0.0,      uTexel.y ) ).rgb;
  vec3 i = texture2D( tSrc, vUv + vec2(  uTexel.x,  uTexel.y ) ).rgb;

  vec3 mnRGB = min( min( min( dd, e ), min( f, b ) ), h );
  vec3 mnRGB2 = min( mnRGB, min( min( a, c ), min( g, i ) ) );
  mnRGB += mnRGB2;

  vec3 mxRGB = max( max( max( dd, e ), max( f, b ) ), h );
  vec3 mxRGB2 = max( mxRGB, max( max( a, c ), max( g, i ) ) );
  mxRGB += mxRGB2;

  vec3 rcpM = 1.0 / max( vec3( 1e-4 ), mxRGB );
  vec3 amp = clamp( min( mnRGB, 2.0 - mxRGB ) * rcpM, 0.0, 1.0 );
  amp = sqrt( amp );

  float peak = -1.0 / mix( 10.0, 5.0, clamp( uSharpness, 0.0, 1.0 ) );
  vec3 w = amp * peak;
  vec3 rcpW = 1.0 / ( 1.0 + 4.0 * w );

  gl_FragColor = vec4( clamp( ( b * w + dd * w + f * w + h * w + e ) * rcpW, 0.0, 1.0 ), 1.0 );
}
`;

export class CompositePass {

  constructor() {
    this.composite = new ScreenPass( COMPOSITE, {
      tScene: { value: null },
      tBloom: { value: null },
      tLUT: { value: null },
      tBlueNoise: { value: null },
      uNoiseParams: { value: new THREE.Vector4( 1 / 64, 0, 0, 0 ) },
      uResolution: { value: new THREE.Vector2() },
      uExposure: { value: 1 },
      uBloomIntensity: { value: 0.055 },
      uChromatic: { value: 0.45 },
      uVignette: { value: 0.6 },
      uGrain: { value: 0.5 },
      uAspect: { value: 1.777 },
      uLutSize: { value: 32 },
      uLutStrength: { value: 0.85 },
      uAgxPunch: { value: 0.22 },
      uLift: { value: new THREE.Vector3( 0.004, 0.006, 0.012 ) },
      uGamma: { value: new THREE.Vector3( 1.0, 1.0, 1.0 ) },
      uGain: { value: new THREE.Vector3( 1.02, 1.0, 0.985 ) },
      uContrast: { value: 1.06 },
      uSaturation: { value: 1.04 },
      uFlash: { value: 0 },
      uFlashColor: { value: new THREE.Vector3( 1, 0.98, 0.94 ) },
      uDamage: { value: 0 },
    }, { name: 'composite', defines: { TONEMAP_MODE: 0, BLOOM_ENABLED: 1, LUT_ENABLED: 1 } } );

    this.cas = new ScreenPass( CAS, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uSharpness: { value: 0.35 },
    }, { name: 'cas' } );
  }

  setSize( w, h ) {
    this.composite.uniforms.uResolution.value.set( w, h );
    this.composite.uniforms.uAspect.value = w / Math.max( 1, h );
    this.cas.uniforms.uTexel.value.set( 1 / w, 1 / h );
  }

  dispose() {
    this.composite.dispose();
    this.cas.dispose();
  }

}
