import * as THREE from 'three';
import { Rng, clamp, saturate } from './Util.js';

/**
 * Ambient life.
 *
 * Transient effects fire when something happens; this is what is on screen when
 * *nothing* happens, and it is a large part of the difference between a rendered
 * frame and a photographed one:
 *
 *   - dust motes in the air, sized in millimetres, that light up only where a
 *     shaft catches them and are invisible everywhere else;
 *   - wind-blown sand streaking low across the ground;
 *   - insect swarms hovering over vegetation, repositioned by ground probes so
 *     they never end up inside a wall.
 *
 * Each field is one draw call and is simulated entirely in the vertex shader on
 * a wrapping torus centred on the camera, so it is infinite and costs nothing
 * to move through.
 *
 * Two rules this file exists to enforce, because breaking either turns ambient
 * particulate into a fog over the whole screen:
 *
 *  1. **Occlusion is mandatory.** The HDR colour target has no depth
 *     attachment, so these sample the g-buffer depth and do a manual depth test
 *     exactly like `ParticleLayer` does. Without it every mote in the level
 *     draws through every wall.
 *  2. **Motes are a shaft effect, not an atmosphere.** Their alpha is gated by
 *     the forward-scattering term, so they are visible looking into the light
 *     and gone otherwise. They must never read as haze.
 */

const VERT = /* glsl */`
precision highp float;

attribute vec4 aSeed;    // xyz normalised cell position, w phase
attribute vec4 aSeed2;   // per-mote random: size, drift bias, twinkle rate, swarm slot

uniform float uTime;
uniform vec3  uOrigin;
uniform vec3  uBox;
uniform vec3  uDrift;
uniform vec3  uWobble;   // amplitude, frequency, vertical bias
uniform vec2  uSize;     // base, variance
uniform float uStretch;
uniform vec3  uSwarm0;
uniform vec3  uSwarm1;
uniform vec3  uSwarm2;
uniform vec3  uSwarm3;
uniform vec4  uSwarmOn;

varying vec2  vUv;
varying float vFade;
varying float vTwinkle;
varying vec3  vViewPos;
varying vec4  vScreen;

vec3 swarmCenter( float slot, out float on ) {
  if ( slot < 1.0 ) { on = uSwarmOn.x; return uSwarm0; }
  if ( slot < 2.0 ) { on = uSwarmOn.y; return uSwarm1; }
  if ( slot < 3.0 ) { on = uSwarmOn.z; return uSwarm2; }
  on = uSwarmOn.w; return uSwarm3;
}

void main() {
  vUv = uv;
  float on = 1.0;
  vec3 p;

#if FIELD_MODE == 1
  // Insect swarm: tight erratic orbits around a probed anchor.
  float slot = floor( aSeed2.w * 4.0 );
  vec3 c = swarmCenter( slot, on );
  float t = uTime * ( 1.6 + aSeed2.z * 2.4 ) + aSeed.w * 31.4;
  vec3 orbit = vec3(
    sin( t ) * ( 0.5 + aSeed.x ),
    sin( t * 1.37 + 1.1 ) * ( 0.25 + aSeed.y * 0.5 ),
    cos( t * 0.91 + 2.3 ) * ( 0.5 + aSeed.z )
  );
  // A second, faster harmonic makes the motion read as insect, not orbit.
  orbit += 0.28 * vec3(
    sin( t * 5.3 + aSeed.y * 12.0 ),
    sin( t * 6.7 + aSeed.z * 9.0 ),
    sin( t * 4.9 + aSeed.x * 15.0 )
  );
  p = c + orbit * uBox;
#else
  vec3 base = aSeed.xyz * uBox;
  vec3 drift = uDrift * uTime * ( 0.65 + aSeed2.y * 0.7 );
  float ph = aSeed.w * 62.8;
  vec3 wob = vec3(
    sin( uTime * uWobble.y + ph ),
    sin( uTime * uWobble.y * 0.71 + ph * 1.7 ) + uWobble.z,
    sin( uTime * uWobble.y * 1.31 + ph * 2.3 )
  ) * uWobble.x;
  p = base + drift + wob;
  // Wrap into the box centred on the camera: an infinite field for free.
  p = mod( p - uOrigin + uBox * 0.5, uBox ) + uOrigin - uBox * 0.5;
#endif

  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  vViewPos = mv.xyz;

  float size = uSize.x * ( 1.0 - uSize.y + aSeed2.x * uSize.y * 2.0 );
  vec2 q = position.xy * size;
  q.y *= 1.0 + uStretch;
  mv.xy += q;

  // Edge + proximity fade so motes never pop at the box boundary or slap the
  // lens when the player walks through them.
  vec3 rel = ( p - uOrigin ) / max( vec3( 0.001 ), uBox * 0.5 );
  float edge = max( max( abs( rel.x ), abs( rel.y ) ), abs( rel.z ) );
  float depth = -mv.z;
  vFade = ( 1.0 - smoothstep( 0.62, 0.98, edge ) ) * on
        * clamp( ( depth - 0.35 ) / 0.6, 0.0, 1.0 );
  vTwinkle = 0.55 + 0.45 * sin( uTime * ( 2.0 + aSeed2.z * 7.0 ) + aSeed.w * 40.0 );

  gl_Position = projectionMatrix * mv;
  vScreen = gl_Position;
}
`;

