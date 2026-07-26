/**
 * onBeforeCompile injections for the material library.
 *
 * Five features, all opt-in per material, all sharing one prelude so they cost
 * a single extra texture fetch each rather than a separate pass:
 *
 *  OB_MACRO      large-scale albedo/roughness variation sampled at 1/16 the base
 *                frequency. Kills visible tiling, which is the single loudest
 *                "this is a web demo" tell there is.
 *  OB_DETAIL     a second, high-frequency normal map tiled ~20x and blended with
 *                the whiteout method so surfaces stay crisp at knife-fight range.
 *  OB_PARALLAX   offset-limited parallax driven by the height stored in the
 *                albedo's alpha channel. Free depth on brick, rust and gravel.
 *  OB_TRIPLANAR  world-space projection for terrain/rubble so nothing stretches.
 *  OB_WET / OB_WATER / OB_FOLIAGE — second-order shading tweaks.
 *
 * Every replacement re-implements the stock chunk faithfully (including the
 * USE_* guards three generates) so a material can turn any subset on.
 */

const HEADER_FS = /* glsl */`
#include <common>

#if defined( OB_DETAIL )
  uniform sampler2D uDetailNormal;
  uniform vec2 uDetailParams;   // x: tiling, y: strength
#endif
#if defined( OB_MACRO )
  uniform sampler2D uMacroTex;
  uniform vec3 uMacroParams;    // x: tiling, y: albedo amount, z: roughness amount
#endif
#if defined( OB_PARALLAX )
  uniform float uParallax;
#endif
#if defined( OB_TRIPLANAR )
  uniform vec2 uTriParams;      // x: world scale, y: blend sharpness
  varying vec3 vTriPos;
  varying vec3 vTriNrm;
#endif
#if defined( OB_WET )
  uniform vec3 uWet;            // x: amount, y/z: puddle threshold band
#endif
#if defined( OB_WATER )
  uniform vec4 uWater;          // xy: layer scales, zw: layer speeds
#endif
#if defined( OB_FOLIAGE )
  uniform vec2 uFoliage;        // x: translucency, y: wrap
#endif
#if defined( OB_WATER ) || defined( OB_TIME )
  uniform float uTime;
#endif

// Our normal maps are two-channel (RG8): half the memory, and Z is exact.
vec3 obUnpackRG( vec4 t ) {
  vec2 xy = t.xy * 2.0 - 1.0;
  return vec3( xy, sqrt( max( 1.0 - dot( xy, xy ), 0.0 ) ) );
}

// Cotangent frame (Mikkelsen) — used only by the parallax offset; the lighting
// path still uses three's own tbn so the two never disagree.
mat3 obFrame( vec3 eyePos, vec3 n, vec2 uv ) {
  vec3 q0 = dFdx( eyePos );
  vec3 q1 = dFdy( eyePos );
  vec2 st0 = dFdx( uv );
  vec2 st1 = dFdy( uv );
  vec3 q1perp = cross( q1, n );
  vec3 q0perp = cross( n, q0 );
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max( dot( T, T ), dot( B, B ) );
  float scale = ( det == 0.0 ) ? 0.0 : inversesqrt( det );
  return mat3( T * scale, B * scale, n );
}

#if defined( OB_TRIPLANAR )
  vec4 obTriSample( sampler2D t, vec3 p, vec3 w ) {
    return texture2D( t, p.zy ) * w.x + texture2D( t, p.xz ) * w.y + texture2D( t, p.xy ) * w.z;
  }
  vec4 obTriSampleScaled( sampler2D t, vec3 p, vec3 w, float s ) {
    return texture2D( t, p.zy * s ) * w.x + texture2D( t, p.xz * s ) * w.y + texture2D( t, p.xy * s ) * w.z;
  }
  // Whiteout normal blend in world space (Golus). Keeps detail from all three
  // projections instead of letting the dominant axis flatten the other two.
  vec3 obTriNormal( sampler2D t, vec3 p, vec3 w, vec3 n, float s ) {
    vec3 nx = obUnpackRG( texture2D( t, p.zy * s ) );
    vec3 ny = obUnpackRG( texture2D( t, p.xz * s ) );
    vec3 nz = obUnpackRG( texture2D( t, p.xy * s ) );
    vec3 an = abs( n );
    nx = vec3( nx.xy + n.zy, an.x * nx.z );
    ny = vec3( ny.xy + n.xz, an.y * ny.z );
    nz = vec3( nz.xy + n.xy, an.z * nz.z );
    return normalize( nx.zyx * w.x + ny.xzy * w.y + nz.xyz * w.z );
  }
#endif
`;

