/**
 * The level plan.
 *
 * "Operation Blackout" is a three-lane map in the Call of Duty tradition: three
 * routes run north-south between the two spawns, joined by three cross streets
 * so a squad can rotate without ever being forced through the middle.
 *
 *   WEST  x ~ -38   the Boulevard    120 m straight — the sniper lane
 *   MID   x ~  -3   the Souk         tight, awninged, broken by stalls
 *   EAST  x ~  34   the Compound     walled courtyards, medium sightlines
 *
 * Cross streets at z = +30, z = 0 and z = -34, plus two dirt alleys that let
 * the mid lane leak into both flanks. Everything is metres; +X is east, -Z is
 * north, and the two spawns face each other down the map's long axis.
 */

export const MAP = {
  half: 70,          // playable half-extent
  terrainHalf: 96,   // detailed heightfield half-extent
  farRadius: 620,    // distant silhouette terrain
};

/** Road centrelines. `w` is the half-width of the carriageway. */
export const ROADS = [
  { id: 'mid', a: [-3, 68], b: [-3, -68], w: 5.0, kind: 'asphalt', kerb: true },
  { id: 'boulevard', a: [-38, 70], b: [-38, -70], w: 6.2, kind: 'asphalt', kerb: true },
  { id: 'east', a: [34, 64], b: [34, -58], w: 4.6, kind: 'asphalt', kerb: true },
  { id: 'cross-s', a: [-50, 30], b: [46, 30], w: 5.0, kind: 'asphalt', kerb: true },
  { id: 'cross-c', a: [-48, 0], b: [44, 0], w: 5.0, kind: 'asphalt', kerb: true },
  { id: 'cross-n', a: [-48, -34], b: [42, -34], w: 4.4, kind: 'asphalt', kerb: true },
  { id: 'alley-w', a: [-12, -19], b: [-34, -19], w: 2.3, kind: 'dirt', kerb: false },
  { id: 'alley-e', a: [22, -16], b: [31, -16], w: 2.4, kind: 'dirt', kerb: false },
  { id: 'alley-s', a: [6, 14], b: [30, 14], w: 2.4, kind: 'dirt', kerb: false },
];

/** Potholes: [x, z, radius, depth]. */
export const POTHOLES = [
  [-3.4, 12, 1.5, 0.17], [-1.2, -24, 1.1, 0.13], [-4.8, -41, 1.8, 0.20],
  [-38.6, 8, 1.9, 0.16], [-37.2, -30, 1.4, 0.12], [12, 30.5, 1.6, 0.15],
  [34.8, -12, 1.3, 0.14], [-20, 4.0, 2.1, 0.18],
];

/**
 * Building palette.
 *
 * These are *linear* multipliers on an already-baked albedo, applied through the
 * vertex colour channel (see `paintGeometry`), so they cost no extra draw call
 * and a whole block still merges into one mesh. Multiplication can only subtract
 * saturation, never invent it, which is why the painted entries push one channel
 * above 1 rather than pulling the other two down — that is the difference
 * between "blue house" and "dark grey house".
 *
 * They are pitched as a value ladder, not as decoration: `whitewash` and
 * `limewash` are the bright end that the eye lands on first, `oxide` and `mud`
 * are the dark end that frames them, and no two neighbours on the same street
 * sit at the same value.
 */
export const PAINT = {
  whitewash: [1.28, 1.27, 1.22],   // brightest thing in the level
  limewash: [1.14, 1.13, 1.06],
  sand: [1.06, 0.94, 0.74],
  ochre: [1.16, 0.86, 0.50],
  saffron: [1.22, 0.94, 0.46],
  terracotta: [1.10, 0.62, 0.42],
  oxide: [0.92, 0.48, 0.36],
  teal: [0.62, 0.96, 1.02],
  sky: [0.72, 0.92, 1.22],
  verdigris: [0.66, 0.96, 0.80],
  grey: [0.80, 0.82, 0.84],
  mud: [0.72, 0.60, 0.46],
  soot: [0.52, 0.50, 0.48],
};

/** Weathered paint for shutters, door leaves and railings. */
export const TRIM = {
  blue: [0.72, 1.30, 1.85],
  teal: [0.70, 1.32, 1.30],
  green: [0.78, 1.24, 0.86],
  red: [1.34, 0.62, 0.52],
  ochre: [1.30, 0.98, 0.60],
  bare: [0.86, 0.80, 0.72],
};

