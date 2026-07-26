/**
 * Shared GLSL building blocks for the post chain.
 *
 * NOTE: three already injects `luminance()`, `sRGBTransferOETF()` and friends into
 * every fragment shader prefix, so nothing here may reuse those identifiers.
 *
 * Everything is authored for GLSL ES 3.00 (three upgrades plain ShaderMaterial
 * sources automatically and declares `pc_fragColor` at location 0, which leaves
 * location 1+ free for our MRT g-buffer).
 */

export const FULLSCREEN_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

/** Small numeric helpers used by nearly every pass. */
export const GLSL_MATH = /* glsl */`
#define FX_PI 3.14159265359
#define FX_TAU 6.28318530718
float fxLuma( vec3 c ) { return dot( c, vec3( 0.2126729, 0.7151522, 0.0721750 ) ); }
float fxMax3( vec3 c ) { return max( c.r, max( c.g, c.b ) ); }
float fxSat( float x ) { return clamp( x, 0.0, 1.0 ); }
vec2  fxSat( vec2 x )  { return clamp( x, 0.0, 1.0 ); }
vec3  fxSat( vec3 x )  { return clamp( x, 0.0, 1.0 ); }
float fxSq( float x ) { return x * x; }
vec3 fxSafe( vec3 c ) { return max( vec3( 0.0 ), c ); }
// Reversible tonemap used to weight temporal / spatial filters so a single
// fireflies pixel cannot dominate a neighbourhood average.
vec3 fxTonemapW( vec3 c )   { return c / ( 1.0 + fxMax3( c ) ); }
vec3 fxTonemapWInv( vec3 c ){ return c / max( 1e-4, 1.0 - fxMax3( c ) ); }
vec3 fxRGBToYCoCg( vec3 c ) {
  return vec3( 0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
               0.5  * c.r - 0.5 * c.b,
              -0.25 * c.r + 0.5 * c.g - 0.25 * c.b );
}
vec3 fxYCoCgToRGB( vec3 c ) {
  float t = c.x - c.z;
  return vec3( t + c.y, c.x + c.z, t - c.y );
}
vec3 fxLinearToSRGB( vec3 c ) {
  c = max( c, vec3( 0.0 ) );
  return mix( c * 12.92, 1.055 * pow( c, vec3( 0.41666667 ) ) - 0.055, step( 0.0031308, c ) );
}
vec3 fxSRGBToLinear( vec3 c ) {
  return mix( c / 12.92, pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), step( 0.04045, c ) );
}
`;

/**
 * Depth utilities. Every pass that samples `tDepth` gets these; `uProjParams`
 * carries (near, far, 1/near, 1/far) so we avoid a divide in the hot loop.
 */
export const GLSL_DEPTH = /* glsl */`
uniform mat4 uInvProjection;
uniform mat4 uProjection;
uniform vec4 uProjParams; // near, far, 1/near, 1/far

float fxRawDepth( sampler2D d, vec2 uv ) { return texture2D( d, uv ).x; }

// -> positive distance along the view axis
float fxLinearDepth( float raw ) {
  float z = raw * 2.0 - 1.0;
  return ( 2.0 * uProjParams.x * uProjParams.y ) /
         ( uProjParams.y + uProjParams.x - z * ( uProjParams.y - uProjParams.x ) );
}

vec3 fxViewPos( vec2 uv, float raw ) {
  vec4 ndc = vec4( uv * 2.0 - 1.0, raw * 2.0 - 1.0, 1.0 );
  vec4 v = uInvProjection * ndc;
  return v.xyz / v.w;
}

// view -> screen uv (+ raw depth in .z)
vec3 fxProjectView( vec3 vp ) {
  vec4 c = uProjection * vec4( vp, 1.0 );
  c.xyz /= max( 1e-6, c.w );
  return vec3( c.xy * 0.5 + 0.5, c.z * 0.5 + 0.5 );
}
`;

