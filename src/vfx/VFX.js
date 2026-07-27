import * as THREE from 'three';

import {
  buildPuffAtlas, buildSparkAtlas, buildChipAtlas, buildBloodAtlas,
  buildDecalAtlas, buildRampTexture, buildNoiseTexture, buildFireRamp,
  buildGlowTexture, DECAL,
} from './Textures.js';
import { PROFILES, P } from './Profiles.js';
import { ParticleSystem, MODE, STRETCH } from './Particles.js';
import { DecalSystem } from './Decals.js';
import { LightPool } from './Lights.js';
import { MuzzleFlash } from './Muzzle.js';
import { Tracers } from './Tracers.js';
import { ImpactFX } from './Impacts.js';
import { BloodFX } from './Blood.js';
import { Explosions } from './Explosions.js';
import { SmokeSystem } from './Smoke.js';
import { AmbientLife } from './Ambient.js';
import { DistortionField } from './Distortion.js';
import { V, clamp, saturate, coneDirection, lodScale, TAU } from './Util.js';

/**
 * OPERATION BLACKOUT — transient visuals.
 *
 * Every effect in the game that is not part of the level, the player or the
 * weapon lives here: muzzle flashes, tracers, impacts, decals, blood,
 * explosions, smoke and the ambient particulate that keeps a still frame from
 * looking dead.
 *
 * Design rules this module holds itself to:
 *
 *  - **Nothing is loaded.** Every texture is generated at boot from noise and
 *    canvas 2D: flipbook smoke with baked normals, a 16-tile decal sheet with
 *    albedo/normal/ORM, spark streaks, debris silhouettes, blood.
 *  - **Nothing allocates per frame.** Particles are simulated in the vertex
 *    shader from their spawn record; the CPU writes 24 floats once and never
 *    touches them again. Meshes, lights and decal slots are pooled.
 *  - **Nothing throws.** Every other system is reached through optional
 *    chaining and every event handler is defensive, because one exception in
 *    `update()` would kill the frame loop for ten other modules.
 *
 * Budgets come from `settings.particleBudget` and `settings.decalBudget` and
 * are re-checked at runtime, so the quality menu takes effect immediately.
 */
export class VFX {
  constructor(game) {
    this.game = game;
    this.time = 0;
    this.quality = 1;
    this.enabled = true;
    this.layers = {};
    this.wind = new THREE.Vector3(0.9, 0, 0.55);
    this._budgetCheck = 0;
    this._env = {
      sunDirView: new THREE.Vector3(0, 1, 0),
      sunColor: new THREE.Vector3(1, 0.95, 0.86),
      fogColor: new THREE.Vector3(0.5, 0.55, 0.62),
      fogDensity: 0,
      wind: this.wind,
      sunElevation: 0.6,
      depth: null,
      soft: false,
    };
    this._unsubs = [];
    this._muzzleWorld = new THREE.Vector3();
    this._muzzleView = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._tmpColor = new THREE.Color();
    this._lastFire = -1;
    this._hazeTarget = 0;
    this._haze = 0;
  }

  /* ====================================================================== */
  /* boot                                                                    */
  /* ====================================================================== */