/**
 * Buildings. `cx/cz` is the footprint centre, `w/d` the extents, `rot` a small
 * yaw in degrees that keeps the town from reading as a spreadsheet. The two
 * hero volumes (souk-hall and plaza-house) stay axis aligned because the shot
 * list frames them.
 *
 * `tint` / `accentTint` / `trimTint` pick out of the palettes above. They are
 * applied by material name inside `Buildings.build`, so every piece a style
 * emits — piers, arches, copings, string courses — is coloured without the
 * generators knowing anything about it.
 */
export const BUILDINGS = [
  {
    id: 'souk-hall', style: 'hall', cx: 14, cz: -16, w: 16, d: 20, rot: 0,
    floors: 2, floorH: 4.3, wall: 'plaster', accent: 'stucco',
    tint: PAINT.ochre, accentTint: PAINT.whitewash, trimTint: TRIM.teal,
    arcade: { west: true, east: true }, loggia: { west: true },
    enterable: true, roofAccess: true, parapet: 1.05,
  },
  {
    id: 'plaza-house', style: 'townhouse', cx: -19, cz: -7, w: 14, d: 18, rot: 0,
    floors: 3, floorH: 3.5, wall: 'stucco', accent: 'brick',
    tint: PAINT.whitewash, trimTint: TRIM.blue,
    enterable: true, roofAccess: true, parapet: 0.95,
    balconies: [{ side: 'east', offset: -3.5, width: 4.2, floor: 1 },
      { side: 'east', offset: 3.5, width: 4.2, floor: 2 }],
    heroWall: 'east',
  },
  {
    id: 'corner-shop', style: 'townhouse', cx: 12, cz: 15, w: 12, d: 14, rot: -3,
    floors: 2, floorH: 3.6, wall: 'plaster', accent: 'concrete',
    tint: PAINT.sky, accentTint: PAINT.grey, trimTint: TRIM.red,
    enterable: true, roofAccess: false, parapet: 0.8,
    balconies: [{ side: 'west', offset: 0, width: 5.0, floor: 1 }],
  },
  {
    id: 'riad', style: 'townhouse', cx: -27, cz: 14, w: 14, d: 16, rot: 4,
    floors: 2, floorH: 3.7, wall: 'stucco', accent: 'plaster',
    tint: PAINT.saffron, accentTint: PAINT.limewash, trimTint: TRIM.green,
    enterable: true, roofAccess: false, parapet: 1.0,
    balconies: [{ side: 'east', offset: 0, width: 4.6, floor: 1 }],
  },
  {
    id: 'ruin', style: 'ruin', cx: -21, cz: -31, w: 14, d: 18, rot: -6,
    floors: 2, floorH: 3.4, wall: 'concrete_cracked', accent: 'brick',
    tint: PAINT.soot, trimTint: TRIM.bare,
    enterable: true, parapet: 0.5,
  },
  {
    id: 'warehouse', style: 'warehouse', cx: 17, cz: -48, w: 18, d: 22, rot: 2,
    floors: 1, floorH: 7.4, wall: 'concrete', accent: 'metal_corrugated',
    tint: PAINT.grey, accentTint: PAINT.oxide, trimTint: TRIM.blue,
    enterable: true, parapet: 0.4,
  },
  {
    id: 'west-block', style: 'townhouse', cx: -56, cz: -10, w: 16, d: 40, rot: 1,
    floors: 2, floorH: 3.6, wall: 'plaster', accent: 'stucco',
    tint: PAINT.limewash, accentTint: PAINT.sand, trimTint: TRIM.ochre,
    enterable: false, parapet: 0.9,
  },
  {
    id: 'west-sheds', style: 'warehouse', cx: -58, cz: 33, w: 12, d: 22, rot: -2,
    floors: 1, floorH: 4.6, wall: 'stucco', accent: 'metal_corrugated',
    tint: PAINT.mud, accentTint: PAINT.oxide, trimTint: TRIM.bare,
    enterable: false, parapet: 0.35,
  },
  {
    id: 'minaret', style: 'tower', cx: -47, cz: -44, w: 6.4, d: 6.4, rot: 0,
    floors: 4, floorH: 3.5, wall: 'stucco', accent: 'plaster',
    tint: PAINT.whitewash, accentTint: PAINT.verdigris, trimTint: TRIM.green,
    enterable: false, parapet: 0.9,
  },
  {
    id: 'villa', style: 'townhouse', cx: 51, cz: -10, w: 18, d: 20, rot: -4,
    floors: 2, floorH: 3.8, wall: 'stucco', accent: 'plaster',
    tint: PAINT.terracotta, accentTint: PAINT.limewash, trimTint: TRIM.blue,
    enterable: true, roofAccess: true, parapet: 1.0,
    balconies: [{ side: 'west', offset: 0, width: 6.0, floor: 1 }],
  },
  {
    id: 'garage', style: 'warehouse', cx: 50, cz: 17, w: 16, d: 14, rot: 3,
    floors: 1, floorH: 5.2, wall: 'concrete', accent: 'metal_corrugated',
    tint: PAINT.mud, accentTint: PAINT.oxide, trimTint: TRIM.red,
    enterable: true, parapet: 0.3,
  },
  {
    id: 'north-row', style: 'townhouse', cx: -20, cz: -55, w: 18, d: 12, rot: -2,
    floors: 2, floorH: 3.4, wall: 'plaster', accent: 'brick',
    tint: PAINT.sand, trimTint: TRIM.teal,
    enterable: false, parapet: 0.85,
  },
  {
    id: 'south-row', style: 'townhouse', cx: 14, cz: 47, w: 20, d: 12, rot: 2,
    floors: 2, floorH: 3.4, wall: 'stucco', accent: 'plaster',
    tint: PAINT.verdigris, accentTint: PAINT.whitewash, trimTint: TRIM.ochre,
    enterable: false, parapet: 0.85,
  },
  {
    id: 'east-shed', style: 'warehouse', cx: 52, cz: -44, w: 14, d: 14, rot: -3,
    floors: 1, floorH: 4.8, wall: 'plaster', accent: 'metal_corrugated',
    tint: PAINT.ochre, accentTint: PAINT.oxide, trimTint: TRIM.bare,
    enterable: false, parapet: 0.3,
  },
];