/**
 * Blue-noise fetch. `tBlueNoise` is a 64x64 RGBA void-and-cluster mask; the
 * temporal offset walks the golden-ratio sequence so successive frames stay
 * decorrelated and TAA can integrate them into something smooth.
 */
export const GLSL_BLUENOISE = /* glsl */`
uniform sampler2D tBlueNoise;
uniform vec4 uNoiseParams; // 1/size, frameIndex, goldenOffset, unused

vec4 fxBlueNoise4( vec2 fragCoord ) {
  return texture2D( tBlueNoise, ( fragCoord + 0.5 ) * uNoiseParams.x );
}
float fxBlueNoise( vec2 fragCoord, float channelPhase ) {
  vec4 n = fxBlueNoise4( fragCoord );
  float v = channelPhase < 0.5 ? n.x : ( channelPhase < 1.5 ? n.y : ( channelPhase < 2.5 ? n.z : n.w ) );
  // Animate with the golden ratio: keeps the *spatial* blue-noise spectrum but
  // makes the temporal sequence low-discrepancy instead of periodic.
  return fract( v + uNoiseParams.z );
}
float fxInterleavedGradient( vec2 fragCoord ) {
  return fract( 52.9829189 * fract( dot( fragCoord, vec2( 0.06711056, 0.00583715 ) ) ) );
}
`;

/** AgX (Troy Sobotka / Blender rebuild) plus an ACES fallback and the grade. */
export const GLSL_TONEMAP = /* glsl */`
// ---- AgX ------------------------------------------------------------------
const mat3 AGX_IN = mat3(
  0.8424790, 0.0784336, 0.0792237,
  0.0423282, 0.8784686, 0.0791661,
  0.0423756, 0.0784336, 0.8791430 );
const mat3 AGX_OUT = mat3(
   1.1968790, -0.0980210, -0.0990297,
  -0.0528968,  1.1519102, -0.0989636,
  -0.0529716, -0.0980435,  1.1508940 );

vec3 agxDefaultContrast( vec3 x ) {
  // 6th order polynomial fit of the AgX contrast sigmoid.
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2
       - 40.14 * x4 * x
       + 31.96 * x4
       - 6.868 * x2 * x
       + 0.4298 * x2
       + 0.1191 * x
       - 0.00232;
}

vec3 tonemapAgX( vec3 col, float punch ) {
  const float minEv = -12.47393;
  const float maxEv = 4.026069;
  col = max( col, vec3( 0.0 ) );
  col = AGX_IN * col;
  col = clamp( log2( max( col, vec3( 1e-10 ) ) ), minEv, maxEv );
  col = ( col - minEv ) / ( maxEv - minEv );
  col = agxDefaultContrast( col );
  // "Punchy" look: restore some of the saturation AgX intentionally rolls off.
  float l = fxLuma( col );
  col = mix( vec3( l ), col, 1.0 + punch );
  col = AGX_OUT * col;
  col = max( col, vec3( 0.0 ) );
  col = pow( col, vec3( 2.2 ) ); // AgX outputs display-encoded; back to linear
  return col;
}

// ---- ACES (Narkowicz RRT+ODT fit, in AP1) ---------------------------------
const mat3 ACES_IN = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777 );
const mat3 ACES_OUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602 );

vec3 tonemapACES( vec3 col ) {
  col = ACES_IN * max( col, vec3( 0.0 ) );
  vec3 a = col * ( col + 0.0245786 ) - 0.000090537;
  vec3 b = col * ( 0.983729 * col + 0.4329510 ) + 0.238081;
  col = a / b;
  return max( ACES_OUT * col, vec3( 0.0 ) );
}

// ---- ASC-CDL style grade ---------------------------------------------------
vec3 fxLiftGammaGain( vec3 c, vec3 lift, vec3 gamma, vec3 gain ) {
  c = c * gain + lift * ( 1.0 - c );
  return pow( max( c, vec3( 0.0 ) ), max( vec3( 1e-3 ), gamma ) );
}
vec3 fxContrast( vec3 c, float amount, float pivot ) {
  return max( vec3( 0.0 ), ( c - pivot ) * amount + pivot );
}
vec3 fxSaturation( vec3 c, float s ) {
  return max( vec3( 0.0 ), mix( vec3( fxLuma( c ) ), c, s ) );
}
`;