const FRAG = /* glsl */`
precision highp float;
uniform sampler2D uMap;
uniform sampler2D uDepth;
uniform vec2  uProj;      // near, far
uniform float uSoftEnabled;
uniform vec4  uTile;      // offsetX, offsetY, scaleX, scaleY
uniform vec3  uColor;
uniform vec3  uSunDir;    // view space
uniform vec3  uSunColor;
uniform float uOpacity;
uniform float uGlint;
uniform float uBase;      // ambient term; 0 means "only visible when backlit"
uniform float uGate;      // 0..1 how hard alpha is gated by the shaft term
uniform vec3  uFogColor;
uniform float uFogDensity;

varying vec2  vUv;
varying float vFade;
varying float vTwinkle;
varying vec3  vViewPos;
varying vec4  vScreen;

void main() {
  if ( vFade <= 0.002 ) discard;
  vec4 tex = texture2D( uMap, uTile.xy + vUv * uTile.zw );
  float a = tex.a * vFade * uOpacity;
  if ( a <= 0.002 ) discard;

  float viewZ = -vViewPos.z;

  // Manual depth test against the g-buffer. The HDR colour target has no depth
  // attachment, so without this every mote in the field draws straight through
  // the level. With no depth texture available the test is skipped rather than
  // sampling an unrelated sampler.
  if ( uSoftEnabled > 0.5 ) {
    vec2 suv = vScreen.xy / max( 1e-5, vScreen.w ) * 0.5 + 0.5;
    float d = texture2D( uDepth, suv ).x * 2.0 - 1.0;
    float sceneZ = ( 2.0 * uProj.x * uProj.y ) / ( uProj.y + uProj.x - d * ( uProj.y - uProj.x ) );
    a *= clamp( ( sceneZ - viewZ ) / 0.25, 0.0, 1.0 );
    if ( a <= 0.002 ) discard;
  }

  // Forward scattering: a mote is essentially a tiny sphere, so it flares when
  // it sits between the eye and the sun and all but disappears with the sun
  // behind the camera. This single term is what makes airborne dust read — and
  // gating alpha on it is what keeps it a shaft effect instead of a haze.
  vec3 vdir = normalize( vViewPos );
  float fwd = clamp( dot( vdir, -uSunDir ) * 0.5 + 0.5, 0.0, 1.0 );
  float glint = pow( fwd, 7.0 ) * uGlint * vTwinkle;
  a *= mix( 1.0, clamp( glint, 0.0, 1.0 ), uGate );
  if ( a <= 0.002 ) discard;

  vec3 rgb = uColor * ( uBase + glint ) + uSunColor * glint * 0.5;

  float fogT = exp( -uFogDensity * uFogDensity * viewZ * viewZ );
#ifdef ADDITIVE
  rgb *= fogT;
#else
  rgb = mix( uFogColor, rgb, fogT );
#endif
  gl_FragColor = vec4( rgb * tex.rgb, a );
}
`;

export class AmbientField {
  constructor(game, opts = {}) {
    this.game = game;
    this.opts = opts;
    this.count = Math.max(0, opts.count | 0);
    this.mode = opts.mode ?? 0;
    this.time = 0;
    this.enabled = true;
    this._build();
  }

