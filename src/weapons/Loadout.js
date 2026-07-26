import { Clip, Track } from './Anim.js';

/**
 * Weapon data tables: stats, recoil patterns and animation choreography.
 *
 * Recoil patterns are authored the way a real COD spray is: a designed sequence
 * of per-shot pitch/yaw offsets in degrees, so the first shots climb almost
 * vertically and the tail walks in a repeatable shape a player can learn and
 * counter. Random bloom is added *on top* of the pattern rather than replacing
 * it, and recovery returns most — never all — of the accumulated offset.
 */

/* ==================================================================== */
/* recoil pattern authoring                                              */
/* ==================================================================== */

/**
 * Build an n-shot pattern from a compact description.
 * @param {number} n
 * @param {Object} cfg {climb, settle, sway:[...], drift, seed}
 * @returns {Array<[pitch, yaw]>} degrees
 */
function makePattern(n, cfg) {
  const out = [];
  const climb = cfg.climb ?? 0.42;
  const settle = cfg.settle ?? 0.62;
  const sway = cfg.sway ?? [0, 0.2, 0.5, 0.35, -0.1, -0.5, -0.7, -0.5, -0.1, 0.3, 0.6, 0.5];
  const drift = cfg.drift ?? 0.0;
  let s = cfg.seed ?? 7;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < n; i++) {
    // vertical: strong for the first third, then decaying toward a floor
    const k = i / Math.max(1, n - 1);
    const pitch = climb * (settle + (1 - settle) * Math.exp(-i * 0.42)) * (0.92 + rnd() * 0.16);
    const yaw = (sway[i % sway.length] * (cfg.yawScale ?? 0.30)) + drift * k
      + (rnd() - 0.5) * (cfg.yawJitter ?? 0.06);
    out.push([pitch, yaw]);
  }
  return out;
}

/* ==================================================================== */
/* animation choreography                                                */
/* ==================================================================== */

/**
 * Tactical reload: magazine still has a round, so no bolt release.
 * `m` scales the whole timeline; `mag` describes where the magazine travels.
 */
