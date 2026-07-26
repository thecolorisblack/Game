import * as THREE from 'three';

/**
 * Weapon material palette.
 *
 * Everything comes out of `game.materials` so the guns share the same baked PBR
 * map sets — and therefore the same shader extensions, the same colour space
 * handling and the same texture memory — as the rest of the world. Each entry
 * turns on `vertexColors` because the geometry toolkit bakes edge wear into the
 * colour attribute (see Parts.bakeWear): a multiplier above 1.0 on a dark
 * parkerised finish is what makes a chamfer read as rubbed-through steel.
 *
 * Everything degrades: if the materials system is missing or a recipe failed to
 * bake, each entry falls back to a hand-tuned MeshStandardMaterial so the
 * viewmodel still renders rather than throwing on the boot path.
 */

const COMMON = { vertexColors: true, macro: 0.10, macroScale: 0.55, envMapIntensity: 1.5 };

/** name -> [materials-library recipe, variant opts, standalone fallback params] */
const SPEC = {
  // dark parkerised receiver / rail furniture
  gunmetal: ['gun_metal', {
    ...COMMON, color: 0x4a4e55, roughness: 0.82, metalness: 1.0,
    normalScale: 0.9, detailStrength: 0.45, detailScale: 26,
  }, { color: 0x2a2d32, roughness: 0.52, metalness: 0.95 }],

  // machined / in-the-white steel: barrel, bolt, pins, trigger
  steel: ['gun_metal', {
    ...COMMON, color: 0x9aa2ab, roughness: 0.42, metalness: 1.0,
    normalScale: 0.55, detailStrength: 0.30, detailScale: 34, envMapIntensity: 2.1,
  }, { color: 0x8d949c, roughness: 0.28, metalness: 1.0 }],

  // cold blued: slides, small levers
  blued: ['gun_metal', {
    ...COMMON, color: 0x3a3f47, roughness: 0.36, metalness: 1.0,
    normalScale: 0.45, detailStrength: 0.22, detailScale: 30, envMapIntensity: 2.0,
  }, { color: 0x23262b, roughness: 0.3, metalness: 1.0 }],

  // anodised aluminium handguard / optic bodies (slightly warmer, matte)
  alloy: ['gun_metal', {
    ...COMMON, color: 0x565a60, roughness: 0.95, metalness: 0.92,
    normalScale: 0.8, detailStrength: 0.5, detailScale: 24,
  }, { color: 0x34373c, roughness: 0.62, metalness: 0.85 }],

  // weathered polymer furniture
  polymer: ['polymer', {
    ...COMMON, color: 0x54544c, roughness: 0.98, metalness: 0.0,
    normalScale: 1.0, detailStrength: 0.55, detailScale: 22, envMapIntensity: 0.8,
  }, { color: 0x2e2f2a, roughness: 0.86, metalness: 0.0 }],

  // flat dark earth furniture, for weapon-to-weapon variation
  fde: ['polymer', {
    ...COMMON, color: 0xa08a63, roughness: 0.96, metalness: 0.0,
    normalScale: 1.0, detailStrength: 0.55, detailScale: 22, envMapIntensity: 0.8,
  }, { color: 0x6d5c40, roughness: 0.88, metalness: 0.0 }],

  // grip / stock: heavily textured, near-black
  grip: ['polymer', {
    ...COMMON, color: 0x33342f, roughness: 1.0, metalness: 0.0,
    normalScale: 1.35, detailStrength: 0.85, detailScale: 16, envMapIntensity: 0.55,
  }, { color: 0x1b1c19, roughness: 0.95, metalness: 0.0 }],

  // buttpad / suppressor cover / sling rubber
  rubber: ['polymer', {
    ...COMMON, color: 0x1e1f1f, roughness: 1.0, metalness: 0.0,
    normalScale: 1.1, detailStrength: 0.7, detailScale: 20, envMapIntensity: 0.35,
  }, { color: 0x141514, roughness: 0.98, metalness: 0.0 }],

  brass: ['brass', {
    ...COMMON, color: 0xd8a94f, roughness: 0.34, metalness: 1.0, envMapIntensity: 2.4,
  }, { color: 0xc79b46, roughness: 0.3, metalness: 1.0 }],

  // glove leather / nomex
  glove: ['fabric', {
    vertexColors: true, color: 0x2a2c2b, roughness: 0.97, metalness: 0.0,
    normalScale: 1.25, detailStrength: 0.8, detailScale: 18, macro: 0.22,
    macroScale: 0.9, envMapIntensity: 0.6,
  }, { color: 0x232524, roughness: 0.95, metalness: 0.0 }],

  // knuckle armour / glove hard pads
  glovePad: ['polymer', {
    vertexColors: true, color: 0x26282a, roughness: 0.72, metalness: 0.1,
    normalScale: 1.0, detailStrength: 0.6, detailScale: 22, envMapIntensity: 0.9,
  }, { color: 0x1d1f21, roughness: 0.7, metalness: 0.1 }],

  // exposed forearm skin at the cuff
  skin: ['flesh', {
    vertexColors: true, color: 0xb98b6e, roughness: 0.78, metalness: 0.0,
    normalScale: 0.7, detailStrength: 0.3, detailScale: 26, envMapIntensity: 0.7,
  }, { color: 0xa87c60, roughness: 0.8, metalness: 0.0 }],

  // sling webbing
  webbing: ['fabric', {
    vertexColors: true, color: 0x3b3a30, roughness: 1.0, metalness: 0.0,
    normalScale: 1.4, detailStrength: 0.9, detailScale: 12, envMapIntensity: 0.5,
  }, { color: 0x33322a, roughness: 1.0, metalness: 0.0 }],
};