  _build() {
    const n = Math.max(1, this.count);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute('position', new THREE.Float32BufferAttribute(
      [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));

    // Every instance attribute is fully written here; nothing in this buffer is
    // ever left at whatever the allocator handed back.
    const rng = new Rng(this.opts.seed ?? 4242);
    const seed = new Float32Array(n * 4);
    const seed2 = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      seed[i * 4] = rng.float();
      seed[i * 4 + 1] = rng.float();
      seed[i * 4 + 2] = rng.float();
      seed[i * 4 + 3] = rng.float();
      seed2[i * 4] = rng.float();
      seed2[i * 4 + 1] = rng.float();
      seed2[i * 4 + 2] = rng.float();
      seed2[i * 4 + 3] = rng.float() * 0.999;
    }
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
    geo.setAttribute('aSeed2', new THREE.InstancedBufferAttribute(seed2, 4));
    geo.instanceCount = this.count;

    const o = this.opts;
    // A real, finite bound: the field is a box of known size that follows the
    // camera, so the sphere is the box's circumradius, re-centred every frame.
    const box = o.box || new THREE.Vector3(14, 7, 14);
    this._radius = 0.5 * Math.sqrt(box.x * box.x + box.y * box.y + box.z * box.z)
      + (o.size?.[0] ?? 0.02) * 4 + 1;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), this._radius);

    const defines = { FIELD_MODE: this.mode };
    if (o.additive !== false) defines.ADDITIVE = '';

    const mat = new THREE.ShaderMaterial({
      name: `vfxAmbient.${o.name || 'field'}`,
      vertexShader: VERT,
      fragmentShader: FRAG,
      defines,
      uniforms: {
        uTime: { value: 0 },
        uOrigin: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(14, 7, 14) },
        uDrift: { value: new THREE.Vector3(0.08, 0.03, 0.05) },
        uWobble: { value: new THREE.Vector3(0.25, 0.35, 0) },
        uSize: { value: new THREE.Vector2(0.014, 0.6) },
        uStretch: { value: 0 },
        uSwarm0: { value: new THREE.Vector3() },
        uSwarm1: { value: new THREE.Vector3() },
        uSwarm2: { value: new THREE.Vector3() },
        uSwarm3: { value: new THREE.Vector3() },
        uSwarmOn: { value: new THREE.Vector4() },
        uMap: { value: o.map || null },
        uDepth: { value: null },
        uProj: { value: new THREE.Vector2(0.05, 2200) },
        uSoftEnabled: { value: 0 },
        uTile: { value: new THREE.Vector4(o.tile?.[0] ?? 0, o.tile?.[1] ?? 0, o.tile?.[2] ?? 1, o.tile?.[3] ?? 1) },
        uColor: { value: new THREE.Vector3(1, 1, 1) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Vector3(1, 0.95, 0.86) },
        uOpacity: { value: o.opacity ?? 1 },
        uGlint: { value: o.glint ?? 1 },
        uBase: { value: o.base ?? 0.35 },
        uGate: { value: saturate(o.gate ?? 0) },
        uFogColor: { value: new THREE.Vector3(0.5, 0.55, 0.6) },
        uFogDensity: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: o.additive !== false ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
    });

    if (o.color) mat.uniforms.uColor.value.set(o.color.r, o.color.g, o.color.b);
    if (o.box) mat.uniforms.uBox.value.copy(o.box);
    if (o.drift) mat.uniforms.uDrift.value.copy(o.drift);
    if (o.wobble) mat.uniforms.uWobble.value.copy(o.wobble);
    if (o.size) mat.uniforms.uSize.value.set(o.size[0], o.size[1]);
    if (o.stretch !== undefined) mat.uniforms.uStretch.value = o.stretch;

    this.geometry = geo;
    this.material = mat;
    const mesh = new THREE.Mesh(geo, mat);
    // The field is a box that wraps around the camera, so it is always in view;
    // culling it is pointless work, but the bound above is real either way.
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = mesh.receiveShadow = false;
    mesh.renderOrder = o.renderOrder ?? 8;
    mesh.userData.postfxIgnore = true;
    mesh.visible = this.enabled !== false && this.count > 0;
    this.mesh = mesh;
  }

  setCount(n) {
    n = Math.max(0, n | 0);
    if (n === this.count) return;
    this.count = n;
    const parent = this.mesh?.parent;
    parent?.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this._build();
    parent?.add(this.mesh);
  }

  update(dt, origin) {
    this.time += (dt - dt === 0) ? dt : 0;
    const u = this.material.uniforms;
    u.uTime.value = this.time;
    if (origin && origin.x - origin.x === 0) {
      u.uOrigin.value.copy(origin);
      // Keep the (finite) bound centred on the field so it stays honest.
      this.geometry.boundingSphere.center.copy(origin);
      this.geometry.boundingSphere.radius = this._radius;
    }
    this.mesh.visible = this.enabled && this.count > 0;
  }

  /** Depth texture + projection for the manual depth test. */
  setDepth(depthTexture, camera) {
    const u = this.material.uniforms;
    u.uDepth.value = depthTexture || null;
    u.uSoftEnabled.value = depthTexture ? 1 : 0;
    if (camera) u.uProj.value.set(camera.near, camera.far);
  }

  dispose() {
    this.mesh?.parent?.remove(this.mesh);
    this.geometry?.dispose();
    this.material?.dispose();
  }
}