const PRELUDE_FS = /* glsl */`
#include <clipping_planes_fragment>

vec2 obUv = OB_UV0;
float obHeight = 0.5;
float obWetMask = 0.0;
vec4 obMacro = vec4( 0.5 );

#if defined( OB_TRIPLANAR )
  vec3 obTriP = vTriPos * uTriParams.x;
  vec3 obTriN = normalize( vTriNrm );
  vec3 obTriW = pow( abs( obTriN ), vec3( uTriParams.y ) );
  obTriW /= max( obTriW.x + obTriW.y + obTriW.z, 1e-4 );
#endif

#if defined( OB_PARALLAX ) && defined( USE_MAP ) && !defined( OB_TRIPLANAR ) && !defined( FLAT_SHADED )
  {
    vec3 obN = normalize( vNormal );
    mat3 obTb = obFrame( - vViewPosition, obN, obUv );
    vec3 obV = normalize( vViewPosition );
    vec3 obTsV = vec3( dot( obV, obTb[ 0 ] ), dot( obV, obTb[ 1 ] ), dot( obV, obTb[ 2 ] ) );
    float obH0 = texture2D( map, obUv ).a;
    // Offset-limited: no divide by tsV.z, so grazing angles never explode.
    obUv -= obTsV.xy * ( ( obH0 - 0.55 ) * uParallax );
  }
#endif

#if defined( OB_WATER )
  vec2 obW1 = obUv * uWater.x + vec2( uTime * uWater.z, uTime * uWater.z * 0.63 );
  vec2 obW2 = obUv * uWater.y - vec2( uTime * uWater.w * 0.79, uTime * uWater.w );
#endif

#if defined( OB_MACRO )
  #if defined( OB_TRIPLANAR )
    obMacro = obTriSampleScaled( uMacroTex, obTriP, obTriW, uMacroParams.x );
  #else
    obMacro = texture2D( uMacroTex, obUv * uMacroParams.x );
  #endif
#endif
`;

const MAP_FS = /* glsl */`
#ifdef USE_MAP
  #if defined( OB_TRIPLANAR )
    vec4 obTex = obTriSample( map, obTriP, obTriW );
  #elif defined( OB_WATER )
    vec4 obTex = texture2D( map, obW1 ) * 0.55 + texture2D( map, obW2 ) * 0.45;
  #else
    vec4 obTex = texture2D( map, obUv );
  #endif
  obHeight = obTex.a;
  diffuseColor.rgb *= obTex.rgb;
  #if defined( OB_ALPHA_FROM_MAP )
    diffuseColor.a *= obTex.a;
  #endif
#endif

#if defined( OB_MACRO )
  diffuseColor.rgb *= mix( vec3( 1.0 ), obMacro.rgb * 2.0, uMacroParams.y );
#endif

#if defined( OB_WET )
  // Water pools where the surface is low and the macro field says "hollow".
  obWetMask = clamp( uWet.x * smoothstep( uWet.y, uWet.z, 1.0 - obMacro.a )
                     * smoothstep( 0.66, 0.30, obHeight ), 0.0, 1.0 );
  diffuseColor.rgb *= mix( 1.0, 0.34, obWetMask );
#endif
`;