  async init() {
    const g = this.game;
    const s = g.settings || {};

    this.quality = QUALITY_SCALE[s.preset] ?? 1;

    /* ---- procedural texture set ---------------------------------------- */
    this.tex = {
      smoke: buildPuffAtlas({
        tile: 96, tilesX: 8, tilesY: 8, blobs: 22, growth: 1.8, erode: 0.45,
        detail: 1.0, wispiness: 1.05, normalStrength: 0.85, seed: 91, name: 'vfxSmokeAtlas',
      }),
      dust: buildPuffAtlas({
        tile: 96, tilesX: 4, tilesY: 4, blobs: 16, growth: 2.2, erode: 0.40,
        detail: 1.35, wispiness: 0.85, normalStrength: 0.7, seed: 313, name: 'vfxDustAtlas',
      }),
      spark: buildSparkAtlas({ tile: 128 }),
      chip: buildChipAtlas({ tile: 96 }),
      blood: buildBloodAtlas({ tile: 96 }),
      glow: buildGlowTexture({ size: 256 }),
      noise: buildNoiseTexture(256, 24),
      fireRamp: buildFireRamp(128),
      ramps: buildRampTexture(PROFILES, 128),
    };
    this.decalAtlas = buildDecalAtlas({ tile: 192, seed: 777 });

    const rampRows = PROFILES.length * 2;

    /* ---- particle layers ------------------------------------------------ */
    this.particles = new ParticleSystem(g, this.tex);
    this.particles.wind.copy(this.wind);

    const common = { ramp: this.tex.ramps, rampRows };

    this.layers.ambientSmoke = this.particles.add('ambientSmoke', {
      ...common, map: this.tex.smoke, tilesX: 8, tilesY: 8,
      mode: MODE.LIT, blendFrames: true, stretch: STRETCH.NONE,
      capacity: 256, softness: 4.0, turbulence: 0.6, scatter: 1.5,
      wind: 0.35, renderOrder: 6, camFadeStart: 0.4, camFadeRange: 1.2,
    });
    this.layers.smoke = this.particles.add('smoke', {
      ...common, map: this.tex.smoke, tilesX: 8, tilesY: 8,
      mode: MODE.LIT, blendFrames: true, capacity: 512,
      softness: 1.6, turbulence: 1.0, scatter: 1.25, wind: 0.22,
      renderOrder: 11, camFadeStart: 0.3, camFadeRange: 0.7,
    });
    this.layers.dust = this.particles.add('dust', {
      ...common, map: this.tex.dust, tilesX: 4, tilesY: 4,
      mode: MODE.LIT, blendFrames: true, capacity: 512,
      softness: 1.1, turbulence: 1.0, scatter: 0.95, wind: 0.14,
      renderOrder: 12, camFadeStart: 0.3, camFadeRange: 0.6,
    });
    this.layers.chip = this.particles.add('chip', {
      ...common, map: this.tex.chip, tilesX: 4, tilesY: 4,
      mode: MODE.SHADED, capacity: 384, softness: 0.18, turbulence: 0.6,
      renderOrder: 13, camFadeStart: 0.16, camFadeRange: 0.3,
    });
    this.layers.blood = this.particles.add('blood', {
      ...common, map: this.tex.blood, tilesX: 4, tilesY: 4,
      mode: MODE.SHADED, capacity: 320, softness: 0.35, turbulence: 0.8,
      renderOrder: 13, camFadeStart: 0.2, camFadeRange: 0.35,
    });
    this.layers.spark = this.particles.add('spark', {
      ...common, map: this.tex.spark, tilesX: 4, tilesY: 4,
      mode: MODE.UNLIT, additive: true, stretch: STRETCH.VELOCITY,
      capacity: 768, softness: 0.28, turbulence: 0.5, stretchScale: 0.02,
      renderOrder: 14, camFadeStart: 0.14, camFadeRange: 0.25,
    });
    this.layers.tracer = this.particles.add('tracer', {
      ...common, map: this.tex.spark, tilesX: 4, tilesY: 4,
      mode: MODE.UNLIT, additive: true, stretch: STRETCH.WORLD,
      capacity: 128, softness: 0.4, turbulence: 0,
      renderOrder: 15, camFadeStart: 0.1, camFadeRange: 0.2,
    });
    this.layers.vmSpark = this.particles.add('vmSpark', {
      ...common, map: this.tex.spark, tilesX: 4, tilesY: 4,
      mode: MODE.UNLIT, additive: true, stretch: STRETCH.VELOCITY,
      capacity: 192, softness: 0.2, turbulence: 0.6, viewmodel: true,
      renderOrder: 14, camFadeStart: 0.02, camFadeRange: 0.05,
    });
    this.layers.vmSmoke = this.particles.add('vmSmoke', {
      ...common, map: this.tex.dust, tilesX: 4, tilesY: 4,
      mode: MODE.LIT, blendFrames: true, capacity: 160, viewmodel: true,
      softness: 0.4, turbulence: 1.2, scatter: 1.1,
      renderOrder: 13, camFadeStart: 0.02, camFadeRange: 0.06,
    });

    /* ---- subsystems ----------------------------------------------------- */
    this.decals = new DecalSystem(g, this.decalAtlas);

    const lightCount = s.preset === 'low' ? 2 : s.preset === 'medium' ? 3 : 4;
    this.lights = new LightPool(g.scene, lightCount, { distance: 12, decay: 2 });
    this.viewLights = new LightPool(g.engine?.viewScene, 2, { distance: 3.2, decay: 2 });

    this.muzzle = new MuzzleFlash(g, { glowTexture: this.tex.glow, count: 5 });
    this.tracers = new Tracers(g, this.layers.tracer);
    this.impacts = new ImpactFX(this);
    this.blood = new BloodFX(this);
    this.explosions = new Explosions(this, {
      fireRamp: this.tex.fireRamp,
      noise: this.tex.noise,
      debrisCount: s.preset === 'low' ? 24 : 72,
    });
    this.smoke = new SmokeSystem(this, this.layers.ambientSmoke);
    this.distortion = new DistortionField(g, this.tex.noise, {
      waves: s.preset === 'low' ? 2 : 4,
      heat: s.preset !== 'low',
    });
    this.ambient = new AmbientLife(this, {
      sparkAtlas: this.tex.spark,
      budget: (s.particleBudget ?? 3000) * 0.3,
    });

    this._applyBudget(true);
    // Distant burning columns are skyline dressing. Two or three of them, kept
    // inside the level's own footprint, so they never become a grey wash across
    // the horizon and never stretch the layer's bounds off the map.
    this.smoke.placeColumns(s.preset === 'low' ? 1 : 2, { minDist: 115, maxDist: 195 });

    this._bindEvents();
    return this;
  }

