/**
 * The canonical shot list. Every shot targets a specific quality claim so a
 * critic can look at one image and judge one thing.
 *
 * pos/look are world-space; `action` runs gameplay verbs before the capture so
 * transient effects (muzzle flash, impacts, blood) are on screen.
 */
export const SHOTS = [
  {
    name: 'establishing',
    what: 'Wide exterior. Sky, sun, atmosphere, distant geometry, global composition.',
    pos: [-26, 3.6, 34], look: [6, 4.5, -10], fov: 75, time: 0.32,
  },
  {
    name: 'weapon-hero',
    what: 'Viewmodel readability: geometry density, PBR metal/polymer, hands, attachments.',
    pos: [4, 1.7, 8], look: [4, 1.7, -20], fov: 80, action: 'inspect',
  },
  {
    name: 'ads',
    what: 'Aim-down-sight: optic reticle, lens glass, depth of field, FOV compression.',
    pos: [4, 1.7, 8], look: [4, 1.75, -30], fov: 80, action: 'ads',
  },
  {
    name: 'muzzle-flash',
    what: 'Firing: muzzle flash shape + light contribution, smoke, shell eject, recoil.',
    pos: [4, 1.7, 8], look: [4, 1.7, -30], fov: 80, action: 'fire',
  },
  {
    name: 'interior',
    what: 'Indoor lighting: bounce, contact shadows/AO, material variety, dust volumetrics.',
    pos: [12, 1.7, -14], look: [-6, 1.4, -14], fov: 80, time: 0.32,
  },
  {
    name: 'god-rays',
    what: 'Volumetric shafts through openings, atmospheric scattering, bloom quality.',
    pos: [-4, 1.7, -18], look: [10, 6, -26], fov: 80, time: 0.22,
  },
  {
    name: 'combat',
    what: 'Full combat frame: enemies, tracers, impacts, HUD, hitmarkers.',
    pos: [2, 1.7, 2], look: [2, 1.6, -26], fov: 80, action: 'combat',
  },
  {
    name: 'surfaces',
    what: 'Material close-up: normal maps, roughness variation, parallax, decals, wear.',
    pos: [-9.2, 1.5, -3], look: [-11.6, 1.35, -3], fov: 55,
  },
  {
    name: 'enemy',
    what: 'Character quality: silhouette, gear, cloth, skin/fabric shading, animation pose.',
    pos: [0, 1.7, -6], look: [0, 1.55, -13], fov: 60, action: 'enemy-pose',
  },
  {
    name: 'night',
    what: 'Night lighting: local light falloff, shadow contrast, emissive, tone response.',
    pos: [-26, 3.6, 34], look: [6, 4.5, -10], fov: 75, time: 0.88,
  },
];