/** Free-standing compound walls: polylines extruded to a height. */
export const WALLS = [
  { pts: [[40, -30], [62, -30], [62, 6], [40, 6]], h: 2.6, gap: [[40, -30], [40, -24]], mat: 'stucco', tint: PAINT.limewash },
  { pts: [[26, 30], [26, 8]], h: 2.4, mat: 'concrete', tint: PAINT.grey },
  { pts: [[-13, 27], [-13, 7]], h: 2.5, mat: 'stucco', tint: PAINT.sand },
  { pts: [[-46, 24], [-46, -30]], h: 2.7, mat: 'concrete', tint: PAINT.mud },
  { pts: [[6, 40], [26, 40]], h: 2.3, mat: 'stucco', tint: PAINT.ochre },
  { pts: [[6, -54], [6, -36]], h: 2.5, mat: 'concrete', tint: PAINT.grey },
];

/**
 * Spawn points. `team` is advisory — the AI system picks whichever set it
 * wants, the player controller takes `role === 'player'`.
 */
export const SPAWNS = [
  { role: 'player', team: 'friendly', position: [-3, 0, 52], yaw: 0 },
  { role: 'friendly', team: 'friendly', position: [-8.5, 0, 56], yaw: 0.06 },
  { role: 'friendly', team: 'friendly', position: [2.5, 0, 57], yaw: -0.05 },
  { role: 'friendly', team: 'friendly', position: [-38, 0, 58], yaw: 0 },
  { role: 'friendly', team: 'friendly', position: [34, 0, 54], yaw: 0.1 },
  { role: 'hostile', team: 'hostile', position: [-3, 0, -50], yaw: Math.PI },
  { role: 'hostile', team: 'hostile', position: [-38, 0, -54], yaw: Math.PI },
  { role: 'hostile', team: 'hostile', position: [34, 0, -48], yaw: Math.PI },
  { role: 'hostile', team: 'hostile', position: [16, 0, -34], yaw: Math.PI * 0.85 },
  { role: 'hostile', team: 'hostile', position: [-24, 0, -37], yaw: Math.PI * 1.1 },
  { role: 'contest', team: 'neutral', position: [-3, 0, -14], yaw: Math.PI },
  { role: 'contest', team: 'neutral', position: [12, 0, -14], yaw: -Math.PI * 0.5 },
  { role: 'contest', team: 'neutral', position: [-19, 0, 0], yaw: 0.4 },
  { role: 'contest', team: 'neutral', position: [34, 0, -20], yaw: Math.PI },
  { role: 'contest', team: 'neutral', position: [-38, 0, 6], yaw: Math.PI },
];

/**
 * Waist- and chest-height cover. `h` is the top of the cover in metres: 0.95 is
 * a crouch-behind, 1.25 is a stand-behind-and-lean.
 */
