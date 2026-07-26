import * as THREE from 'three';
import { clamp, lerp, smoothstep } from './Rng.js';

/**
 * Sun, sky ambient, cascaded shadow maps and the practical-light budget.
 *
 * CASCADES. The sun is `settings.cascades` directional lights that share a
 * direction, colour and intensity. Each one owns a shadow camera fitted to the
 * bounding *sphere* of one slice of the view frustum — a sphere rather than a
 * box because its size does not change when the camera rotates, which is half
 * of what stops shadow edges from crawling. The other half is snapping the
 * sphere centre to whole shadow-map texels in light space, so the projection
 * moves in discrete texel steps as the player walks. `ShaderPatch` makes sure a
 * fragment only ever accepts one cascade.
 *
 * DAY CYCLE. `setTimeOfDay` is the single source of truth: it derives the solar
 * elevation and azimuth, runs an airmass extinction to get the sun's colour,
 * and from that drives light intensity, hemisphere fill, environment
 * intensity, fog colour/density, sky-shader parameters and the moment the
 * practicals come on. Nothing else in the world is allowed to hardcode a
 * lighting value.
 *
 * PRACTICALS. Building interiors, braziers and street lamps register hints;
 * a fixed-size pool of point lights is assigned to the nearest hints at night.
 * The pool is fixed because changing the light count in a three.js scene
 * recompiles every material in it, which is a visible hitch mid-firefight.
 */

const DEG = Math.PI / 180;
const SUNRISE = 0.20;
const SUNSET = 0.80;
const MAX_ELEVATION = 68 * DEG;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _centre = new THREE.Vector3();
const _axisX = new THREE.Vector3();
const _axisY = new THREE.Vector3();
const _axisZ = new THREE.Vector3();
const _corner = new THREE.Vector3();

export class Lighting {
  constructor(world) {
    this.world = world;
    this.game = world.game;
    this.cascades = [];
    this.practicals = [];
    this.spots = [];
    this.hints = [];
    this.sunDir = new THREE.Vector3(0.6, 0.6, 0.4).normalize();
    this.moonDir = new THREE.Vector3(-0.6, 0.6, -0.4).normalize();
    this.sunColor = new THREE.Color(1, 0.95, 0.88);
    this.night = 0;
    this.practicalLevel = 0;
    this._assignTimer = 0;
    this._splits = [];
  }