  _applyBudget(force = false) {
    const s = this.game.settings || {};
    const total = clamp(s.particleBudget ?? 3000, 200, 20000);
    this.particles.setBudget(total, {
      ambientSmoke: 0.13, smoke: 0.18, dust: 0.19, chip: 0.12,
      blood: 0.08, spark: 0.26, tracer: 128, vmSpark: 192, vmSmoke: 160,
    });
    this.decals.setCapacity(clamp(s.decalBudget ?? 128, 16, 1024));
    this.ambient.setBudget(total * 0.3);
    this.quality = QUALITY_SCALE[s.preset] ?? 1;
  }

  /* ====================================================================== */
  /* event wiring                                                            */
  /* ====================================================================== */

  _bindEvents() {
    const bus = this.game.bus;
    if (!bus?.on) return;
    const on = (name, fn) => this._unsubs.push(bus.on(name, (e) => {
      if (!this.enabled) return;
      try { fn(e); } catch (err) {
        if (!this._loggedError) {
          this._loggedError = true;
          console.error(`[VFX] handler for "${name}" failed`, err);
        }
      }
    }));

    on('bullet:impact', (e) => this.spawnImpact(e));
    on('weapon:fire', (e) => this._onFire(e));
    on('explosion', (e) => this.spawnExplosion(e));
    on('bullet:whizby', (e) => this.tracers.whizby(e?.distance, this.game.camera));
    on('enemy:killed', (e) => this._onKill(e));
    on('damage:dealt', (e) => this._onDamage(e));
    on('player:land', (e) => this._onLand(e));
    on('player:footstep', (e) => this._onFootstep(e));
    on('state', (e) => {
      if (e?.next === 'playing' && e?.prev === 'menu') this.clear();
    });
  }

