import * as THREE from 'three';
import { P } from './Profiles.js';
import { DECAL } from './Textures.js';
import { Pool, Rng, V, coneDirection, clamp, saturate, lodScale, TAU } from './Util.js';

/**
 * Explosions.
 *
 * Layered exactly the way a real one photographs:
 *   t+0 ms    white core, PointLight spike, screen flash (PostFX picks this up
 *             off the `explosion` event itself)
 *   t+10 ms   fireball — a noise-displaced shell shading from white through a
 *             blackbody ramp as it cools, plus fire puffs breaking off it
 *   t+30 ms   pressure wave: an expanding refraction shell and two bright rings
 *   t+60 ms   dust wave racing outward along the ground
 *   t+120 ms  debris arcing away as real rigid bodies, embers, smoke column
 *   t+400 ms  the fireball is gone and only the smoke and the scorch remain
 */

const FIREBALL_VERT = /* glsl */`
precision highp float;
uniform sampler2D uNoise;
uniform float uT;
uniform float uDisplace;
varying vec3 vN;
varying vec3 vView;
varying float vNoise;

void main() {
  vec3 n = normalize( normal );
  // Triplanar on the sphere's own normal: an icosphere's UVs are seamed and
  // wildly non-uniform, and sampling them directly stamps visible facets.
  vec3 an = abs( n );
  vec3 bw = an / max( 1e-4, an.x + an.y + an.z );
  vec3 s1 = texture2D( uNoise, n.yz * 0.8 + vec2( uT * 0.13, -uT * 0.21 ) ).rgb * bw.x
          + texture2D( uNoise, n.zx * 0.8 + vec2( -uT * 0.17, uT * 0.11 ) ).rgb * bw.y
          + texture2D( uNoise, n.xy * 0.8 + vec2( uT * 0.09, uT * 0.19 ) ).rgb * bw.z;
  vec3 s2 = texture2D( uNoise, n.yz * 2.6 - vec2( uT * 0.29, uT * 0.11 ) ).rgb * bw.x
          + texture2D( uNoise, n.zx * 2.6 + vec2( uT * 0.23, uT * 0.31 ) ).rgb * bw.y
          + texture2D( uNoise, n.xy * 2.6 - vec2( uT * 0.35, uT * 0.13 ) ).rgb * bw.z;
  float n1 = s1.r;
  float n2 = s2.g;
  float n3 = s2.b;
  vNoise = n1 * 0.55 + n2 * 0.31 + n3 * 0.14;
  float d = ( vNoise - 0.5 ) * 2.0;
  vec3 p = position * ( 1.0 + d * uDisplace );
  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  vView = mv.xyz;
  vN = normalize( normalMatrix * n );
  gl_Position = projectionMatrix * mv;
}
`;

const FIREBALL_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uRamp;
uniform float uT;
uniform float uIntensity;
uniform vec3 uTint;
varying vec3 vN;
varying vec3 vView;
varying float vNoise;