/* -------------------------------------------------------------------------- */

/**
 * Budgets are deliberately small. Ambient particulate is seasoning: the moment
 * it is legible as a layer over the frame it is wrong, so the counts, sizes and
 * opacities here are chosen to keep total screen coverage around a percent.
 */
const MOTE_COUNT = 150;
const SAND_COUNT = 190;
const INSECT_COUNT = 84;

export class AmbientLife {
  constructor(vfx, { sparkAtlas, budget = 900 } = {}) {
    this.vfx = vfx;
    this.game = vfx.game;
    this.enabled = true;
    this.time = 0;
    this._probe = 0;
    this._swarmProbe = 0;
    this._origin = new THREE.Vector3();

    // Atlas tiles: 12..15 are soft dots. 4x4 sheet => 0.25 steps.
    const dot = [12 % 4 * 0.25, 1 - (Math.floor(12 / 4) + 1) * 0.25, 0.25, 0.25];
    const softDot = [13 % 4 * 0.25, 1 - (Math.floor(13 / 4) + 1) * 0.25, 0.25, 0.25];

    const scale = clamp(budget / 900, 0.15, 1.3);

    this.motes = new AmbientField(this.game, {
      name: 'motes',
      count: Math.round(MOTE_COUNT * scale),
      map: sparkAtlas,
      tile: dot,
      box: new THREE.Vector3(15, 8, 15),
      drift: new THREE.Vector3(0.10, 0.035, 0.07),
      wobble: new THREE.Vector3(0.22, 0.30, 0.02),
      size: [0.011, 0.75],
      color: { r: 0.55, g: 0.53, b: 0.48 },
      glint: 2.4,
      // No ambient term and full gating: a mote only exists where the light
      // catches it. Look away from the sun and the field is simply not there.
      base: 0.0,
      gate: 1.0,
      opacity: 0.42,
      additive: true,
      seed: 991,
      renderOrder: 8,
    });

    this.sand = new AmbientField(this.game, {
      name: 'sand',
      count: Math.round(SAND_COUNT * scale),
      map: sparkAtlas,
      tile: softDot,
      box: new THREE.Vector3(46, 4.5, 46),
      drift: new THREE.Vector3(6.5, 0.25, 3.2),
      wobble: new THREE.Vector3(0.55, 0.9, -0.15),
      size: [0.024, 0.8],
      color: { r: 0.52, g: 0.44, b: 0.31 },
      glint: 1.4,
      base: 0.05,
      gate: 0.85,
      opacity: 0.10,
      stretch: 2.2,
      additive: true,
      seed: 7717,
      renderOrder: 7,
    });

    this.insects = new AmbientField(this.game, {
      name: 'insects',
      mode: 1,
      count: Math.round(INSECT_COUNT * scale),
      map: sparkAtlas,
      tile: dot,
      box: new THREE.Vector3(0.55, 0.30, 0.55),
      size: [0.009, 0.5],
      color: { r: 0.06, g: 0.055, b: 0.05 },
      glint: 0.3,
      // Insects are dark specks read against the background, not scattering
      // motes: they keep their body colour and are never gated away.
      base: 1.0,
      gate: 0.0,
      opacity: 0.8,
      additive: false,
      seed: 3131,
      renderOrder: 9,
    });
    // The swarm field is anchored to probed ground within ~15 m of the camera.
    this.insects._radius = 18;

    this.fields = [this.motes, this.sand, this.insects];
    for (const f of this.fields) this.game.scene?.add(f.mesh);

    this.swarms = [
      { pos: new THREE.Vector3(), on: 0, next: 0.4 },
      { pos: new THREE.Vector3(), on: 0, next: 1.1 },
      { pos: new THREE.Vector3(), on: 0, next: 1.9 },
      { pos: new THREE.Vector3(), on: 0, next: 2.7 },
    ];
    this._swarmIndex = 0;
    this.groundY = 0;
  }

  setBudget(budget) {
    const scale = clamp(budget / 900, 0.15, 1.3);
    this.motes.setCount(Math.round(MOTE_COUNT * scale));
    this.sand.setCount(Math.round(SAND_COUNT * scale));
    this.insects.setCount(Math.round(INSECT_COUNT * scale));
    this.insects._radius = 18;
    for (const f of this.fields) if (!f.mesh.parent) this.game.scene?.add(f.mesh);
  }