  _onFire(e) {
    if (!e) return;
    const cam = this.game.camera;
    const origin = e.origin;
    const dir = this._dir.copy(e.dir || FORWARD);
    if (dir.lengthSq() < 1e-8) dir.set(0, 0, -1);
    dir.normalize();

    const weapon = e.weapon || null;
    const scale = weapon?.muzzleScale ?? weapon?.flashScale ?? 0.28;
    const suppressed = !!(weapon?.suppressed ?? weapon?.silenced);
    const worldPoint = this._muzzleWorld.copy(origin || (cam ? cam.position : ZERO));
    const distToCam = cam ? worldPoint.distanceTo(cam.position) : 99;
    const firstPerson = distToCam < 1.6;

    /* ---- flash ---------------------------------------------------------- */
    const flashScale = scale * (suppressed ? 0.42 : 1);
    const intensity = suppressed ? 0.35 : 1;
    const hue = suppressed ? SUPPRESSED_HUE : FLASH_HUE;

    if (firstPerson) {
      this._toViewSpace(worldPoint, this._muzzleView);
      this.muzzle.fire({
        position: this._muzzleView, direction: dir, scale: flashScale,
        viewmodel: true, intensity, color: hue,
      });
      this.viewLights?.flash(this._muzzleView, 8 * intensity, 0.075, MUZZLE_LIGHT, 0, 3.0);
    } else {
      this.muzzle.fire({
        position: worldPoint, direction: dir, scale: flashScale,
        viewmodel: false, intensity, color: hue,
      });
    }
    // The world light always exists so the muzzle throws real light on walls,
    // even when the flash geometry itself lives in the viewmodel pass.
    this.lights?.flash(worldPoint, 17 * intensity, 0.085, MUZZLE_LIGHT, 0, 9);

    /* ---- muzzle gases --------------------------------------------------- */
    const q = this.quality;
    const smokeLayer = firstPerson ? this.layers.vmSmoke : this.layers.smoke;
    const sparkLayer = firstPerson ? this.layers.vmSpark : this.layers.spark;
    const p = firstPerson ? this._muzzleView : worldPoint;

    const puffs = Math.max(1, Math.round((suppressed ? 4 : 2) * q));
    for (let i = 0; i < puffs; i++) {
      coneDirection(dir, 0.45, V.a, Math.random, 1.4);
      const sp = 1.4 + Math.random() * 2.6;
      const s0 = flashScale * (0.32 + Math.random() * 0.3);
      smokeLayer?.spawn(
        p.x, p.y, p.z, V.a.x * sp, V.a.y * sp + 0.25, V.a.z * sp,
        (suppressed ? 1.1 : 0.55) + Math.random() * 0.7,
        s0, s0 * (3.5 + Math.random() * 3), Math.random() * TAU, (Math.random() - 0.5) * 2.2,
        3.4, -0.14, 0,
        1, 1, 1, suppressed ? 0.7 : 0.42,
        P.SMOKE_LIGHT, 0, firstPerson ? 15 : 63, firstPerson ? 0.5 : 1.2, Math.random(),
      );
    }

    if (!suppressed) {
      const embers = Math.round(5 * q) + 2;
      for (let i = 0; i < embers; i++) {
        coneDirection(dir, 0.55, V.a, Math.random, 1.8);
        const sp = 2.5 + Math.random() * 7;
        const sz = 0.006 + Math.random() * 0.012;
        sparkLayer?.spawn(
          p.x, p.y, p.z, V.a.x * sp, V.a.y * sp, V.a.z * sp,
          0.14 + Math.random() * 0.3,
          sz, sz * 0.5, 0, 0, 1.4, 0.9, 0.05,
          1, 1, 1, 1, P.SPARK, (Math.random() * 4) | 0, 0, 0.2, Math.random(),
        );
      }
      // Lingering world-space haze at the barrel, independent of the viewmodel
      // pass, so a firefight slowly fills the air.
      if (Math.random() < 0.55) {
        const s0 = flashScale * 0.5;
        this.layers.smoke?.spawn(
          worldPoint.x, worldPoint.y, worldPoint.z,
          dir.x * 0.5, dir.y * 0.5 + 0.18, dir.z * 0.5,
          2.4 + Math.random() * 2.6,
          s0, s0 * (6 + Math.random() * 5), Math.random() * TAU, (Math.random() - 0.5) * 0.6,
          1.0, -0.06, 0,
          1, 1, 1, 0.16, P.HAZE, 0, 63, 2.0, Math.random(),
        );
      }
      this._hazeTarget = Math.min(1, this._hazeTarget + 0.10);
    }

    /* ---- tracer ---------------------------------------------------------- */
    const trace = weapon?.tracerEvery !== undefined
      ? (this.tracers.every = Math.max(1, weapon.tracerEvery), this.tracers.shouldTrace())
      : this.tracers.shouldTrace(weapon?.alwaysTracer === true);
    if (trace) {
      this.tracers.fire({
        origin: worldPoint,
        direction: dir,
        distance: weapon?.range ?? 160,
        speed: weapon?.tracerSpeed ?? (suppressed ? 300 : 400),
        width: weapon?.tracerWidth ?? 0.03,
        color: weapon?.tracerColor,
      });
    }
  }

