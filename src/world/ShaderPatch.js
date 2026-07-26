import * as THREE from 'three';

/**
 * Two global shader-chunk patches that the world's lighting model depends on.
 *
 * These edit `THREE.ShaderChunk` rather than individual materials on purpose.
 * Ten systems author materials in this project and most of them never hear
 * about the world; patching the chunk means a crate spawned by the VFX system
 * three minutes into a match receives cascaded shadows and aerial perspective
 * without anyone wiring anything together. Both patches are no-ops unless the
 * conditions they key off are met, so a scene with a single directional light
 * (the first-person viewmodel scene, for instance) compiles to exactly the
 * stock three.js code path.
 *
 *   1. CASCADED SHADOWS. The sun is N directional lights sharing a direction
 *      and colour, each with a shadow camera fitted to one slice of the view
 *      frustum. A fragment must take exactly one of them or it would be lit N
 *      times. The selection is made from `vDirectionalShadowCoord[i]` alone —
 *      the first cascade whose shadow-space coordinate is inside the unit cube
 *      wins, the last cascade catches everything past the split — so no extra
 *      uniform has to be plumbed into every material in the game.
 *
 *   2. AERIAL PERSPECTIVE. Stock `fog_fragment` lerps to one flat colour, which
 *      is the tell that separates a web demo from a shipped shooter. This
 *      replaces it with exponential *height* fog analytically integrated along
 *      the view ray, plus Henyey-Greenstein forward scattering so the haze
 *      lights up around the sun and stays cold away from it. Both terms are
 *      derived from uniforms that already exist in every lit shader
 *      (`fogColor`, `fogDensity`, `viewMatrix`, `cameraPosition`, the first
 *      directional light), which is what makes the patch free.
 */

let patched = false;

export function patchShaderChunks(opts = {}) {
  if (patched) return true;
  patched = true;
  let ok = true;
  ok = patchCascades(opts) && ok;
  ok = patchAerialPerspective(opts) && ok;
  return ok;
}

/* ------------------------------------------------------------------ */
/* 1. cascaded shadow selection                                        */
/* ------------------------------------------------------------------ */

function patchCascades(opts) {
  const edge = (opts.cascadeEdge ?? 0.0025).toFixed(5);
  const src = THREE.ShaderChunk.lights_fragment_begin;
  const declAnchor = 'DirectionalLight directionalLight;';
  const loopAnchor = 'for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ )';
  const endToken = '#pragma unroll_loop_end';

  const declAt = src.indexOf(declAnchor);
  const loopAt = src.indexOf(loopAnchor);
  if (declAt < 0 || loopAt < 0 || loopAt < declAt) {
    console.warn('[World] CSM shader patch skipped: unexpected three.js lights chunk.');
    return false;
  }
  const endAt = src.indexOf(endToken, loopAt);
  if (endAt < 0) return false;

  const replacement = /* glsl */`
	DirectionalLight directionalLight;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	bool obCsmUsed = false;
	bool obCsmTake = true;
	#endif

	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {

		directionalLight = directionalLights[ i ];

		getDirectionalLightInfo( directionalLight, directLight );

		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )

			#if ( NUM_DIR_LIGHT_SHADOWS > 1 )

				{
					vec4 obSc = vDirectionalShadowCoord[ i ];
					vec3 obCoord = obSc.xyz / max( 1e-5, obSc.w );
					bool obInside = all( greaterThanEqual( obCoord, vec3( ${edge} ) ) )
						&& all( lessThanEqual( obCoord, vec3( ${(1 - Number(edge)).toFixed(5)} ) ) );
					#if ( UNROLLED_LOOP_INDEX + 1 >= NUM_DIR_LIGHT_SHADOWS )
						obInside = true;
					#endif
					obCsmTake = obInside && ! obCsmUsed;
					obCsmUsed = obCsmUsed || obCsmTake;
				}

				if ( obCsmTake ) {
					directionalLightShadow = directionalLightShadows[ i ];
					directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
				}

			#else

				directionalLightShadow = directionalLightShadows[ i ];
				directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;

			#endif

		#endif

		#if defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 1 ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		if ( obCsmTake )
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

	}
	#pragma unroll_loop_end
`;

  THREE.ShaderChunk.lights_fragment_begin =
    src.slice(0, declAt) + replacement.trim() + src.slice(endAt + endToken.length);
  return true;
}