  setEnabled(on) {
    this.enabled = !!on;
    for (const f of this.fields) {
      f.enabled = this.enabled;
      f.mesh.visible = this.enabled && f.count > 0;
    }
  }

  /**
   * @param {number} dt
   * @param {THREE.Camera} camera
   * @param {Object} env {sunDirView, sunColor, fogColor, fogDensity, wind, depth, soft}
   */
  update(dt, camera, env) {
    if (!this.enabled || !camera) return;
    const d = (dt - dt === 0) ? clamp(dt, 0, 0.1) : 0;
    this.time += d;
    this._origin.copy(camera.position);

    const depth = env?.soft ? (env.depth || null) : null;
    for (const f of this.fields) {
      const u = f.material.uniforms;
      if (env) {
        u.uSunDir.value.copy(env.sunDirView);
        u.uSunColor.value.copy(env.sunColor);
        u.uFogColor.value.copy(env.fogColor);
        u.uFogDensity.value = env.fogDensity;
      }
      f.setDepth(depth, camera);
    }

    // Wind drives the sand field directly; motes only feel a fraction of it.
    if (env?.wind) {
      this.sand.material.uniforms.uDrift.value.set(
        env.wind.x * 3.2 + 2.2, 0.25, env.wind.z * 3.2 + 1.1,
      );
      this.motes.material.uniforms.uDrift.value.set(
        env.wind.x * 0.16 + 0.06, 0.035, env.wind.z * 0.16 + 0.04,
      );
    }

    this.motes.update(d, this._origin);

    // Sand hugs the ground: keep the field centred a metre or so above it.
    this._probe -= d;
    if (this._probe <= 0) {
      this._probe = 0.5;
      const hit = this._ground(this._origin, 40);
      if (hit && hit.point.y - hit.point.y === 0) this.groundY = hit.point.y;
    }
    SAND_ORIGIN.set(this._origin.x, this.groundY + 1.6, this._origin.z);
    this.sand.update(d, SAND_ORIGIN);

    this.insects.update(d, this._origin);
    this._updateSwarms(d, camera);
  }

  _ground(from, dist) {
    const phys = this.game?.physics;
    if (!phys?.raycast) return null;
    PROBE.copy(from);
    PROBE.y += 1.0;
    try { return phys.raycast(PROBE, DOWN, dist); } catch (e) { return null; }
  }

  _updateSwarms(dt, camera) {
    const u = this.insects.material.uniforms;
    let moved = false;
    for (let i = 0; i < this.swarms.length; i++) {
      const s = this.swarms[i];
      s.next -= dt;
      const far = s.pos.distanceToSquared(camera.position) > 900;
      if (s.next <= 0 || (far && s.on > 0)) {
        s.next = 2.2 + Math.random() * 2.5;
        this._placeSwarm(s, camera);
        moved = true;
      }
    }
    u.uSwarm0.value.copy(this.swarms[0].pos);
    u.uSwarm1.value.copy(this.swarms[1].pos);
    u.uSwarm2.value.copy(this.swarms[2].pos);
    u.uSwarm3.value.copy(this.swarms[3].pos);
    u.uSwarmOn.value.set(
      this.swarms[0].on, this.swarms[1].on, this.swarms[2].on, this.swarms[3].on,
    );
    return moved;
  }

  _placeSwarm(s, camera) {
    const a = Math.random() * Math.PI * 2;
    const d = 4 + Math.random() * 11;
    PROBE.set(
      camera.position.x + Math.cos(a) * d,
      camera.position.y + 3,
      camera.position.z + Math.sin(a) * d,
    );
    const phys = this.game?.physics;
    let hit = null;
    if (phys?.raycast) {
      try { hit = phys.raycast(PROBE, DOWN, 14); } catch (e) { hit = null; }
    }
    if (!hit || !(hit.point.x - hit.point.x === 0)) { s.on = 0; return; }
    // Insects belong over living ground, not concrete or steel.
    const good = hit.surface === 'foliage' || hit.surface === 'dirt' || hit.surface === 'sand' || hit.surface === 'water';
    s.on = good ? 1 : 0;
    s.pos.copy(hit.point);
    s.pos.y += 0.75 + Math.random() * 0.9;
  }

  dispose() {
    for (const f of this.fields) f.dispose();
    this.fields.length = 0;
  }
}

const DOWN = /* @__PURE__ */ new THREE.Vector3(0, -1, 0);
const PROBE = /* @__PURE__ */ new THREE.Vector3();
const SAND_ORIGIN = /* @__PURE__ */ new THREE.Vector3();
