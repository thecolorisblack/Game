import * as THREE from 'three';
import { ScreenPass, makeRT } from './ScreenPass.js';
import { GLSL_MATH, GLSL_DEPTH, GLSL_BLUENOISE } from '../shaders/common.js';

/**
 * Screen-space reflections.
 *
 * View-space ray march with geometrically growing stride and a binary refine
 * on the crossing, roughness-aware cone jitter (blue noise, so successive TAA
 * frames integrate into a smooth rough reflection rather than a sparkling
 * mess), and a mip pyramid of the scene colour so a rough surface reads as a
 * blurred reflection instead of a mirror with noise on it.
 *
 * Confidence fades on: screen edges, rays pointing back at the camera, ray
 * length, and depth-thickness mismatch — the four things that make naive SSR
 * look like smeared garbage on the edge of frame.
 */

const SSR_TRACE = /* glsl */`
precision highp float;
${GLSL_MATH}
${GLSL_DEPTH}
${GLSL_BLUENOISE}

uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform sampler2D tColor0;
uniform sampler2D tColor1;
uniform sampler2D tColor2;
uniform sampler2D tColor3;
uniform vec2 uResolution;
uniform float uMaxRoughness;
uniform float uThickness;
uniform float uMaxDistance;
uniform float uEdgeFade;

varying vec2 vUv;

#ifndef SSR_STEPS
#define SSR_STEPS 24
#endif
#ifndef SSR_REFINE
#define SSR_REFINE 5
#endif

vec3 sampleColorLod( vec2 uv, float lod ) {
  if ( lod < 1.0 ) return mix( texture2D( tColor0, uv ).rgb, texture2D( tColor1, uv ).rgb, lod );
  if ( lod < 2.0 ) return mix( texture2D( tColor1, uv ).rgb, texture2D( tColor2, uv ).rgb, lod - 1.0 );
  return mix( texture2D( tColor2, uv ).rgb, texture2D( tColor3, uv ).rgb, min( 1.0, lod - 2.0 ) );
}

void main() {
  float raw = texture2D( tDepth, vUv ).x;
  vec4 nr = texture2D( tNormal, vUv );
  float roughness = nr.w;

  if ( raw >= 0.9999 || roughness > uMaxRoughness ) { gl_FragColor = vec4( 0.0 ); return; }

  vec3 P = fxViewPos( vUv, raw );
  vec3 N = normalize( nr.xyz );
  vec3 V = normalize( -P );

  vec4 noise = fxBlueNoise4( vUv * uResolution );
  float n1 = fract( noise.x + uNoiseParams.z );
  float n2 = fract( noise.z + uNoiseParams.z * 1.6180339887 );

  // Roughness cone: perturb the mirror direction inside a lobe whose width
  // tracks alpha = roughness^2, which is what a GGX NDF actually does.
  vec3 R = reflect( -V, N );
  float alpha = roughness * roughness;
  float phi = FX_TAU * n1;
  float ct = sqrt( ( 1.0 - n2 ) / ( 1.0 + ( alpha * alpha - 1.0 ) * n2 ) );
  float st = sqrt( max( 0.0, 1.0 - ct * ct ) );
  vec3 up = abs( R.z ) < 0.999 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 1.0, 0.0, 0.0 );
  vec3 tx = normalize( cross( up, R ) );
  vec3 ty = cross( R, tx );
  R = normalize( R * ct + ( tx * cos( phi ) + ty * sin( phi ) ) * st * 0.85 );
  if ( dot( R, N ) < 0.0 ) R = reflect( R, N );

  float viewDist = -P.z;
  float stride = max( 0.055, viewDist * 0.022 );
  vec3 origin = P + N * ( 0.02 + viewDist * 0.004 );

  vec3 pos = origin + R * stride * ( 0.35 + n1 * 0.65 );
  vec3 prevPos = origin;
  float travelled = 0.0;
  bool hit = false;
  vec2 hitUv = vec2( 0.0 );
  float hitDelta = 0.0;

  for ( int i = 0; i < SSR_STEPS; i++ ) {
    vec3 uvz = fxProjectView( pos );
    if ( uvz.x < 0.0 || uvz.y < 0.0 || uvz.x > 1.0 || uvz.y > 1.0 || uvz.z > 1.0 ) break;

    float sceneRaw = texture2D( tDepth, uvz.xy ).x;
    float sceneDist = sceneRaw >= 0.9999 ? 1e6 : fxLinearDepth( sceneRaw );
    float rayDist = -pos.z;
    float delta = rayDist - sceneDist;

    if ( delta > 0.0 && delta < uThickness * max( 1.0, sceneDist * 0.11 ) ) {
      // Binary refine between the last miss and this hit.
      vec3 a = prevPos, b = pos;
      for ( int r = 0; r < SSR_REFINE; r++ ) {
        vec3 mid = ( a + b ) * 0.5;
        vec3 muvz = fxProjectView( mid );
        float mRaw = texture2D( tDepth, muvz.xy ).x;
        float mDist = mRaw >= 0.9999 ? 1e6 : fxLinearDepth( mRaw );
        if ( -mid.z - mDist > 0.0 ) b = mid; else a = mid;
      }
      vec3 finalPos = ( a + b ) * 0.5;
      vec3 fuvz = fxProjectView( finalPos );
      hitUv = fuvz.xy;
      hitDelta = abs( -finalPos.z - ( texture2D( tDepth, fuvz.xy ).x >= 0.9999 ? 1e6 : fxLinearDepth( texture2D( tDepth, fuvz.xy ).x ) ) );
      hit = true;
      break;
    }

    prevPos = pos;
    travelled += stride;
    if ( travelled > uMaxDistance ) break;
    stride *= 1.14;
    pos += R * stride;
  }

  if ( ! hit ) { gl_FragColor = vec4( 0.0 ); return; }

  // --- confidence -----------------------------------------------------------
  vec2 edge = smoothstep( vec2( 0.0 ), vec2( uEdgeFade ), hitUv )
            * ( 1.0 - smoothstep( vec2( 1.0 - uEdgeFade ), vec2( 1.0 ), hitUv ) );
  float conf = edge.x * edge.y;
  conf *= fxSat( 1.0 - travelled / uMaxDistance );
  // Rays coming back towards the eye have no on-screen information behind them.
  conf *= fxSat( 1.0 - 2.2 * max( 0.0, dot( R, V ) ) );
  conf *= 1.0 - fxSat( roughness / uMaxRoughness );
  conf *= fxSat( 1.0 - hitDelta / ( uThickness * 2.0 ) );

  vec3 color = sampleColorLod( hitUv, min( 3.0, roughness * 5.0 ) );
  // A single fireflies pixel reflected off a rough floor tiles the whole wall.
  color = min( color, vec3( 24.0 ) );

  gl_FragColor = vec4( color, fxSat( conf ) );
}
`;