/** 32^3 LUT stored as a 1024x32 strip of slices. */
export const GLSL_LUT = /* glsl */`
vec3 fxSampleLUT( sampler2D lut, vec3 c, float size ) {
  c = clamp( c, vec3( 0.0 ), vec3( 1.0 ) );
  float sliceSize      = 1.0 / size;
  float slicePixelSize = sliceSize / size;
  float sliceInnerSize = slicePixelSize * ( size - 1.0 );
  float zs = c.b * size - 0.5;
  float z0 = clamp( floor( zs ), 0.0, size - 1.0 );
  float z1 = min( z0 + 1.0, size - 1.0 );
  float zf = clamp( zs - z0, 0.0, 1.0 );
  float xo = slicePixelSize * 0.5 + c.r * sliceInnerSize;
  float v  = ( c.g * ( size - 1.0 ) + 0.5 ) / size;
  vec3 a = texture2D( lut, vec2( z0 * sliceSize + xo, v ) ).rgb;
  vec3 b = texture2D( lut, vec2( z1 * sliceSize + xo, v ) ).rgb;
  return mix( a, b, zf );
}
`;

/** Catmull-Rom (5-tap Bicubic) history resample — kills TAA's blur-per-frame. */
export const GLSL_CATMULL = /* glsl */`
vec4 fxCatmullRom( sampler2D tex, vec2 uv, vec2 texSize ) {
  vec2 samplePos = uv * texSize;
  vec2 texPos1 = floor( samplePos - 0.5 ) + 0.5;
  vec2 f = samplePos - texPos1;

  vec2 w0 = f * ( -0.5 + f * ( 1.0 - 0.5 * f ) );
  vec2 w1 = 1.0 + f * f * ( -2.5 + 1.5 * f );
  vec2 w2 = f * ( 0.5 + f * ( 2.0 - 1.5 * f ) );
  vec2 w3 = f * f * ( -0.5 + 0.5 * f );

  vec2 w12 = w1 + w2;
  vec2 offset12 = w2 / max( w12, vec2( 1e-5 ) );

  vec2 texPos0  = ( texPos1 - 1.0 ) / texSize;
  vec2 texPos3  = ( texPos1 + 2.0 ) / texSize;
  vec2 texPos12 = ( texPos1 + offset12 ) / texSize;

  vec4 result = vec4( 0.0 );
  result += texture2D( tex, vec2( texPos0.x,  texPos0.y  ) ) * w0.x  * w0.y;
  result += texture2D( tex, vec2( texPos12.x, texPos0.y  ) ) * w12.x * w0.y;
  result += texture2D( tex, vec2( texPos3.x,  texPos0.y  ) ) * w3.x  * w0.y;

  result += texture2D( tex, vec2( texPos0.x,  texPos12.y ) ) * w0.x  * w12.y;
  result += texture2D( tex, vec2( texPos12.x, texPos12.y ) ) * w12.x * w12.y;
  result += texture2D( tex, vec2( texPos3.x,  texPos12.y ) ) * w3.x  * w12.y;

  result += texture2D( tex, vec2( texPos0.x,  texPos3.y  ) ) * w0.x  * w3.y;
  result += texture2D( tex, vec2( texPos12.x, texPos3.y  ) ) * w12.x * w3.y;
  result += texture2D( tex, vec2( texPos3.x,  texPos3.y  ) ) * w3.x  * w3.y;
  return result;
}
`;