function reloadClip(cfg) {
  const d = cfg.duration;
  const s = (t) => t * d;   // author in normalised time, emit seconds
  const magOut = cfg.magOut ?? [0.02, -0.24, 0.05];
  return new Clip({
    duration: d,
    tracks: {
      'pos.x': [[s(0), 0], [s(0.14), 0.028, 'outCubic'], [s(0.55), 0.034], [s(0.80), 0.012, 'inOutCubic'], [s(1), 0, 'outCubic']],
      'pos.y': [[s(0), 0], [s(0.12), -0.038, 'outCubic'], [s(0.58), -0.048], [s(0.84), -0.014, 'inOutCubic'], [s(1), 0, 'outCubic']],
      'pos.z': [[s(0), 0], [s(0.14), 0.052, 'outCubic'], [s(0.60), 0.058], [s(0.86), 0.012, 'inOutCubic'], [s(1), 0, 'outCubic']],
      'rot.x': [[s(0), 0], [s(0.16), -0.20, 'outCubic'], [s(0.58), -0.24], [s(0.86), -0.05, 'inOutCubic'], [s(1), 0, 'outCubic']],
      'rot.y': [[s(0), 0], [s(0.16), 0.30, 'outCubic'], [s(0.58), 0.36], [s(0.86), 0.08, 'inOutCubic'], [s(1), 0, 'outCubic']],
      'rot.z': [[s(0), 0], [s(0.16), 0.46, 'outCubic'], [s(0.58), 0.52], [s(0.86), 0.10, 'inOutCubic'], [s(1), 0, 'outCubic']],
      // magazine: released, falls clear, replacement rides up from below
      'mag.y': [
        [s(0), 0], [s(0.22), 0], [s(0.30), -0.055, 'inQuad'], [s(0.34), -0.30, 'inQuad'],
        [s(0.50), -0.34], [s(0.58), -0.28, 'outCubic'], [s(0.70), -0.045, 'outCubic'], [s(0.76), 0, 'outQuad'], [s(1), 0],
      ],
      'mag.z': [[s(0), 0], [s(0.30), 0], [s(0.36), 0.045, 'outCubic'], [s(0.58), 0.05], [s(0.70), 0.008, 'outCubic'], [s(0.76), 0], [s(1), 0]],
      'mag.rx': [[s(0), 0], [s(0.30), 0], [s(0.40), 0.34, 'outCubic'], [s(0.58), 0.30], [s(0.72), 0.03, 'outCubic'], [s(0.76), 0], [s(1), 0]],
      'mag.v': [[s(0), 1], [s(0.44), 1], [s(0.45), 0, 'step'], [s(0.575), 0, 'step'], [s(0.58), 1, 'step'], [s(1), 1]],
      // support hand: off the handguard, down to the pouch, back with a mag
      'lh.x': [[s(0), 0], [s(0.16), 0.030, 'outCubic'], [s(0.30), 0.055], [s(0.44), 0.060], [s(0.62), 0.040], [s(0.76), 0.005, 'inOutCubic'], [s(0.88), 0.012], [s(1), 0, 'outCubic']],
      'lh.y': [[s(0), 0], [s(0.18), -0.075, 'outCubic'], [s(0.32), -0.095], [s(0.46), -0.34, 'inOutCubic'], [s(0.56), -0.36], [s(0.70), -0.075, 'outCubic'], [s(0.78), -0.015], [s(0.84), -0.055], [s(0.92), -0.020, 'outCubic'], [s(1), 0, 'outCubic']],
      'lh.z': [[s(0), 0], [s(0.18), 0.120, 'outCubic'], [s(0.34), 0.150], [s(0.50), 0.175], [s(0.68), 0.150], [s(0.80), 0.040, 'inOutCubic'], [s(0.88), 0.055], [s(1), 0, 'outCubic']],
      'lh.rx': [[s(0), 0], [s(0.20), -0.55, 'outCubic'], [s(0.50), -0.75], [s(0.70), -0.45], [s(0.86), -0.10, 'inOutCubic'], [s(1), 0, 'outCubic']],
      'lh.rz': [[s(0), 0], [s(0.20), 0.45, 'outCubic'], [s(0.50), 0.62], [s(0.72), 0.30], [s(0.88), 0.05, 'inOutCubic'], [s(1), 0, 'outCubic']],
      'trigger.rx': [[s(0), 0], [s(0.08), 0], [s(1), 0]],
    },
    events: [
      [s(0.06), 'lh', 'open'],
      [s(0.28), 'magRelease'],
      [s(0.30), 'lh', 'pinch'],
      [s(0.45), 'magDrop'],
      [s(0.58), 'magNew'],
      [s(0.755), 'magSeated'],
      [s(0.80), 'lh', 'fist'],
      [s(0.88), 'lh', 'support'],
    ],
  });
}

/** Empty reload: same as tactical plus a charging-handle / bolt-release beat. */
function reloadEmptyClip(cfg) {
  const base = reloadClip({ ...cfg, duration: cfg.duration });
  const d = cfg.duration;
  const s = (t) => t * d;
  // extend the tail: after seating the magazine the support hand goes to the
  // charging handle (or bolt catch) and sends the bolt home
  base.tracks.set('charge.z', new Track([
    [s(0.82), 0], [s(0.88), (cfg.chargeTravel ?? 0.06), 'outQuart'], [s(0.93), 0, 'outQuad'], [s(1), 0],
  ]));
  base.tracks.set('bolt.z', new Track([
    [s(0), cfg.boltBack ?? 0.03], [s(0.86), cfg.boltBack ?? 0.03], [s(0.90), (cfg.boltBack ?? 0.03) + (cfg.boltExtra ?? 0.006), 'outQuad'], [s(0.935), 0, 'outQuart'], [s(1), 0],
  ]));
  base.channels = [...base.tracks.keys()];
  base.events = base.events.filter((e) => e[0] < s(0.80));
  base.events.push(
    [s(0.80), 'lh', 'hook'],
    [s(0.90), 'chargePull'],
    [s(0.935), 'boltRelease'],
    [s(0.95), 'lh', 'support'],
  );
  base.events.sort((a, b) => a[0] - b[0]);
  return base;
}