const ROUGH_FS = /* glsl */`
float roughnessFactor = roughness;

#ifdef USE_ROUGHNESSMAP
  #if defined( OB_TRIPLANAR )
    vec4 texelRoughness = obTriSample( roughnessMap, obTriP, obTriW );
  #elif defined( OB_WATER )
    vec4 texelRoughness = texture2D( roughnessMap, obW1 );
  #else
    vec4 texelRoughness = texture2D( roughnessMap, obUv );
  #endif
  roughnessFactor *= texelRoughness.g;
#endif

#if defined( OB_MACRO )
  roughnessFactor = clamp( roughnessFactor + ( obMacro.a - 0.5 ) * uMacroParams.z, 0.035, 1.0 );
#endif
#if defined( OB_WET )
  roughnessFactor = mix( roughnessFactor, 0.055, obWetMask );
#endif
`;

const METAL_FS = /* glsl */`
float metalnessFactor = metalness;

#ifdef USE_METALNESSMAP
  #if defined( OB_TRIPLANAR )
    vec4 texelMetalness = obTriSample( metalnessMap, obTriP, obTriW );
  #else
    vec4 texelMetalness = texture2D( metalnessMap, obUv );
  #endif
  metalnessFactor *= texelMetalness.b;
#endif
`;

const NORMAL_FS = /* glsl */`
#ifdef USE_NORMALMAP_OBJECTSPACE

  normal = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
  #ifdef FLIP_SIDED
    normal = - normal;
  #endif
  #ifdef DOUBLE_SIDED
    normal = normal * faceDirection;
  #endif
  normal = normalize( normalMatrix * normal );

#elif defined( USE_NORMALMAP_TANGENTSPACE )

  #if defined( OB_TRIPLANAR )

    vec3 obWorldN = obTriNormal( normalMap, obTriP, obTriW, obTriN, 1.0 );
    #if defined( OB_DETAIL )
      vec3 obWorldD = obTriNormal( uDetailNormal, obTriP, obTriW, obTriN, uDetailParams.x );
      obWorldN = normalize( mix( obWorldN, normalize( obWorldN + obWorldD ), uDetailParams.y ) );
    #endif
    normal = normalize( ( viewMatrix * vec4( obWorldN, 0.0 ) ).xyz );
    #ifdef DOUBLE_SIDED
      normal *= faceDirection;
    #endif

  #else

    #if defined( OB_WATER )
      vec3 obN1 = obUnpackRG( texture2D( normalMap, obW1 ) );
      vec3 obN2 = obUnpackRG( texture2D( normalMap, obW2 ) );
      vec3 mapN = normalize( vec3( obN1.xy + obN2.xy, obN1.z * obN2.z ) );
    #else
      vec3 mapN = obUnpackRG( texture2D( normalMap, obUv ) );
    #endif

    mapN.xy *= normalScale;

    #if defined( OB_DETAIL )
      vec3 obDet = obUnpackRG( texture2D( uDetailNormal, obUv * uDetailParams.x ) );
      obDet.xy *= uDetailParams.y;
      // Whiteout blend: add the tangents, multiply the Z. Preserves both the
      // base silhouette and the micro-facet detail without washing either out.
      mapN = normalize( vec3( mapN.xy + obDet.xy, mapN.z * obDet.z ) );
    #endif

    #if defined( OB_WET )
      mapN = normalize( mix( mapN, vec3( 0.0, 0.0, 1.0 ), obWetMask * 0.88 ) );
    #endif

    normal = normalize( tbn * mapN );

  #endif

#elif defined( USE_BUMPMAP )

  normal = perturbNormalArb( - vViewPosition, normal, dHdxy_fwd(), faceDirection );

#endif
`;

const AO_FS = /* glsl */`
#ifdef USE_AOMAP

  #if defined( OB_TRIPLANAR )
    float ambientOcclusion = ( obTriSample( aoMap, obTriP, obTriW ).r - 1.0 ) * aoMapIntensity + 1.0;
  #else
    float ambientOcclusion = ( texture2D( aoMap, obUv ).r - 1.0 ) * aoMapIntensity + 1.0;
  #endif

  reflectedLight.indirectDiffuse *= ambientOcclusion;

  #if defined( USE_CLEARCOAT )
    clearcoatSpecularIndirect *= ambientOcclusion;
  #endif

  #if defined( USE_SHEEN )
    sheenSpecularIndirect *= ambientOcclusion;
  #endif

  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
  #endif

#endif
`;

