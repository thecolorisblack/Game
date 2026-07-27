import * as THREE from 'three';

import { Rng, clamp } from './Rng.js';
import { Batcher, InstanceBatcher } from './GeoUtil.js';
import { patchShaderChunks } from './ShaderPatch.js';
import { Sky } from './Sky.js';
import { Lighting } from './Lighting.js';
import { Terrain } from './Terrain.js';
import { Buildings } from './Buildings.js';
import { Props } from './Props.js';
import { Foliage } from './Foliage.js';
import { BUILDINGS, SPAWNS, MAP, OBJECTIVE_TEXT } from './Layout.js';
import { bus } from '../core/EventBus.js';

/**
 * The level.
 *
 * `build()` runs the generator once at boot: terrain, then buildings, then
 * dressing, then vegetation, all writing into one merged batcher plus one
 * instanced batcher. Nothing is added to the scene per-prop — the batchers emit
 * a couple of hundred meshes for several thousand pieces of geometry, and every
 * merged mesh is handed to `physics.addStatic` with the right surface id before
 * `physics.build()` closes the world.
 *
 * After that the world is static and this class only does four things per
 * frame: drift the clouds, refit the shadow cascades, keep the practical-light
 * pool pointed at whatever is nearest, and (when the clock moves) re-render the
 * sky probe so reflections and ambient follow the sun.
 *
 * Public API (fixed by the module contract):
 *   await build() / setTimeOfDay(t) / update(dt) / get sunDirection / getSpawnPoints()
 */

const DEFAULT_TIME = 0.32;

export class World {
  constructor(game) {
    this.game = game;
    this.rng = new Rng(0x0B1AC407);
    this.timeOfDay = DEFAULT_TIME;
    this.fogBase = 0;                 // read by PostFX's height-fog raymarch
    this.ready = false;

    this.root = new THREE.Group();
    this.root.name = 'world';
    this.root.matrixAutoUpdate = false;

    this._mats = new Map();
    this._emissives = [];
    this._envTimer = 0;
    this._envDirty = true;
    this._statics = [];
  }

  /* ================================================================ */
  /* material access                                                   */
  /* ================================================================ */

  /**
   * Material lookup for the generators.
   *
   * Two things happen here that the rest of the world depends on. First, every
   * generator writes UVs in *metres*, so the tiling of the requested material is
   * converted into a texture repeat of `1 / tileMeters` — that is what lets a
   * kerbstone, a minaret and a market crate all share one concrete bake without
   * anyone unwrapping anything. Second, a handful of names are world-local
   * pseudo-materials (glowing windows, lamp bulbs, dyed canopies) that do not
   * exist in the shared library.
   */
  mat(name, opts = {}) {
    const tiling = opts.tiling ?? 1;
    const key = `${name}|${tiling}|${opts.key ?? ''}`;
    const hit = this._mats.get(key);
    if (hit) return hit;

    const materials = this.game.materials;
    const custom = this._customMaterial(name, tiling);
    if (custom) { this._mats.set(key, custom); return custom; }

    if (!materials) {
      const fallback = new THREE.MeshStandardMaterial({
        color: 0x8b8880, roughness: 0.92, vertexColors: true,
      });
      this._mats.set(key, fallback);
      return fallback;
    }

    const base = materials.get(name);
    const tileMeters = base?.userData?.tileMeters || 2;
    const extra = { ...opts };
    delete extra.tiling; delete extra.key;
    // Every world material reads the vertex colour channel — see `paintGeometry`.
    // The flag is part of the variant cache key, so nothing another system asked
    // for is affected.
    const m = materials.variant(name, { scale: tiling / tileMeters, vertexColors: true, ...extra }) || base;
    this._mats.set(key, m);
    return m;
  }