/** Inspect: rotate the weapon into the light, check the chamber, drop it back. */
function inspectClip(cfg) {
  const d = cfg.duration ?? 2.9;
  const s = (t) => t * d;
  return new Clip({
    duration: d,
    tracks: {
      'pos.x': [[s(0), 0], [s(0.20), -0.030, 'outCubic'], [s(0.46), -0.038], [s(0.70), 0.010], [s(1), 0, 'inOutCubic']],
      'pos.y': [[s(0), 0], [s(0.18), 0.036, 'outCubic'], [s(0.48), 0.042], [s(0.72), 0.010], [s(1), 0, 'inOutCubic']],
      'pos.z': [[s(0), 0], [s(0.20), 0.060, 'outCubic'], [s(0.50), 0.070], [s(0.74), 0.020], [s(1), 0, 'inOutCubic']],
      'rot.x': [[s(0), 0], [s(0.16), 0.10, 'outCubic'], [s(0.34), -0.06], [s(0.56), 0.22], [s(0.78), 0.04], [s(1), 0, 'inOutCubic']],
      'rot.y': [[s(0), 0], [s(0.22), -0.95, 'outCubic'], [s(0.44), -1.05], [s(0.60), -0.30, 'inOutCubic'], [s(0.78), 0.55], [s(0.90), 0.18], [s(1), 0, 'inOutCubic']],
      'rot.z': [[s(0), 0], [s(0.22), 0.34, 'outCubic'], [s(0.46), 0.42], [s(0.66), -0.10], [s(0.84), -0.22], [s(1), 0, 'inOutCubic']],
      'lh.y': [[s(0), 0], [s(0.30), -0.020], [s(0.52), -0.050], [s(0.74), -0.010], [s(1), 0, 'outCubic']],
      'lh.z': [[s(0), 0], [s(0.30), 0.030], [s(0.52), 0.075], [s(0.74), 0.020], [s(1), 0, 'outCubic']],
      'lh.rx': [[s(0), 0], [s(0.34), -0.25], [s(0.56), -0.42], [s(0.78), -0.08], [s(1), 0, 'outCubic']],
      'charge.z': [[s(0), 0], [s(0.50), 0], [s(0.56), (cfg.chargeTravel ?? 0.05) * 0.55, 'outQuart'], [s(0.62), 0, 'outQuad'], [s(1), 0]],
      'bolt.z': [[s(0), 0], [s(0.50), 0], [s(0.56), (cfg.boltBack ?? 0.03) * 0.75, 'outQuart'], [s(0.63), 0, 'outQuad'], [s(1), 0]],
      'dust.rz': [[s(0), 0], [s(0.48), 0], [s(0.55), -1.75, 'outQuart'], [s(0.86), -1.75], [s(0.96), 0, 'inOutCubic'], [s(1), 0]],
    },
    events: [[s(0.50), 'lh', 'hook'], [s(0.66), 'lh', 'support']],
  });
}

/** Melee: a hard buttstroke with the stock, then recover. */
function meleeClip(cfg) {
  const d = cfg.duration ?? 0.72;
  const s = (t) => t * d;
  return new Clip({
    duration: d,
    tracks: {
      'pos.x': [[s(0), 0], [s(0.22), -0.10, 'outCubic'], [s(0.42), 0.16, 'inQuart'], [s(0.55), 0.10], [s(1), 0, 'outCubic']],
      'pos.y': [[s(0), 0], [s(0.22), 0.07, 'outCubic'], [s(0.42), -0.06, 'inQuart'], [s(1), 0, 'outCubic']],
      'pos.z': [[s(0), 0], [s(0.22), 0.10, 'outCubic'], [s(0.42), -0.14, 'inQuart'], [s(0.60), 0.02], [s(1), 0, 'outCubic']],
      'rot.x': [[s(0), 0], [s(0.22), 0.30, 'outCubic'], [s(0.42), -0.44, 'inQuart'], [s(1), 0, 'outCubic']],
      'rot.y': [[s(0), 0], [s(0.22), 0.62, 'outCubic'], [s(0.42), -0.85, 'inQuart'], [s(0.62), -0.20], [s(1), 0, 'outCubic']],
      'rot.z': [[s(0), 0], [s(0.22), -0.45, 'outCubic'], [s(0.42), 0.55, 'inQuart'], [s(1), 0, 'outCubic']],
    },
    events: [[s(0.40), 'meleeHit']],
  });
}

