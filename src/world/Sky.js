import * as THREE from 'three';

/**
 * Analytic scattering sky, cloud layer, sun/moon discs and star field, plus the
 * image-based-lighting probe generated from all of it.
 *
 * The daytime luminance and chromaticity come from the Preetham all-weather
 * model (Perez five-parameter distribution driven by turbidity and solar zenith
 * angle), converted xyY -> CIE XYZ -> linear sRGB. Preetham degenerates as the
 * sun approaches the horizon, so the solar zenith angle is clamped and the last
 * few degrees of sunset are carried by an explicit airmass extinction term,
 * which is also what tints the sun disc and the horizon glow. Below the horizon
 * the whole thing cross-fades into a night model with a moon, a Milky Way band
 * and a hash-generated star field.
 *
 * The same material is rendered twice: once as a backside box locked to the
 * camera (the visible sky) and once into a small cube target that is run
 * through PMREM to become `scene.environment`. That is what makes metal in this
 * level reflect the actual sky it is standing under, at whatever time of day
 * the level is currently set to, without a single asset file.
 */

const SKY_VERT = /* glsl */`
varying vec3 vRay;

void main() {
  vRay = position;
  vec4 clip = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  // Pin the sky to the far plane (z/w = 1) so it can be drawn *after* the
  // opaque pass with a LESS-EQUAL test: every pixel already covered by geometry
  // fails the test and is never shaded. On a 140 m street that is most of them.
  gl_Position = vec4( clip.xy, clip.w, clip.w );
}
`;

