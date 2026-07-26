import * as THREE from 'three';
import { Pool, clamp, saturate } from './Util.js';

/**
 * Screen-space refraction without touching the post chain.
 *
 * The trick: sample the *previous* composed frame twice — once displaced, once
 * not — and additively blend the **difference**. Where the image is flat the
 * difference is zero, so no colour-space error from the LDR source can leak in;
 * where there is an edge, the difference reads exactly as if that edge had been
 * pushed sideways. It degrades to a faint warm shell if the post chain has not
 * published a frame yet, and it is masked against scene depth so a blast wave
 * does not warp the wall between it and the camera.
 *
 * Used for explosion shockwaves, muzzle-blast pressure and ground heat shimmer.
 */

const VERT = /* glsl */`
precision highp float;
uniform float uScrollA;
uniform float uScrollB;
uniform vec2  uNoiseScale;
varying vec4 vScreen;
varying vec3 vNormalView;
varying vec3 vViewPos;
varying vec2 vNoiseUvA;
varying vec2 vNoiseUvB;
varying float vRim;

void main() {
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vViewPos = mv.xyz;
  vNormalView = normalize( normalMatrix * normal );
  vec3 vdir = normalize( -mv.xyz );
  vRim = pow( 1.0 - abs( dot( vNormalView, vdir ) ), 1.6 );
  vNoiseUvA = uv * uNoiseScale + vec2( uScrollA, uScrollA * 0.63 );
  vNoiseUvB = uv * uNoiseScale * 2.17 - vec2( uScrollB * 0.71, uScrollB );
  gl_Position = projectionMatrix * mv;
  vScreen = gl_Position;
}
`;

const FRAG = /* glsl */`
precision highp float;
uniform sampler2D tPrev;
uniform sampler2D tNoise;
uniform sampler2D uDepth;
uniform vec2  uProj;
uniform float uHasPrev;
uniform float uSoftEnabled;
uniform float uStrength;
uniform float uRefract;
uniform float uGlow;
uniform vec3  uGlowColor;
uniform float uRimPower;

varying vec4 vScreen;
varying vec3 vNormalView;
varying vec3 vViewPos;
varying vec2 vNoiseUvA;
varying vec2 vNoiseUvB;
varying float vRim;

void main() {
  vec2 uv = vScreen.xy / max( 1e-5, vScreen.w ) * 0.5 + 0.5;
  float viewZ = -vViewPos.z;

  float mask = pow( clamp( vRim, 0.0, 1.0 ), uRimPower ) * uStrength;
  if ( uSoftEnabled > 0.5 ) {
    float d = texture2D( uDepth, uv ).x * 2.0 - 1.0;
    float sceneZ = ( 2.0 * uProj.x * uProj.y ) / ( uProj.y + uProj.x - d * ( uProj.y - uProj.x ) );
    mask *= clamp( ( sceneZ - viewZ ) / 0.75, 0.0, 1.0 );
  }
  if ( mask <= 0.001 ) discard;

  vec3 na = texture2D( tNoise, vNoiseUvA ).rgb;
  vec3 nb = texture2D( tNoise, vNoiseUvB ).rgb;
  vec2 jitter = ( na.rg + nb.gb - 1.0 );
  vec2 offset = ( vNormalView.xy * 0.65 + jitter * 0.85 ) * uRefract * mask
              / max( 1.0, viewZ * 0.35 );

  vec3 outColor = uGlowColor * ( uGlow * mask );
  if ( uHasPrev > 0.5 ) {
    vec3 a = texture2D( tPrev, clamp( uv + offset, vec2( 0.001 ), vec2( 0.999 ) ) ).rgb;
    vec3 b = texture2D( tPrev, uv ).rgb;
    float lum = dot( b, vec3( 0.2126, 0.7152, 0.0722 ) );
    // The source is display-referred; scale the delta back up so highlights
    // shimmer as hard as they would in scene-referred values.
    outColor += ( a - b ) * ( 0.7 + lum * 4.0 ) * mask;
  }

  gl_FragColor = vec4( outColor, 1.0 );
}
`;

function makeMaterial(noise, opts = {}) {
  return new THREE.ShaderMaterial({
    name: opts.name || 'vfxDistortion',
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      tPrev: { value: null },
      tNoise: { value: noise },
      uDepth: { value: null },
      uProj: { value: new THREE.Vector2(0.05, 2200) },
      uHasPrev: { value: 0 },
      uSoftEnabled: { value: 0 },
      uStrength: { value: 0 },
      uRefract: { value: opts.refract ?? 0.045 },
      uGlow: { value: opts.glow ?? 0.05 },
      uGlowColor: { value: new THREE.Vector3(1, 0.82, 0.6) },
      uRimPower: { value: opts.rimPower ?? 1.0 },
      uScrollA: { value: 0 },
      uScrollB: { value: 0 },
      uNoiseScale: { value: new THREE.Vector2(opts.noiseScale ?? 2, opts.noiseScale ?? 2) },
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: opts.side ?? THREE.FrontSide,
    fog: false,
    toneMapped: false,
  });
}