  init() {
    const scene = this.game.scene;
    const settings = this.game.settings || {};
    const n = clamp(Math.round(settings.cascades ?? 3), 1, 4);
    const base = clamp(Math.round(settings.shadowMapSize ?? 2048), 512, 2048);
    const sizeFor = [1, 0.75, 0.5, 0.5];

    this.group = new THREE.Group();
    this.group.name = 'lighting';
    scene.add(this.group);

    this.shadowDistance = settings.preset === 'low' ? 90
      : settings.preset === 'medium' ? 130 : 185;

    for (let i = 0; i < n; i++) {
      const light = new THREE.DirectionalLight(0xffffff, 3);
      light.name = `sun.cascade${i}`;
      const size = Math.max(512, Math.round(base * (sizeFor[i] ?? 0.5) / 64) * 64);
      light.castShadow = true;
      light.shadow.mapSize.set(size, size);
      light.shadow.bias = 0;
      light.shadow.normalBias = 0.02 + i * 0.045;
      light.shadow.radius = i === 0 ? 2.4 : 1.6;
      light.shadow.blurSamples = i === 0 ? 8 : 5;
      light.shadow.camera.near = 0.5;
      light.shadow.camera.far = 400;
      light.target.position.set(0, 0, 0);
      // The cascade lights must appear in the scene in index order: three
      // indexes directionalShadowMap[] by traversal order, and the shader picks
      // the first cascade whose coordinate is in range.
      this.group.add(light);
      this.group.add(light.target);
      this.cascades.push(light);
    }

    // PostFX raymarches this light's shadow map for volumetrics; cascade 1 is
    // the sweet spot — cascade 0 is too tight to hold a full light shaft and
    // the outer cascades are too coarse to keep its edges crisp.
    this.sun = this.cascades[Math.min(1, this.cascades.length - 1)];
    this.sunLight = this.sun;

    this.hemi = new THREE.HemisphereLight(0x9dbbe0, 0x6a5136, 0.5);
    this.hemi.name = 'skyfill';
    this.group.add(this.hemi);

    // Fixed pool: never add or remove lights at runtime.
    const poolSize = settings.preset === 'low' ? 4 : settings.preset === 'medium' ? 6 : 8;
    for (let i = 0; i < poolSize; i++) {
      const p = new THREE.PointLight(0xffb066, 0, 14, 2);
      p.name = `practical${i}`;
      p.castShadow = false;
      p.visible = true;
      this.group.add(p);
      this.practicals.push({ light: p, hint: null, intensity: 0, target: 0 });
    }

    const spotCount = settings.preset === 'low' ? 0 : 2;
    for (let i = 0; i < spotCount; i++) {
      const s = new THREE.SpotLight(0xffc98a, 0, 26, 1.05, 0.55, 1.7);
      s.name = `streetlamp${i}`;
      s.castShadow = true;
      s.shadow.mapSize.set(512, 512);
      s.shadow.camera.near = 0.4;
      s.shadow.camera.far = 30;
      s.shadow.bias = 0;
      s.shadow.normalBias = 0.05;
      s.shadow.radius = 2;
      s.shadow.blurSamples = 4;
      // Static world, static lamp: the map is baked once and then frozen so the
      // cost is paid at boot rather than every frame.
      s.shadow.autoUpdate = false;
      s.shadow.needsUpdate = true;
      s.position.set(0, 6, 0);
      s.target.position.set(0, 0, 0);
      this.group.add(s);
      this.group.add(s.target);
      this.spots.push({ light: s, hint: null, intensity: 0, target: 0 });
    }

    this._computeSplits();
    return this;
  }

  /** Register a candidate practical light position. */
  addHint(hint) {
    this.hints.push({
      position: hint.position.clone(),
      color: new THREE.Color(hint.color ?? 0xffb066),
      intensity: hint.intensity ?? 8,
      distance: hint.distance ?? 12,
      decay: hint.decay ?? 2,
      dayLit: hint.dayLit === true,
      spot: hint.spot === true,
      dir: hint.dir ? hint.dir.clone() : null,
    });
  }

  _computeSplits() {
    const n = this.cascades.length;
    const near = 0.4;
    const far = this.shadowDistance;
    const lambda = 0.72;
    this._splits = [near];
    for (let i = 1; i < n; i++) {
      const f = i / n;
      const log = near * Math.pow(far / near, f);
      const uni = near + (far - near) * f;
      this._splits.push(lambda * log + (1 - lambda) * uni);
    }
    this._splits.push(far);
  }

