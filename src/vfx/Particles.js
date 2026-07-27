import * as THREE from 'three';
import { EMISSIVE_RANGE } from './Textures.js';

/**
 * GPU particle system.
 *
 * Simulation happens entirely in the vertex shader from the spawn parameters:
 * position, velocity, linear drag, gravity and wind are integrated *analytically*
 * (closed form for `dv/dt = -k(v - w) + g`), so a particle's state at any time
 * is a pure function of its birth record. The CPU writes 24 floats once, at
 * spawn, into an interleaved instance buffer and never re-simulates them.
 *
 * Liveness is *not* left to the shader alone. The pool is packed: live records
 * occupy `[0, count)` and a dead record is swap-removed with the last live one,
 * so `instanceCount` is the live high-water mark and dead slots are never even
 * submitted. On top of that the vertex shader collapses anything it cannot
 * prove alive — including a slot poisoned by NaN — to a degenerate vertex
 * outside the clip volume, because a single garbage quad in an additive layer
 * is a veil over the whole frame.
 *
 * Per-layer features:
 *   - soft depth fade against the g-buffer depth (which doubles as a manual
 *     depth test, so particles are correctly occluded even though the HDR
 *     colour target has no depth attachment); disabled outright when no depth
 *     texture is available rather than sampling whatever is bound;
 *   - flipbook animation over an atlas with optional inter-frame blending;
 *   - per-particle rotation + spin, or velocity-aligned stretching in either
 *     screen-relative or world-length modes (tracers);
 *   - colour/alpha/size/emissive/turbulence curves sampled from a baked ramp
 *     LUT, one row pair per profile;
 *   - three shading models: unlit (sparks), normal-mapped lit (smoke — the
 *     sprite's RGB is a normal baked from the density gradient) and cheap
 *     hemispheric shading (solid debris).
 */

const STRIDE = 24;

/** Hard ceilings; anything past these is a bug upstream, not an effect. */
const MAX_LIFE = 120;
const MAX_SPEED = 1e4;
const MAX_COORD = 1e6;
const MAX_SIZE = 200;

export const MODE = { UNLIT: 0, LIT: 1, SHADED: 2 };
export const STRETCH = { NONE: 0, VELOCITY: 1, WORLD: 2 };