  _onKill(e) {
    const point = e?.point || e?.enemy?.position;
    if (!point) return;
    this.blood?.gush(point, e?.headshot ? UP : DOWN_ISH, { headshot: !!e?.headshot, q: this.quality });
    this.blood?.pool(point, { radius: e?.headshot ? 0.85 : 0.7, grow: 6.5 });
  }

  _onDamage(e) {
    if (!e?.headshot || !e?.point) return;
    this.blood?.gush(e.point, UP, { headshot: true, q: this.quality * 0.6 });
  }

  _onLand(e) {
    const impact = clamp(e?.impact ?? 0, 0, 1);
    if (impact < 0.12) return;
    const cam = this.game.camera;
    if (!cam) return;
    FEET.copy(cam.position);
    FEET.y -= 1.55;
    let surface = 'concrete';
    try { surface = this.game.physics?.groundSurfaceAt?.(FEET) || 'concrete'; } catch (err) { /* not built */ }
    this._groundPuff(FEET, surface, 3 + impact * 6, 1.1 + impact);
  }

  _onFootstep(e) {
    if (!e?.position) return;
    const surface = e.surface || 'concrete';
    if (surface !== 'sand' && surface !== 'dirt' && surface !== 'foliage') return;
    this._groundPuff(e.position, surface, e.running ? 2 : 1, 0.5);
  }