  /* ---------------------------------------------------------------- */
  /* time of day                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Derive the whole lighting state from a 0..1 clock and return the parameter
   * block the sky shader needs. t=0.22 low golden morning, 0.32 mid-morning,
   * 0.5 noon, 0.78 sunset, 0.88 night.
   */
  setTimeOfDay(t) {
    const tt = ((t % 1) + 1) % 1;
    const span = SUNSET - SUNRISE;
    const phase = Math.PI * (tt - SUNRISE) / span;
    const elevation = MAX_ELEVATION * Math.sin(phase);
    const azimuth = (-100 + 200 * (tt - SUNRISE) / span) * DEG;

    const ce = Math.cos(elevation), se = Math.sin(elevation);
    this.sunDir.set(-Math.sin(azimuth) * ce, se, Math.cos(azimuth) * ce).normalize();
    // The moon trails the sun by half a cycle and rides a slightly tilted arc.
    this.moonDir.set(
      Math.sin(azimuth + 0.35) * ce * 0.92 + 0.10,
      -se * 0.86 + 0.18,
      -Math.cos(azimuth + 0.35) * ce * 0.92,
    ).normalize();

    const y = this.sunDir.y;
    const dayFactor = smoothstep(-0.11, 0.10, y);
    const night = 1 - dayFactor;
    this.night = night;

    // Airmass extinction: the reason a low sun is orange and a high sun is not.
    const airmass = 1 / Math.max(0.055, y + 0.16);
    const k = Math.max(0, airmass - 0.862) * 0.30;
    const ext = new THREE.Color(
      Math.exp(-0.62 * k),
      Math.exp(-1.30 * k),
      Math.exp(-2.95 * k),
    );
    const lum = Math.max(0.03, 0.2126 * ext.r + 0.7152 * ext.g + 0.0722 * ext.b);
    const compensate = Math.pow(lum, -0.22);
    const dayCurve = smoothstep(-0.05, 0.25, y);
    const lowSun = smoothstep(0.40, -0.03, y);

    const sunIntensity = 6.4 * dayCurve * compensate;
    this.sunColor.copy(ext);

    const moonIntensity = 0.34 * night;
    const moonColor = new THREE.Color(0.48, 0.60, 0.92);

    // The cascades become the moon once the sun is down; there is only ever one
    // directional source so the cascade selection in the shader stays valid.
    const useMoon = sunIntensity < moonIntensity;
    const keyDir = useMoon ? this.moonDir : this.sunDir;
    const keyColor = useMoon ? moonColor : this.sunColor;
    const keyIntensity = useMoon ? moonIntensity : sunIntensity;
    this.keyDir = keyDir;

    for (const c of this.cascades) {
      c.color.copy(keyColor);
      c.intensity = keyIntensity;
    }

    // Hemisphere fill: cool sky above, hot sand bounce below.
    const skyFill = new THREE.Color().setRGB(
      lerp(0.030, 0.40, dayFactor) + lowSun * 0.10,
      lerp(0.042, 0.52, dayFactor) + lowSun * 0.06,
      lerp(0.085, 0.78, dayFactor),
    );
    const groundFill = new THREE.Color().setRGB(
      lerp(0.020, 0.34, dayFactor) + lowSun * 0.14,
      lerp(0.017, 0.26, dayFactor) + lowSun * 0.07,
      lerp(0.014, 0.17, dayFactor),
    );
    this.hemi.color.copy(skyFill);
    this.hemi.groundColor.copy(groundFill);
    this.hemi.intensity = lerp(0.55, 0.85, dayFactor);

    const scene = this.game.scene;
    if ('environmentIntensity' in scene) {
      scene.environmentIntensity = lerp(1.45, 1.0, dayFactor);
    }

    /* ---- fog ---- */
    const horizon = new THREE.Color().setRGB(
      lerp(0.012, 0.62, dayFactor) + lowSun * dayFactor * 0.85 * ext.r,
      lerp(0.016, 0.70, dayFactor) + lowSun * dayFactor * 0.44 * ext.g,
      lerp(0.030, 0.92, dayFactor) + lowSun * dayFactor * 0.16 * ext.b,
    );
    if (!scene.fog || !scene.fog.isFogExp2) {
      scene.fog = new THREE.FogExp2(0x000000, 0.0026);
    }
    scene.fog.color.copy(horizon).multiplyScalar(lerp(0.22, 0.42, dayFactor));
    scene.fog.density = lerp(0.0042, 0.0022, dayFactor) + lowSun * dayFactor * 0.0022;

    /* ---- practicals ---- */
    this.practicalLevel = smoothstep(0.20, -0.02, y);

    /* ---- sky shader block ---- */
    const skyParams = {
      sunDir: this.sunDir,
      moonDir: this.moonDir,
      sunTint: ext,
      moonTint: new THREE.Color(0.55, 0.66, 0.95),
      groundColor: new THREE.Color().setRGB(
        lerp(0.008, 0.115, dayFactor),
        lerp(0.007, 0.093, dayFactor),
        lerp(0.008, 0.070, dayFactor),
      ),
      turbidity: lerp(2.6, 4.6, lowSun),
      skyLuminance: lerp(0.05, 1.0, dayFactor),
      sunDiscIntensity: lerp(28, 120, dayCurve),
      night,
      cloudCover: 0.54,
      cloudLight: lerp(0.16, 1.0, dayFactor) * lerp(1.0, 0.72, lowSun * dayFactor)
        + lowSun * dayFactor * 0.5,
      haze: lerp(0.05, 0.11, dayFactor) + lowSun * dayFactor * 0.10,
      stars: night,
    };

    this.timeOfDay = tt;
    this.dayFactor = dayFactor;
    this.lowSun = lowSun;
    return skyParams;
  }

