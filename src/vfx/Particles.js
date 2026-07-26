import * as THREE from 'three';
import { EMISSIVE_RANGE } from './Textures.js';

/**
 * GPU particle system.
 *
 * Simulation happens entirely in the vertex shader from the spawn parameters:
 * position, velocity, linear drag, gravity and wind are integrated *analytically*
 * (closed form for `dv/dt = -k(v - w) + g`), so a particle's state at any time
 * is a pure function of its birth record. The CPU writes 24 floats once, at
 * spawn, into an interleaved instance buffer and never touches it again — there
 * is no per-particle CPU update anywhere in this module.
 *
 * Per-layer features:
 *   - soft depth fade against the g-buffer depth (which doubles as a manual
 *     depth test, so particles are correctly occluded even though the HDR
 *     colour target has no depth attachment);
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

void main() {
  float life = max( aVel.w, 1e-4 );
  float age = uTime - aSpawn.w;
  float t = age / life;

  if ( age < 0.0 || t >= 1.0 ) {
    // Retired slot: collapse outside clip space. Costs one vertex, zero fill.
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    vColor = vec4( 0.0 );
    vUvA = vUvB = vec2( 0.0 );
    vParams = vec4( 0.0 );
    vScreen = vec4( 0.0, 0.0, 1.0, 1.0 );
    vViewPos = vec3( 0.0 );
    vRot = vec2( 1.0, 0.0 );
    vQuad = vec2( 0.0 );
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
  float rot = aSize.z + aSize.w * age;
  float cr = cos( rot ), sr = sin( rot );
  vRot = vec2( cr, sr );
  vQuad = position.xy;

  vec4 mv = modelViewMatrix * vec4( pos, 1.0 );

#if STRETCH_MODE == 0
  vec2 q = position.xy * size;
  mv.xy += vec2( q.x * cr - q.y * sr, q.x * sr + q.y * cr );
#else
  vec3 vv = normalize( mat3( modelViewMatrix ) * ( length( vel ) > 1e-4 ? vel : vec3( 0.0, 1.0, 0.0 ) ) );
  #if STRETCH_MODE == 1
    float len = max( size, size + aDyn.z * length( vel ) * uStretchScale );
  #else
    float len = max( size, aDyn.z );
  #endif
  vec4 tail = modelViewMatrix * vec4( pos - normalize( length( vel ) > 1e-4 ? vel : vec3( 0.0, 1.0, 0.0 ) ) * len, 1.0 );
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
  rgb = vColor.rgb * lit;
#elif SHADE_MODE == 2
  rgb = vColor.rgb * tex.rgb * ( uAmbient + uSunColor * 0.62 );
#else
  rgb = vColor.rgb * tex.rgb;
#endif

  float viewZ = vParams.y;

  // Soft particles. The same term is a manual depth test: anything behind the
  // recorded scene depth fades to zero, which keeps effects correctly occluded
  // regardless of what the colour target's depth attachment is doing.
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

/**
 * One draw call: a pooled ring of particles sharing an atlas, a blend mode and
 * a shading model.
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

    this._head = 0;
    this._wrapped = false;
    this._maxExpiry = -1;
    this._dirtyMin = Infinity;
    this._dirtyMax = -Infinity;
    this._time = 0;
    this._spawnCount = 0;

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

    this.array = new Float32Array(this.capacity * STRIDE);
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
    // Simulation lives on the GPU, so the CPU has no idea where these are.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    geo.boundingBox = new THREE.Box3(
      new THREE.Vector3(-1e6, -1e6, -1e6), new THREE.Vector3(1e6, 1e6, 1e6),
    );
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
    mesh.frustumCulled = false;   // bounds are unknowable CPU-side
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = o.renderOrder ?? 10;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.postfxIgnore = true;
    this.mesh = mesh;
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
    this._head = 0;
    this._wrapped = false;
    this._maxExpiry = -1;
    this._dirtyMin = Infinity;
    this._dirtyMax = -Infinity;
    parent?.add(this.mesh);
  }

  /**
   * Write one particle. Every argument is a scalar so bursts do not allocate.
   * Returns the slot index.
   */
  spawn(
    px, py, pz, vx, vy, vz, life,
    size0, size1, rot, spin, drag, gravity, stretch,
    r, g, b, a, profile, frame0, frameSpan, softness, seed,
  ) {
    const i = this._head;
    const o = i * STRIDE;
    const arr = this.array;
    const t = this._time;
    arr[o] = px; arr[o + 1] = py; arr[o + 2] = pz; arr[o + 3] = t;
    arr[o + 4] = vx; arr[o + 5] = vy; arr[o + 6] = vz; arr[o + 7] = life;
    arr[o + 8] = size0; arr[o + 9] = size1; arr[o + 10] = rot; arr[o + 11] = spin;
    arr[o + 12] = drag; arr[o + 13] = gravity; arr[o + 14] = stretch; arr[o + 15] = seed;
    arr[o + 16] = r; arr[o + 17] = g; arr[o + 18] = b; arr[o + 19] = a;
    arr[o + 20] = profile; arr[o + 21] = frame0; arr[o + 22] = frameSpan;
    arr[o + 23] = softness === undefined ? this.softness : softness;

    if (i < this._dirtyMin) this._dirtyMin = i;
    if (i > this._dirtyMax) this._dirtyMax = i;
    const expiry = t + life;
    if (expiry > this._maxExpiry) this._maxExpiry = expiry;
    this._spawnCount++;

    this._head++;
    if (this._head >= this.capacity) { this._head = 0; this._wrapped = true; }
    return i;
  }

  /** Uploads the frame's dirty range and picks the tightest instance count. */
  flush(time) {
    this._time = time;
    this.material.uniforms.uTime.value = time;

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

    if (time > this._maxExpiry) {
      // Everything is dead: rewind the ring so the next burst draws a tiny
      // instance range instead of the whole pool.
      this.geometry.instanceCount = 0;
      this._head = 0;
      this._wrapped = false;
    } else {
      this.geometry.instanceCount = this._wrapped ? this.capacity : this._head;
    }
  }

  clear() {
    this.array.fill(0);
    this.buffer.needsUpdate = true;
    this._head = 0;
    this._wrapped = false;
    this._maxExpiry = -1;
    this._dirtyMin = Infinity;
    this._dirtyMax = -Infinity;
    this.geometry.instanceCount = 0;
  }

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
    this.time += dt;
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

    for (const layer of this.layers.values()) {
      const u = layer.material.uniforms;
      const cam = layer.viewmodel ? viewCamera : camera;
      if (cam) u.uProj.value.set(cam.near, cam.far);
      u.uDepth.value = depthTexture;
      u.uSoftEnabled.value = !layer.viewmodel && softEnabled && depthTexture ? 1 : 0;
      u.uSunDir.value.copy(this._sunDirView);
      u.uSunColor.value.copy(this._sunColor);
      u.uAmbient.value.copy(this._ambient);
      u.uFogColor.value.copy(this._fogColor);
      u.uFogDensity.value = layer.viewmodel ? 0 : this._fogDensity;
      u.uWind.value.copy(this.wind);
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
    for (const l of this.layers.values()) { live += l.geometry.instanceCount; cap += l.capacity; }
    return { live, cap, layers: this.layers.size };
  }
}

export { STRIDE };