/** Draw / holster. */
function switchClip(cfg, out) {
  const d = cfg.duration ?? 0.5;
  const s = (t) => t * d;
  if (out) {
    return new Clip({
      duration: d,
      tracks: {
        'pos.y': [[s(0), 0], [s(1), -0.34, 'inCubic']],
        'pos.z': [[s(0), 0], [s(1), 0.10, 'inCubic']],
        'rot.x': [[s(0), 0], [s(1), -1.15, 'inCubic']],
        'rot.z': [[s(0), 0], [s(1), 0.42, 'inCubic']],
      },
      events: [],
    });
  }
  return new Clip({
    duration: d,
    tracks: {
      'pos.y': [[s(0), -0.34], [s(0.72), 0.014, 'outCubic'], [s(1), 0, 'outCubic']],
      'pos.z': [[s(0), 0.10], [s(0.72), -0.012, 'outCubic'], [s(1), 0, 'outCubic']],
      'rot.x': [[s(0), -1.15], [s(0.70), 0.10, 'outCubic'], [s(1), 0, 'outCubic']],
      'rot.y': [[s(0), 0.45], [s(0.70), -0.05, 'outCubic'], [s(1), 0, 'outCubic']],
      'rot.z': [[s(0), 0.42], [s(0.70), -0.06, 'outCubic'], [s(1), 0, 'outCubic']],
    },
    events: [[s(0.05), 'lh', 'support']],
  });
}

/** Bolt-action cycle: lift, draw, feed, lock. */
function boltCycleClip(cfg) {
  const d = cfg.duration ?? 0.95;
  const s = (t) => t * d;
  const travel = cfg.travel ?? 0.09;
  const lift = cfg.lift ?? 1.15;
  return new Clip({
    duration: d,
    tracks: {
      'pos.x': [[s(0), 0], [s(0.20), 0.020, 'outCubic'], [s(0.62), 0.024], [s(0.88), 0.004], [s(1), 0, 'outCubic']],
      'pos.y': [[s(0), 0], [s(0.20), -0.014, 'outCubic'], [s(0.62), -0.018], [s(1), 0, 'outCubic']],
      'rot.z': [[s(0), 0], [s(0.18), 0.16, 'outCubic'], [s(0.62), 0.20], [s(0.90), 0.03], [s(1), 0, 'outCubic']],
      'rot.y': [[s(0), 0], [s(0.18), 0.10, 'outCubic'], [s(0.62), 0.13], [s(1), 0, 'outCubic']],
      'bolt.rz': [[s(0), 0], [s(0.16), lift, 'outQuart'], [s(0.68), lift], [s(0.86), 0, 'outQuart'], [s(1), 0]],
      'bolt.z': [[s(0), 0], [s(0.18), 0], [s(0.40), travel, 'outQuart'], [s(0.56), travel], [s(0.74), 0, 'inOutCubic'], [s(1), 0]],
      'lh.x': [[s(0), 0], [s(0.14), 0.10, 'outCubic'], [s(0.50), 0.14], [s(0.84), 0.02], [s(1), 0, 'outCubic']],
      'lh.y': [[s(0), 0], [s(0.14), 0.075, 'outCubic'], [s(0.50), 0.10], [s(0.84), 0.01], [s(1), 0, 'outCubic']],
      'lh.z': [[s(0), 0], [s(0.14), 0.20, 'outCubic'], [s(0.40), 0.235], [s(0.56), 0.30], [s(0.84), 0.05], [s(1), 0, 'outCubic']],
      'lh.rx': [[s(0), 0], [s(0.20), -0.35], [s(0.60), -0.42], [s(0.88), -0.06], [s(1), 0, 'outCubic']],
    },
    events: [
      [s(0.05), 'lh', 'hook'],
      [s(0.34), 'boltBack'],
      [s(0.74), 'boltForward'],
      [s(0.90), 'lh', 'support'],
    ],
  });
}