  _groundPuff(position, surface, count, power) {
    const layer = this.layers.dust;
    if (!layer) return;
    const sandy = surface === 'sand';
    const dirty = surface === 'dirt' || surface === 'foliage';
    const n = Math.max(1, Math.round(count * this.quality));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const sp = (0.4 + Math.random() * 1.5) * power;
      const s0 = 0.05 + Math.random() * 0.07;
      layer.spawn(
        position.x + Math.cos(a) * 0.15, position.y + 0.05, position.z + Math.sin(a) * 0.15,
        Math.cos(a) * sp, 0.35 * power + Math.random() * 0.5, Math.sin(a) * sp,
        0.7 + Math.random() * 1.1,
        s0, s0 * (4 + Math.random() * 4), Math.random() * TAU, (Math.random() - 0.5) * 1.0,
        3.0, 0.1, 0,
        sandy ? 1 : dirty ? 0.72 : 0.85, sandy ? 1 : dirty ? 0.66 : 0.84, sandy ? 1 : dirty ? 0.56 : 0.82,
        0.6, sandy ? P.DUST_SAND : P.DUST_CONCRETE, 0, 15, 1.0, Math.random(),
      );
    }
  }

  /** Map a world-space point into the first-person pass's space. */
  _toViewSpace(worldPoint, out) {
    const cam = this.game.camera;
    const view = this.game.engine?.viewCamera;
    out.copy(worldPoint);
    if (!cam || !view) return out;
    cam.updateMatrixWorld();
    view.updateMatrixWorld();
    cam.worldToLocal(out);
    view.localToWorld(out);
    return out;
  }

  /* ====================================================================== */
  /* public API                                                              */
  /* ====================================================================== */

  /** `bullet:impact` payload shape: {point, normal, surface, dir, object}. */
  spawnImpact(o) { this.impacts?.spawn(o); }

  /** Muzzle flash + light. See `_onFire` for the full weapon-driven version. */
  spawnMuzzleFlash(o = {}) {
    const rig = this.muzzle?.fire(o);
    if (o.position && !o.viewmodel) {
      this.lights?.flash(o.position, 17 * (o.intensity ?? 1), 0.08, MUZZLE_LIGHT, 0, 9);
    }
    return rig;
  }

  spawnTracer(o) { this.tracers?.fire(o); }

  /** @param {Object} o see DecalSystem.spawn */
  spawnDecal(o) { return this.decals?.spawn(o); }

  /** `explosion` payload shape: {position, radius, power}. */
  spawnExplosion(o) { this.explosions?.spawn(o); }

  spawnShockwave(position, { radius = 8, duration = 0.35, power = 1 } = {}) {
    return this.distortion?.shockwave(position, radius, duration, power);
  }

  spawnBlood(o = {}) {
    this.blood?.spray(o.point, o.normal || UP, o.dir || DOWN_ISH, o.amount ?? this.quality);
  }

  spawnBloodPool(position, o) { return this.blood?.pool(position, o); }

  spawnSmokeScreen(position, o) { return this.smoke?.screen(position, o); }

  spawnSmokeWisp(position, direction, o) { this.smoke?.wisp(position, direction, o); }

  spawnSparks(o = {}) {
    if (!o.point) return;
    NORMAL.copy(o.normal || UP).normalize();
    this.impacts?.sparks(o.point, NORMAL, o.direction ? DIRV.copy(o.direction).normalize() : NORMAL,
      Math.round((o.count ?? 12) * this.quality), o);
  }

  spawnDust(o = {}) {
    if (!o.point) return;
    NORMAL.copy(o.normal || UP).normalize();
    this.impacts?.puff(this.layers.dust, o.point, NORMAL,
      Math.round((o.count ?? 6) * this.quality), o);
  }

  spawnFragments(o = {}) {
    if (!o.point) return;
    NORMAL.copy(o.normal || UP).normalize();
    this.impacts?.fragments(o.point, NORMAL, o.direction ? DIRV.copy(o.direction).normalize() : NORMAL,
      Math.round((o.count ?? 8) * this.quality), o);
  }

  /** Physics-driven chunks; delegates to `physics.spawnDebris`. */
  spawnDebrisChunks(position, { radius = 3, power = 12 } = {}) {
    this.explosions?.spawnDebris(position, radius, power, this.quality);
  }

  /** Instantaneous additive pop at a point — hit flashes, sparks, impacts. */
  spawnFlash(point, normal, size = 0.08, intensity = 1) {
    NORMAL.copy(normal || UP).normalize();
    this.impacts?.flash(point, NORMAL, size, intensity);
  }

  /** Low-level access for other systems that want a bespoke emitter. */
  emit(layerName, args) {
    const layer = this.layers[layerName];
    if (!layer) return;
    layer.spawn.apply(layer, args);
  }

  setQuality(scale) { this.quality = clamp(scale, 0.1, 2); }

  setWind(x, y, z) {
    this.wind.set(x, y, z);
    this.particles?.wind.copy(this.wind);
  }

  clear() {
    this.particles?.clear();
    this.decals?.clear();
    this.lights?.clear();
    this.viewLights?.clear();
    this.muzzle?.clear();
    this.explosions?.clear();
    this.distortion?.clear();
    this.smoke?.clear();
  }

  stats() {
    return {
      particles: this.particles?.stats(),
      decals: this.decals?.stats(),
      quality: this.quality,
    };
  }

  /* ====================================================================== */
  /* frame                                                                   */
  /* ====================================================================== */

  update(dt) {
    if (!this.enabled) return;
    const d = clamp(dt || 0, 0, 0.1);
    this.time += d;

    this._budgetCheck -= d;
    if (this._budgetCheck <= 0) {
      this._budgetCheck = 1.0;
      try { this._applyBudget(); } catch (e) { /* mid-resize */ }
    }

    const g = this.game;
    const postfx = g.postfx;
    const depth = postfx?.hasGBuffer ? (postfx.gbufferRT?.depthTexture || null) : null;
    const soft = !!depth;

    // Wind: a slow rotation plus gusting, so smoke and sand never look canned.
    const wt = this.time * 0.07;
    const gust = 0.65 + 0.35 * Math.sin(this.time * 0.31) * Math.sin(this.time * 0.13 + 1.7);
    this.wind.set(Math.cos(wt) * 1.15 * gust, 0, Math.sin(wt * 0.83) * 1.15 * gust);
    if (g.world?.wind?.isVector3) this.wind.copy(g.world.wind);
    this.particles.wind.copy(this.wind);

    try {
      this.particles.update(d, g.camera, g.engine?.viewCamera, depth, soft);
    } catch (e) { this._once('particles', e); }

    const env = this._env;
    env.sunDirView.copy(this.particles._sunDirView);
    env.sunColor.copy(this.particles._sunColor);
    env.fogColor.copy(this.particles._fogColor);
    env.fogDensity = this.particles._fogDensity;
    env.wind = this.wind;
    // Ambient fields do their own manual depth test against this; without it
    // they draw straight through the level.
    env.depth = depth;
    env.soft = soft;

    try { this.decals.update(d, this.time); } catch (e) { this._once('decals', e); }
    try { this.lights.update(d); this.viewLights.update(d); } catch (e) { this._once('lights', e); }
    try { this.blood.update(d); } catch (e) { this._once('blood', e); }
    try { this.explosions.update(d); } catch (e) { this._once('explosions', e); }
    try { this.smoke.update(d); } catch (e) { this._once('smoke', e); }
  }

  lateUpdate(dt) {
    if (!this.enabled) return;
    const d = clamp(dt || 0, 0, 0.1);
    const g = this.game;
    const cam = g.camera;
    const postfx = g.postfx;

    try {
      this.muzzle.update(d, cam, g.engine?.viewCamera);
    } catch (e) { this._once('muzzle', e); }

    try {
      this.ambient.update(d, cam, this._env);
    } catch (e) { this._once('ambient', e); }

    // Heat shimmer: strongest with a high sun, and pumped briefly by sustained
    // fire so a firefight visibly disturbs the air.
    let sunY = g.world?.lighting?.sunDir?.y ?? g.world?.sunDirection?.y ?? 0.6;
    if (!(sunY - sunY === 0)) sunY = 0.6;
    this._hazeTarget *= Math.exp(-d * 0.7);
    // Deliberately small. Ground shimmer is a detail you notice on a long look
    // down a street, not a layer over the frame.
    this._haze += (saturate(sunY * 1.6 - 0.25) * 0.20 + this._hazeTarget * 0.14 - this._haze)
      * (1 - Math.exp(-d * 2.5));
    this.distortion?.setHeat(this._haze);

    // Previous frame's composed image, used as the refraction source. It is one
    // frame stale, which for a 300 ms blast wave is invisible.
    const prev = (g.settings?.sharpen ?? 0.35) > 0.001 ? (postfx?.ldrRT?.texture || null) : null;
    const depth = postfx?.hasGBuffer ? (postfx.gbufferRT?.depthTexture || null) : null;
    try {
      this.distortion.update(d, cam, prev, depth, !!depth);
    } catch (e) { this._once('distortion', e); }
  }

  _once(tag, err) {
    if (!this._errors) this._errors = new Set();
    if (this._errors.has(tag)) return;
    this._errors.add(tag);
    console.error(`[VFX] ${tag} update failed; that stage is degraded`, err);
  }

  dispose() {
    for (const off of this._unsubs) off?.();
    this._unsubs.length = 0;
    this.particles?.dispose();
    this.decals?.dispose();
    this.lights?.dispose();
    this.viewLights?.dispose();
    this.muzzle?.dispose();
    this.explosions?.dispose();
    this.distortion?.dispose();
    this.ambient?.dispose();
    for (const k in this.tex) this.tex[k]?.dispose?.();
    this.decalAtlas?.albedo?.dispose();
    this.decalAtlas?.normal?.dispose();
    this.decalAtlas?.orm?.dispose();
  }
}

const QUALITY_SCALE = { low: 0.35, medium: 0.65, high: 1.0, ultra: 1.35 };
const FORWARD = /* @__PURE__ */ new THREE.Vector3(0, 0, -1);
const UP = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);
const DOWN_ISH = /* @__PURE__ */ new THREE.Vector3(0, -0.4, 1).normalize();
const ZERO = /* @__PURE__ */ new THREE.Vector3();
const FEET = /* @__PURE__ */ new THREE.Vector3();
const NORMAL = /* @__PURE__ */ new THREE.Vector3();
const DIRV = /* @__PURE__ */ new THREE.Vector3();
const MUZZLE_LIGHT = /* @__PURE__ */ new THREE.Color(1.0, 0.72, 0.38);
const FLASH_HUE = /* @__PURE__ */ new THREE.Color(1.0, 0.86, 0.62);
const SUPPRESSED_HUE = /* @__PURE__ */ new THREE.Color(1.0, 0.55, 0.28);

export { DECAL, P as PARTICLE_PROFILE };