/* ------------------------------------------------------------------ */
/* 2. height fog + aerial perspective                                  */
/* ------------------------------------------------------------------ */

function patchAerialPerspective(opts) {
  const height = (opts.fogHeight ?? 46).toFixed(2);
  const base = (opts.fogBase ?? 0).toFixed(2);
  const inscatter = (opts.fogInscatter ?? 0.048).toFixed(4);

  const parsV = THREE.ShaderChunk.fog_pars_vertex;
  const vert = THREE.ShaderChunk.fog_vertex;
  const parsF = THREE.ShaderChunk.fog_pars_fragment;
  if (!parsV.includes('vFogDepth') || !vert.includes('vFogDepth')) {
    console.warn('[World] fog shader patch skipped: unexpected three.js fog chunk.');
    return false;
  }

  THREE.ShaderChunk.fog_pars_vertex = parsV.replace(
    'varying float vFogDepth;',
    'varying float vFogDepth;\n\tvarying vec3 vFogView;',
  );
  THREE.ShaderChunk.fog_vertex = vert.replace(
    'vFogDepth = - mvPosition.z;',
    'vFogDepth = - mvPosition.z;\n\tvFogView = mvPosition.xyz;',
  );
  THREE.ShaderChunk.fog_pars_fragment = parsF.replace(
    'varying float vFogDepth;',
    'varying float vFogDepth;\n\tvarying vec3 vFogView;',
  );

  THREE.ShaderChunk.fog_fragment = /* glsl */`
#ifdef USE_FOG

	float obDist = length( vFogView );
	vec3 obDir = obDist > 1e-4 ? vFogView / obDist : vec3( 0.0, 0.0, -1.0 );

	// World-space heights without inverting a matrix: the world offset of a
	// view-space point is transpose(R) * p, and we only need its Y row.
	float obFragY = cameraPosition.y + dot( vFogView, vec3( viewMatrix[ 0 ].y, viewMatrix[ 1 ].y, viewMatrix[ 2 ].y ) );

	#ifdef FOG_EXP2
		float obBase = fogDensity;
	#else
		float obBase = 1.0 / max( 1.0, fogFar - fogNear );
	#endif

	// Analytic integral of rho0 * exp( -( y - base ) / H ) along the ray.
	const float obH = ${height};
	float obDy = obFragY - cameraPosition.y;
	float obRho = exp( - clamp( ( cameraPosition.y - ${base} ) / obH, -4.0, 12.0 ) );
	float obTau = ( abs( obDy ) < 0.06 )
		? obRho * obDist
		: obRho * obDist * ( 1.0 - exp( - obDy / obH ) ) * obH / obDy;
	float fogFactor = 1.0 - exp( - obBase * max( obTau, 0.0 ) );

	vec3 obFogColor = fogColor;

	#if NUM_DIR_LIGHTS > 0

		float obMu = dot( obDir, directionalLights[ 0 ].direction );
		const float obG = 0.70;
		float obDen = 1.0 + obG * obG - 2.0 * obG * obMu;
		float obPhase = ( 1.0 - obG * obG ) / ( 12.5663706 * max( 0.03, obDen * sqrt( max( 0.03, obDen ) ) ) );
		float obGlow = clamp( obPhase * 2.4, 0.0, 0.9 );
		obFogColor = mix( fogColor, fogColor * 0.5 + directionalLights[ 0 ].color * ${inscatter}, obGlow );

	#endif

	gl_FragColor.rgb = mix( gl_FragColor.rgb, obFogColor, clamp( fogFactor, 0.0, 1.0 ) );

#endif
`;

  return true;
}