const VERT = /* glsl */`
precision highp float;

attribute vec4 aSpawn;   // xyz position, w spawn time
attribute vec4 aVel;     // xyz velocity, w life
attribute vec4 aSize;    // size0, size1, rot0, spin
attribute vec4 aDyn;     // drag, gravityScale, stretch, seed
attribute vec4 aColor;   // rgb tint, a alpha
attribute vec4 aMisc;    // profile, frame0, frameSpan, softness

uniform float uTime;
uniform vec3  uGravity;
uniform vec3  uWind;
uniform float uWindScale;
uniform vec2  uAtlas;      // tilesX, tilesY
uniform sampler2D uRamp;
uniform float uRampRows;
uniform float uTurbScale;
uniform float uSizeScale;
uniform float uStretchScale;

varying vec4 vColor;
varying vec2 vUvA;
varying vec2 vUvB;
varying vec4 vParams;    // frameBlend, viewZ, softness, emissive
varying vec4 vScreen;
varying vec3 vViewPos;
varying vec2 vRot;       // cos, sin
varying vec2 vQuad;      // -0.5..0.5 quad coords, for the fake sphere normal

vec2 tileOffset( float index ) {
  float col = mod( index, uAtlas.x );
  float row = floor( index / uAtlas.x );
  return vec2( col, uAtlas.y - 1.0 - row );
}

/**
 * Collapse this vertex to a point outside the clip volume. All four corners of
 * the quad land on the same clipped point, so the primitive is discarded before
 * rasterisation: exactly zero fill, zero blend, whatever the attributes hold.
 */
void killVertex() {
  gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
  vColor = vec4( 0.0 );
  vUvA = vec2( 0.0 );
  vUvB = vec2( 0.0 );
  vParams = vec4( 0.0, 1.0, 1.0, 0.0 );
  vScreen = vec4( 0.0, 0.0, 1.0, 1.0 );
  vViewPos = vec3( 0.0, 0.0, -1.0 );
  vRot = vec2( 1.0, 0.0 );
  vQuad = vec2( 0.0 );
}

void main() {
  float life = aVel.w;
  float age = uTime - aSpawn.w;
  float t = age / max( life, 1e-4 );

  // Every test is written as a *negated* comparison so that NaN — which fails
  // every comparison — takes the dead branch instead of sneaking through.
  // A never-written slot reads life = 0 and dies here too.
  if ( !( life > 0.0 ) || !( age >= 0.0 ) || !( t < 1.0 ) ) {
    killVertex();
    return;
  }

  /* ---- analytic motion ------------------------------------------------- */
  vec3 g = uGravity * aDyn.y;
  vec3 w = uWind * uWindScale;
  float k = aDyn.x;
  vec3 pos, vel;
  if ( k > 0.02 ) {
    vec3 vt = w + g / k;                       // terminal velocity
    float e = exp( -k * age );
    pos = aSpawn.xyz + vt * age + ( aVel.xyz - vt ) * ( 1.0 - e ) / k;
    vel = ( aVel.xyz - vt ) * e + vt;
  } else {
    pos = aSpawn.xyz + aVel.xyz * age + 0.5 * g * age * age;
    vel = aVel.xyz + g * age;
  }

  /* ---- curves ---------------------------------------------------------- */
  float rowC = ( aMisc.x * 2.0 + 0.5 ) / uRampRows;
  float rowS = ( aMisc.x * 2.0 + 1.5 ) / uRampRows;
  vec4 ramp = texture2D( uRamp, vec2( t, rowC ) );
  vec4 curve = texture2D( uRamp, vec2( t, rowS ) );

  float emissive = 1.0 + curve.g * 3.0;
  vColor = vec4( ramp.rgb * ${EMISSIVE_RANGE.toFixed(1)} * aColor.rgb * emissive, ramp.a * aColor.a );

  /* ---- turbulence ------------------------------------------------------ */
  float seed = aDyn.w;
  float turb = curve.b * uTurbScale;
  if ( turb > 0.001 ) {
    float s = seed * 63.71;
    vec3 wob = vec3(
      sin( age * 1.73 + s ),
      sin( age * 1.19 + s * 1.7 + 2.1 ),
      sin( age * 2.11 + s * 2.3 + 4.2 )
    ) + 0.45 * vec3(
      sin( age * 4.1 + s * 3.1 ),
      sin( age * 3.3 + s * 5.7 ),
      sin( age * 5.2 + s * 4.3 )
    );
    pos += wob * turb * mix( aSize.x, aSize.y, t ) * t;
  }

  /* ---- billboard ------------------------------------------------------- */
  float size = mix( aSize.x, aSize.y, t ) * curve.r * uSizeScale;

  // Second gate: the integrator can still produce a non-finite position from a
  // pathological drag/velocity pair, and one NaN here poisons the draw call.
  if ( !( dot( pos, pos ) < 1.0e18 ) || !( size > 0.0 ) || !( dot( vel, vel ) >= 0.0 ) ) {
    killVertex();
    return;
  }

  float rot = aSize.z + aSize.w * age;
  float cr = cos( rot ), sr = sin( rot );
  vRot = vec2( cr, sr );
  vQuad = position.xy;

  vec4 mv = modelViewMatrix * vec4( pos, 1.0 );

#if STRETCH_MODE == 0
  vec2 q = position.xy * size;
  mv.xy += vec2( q.x * cr - q.y * sr, q.x * sr + q.y * cr );
#else
  vec3 vsafe = length( vel ) > 1e-4 ? vel : vec3( 0.0, 1.0, 0.0 );
  vec3 vv = normalize( mat3( modelViewMatrix ) * vsafe );
  #if STRETCH_MODE == 1
    float len = max( size, size + aDyn.z * length( vel ) * uStretchScale );
  #else
    float len = max( size, aDyn.z );
  #endif
  vec4 tail = modelViewMatrix * vec4( pos - normalize( vsafe ) * len, 1.0 );
  // position.y in [-0.5,0.5]: +0.5 is the head, -0.5 the tail.
  mv = mix( tail, mv, position.y + 0.5 );
  vec2 axis = vv.xy;
  float al = length( axis );
  axis = al > 1e-4 ? axis / al : vec2( 0.0, 1.0 );
  vec2 perp = vec2( -axis.y, axis.x );
  // A streak pointing at the camera collapses in screen space; fatten it so it
  // reads as a glint rather than disappearing.
  float axial = 1.0 + ( 1.0 - al ) * 1.6;
  mv.xy += perp * ( position.x * size * axial );
#endif

  vViewPos = mv.xyz;
  vParams = vec4( 0.0, -mv.z, max( 0.05, aMisc.w ), emissive );

  /* ---- flipbook -------------------------------------------------------- */
  float frames = uAtlas.x * uAtlas.y;
  float f = aMisc.y + t * aMisc.z;
  float fi = floor( f );
  vParams.x = f - fi;
  vec2 t0 = tileOffset( mod( fi, frames ) );
  vec2 t1 = tileOffset( mod( fi + 1.0, frames ) );
  // Inset by half a texel-ish to keep bilinear taps out of the neighbour tile.
  vec2 iuv = clamp( uv, vec2( 0.004 ), vec2( 0.996 ) );
  vUvA = ( t0 + iuv ) / uAtlas;
  vUvB = ( t1 + iuv ) / uAtlas;

  gl_Position = projectionMatrix * mv;
  vScreen = gl_Position;
}
`;