/**
 * Build (and memoise) the whole palette for a game instance.
 * @returns {Object<string, THREE.Material>} plus the non-library specials.
 */
export function buildPalette(game) {
  if (game && game.__weaponPalette) return game.__weaponPalette;
  const lib = game?.materials;
  const out = {};

  for (const [key, [recipe, opts, fallback]] of Object.entries(SPEC)) {
    let mat = null;
    try {
      mat = lib?.variant?.(recipe, { ...opts, name: `weapon_${key}` }) ?? null;
    } catch (err) {
      console.warn(`[Weapons] palette "${key}" fell back:`, err);
      mat = null;
    }
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ vertexColors: true, ...fallback });
      mat.name = `weapon_${key}`;
    }
    out[key] = mat;
  }

  // ---- specials that are not part of the world material library -------

  // Optic housing rubber armour: dead matte so the lens pops against it.
  out.opticBody = out.alloy;

  // Lens glass. Physical, thin, low roughness, tinted toward the classic
  // magenta/green anti-reflective coating.
  out.lens = new THREE.MeshPhysicalMaterial({
    color: 0x0a1418,
    roughness: 0.04,
    metalness: 0.0,
    transparent: true,
    opacity: 0.34,
    transmission: 0.0,
    ior: 1.52,
    clearcoat: 1.0,
    clearcoatRoughness: 0.02,
    envMapIntensity: 3.2,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  out.lens.name = 'weapon_lens';

  // Rear ocular glass: darker, kills the "floating hologram" look.
  out.lensRear = out.lens.clone();
  out.lensRear.opacity = 0.22;
  out.lensRear.color = new THREE.Color(0x101a1e);
  out.lensRear.name = 'weapon_lens_rear';

  // Tritium / fibre-optic sight inserts.
  out.tritium = new THREE.MeshStandardMaterial({
    color: 0x0a1a10, emissive: 0x35ff9a, emissiveIntensity: 2.6,
    roughness: 0.35, metalness: 0.0, toneMapped: true,
  });
  out.tritium.name = 'weapon_tritium';

  out.fibre = new THREE.MeshStandardMaterial({
    color: 0x2a0805, emissive: 0xff3418, emissiveIntensity: 3.4,
    roughness: 0.3, metalness: 0.0,
  });
  out.fibre.name = 'weapon_fibre';

  // Bore black: the inside of muzzle devices and ejection ports.
  out.bore = new THREE.MeshStandardMaterial({
    color: 0x050506, roughness: 0.95, metalness: 0.4,
  });
  out.bore.name = 'weapon_bore';

  if (game) game.__weaponPalette = out;
  return out;
}

/** Wear presets keyed by palette entry, consumed by PartBin.bake(). */
export const WEAR = {
  default: { amount: 0.85, gain: 1.9, tint: 0xc6ced6, dirt: 0.5 },
  gunmetal: { amount: 1.0, gain: 2.15, tint: 0xc9d3dc, dirt: 0.55 },
  alloy: { amount: 0.9, gain: 1.85, tint: 0xbfc7cf, dirt: 0.6 },
  steel: { amount: 0.55, gain: 1.35, tint: 0xe2e8ee, dirt: 0.35 },
  blued: { amount: 0.8, gain: 2.0, tint: 0xccd4dc, dirt: 0.45 },
  polymer: { amount: 0.5, gain: 1.35, tint: 0xa9a89c, dirt: 0.65 },
  fde: { amount: 0.5, gain: 1.28, tint: 0xd6c3a0, dirt: 0.6 },
  grip: { amount: 0.35, gain: 1.25, tint: 0x9a998f, dirt: 0.7 },
  rubber: { amount: 0.25, gain: 1.2, tint: 0x8e8e8e, dirt: 0.5 },
  brass: { amount: 0.4, gain: 1.3, tint: 0xffe6a8, dirt: 0.3 },
  glove: { amount: 0.45, gain: 1.35, tint: 0x9c9a92, dirt: 0.75 },
  glovePad: { amount: 0.55, gain: 1.4, tint: 0xa8adb2, dirt: 0.6 },
  skin: { amount: 0.2, gain: 1.15, tint: 0xffd8bc, dirt: 0.35 },
  webbing: { amount: 0.3, gain: 1.2, tint: 0x9d9a86, dirt: 0.8 },
};