  _customMaterial(name, tiling) {
    const materials = this.game.materials;
    if (!materials) return null;
    const v = (base, opts) => materials.variant(base, { vertexColors: true, ...opts })
      || materials.get(base);

    switch (name) {
      // ---- glass ---------------------------------------------------------
      // A pane set in a wall in full sun does not read as a white veil. It reads
      // as a near-black mirror: what you see is the sky and the building
      // opposite, not the room behind. So the world's glass is *opaque* —
      // depth-writing, single-sided, dark, and glossy enough that the sky probe
      // carries the whole read.
      //
      // The alternative that was here (0.2 opacity, DoubleSide, no depth write)
      // meant every window in a 40 m block merged into one unsorted transparent
      // draw that blended over everything behind it. That is where the haze on
      // the distant buildings came from, and no amount of sorting fixes it while
      // the panes are merged.
      case 'glass': return this._pane('glass', 0);
      // Building windows only: the same dark pane, but wired into the day/night
      // cycle so the town lights up after dusk. (Props — insulators, bottles,
      // smashed lamp diffusers — must not glow, hence the split.)
      case 'windowGlass': return this._pane('windowGlass', 1.6);

      case 'windowLight': {
        // Near-black by day so windows read as holes, warm and emissive at night.
        const m = v('plaster', {
          scale: 0.5, color: 0x0b0906, roughness: 0.95, metalness: 0,
          emissive: 0xffb066, emissiveIntensity: 0, name: 'windowLight',
        });
        m.emissive = new THREE.Color(0xffb066);
        m.emissiveIntensity = 0;
        this._emissives.push({ mat: m, day: 0, night: 1.9 });
        return m;
      }
      case 'lampGlow': {
        const m = v('polymer', {
          scale: 2, color: 0xfff2dc, roughness: 0.35, metalness: 0,
          emissive: 0xffd39a, emissiveIntensity: 0, name: 'lampGlow',
        });
        m.emissive = new THREE.Color(0xffd39a);
        m.emissiveIntensity = 0;
        this._emissives.push({ mat: m, day: 0.02, night: 9.0 });
        return m;
      }
      case 'scorch':
        return v('asphalt', {
          scale: tiling / 3.0, color: 0x161311, roughness: 1.0, metalness: 0,
          polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
          name: 'scorch',
        });
      case 'fabric':
        return v('fabric', {
          scale: tiling / 1.1, side: THREE.DoubleSide, color: 0xd8cdb8, name: 'fabricSided',
        });
      // Tints multiply an already mid-tone weave, so they are pitched light:
      // a "red" canopy authored at 0xb8 comes out near black once the albedo
      // and a shaded underside are through with it.
      case 'stallCanopy0': return this._canopy(0xfaf1de, 'stallCanopy0');
      case 'stallCanopy1': return this._canopy(0xf09a72, 'stallCanopy1');
      case 'stallCanopy2': return this._canopy(0x8fc4e2, 'stallCanopy2');
      case 'laundry0': return this._canopy(0xf2f5f7, 'laundry0');
      case 'laundry1': return this._canopy(0xb6d2e2, 'laundry1');
      case 'laundry2': return this._canopy(0xf0cb95, 'laundry2');
      case 'produce': return v('plaster', {
        scale: 1 / 0.35, color: 0xffffff, roughness: 0.55, metalness: 0, name: 'produce',
      });
      default: return null;
    }
  }

  _canopy(color, name) {
    return this.game.materials.variant('fabric', {
      scale: 1 / 1.1, color, side: THREE.DoubleSide, roughness: 0.92,
      vertexColors: true, name,
    });
  }

  /**
   * Opaque high-gloss dark glass. `night` is the emissive level the panes reach
   * once the practicals come on; 0 leaves the material inert.
   */
  _pane(name, night) {
    const m = this.game.materials.variant('glass', {
      scale: 0.5,
      color: 0x141a1d,           // dark base: the reflection does the work
      // Not mirror-sharp: a 256 px sky probe sparkles under a 0.04 lobe when
      // the camera moves, and real window glass has a little wave in it anyway.
      roughness: 0.085, metalness: 0.0,
      transparent: false, opacity: 1.0, depthWrite: true, depthTest: true,
      side: THREE.FrontSide,
      envMapIntensity: 3.4, ior: 1.52, specularIntensity: 1.0,
      emissive: 0xffb066, emissiveIntensity: 0,
      vertexColors: true, name,
    });
    // A failed variant falls back to the shared library material; never mutate
    // that — other systems draw with it.
    if (!m || m === this.game.materials.get('glass')) return m || null;
    m.emissive = new THREE.Color(0xffb066);
    m.emissiveIntensity = 0;
    if (night > 0) this._emissives.push({ mat: m, day: 0, night });
    return m;
  }

  /** Materials whose emissive level is driven by the day/night cycle. */
  get emissiveMaterials() { return this._emissives; }

  /* ================================================================ */
  /* build                                                             */
  /* ================================================================ */

  async build() {
    const t0 = now();
    const game = this.game;
    game.scene.add(this.root);

    // Cascaded shadows and aerial perspective are shader-chunk level features;
    // patch before anything compiles.
    patchShaderChunks({ fogHeight: 46, fogBase: 0, fogInscatter: 0.05, cascadeEdge: 0.0025 });

    this.sky = new Sky(this).init();
    this.lighting = new Lighting(this).init();
    this.sun = this.lighting.sun;
    this.sunLight = this.lighting.sun;

    this.terrain = new Terrain(this);
    this.buildings = new Buildings(this);
    this.props = new Props(this);
    this.foliage = new Foliage(this);

    const batcher = new Batcher({ chunkSize: 70 });
    const instancer = new InstanceBatcher();
    const ctx = { batcher, instancer, terrain: this.terrain, lights: this.lighting };

    await this._phase('terrain', () => this.terrain.build(batcher));
    await this._phase('buildings', () => {
      for (const spec of BUILDINGS) {
        try { this.buildings.build(spec, ctx); }
        catch (err) { console.warn(`[World] building "${spec.id}" failed:`, err); }
      }
    });
    await this._phase('props', () => this.props.build(ctx));
    await this._phase('foliage', () => this.foliage.build(ctx));

    await this._phase('merge', () => {
      this._statics = batcher.build(this, this.root);
      this._statics = this._statics.concat(instancer.build(this, this.root));
    });

    // Spawn points sit on the finished terrain.
    this.spawnPoints = SPAWNS.map((s) => {
      const [x, , z] = s.position;
      const y = this.terrain.heightAt(x, z);
      return {
        position: new THREE.Vector3(x, y, z),
        yaw: s.yaw,
        role: s.role,
        team: s.team,
      };
    });

    try { this.game.physics?.build?.(); }
    catch (err) { console.warn('[World] physics.build failed:', err); }

    this.setTimeOfDay(this.timeOfDay);
    this.refreshEnvironment(true);
    // PostFX precompiles by rendering the scene before the loop starts; without
    // this the shadow cameras are still at the origin looking at themselves.
    this.lighting.lateUpdate();

    this.ready = true;
    const tris = this._statics.reduce((n, m) => {
      const g = m.geometry;
      const count = g?.index ? g.index.count : (g?.attributes?.position?.count ?? 0);
      return n + count / 3 * (m.isInstancedMesh ? m.count : 1);
    }, 0);
    console.info(`[World] ${this._statics.length} meshes, ${(tris / 1000).toFixed(0)}k triangles in ${(now() - t0).toFixed(0)} ms`);

    // The HUD is constructed six steps after the world, so the objective is
    // announced again once everyone is listening.
    bus.emit('objective', { text: OBJECTIVE_TEXT });
    bus.on('boot:complete', () => bus.emit('objective', { text: OBJECTIVE_TEXT }));
    return this;
  }