const SSR_APPLY = /* glsl */`
precision highp float;
${GLSL_MATH}
${GLSL_DEPTH}

uniform sampler2D tScene;
uniform sampler2D tSSR;
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform sampler2D tMisc;     // .w = metalness
uniform vec2 uSSRTexel;
uniform float uIntensity;
varying vec2 vUv;

void main() {
  vec4 scene = texture2D( tScene, vUv );
  float raw = texture2D( tDepth, vUv ).x;
  if ( raw >= 0.9999 ) { gl_FragColor = scene; return; }

  float centerDepth = fxLinearDepth( raw );
  vec4 nr = texture2D( tNormal, vUv );
  vec3 N = normalize( nr.xyz );
  float roughness = nr.w;
  float metalness = texture2D( tMisc, vUv ).w;

  // depth-aware upsample of the half-res trace
  vec4 sum = vec4( 0.0 );
  float wsum = 0.0;
  for ( int y = 0; y < 2; y++ ) {
    for ( int x = 0; x < 2; x++ ) {
      vec2 uv = vUv + ( vec2( float( x ), float( y ) ) - 0.5 ) * uSSRTexel;
      vec4 s = texture2D( tSSR, uv );
      float sd = fxLinearDepth( texture2D( tDepth, uv ).x );
      float w = 1.0 / ( 1e-3 + abs( sd - centerDepth ) * 3.0 );
      sum += s * w;
      wsum += w;
    }
  }
  vec4 ssr = sum / max( 1e-4, wsum );

  vec3 P = fxViewPos( vUv, raw );
  vec3 V = normalize( -P );
  float ndv = fxSat( dot( N, V ) );

  float f0 = mix( 0.04, 1.0, metalness );
  float fres = f0 + ( 1.0 - f0 ) * pow( 1.0 - ndv, 5.0 );

  vec3 albedo = fxSat( scene.rgb / ( 1.0 + fxMax3( scene.rgb ) ) );
  vec3 tint = mix( vec3( 1.0 ), albedo, metalness );

  float weight = ssr.a * fres * ( 1.0 - roughness * 0.8 ) * uIntensity;
  gl_FragColor = vec4( scene.rgb + ssr.rgb * tint * weight, scene.a );
}
`;

