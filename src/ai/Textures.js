import * as THREE from 'three';
import { Rand, fbm2, ridge2, worley2, valueNoise2, clamp01, lerp, smoothstep } from './Util.js';

/**
 * Character material library — baked entirely in code into DataTextures.
 *
 * Six surface families cover an operator: printed camouflage cloth, 1000D
 * cordura webbing, matte impact polymer, phosphated gun steel, leather and
 * skin. Each family bakes an albedo, a tangent-space normal derived from its
 * own height field, and a packed ORM (r=AO, g=roughness, b=metalness) so a
 * single MeshStandardMaterial samples one UV set three times.
 *
 * Tints are *not* baked: the neutral structure maps are shared and each kit
 * multiplies them with a colour, so three enemy variants cost one bake.
 * Camouflage is the exception — a printed multi-colour pattern has to live in
 * the albedo — so one small albedo is baked per palette.
 *
 * UVs are authored in metres by the mesh builder; `tile` here is the number of
 * metres one texture repeat covers, folded into `texture.repeat`.
 */

const RGBA = THREE.RGBAFormat;

function makeTexture(data, size, srgb, aniso) {
  const t = new THREE.DataTexture(data, size, size, RGBA, THREE.UnsignedByteType);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

/** Sobel a tiling height field into an RGBA8 tangent normal map. */
function heightToNormal(height, size, strength, aniso) {
  const out = new Uint8Array(size * size * 4);
  const idx = (x, y) => ((y & (size - 1)) * size + (x & (size - 1)));
  const pot = (size & (size - 1)) === 0;
  const wrap = pot ? idx : (x, y) => (((y % size) + size) % size) * size + (((x % size) + size) % size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = height[wrap(x - 1, y)], r = height[wrap(x + 1, y)];
      const d = height[wrap(x, y - 1)], u = height[wrap(x, y + 1)];
      const dx = (r - l) * strength * size * 0.006;
      const dy = (u - d) * strength * size * 0.006;
      let nx = -dx, ny = -dy, nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv; ny *= inv; nz *= inv;
      const o = (y * size + x) * 4;
      out[o] = (nx * 0.5 + 0.5) * 255;
      out[o + 1] = (ny * 0.5 + 0.5) * 255;
      out[o + 2] = (nz * 0.5 + 0.5) * 255;
      out[o + 3] = 255;
    }
  }
  return makeTexture(out, size, false, aniso);
}

/** Cavity AO from the same height field: darker where the surface sits low. */
function packORM(height, size, roughFn, metalFn, aoStrength, aniso) {
  const out = new Uint8Array(size * size * 4);
  // local mean of the height field, 3x3, gives a cheap cavity term
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let mean = 0;
      for (let j = -2; j <= 2; j += 2) {
        for (let i = -2; i <= 2; i += 2) {
          mean += height[(((y + j) % size + size) % size) * size + (((x + i) % size + size) % size)];
        }
      }
      mean /= 9;
      const h = height[y * size + x];
      const ao = clamp01(1 - Math.max(0, mean - h) * aoStrength);
      const o = (y * size + x) * 4;
      out[o] = ao * 255;
      out[o + 1] = clamp01(roughFn(x / size, y / size, h)) * 255;
      out[o + 2] = clamp01(metalFn(x / size, y / size, h)) * 255;
      out[o + 3] = 255;
    }
  }
  return makeTexture(out, size, false, aniso);
}

/* ------------------------------------------------------------------ */
/* surface programs                                                    */
/* ------------------------------------------------------------------ */

/** Ripstop weave: a fine plain weave with a coarser reinforcing grid. */
function fabricHeight(size, seed) {
  const h = new Float32Array(size * size);
  const w = size / 26;          // weave period in pixels
  const rip = size / 7;         // ripstop grid period
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const warp = Math.sin((x / w) * Math.PI * 2) * 0.5 + 0.5;
      const weft = Math.sin((y / w) * Math.PI * 2) * 0.5 + 0.5;
      // over/under interleave: the thread on top swaps every half period
      const phase = ((Math.floor(x / w) + Math.floor(y / w)) & 1) ? warp : weft;
      const ripX = Math.abs(((x % rip) / rip) - 0.5) < 0.08 ? 1 : 0;
      const ripY = Math.abs(((y % rip) / rip) - 0.5) < 0.08 ? 1 : 0;
      const fuzz = fbm2(u, v, 64, 2, seed) * 0.18;
      h[y * size + x] = phase * 0.55 + (ripX + ripY) * 0.22 + fuzz;
    }
  }
  return h;
}