  async _phase(label, fn) {
    const t = now();
    try { fn(); }
    catch (err) { console.warn(`[World] phase "${label}" failed:`, err); }
    if (typeof performance !== 'undefined') {
      const ms = now() - t;
      if (ms > 40) console.debug(`[World] ${label}: ${ms.toFixed(0)} ms`);
    }
    await yieldFrame();
  }

  /* ================================================================ */
  /* time of day                                                       */
  /* ================================================================ */

  /**
   * Drive the entire lighting state from a 0..1 clock.
   * 0.22 low golden morning, 0.32 mid-morning, 0.5 noon, 0.78 sunset, 0.88 night.
   */
  setTimeOfDay(t) {
    const tt = clamp(Number.isFinite(t) ? t : DEFAULT_TIME, 0, 1);
    this.timeOfDay = tt;
    if (!this.lighting) return;

    const params = this.lighting.setTimeOfDay(tt);
    this.sky?.apply(params);

    const night = this.lighting.night;
    for (const e of this._emissives) {
      e.mat.emissiveIntensity = e.day + (e.night - e.day) * night;
    }
    this._envDirty = true;
    this._envTimer = 0;
    return this;
  }

  /** Re-render the sky cube and re-filter it into `scene.environment`. */
  refreshEnvironment(force = false) {
    if (!this.sky) return;
    const env = this.sky.refreshEnvironment(force);
    if (env) {
      this.game.scene.environment = env;
      this.envMap = env;
    }
    this._envDirty = false;
  }

  /** World-space direction *toward* the sun. Live vector — copy before mutating. */
  get sunDirection() {
    return this.lighting ? this.lighting.sunDir : new THREE.Vector3(0, 1, 0);
  }

  /** Direction of whichever body is currently the key light (sun or moon). */
  get keyDirection() {
    return this.lighting?.keyDir || this.sunDirection;
  }

  /**
   * Spawn points for the player and AI: `{position, yaw}` plus advisory
   * `role` ('player' | 'friendly' | 'hostile' | 'contest') and `team`.
   */
  getSpawnPoints(role) {
    const list = this.spawnPoints || [];
    if (!role) return list;
    const filtered = list.filter((s) => s.role === role);
    return filtered.length ? filtered : list;
  }

  /** Ground height under a point; used by anything that needs to stand up. */
  heightAt(x, z) { return this.terrain ? this.terrain.heightAt(x, z) : 0; }

  /* ================================================================ */
  /* per frame                                                         */
  /* ================================================================ */

  update(dt) {
    if (!this.ready) return;
    const d = Math.min(dt || 0, 0.1);
    this.sky?.update(d);
    this.lighting?.update(d);

    if (this._envDirty) {
      this._envTimer -= d;
      if (this._envTimer <= 0) this.refreshEnvironment(true);
    }
  }

  /** Shadow cascades are fitted here: the camera is final by lateUpdate. */
  lateUpdate() {
    if (!this.ready) return;
    this.lighting?.lateUpdate();
  }

  dispose() {
    this.sky?.dispose();
    this.lighting?.dispose();
    this.terrain?.dispose();
    for (const m of this._statics) {
      m.geometry?.dispose();
      this.root.remove(m);
    }
    this._statics.length = 0;
    this.game.scene.remove(this.root);
  }
}

/* ------------------------------------------------------------------ */

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Yield to the browser between generation phases so the boot progress bar
 * actually repaints. A MessageChannel task is used rather than rAF because a
 * single frame under a software rasteriser can cost hundreds of milliseconds.
 */
function yieldFrame() {
  if (typeof MessageChannel === 'function') {
    return new Promise((resolve) => {
      const mc = new MessageChannel();
      mc.port1.onmessage = () => { mc.port1.close(); resolve(); };
      mc.port2.postMessage(0);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export { MAP };