const DOWNSAMPLE = /* glsl */`
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;   // texel size of the SOURCE
varying vec2 vUv;
void main() {
  vec3 c = texture2D( tSrc, vUv + vec2( -1.0, -1.0 ) * uTexel ).rgb;
  c += texture2D( tSrc, vUv + vec2(  1.0, -1.0 ) * uTexel ).rgb;
  c += texture2D( tSrc, vUv + vec2( -1.0,  1.0 ) * uTexel ).rgb;
  c += texture2D( tSrc, vUv + vec2(  1.0,  1.0 ) * uTexel ).rgb;
  gl_FragColor = vec4( c * 0.25, 1.0 );
}
`;

export class SSRPass {

  constructor() {
    this.trace = new ScreenPass( SSR_TRACE, {
      tDepth: { value: null },
      tNormal: { value: null },
      tColor0: { value: null },
      tColor1: { value: null },
      tColor2: { value: null },
      tColor3: { value: null },
      tBlueNoise: { value: null },
      uNoiseParams: { value: new THREE.Vector4( 1 / 64, 0, 0, 0 ) },
      uResolution: { value: new THREE.Vector2() },
      uMaxRoughness: { value: 0.62 },
      uThickness: { value: 0.65 },
      uMaxDistance: { value: 42 },
      uEdgeFade: { value: 0.16 },
      uInvProjection: { value: new THREE.Matrix4() },
      uProjection: { value: new THREE.Matrix4() },
      uProjParams: { value: new THREE.Vector4( 0.05, 2200, 20, 1 / 2200 ) },
    }, { name: 'ssr', defines: { SSR_STEPS: 24, SSR_REFINE: 5 } } );

    this.apply = new ScreenPass( SSR_APPLY, {
      tScene: { value: null },
      tSSR: { value: null },
      tDepth: { value: null },
      tNormal: { value: null },
      tMisc: { value: null },
      uSSRTexel: { value: new THREE.Vector2() },
      uIntensity: { value: 1.0 },
      uInvProjection: { value: new THREE.Matrix4() },
      uProjection: { value: new THREE.Matrix4() },
      uProjParams: { value: new THREE.Vector4( 0.05, 2200, 20, 1 / 2200 ) },
    }, { name: 'ssrApply' } );

    this.down = new ScreenPass( DOWNSAMPLE, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
    }, { name: 'ssrDown' } );

    this.rt = null;
    this.mips = [];
  }

  setQuality( steps ) { this.trace.define( 'SSR_STEPS', steps ); }

  setSize( w, h ) {
    this.rt?.dispose();
    this.rt = makeRT( w, h, { name: 'ssr' } );
    this.trace.uniforms.uResolution.value.set( w, h );
    this.apply.uniforms.uSSRTexel.value.set( 1 / w, 1 / h );

    for ( const m of this.mips ) m.dispose();
    this.mips = [];
    let mw = w, mh = h;
    for ( let i = 0; i < 4; i++ ) {
      this.mips.push( makeRT( Math.max( 1, mw ), Math.max( 1, mh ), { name: `ssrMip${i}` } ) );
      mw = Math.max( 1, mw >> 1 );
      mh = Math.max( 1, mh >> 1 );
    }
  }

  /** Builds the colour pyramid the trace samples for rough reflections. */
  buildPyramid( renderer, sourceTexture, srcW, srcH ) {
    this.down.uniforms.tSrc.value = sourceTexture;
    this.down.uniforms.uTexel.value.set( 1 / srcW, 1 / srcH );
    this.down.render( renderer, this.mips[ 0 ] );
    for ( let i = 1; i < this.mips.length; i++ ) {
      const prev = this.mips[ i - 1 ];
      this.down.uniforms.tSrc.value = prev.texture;
      this.down.uniforms.uTexel.value.set( 1 / prev.width, 1 / prev.height );
      this.down.render( renderer, this.mips[ i ] );
    }
    const u = this.trace.uniforms;
    u.tColor0.value = this.mips[ 0 ].texture;
    u.tColor1.value = this.mips[ 1 ].texture;
    u.tColor2.value = this.mips[ 2 ].texture;
    u.tColor3.value = this.mips[ 3 ].texture;
  }

  dispose() {
    this.trace.dispose();
    this.apply.dispose();
    this.down.dispose();
    this.rt?.dispose();
    for ( const m of this.mips ) m.dispose();
  }

}