/** Basket-weave cordura: chunky, directional, with fibre noise. */
function corduraHeight(size, seed) {
  const h = new Float32Array(size * size);
  const w = size / 14;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const bx = Math.floor(x / w), by = Math.floor(y / w);
      const inX = (x % w) / w, inY = (y % w) / w;
      const over = ((bx + by) & 1) === 0;
      const bump = over
        ? Math.sin(inY * Math.PI) * 0.85 + Math.sin(inX * Math.PI) * 0.15
        : Math.sin(inX * Math.PI) * 0.85 + Math.sin(inY * Math.PI) * 0.15;
      const fibre = ridge2(u, v, 96, 2, seed) * 0.16;
      h[y * size + x] = bump * 0.8 + fibre;
    }
  }
  return h;
}

/** Injection-moulded polymer: micro-pebble grain plus scuff scratches. */
function polymerHeight(size, seed) {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const pebble = 1 - worley2(u, v, 44, seed);
      const grain = fbm2(u, v, 48, 3, seed + 11);
      const scratch = Math.pow(ridge2(u * 0.35 + v * 0.9, v * 0.4, 12, 2, seed + 5), 7) * 0.7;
      h[y * size + x] = pebble * 0.30 + grain * 0.28 + scratch * 0.5;
    }
  }
  return h;
}

/** Phosphate-finished steel: fine machining lines, pitting, edge polish. */
function steelHeight(size, seed) {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const brush = valueNoise2(u * 220, v * 6, 220, seed) * 0.5;
      const pit = Math.pow(1 - worley2(u, v, 26, seed + 3), 4) * 0.55;
      const grain = fbm2(u, v, 64, 2, seed + 9) * 0.22;
      h[y * size + x] = brush * 0.5 + grain + pit * 0.4;
    }
  }
  return h;
}

/** Grain leather: cell structure with creases. */
function leatherHeight(size, seed) {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const cell = 1 - worley2(u, v, 18, seed);
      const crease = Math.pow(ridge2(u, v, 9, 3, seed + 17), 3) * 0.8;
      h[y * size + x] = cell * 0.55 + crease * 0.5 + fbm2(u, v, 40, 2, seed) * 0.15;
    }
  }
  return h;
}

/** Skin: pores, fine wrinkle direction, blotching. */
function skinHeight(size, seed) {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const pore = 1 - worley2(u, v, 56, seed);
      const fine = fbm2(u, v, 96, 2, seed + 4);
      h[y * size + x] = pore * 0.22 + fine * 0.3;
    }
  }
  return h;
}

/* ------------------------------------------------------------------ */
/* camouflage                                                          */
/* ------------------------------------------------------------------ */

/**
 * A 5-colour blotch print in the multicam tradition: broad low-frequency
 * shapes, a mid-frequency overlay in a second hue, and small high-frequency
 * "twigs" so the pattern still reads at 30 m without turning into mush.
 */
function camoAlbedo(size, palette, seed, structure) {
  const out = new Uint8Array(size * size * 4);
  const c = palette.map((hex) => new THREE.Color(hex));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const big = fbm2(u, v, 4, 3, seed);
      const mid = fbm2(u + 0.31, v + 0.17, 8, 3, seed + 51);
      const fine = fbm2(u - 0.11, v + 0.63, 16, 2, seed + 133);

      let col = c[0];
      if (big > 0.56) col = c[1];
      if (mid > 0.60) col = c[2];
      if (big < 0.40 && mid < 0.52) col = c[3];
      if (fine > 0.70 && big > 0.46) col = c[4];

      // print bleed: soften the transition so it does not look like a stencil
      const bleed = smoothstep(0.52, 0.60, mid) * 0.18;
      let r = lerp(col.r, c[2].r, bleed);
      let g = lerp(col.g, c[2].g, bleed);
      let b = lerp(col.b, c[2].b, bleed);

      // fabric shading + accumulated grime in the weave
      const h = structure[y * size + x];
      const shade = 0.82 + h * 0.26;
      const grime = 1 - fbm2(u * 0.5, v * 0.5, 3, 2, seed + 900) * 0.22;
      r *= shade * grime; g *= shade * grime; b *= shade * grime;

      const o = (y * size + x) * 4;
      out[o] = clamp01(r) * 255;
      out[o + 1] = clamp01(g) * 255;
      out[o + 2] = clamp01(b) * 255;
      out[o + 3] = 255;
    }
  }
  return out;
}