const SKY_FRAG = /* glsl */`
precision highp float;

uniform vec3  uSunDir;
uniform vec3  uMoonDir;
uniform vec3  uSunTint;
uniform vec3  uMoonTint;
uniform vec3  uGroundColor;
uniform float uTurbidity;
uniform float uSkyLuminance;
uniform float uSunDiscIntensity;
uniform float uNight;
uniform float uCloudCover;
uniform float uCloudSharp;
uniform vec2  uCloudWind;
uniform float uCloudLight;
uniform float uHaze;
uniform float uStars;
uniform float uTime;

varying vec3 vRay;

const float PI = 3.141592653589793;

/* ---------------- noise ---------------- */

float hash21( vec2 p ) {
  p = fract( p * vec2( 123.34, 456.21 ) );
  p += dot( p, p + 45.32 );
  return fract( p.x * p.y );
}

float hash31( vec3 p ) {
  p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
  p += dot( p, p.yxz + 33.33 );
  return fract( ( p.x + p.y ) * p.z );
}

float vnoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  float a = hash21( i );
  float b = hash21( i + vec2( 1.0, 0.0 ) );
  float c = hash21( i + vec2( 0.0, 1.0 ) );
  float d = hash21( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}

float fbm( vec2 p, int oct ) {
  float s = 0.0, a = 0.5, n = 0.0;
  mat2 rot = mat2( 0.8, 0.6, -0.6, 0.8 );
  for ( int i = 0; i < 6; i ++ ) {
    if ( i >= oct ) break;
    s += vnoise( p ) * a;
    n += a;
    p = rot * p * 2.03 + 17.1;
    a *= 0.52;
  }
  return s / max( n, 1e-4 );
}

/* ---------------- Preetham ---------------- */

vec3 xyYToLinearRGB( float x, float y, float Y ) {
  float yy = max( y, 1e-4 );
  float X = ( x / yy ) * Y;
  float Z = ( ( 1.0 - x - yy ) / yy ) * Y;
  mat3 M = mat3(
     3.2404542, -0.9692660,  0.0556434,
    -1.5371385,  1.8760108, -0.2040259,
    -0.4985314,  0.0415560,  1.0572252
  );
  return M * vec3( X, Y, Z );
}

float perez( float cosTheta, float gamma, float cosGamma, float A, float B, float C, float D, float E ) {
  return ( 1.0 + A * exp( B / max( cosTheta, 0.022 ) ) )
       * ( 1.0 + C * exp( D * gamma ) + E * cosGamma * cosGamma );
}

vec3 preethamSky( vec3 dir, vec3 sun, float T ) {
  float thetaS = acos( clamp( sun.y, -0.02, 1.0 ) );
  thetaS = min( thetaS, 1.5184 );                 // 87 degrees: the model dies past this
  float cosThetaS = cos( thetaS );

  float cosTheta = max( dir.y, 0.0 );
  float cosGamma = clamp( dot( dir, sun ), -1.0, 1.0 );
  float gamma = acos( cosGamma );

  float AY =  0.1787 * T - 1.4630;
  float BY = -0.3554 * T + 0.4275;
  float CY = -0.0227 * T + 5.3251;
  float DY =  0.1206 * T - 2.5771;
  float EY = -0.0670 * T + 0.3703;

  float Ax = -0.0193 * T - 0.2592;
  float Bx = -0.0665 * T + 0.0008;
  float Cx = -0.0004 * T + 0.2125;
  float Dx = -0.0641 * T - 0.8989;
  float Ex = -0.0033 * T + 0.0452;

  float Ay = -0.0167 * T - 0.2608;
  float By = -0.0950 * T + 0.0092;
  float Cy = -0.0079 * T + 0.2102;
  float Dy = -0.0441 * T - 1.6537;
  float Ey = -0.0109 * T + 0.0529;

  float chi = ( 4.0 / 9.0 - T / 120.0 ) * ( PI - 2.0 * thetaS );
  float Yz = ( 4.0453 * T - 4.9710 ) * tan( chi ) - 0.2155 * T + 2.4192;

  float t2 = thetaS * thetaS;
  float t3 = t2 * thetaS;
  float xz = ( 0.00166 * t3 - 0.00375 * t2 + 0.00209 * thetaS ) * T * T
           + ( -0.02903 * t3 + 0.06377 * t2 - 0.03202 * thetaS + 0.00394 ) * T
           + ( 0.11693 * t3 - 0.21196 * t2 + 0.06052 * thetaS + 0.25886 );
  float yz = ( 0.00275 * t3 - 0.00610 * t2 + 0.00317 * thetaS ) * T * T
           + ( -0.04214 * t3 + 0.08970 * t2 - 0.04153 * thetaS + 0.00516 ) * T
           + ( 0.15346 * t3 - 0.26756 * t2 + 0.06670 * thetaS + 0.26688 );

  float denomY = perez( 1.0, thetaS, cosThetaS, AY, BY, CY, DY, EY );
  float denomx = perez( 1.0, thetaS, cosThetaS, Ax, Bx, Cx, Dx, Ex );
  float denomy = perez( 1.0, thetaS, cosThetaS, Ay, By, Cy, Dy, Ey );

  float Y = max( 0.0, Yz ) * perez( cosTheta, gamma, cosGamma, AY, BY, CY, DY, EY ) / max( denomY, 1e-3 );
  float x = xz * perez( cosTheta, gamma, cosGamma, Ax, Bx, Cx, Dx, Ex ) / max( denomx, 1e-3 );
  float y = yz * perez( cosTheta, gamma, cosGamma, Ay, By, Cy, Dy, Ey ) / max( denomy, 1e-3 );

  vec3 rgb = xyYToLinearRGB( x, y, Y * 0.055 );
  return max( rgb, vec3( 0.0 ) );
}

/* ---------------- clouds ---------------- */

float cloudDensity( vec2 p, float cover, int oct ) {
  float n = fbm( p, oct );
  // billowy edge: square the shaped noise so tops stay dense and edges wisp out
  float d = smoothstep( cover, cover + uCloudSharp, n );
  return d * d * ( 3.0 - 2.0 * d );
}

void main() {
  vec3 dir = normalize( vRay );
  vec3 sun = normalize( uSunDir );
  vec3 moon = normalize( uMoonDir );

  float up = dir.y;
  float dayFactor = 1.0 - uNight;

  /* ---- base sky ---- */
  vec3 sky = preethamSky( dir, sun, uTurbidity ) * uSkyLuminance * dayFactor;

  // Twilight and low-sun warmth: the horizon band around the sun's azimuth.
  vec3 sunFlat = normalize( vec3( sun.x, 0.0, sun.z ) + vec3( 1e-4 ) );
  vec3 dirFlat = normalize( vec3( dir.x, 0.0, dir.z ) + vec3( 1e-4 ) );
  float azimuthAlign = max( 0.0, dot( dirFlat, sunFlat ) );
  float horizonBand = exp( - abs( up ) * 7.5 );
  float lowSun = smoothstep( 0.42, -0.06, sun.y );
  sky += uSunTint * horizonBand * pow( azimuthAlign, 3.0 ) * 2.6 * lowSun * dayFactor;
  sky += uSunTint * exp( - abs( up ) * 3.0 ) * 0.22 * lowSun * dayFactor;

  /* ---- night sky ---- */
  vec3 night = mix( vec3( 0.0075, 0.0115, 0.0215 ), vec3( 0.0022, 0.0034, 0.0075 ), smoothstep( 0.0, 0.65, up ) );
  // sodium-vapour glow off the town, bounced into the haze
  night += vec3( 0.055, 0.030, 0.012 ) * exp( - max( up, 0.0 ) * 9.0 ) * 0.55;

  if ( uStars > 0.001 ) {
    // Milky Way: a wide fbm band tilted across the dome.
    float band = exp( - pow( abs( dot( dir, normalize( vec3( 0.55, 0.42, -0.72 ) ) ) ) * 3.4, 2.0 ) );
    float mw = fbm( dir.xz * 5.5 / max( 0.15, abs( dir.y ) + 0.35 ) + 4.0, 4 );
    night += vec3( 0.030, 0.034, 0.052 ) * band * smoothstep( 0.35, 0.85, mw ) * uStars;

    vec3 sc = dir * 260.0;
    vec3 cell = floor( sc );
    float h = hash31( cell );
    float bright = pow( max( 0.0, h - 0.9825 ) * 57.0, 3.0 );
    vec3 jitter = vec3( hash31( cell + 3.1 ), hash31( cell + 7.7 ), hash31( cell + 11.3 ) ) - 0.5;
    float d = length( fract( sc ) - 0.5 - jitter * 0.6 );
    float twinkle = 0.65 + 0.35 * sin( uTime * 2.3 + h * 90.0 );
    float star = bright * smoothstep( 0.34, 0.0, d ) * twinkle;
    vec3 starTint = mix( vec3( 0.75, 0.82, 1.0 ), vec3( 1.0, 0.86, 0.68 ), hash31( cell + 21.9 ) );
    night += starTint * star * 3.2 * uStars * smoothstep( -0.02, 0.14, up );
  }

  sky += night * uNight;

  /* ---- moon ---- */
  float cosMoon = dot( dir, moon );
  float moonR = 0.0125;
  float moonDisc = smoothstep( cos( moonR * 1.25 ), cos( moonR * 0.88 ), cosMoon );
  if ( moonDisc > 0.0 ) {
    // crude maria so the disc is not a flat white circle
    vec3 mt = normalize( cross( moon, vec3( 0.0, 1.0, 0.0 ) ) );
    vec3 mb = cross( moon, mt );
    vec2 mp = vec2( dot( dir, mt ), dot( dir, mb ) ) / moonR;
    float maria = 0.78 + 0.22 * fbm( mp * 1.7 + 9.0, 3 );
    float limb = sqrt( max( 0.0, 1.0 - dot( mp, mp ) * 0.92 ) );
    sky += uMoonTint * moonDisc * maria * ( 0.45 + 0.55 * limb ) * 14.0 * uNight;
  }
  sky += uMoonTint * pow( max( cosMoon, 0.0 ), 900.0 ) * 1.4 * uNight;
  sky += uMoonTint * pow( max( cosMoon, 0.0 ), 26.0 ) * 0.055 * uNight;

  /* ---- sun disc + aureole ---- */
  float cosSun = dot( dir, sun );
  float sunR = 0.0058;
  float ang = acos( clamp( cosSun, -1.0, 1.0 ) );
  float disc = smoothstep( sunR * 1.35, sunR * 0.72, ang );
  float limbDark = mix( 0.62, 1.0, sqrt( max( 0.0, 1.0 - pow( min( ang / sunR, 1.0 ), 2.0 ) ) ) );
  float aboveHorizon = smoothstep( -0.035, 0.02, sun.y );
  sky += uSunTint * disc * limbDark * uSunDiscIntensity * aboveHorizon;
  sky += uSunTint * pow( max( cosSun, 0.0 ), 2400.0 ) * uSunDiscIntensity * 0.10 * aboveHorizon;
  sky += uSunTint * pow( max( cosSun, 0.0 ), 90.0 ) * 0.16 * aboveHorizon * dayFactor;
  sky += uSunTint * pow( max( cosSun, 0.0 ), 8.0 ) * 0.04 * aboveHorizon * dayFactor;

  /* ---- clouds ---- */
  if ( up > 0.006 && uCloudCover < 0.995 ) {
    float t = 1.0 / up;

    // cumulus deck
    vec2 cp = dir.xz * t * 0.95 + uCloudWind;
    float d = cloudDensity( cp, uCloudCover, 4 );

    // self shadowing: sample toward the sun and darken where it is occluded
    vec2 lightStep = normalize( sun.xz + vec2( 1e-4 ) ) * 0.55;
    float dl = cloudDensity( cp + lightStep, uCloudCover, 2 );
    float lit = clamp( 1.0 - dl * 0.85, 0.0, 1.0 );

    vec3 base = mix( vec3( 0.16, 0.17, 0.20 ), vec3( 1.0, 0.985, 0.955 ), lit );
    vec3 cloudCol = base * uCloudLight;
    // silver lining where we look through a thin edge toward the sun
    cloudCol += uSunTint * pow( max( cosSun, 0.0 ), 14.0 ) * ( 1.0 - d ) * d * 5.0 * dayFactor;
    cloudCol = mix( cloudCol * 0.10 + uMoonTint * 0.42 * lit, cloudCol, dayFactor );

    float edgeFade = smoothstep( 0.006, 0.11, up );
    float a = clamp( d * edgeFade, 0.0, 1.0 );
    sky = mix( sky, cloudCol, a * 0.94 );

    // high cirrus, stretched and thin
    vec2 hp = dir.xz * t * 0.34 + uCloudWind * 0.35 + 31.0;
    float hc = fbm( vec2( hp.x * 0.55, hp.y * 2.1 ), 3 );
    float ha = smoothstep( 0.56, 0.86, hc ) * edgeFade * 0.42 * ( 1.0 - a );
    sky = mix( sky, ( vec3( 1.0, 0.97, 0.95 ) * uCloudLight * 0.85 + uSunTint * 0.35 ) * mix( 0.12, 1.0, dayFactor ), ha );
  }

  /* ---- ground half and horizon haze ---- */
  float below = smoothstep( 0.02, -0.06, up );
  vec3 ground = uGroundColor * ( 0.55 + 0.45 * dayFactor );
  sky = mix( sky, ground, below );

  float haze = uHaze * exp( - max( abs( up ), 0.0 ) * 5.0 );
  vec3 hazeCol = mix( uGroundColor * 1.4, uSunTint, 0.35 * azimuthAlign );
  sky = mix( sky, hazeCol * ( 0.55 + 0.45 * dayFactor ), clamp( haze, 0.0, 0.85 ) );

  gl_FragColor = vec4( max( sky, vec3( 0.0 ) ), 1.0 );
}
`;