  /* ---------------------------------------------------------------- */
  /* per frame                                                         */
  /* ---------------------------------------------------------------- */

  update(dt) {
    this._updatePracticals(dt);
  }

  /**
   * Cascade fitting runs in lateUpdate because it has to read the *final*
   * camera transform for the frame — the player controller settles the camera
   * during its own update, and a cascade fitted to last frame's camera pops at
   * the split boundaries when you turn quickly.
   */
  lateUpdate() {
    this._fitCascades();
  }

  _fitCascades() {
    const camera = this.game.engine?.camera;
    if (!camera || !this.cascades.length) return;

    const e = camera.matrixWorld.elements;
    _right.set(e[0], e[1], e[2]).normalize();
    _up.set(e[4], e[5], e[6]).normalize();
    _fwd.set(-e[8], -e[9], -e[10]).normalize();
    const camPos = _v1.set(e[12], e[13], e[14]);

    const tanV = Math.tan(camera.fov * 0.5 * DEG);
    const tanH = tanV * camera.aspect;

    const dir = this.keyDir || this.sunDir;
    // Light-space basis, matching how three builds the shadow camera (up = +Y).
    _axisZ.copy(dir).normalize();
    if (Math.abs(_axisZ.y) > 0.9995) _axisZ.y = Math.sign(_axisZ.y || 1) * 0.9995;
    _axisZ.normalize();
    _axisX.set(0, 1, 0).cross(_axisZ).normalize();
    _axisY.copy(_axisZ).cross(_axisX).normalize();

    for (let i = 0; i < this.cascades.length; i++) {
      const light = this.cascades[i];
      const near = this._splits[i];
      const far = this._splits[i + 1];

      // Analytic bounding sphere of the slice: the centre sits on the view
      // axis, so its radius depends only on near/far/fov and never on where the
      // camera is looking. That invariance is what kills shadow swim.
      const a = 1 + tanV * tanV + tanH * tanH;
      let centreDist = 0.5 * (near + far) * a;
      centreDist = Math.max(near, Math.min(far * a, centreDist));
      _centre.copy(camPos).addScaledVector(_fwd, centreDist);

      let radius = 0;
      for (let c = 0; c < 8; c++) {
        const d = (c & 4) ? far : near;
        const sx = (c & 1) ? 1 : -1;
        const sy = (c & 2) ? 1 : -1;
        _corner.copy(camPos)
          .addScaledVector(_fwd, d)
          .addScaledVector(_right, sx * d * tanH)
          .addScaledVector(_up, sy * d * tanV);
        radius = Math.max(radius, _corner.distanceTo(_centre));
      }
      // Quantised, and padded a little to absorb a frame of camera lag.
      radius = Math.ceil(radius * 1.04 * 16) / 16;

      // Snap the centre to whole texels along the light's X/Y so the projection
      // advances in texel steps instead of sliding continuously.
      const mapSize = light.shadow.mapSize.x;
      const texel = (2 * radius) / mapSize;
      const lx = Math.round(_centre.dot(_axisX) / texel) * texel;
      const ly = Math.round(_centre.dot(_axisY) / texel) * texel;
      const lz = _centre.dot(_axisZ);
      _v2.copy(_axisX).multiplyScalar(lx)
        .addScaledVector(_axisY, ly)
        .addScaledVector(_axisZ, lz);

      const back = Math.max(60, radius * 2.4);
      light.target.position.copy(_v2);
      light.position.copy(_v2).addScaledVector(_axisZ, back);
      light.target.updateMatrixWorld();
      light.updateMatrixWorld();

      const cam = light.shadow.camera;
      cam.left = -radius; cam.right = radius;
      cam.top = radius; cam.bottom = -radius;
      cam.near = 0.5;
      cam.far = back + radius * 2.2;
      cam.updateProjectionMatrix();

      // Normal bias must scale with the cascade's texel footprint or the near
      // cascade acne-fights while the far one peter-pans.
      light.shadow.normalBias = Math.max(0.012, texel * 1.35);
    }
  }