const FRAG = /* glsl */`
precision highp float;

uniform sampler2D uMap;
uniform sampler2D uDepth;
uniform vec2  uProj;        // near, far
uniform float uSoftEnabled;
uniform vec2  uCamFade;     // start, range
uniform vec3  uSunDir;      // view space, toward the sun
uniform vec3  uSunColor;
uniform vec3  uAmbient;
uniform vec3  uFogColor;
uniform float uFogDensity;
uniform float uScatter;
uniform float uOpacity;

varying vec4 vColor;
varying vec2 vUvA;
varying vec2 vUvB;
varying vec4 vParams;
varying vec4 vScreen;
varying vec3 vViewPos;
varying vec2 vRot;
varying vec2 vQuad;

void main() {
  vec4 tex = texture2D( uMap, vUvA );
#ifdef BLEND_FRAMES
  tex = mix( tex, texture2D( uMap, vUvB ), vParams.x );
#endif

  float alpha = tex.a * vColor.a * uOpacity;
  if ( alpha <= 0.002 ) discard;

  vec3 rgb;
#if SHADE_MODE == 1
  // Sprite RGB is a tangent-space normal baked from the density field; the
  // billboard's tangent frame *is* the view frame, so rotating by the particle
  // roll puts it straight into view space.
  vec3 sn = tex.rgb * 2.0 - 1.0;
  vec2 rn = vec2( sn.x * vRot.x - sn.y * vRot.y, sn.x * vRot.y + sn.y * vRot.x );
  vec3 n = vec3( rn, max( 0.05, sn.z ) );
  // Blend toward a spherical normal so the puff has volume, not just relief.
  float r2 = clamp( dot( vQuad, vQuad ) * 4.0, 0.0, 1.0 );
  vec3 sphere = normalize( vec3( vQuad * 2.0, sqrt( max( 0.02, 1.0 - r2 ) ) ) );
  n = normalize( mix( sphere, normalize( n ), 0.38 ) );

  float ndl = dot( n, uSunDir );
  float wrapped = clamp( ( ndl + 0.85 ) / 1.85, 0.0, 1.0 );
  vec3 lit = uAmbient + uSunColor * wrapped;
  // Forward scattering: looking through the puff toward the sun lights it up.
  vec3 vdir = normalize( vViewPos );
  float fwd = pow( clamp( dot( vdir, -uSunDir ) * 0.5 + 0.5, 0.0, 1.0 ), 5.0 );
  lit += uSunColor * fwd * uScatter * ( 1.0 - alpha * 0.5 );
  // Emissive profiles (fire, embers) share this layer with smoke so they sort
  // against each other correctly, but they must not be *lit* — a flame is its
  // own light source, and multiplying it by the smoke lighting term is what
  // turns a fireball into a flat orange blob.
  float emissiveMix = clamp( vParams.w - 1.0, 0.0, 1.0 );
  rgb = vColor.rgb * mix( lit, vec3( 1.0 ), emissiveMix );
#elif SHADE_MODE == 2
  rgb = vColor.rgb * tex.rgb * ( uAmbient + uSunColor * 0.62 );
#else
  rgb = vColor.rgb * tex.rgb;
#endif

  float viewZ = vParams.y;

  // Soft particles. The same term is a manual depth test: anything behind the
  // recorded scene depth fades to zero, which keeps effects correctly occluded
  // regardless of what the colour target's depth attachment is doing. With no
  // depth texture bound the fade is switched off entirely rather than sampling
  // whatever texture the sampler happens to default to.
  if ( uSoftEnabled > 0.5 ) {
    vec2 suv = vScreen.xy / max( 1e-5, vScreen.w ) * 0.5 + 0.5;
    float d = texture2D( uDepth, suv ).x * 2.0 - 1.0;
    float sceneZ = ( 2.0 * uProj.x * uProj.y ) / ( uProj.y + uProj.x - d * ( uProj.y - uProj.x ) );
    alpha *= clamp( ( sceneZ - viewZ ) / vParams.z, 0.0, 1.0 );
  }

  // Never slap the lens: fade out anything crossing the near plane.
  alpha *= clamp( ( viewZ - uCamFade.x ) / max( 0.001, uCamFade.y ), 0.0, 1.0 );

  float fogT = exp( -uFogDensity * uFogDensity * viewZ * viewZ );
#ifdef ADDITIVE
  rgb *= fogT;
#else
  rgb = mix( uFogColor, rgb, fogT );
#endif

  if ( alpha <= 0.002 ) discard;
  gl_FragColor = vec4( rgb, alpha );
}
`;