/** Flat-tinted albedo driven by a structure field: gear, polymer, steel. */
function tintedAlbedo(size, base, structure, contrast, seed, mottle = 0.1) {
  const out = new Uint8Array(size * size * 4);
  const c = new THREE.Color(base);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const h = structure[y * size + x];
      const shade = 1 - contrast * 0.5 + h * contrast;
      const m = 1 - mottle * 0.5 + fbm2(u, v, 6, 3, seed) * mottle;
      const o = (y * size + x) * 4;
      out[o] = clamp01(c.r * shade * m) * 255;
      out[o + 1] = clamp01(c.g * shade * m) * 255;
      out[o + 2] = clamp01(c.b * shade * m) * 255;
      out[o + 3] = 255;
    }
  }
  return out;
}

function skinAlbedo(size, base, structure, seed) {
  const out = new Uint8Array(size * size * 4);
  const c = new THREE.Color(base);
  const flush = new THREE.Color(base).offsetHSL(-0.02, 0.16, -0.05);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const h = structure[y * size + x];
      const blotch = fbm2(u, v, 5, 3, seed + 21);
      const t = smoothstep(0.45, 0.72, blotch);
      const shade = 0.9 + h * 0.18;
      const o = (y * size + x) * 4;
      out[o] = clamp01(lerp(c.r, flush.r, t) * shade) * 255;
      out[o + 1] = clamp01(lerp(c.g, flush.g, t) * shade) * 255;
      out[o + 2] = clamp01(lerp(c.b, flush.b, t) * shade) * 255;
      out[o + 3] = 255;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* library                                                             */
/* ------------------------------------------------------------------ */

const CAMO = {
  arid:  [0xa89877, 0x7c7150, 0x5d5138, 0x3d3a2a, 0xc9bb95],
  olive: [0x6d7350, 0x4c5238, 0x3a4030, 0x252a1e, 0x8d9068],
  urban: [0x8d9198, 0x63676d, 0x45484e, 0x2b2d31, 0xb0b4b8],
};

export class CharacterTextures {
  constructor(game) {
    this.game = game;
    this.sets = new Map();
    this.built = false;
  }

  build() {
    if (this.built) return this;
    const aniso = Math.min(8, this.game?.engine?.maxAnisotropy ?? 8);
    // Matches the material library's policy: halve the bake on the low presets,
    // where the boot cost matters more than texel density on a 30 m silhouette.
    const preset = this.game?.settings?.preset;
    const S = (preset === 'low' || preset === 'medium') ? 128 : 256;
    const rand = new Rand(0xA1C0DE);
    const seed = () => Math.floor(rand.next() * 1e6);

    /* --- shared structure fields ------------------------------------ */
    const fab = fabricHeight(S, seed());
    const cor = corduraHeight(S, seed());
    const pol = polymerHeight(S, seed());
    const stl = steelHeight(S, seed());
    const lea = leatherHeight(S, seed());
    const skn = skinHeight(S, seed());

    /* --- camouflage albedos, one per palette ------------------------ */
    this.camoMaps = {};
    for (const [name, palette] of Object.entries(CAMO)) {
      this.camoMaps[name] = makeTexture(camoAlbedo(S, palette, 40 + name.length * 7, fab), S, true, aniso);
    }

    const fabNormal = heightToNormal(fab, S, 1.15, aniso);
    const fabORM = packORM(fab, S, () => 0.90, () => 0, 1.6, aniso);

    const corNormal = heightToNormal(cor, S, 1.55, aniso);
    const corORM = packORM(cor, S, (u, v, h) => 0.80 + h * 0.12, () => 0, 1.4, aniso);

    const polNormal = heightToNormal(pol, S, 0.95, aniso);
    const polORM = packORM(pol, S, (u, v, h) => 0.52 + h * 0.30, () => 0.02, 1.2, aniso);

    const stlNormal = heightToNormal(stl, S, 0.75, aniso);
    const stlORM = packORM(stl, S, (u, v, h) => 0.34 + h * 0.34, () => 0.94, 1.0, aniso);

    const leaNormal = heightToNormal(lea, S, 1.30, aniso);
    const leaORM = packORM(lea, S, (u, v, h) => 0.62 + h * 0.22, () => 0, 1.5, aniso);

    const sknNormal = heightToNormal(skn, S, 0.55, aniso);
    const sknORM = packORM(skn, S, (u, v, h) => 0.60 + h * 0.16, () => 0, 0.9, aniso);

    this.maps = {
      cloth:   { normal: fabNormal, orm: fabORM, tile: 0.55 },
      gear:    { albedo: makeTexture(tintedAlbedo(S, 0xffffff, cor, 0.55, seed(), 0.14), S, true, aniso), normal: corNormal, orm: corORM, tile: 0.34 },
      polymer: { albedo: makeTexture(tintedAlbedo(S, 0xffffff, pol, 0.40, seed(), 0.10), S, true, aniso), normal: polNormal, orm: polORM, tile: 0.30 },
      steel:   { albedo: makeTexture(tintedAlbedo(S, 0xffffff, stl, 0.45, seed(), 0.12), S, true, aniso), normal: stlNormal, orm: stlORM, tile: 0.22 },
      leather: { albedo: makeTexture(tintedAlbedo(S, 0xffffff, lea, 0.50, seed(), 0.12), S, true, aniso), normal: leaNormal, orm: leaORM, tile: 0.26 },
      skin:    { albedo: makeTexture(skinAlbedo(S, 0xffffff, skn, seed()), S, true, aniso), normal: sknNormal, orm: sknORM, tile: 0.30 },
    };

    this.built = true;
    return this;
  }

  /**
   * A view of a baked texture at a given metre-tiling. Clones are cached by
   * (texture, tile) so ten materials at the same tiling share one upload.
   */
  _repeat(tex, tile) {
    if (!tex) return null;
    this._tiled = this._tiled || new Map();
    const key = `${tex.uuid}|${tile}`;
    const hit = this._tiled.get(key);
    if (hit) return hit;
    const t = tex.clone();
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1 / tile, 1 / tile);
    t.needsUpdate = true;
    this._tiled.set(key, t);
    return t;
  }

  /**
   * A MeshStandardMaterial for one surface family.
   * @param {string} family cloth|gear|polymer|steel|leather|skin
   * @param {Object} opts {color, camo, roughness, metalness, tile, name}
   */
  material(family, opts = {}) {
    this.build();
    const set = this.maps[family];
    if (!set) return new THREE.MeshStandardMaterial({ color: opts.color ?? 0x808080, roughness: 0.9 });
    const tile = opts.tile ?? set.tile;
    const key = `${family}|${tile}|${opts.camo ?? ''}|${(opts.color ?? 0xffffff).toString(16)}|${opts.roughness ?? ''}|${opts.metalness ?? ''}|${opts.sheen ?? ''}`;
    const hit = this.sets.get(key);
    if (hit) return hit;

    const albedo = opts.camo
      ? (this.camoMaps[opts.camo] || this.camoMaps.arid)
      : (set.albedo || this.camoMaps.arid);
    const params = {
      map: this._repeat(albedo, tile),
      normalMap: this._repeat(set.normal, tile),
      roughnessMap: this._repeat(set.orm, tile),
      metalnessMap: this._repeat(set.orm, tile),
      aoMap: this._repeat(set.orm, tile),
      color: opts.color ?? 0xffffff,
      roughness: opts.roughness ?? 1.0,
      metalness: opts.metalness ?? (family === 'steel' ? 1.0 : 0.0),
      normalScale: new THREE.Vector2(opts.normalScale ?? 1, opts.normalScale ?? 1),
      envMapIntensity: opts.envMapIntensity ?? (family === 'steel' ? 1.25 : 0.85),
      aoMapIntensity: opts.aoMapIntensity ?? 0.85,
      dithering: true,
    };
    let mat;
    if (family === 'skin' || opts.sheen) {
      mat = new THREE.MeshPhysicalMaterial({
        ...params,
        sheen: opts.sheen ?? 0.25,
        sheenColor: new THREE.Color(opts.sheenColor ?? 0x7a3020),
        sheenRoughness: 0.75,
      });
    } else {
      mat = new THREE.MeshStandardMaterial(params);
    }
    mat.name = opts.name || `ai_${family}`;
    mat.userData.surface = family === 'skin' ? 'flesh' : family === 'steel' ? 'metal' : 'fabric';
    this.sets.set(key, mat);
    return mat;
  }

  /** Goggle / optic glass: thin, dark, strongly reflective. */
  glass(color = 0x1c2a30, opacity = 0.55) {
    const key = `glass|${color}|${opacity}`;
    const hit = this.sets.get(key);
    if (hit) return hit;
    const mat = new THREE.MeshPhysicalMaterial({
      color, roughness: 0.06, metalness: 0.1, transparent: true, opacity,
      envMapIntensity: 2.6, ior: 1.5, specularIntensity: 1.0,
      side: THREE.DoubleSide, depthWrite: false,
    });
    mat.name = 'ai_glass';
    this.sets.set(key, mat);
    return mat;
  }

  dispose() {
    for (const m of this.sets.values()) m.dispose?.();
    this.sets.clear();
    for (const set of Object.values(this.maps || {})) {
      for (const t of Object.values(set)) t?.dispose?.();
    }
    for (const t of Object.values(this.camoMaps || {})) t?.dispose?.();
    this.built = false;
  }
}