export const COVER = [
  // mid lane, staggered so neither side has a straight run
  { kind: 'jersey', x: 1.4, z: 22, rot: 4, h: 1.05 },
  { kind: 'jersey', x: -7.2, z: 16, rot: -88, h: 1.05 },
  { kind: 'sandbag', x: 2.0, z: 4, rot: 6, h: 1.15 },
  { kind: 'crates', x: -7.6, z: -3, rot: 12, h: 1.2 },
  { kind: 'jersey', x: 0.6, z: -10, rot: -95, h: 1.05 },
  { kind: 'barrels', x: -8.0, z: -22, rot: 0, h: 0.95 },
  { kind: 'rubble', x: 3.0, z: -30, rot: 24, h: 1.1 },
  { kind: 'car', x: -4.5, z: -37, rot: 74, h: 1.35 },
  { kind: 'sandbag', x: -1.0, z: -47, rot: 92, h: 1.15 },
  // boulevard: sparse, long, deliberately exposed between hard cover
  { kind: 'jersey', x: -34.5, z: 40, rot: 90, h: 1.05 },
  { kind: 'car', x: -41.0, z: 20, rot: 12, h: 1.35 },
  { kind: 'sandbag', x: -34.0, z: -4, rot: 90, h: 1.15 },
  { kind: 'jersey', x: -41.5, z: -18, rot: 88, h: 1.05 },
  { kind: 'rubble', x: -35.0, z: -40, rot: 8, h: 1.2 },
  { kind: 'crates', x: -42.0, z: -52, rot: -20, h: 1.2 },
  // east compound
  { kind: 'crates', x: 30.5, z: 34, rot: 0, h: 1.2 },
  { kind: 'barrels', x: 38.5, z: 12, rot: 0, h: 0.95 },
  { kind: 'jersey', x: 30.0, z: -6, rot: 90, h: 1.05 },
  { kind: 'sandbag', x: 38.0, z: -26, rot: 0, h: 1.15 },
  { kind: 'car', x: 33.0, z: -40, rot: 100, h: 1.35 },
  // cross streets
  { kind: 'jersey', x: -20, z: 33, rot: 2, h: 1.05 },
  { kind: 'sandbag', x: 18, z: 27, rot: 178, h: 1.15 },
  { kind: 'crates', x: -15, z: 6, rot: 40, h: 1.2 },
  { kind: 'rubble', x: 22, z: -2, rot: 15, h: 1.1 },
  { kind: 'barrels', x: -31, z: -37, rot: 0, h: 0.95 },
  { kind: 'jersey', x: 8, z: -31, rot: 6, h: 1.05 },
];

/** Market stalls: the mid lane's identity. */
export const STALLS = [
  { x: 3.6, z: 20, rot: -90, canopy: 0 },
  { x: 3.9, z: 12, rot: -90, canopy: 1 },
  { x: -9.4, z: 8, rot: 90, canopy: 2 },
  { x: -9.2, z: 6.5, rot: 90, canopy: 0 },
  { x: 3.7, z: -6, rot: -90, canopy: 1 },
  { x: 3.5, z: -20, rot: -92, canopy: 2 },
  { x: -9.6, z: -26, rot: 88, canopy: 1 },
  { x: -20, z: 36.6, rot: 180, canopy: 0 },
  { x: -10, z: 23.0, rot: 0, canopy: 2 },
  { x: 20, z: 36.6, rot: 180, canopy: 1 },
];

/** Power/telephone poles; wires are strung between consecutive ids. */
export const POLES = [
  { x: 5.6, z: 30, h: 8.2 }, { x: 5.4, z: 12, h: 8.0 }, { x: 5.8, z: -6, h: 8.4 },
  { x: 5.5, z: -24, h: 8.1 }, { x: 5.9, z: -42, h: 8.3 },
  { x: -31.0, z: 34, h: 9.0 }, { x: -31.2, z: 12, h: 8.8 }, { x: -30.8, z: -10, h: 9.1 },
  { x: -31.1, z: -32, h: 8.9 }, { x: -31.0, z: -54, h: 9.0 },
  { x: 27.5, z: 30, h: 8.4 }, { x: 27.8, z: 6, h: 8.2 }, { x: 27.4, z: -20, h: 8.5 },
];

export const WIRES = [[0, 1], [1, 2], [2, 3], [3, 4], [5, 6], [6, 7], [7, 8], [8, 9], [10, 11], [11, 12]];

/** Palms and scrub. */
export const PALMS = [
  [-15.5, 37.4], [-6, 37.6], [7.5, 37.5], [24, 37.4], [-25, 37.2],
  [-30.5, 44], [-30.0, 20], [-46.5, 34], [-46.5, -6], [-29.5, -46],
  [8.0, 6.5], [-10.5, 6.0], [29, 8], [44, 2], [43, -27], [24, -62], [-14, 60], [10, 58],
];

export const OBJECTIVE_TEXT = 'SECURE THE MARKET DISTRICT';