/* -------------------------------------------------------------------------- */

const QUAD_POS = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
const QUAD_UV = [0, 0, 1, 0, 1, 1, 0, 1];
const QUAD_INDEX = [0, 1, 2, 0, 2, 3];

/** Finite number or the supplied fallback. Cheap, and called once per spawn. */
function num(v, fallback) {
  return (typeof v === 'number' && v - v === 0) ? v : fallback;
}

function clampAbs(v, limit) {
  return v > limit ? limit : v < -limit ? -limit : v;
}

/**
 * One draw call: a pooled, front-packed set of particles sharing an atlas, a
 * blend mode and a shading model.
 */
export class ParticleLayer {
  constructor(name, opts = {}) {
    this.name = name;
    this.capacity = Math.max(8, opts.capacity | 0 || 256);
    this.opts = opts;
    this.additive = opts.additive === true;
    this.viewmodel = opts.viewmodel === true;
    this.softness = opts.softness ?? 0.6;

    this.geometry = null;
    this.mesh = null;
    this.buffer = null;
    this.array = null;

    this._count = 0;          // live records, packed into [0, count)
    this._evict = 0;          // round-robin victim when the pool is full
    this._dirtyMin = Infinity;
    this._dirtyMax = -Infinity;
    this._time = 0;
    this._spawnCount = 0;
    // Live wind, pushed in by ParticleSystem before anything spawns this frame.
    this._windX = 0;
    this._windY = 0;
    this._windZ = 0;

    this._build();
  }