export class Sky {
  constructor(world) {
    this.world = world;
    this.game = world.game;
    this.envRT = null;
    this._pmremRT = null;
    this._dirty = true;
  }

  init() {
    const preset = this.game.settings?.preset ?? 'high';
    const cubeSize = preset === 'low' || preset === 'medium' ? 128 : 256;

    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(0.6, 0.5, 0.6) },
      uMoonDir: { value: new THREE.Vector3(-0.6, 0.5, -0.6) },
      uSunTint: { value: new THREE.Color(1, 0.95, 0.88) },
      uMoonTint: { value: new THREE.Color(0.62, 0.72, 1.0) },
      uGroundColor: { value: new THREE.Color(0.10, 0.085, 0.065) },
      uTurbidity: { value: 3.4 },
      uSkyLuminance: { value: 1.0 },
      uSunDiscIntensity: { value: 90 },
      uNight: { value: 0 },
      uCloudCover: { value: 0.52 },
      uCloudSharp: { value: 0.22 },
      uCloudWind: { value: new THREE.Vector2(0, 0) },
      uCloudLight: { value: 1.0 },
      uHaze: { value: 0.10 },
      uStars: { value: 0 },
      uTime: { value: 0 },
    };

    this.material = new THREE.ShaderMaterial({
      name: 'ob.sky',
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      depthFunc: THREE.LessEqualDepth,
      fog: false,
      toneMapped: false,
      lights: false,
    });

    const geo = new THREE.BoxGeometry(2, 2, 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'sky';
    this.mesh.renderOrder = 9000;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.matrixAutoUpdate = false;
    // Excluded from the g-buffer prepass by PostFX's depthWrite===false rule,
    // and pinned to the camera at draw time so it can never be walked out of.
    this.mesh.userData.postfxIgnore = true;
    this.mesh.onBeforeRender = (renderer, scene, camera) => {
      this.mesh.position.copy(camera.position);
      this.mesh.updateMatrix();
      this.mesh.updateMatrixWorld(true);
    };
    this.game.scene.add(this.mesh);

    // Probe scene: the same shader, rendered into a cube for IBL.
    this.probeScene = new THREE.Scene();
    this.probeMesh = new THREE.Mesh(geo, this.material);
    this.probeMesh.frustumCulled = false;
    this.probeScene.add(this.probeMesh);

    this.cubeRT = new THREE.WebGLCubeRenderTarget(cubeSize, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.cubeCamera = new THREE.CubeCamera(0.1, 10, this.cubeRT);

    this.pmrem = new THREE.PMREMGenerator(this.game.renderer);
    try { this.pmrem.compileCubemapShader(); } catch { /* software GL can be picky */ }

    return this;
  }

  /** Push a full parameter set; the environment probe is marked stale. */
  apply(p) {
    const u = this.uniforms;
    u.uSunDir.value.copy(p.sunDir);
    u.uMoonDir.value.copy(p.moonDir);
    u.uSunTint.value.copy(p.sunTint);
    u.uMoonTint.value.copy(p.moonTint);
    u.uGroundColor.value.copy(p.groundColor);
    u.uTurbidity.value = p.turbidity;
    u.uSkyLuminance.value = p.skyLuminance;
    u.uSunDiscIntensity.value = p.sunDiscIntensity;
    u.uNight.value = p.night;
    u.uCloudCover.value = p.cloudCover;
    u.uCloudLight.value = p.cloudLight;
    u.uHaze.value = p.haze;
    u.uStars.value = p.stars;
    this._dirty = true;
  }

  update(dt) {
    const u = this.uniforms;
    u.uTime.value += dt;
    // Clouds drift; the probe is not refreshed for this, only for time of day.
    u.uCloudWind.value.x += dt * 0.0065;
    u.uCloudWind.value.y += dt * 0.0022;
  }

  /**
   * Re-render the sky into the cube target and re-filter it into a PMREM
   * environment map. Costs a few milliseconds, so it is only run when the time
   * of day actually moved.
   */
  refreshEnvironment(force = false) {
    if (!force && !this._dirty) return null;
    this._dirty = false;
    const renderer = this.game.renderer;
    if (!renderer) return null;

    const prevTarget = renderer.getRenderTarget();
    try {
      this.cubeCamera.update(renderer, this.probeScene);
      const next = this.pmrem.fromCubemap(this.cubeRT.texture);
      if (this._pmremRT && this._pmremRT !== next) this._pmremRT.dispose();
      this._pmremRT = next;
      this.envMap = next.texture;
    } catch (err) {
      console.warn('[World] environment probe failed', err);
    }
    renderer.setRenderTarget(prevTarget);
    return this.envMap || null;
  }

  dispose() {
    this.material?.dispose();
    this.mesh?.geometry?.dispose();
    this.cubeRT?.dispose();
    this._pmremRT?.dispose();
    this.pmrem?.dispose();
  }
}