void main() {
  vec3 v = normalize( -vView );
  float ndv = abs( dot( normalize( vN ), v ) );
  // Temperature falls with time and with the noise field, so the shell breaks
  // into cooling lobes instead of fading uniformly.
  float temp = clamp( vNoise * 1.35 - uT * 1.05 + ( 1.0 - ndv ) * 0.16, 0.0, 1.0 );
  vec3 c = texture2D( uRamp, vec2( temp, 0.5 ) ).rgb * 16.0 * uTint;
  // Optical depth through a sphere goes to zero at the silhouette; without this
  // the ball has a razor edge and reads as a lit polygon, not as fire.
  float a = smoothstep( 0.015, 0.30, temp ) * ( 1.0 - uT * uT ) * pow( ndv, 1.1 );
  if ( a <= 0.002 ) discard;
  gl_FragColor = vec4( c * uIntensity, a );
}
`;

function ringGeometry(segments = 72) {
  const pos = [];
  const col = [];
  const radii = [0.60, 0.86, 1.0, 1.16, 1.5];
  const alpha = [0.0, 0.55, 1.0, 0.5, 0.0];
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * TAU;
    const a1 = ((i + 1) / segments) * TAU;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);
    for (let r = 0; r < radii.length - 1; r++) {
      const ra = radii[r], rb = radii[r + 1];
      const aa = alpha[r], ab = alpha[r + 1];
      const p = [
        [c0 * ra, 0, s0 * ra, aa], [c1 * ra, 0, s1 * ra, aa], [c1 * rb, 0, s1 * rb, ab],
        [c0 * ra, 0, s0 * ra, aa], [c1 * rb, 0, s1 * rb, ab], [c0 * rb, 0, s0 * rb, ab],
      ];
      for (const q of p) {
        pos.push(q[0], q[1], q[2]);
        col.push(q[3], q[3], q[3]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

function chunkGeometry(rng, roughness = 0.42) {
  const g = new THREE.IcosahedronGeometry(0.5, 1);
  const p = g.getAttribute('position');
  const seen = new Map();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    let s = seen.get(key);
    if (s === undefined) { s = 1 + (rng.float() - 0.5) * roughness * 2; seen.set(key, s); }
    p.setXYZ(i, x * s, y * s * (0.7 + rng.float() * 0.5), z * s);
  }
  g.computeVertexNormals();
  return g;
}

export class Explosions {
  constructor(vfx, { fireRamp, noise, debrisCount = 72 } = {}) {
    this.vfx = vfx;
    this.game = vfx.game;
    this.rng = new Rng(8081);
    this.time = 0;

    /* ---- fireball shells ---- */
    this.sphereGeometry = new THREE.IcosahedronGeometry(1, 4);
    this.balls = new Pool(3, () => {
      const mat = new THREE.ShaderMaterial({
        name: 'vfxFireball',
        vertexShader: FIREBALL_VERT,
        fragmentShader: FIREBALL_FRAG,
        uniforms: {
          uNoise: { value: noise },
          uRamp: { value: fireRamp },
          uT: { value: 0 },
          uDisplace: { value: 0.28 },
          uIntensity: { value: 1 },
          uTint: { value: new THREE.Vector3(1, 1, 1) },
        },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        side: THREE.FrontSide,
        fog: false,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(this.sphereGeometry, mat);
      mesh.frustumCulled = true;
      mesh.castShadow = mesh.receiveShadow = false;
      mesh.visible = false;
      mesh.renderOrder = 16;
      mesh.userData.postfxIgnore = true;
      this.game.scene?.add(mesh);
      return { mesh, mat, alive: false, age: 0, life: 0.55, r0: 0.4, r1: 3 };
    });

    /* ---- pressure rings ---- */
    this.ringGeometry = ringGeometry(72);
    this.rings = new Pool(4, () => {
      const mat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        fog: false,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(this.ringGeometry, mat);
      mesh.frustumCulled = true;
      mesh.castShadow = mesh.receiveShadow = false;
      mesh.visible = false;
      mesh.renderOrder = 17;
      mesh.userData.postfxIgnore = true;
      this.game.scene?.add(mesh);
      return { mesh, mat, alive: false, age: 0, life: 0.4, r0: 0.5, r1: 8, flat: 1, peak: 6 };
    });

    /* ---- debris ---- */
    this.debrisFree = [];
    this.debrisMesh = null;
    if (debrisCount > 0) {
      const geo = chunkGeometry(this.rng, 0.5);
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(0.20, 0.19, 0.175),
        roughness: 0.92,
        metalness: 0.0,
        flatShading: true,
      });
      const mesh = new THREE.InstancedMesh(geo, mat, debrisCount);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = debrisCount;
      const zero = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < debrisCount; i++) {
        mesh.setMatrixAt(i, zero);
        this.debrisFree.push(i);
      }
      mesh.instanceMatrix.needsUpdate = true;
      this.game.scene?.add(mesh);
      this.debrisMesh = mesh;
      this._zeroMatrix = zero;
    }
    this._scale = new THREE.Vector3(1, 1, 1);
  }

  /**
   * @param {Object} o {position, radius, power, color, groundY}
   */
  spawn(o = {}) {
    const pos = o.position;
    if (!pos) return;
    const radius = clamp(o.radius ?? 6, 0.5, 60);
    const power = clamp(o.power ?? 14, 0.1, 200);
    const scale = clamp(radius / 6, 0.25, 6);
    const q = this.vfx.quality * lodScale(this.game.camera, pos, 25, 180);
    const L = this.vfx.layers;

    /* --- core light ------------------------------------------------------ */
    this.vfx.lights?.flash(pos, 34 * scale * scale, 0.55, FIRE_LIGHT, 1, radius * 3.2);

    /* --- fireball -------------------------------------------------------- */
    const ball = this.balls.acquire();
    if (ball) {
      ball.alive = true;
      ball.age = 0;
      ball.life = 0.34 + scale * 0.24;
      ball.r0 = radius * 0.16;
      ball.r1 = radius * 0.72;
      ball.mesh.position.copy(pos);
      ball.mesh.quaternion.set(Math.random(), Math.random(), Math.random(), Math.random()).normalize();
      ball.mesh.scale.setScalar(ball.r0);
      ball.mesh.visible = true;
      ball.mat.uniforms.uT.value = 0;
      ball.mat.uniforms.uIntensity.value = 1;
      const c = o.color;
      ball.mat.uniforms.uTint.value.set(c?.r ?? 1, c?.g ?? 1, c?.b ?? 1);
    }

    /* --- rings ----------------------------------------------------------- */
    const groundY = o.groundY ?? this._probeGround(pos, radius);
    const ring = this.rings.acquire();
    if (ring) {
      ring.alive = true; ring.age = 0; ring.life = 0.30 + scale * 0.12;
      ring.r0 = radius * 0.2; ring.r1 = radius * 1.5; ring.peak = 9 * scale;
      ring.mesh.position.set(pos.x, Math.max(groundY + 0.08, pos.y - radius * 0.35), pos.z);
      ring.mesh.rotation.set(0, Math.random() * TAU, 0);
      ring.mesh.visible = true;
    }
    const ring2 = this.rings.acquire();
    if (ring2) {
      ring2.alive = true; ring2.age = 0; ring2.life = 0.22 + scale * 0.09;
      ring2.r0 = radius * 0.15; ring2.r1 = radius * 1.05; ring2.peak = 6 * scale;
      ring2.mesh.position.copy(pos);
      ring2.mesh.rotation.set(Math.random() * 0.9 - 0.45, Math.random() * TAU, Math.random() * 0.9 - 0.45);
      ring2.mesh.visible = true;
    }

    /* --- pressure wave --------------------------------------------------- */
    this.vfx.distortion?.shockwave(pos, radius * 1.5, 0.30 + scale * 0.14, 1.1 * clamp(scale, 0.4, 2));

    /* --- fire puffs ------------------------------------------------------ */
    const fireCount = Math.round(14 * q * clamp(scale, 0.5, 2.2));
    for (let i = 0; i < fireCount; i++) {
      coneDirection(UP, 1.45, V.a, Math.random, 0.7);
      const sp = (2.5 + Math.random() * 9) * scale;
      const s0 = radius * (0.10 + Math.random() * 0.13);
      L.smoke?.spawn(
        pos.x + V.a.x * radius * 0.15, pos.y + V.a.y * radius * 0.15, pos.z + V.a.z * radius * 0.15,
        V.a.x * sp, V.a.y * sp * 0.85 + 1.2, V.a.z * sp,
        0.42 + Math.random() * 0.55,
        s0, s0 * (2.4 + Math.random() * 1.6), Math.random() * TAU, (Math.random() - 0.5) * 1.6,
        2.4, -0.22, 0,
        1, 1, 1, 1, P.FIRE, 0, 63, 1.4, Math.random(),
      );
    }

    /* --- smoke column ---------------------------------------------------- */
    const smokeCount = Math.round(12 * q * clamp(scale, 0.5, 2.4));
    for (let i = 0; i < smokeCount; i++) {
      coneDirection(UP, 1.2, V.a, Math.random, 0.8);
      const sp = (1.2 + Math.random() * 4.5) * scale;
      const s0 = radius * (0.12 + Math.random() * 0.16);
      L.smoke?.spawn(
        pos.x + V.a.x * radius * 0.2, pos.y + V.a.y * radius * 0.2 + 0.2, pos.z + V.a.z * radius * 0.2,
        V.a.x * sp, V.a.y * sp * 0.7 + 1.6, V.a.z * sp,
        2.6 + Math.random() * 3.4,
        s0, s0 * (3.5 + Math.random() * 2.5), Math.random() * TAU, (Math.random() - 0.5) * 0.8,
        1.1, -0.10, 0,
        1, 1, 1, 1, P.SMOKE_DARK, 0, 63, 1.8, Math.random(),
      );
    }

    /* --- ground dust wave ------------------------------------------------ */
    const dustCount = Math.round(16 * q * clamp(scale, 0.5, 2.2));
    const gy = groundY + 0.15;
    for (let i = 0; i < dustCount; i++) {
      const a = (i / dustCount) * TAU + Math.random() * 0.5;
      const dx = Math.cos(a), dz = Math.sin(a);
      const sp = (5 + Math.random() * 11) * clamp(scale, 0.5, 2);
      const s0 = radius * (0.10 + Math.random() * 0.12);
      L.dust?.spawn(
        pos.x + dx * radius * 0.25, gy, pos.z + dz * radius * 0.25,
        dx * sp, 0.6 + Math.random() * 1.4, dz * sp,
        1.6 + Math.random() * 2.2,
        s0, s0 * (4 + Math.random() * 3), Math.random() * TAU, (Math.random() - 0.5) * 1.2,
        1.9, 0.05, 0,
        1, 1, 1, 0.9, P.DUST_SAND, 0, 15, 1.6, Math.random(),
      );
    }

    /* --- embers and sparks ------------------------------------------------ */
    const emberCount = Math.round(26 * q * clamp(scale, 0.5, 2));
    for (let i = 0; i < emberCount; i++) {
      coneDirection(UP, 1.5, V.a, Math.random, 0.8);
      const sp = (4 + Math.random() * 18) * clamp(scale, 0.5, 2);
      const s = 0.012 + Math.random() * 0.03;
      L.spark?.spawn(
        pos.x, pos.y, pos.z, V.a.x * sp, V.a.y * sp + 2, V.a.z * sp,
        0.7 + Math.random() * 1.9,
        s, s * 0.6, 0, 0, 0.55, 0.9, 0.05,
        1, 1, 1, 1, P.EMBER, (Math.random() * 4) | 0, 0, 0.3, Math.random(),
      );
    }

    /* --- debris ----------------------------------------------------------- */
    this.spawnDebris(pos, radius, power, q);

    /* --- ground scorch ---------------------------------------------------- */
    if (groundY > -1e5) {
      GROUND.set(pos.x, groundY, pos.z);
      this.vfx.decals?.spawn({
        point: GROUND, normal: UP, tile: DECAL.CRATER,
        size: radius * 0.55, depth: radius * 0.5, life: 300,
        opacity: 0.8, fadeIn: 0.25,
      });
      this.vfx.decals?.spawn({
        point: GROUND, normal: UP, tile: DECAL.DUST_RING,
        size: radius * 1.15, depth: radius * 0.5, life: 60,
        opacity: 0.35, fadeIn: 0.5,
      });
    }

    /* --- camera --------------------------------------------------------- */
    const cam = this.game.camera;
    if (cam) {
      const d = cam.position.distanceTo(pos);
      const amp = clamp((power * 0.06 * radius) / (3 + d * d * 0.35), 0, 1.6);
      if (amp > 0.01) {
        V.b.copy(pos).sub(cam.position).normalize();
        this.game.bus?.emit('camera:shake', {
          amplitude: amp,
          frequency: 22 + 10 * Math.random(),
          duration: 0.45 + clamp(scale, 0, 2) * 0.35,
          direction: V.b.clone(),
        });
      }
    }
  }

  spawnDebris(pos, radius, power, q) {
    const phys = this.game?.physics;
    if (!phys?.spawnDebris || !this.debrisMesh) return;
    const want = Math.round(clamp(6 + radius * 1.6, 4, 22) * clamp(q, 0.3, 1));
    const n = Math.min(want, this.debrisFree.length);
    for (let i = 0; i < n; i++) {
      const slot = this.debrisFree.pop();
      const size = (0.09 + Math.random() * 0.22) * clamp(radius / 6, 0.5, 2);
      coneDirection(UP, 1.15, V.a, Math.random, 0.65);
      const speed = (3 + Math.random() * 9) * clamp(power / 14, 0.5, 2.2);
      this._scale.set(size, size, size);
      try {
        phys.spawnDebris({
          position: V.b.copy(pos).addScaledVector(V.a, radius * 0.18).clone(),
          velocity: V.a.clone().multiplyScalar(speed).setY(Math.abs(V.a.y) * speed + 2),
          shape: 'sphere',
          radius: size * 0.5,
          mass: size * 6,
          restitution: 0.2,
          friction: 0.75,
          angularVelocity: new THREE.Vector3(
            (Math.random() - 0.5) * 26, (Math.random() - 0.5) * 26, (Math.random() - 0.5) * 26,
          ),
          lifetime: 9 + Math.random() * 5,
          surface: 'concrete',
          instanced: { mesh: this.debrisMesh, index: slot, scale: this._scale.clone() },
          onExpire: () => this._freeDebris(slot),
        });
      } catch (e) {
        this._freeDebris(slot);
      }
    }
  }

  _freeDebris(slot) {
    if (!this.debrisMesh) return;
    this.debrisMesh.setMatrixAt(slot, this._zeroMatrix);
    this.debrisMesh.instanceMatrix.needsUpdate = true;
    if (this.debrisFree.indexOf(slot) < 0) this.debrisFree.push(slot);
  }

  _probeGround(pos, radius) {
    const phys = this.game?.physics;
    if (!phys?.raycast) return pos.y - 0.5;
    try {
      const hit = phys.raycast(pos, DOWN, Math.max(3, radius));
      return hit ? hit.point.y : pos.y - 0.5;
    } catch (e) { return pos.y - 0.5; }
  }

  update(dt) {
    this.time += dt;
    this.balls.forEach((b, i) => {
      if (!b.alive) return;
      b.age += dt;
      const t = b.age / b.life;
      if (t >= 1) {
        b.alive = false; b.mesh.visible = false; this.balls.releaseIndex(i);
        return;
      }
      const k = 1 - Math.pow(1 - t, 2.6);
      const r = b.r0 + (b.r1 - b.r0) * k;
      b.mesh.scale.setScalar(r);
      b.mesh.rotation.y += dt * 0.6;
      b.mat.uniforms.uT.value = t;
      b.mat.uniforms.uDisplace.value = 0.16 + t * 0.42;
      b.mat.uniforms.uIntensity.value = 1.35 - t * 0.5;
    });

    this.rings.forEach((r, i) => {
      if (!r.alive) return;
      r.age += dt;
      const t = r.age / r.life;
      if (t >= 1) {
        r.alive = false; r.mesh.visible = false; this.rings.releaseIndex(i);
        return;
      }
      const k = 1 - Math.pow(1 - t, 2.2);
      const rad = r.r0 + (r.r1 - r.r0) * k;
      r.mesh.scale.set(rad, rad, rad);
      const f = r.peak * Math.pow(1 - t, 2.4);
      r.mat.color.setRGB(f, f * 0.62, f * 0.30);
    });
  }

  clear() {
    this.balls.forEach((b, i) => { b.alive = false; b.mesh.visible = false; this.balls.releaseIndex(i); });
    this.rings.forEach((r, i) => { r.alive = false; r.mesh.visible = false; this.rings.releaseIndex(i); });
    if (this.debrisMesh) {
      this.debrisFree.length = 0;
      for (let i = 0; i < this.debrisMesh.count; i++) {
        this.debrisMesh.setMatrixAt(i, this._zeroMatrix);
        this.debrisFree.push(i);
      }
      this.debrisMesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() {
    this.balls.forEach((b) => { b.mesh.parent?.remove(b.mesh); b.mat.dispose(); });
    this.rings.forEach((r) => { r.mesh.parent?.remove(r.mesh); r.mat.dispose(); });
    this.sphereGeometry.dispose();
    this.ringGeometry.dispose();
    if (this.debrisMesh) {
      this.debrisMesh.parent?.remove(this.debrisMesh);
      this.debrisMesh.geometry.dispose();
      this.debrisMesh.material.dispose();
    }
  }
}

const UP = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);
const DOWN = /* @__PURE__ */ new THREE.Vector3(0, -1, 0);
const GROUND = /* @__PURE__ */ new THREE.Vector3();
const FIRE_LIGHT = /* @__PURE__ */ new THREE.Color(1.0, 0.66, 0.32);
