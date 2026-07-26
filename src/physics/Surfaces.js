/**
 * Surface material table.
 *
 * The ids here are the ones fixed by ARCHITECTURE.md ("surface material ids") and
 * are what `bullet:impact.surface` carries. Everything physical that varies per
 * material — how bouncy debris is on it, how much of a bullet's energy it eats,
 * how thick a slab of it a rifle round can defeat — lives in one table so the
 * ballistics solver, the debris solver and the ragdoll solver all agree.
 *
 * Numbers are hand-tuned for feel, not for physical accuracy: `maxPen` is the
 * thickness in metres that a reference 1.0-energy rifle round can just barely
 * punch through, `entryCost` is the flat energy toll for crossing the surface at
 * all (so a chain-link fence is nearly free while sheet steel is not).
 */

export const SURFACE_IDS = [
  'concrete', 'metal', 'wood', 'sand', 'glass',
  'water', 'dirt', 'fabric', 'flesh', 'foliage',
];

/** name -> integer id used in the per-triangle byte arrays. */
export const SURFACE_INDEX = /* @__PURE__ */ (() => {
  const m = Object.create(null);
  for (let i = 0; i < SURFACE_IDS.length; i++) m[SURFACE_IDS[i]] = i;
  return m;
})();

/**
 * @typedef {Object} SurfaceProps
 * @property {string}  name
 * @property {number}  restitution   bounciness for debris landing on it
 * @property {number}  friction      coulomb friction coefficient
 * @property {number}  density       kg/m^3, used for ricochet weighting
 * @property {number}  maxPen        metres a 1.0-energy round can defeat
 * @property {number}  entryCost     flat energy toll to enter the material
 * @property {number}  thin          assumed thickness when no exit face is found
 * @property {number}  ricochetCos   cos of the grazing angle below which rounds skip
 * @property {number}  softness      0 hard .. 1 soft; drives impact particle choice
 * @property {boolean} shatters      glass-like: penetration is basically free
 */
const P = (name, o) => ({
  name,
  restitution: 0.2,
  friction: 0.8,
  density: 1500,
  maxPen: 0.25,
  entryCost: 0.06,
  thin: 0.04,
  ricochetCos: 0.14,
  softness: 0.3,
  shatters: false,
  ...o,
});

export const SURFACE_PROPS = {
  concrete: P('concrete', {
    restitution: 0.26, friction: 0.92, density: 2400,
    maxPen: 0.14, entryCost: 0.11, thin: 0.10, ricochetCos: 0.17, softness: 0.05,
  }),
  metal: P('metal', {
    restitution: 0.42, friction: 0.48, density: 7800,
    maxPen: 0.055, entryCost: 0.15, thin: 0.006, ricochetCos: 0.22, softness: 0.0,
  }),
  wood: P('wood', {
    restitution: 0.22, friction: 0.72, density: 620,
    maxPen: 0.42, entryCost: 0.05, thin: 0.025, ricochetCos: 0.08, softness: 0.25,
  }),
  sand: P('sand', {
    restitution: 0.04, friction: 1.05, density: 1650,
    maxPen: 0.30, entryCost: 0.09, thin: 0.20, ricochetCos: 0.05, softness: 0.7,
  }),
  glass: P('glass', {
    restitution: 0.12, friction: 0.42, density: 2500,
    maxPen: 0.9, entryCost: 0.02, thin: 0.006, ricochetCos: 0.04, softness: 0.1,
    shatters: true,
  }),
  water: P('water', {
    restitution: 0.0, friction: 0.35, density: 1000,
    maxPen: 0.75, entryCost: 0.05, thin: 0.35, ricochetCos: 0.03, softness: 1.0,
  }),
  dirt: P('dirt', {
    restitution: 0.09, friction: 0.98, density: 1500,
    maxPen: 0.34, entryCost: 0.08, thin: 0.18, ricochetCos: 0.06, softness: 0.6,
  }),
  fabric: P('fabric', {
    restitution: 0.03, friction: 1.0, density: 300,
    maxPen: 1.6, entryCost: 0.01, thin: 0.004, ricochetCos: 0.02, softness: 0.9,
  }),
  flesh: P('flesh', {
    restitution: 0.02, friction: 1.0, density: 1050,
    maxPen: 0.55, entryCost: 0.04, thin: 0.14, ricochetCos: 0.02, softness: 1.0,
  }),
  foliage: P('foliage', {
    restitution: 0.08, friction: 0.85, density: 220,
    maxPen: 2.2, entryCost: 0.005, thin: 0.02, ricochetCos: 0.01, softness: 0.85,
  }),
};

const DEFAULT_SURFACE = SURFACE_PROPS.concrete;

/** Clamp any string to a valid surface index (unknown -> concrete). */
export function surfaceIndexOf(name) {
  const i = SURFACE_INDEX[name];
  return i === undefined ? 0 : i;
}

export function surfaceName(index) {
  return SURFACE_IDS[index] || 'concrete';
}

/** Accepts a name or an integer index. */
export function surfaceProps(nameOrIndex) {
  if (typeof nameOrIndex === 'number') return SURFACE_PROPS[SURFACE_IDS[nameOrIndex]] || DEFAULT_SURFACE;
  return SURFACE_PROPS[nameOrIndex] || DEFAULT_SURFACE;
}