export class DistortionField {
  constructor(game, noiseTexture, { waves = 4, heat = true } = {}) {
    this.game = game;
    this.noise = noiseTexture;
    this.materials = [];
    this.time = 0;

    const sphere = new THREE.SphereGeometry(1, 32, 20);
    this.sphereGeometry = sphere;

    this.waves = new Pool(waves, () => {
      const mat = makeMaterial(noiseTexture, {
        name: 'vfxShockwave', refract: 0.11, glow: 0.10, rimPower: 1.35, noiseScale: 3,
      });
      this.materials.push(mat);
      const mesh = new THREE.Mesh(sphere, mat);
      mesh.frustumCulled = true;
      mesh.castShadow = mesh.receiveShadow = false;
      mesh.visible = false;
      mesh.renderOrder = 20;
      mesh.userData.postfxIgnore = true;
      game.scene?.add(mesh);
      return { mesh, mat, alive: false, age: 0, life: 1, radius: 1, from: 0.2, to: 6, power: 1 };
    });

    this.heat = null;
    if (heat) {
      const geo = new THREE.RingGeometry(2.5, 95, 96, 6);
      geo.rotateX(-Math.PI / 2);
      const mat = makeMaterial(noiseTexture, {
        name: 'vfxHeatHaze', refract: 0.020, glow: 0.0, rimPower: 0.25, noiseScale: 22,
        side: THREE.DoubleSide,
      });
      this.materials.push(mat);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = mesh.receiveShadow = false;
      mesh.renderOrder = 19;
      mesh.userData.postfxIgnore = true;
      mesh.visible = false;
      game.scene?.add(mesh);
      this.heat = { mesh, mat, groundY: 0, probe: 0, strength: 0 };
    }
  }

  /**
   * Expanding pressure wave.
   * @param {THREE.Vector3} position
   * @param {number} radius  final radius in metres
   * @param {number} duration seconds
   * @param {number} power   0..2 strength multiplier
   */
  shockwave(position, radius = 8, duration = 0.42, power = 1) {
    const w = this.waves.acquire();
    if (!w) return null;
    w.alive = true;
    w.age = 0;
    w.life = Math.max(0.05, duration);
    w.from = Math.max(0.2, radius * 0.06);
    w.to = Math.max(w.from + 0.2, radius);
    w.power = clamp(power, 0, 4);
    w.mesh.position.copy(position);
    w.mesh.scale.setScalar(w.from);
    w.mesh.visible = true;
    w.mat.uniforms.uStrength.value = 0;
    return w;
  }

  setHeat(strength, groundY) {
    if (!this.heat) return;
    this.heat.strength = saturate(strength);
    if (groundY !== undefined) this.heat.groundY = groundY;
  }

  update(dt, camera, prevTexture, depthTexture, softEnabled) {
    this.time += dt;
    const hasPrev = prevTexture ? 1 : 0;

    for (const m of this.materials) {
      const u = m.uniforms;
      u.tPrev.value = prevTexture || null;
      u.uHasPrev.value = hasPrev;
      u.uDepth.value = depthTexture || null;
      u.uSoftEnabled.value = softEnabled && depthTexture ? 1 : 0;
      if (camera) u.uProj.value.set(camera.near, camera.far);
      u.uScrollA.value = this.time * 0.11;
      u.uScrollB.value = this.time * 0.17;
    }

    this.waves.forEach((w, i, active) => {
      if (!w.alive) return;
      w.age += dt;
      const t = w.age / w.life;
      if (t >= 1) {
        w.alive = false;
        w.mesh.visible = false;
        this.waves.releaseIndex(i);
        return;
      }
      // Blast radius growth: fast then asymptotic, like a real pressure front.
      const k = 1 - Math.pow(1 - t, 2.4);
      const r = w.from + (w.to - w.from) * k;
      w.mesh.scale.setScalar(r);
      const fade = Math.pow(1 - t, 1.5) * (1 - 0.25 * t);
      w.mat.uniforms.uStrength.value = w.power * fade * 1.35;
      w.mat.uniforms.uGlow.value = 0.16 * Math.pow(1 - t, 3);
    });

    const h = this.heat;
    if (h) {
      h.probe -= dt;
      if (h.probe <= 0 && camera) {
        h.probe = 0.75;
        const hit = this.game?.physics?.raycast?.(camera.position, DOWN, 30);
        h.groundY = hit ? hit.point.y : camera.position.y - 1.7;
      }
      const on = h.strength > 0.01;
      h.mesh.visible = on;
      if (on && camera) {
        h.mesh.position.set(camera.position.x, h.groundY + 0.35, camera.position.z);
        h.mesh.updateMatrix();
        h.mesh.updateMatrixWorld(true);
        h.mat.uniforms.uStrength.value = h.strength;
      }
    }
  }

  clear() {
    this.waves.forEach((w, i) => { w.alive = false; w.mesh.visible = false; this.waves.releaseIndex(i); });
  }

  dispose() {
    this.waves.forEach((w) => { w.mesh.parent?.remove(w.mesh); w.mat.dispose(); });
    this.sphereGeometry.dispose();
    if (this.heat) {
      this.heat.mesh.parent?.remove(this.heat.mesh);
      this.heat.mesh.geometry.dispose();
      this.heat.mat.dispose();
    }
  }
}

const DOWN = /* @__PURE__ */ new THREE.Vector3(0, -1, 0);