const FOLIAGE_FS = /* glsl */`
#include <lights_fragment_end>

#if defined( OB_FOLIAGE ) && ( NUM_DIR_LIGHTS > 0 )
  // Cheap single-scatter transmission: leaves glow when the sun is behind them.
  {
    vec3 obLdir = directionalLights[ 0 ].direction;
    float obBack = pow( saturate( dot( normalize( vViewPosition ), - obLdir ) ), 3.0 );
    float obWrap = saturate( ( dot( normal, obLdir ) + uFoliage.y ) / ( 1.0 + uFoliage.y ) );
    reflectedLight.indirectDiffuse += directionalLights[ 0 ].color * diffuseColor.rgb
      * ( obBack * 1.4 + obWrap * 0.35 ) * uFoliage.x;
  }
#endif
`;

const HEADER_VS = /* glsl */`
#include <common>

#if defined( OB_TRIPLANAR )
  varying vec3 vTriPos;
  varying vec3 vTriNrm;
#endif
`;

const PROJECT_VS = /* glsl */`
#include <project_vertex>

#if defined( OB_TRIPLANAR )
  {
    vec4 obLocal = vec4( transformed, 1.0 );
    #ifdef USE_BATCHING
      obLocal = batchingMatrix * obLocal;
    #endif
    #ifdef USE_INSTANCING
      obLocal = instanceMatrix * obLocal;
    #endif
    vTriPos = ( modelMatrix * obLocal ).xyz;

    vec3 obNrm = objectNormal;
    #ifdef USE_INSTANCING
      obNrm = mat3( instanceMatrix ) * obNrm;
    #endif
    vTriNrm = mat3( modelMatrix ) * obNrm;
  }
#endif
`;

/**
 * Install the injection on a material.
 *
 * @param material three.js material (Standard or Physical)
 * @param flags    { macro, detail, parallax, triplanar, wet, water, foliage,
 *                   alphaFromMap, hasMap }
 * @param uniforms plain object of THREE.IUniform, stored on the material so
 *                 update() can drive uTime without reaching into the program
 */
export function applyOBShader(material, flags, uniforms) {
  const defines = [];
  if (flags.macro) defines.push('OB_MACRO');
  if (flags.detail) defines.push('OB_DETAIL');
  if (flags.parallax) defines.push('OB_PARALLAX');
  if (flags.triplanar) defines.push('OB_TRIPLANAR');
  if (flags.wet) defines.push('OB_WET');
  if (flags.water) defines.push('OB_WATER');
  if (flags.foliage) defines.push('OB_FOLIAGE');
  if (flags.alphaFromMap) defines.push('OB_ALPHA_FROM_MAP');

  if (!defines.length) return material;

  const uvExpr = flags.hasMap ? 'vMapUv' : 'vUv';
  const defineBlock = defines.map((d) => `#define ${d}`).join('\n')
    + `\n#define OB_UV0 ${uvExpr}\n`;
  const key = defines.join('|') + '|' + uvExpr;

  material.userData.obUniforms = uniforms;
  material.userData.obKey = key;

  material.onBeforeCompile = (shader) => {
    for (const k in uniforms) shader.uniforms[k] = uniforms[k];

    shader.vertexShader = defineBlock + shader.vertexShader
      .replace('#include <common>', HEADER_VS)
      .replace('#include <project_vertex>', PROJECT_VS);

    let fs = defineBlock + shader.fragmentShader
      .replace('#include <common>', HEADER_FS)
      .replace('#include <clipping_planes_fragment>', PRELUDE_FS)
      .replace('#include <map_fragment>', MAP_FS)
      .replace('#include <roughnessmap_fragment>', ROUGH_FS)
      .replace('#include <metalnessmap_fragment>', METAL_FS)
      .replace('#include <normal_fragment_maps>', NORMAL_FS)
      .replace('#include <aomap_fragment>', AO_FS);

    if (flags.foliage) fs = fs.replace('#include <lights_fragment_end>', FOLIAGE_FS);

    shader.fragmentShader = fs;
  };

  material.customProgramCacheKey = () => key;
  return material;
}