/** Semi-auto slide cycle for the pistol (visual only, driven by the fire beat). */
function slideCycleClip(cfg) {
  const d = cfg.duration ?? 0.10;
  const s = (t) => t * d;
  const travel = cfg.travel ?? 0.042;
  return new Clip({
    duration: d,
    tracks: {
      'slide.z': [[s(0), 0], [s(0.28), travel, 'outQuart'], [s(0.48), travel], [s(1), 0, 'inOutCubic']],
      'hammer.rx': [[s(0), 0], [s(0.30), -1.05, 'outQuart'], [s(0.85), 0, 'inOutCubic'], [s(1), 0]],
    },
    events: [[s(0.30), 'boltBack']],
  });
}

/* ==================================================================== */
/* weapons                                                               */
/* ==================================================================== */

export const WEAPONS = [
  {
    id: 'rifle',
    model: 'rifle',
    name: 'AR-70',
    displayName: 'AR-70 WARDEN',
    className: 'Assault Rifle',
    slot: 0,
    calibre: '5.56x45',
    /* --- gunplay --- */
    rpm: 760,
    fireModes: ['auto', 'burst', 'semi'],
    burstCount: 3,
    burstDelay: 0.20,
    magSize: 30,
    reserve: 210,
    damage: 33,
    falloff: [[0, 1], [28, 1], [55, 0.74], [90, 0.58], [150, 0.5]],
    multipliers: { head: 1.9, chest: 1.15, body: 1, legs: 0.85, arms: 0.88 },
    penetration: 1.0,
    range: 330,
    /* --- handling --- */
    adsTime: 0.235,
    adsZoom: 0.78,
    sprintOut: 0.19,
    reloadTime: 2.15,
    reloadEmptyTime: 2.75,
    switchInTime: 0.48,
    switchOutTime: 0.30,
    spread: { hip: 0.036, ads: 0.0022, move: 0.030, jump: 0.055, crouch: -0.008 },
    bloom: { perShot: 0.0034, max: 0.020, recover: 0.055 },
    /* --- recoil --- */
    recoil: {
      pattern: makePattern(30, { climb: 0.44, settle: 0.55, yawScale: 0.34, drift: 0.05, seed: 11 }),
      bloomYaw: 0.10,
      bloomPitch: 0.06,
      recovery: 8.5,
      retain: 0.13,
      adsScale: 0.72,
      kick: { back: 0.031, up: 0.013, roll: 0.062, pitch: 0.095, yaw: 0.024 },
      shake: { amplitude: 0.028, frequency: 26, duration: 0.10 },
    },
    /* --- viewmodel --- */
    poses: {
      hip: { pos: [0.104, -0.112, -0.168], rot: [0.020, -0.055, 0.020] },
      ads: { pos: [0, -0.0615, -0.098], rot: [0, 0, 0] },
      sprint: { pos: [0.150, -0.150, -0.098], rot: [-0.30, -0.75, 0.62] },
      slide: { pos: [0.150, -0.180, -0.060], rot: [-0.52, -0.90, 0.78] },
      air: { pos: [0.112, -0.140, -0.150], rot: [0.06, -0.08, 0.05] },
    },
    ejectVelocity: [2.9, 1.5, -0.35],
    flashPower: 1.0,
    shellScale: 1.0,
    tracerColor: 0xffcf8a,
    tracerEvery: 3,
    clips: {},
    boltBack: 0.032,
    chargeTravel: 0.060,
  },

  {
    id: 'smg',
    model: 'smg',
    name: 'SMG-9',
    displayName: 'SMG-9 WRAITH',
    className: 'Submachine Gun',
    slot: 1,
    calibre: '9x19',
    rpm: 940,
    fireModes: ['auto', 'semi'],
    magSize: 32,
    reserve: 224,
    damage: 25,
    falloff: [[0, 1], [16, 1], [32, 0.72], [60, 0.52], [110, 0.44]],
    multipliers: { head: 1.7, chest: 1.1, body: 1, legs: 0.85, arms: 0.9 },
    penetration: 0.62,
    range: 220,
    adsTime: 0.185,
    adsZoom: 0.84,
    sprintOut: 0.14,
    reloadTime: 1.85,
    reloadEmptyTime: 2.40,
    switchInTime: 0.40,
    switchOutTime: 0.26,
    spread: { hip: 0.030, ads: 0.0034, move: 0.020, jump: 0.048, crouch: -0.006 },
    bloom: { perShot: 0.0030, max: 0.022, recover: 0.062 },
    recoil: {
      pattern: makePattern(32, { climb: 0.34, settle: 0.6, yawScale: 0.46, drift: -0.06, seed: 23 }),
      bloomYaw: 0.14,
      bloomPitch: 0.07,
      recovery: 9.5,
      retain: 0.10,
      adsScale: 0.78,
      kick: { back: 0.023, up: 0.010, roll: 0.052, pitch: 0.072, yaw: 0.030 },
      shake: { amplitude: 0.021, frequency: 30, duration: 0.08 },
    },
    poses: {
      hip: { pos: [0.098, -0.104, -0.150], rot: [0.02, -0.06, 0.025] },
      ads: { pos: [0, -0.0538, -0.090], rot: [0, 0, 0] },
      sprint: { pos: [0.142, -0.140, -0.086], rot: [-0.32, -0.80, 0.66] },
      slide: { pos: [0.142, -0.170, -0.055], rot: [-0.54, -0.95, 0.80] },
      air: { pos: [0.104, -0.130, -0.135], rot: [0.06, -0.09, 0.05] },
    },
    ejectVelocity: [2.6, 1.6, -0.2],
    flashPower: 0.78,
    shellScale: 0.82,
    tracerColor: 0xffc27a,
    tracerEvery: 4,
    clips: {},
    boltBack: 0.030,
    chargeTravel: 0.050,
  },

  {
    id: 'sniper',
    model: 'sniper',
    name: 'DMR-338',
    displayName: 'DMR-338 LONGBOW',
    className: 'Marksman Rifle',
    slot: 2,
    calibre: '.338 LM',
    rpm: 55,
    fireModes: ['semi'],
    boltAction: true,
    magSize: 7,
    reserve: 42,
    damage: 118,
    falloff: [[0, 1], [200, 1], [400, 0.92]],
    multipliers: { head: 2.4, chest: 1.25, body: 1, legs: 0.9, arms: 0.9 },
    penetration: 2.4,
    range: 800,
    adsTime: 0.42,
    adsZoom: 0.20,
    sprintOut: 0.32,
    reloadTime: 2.85,
    reloadEmptyTime: 3.35,
    switchInTime: 0.62,
    switchOutTime: 0.40,
    spread: { hip: 0.075, ads: 0.0002, move: 0.045, jump: 0.09, crouch: -0.012 },
    bloom: { perShot: 0.010, max: 0.030, recover: 0.10 },
    recoil: {
      pattern: makePattern(8, { climb: 1.55, settle: 0.9, yawScale: 0.24, drift: 0, seed: 5 }),
      bloomYaw: 0.06,
      bloomPitch: 0.05,
      recovery: 5.4,
      retain: 0.22,
      adsScale: 0.9,
      kick: { back: 0.075, up: 0.028, roll: 0.09, pitch: 0.20, yaw: 0.03 },
      shake: { amplitude: 0.075, frequency: 18, duration: 0.20 },
    },
    poses: {
      hip: { pos: [0.116, -0.128, -0.140], rot: [0.02, -0.05, 0.02] },
      ads: { pos: [0, -0.0745, -0.160], rot: [0, 0, 0] },
      sprint: { pos: [0.165, -0.165, -0.070], rot: [-0.28, -0.70, 0.58] },
      slide: { pos: [0.165, -0.195, -0.040], rot: [-0.50, -0.86, 0.74] },
      air: { pos: [0.124, -0.152, -0.126], rot: [0.06, -0.08, 0.05] },
    },
    ejectVelocity: [3.3, 1.9, -0.4],
    flashPower: 1.6,
    shellScale: 1.35,
    tracerColor: 0xfff0c0,
    tracerEvery: 1,
    scoped: true,
    clips: {},
    boltBack: 0.090,
    chargeTravel: 0,
  },

  {
    id: 'pistol',
    model: 'pistol',
    name: 'P-45',
    displayName: 'P-45 SIDEARM',
    className: 'Sidearm',
    slot: 3,
    calibre: '.45 ACP',
    rpm: 420,
    fireModes: ['semi'],
    magSize: 12,
    reserve: 72,
    damage: 42,
    falloff: [[0, 1], [14, 1], [30, 0.70], [55, 0.55]],
    multipliers: { head: 1.8, chest: 1.1, body: 1, legs: 0.85, arms: 0.9 },
    penetration: 0.45,
    range: 160,
    adsTime: 0.155,
    adsZoom: 0.86,
    sprintOut: 0.11,
    reloadTime: 1.62,
    reloadEmptyTime: 2.15,
    switchInTime: 0.32,
    switchOutTime: 0.22,
    spread: { hip: 0.028, ads: 0.0030, move: 0.022, jump: 0.05, crouch: -0.006 },
    bloom: { perShot: 0.0060, max: 0.026, recover: 0.09 },
    recoil: {
      pattern: makePattern(12, { climb: 0.86, settle: 0.85, yawScale: 0.30, drift: 0.04, seed: 17 }),
      bloomYaw: 0.14,
      bloomPitch: 0.10,
      recovery: 10.5,
      retain: 0.08,
      adsScale: 0.8,
      kick: { back: 0.034, up: 0.019, roll: 0.10, pitch: 0.160, yaw: 0.036 },
      shake: { amplitude: 0.030, frequency: 24, duration: 0.09 },
    },
    poses: {
      hip: { pos: [0.086, -0.108, -0.230], rot: [0.03, -0.07, 0.02] },
      ads: { pos: [0, -0.0210, -0.369], rot: [0, 0, 0] },
      sprint: { pos: [0.120, -0.150, -0.180], rot: [-0.36, -0.72, 0.60] },
      slide: { pos: [0.120, -0.180, -0.150], rot: [-0.55, -0.85, 0.72] },
      air: { pos: [0.092, -0.130, -0.212], rot: [0.06, -0.09, 0.05] },
    },
    ejectVelocity: [2.4, 2.0, -0.1],
    flashPower: 0.9,
    shellScale: 1.05,
    tracerColor: 0xffc07a,
    tracerEvery: 2,
    slideAction: true,
    clips: {},
    boltBack: 0.042,
    chargeTravel: 0,
  },
];

/** Build the animation clips for one weapon definition. */
export function buildClips(def) {
  const chargeTravel = def.chargeTravel ?? 0.05;
  const boltBack = def.boltBack ?? 0.03;
  return {
    reload: reloadClip({ duration: def.reloadTime, chargeTravel, boltBack }),
    reloadEmpty: reloadEmptyClip({ duration: def.reloadEmptyTime, chargeTravel, boltBack }),
    inspect: inspectClip({ duration: def.inspectTime ?? 3.0, chargeTravel, boltBack }),
    melee: meleeClip({ duration: def.meleeTime ?? 0.72 }),
    switchIn: switchClip({ duration: def.switchInTime }, false),
    switchOut: switchClip({ duration: def.switchOutTime }, true),
    boltCycle: def.boltAction
      ? boltCycleClip({ duration: def.boltCycleTime ?? 0.95, travel: boltBack, lift: 1.15 })
      : null,
    slideCycle: def.slideAction ? slideCycleClip({ duration: 0.11, travel: boltBack }) : null,
  };
}

export { makePattern };
