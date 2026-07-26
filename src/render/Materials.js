import * as THREE from 'three';

import { BakeContext, RECIPES, DERIVED, bakeDetailHeight, bakeMacro } from './textures/Recipes.js';
import { packSurface, packDetailNormal } from './textures/Fields.js';
import { applyOBShader } from './textures/ShaderLib.js';

/**
 * Procedural PBR material library.
 *
 * Everything is generated at boot — there is no asset server and no texture on
 * disk. Each entry in `RECIPES` bakes a full map set (albedo+height, tangent
 * normal, packed AO/roughness/metalness) from layered noise plus explicit
 * structural passes, then gets wrapped in a three.js material with the shared
 * shader extensions installed:
 *
 *   - macro variation, so 30 metres of the same wall never reads as one tile
 *     stamped fifteen times;
 *   - a 20x detail normal, so the surface still has micro-structure with the
 *     muzzle two inches from it;
 *   - offset-limited parallax on the deep surfaces;
 *   - triplanar projection for terrain and rubble.
 *
 * Memory discipline: normals are RG8 (three reconstructs Z via
 * USE_PACKED_NORMALMAP), AO/roughness/metalness share one RGBA8 at half
 * resolution, and derived materials reuse another recipe's maps outright.
 *
 * Public API (fixed by the module contract):
 *   await init(onProgress) / get(name) / variant(name, opts) / texture(name)
 */

const RES = { hero: 1024, std: 512, small: 256 };

/**
 * Texture resolution multiplier per quality preset. Halving the bake on the
 * lower presets cuts boot time roughly 4x and VRAM 4x; the detail normal and
 * macro variation carry most of the close-range fidelity anyway.
 */
const RES_SCALE = { low: 0.5, medium: 0.5, high: 1, ultra: 1 };

/** Fraction of the boot bar this system owns (11 boot steps in main.js). */
const BOOT_SLICE = 1 / 11;

/**
 * Per-material shading overrides that are not worth expressing as fields.
 * `type` picks the three.js material class; `params` go to the constructor.
 */
const SPECIAL = {
  glass: {
    type: 'physical',
    params: {
      color: 0xd6e2e6, roughness: 0.055, metalness: 0.0, transparent: true, opacity: 0.20,
      side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 2.4, ior: 1.52,
      specularIntensity: 1.0, premultipliedAlpha: false,
    },
    noMacro: true,
  },
  water: {
    type: 'standard',
    params: {
      color: 0xffffff, roughness: 1.0, metalness: 0.02, transparent: true, opacity: 0.88,
      depthWrite: false, envMapIntensity: 1.9, side: THREE.FrontSide,
    },
    flags: { water: true },
    uniforms: { uWater: [1.0, 2.37, 0.020, 0.031] },
    noMacro: true,
  },
  foliage: {
    type: 'standard',
    params: {
      color: 0xffffff, roughness: 1.0, metalness: 0.0, side: THREE.DoubleSide,
      alphaTest: 0.42, transparent: false,
    },
    flags: { foliage: true },
    uniforms: { uFoliage: [0.55, 0.5] },
  },
  flesh: {
    type: 'physical',
    params: {
      color: 0xffffff, roughness: 1.0, metalness: 0.0,
      sheen: 0.30, sheenColor: 0x8c2a1e, sheenRoughness: 0.75,
    },
  },
  gun_metal: { params: { envMapIntensity: 1.35 } },
  metal: { params: { envMapIntensity: 1.2 } },
  metal_painted: { params: { envMapIntensity: 1.1 } },
  tile: { params: { envMapIntensity: 1.25 } },
};

/**
 * Friendly names other systems are likely to ask for. Keeps `get()` from
 * falling back to concrete just because the world agent said "stone".
 */