  _build() {
    // Attributes are per-layer, never shared: BufferGeometry.dispose() frees the
    // GPU buffers of every attribute it references, so a shared quad would be
    // yanked out from under the other layers on a budget change.
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(QUAD_INDEX.slice());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(QUAD_POS.slice(), 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(QUAD_UV.slice(), 2));

    // Never ship a buffer whose contents depend on the allocator: every slot is
    // written to an explicit dead state (life 0, size 0, alpha 0, birth far in
    // the past so age is large) before it can ever reach a draw call.
    this.array = new Float32Array(this.capacity * STRIDE);
    for (let i = 0; i < this.capacity; i++) this._writeDead(i);

    this._expiry = new Float64Array(this.capacity);
    // Conservative world-space bound per live record: cx, cy, cz, radius.
    this._bound = new Float32Array(this.capacity * 4);

    const buf = new THREE.InstancedInterleavedBuffer(this.array, STRIDE, 1);
    buf.setUsage(THREE.DynamicDrawUsage);
    this.buffer = buf;
    geo.setAttribute('aSpawn', new THREE.InterleavedBufferAttribute(buf, 4, 0));
    geo.setAttribute('aVel', new THREE.InterleavedBufferAttribute(buf, 4, 4));
    geo.setAttribute('aSize', new THREE.InterleavedBufferAttribute(buf, 4, 8));
    geo.setAttribute('aDyn', new THREE.InterleavedBufferAttribute(buf, 4, 12));
    geo.setAttribute('aColor', new THREE.InterleavedBufferAttribute(buf, 4, 16));
    geo.setAttribute('aMisc', new THREE.InterleavedBufferAttribute(buf, 4, 20));
    geo.instanceCount = 0;

    // A real, finite bound, recomputed every frame from the live records. It
    // starts empty because an empty pool occupies exactly nothing.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
    this.geometry = geo;

    const o = this.opts;
    const defines = {
      STRETCH_MODE: o.stretch ?? STRETCH.NONE,
      SHADE_MODE: o.mode ?? MODE.UNLIT,
    };
    if (o.blendFrames) defines.BLEND_FRAMES = '';
    if (this.additive) defines.ADDITIVE = '';

    const mat = new THREE.ShaderMaterial({
      name: `vfxParticles.${this.name}`,
      vertexShader: VERT,
      fragmentShader: FRAG,
      defines,
      uniforms: {
        uTime: { value: 0 },
        uGravity: { value: new THREE.Vector3(0, -9.81, 0) },
        uWind: { value: new THREE.Vector3() },
        uWindScale: { value: o.wind ?? 0 },
        uAtlas: { value: new THREE.Vector2(o.tilesX ?? 4, o.tilesY ?? 4) },
        uRamp: { value: o.ramp ?? null },
        uRampRows: { value: o.rampRows ?? 2 },
        uTurbScale: { value: o.turbulence ?? 1 },
        uSizeScale: { value: 1 },
        uStretchScale: { value: o.stretchScale ?? 0.02 },
        uMap: { value: o.map ?? null },
        uDepth: { value: null },
        uProj: { value: new THREE.Vector2(0.05, 2200) },
        uSoftEnabled: { value: 0 },
        uCamFade: { value: new THREE.Vector2(o.camFadeStart ?? 0.28, o.camFadeRange ?? 0.35) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Vector3(1, 0.95, 0.86) },
        uAmbient: { value: new THREE.Vector3(0.25, 0.28, 0.33) },
        uFogColor: { value: new THREE.Vector3(0.5, 0.55, 0.62) },
        uFogDensity: { value: 0 },
        uScatter: { value: o.scatter ?? 0.9 },
        uOpacity: { value: o.opacity ?? 1 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: this.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: false,
      toneMapped: false,
    });
    this.material = mat;

    const mesh = new THREE.Mesh(geo, mat);
    // Bounds are real now, so the pool culls like any other object.
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = o.renderOrder ?? 10;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.postfxIgnore = true;
    this.mesh = mesh;
  }

  /** Stamp slot `i` with a state the vertex shader is guaranteed to reject. */
  _writeDead(i) {
    const o = i * STRIDE;
    const arr = this.array;
    for (let k = 0; k < STRIDE; k++) arr[o + k] = 0;
    arr[o + 3] = -1e6;    // spawn time: age is large
    arr[o + 7] = 0;       // life 0  -> dead
    arr[o + 8] = 0;       // size0 0
    arr[o + 9] = 0;       // size1 0
    arr[o + 19] = 0;      // alpha 0
  }

  setCapacity(n) {
    n = Math.max(8, n | 0);
    if (n === this.capacity) return;
    this.capacity = n;
    const parent = this.mesh?.parent;
    const renderOrder = this.mesh?.renderOrder;
    parent?.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this._build();
    if (renderOrder !== undefined) this.mesh.renderOrder = renderOrder;
    this._count = 0;
    this._evict = 0;
    this._dirtyMin = Infinity;
    this._dirtyMax = -Infinity;
    parent?.add(this.mesh);
  }

  /**
   * Write one particle. Every argument is a scalar so bursts do not allocate.
   * Returns the slot index, or -1 if the request was rejected.
   *
   * Non-finite position, velocity or life is dropped outright: a single NaN in
   * an instance attribute takes the entire draw call with it, so the guard is
   * not optional.
   */
  spawn(
    px, py, pz, vx, vy, vz, life,
    size0, size1, rot, spin, drag, gravity, stretch,
    r, g, b, a, profile, frame0, frameSpan, softness, seed,
  ) {
    // eslint-disable-next-line no-self-compare
    if (!(px - px === 0 && py - py === 0 && pz - pz === 0)) return -1;
    if (!(vx - vx === 0 && vy - vy === 0 && vz - vz === 0)) return -1;
    if (!(life > 0) || !(life - life === 0)) return -1;
    if (Math.abs(px) > MAX_COORD || Math.abs(py) > MAX_COORD || Math.abs(pz) > MAX_COORD) return -1;

    const lf = life > MAX_LIFE ? MAX_LIFE : life;
    const sx = clampAbs(vx, MAX_SPEED);
    const sy = clampAbs(vy, MAX_SPEED);
    const sz = clampAbs(vz, MAX_SPEED);
    let s0 = num(size0, 0); if (s0 < 0) s0 = 0; else if (s0 > MAX_SIZE) s0 = MAX_SIZE;
    let s1 = num(size1, s0); if (s1 < 0) s1 = 0; else if (s1 > MAX_SIZE) s1 = MAX_SIZE;
    if (s0 <= 0 && s1 <= 0) return -1;
    const alpha = num(a, 1);
    if (!(alpha > 0)) return -1;

    const dragK = Math.max(0, num(drag, 0));
    const grav = num(gravity, 0);
    const str = Math.max(0, num(stretch, 0));

    const i = this._acquire();
    const o = i * STRIDE;
    const arr = this.array;
    const t = this._time;
    arr[o] = px; arr[o + 1] = py; arr[o + 2] = pz; arr[o + 3] = t;
    arr[o + 4] = sx; arr[o + 5] = sy; arr[o + 6] = sz; arr[o + 7] = lf;
    arr[o + 8] = s0; arr[o + 9] = s1; arr[o + 10] = num(rot, 0); arr[o + 11] = num(spin, 0);
    arr[o + 12] = dragK; arr[o + 13] = grav; arr[o + 14] = str; arr[o + 15] = num(seed, 0);
    arr[o + 16] = num(r, 1); arr[o + 17] = num(g, 1); arr[o + 18] = num(b, 1); arr[o + 19] = alpha;
    arr[o + 20] = Math.max(0, num(profile, 0));
    arr[o + 21] = Math.max(0, num(frame0, 0));
    arr[o + 22] = Math.max(0, num(frameSpan, 0));
    arr[o + 23] = softness === undefined ? this.softness : Math.max(0.01, num(softness, this.softness));

    this._expiry[i] = t + lf;

    /* ---- world bound for this record ------------------------------------ */
    // The shader's integrator is closed form, so the CPU can evaluate the exact
    // end point and bound the record by the chord between birth and death
    // rather than by a wild over-estimate. The 0.65 factor on the chord covers
    // the curvature of the drag path.
    const ws = this.opts.wind ?? 0;
    const wx = this._windX * ws, wy = this._windY * ws, wz = this._windZ * ws;
    const gy = -9.81 * grav;
    let ex, ey, ez;
    if (dragK > 0.02) {
      const vty = wy + gy / dragK;
      const decay = (1 - Math.exp(-dragK * lf)) / dragK;
      ex = wx * lf + (sx - wx) * decay;
      ey = vty * lf + (sy - vty) * decay;
      ez = wz * lf + (sz - wz) * decay;
    } else {
      ex = sx * lf + wx * lf;
      ey = sy * lf + 0.5 * gy * lf * lf + wy * lf;
      ez = sz * lf + wz * lf;
    }
    let chord = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (!(chord >= 0)) { ex = ey = ez = 0; chord = 0; }
    const big = s0 > s1 ? s0 : s1;
    // Turbulence displaces by at most ~1.45 * turbScale * size; the stretch
    // modes trail the record backwards by `stretch` metres; the sprite itself
    // is `big` across.
    const pad = big * 1.2 + (this.opts.turbulence ?? 0) * big * 1.5 + str + 0.5;
    const bo = i * 4;
    this._bound[bo] = px + ex * 0.5;
    this._bound[bo + 1] = py + ey * 0.5;
    this._bound[bo + 2] = pz + ez * 0.5;
    this._bound[bo + 3] = Math.min(chord * 0.65 + pad, MAX_COORD);

    this._markDirty(i);
    this._spawnCount++;
    return i;
  }

  /** A free slot, or the round-robin victim when the pool is saturated. */
  _acquire() {
    if (this._count < this.capacity) return this._count++;
    const i = this._evict;
    this._evict = (i + 1) % this.capacity;
    return i;
  }

  _markDirty(i) {
    if (i < this._dirtyMin) this._dirtyMin = i;
    if (i > this._dirtyMax) this._dirtyMax = i;
  }

  /**
   * Retire dead records, upload the frame's dirty range, refresh the bound and
   * set `instanceCount` to the live high-water mark.
   */
  flush(time) {
    this._time = (time - time === 0) ? time : this._time;
    this.material.uniforms.uTime.value = this._time;
    const now = this._time;

    /* ---- swap-remove the dead so live records stay packed at the front --- */
    const arr = this.array;
    const exp = this._expiry;
    const bnd = this._bound;
    let n = this._count;
    for (let i = 0; i < n;) {
      if (exp[i] > now) { i++; continue; }
      n--;
      if (i !== n) {
        arr.copyWithin(i * STRIDE, n * STRIDE, n * STRIDE + STRIDE);
        bnd.copyWithin(i * 4, n * 4, n * 4 + 4);
        exp[i] = exp[n];
        this._markDirty(i);
        // Re-test the record just moved into i.
      }
      // The vacated tail slot goes back to an explicit dead state so it can
      // never be drawn even if instanceCount were wrong.
      this._writeDead(n);
      exp[n] = -1;
    }
    this._count = n;
    if (this._evict >= n) this._evict = 0;

    if (this._dirtyMax >= this._dirtyMin) {
      const start = this._dirtyMin * STRIDE;
      const count = (this._dirtyMax - this._dirtyMin + 1) * STRIDE;
      const buf = this.buffer;
      if (typeof buf.clearUpdateRanges === 'function') {
        buf.clearUpdateRanges();
        buf.addUpdateRange(start, count);
      } else if (buf.updateRange) {
        buf.updateRange.offset = start;
        buf.updateRange.count = count;
      }
      buf.needsUpdate = true;
      this._dirtyMin = Infinity;
      this._dirtyMax = -Infinity;
    }

    this.geometry.instanceCount = n;
    this._updateBounds(n);
  }

  /** Union of the live records' conservative bounds. O(live), no allocation. */
  _updateBounds(n) {
    const sphere = this.geometry.boundingSphere;
    const box = this.geometry.boundingBox;
    if (n <= 0) {
      sphere.center.set(0, 0, 0);
      sphere.radius = 0;
      box.min.set(0, 0, 0);
      box.max.set(0, 0, 0);
      return;
    }
    const b = this._bound;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const r = b[o + 3];
      const x = b[o], y = b[o + 1], z = b[o + 2];
      if (x - r < minX) minX = x - r;
      if (y - r < minY) minY = y - r;
      if (z - r < minZ) minZ = z - r;
      if (x + r > maxX) maxX = x + r;
      if (y + r > maxY) maxY = y + r;
      if (z + r > maxZ) maxZ = z + r;
    }
    const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5;
    // Second pass for the radius: the box diagonal is a much looser sphere than
    // the farthest record actually needs, and this pool is drawn every frame.
    let rad = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const dx = b[o] - cx, dy = b[o + 1] - cy, dz = b[o + 2] - cz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + b[o + 3];
      if (d > rad) rad = d;
    }
    sphere.center.set(cx, cy, cz);
    sphere.radius = rad;
    box.min.set(minX, minY, minZ);
    box.max.set(maxX, maxY, maxZ);
  }