  _updatePracticals(dt) {
    const camera = this.game.engine?.camera;
    if (!camera) return;
    const level = this.practicalLevel;

    this._assignTimer -= dt;
    if (this._assignTimer <= 0 && this.hints.length) {
      this._assignTimer = 0.4;
      this._assign(camera.position, this.practicals, false);
      this._assign(camera.position, this.spots, true);
    }

    const rate = Math.min(1, dt * 4.5);
    for (const slot of this.practicals) {
      const want = slot.hint ? slot.target * (slot.hint.dayLit ? 1 : level) : 0;
      slot.intensity = lerp(slot.intensity, want, rate);
      slot.light.intensity = slot.intensity;
    }
    for (const slot of this.spots) {
      const want = slot.hint ? slot.target * (slot.hint.dayLit ? 1 : level) : 0;
      const prev = slot.intensity;
      slot.intensity = lerp(slot.intensity, want, rate);
      slot.light.intensity = slot.intensity;
      // The lamp shadow map is frozen; refresh it only as it fades in.
      if (prev < 0.02 && slot.intensity >= 0.02) slot.light.shadow.needsUpdate = true;
    }
  }

  _assign(camPos, pool, wantSpot) {
    if (!pool.length) return;
    const candidates = [];
    for (const h of this.hints) {
      if (!!h.spot !== wantSpot) continue;
      const d = h.position.distanceToSquared(camPos);
      if (d > 90 * 90) continue;
      candidates.push({ h, d });
    }
    candidates.sort((a, b) => a.d - b.d);

    // A slot keeps its hint while that hint is still one of the nearest N.
    // Once it drops out it is *released*: the light fades to nothing first and
    // only then becomes available for a new hint, so a light never teleports.
    const taken = new Set();
    for (const slot of pool) {
      if (!slot.hint) continue;
      const idx = candidates.findIndex((c) => c.h === slot.hint);
      const stillNear = idx >= 0 && idx < pool.length;
      if (stillNear) { slot.releasing = false; taken.add(slot.hint); }
      else if (slot.intensity < 0.05) { slot.hint = null; slot.releasing = false; }
      else slot.releasing = true;
    }
    for (const slot of pool) {
      if (slot.hint) continue;
      const next = candidates.find((c) => !taken.has(c.h));
      if (!next) continue;
      taken.add(next.h);
      slot.hint = next.h;
      this._bind(slot, next.h);
    }
    for (const slot of pool) {
      slot.target = slot.hint && !slot.releasing ? slot.hint.intensity : 0;
    }
  }

  _bind(slot, hint) {
    const l = slot.light;
    l.position.copy(hint.position);
    l.color.copy(hint.color);
    l.distance = hint.distance;
    l.decay = hint.decay;
    if (l.isSpotLight && hint.dir) {
      l.target.position.copy(hint.position).add(hint.dir);
      l.target.updateMatrixWorld();
      l.shadow.needsUpdate = true;
    }
    slot.intensity = 0;
    l.intensity = 0;
  }

  dispose() {
    for (const c of this.cascades) c.dispose?.();
    for (const p of this.practicals) p.light.dispose?.();
    for (const s of this.spots) s.light.dispose?.();
  }
}