const ALIASES = {
  default: 'concrete', stone: 'concrete', cement: 'concrete', wall: 'concrete',
  floor: 'concrete', road: 'asphalt', tarmac: 'asphalt', ground: 'dirt',
  soil: 'dirt', mud: 'dirt', earth: 'dirt', rock: 'rubble', debris: 'rubble',
  steel: 'metal', iron: 'metal', pipe: 'metal', rust: 'metal_rusted',
  rusted_metal: 'metal_rusted', painted_metal: 'metal_painted',
  corrugated_steel: 'metal_corrugated', corrugated: 'metal_corrugated',
  gunmetal: 'gun_metal', weapon: 'gun_metal', plastic: 'polymer',
  weathered_polymer: 'polymer', crate: 'wood', plank: 'wood', timber: 'wood',
  board: 'wood', cloth: 'fabric', canvas: 'fabric', burlap: 'sandbag',
  camo_fabric: 'camo', skin: 'flesh', body: 'flesh', grass: 'foliage',
  leaves: 'foliage', bush: 'foliage', window: 'glass', brickwork: 'brick',
  ceramic: 'tile', ceramic_tile: 'tile', cracked_concrete: 'concrete_cracked',
  render: 'stucco', drywall: 'plaster',
};

function texKey(name, slot) { return `${name}.${slot}`; }

export class Materials {
  constructor(game) {
    this.game = game;
    this.cache = new Map();      // name -> THREE.Material  (legacy field name kept)
    this.materials = this.cache;
    this.textures = new Map();   // 'name.slot' -> THREE.Texture
    this.specs = new Map();      // name -> bake/shader spec, used by variant()
    this._variants = new Map();
    this._scaled = new Map();   // 'name@scale' -> {albedo, normal, orm}
    this._timed = [];            // uniform holders that need uTime
    this._warned = new Set();
    this._time = 0;
    this.anisotropy = 8;
    this.ready = false;
  }

  /* ---------------------------------------------------------------- */
  /* boot                                                              */
  /* ---------------------------------------------------------------- */

  async init(onProgress) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const settings = this.game?.settings;
    const maxAniso = this.game?.engine?.maxAnisotropy ?? 8;
    this.anisotropy = Math.max(1, Math.min(settings?.anisotropy ?? 8, maxAniso));

    const names = Object.keys(RECIPES);
    // shared assets count as ~4 units of work so the bar does not stall at zero
    const total = names.length + 5;
    let done = 0;
    const report = (label) => {
      onProgress?.(label, Math.min(1, done / total) * BOOT_SLICE);
    };

    // --- shared: detail normals + macro variation ---------------------
    report('Baking detail normals');
    await this._yield(true);

    const DETAIL_SIZE = 512;
    for (const kind of ['grit', 'brushed', 'weave', 'stipple']) {
      const height = bakeDetailHeight(DETAIL_SIZE, kind);
      const rg = packDetailNormal(height, DETAIL_SIZE, kind === 'brushed' ? 0.55 : 0.9);
      const tex = this._makeTexture(rg, DETAIL_SIZE, THREE.RGFormat, THREE.NoColorSpace);
      tex.name = `detail.${kind}`;
      this.textures.set(`detail.${kind}`, tex);
      done += 0.25;
      report('Baking detail normals');
    }
    await this._yield();

    const MACRO_SIZE = 512;
    const macroData = bakeMacro(MACRO_SIZE);
    this.macroTexture = this._makeTexture(macroData, MACRO_SIZE, THREE.RGBAFormat, THREE.NoColorSpace);
    this.macroTexture.name = 'macro';
    this.textures.set('macro', this.macroTexture);
    done += 1;
    report('Baking macro variation');
    await this._yield();


    // --- per-material bakes, grouped by resolution so the shared noise
    //     field cache is built once per size and freed as soon as possible.
    const quality = RES_SCALE[settings?.preset] ?? 1;
    const groups = new Map();
    for (const name of names) {
      const res = Math.max(128, Math.round((RES[RECIPES[name].res] ?? RES.std) * quality));
      if (!groups.has(res)) groups.set(res, []);
      groups.get(res).push(name);
    }