  clear() {
    for (let i = 0; i < this.capacity; i++) this._writeDead(i);
    this._expiry.fill(-1);
    this.buffer.needsUpdate = true;
    this._count = 0;
    this._evict = 0;
    this._dirtyMin = Infinity;
    this._dirtyMax = -Infinity;
    this.geometry.instanceCount = 0;
    this._updateBounds(0);
  }

  /** Live record count — what the draw call actually submits. */
  get live() { return this._count; }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

/* -------------------------------------------------------------------------- */

/**
 * Owns every layer, distributes `settings.particleBudget` between them and
 * pushes the shared per-frame environment (sun, fog, wind, depth) into each.
 */
export class ParticleSystem {
  constructor(game, textures) {
    this.game = game;
    this.textures = textures;
    this.layers = new Map();
    this.time = 0;
    this._sunDirView = new THREE.Vector3(0, 1, 0);
    this._sunColor = new THREE.Vector3(1, 0.95, 0.86);
    this._ambient = new THREE.Vector3(0.22, 0.25, 0.30);
    this._fogColor = new THREE.Vector3(0.5, 0.55, 0.62);
    this._fogDensity = 0;
    this.wind = new THREE.Vector3(0.9, 0, 0.5);
    this._budget = 0;
  }

  add(name, opts) {
    const layer = new ParticleLayer(name, opts);
    this.layers.set(name, layer);
    const target = opts.viewmodel ? this.game.engine?.viewScene : this.game.scene;
    target?.add(layer.mesh);
    return layer;
  }

  get(name) { return this.layers.get(name); }

  setBudget(total, weights) {
    if (Math.abs(total - this._budget) < 32) return;
    this._budget = total;
    for (const [name, layer] of this.layers) {
      const w = weights[name];
      if (w === undefined) continue;
      const cap = typeof w === 'number' && w >= 1 ? w : Math.max(48, Math.round(total * w));
      layer.setCapacity(cap);
      const target = layer.viewmodel ? this.game.engine?.viewScene : this.game.scene;
      if (!layer.mesh.parent) target?.add(layer.mesh);
    }
  }

  /** Per-frame environment sync. Cheap: a handful of uniform writes per layer. */
  update(dt, camera, viewCamera, depthTexture, softEnabled) {
    const d = (dt - dt === 0) ? dt : 0;
    this.time += d;
    const scene = this.game.scene;
    const fog = scene?.fog;
    if (fog && fog.isFogExp2) {
      this._fogColor.set(fog.color.r, fog.color.g, fog.color.b);
      this._fogDensity = fog.density;
    } else if (fog && fog.color) {
      this._fogColor.set(fog.color.r, fog.color.g, fog.color.b);
      this._fogDensity = 0;
    }

    const sun = this.game.world?.sun || this.game.world?.sunLight || null;
    if (sun && sun.isLight && camera) {
      const tgt = sun.target?.position;
      this._sunDirView.copy(sun.position);
      if (tgt) this._sunDirView.sub(tgt);
      if (this._sunDirView.lengthSq() < 1e-8) this._sunDirView.set(0, 1, 0);
      this._sunDirView.normalize().transformDirection(camera.matrixWorldInverse);
      const c = sun.color;
      const i = sun.intensity ?? 1;
      if (c) this._sunColor.set(c.r * i, c.g * i, c.b * i).multiplyScalar(0.6);
    }
    const amb = this.game.world?.ambientColor;
    if (amb) this._ambient.set(amb.r, amb.g, amb.b);

    // A non-finite wind vector would poison every bound estimate downstream.
    if (!(this.wind.lengthSq() >= 0)) this.wind.set(0, 0, 0);
    if (this.wind.lengthSq() > 2500) this.wind.setLength(50);
    // No depth texture means no manual depth test: switch the fade off rather
    // than sampling whatever sampler slot happens to be bound.
    const soft = !!(softEnabled && depthTexture);

    for (const layer of this.layers.values()) {
      const u = layer.material.uniforms;
      const cam = layer.viewmodel ? viewCamera : camera;
      if (cam) u.uProj.value.set(cam.near, cam.far);
      u.uDepth.value = depthTexture || null;
      u.uSoftEnabled.value = !layer.viewmodel && soft ? 1 : 0;
      u.uSunDir.value.copy(this._sunDirView);
      u.uSunColor.value.copy(this._sunColor);
      u.uAmbient.value.copy(this._ambient);
      u.uFogColor.value.copy(this._fogColor);
      u.uFogDensity.value = layer.viewmodel ? 0 : this._fogDensity;
      u.uWind.value.copy(this.wind);
      layer._windX = this.wind.x;
      layer._windY = this.wind.y;
      layer._windZ = this.wind.z;
      layer.flush(this.time);
    }
  }

  clear() { for (const l of this.layers.values()) l.clear(); }

  dispose() {
    for (const l of this.layers.values()) l.dispose();
    this.layers.clear();
  }

  stats() {
    let live = 0, cap = 0;
    for (const l of this.layers.values()) { live += l.live; cap += l.capacity; }
    return { live, cap, layers: this.layers.size };
  }
}

export { STRIDE };