    let sinceYield = 0;
    for (const [size, list] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
      const ctx = new BakeContext(size);
      for (const name of list) {
        const recipe = RECIPES[name];
        report(`Baking ${name.replace(/_/g, ' ')}`);
        try {
          this._bakeRecipe(name, recipe, ctx);
        } catch (err) {
          console.warn(`[Materials] recipe "${name}" failed to bake:`, err);
        }
        done += 1;
        if (++sinceYield >= 2) { sinceYield = 0; await this._yield(); }
      }
      ctx.dispose();
      await this._yield();
    }

    // --- derived (parameter-only) materials ---------------------------
    for (const [name, def] of Object.entries(DERIVED)) {
      try {
        this._buildDerived(name, def);
      } catch (err) {
        console.warn(`[Materials] derived "${name}" failed:`, err);
      }
    }
    done += 1;
    report('Compiling materials');

    // Guarantee a fallback exists no matter what blew up above.
    if (!this.cache.has('concrete')) {
      this.cache.set('concrete', new THREE.MeshStandardMaterial({ color: 0x8b8880, roughness: 0.92, metalness: 0 }));
    }
    this._fallback = this.cache.get('concrete');

    await this._warmTextures();

    this.ready = true;
    const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    console.info(`[Materials] ${this.cache.size} materials, ${this.textures.size} textures baked in ${ms.toFixed(0)} ms`);
    report('Materials ready');
  }

  /**
   * Time-slice yield.
   *
   * The default path is a MessageChannel macrotask (~0.05 ms) rather than
   * requestAnimationFrame: under a software rasteriser a single rAF can cost
   * 200+ ms, and twenty of them turn a four-second bake into a nine-second one.
   * `hard: true` requests a real frame, used only where the boot label genuinely
   * needs to repaint.
   */
  _yield(hard = false) {
    if (hard && typeof requestAnimationFrame === 'function') {
      return new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }
    if (typeof MessageChannel === 'function') {
      return new Promise((resolve) => {
        const mc = new MessageChannel();
        mc.port1.onmessage = () => { mc.port1.close(); resolve(); };
        mc.port2.postMessage(0);
      });
    }
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  /* ---------------------------------------------------------------- */
  /* baking                                                            */
  /* ---------------------------------------------------------------- */

  _makeTexture(data, size, format, colorSpace) {
    const tex = new THREE.DataTexture(data, size, size, format, THREE.UnsignedByteType);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = this.anisotropy;
    tex.colorSpace = colorSpace;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    return tex;
  }

  _bakeRecipe(name, recipe, ctx) {
    const surf = recipe.build(ctx);
    const packed = packSurface(surf, {
      normalStrength: recipe.normalStrength ?? 1,
      saturation: recipe.saturation ?? 0.76,
      gain: recipe.gain ?? 0.90,
      ormHalf: true,
    });
    // Every scratch buffer this recipe took is dead the moment the surface has
    // been packed to bytes; hand them straight back to the pool.
    ctx.reclaim?.();

    const albedo = this._makeTexture(packed.albedo, packed.size, THREE.RGBAFormat, THREE.SRGBColorSpace);
    const normal = this._makeTexture(packed.normal, packed.size, THREE.RGFormat, THREE.NoColorSpace);
    const orm = this._makeTexture(packed.orm, packed.ormSize, THREE.RGBAFormat, THREE.NoColorSpace);
    albedo.name = texKey(name, 'albedo');
    normal.name = texKey(name, 'normal');
    orm.name = texKey(name, 'orm');
    this.textures.set(albedo.name, albedo);
    this.textures.set(normal.name, normal);
    this.textures.set(orm.name, orm);

    const spec = {
      name,
      recipe,
      surface: recipe.surface,
      tileMeters: recipe.tileMeters ?? 2,
      maps: { albedo, normal, orm },
    };
    this.specs.set(name, spec);
    this.cache.set(name, this._buildMaterial(spec, {}));
  }

  /**
   * Instantiate a three.js material from a baked spec plus per-instance
   * overrides. Variants go through the same path, which is why a variant is
   * never a `clone()` — cloning would deep-copy userData and share the uniform
   * objects between instances, which silently breaks the shader extensions.
   */
  _buildMaterial(spec, opts) {
    const recipe = spec.recipe;
    const special = SPECIAL[spec.name] ?? {};
    const type = opts.type ?? special.type ?? 'standard';

    const scale = opts.scale ?? opts.tiling ?? 1;
    const maps = this._scaledMaps(spec, scale);

    const params = {
      color: 0xffffff,
      map: maps.albedo,
      normalMap: maps.normal,
      roughnessMap: maps.orm,
      metalnessMap: maps.orm,
      aoMap: maps.orm,
      roughness: 1.0,
      metalness: 1.0,
      aoMapIntensity: 1.0,
      ...(special.params ?? {}),
    };
    if (recipe?.alphaFromMap && params.alphaTest === undefined) params.alphaTest = 0.42;

    // Explicit user overrides win over everything.
    for (const k of [
      'color', 'roughness', 'metalness', 'emissive', 'emissiveIntensity', 'opacity',
      'transparent', 'side', 'alphaTest', 'depthWrite', 'depthTest', 'flatShading',
      'envMapIntensity', 'aoMapIntensity', 'vertexColors', 'toneMapped', 'wireframe',
      'sheen', 'sheenColor', 'sheenRoughness', 'clearcoat', 'clearcoatRoughness', 'ior',
      'polygonOffset', 'polygonOffsetFactor', 'polygonOffsetUnits', 'blending', 'premultipliedAlpha',
    ]) {
      if (opts[k] !== undefined) params[k] = opts[k];
    }
    if (opts.map === null) params.map = null;
    if (opts.normalMap === null) params.normalMap = null;

    const mat = type === 'physical'
      ? new THREE.MeshPhysicalMaterial(params)
      : new THREE.MeshStandardMaterial(params);

    mat.name = opts.name ?? spec.name;
    mat.normalScale = new THREE.Vector2(opts.normalScale ?? 1, opts.normalScale ?? 1);
    if (opts.roughnessScale !== undefined) mat.roughness = params.roughness * opts.roughnessScale;
    if (opts.metalnessScale !== undefined) mat.metalness = params.metalness * opts.metalnessScale;

    // --- shader extension flags --------------------------------------
    const detailKind = opts.detail ?? recipe?.detail ?? null;
    const detailTex = detailKind ? this.textures.get(`detail.${detailKind}`) : null;
    const detailStrength = opts.detailStrength ?? recipe?.detailStrength ?? 0;
    const useDetail = !!detailTex && detailStrength > 0.001;

    const macroPair = recipe?.macro ?? [0.28, 0.14];
    const macroAlbedo = opts.macro ?? (special.noMacro ? 0 : macroPair[0]);
    const useMacro = !!this.macroTexture && macroAlbedo > 0.001;

    // Triplanar is opt-in per material; `triplanarDefault` turns it on for the
    // surfaces whose meshes are inherently UV-hostile (rubble, gravel beds).
    const useTriplanar = opts.triplanar !== undefined
      ? opts.triplanar === true
      : recipe?.triplanarDefault === true;

    const parallax = opts.parallax ?? recipe?.parallax ?? 0;
    const useParallax = parallax > 0.0005 && !useTriplanar;

    const wet = opts.wet ?? null;
    const isWater = !!(special.flags?.water);
    const isFoliage = !!(special.flags?.foliage);

    const uniforms = {};
    if (useDetail) {
      uniforms.uDetailNormal = { value: detailTex };
      // detailScale is relative to the base map frequency, so it is *not*
      // divided by `scale` — vMapUv already carries the repeat.
      uniforms.uDetailParams = new THREE.Uniform(new THREE.Vector2(
        opts.detailScale ?? recipe?.detailScale ?? 20,
        detailStrength,
      ));
    }
    if (useMacro) {
      uniforms.uMacroTex = { value: this.macroTexture };
      uniforms.uMacroParams = new THREE.Uniform(new THREE.Vector3(
        (opts.macroScale ?? 1 / 16),
        macroAlbedo,
        opts.macroRoughness ?? macroPair[1],
      ));
    }
    if (useParallax) uniforms.uParallax = { value: parallax };
    if (useTriplanar) {
      uniforms.uTriParams = new THREE.Uniform(new THREE.Vector2(
        opts.triplanarScale ?? (1 / (spec.tileMeters || 2)),
        opts.triplanarSharpness ?? 6.0,
      ));
    }
    if (wet) {
      uniforms.uWet = new THREE.Uniform(new THREE.Vector3(wet[0] ?? 1, wet[1] ?? 0.3, wet[2] ?? 0.75));
    }
    if (isWater) {
      const w = special.uniforms?.uWater ?? [1, 2.37, 0.02, 0.03];
      uniforms.uWater = new THREE.Uniform(new THREE.Vector4(w[0], w[1], w[2], w[3]));
      uniforms.uTime = { value: 0 };
    }
    if (isFoliage) {
      const f = special.uniforms?.uFoliage ?? [0.55, 0.5];
      uniforms.uFoliage = new THREE.Uniform(new THREE.Vector2(
        opts.translucency ?? f[0], opts.foliageWrap ?? f[1],
      ));
    }

    applyOBShader(mat, {
      macro: useMacro,
      detail: useDetail,
      parallax: useParallax,
      triplanar: useTriplanar,
      wet: !!wet,
      water: isWater,
      foliage: isFoliage,
      alphaFromMap: !!recipe?.alphaFromMap,
      hasMap: !!params.map,
    }, uniforms);

    if (uniforms.uTime) this._timed.push(uniforms.uTime);

    mat.userData.surface = opts.surface ?? spec.surface ?? 'concrete';
    mat.userData.tileMeters = spec.tileMeters / (scale || 1);
    mat.userData.material = spec.name;
    return mat;
  }

  /**
   * Textures with a non-unit repeat. `Texture.clone()` shares the underlying
   * `Source`, so the GPU upload is deduplicated — a variant costs one extra
   * descriptor, not one extra megabyte.
   */
  _scaledMaps(spec, scale) {
    if (!scale || scale === 1) return spec.maps;
    const key = `${spec.name}@${scale}`;
    let cached = this._scaled.get(key);
    if (!cached) {
      cached = {};
      for (const slot of ['albedo', 'normal', 'orm']) {
        const src = spec.maps[slot];
        const t = src.clone();
        t.repeat.set(scale, scale);
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = src.anisotropy;
        t.colorSpace = src.colorSpace;
        t.name = `${src.name}@${scale}`;
        t.needsUpdate = true;
        cached[slot] = t;
      }
      this._scaled.set(key, cached);
    }
    return cached;
  }

  _buildDerived(name, def) {
    const base = this.specs.get(def.from);
    if (!base) return;
    const spec = {
      name,
      recipe: base.recipe,
      surface: def.surface ?? base.surface,
      tileMeters: def.tileMeters ?? base.tileMeters,
      maps: base.maps,
    };
    this.specs.set(name, spec);
    const opts = { ...(def.params ?? {}) };
    if (def.roughnessScale !== undefined) opts.roughnessScale = def.roughnessScale;
    if (def.wet) opts.wet = def.wet;
    opts.name = name;
    opts.surface = spec.surface;
    this.cache.set(name, this._buildMaterial(spec, opts));
  }

  /**
   * Push textures to the GPU during boot so the first shot never hitches on an
   * upload + mipmap generation. Strictly budgeted: on a software rasteriser a
   * full warm costs several seconds, and anything not warmed here simply
   * uploads lazily on first use, which is the pre-existing behaviour anyway.
   */
  async _warmTextures(budgetMs = 500) {
    const renderer = this.game?.renderer;
    if (!renderer?.initTexture) return;
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const deadline = now() + budgetMs;
    let i = 0;
    for (const tex of this.textures.values()) {
      if (!tex || !tex.isTexture) continue;
      try { renderer.initTexture(tex); } catch { /* software GL can refuse; harmless */ }
      if (++i % 8 === 0) {
        if (now() > deadline) return;
        await this._yield();
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* public API                                                        */
  /* ---------------------------------------------------------------- */

  _resolve(name) {
    if (typeof name !== 'string') return null;
    if (this.cache.has(name)) return name;
    const lower = name.toLowerCase();
    if (this.cache.has(lower)) return lower;
    const alias = ALIASES[lower];
    if (alias && this.cache.has(alias)) return alias;
    const snake = lower.replace(/[\s-]+/g, '_');
    if (this.cache.has(snake)) return snake;
    if (ALIASES[snake] && this.cache.has(ALIASES[snake])) return ALIASES[snake];
    return null;
  }

  /** Never returns undefined: unknown names warn once and fall back. */
  get(name) {
    const key = this._resolve(name);
    if (key) return this.cache.get(key);
    if (!this._warned.has(name)) {
      this._warned.add(name);
      console.warn(`[Materials] unknown material "${name}" — falling back to concrete.`);
    }
    return this._fallback ?? this.cache.get('concrete') ?? this.cache.values().next().value
      ?? new THREE.MeshStandardMaterial({ color: 0x8b8880, roughness: 0.92 });
  }

  /**
   * A parameterised instance of a baked material. Cached by name+options, so
   * asking for the same variant from ten call sites yields one material and one
   * draw-call batch.
   *
   * Useful options: { scale, color, roughness, metalness, normalScale,
   * detailScale, detailStrength, macro, parallax, triplanar, wet:[amt,lo,hi],
   * side, transparent, opacity, alphaTest, emissive, flatShading, name }
   */
  variant(name, opts = {}) {
    const key = this._resolve(name);
    if (!key) return this.get(name);
    let cacheKey;
    try { cacheKey = key + '#' + JSON.stringify(opts, (k, v) => (v && v.isColor ? v.getHex() : v)); }
    catch { cacheKey = null; }
    if (cacheKey && this._variants.has(cacheKey)) return this._variants.get(cacheKey);

    const spec = this.specs.get(key);
    if (!spec) return this.get(name);
    let mat;
    try {
      mat = this._buildMaterial(spec, opts);
    } catch (err) {
      console.warn(`[Materials] variant("${name}") failed:`, err);
      return this.get(name);
    }
    if (cacheKey) this._variants.set(cacheKey, mat);
    return mat;
  }

  /**
   * Baked texture lookup. Accepts `"concrete"` (albedo), `"concrete.normal"`,
   * `"concrete.orm"`, `"detail.grit"` or `"macro"`.
   */
  texture(name) {
    if (typeof name !== 'string') return null;
    if (this.textures.has(name)) return this.textures.get(name);
    const key = this._resolve(name);
    if (key && this.textures.has(texKey(key, 'albedo'))) return this.textures.get(texKey(key, 'albedo'));
    const dot = name.indexOf('.');
    if (dot > 0) {
      const base = this._resolve(name.slice(0, dot));
      const slot = name.slice(dot + 1);
      if (base && this.textures.has(texKey(base, slot))) return this.textures.get(texKey(base, slot));
    }
    if (!this._warned.has('tex:' + name)) {
      this._warned.add('tex:' + name);
      console.warn(`[Materials] unknown texture "${name}".`);
    }
    return null;
  }

  /** The contract surface id (`concrete`, `metal`, ...) a material maps to. */
  surfaceOf(material) {
    return material?.userData?.surface ?? 'concrete';
  }

  /** All material ids currently registered, for menus and debugging. */
  list() { return [...this.cache.keys()]; }

  update(dt) {
    if (!this._timed.length) return;
    this._time += dt || 0;
    for (let i = 0; i < this._timed.length; i++) this._timed[i].value = this._time;
  }

  dispose() {
    for (const t of this.textures.values()) t?.dispose?.();
    for (const set of this._scaled.values()) for (const k in set) set[k]?.dispose?.();
    for (const m of this.cache.values()) m?.dispose?.();
    for (const m of this._variants.values()) m?.dispose?.();
    this.textures.clear();
    this._scaled.clear();
    this.cache.clear();
    this._variants.clear();
    this._timed.length = 0;
  }
}
