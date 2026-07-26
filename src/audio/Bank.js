/**
 * OPERATION BLACKOUT — the sound bank.
 *
 * Every one-shot in the game, synthesised at boot. Each family below is a
 * *recipe*: a description of the physical event in layers, rendered several
 * times with different random seeds so nothing ever repeats verbatim. A rifle
 * firing 760 rounds a minute plays four different shot buffers at four slightly
 * different rates; the ear stops hearing "a sample" almost immediately.
 *
 * Rate policy: cracks and tails run at the context rate (they contain real
 * content above 12 kHz); footsteps, impacts, mechanics and UI are rendered at
 * 32 kHz, which is transparent for their bandwidth and halves both boot cost
 * and resident memory.
 */

import {
  Rng, Biquad, addNoiseBurst, addResonance, addModes, addSweep, addGrains, addClick,
  softClip, dcBlock, normalize, fadeEdges, trim, toBuffer, scale, fillNoise, applyFilters,
} from './Synth.js';

/* ==================================================================== */
/* extra helpers                                                         */
/* ==================================================================== */

/**
 * Chamberlin state-variable filter with a swept cutoff. The fixed Biquad can't
 * glide, and gliding resonance is exactly what a bullet passing your head and a
 * ricochet whining off concrete both are.
 */
export function sweepFilter(buf, sr, f0, f1, q = 3, mode = 'band', from = 0, to = buf.length) {
  let low = 0;
  let band = 0;
  const Q = 1 / Math.max(0.4, q);
  const n = to - from;
  const ratio = f1 / f0;
  const inv = n > 1 ? 1 / (n - 1) : 0;
  let F = 0.1;
  for (let i = 0; i < n; i++) {
    if ((i & 7) === 0) {
      const f = f0 * Math.pow(ratio, i * inv);
      F = 2 * Math.sin(Math.PI * Math.min(f, sr * 0.23) / sr);
    }
    const x = buf[from + i];
    const high = x - low - Q * band;
    band += F * high;
    low += F * band;
    buf[from + i] = mode === 'low' ? low : mode === 'high' ? high : band;
  }
  return buf;
}

/** Filtered noise whose band glides — the core of whizbys, whines and splashes. */
function addSweptNoise(out, sr, o) {
  const i0 = Math.round((o.t0 ?? 0) * sr);
  const dur = o.dur ?? 0.12;
  const n = Math.min(Math.ceil(dur * sr), out.length - i0);
  if (n <= 0) return out;
  const tmp = new Float32Array(n);
  fillNoise(tmp, o.rng, o.color ?? 'white');
  sweepFilter(tmp, sr, o.f0 ?? 3000, o.f1 ?? 800, o.q ?? 4, o.mode ?? 'band');
  const decay = o.decay ?? dur * 0.4;
  const attack = o.attack ?? 0.001;
  const gain = o.gain ?? 1;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const a = 1 - Math.exp(-t / (attack * 0.34));
    const d = Math.exp(-Math.pow(t / decay, o.curve ?? 1));
    out[i0 + i] += tmp[i] * a * d * gain;
  }
  return out;
}

/** A single metal-on-metal event: transient plus a short modal ring. */
function addMech(out, sr, o) {
  const rng = o.rng;
  const t0 = o.t0 ?? 0;
  const g = o.gain ?? 1;
  const mass = o.mass ?? 1;        // heavier = lower, longer
  const bright = o.bright ?? 1;
  const jitter = o.jitter ?? 0;
  const t = t0 + (jitter ? rng.bi(jitter) : 0);

  addNoiseBurst(out, sr, {
    rng,
    t0: t,
    decay: 0.0035 * mass,
    attack: 0.00012,
    curve: 1.4,
    gain: g * 0.9,
    filters: [
      { type: 'hp', f: 900 / mass, q: 0.7 },
      { type: 'peak', f: 2600 * bright, q: 1.2, g: 7 },
      { type: 'lp', f: 11000 * bright, q: 0.6 },
    ],
  });

  const base = (o.f ?? 1450) / mass;
  addModes(out, sr, {
    t0: t,
    gain: g * (o.ring ?? 0.55),
    modes: [
      { f: base, tau: 0.011 * mass, a: 1.0, bend: 0.985, beat: 0.3 },
      { f: base * 1.68, tau: 0.0085 * mass, a: 0.7, bend: 0.99 },
      { f: base * 2.71 * bright, tau: 0.006 * mass, a: 0.45 },
      { f: base * 4.13 * bright, tau: 0.0035 * mass, a: 0.28 },
    ],
  });

  if (o.knock) {
    addSweep(out, sr, {
      t0: t, f0: 210 / mass, f1: 96 / mass, decay: 0.026 * mass, sweep: 0.012,
      gain: g * o.knock, attack: 0.0008,
    });
  }
  if (o.spring) {
    // Recoil-spring zing: a bright, slightly detuned pair sliding downward.
    addModes(out, sr, {
      t0: t + 0.002,
      gain: g * o.spring,
      modes: [
        { f: 4200 * bright, tau: 0.045, a: 0.5, bend: 0.86, beat: 0.6, detune: 1.011 },
        { f: 6350 * bright, tau: 0.030, a: 0.3, bend: 0.9, beat: 0.5, detune: 1.007 },
      ],
    });
  }
  return out;
}

/** Cloth / webbing movement — the glue foley that makes handling feel physical. */
function addCloth(out, sr, o) {
  const rng = o.rng;
  const g = o.gain ?? 1;
  const t0 = o.t0 ?? 0;
  addSweptNoise(out, sr, {
    rng, t0, dur: o.dur ?? 0.16, f0: o.f0 ?? 1800, f1: o.f1 ?? 700, q: 1.1,
    decay: (o.dur ?? 0.16) * 0.42, attack: 0.012, gain: g * 0.5, color: 'pink',
  });
  addGrains(out, sr, {
    rng, t0, dur: (o.dur ?? 0.16) * 0.9, count: o.grains ?? 14, gain: g * 0.28,
    fLo: 1400, fHi: 6200, grainDecay: 0.0035, skew: 1.2, grainQ: 1.6,
  });
  return out;
}

/* ==================================================================== */
/* weapon voices                                                         */
/* ==================================================================== */

/**
 * Per-weapon character. The differences that actually matter to the ear:
 *   - spectral tilt of the crack (bore pressure / calibre)
 *   - ring time of the barrel modes (barrel mass and length)
 *   - how much sub-100 Hz thump gets out of the muzzle
 *   - the mechanical layer's timing and mass (blowback vs rotating bolt)
 */
export const WEAPON_VOICES = {
  rifle: {
    dur: 0.62, drive: 1.7, level: 1.0, tailClass: 'rifle', tailGain: 1.0,
    crack: { decay: 0.030, attack: 0.00035, hp: 620, lp: 15500, peak: [3050, 1.0, 5.5], gain: 1.0, curve: 1.2 },
    tick: { decay: 0.0024, gain: 0.55, hp: 2400, peak: [6300, 1.4, 6] },
    air: { decay: 0.115, hp: 280, lp: 5400, gain: 0.34, curve: 0.85 },
    body: {
      excite: 0.0018, gain: 0.62,
      modes: [
        { f: 128, tau: 0.090, a: 1.00 }, { f: 236, tau: 0.062, a: 0.74 },
        { f: 402, tau: 0.046, a: 0.52 }, { f: 698, tau: 0.033, a: 0.38 },
        { f: 1185, tau: 0.024, a: 0.26 }, { f: 2060, tau: 0.016, a: 0.16 },
      ],
    },
    thump: { f0: 138, f1: 47, decay: 0.130, sweep: 0.048, gain: 0.70 },
    sub: { f0: 66, f1: 33, decay: 0.200, sweep: 0.100, gain: 0.30 },
    mech: [
      { t: 0.0060, gain: 0.16, f: 3200, mass: 0.7, bright: 1.15 },
      { t: 0.0350, gain: 0.26, f: 1500, mass: 1.05, knock: 0.35, jitter: 0.002 },
      { t: 0.0640, gain: 0.22, f: 1180, mass: 1.25, knock: 0.5, spring: 0.10, jitter: 0.003 },
    ],
  },

  smg: {
    dur: 0.44, drive: 1.5, level: 0.86, tailClass: 'smg', tailGain: 0.72,
    crack: { decay: 0.020, attack: 0.0003, hp: 830, lp: 16000, peak: [3900, 1.1, 5.0], gain: 1.0, curve: 1.3 },
    tick: { decay: 0.0020, gain: 0.6, hp: 2900, peak: [7100, 1.5, 6] },
    air: { decay: 0.070, hp: 380, lp: 6200, gain: 0.26, curve: 0.9 },
    body: {
      excite: 0.0013, gain: 0.5,
      modes: [
        { f: 178, tau: 0.052, a: 1.00 }, { f: 318, tau: 0.038, a: 0.68 },
        { f: 545, tau: 0.028, a: 0.48 }, { f: 940, tau: 0.020, a: 0.32 },
        { f: 1620, tau: 0.014, a: 0.20 },
      ],
    },
    thump: { f0: 168, f1: 62, decay: 0.078, sweep: 0.030, gain: 0.46 },
    sub: { f0: 82, f1: 44, decay: 0.120, sweep: 0.060, gain: 0.18 },
    // Blowback: the bolt is a much bigger part of the sound than on a rifle.
    mech: [
      { t: 0.0040, gain: 0.20, f: 3600, mass: 0.6, bright: 1.2 },
      { t: 0.0230, gain: 0.36, f: 1750, mass: 0.85, knock: 0.4, jitter: 0.0015 },
      { t: 0.0430, gain: 0.32, f: 1380, mass: 1.0, knock: 0.55, spring: 0.16, jitter: 0.002 },
    ],
  },

  sniper: {
    dur: 0.95, drive: 1.75, level: 1.35, tailClass: 'sniper', tailGain: 1.45,
    crack: { decay: 0.048, attack: 0.0004, hp: 430, lp: 16500, peak: [2300, 0.9, 6.5], gain: 1.35, curve: 1.05 },
    tick: { decay: 0.0030, gain: 0.62, hp: 1900, peak: [5400, 1.3, 5] },
    air: { decay: 0.210, hp: 190, lp: 4300, gain: 0.46, curve: 0.78 },
    body: {
      excite: 0.0026, gain: 0.85,
      modes: [
        { f: 88, tau: 0.170, a: 1.00 }, { f: 163, tau: 0.120, a: 0.80 },
        { f: 279, tau: 0.088, a: 0.58 }, { f: 468, tau: 0.062, a: 0.42 },
        { f: 812, tau: 0.044, a: 0.30 }, { f: 1420, tau: 0.030, a: 0.20 },
        { f: 2380, tau: 0.020, a: 0.12 },
      ],
    },
    thump: { f0: 108, f1: 34, decay: 0.260, sweep: 0.090, gain: 0.80 },
    sub: { f0: 52, f1: 24, decay: 0.380, sweep: 0.180, gain: 0.32 },
    mech: [
      { t: 0.0090, gain: 0.18, f: 2600, mass: 0.9 },
      { t: 0.0520, gain: 0.14, f: 1250, mass: 1.5, knock: 0.3, jitter: 0.004 },
    ],
  },

  pistol: {
    dur: 0.40, drive: 1.45, level: 0.8, tailClass: 'smg', tailGain: 0.62,
    crack: { decay: 0.022, attack: 0.0003, hp: 700, lp: 15000, peak: [2750, 1.0, 5.0], gain: 1.0, curve: 1.25 },
    tick: { decay: 0.0022, gain: 0.5, hp: 2500, peak: [6000, 1.4, 5.5] },
    air: { decay: 0.085, hp: 320, lp: 5000, gain: 0.30, curve: 0.9 },
    body: {
      excite: 0.0014, gain: 0.55,
      modes: [
        { f: 205, tau: 0.048, a: 1.00 }, { f: 372, tau: 0.034, a: 0.66 },
        { f: 640, tau: 0.025, a: 0.44 }, { f: 1080, tau: 0.018, a: 0.28 },
      ],
    },
    thump: { f0: 154, f1: 56, decay: 0.100, sweep: 0.038, gain: 0.55 },
    sub: { f0: 74, f1: 38, decay: 0.150, sweep: 0.070, gain: 0.22 },
    // Slide cycling is loud, close to the ear, and slightly rattly.
    mech: [
      { t: 0.0035, gain: 0.18, f: 3400, mass: 0.65, bright: 1.15 },
      { t: 0.0260, gain: 0.34, f: 2050, mass: 0.8, knock: 0.35, jitter: 0.0015 },
      { t: 0.0510, gain: 0.38, f: 1620, mass: 0.95, knock: 0.6, spring: 0.22, jitter: 0.002 },
    ],
  },
};

const DEFAULT_VOICE = WEAPON_VOICES.rifle;

function makeShot(sr, v, rng) {
  const out = new Float32Array(Math.ceil((v.dur ?? 0.6) * sr));
  const jit = (x, amt) => x * (1 + rng.bi(amt));

  // 1 — the transient. A few hundred microseconds of attack; everything else
  //     about a gunshot is decided in the first 30 ms.
  addNoiseBurst(out, sr, {
    rng, t0: 0, decay: jit(v.crack.decay, 0.10), attack: v.crack.attack,
    curve: v.crack.curve, gain: v.crack.gain,
    filters: [
      { type: 'hp', f: jit(v.crack.hp, 0.07), q: 0.72 },
      { type: 'peak', f: jit(v.crack.peak[0], 0.05), q: v.crack.peak[1], g: v.crack.peak[2] },
      { type: 'lp', f: v.crack.lp, q: 0.6 },
    ],
  });
  addNoiseBurst(out, sr, {
    rng, t0: 0, decay: v.tick.decay, attack: 0.00008, gain: v.tick.gain,
    filters: [
      { type: 'hp', f: v.tick.hp, q: 0.6 },
      { type: 'peak', f: v.tick.peak[0], q: v.tick.peak[1], g: v.tick.peak[2] },
    ],
  });

  // 2 — expanding propellant gas: slower, darker, no sharp edge.
  addNoiseBurst(out, sr, {
    rng, t0: 0.0016, decay: jit(v.air.decay, 0.08), attack: 0.0026, curve: v.air.curve,
    gain: v.air.gain, color: 'pink',
    filters: [{ type: 'hp', f: v.air.hp, q: 0.7 }, { type: 'lp', f: jit(v.air.lp, 0.08), q: 0.8 }],
  });

  // 3 — the barrel answering. This is the weapon's fingerprint.
  addResonance(out, sr, {
    rng, t0: 0.0008, excite: v.body.excite, gain: v.body.gain,
    modes: v.body.modes.map((m) => ({ f: jit(m.f, 0.012), tau: jit(m.tau, 0.08), a: m.a })),
  });

  // 4 — muzzle blast pressure wave and the sub you feel more than hear.
  addSweep(out, sr, {
    t0: 0.0012, attack: 0.0018, f0: jit(v.thump.f0, 0.05), f1: v.thump.f1,
    decay: jit(v.thump.decay, 0.09), sweep: v.thump.sweep, gain: v.thump.gain,
  });
  addSweep(out, sr, {
    t0: 0.0040, attack: 0.0060, f0: v.sub.f0, f1: v.sub.f1,
    decay: v.sub.decay, sweep: v.sub.sweep, gain: v.sub.gain,
  });

  // 5 — the action cycling. Late, dry, and unmistakably mechanical.
  for (const m of v.mech) addMech(out, sr, { ...m, t0: m.t, rng });

  softClip(out, v.drive, 0.08);
  dcBlock(out, sr);
  normalize(out, 0.94);
  fadeEdges(out, sr, 0.02, 10);
  return trim(out, 1.5e-4, sr);
}

/* ==================================================================== */
/* mechanics (reload, handling)                                          */
/* ==================================================================== */

const MECH_RECIPES = {
  magRelease: (sr, rng) => {
    const out = new Float32Array(Math.ceil(0.16 * sr));
    addMech(out, sr, { rng, t0: 0.0, gain: 0.55, f: 3900, mass: 0.5, bright: 1.25, ring: 0.35 });
    addNoiseBurst(out, sr, {
      rng, t0: 0.001, decay: 0.006, gain: 0.30, attack: 0.0002,
      filters: [{ type: 'bp', f: 2400, q: 1.4 }],
    });
    return out;
  },
  magOut: (sr, rng) => {
    const out = new Float32Array(Math.ceil(0.34 * sr));
    // Magazine sliding out of the well: friction, then a plastic knock.
    addSweptNoise(out, sr, {
      rng, t0: 0, dur: 0.10, f0: 1500, f1: 2900, q: 1.4, decay: 0.055, attack: 0.006, gain: 0.28,
    });
    addMech(out, sr, { rng, t0: 0.085, gain: 0.42, f: 1150, mass: 1.5, bright: 0.7, knock: 0.6, ring: 0.35 });
    addCloth(out, sr, { rng, t0: 0.10, dur: 0.16, gain: 0.22 });
    return out;
  },
  magIn: (sr, rng) => {
    const out = new Float32Array(Math.ceil(0.30 * sr));
    addCloth(out, sr, { rng, t0: 0, dur: 0.12, gain: 0.26, f0: 2200, f1: 900 });
    addSweptNoise(out, sr, {
      rng, t0: 0.05, dur: 0.07, f0: 2600, f1: 1400, q: 1.6, decay: 0.04, attack: 0.005, gain: 0.24,
    });
    return out;
  },
  magSeated: (sr, rng) => {
    const out = new Float32Array(Math.ceil(0.32 * sr));
    // The definitive "clack" — heavy, with a low-frequency body behind it.
    addMech(out, sr, { rng, t0: 0, gain: 0.95, f: 1250, mass: 1.35, knock: 0.9, ring: 0.5 });
    addSweep(out, sr, { t0: 0, f0: 190, f1: 78, decay: 0.055, sweep: 0.02, gain: 0.45, attack: 0.0009 });
    addModes(out, sr, {
      t0: 0.001, gain: 0.28,
      modes: [{ f: 620, tau: 0.045, a: 1, bend: 0.97, beat: 0.4 }, { f: 1580, tau: 0.028, a: 0.5 }],
    });
    return out;
  },
  boltRelease: (sr, rng) => {
    const out = new Float32Array(Math.ceil(0.36 * sr));
    addMech(out, sr, { rng, t0: 0, gain: 0.5, f: 3100, mass: 0.6, bright: 1.2, ring: 0.4 });
    addMech(out, sr, { rng, t0: 0.030, gain: 0.95, f: 1350, mass: 1.15, knock: 0.85, spring: 0.30, ring: 0.6 });
    addSweep(out, sr, { t0: 0.030, f0: 230, f1: 92, decay: 0.05, sweep: 0.018, gain: 0.38, attack: 0.0008 });
    return out;
  },
  boltBack: (sr, rng) => {
    const out = new Float32Array(Math.ceil(0.34 * sr));
    addSweptNoise(out, sr, {
      rng, t0: 0, dur: 0.075, f0: 1100, f1: 3200, q: 2.2, decay: 0.05, attack: 0.004, gain: 0.30,
    });
    addMech(out, sr, { rng, t0: 0.070, gain: 0.75, f: 1500, mass: 1.0, knock: 0.55, spring: 0.22, ring: 0.55 });
    return out;
  },
  chargePull: (sr, rng) => {
    const out = new Float32Array(Math.ceil(0.42 * sr));
    // Ratchet: a train of tiny ticks riding a rising friction band.
    addSweptNoise(out, sr, {
      rng, t0: 0, dur: 0.11, f0: 900, f1: 3400, q: 2.0, decay: 0.075, attack: 0.005, gain: 0.30,
    });
    for (let i = 0; i < 7; i++) {
      addClick(out, sr, { rng, t0: 0.010 + i * 0.0135 + rng.bi(0.002), gain: 0.14 + i * 0.012, f: 3200 + i * 260, q: 1.3, decay: 0.0011 });
    }
    addMech(out, sr, { rng, t0: 0.108, gain: 0.62, f: 1420, mass: 1.05, knock: 0.5, spring: 0.28, ring: 0.55 });
    return out;
  },
  dryfire: (sr, rng) => {
    const out = new Float32Array(Math.ceil(0.14 * sr));
    addMech(out, sr, { rng, t0: 0, gain: 0.5, f: 2450, mass: 0.75, bright: 0.95, knock: 0.25, ring: 0.45 });
    addClick(out, sr, { rng, t0: 0, gain: 0.35, f: 5200, q: 1.0, decay: 0.0008 });
    return out;
  },
  trigger: (sr, rng) => {
    const out = new Float32Array(Math.ceil(0.06 * sr));
    addClick(out, sr, { rng, t0: 0, gain: 0.22, f: 4400, q: 1.2, decay: 0.0007 });
    return out;
  },
  firemode: (sr, rng) => {
    const out = new Float32Array(Math.ceil(0.12 * sr));
    addMech(out, sr, { rng, t0: 0, gain: 0.4, f: 3600, mass: 0.55, bright: 1.2, ring: 0.5 });
    addClick(out, sr, { rng, t0: 0.004, gain: 0.25, f: 6100, q: 1.4, decay: 0.0007 });
    return out;
  },
  raise: (sr, rng) => {
    const out = new Float32Array(Math.ceil(0.42 * sr));
    addCloth(out, sr, { rng, t0: 0, dur: 0.26, gain: 0.42, f0: 2400, f1: 800, grains: 22 });
    addMech(out, sr, { rng, t0: 0.11, gain: 0.24, f: 1700, mass: 1.2, knock: 0.3, ring: 0.4, jitter: 0.01 });
    addMech(out, sr, { rng, t0: 0.19, gain: 0.16, f: 2400, mass: 0.9, ring: 0.35, jitter: 0.02 });
    return out;
  },
  lower: (sr, rng) => {
    const out = new Float32Array(Math.ceil(0.36 * sr));
    addCloth(out, sr, { rng, t0: 0, dur: 0.22, gain: 0.36, f0: 1600, f1: 620, grains: 18 });
    addMech(out, sr, { rng, t0: 0.07, gain: 0.18, f: 1500, mass: 1.3, knock: 0.25, ring: 0.35, jitter: 0.012 });
    return out;
  },
  cloth: (sr, rng) => {
    const out = new Float32Array(Math.ceil(0.28 * sr));
    addCloth(out, sr, { rng, t0: 0, dur: 0.20, gain: 0.30, f0: 2000, f1: 700, grains: 16 });
    return out;
  },
  ads: (sr, rng) => {
    const out = new Float32Array(Math.ceil(0.26 * sr));
    addCloth(out, sr, { rng, t0: 0, dur: 0.14, gain: 0.22, f0: 2600, f1: 1000, grains: 10 });
    addMech(out, sr, { rng, t0: 0.055, gain: 0.10, f: 2800, mass: 1.0, ring: 0.3 });
    return out;
  },
  melee: (sr, rng) => {
    const out = new Float32Array(Math.ceil(0.5 * sr));
    addSweptNoise(out, sr, { rng, t0: 0, dur: 0.13, f0: 700, f1: 2600, q: 1.2, decay: 0.08, attack: 0.02, gain: 0.30 });
    addMech(out, sr, { rng, t0: 0.115, gain: 0.7, f: 900, mass: 1.6, knock: 0.9, ring: 0.5 });
    addNoiseBurst(out, sr, {
      rng, t0: 0.115, decay: 0.05, gain: 0.4, attack: 0.0004, curve: 1.2,
      filters: [{ type: 'bp', f: 700, q: 0.8 }, { type: 'lp', f: 3000, q: 0.7 }],
    });
    return out;
  },
};

/* ==================================================================== */
/* footsteps                                                             */
/* ==================================================================== */

/**
 * A footstep is three things stacked: the body impact (low, felt), the surface
 * texture (the part that identifies the material) and the operator's kit
 * (webbing, sling, magazines). Sprinting shifts weight into the first and
 * third; walking is nearly all texture.
 */
const FOOT_RECIPES = {
  concrete: (out, sr, rng, hard) => {
    addSweep(out, sr, { t0: 0, f0: 160 * rng.range(0.9, 1.12), f1: 68, decay: 0.042 * hard, sweep: 0.016, gain: 0.55 * hard, attack: 0.0012 });
    addNoiseBurst(out, sr, {
      rng, t0: 0.0006, decay: 0.020 * hard, attack: 0.0005, curve: 1.25, gain: 0.50,
      filters: [{ type: 'hp', f: 1100, q: 0.7 }, { type: 'peak', f: 3400, q: 1.1, g: 5 }, { type: 'lp', f: 11000, q: 0.6 }],
    });
    addSweptNoise(out, sr, { rng, t0: 0.006, dur: 0.09, f0: 3400, f1: 1500, q: 1.3, decay: 0.035, attack: 0.004, gain: 0.20 });
    addModes(out, sr, { t0: 0.001, gain: 0.10, modes: [{ f: 420, tau: 0.030, a: 1, bend: 0.96 }, { f: 930, tau: 0.018, a: 0.5 }] });
  },
  metal: (out, sr, rng, hard) => {
    addSweep(out, sr, { t0: 0, f0: 190, f1: 84, decay: 0.030 * hard, sweep: 0.012, gain: 0.40 * hard, attack: 0.001 });
    addNoiseBurst(out, sr, {
      rng, t0: 0, decay: 0.010, attack: 0.0003, curve: 1.4, gain: 0.45,
      filters: [{ type: 'hp', f: 1600, q: 0.7 }, { type: 'peak', f: 4200, q: 1.2, g: 6 }],
    });
    const f = rng.range(0.9, 1.1);
    addModes(out, sr, {
      t0: 0.0004, gain: 0.42 * hard,
      modes: [
        { f: 690 * f, tau: 0.30, a: 1.0, bend: 0.998, beat: 0.45, detune: 1.006 },
        { f: 1163 * f, tau: 0.22, a: 0.62, bend: 0.997, beat: 0.4 },
        { f: 2074 * f, tau: 0.16, a: 0.40, beat: 0.35 },
        { f: 3391 * f, tau: 0.11, a: 0.26 },
        { f: 5240 * f, tau: 0.07, a: 0.15 },
      ],
    });
  },
  wood: (out, sr, rng, hard) => {
    addSweep(out, sr, { t0: 0, f0: 128, f1: 58, decay: 0.052 * hard, sweep: 0.020, gain: 0.52 * hard, attack: 0.0014 });
    addNoiseBurst(out, sr, {
      rng, t0: 0.0005, decay: 0.016, attack: 0.0006, curve: 1.2, gain: 0.32,
      filters: [{ type: 'bp', f: 1800, q: 0.8 }, { type: 'lp', f: 6500, q: 0.7 }],
    });
    const d = rng.range(0.85, 1.2);
    addModes(out, sr, {
      t0: 0.0006, gain: 0.30,
      modes: [
        { f: 186 * d, tau: 0.085, a: 1.0, bend: 0.985 }, { f: 431 * d, tau: 0.060, a: 0.55 },
        { f: 878 * d, tau: 0.040, a: 0.32 }, { f: 1520 * d, tau: 0.024, a: 0.18 },
      ],
    });
    // Board creak: slow, narrow, wobbling — only sometimes.
    if (rng.chance(0.45)) {
      addSweptNoise(out, sr, {
        rng, t0: 0.02, dur: 0.22, f0: rng.range(600, 1100), f1: rng.range(900, 1700),
        q: 9, decay: 0.10, attack: 0.03, gain: 0.16 * hard,
      });
    }
  },
  sand: (out, sr, rng, hard) => {
    addSweep(out, sr, { t0: 0, f0: 96, f1: 52, decay: 0.030 * hard, sweep: 0.014, gain: 0.26 * hard, attack: 0.003 });
    addGrains(out, sr, {
      rng, t0: 0, dur: 0.115, count: Math.round(78 * hard), gain: 0.50, fLo: 1600, fHi: 9500,
      grainDecay: 0.0026, skew: 1.5, grainQ: 2.0, decayFall: 1.5,
    });
    addNoiseBurst(out, sr, {
      rng, t0: 0.001, decay: 0.045, attack: 0.004, curve: 0.9, gain: 0.20, color: 'pink',
      filters: [{ type: 'hp', f: 900, q: 0.7 }, { type: 'lp', f: 7000, q: 0.6 }],
    });
  },
  dirt: (out, sr, rng, hard) => {
    addSweep(out, sr, { t0: 0, f0: 118, f1: 54, decay: 0.045 * hard, sweep: 0.018, gain: 0.44 * hard, attack: 0.002 });
    addGrains(out, sr, {
      rng, t0: 0.001, dur: 0.085, count: Math.round(42 * hard), gain: 0.32, fLo: 900, fHi: 5200,
      grainDecay: 0.0032, skew: 1.8, grainQ: 1.6,
    });
    addNoiseBurst(out, sr, {
      rng, t0: 0.0008, decay: 0.030, attack: 0.0018, curve: 1.1, gain: 0.26, color: 'pink',
      filters: [{ type: 'lp', f: 2600, q: 0.7 }, { type: 'hp', f: 220, q: 0.7 }],
    });
  },
  glass: (out, sr, rng, hard) => {
    addSweep(out, sr, { t0: 0, f0: 150, f1: 70, decay: 0.030 * hard, sweep: 0.012, gain: 0.32 * hard, attack: 0.001 });
    addGrains(out, sr, {
      rng, t0: 0, dur: 0.20, count: 34, gain: 0.34, fLo: 3200, fHi: 12000,
      grainDecay: 0.010, skew: 2.4, grainQ: 6,
    });
    addModes(out, sr, {
      t0: 0.0005, gain: 0.22,
      modes: [{ f: 3120, tau: 0.10, a: 1, beat: 0.5 }, { f: 5210, tau: 0.07, a: 0.6 }, { f: 7830, tau: 0.045, a: 0.35 }],
    });
  },
  water: (out, sr, rng, hard) => {
    addSweptNoise(out, sr, {
      rng, t0: 0, dur: 0.16, f0: 900, f1: 5200, q: 0.9, decay: 0.055, attack: 0.0016, gain: 0.55 * hard,
    });
    addSweep(out, sr, { t0: 0.004, f0: 420, f1: 130, decay: 0.06, sweep: 0.035, gain: 0.20, attack: 0.004 });
    // Bubbles: tiny rising sine chirps.
    for (let i = 0; i < 7; i++) {
      addSweep(out, sr, {
        t0: 0.02 + rng.next() * 0.16, f0: rng.range(700, 1500), f1: rng.range(1400, 3000),
        decay: 0.014, sweep: 0.010, gain: 0.06, attack: 0.001,
      });
    }
    addGrains(out, sr, { rng, t0: 0.01, dur: 0.16, count: 26, gain: 0.16, fLo: 2200, fHi: 9000, grainDecay: 0.0025, skew: 1.2 });
  },
  fabric: (out, sr, rng, hard) => {
    addSweep(out, sr, { t0: 0, f0: 105, f1: 48, decay: 0.038 * hard, sweep: 0.02, gain: 0.30 * hard, attack: 0.003 });
    addCloth(out, sr, { rng, t0: 0, dur: 0.13, gain: 0.34, f0: 1500, f1: 600, grains: 16 });
  },
  flesh: (out, sr, rng, hard) => {
    addSweep(out, sr, { t0: 0, f0: 132, f1: 52, decay: 0.048, sweep: 0.02, gain: 0.42 * hard, attack: 0.0022 });
    addNoiseBurst(out, sr, {
      rng, t0: 0.0006, decay: 0.028, attack: 0.0009, curve: 1.1, gain: 0.30,
      filters: [{ type: 'bp', f: 620, q: 0.8 }, { type: 'lp', f: 2300, q: 0.7 }],
    });
  },
  foliage: (out, sr, rng, hard) => {
    addGrains(out, sr, {
      rng, t0: 0, dur: 0.22, count: Math.round(64 * hard), gain: 0.40, fLo: 2600, fHi: 11000,
      grainDecay: 0.0035, skew: 1.1, grainQ: 2.6,
    });
    addSweptNoise(out, sr, { rng, t0: 0, dur: 0.18, f0: 4200, f1: 2200, q: 1.0, decay: 0.075, attack: 0.006, gain: 0.22 });
    addSweep(out, sr, { t0: 0, f0: 110, f1: 55, decay: 0.030, sweep: 0.014, gain: 0.16 * hard, attack: 0.004 });
  },
};

/* ==================================================================== */
/* bullet impacts                                                        */
/* ==================================================================== */

const IMPACT_RECIPES = {
  concrete: (out, sr, rng) => {
    addNoiseBurst(out, sr, {
      rng, t0: 0, decay: 0.010, attack: 0.00018, curve: 1.5, gain: 0.95,
      filters: [{ type: 'hp', f: 1500, q: 0.7 }, { type: 'peak', f: 4600, q: 1.0, g: 7 }, { type: 'lp', f: 15000, q: 0.6 }],
    });
    addSweep(out, sr, { t0: 0, f0: 330, f1: 118, decay: 0.045, sweep: 0.018, gain: 0.42, attack: 0.0008 });
    addResonance(out, sr, {
      rng, t0: 0.0004, excite: 0.0008, gain: 0.28,
      modes: [{ f: 640, tau: 0.030, a: 1 }, { f: 1290, tau: 0.020, a: 0.6 }, { f: 2400, tau: 0.012, a: 0.35 }],
    });
    addGrains(out, sr, { rng, t0: 0.012, dur: 0.28, count: 26, gain: 0.20, fLo: 1800, fHi: 8000, grainDecay: 0.003, skew: 1.6 });
  },
  metal: (out, sr, rng) => {
    addNoiseBurst(out, sr, {
      rng, t0: 0, decay: 0.0055, attack: 0.00012, curve: 1.6, gain: 0.85,
      filters: [{ type: 'hp', f: 2400, q: 0.7 }, { type: 'peak', f: 6200, q: 1.1, g: 8 }],
    });
    const f = rng.range(0.88, 1.16);
    addModes(out, sr, {
      t0: 0.0002, gain: 0.55,
      modes: [
        { f: 1420 * f, tau: 0.26, a: 1.0, bend: 0.995, beat: 0.5, detune: 1.008 },
        { f: 2380 * f, tau: 0.19, a: 0.62, bend: 0.993, beat: 0.4 },
        { f: 3960 * f, tau: 0.13, a: 0.42, beat: 0.35 },
        { f: 6110 * f, tau: 0.085, a: 0.26 },
        { f: 8700 * f, tau: 0.05, a: 0.14 },
      ],
    });
    // Ricochet whine — the classic descending, warbling tail.
    if (rng.chance(0.55)) {
      addSweptNoise(out, sr, {
        rng, t0: 0.006, dur: 0.42, f0: rng.range(3200, 4600), f1: rng.range(700, 1200),
        q: 22, decay: 0.16, attack: 0.004, gain: 0.30, curve: 0.9,
      });
      addSweep(out, sr, {
        t0: 0.008, f0: rng.range(2800, 3800), f1: rng.range(800, 1300), decay: 0.15,
        sweep: 0.22, gain: 0.16, attack: 0.004, vib: 0.035, vibHz: rng.range(9, 17),
      });
    }
    addSweep(out, sr, { t0: 0, f0: 240, f1: 110, decay: 0.028, sweep: 0.012, gain: 0.22, attack: 0.0008 });
  },
  wood: (out, sr, rng) => {
    addNoiseBurst(out, sr, {
      rng, t0: 0, decay: 0.008, attack: 0.0002, curve: 1.4, gain: 0.60,
      filters: [{ type: 'bp', f: 2200, q: 0.7 }, { type: 'lp', f: 9000, q: 0.7 }],
    });
    addSweep(out, sr, { t0: 0, f0: 290, f1: 96, decay: 0.055, sweep: 0.022, gain: 0.48, attack: 0.0009 });
    const d = rng.range(0.85, 1.2);
    addModes(out, sr, {
      t0: 0.0004, gain: 0.34,
      modes: [
        { f: 205 * d, tau: 0.075, a: 1 }, { f: 470 * d, tau: 0.052, a: 0.55 },
        { f: 940 * d, tau: 0.034, a: 0.32 }, { f: 1780 * d, tau: 0.020, a: 0.18 },
      ],
    });
    // Splinters.
    addGrains(out, sr, { rng, t0: 0.008, dur: 0.20, count: 18, gain: 0.16, fLo: 2600, fHi: 9000, grainDecay: 0.004, skew: 1.8 });
  },
  glass: (out, sr, rng) => {
    addNoiseBurst(out, sr, {
      rng, t0: 0, decay: 0.004, attack: 0.0001, curve: 1.7, gain: 0.70,
      filters: [{ type: 'hp', f: 3000, q: 0.7 }, { type: 'peak', f: 8000, q: 1.0, g: 8 }],
    });
    addModes(out, sr, {
      t0: 0, gain: 0.40,
      modes: [
        { f: 3410, tau: 0.11, a: 1, beat: 0.5 }, { f: 4980, tau: 0.09, a: 0.7 },
        { f: 6720, tau: 0.07, a: 0.5 }, { f: 9100, tau: 0.05, a: 0.32 }, { f: 11800, tau: 0.03, a: 0.18 },
      ],
    });
    // Shards falling — sparse, bright, spread over half a second.
    addGrains(out, sr, { rng, t0: 0.02, dur: 0.55, count: 46, gain: 0.30, fLo: 3600, fHi: 13000, grainDecay: 0.012, skew: 1.1, grainQ: 7 });
  },
  sand: (out, sr, rng) => {
    addSweep(out, sr, { t0: 0, f0: 200, f1: 70, decay: 0.040, sweep: 0.020, gain: 0.34, attack: 0.0015 });
    addNoiseBurst(out, sr, {
      rng, t0: 0, decay: 0.028, attack: 0.0007, curve: 1.05, gain: 0.42, color: 'pink',
      filters: [{ type: 'hp', f: 400, q: 0.7 }, { type: 'lp', f: 5200, q: 0.7 }],
    });
    addGrains(out, sr, { rng, t0: 0.004, dur: 0.30, count: 52, gain: 0.26, fLo: 1400, fHi: 7000, grainDecay: 0.0026, skew: 1.7, decayFall: 1.6 });
  },
  dirt: (out, sr, rng) => {
    addSweep(out, sr, { t0: 0, f0: 240, f1: 78, decay: 0.048, sweep: 0.020, gain: 0.44, attack: 0.0012 });
    addNoiseBurst(out, sr, {
      rng, t0: 0, decay: 0.024, attack: 0.0006, curve: 1.15, gain: 0.40, color: 'pink',
      filters: [{ type: 'lp', f: 3400, q: 0.7 }, { type: 'hp', f: 260, q: 0.7 }],
    });
    addGrains(out, sr, { rng, t0: 0.006, dur: 0.26, count: 34, gain: 0.20, fLo: 1000, fHi: 5600, grainDecay: 0.003, skew: 1.8 });
  },
  water: (out, sr, rng) => {
    addSweptNoise(out, sr, { rng, t0: 0, dur: 0.22, f0: 1200, f1: 6500, q: 0.8, decay: 0.07, attack: 0.0008, gain: 0.70 });
    addSweep(out, sr, { t0: 0.002, f0: 620, f1: 140, decay: 0.075, sweep: 0.045, gain: 0.30, attack: 0.0022 });
    for (let i = 0; i < 12; i++) {
      addSweep(out, sr, {
        t0: 0.015 + rng.next() * 0.26, f0: rng.range(600, 1600), f1: rng.range(1500, 3600),
        decay: 0.016, sweep: 0.012, gain: 0.07, attack: 0.001,
      });
    }
    addGrains(out, sr, { rng, t0: 0.01, dur: 0.30, count: 30, gain: 0.14, fLo: 2000, fHi: 9000, grainDecay: 0.003, skew: 1.2 });
  },
  fabric: (out, sr, rng) => {
    addNoiseBurst(out, sr, {
      rng, t0: 0, decay: 0.012, attack: 0.0004, curve: 1.2, gain: 0.38,
      filters: [{ type: 'bp', f: 1400, q: 0.6 }, { type: 'lp', f: 4200, q: 0.7 }],
    });
    addSweep(out, sr, { t0: 0, f0: 180, f1: 74, decay: 0.030, sweep: 0.014, gain: 0.24, attack: 0.0016 });
    addCloth(out, sr, { rng, t0: 0.002, dur: 0.12, gain: 0.20 });
  },
  flesh: (out, sr, rng) => {
    // Wet, low, and short: the transient is muffled by tissue.
    addSweep(out, sr, { t0: 0, f0: 128, f1: 44, decay: 0.060, sweep: 0.024, gain: 0.62, attack: 0.0013 });
    addNoiseBurst(out, sr, {
      rng, t0: 0, decay: 0.020, attack: 0.0005, curve: 1.15, gain: 0.50,
      filters: [{ type: 'bp', f: 520, q: 0.75 }, { type: 'lp', f: 1900, q: 0.7 }],
    });
    addSweptNoise(out, sr, { rng, t0: 0.004, dur: 0.10, f0: 1800, f1: 480, q: 2.2, decay: 0.035, attack: 0.002, gain: 0.26 });
    if (rng.chance(0.35)) {
      addModes(out, sr, { t0: 0.001, gain: 0.14, modes: [{ f: 2400, tau: 0.010, a: 1 }, { f: 3900, tau: 0.006, a: 0.5 }] });
    }
  },
  foliage: (out, sr, rng) => {
    addGrains(out, sr, { rng, t0: 0, dur: 0.30, count: 70, gain: 0.42, fLo: 2800, fHi: 12000, grainDecay: 0.0032, skew: 1.05, grainQ: 2.8 });
    addSweptNoise(out, sr, { rng, t0: 0, dur: 0.24, f0: 5200, f1: 2400, q: 0.9, decay: 0.10, attack: 0.002, gain: 0.24 });
  },
};

/* ==================================================================== */
/* shell casings                                                         */
/* ==================================================================== */

/**
 * Brass on a hard floor: a burst of bounces with shrinking intervals, each a
 * dry tick plus an inharmonic metallic ring. The pitch stays constant while
 * the interval collapses — that pattern is the whole illusion.
 */
function makeShell(sr, kind, rng, scaleF = 1) {
  const out = new Float32Array(Math.ceil(0.85 * sr));
  const hard = kind === 'concrete' ? 1 : kind === 'metal' ? 1.25 : 0.4;
  const base = rng.range(2100, 2900) / scaleF;
  const bounces = kind === 'dirt' ? rng.int(1, 2) : rng.int(3, 5);
  let t = 0;
  let gap = rng.range(0.085, 0.135);
  let g = 1;
  for (let b = 0; b < bounces; b++) {
    addClick(out, sr, { rng, t0: t, gain: 0.42 * g * hard, f: base * rng.range(1.4, 2.2), q: 1.2, decay: 0.0009 });
    addModes(out, sr, {
      t0: t, gain: 0.36 * g * hard,
      modes: [
        { f: base * rng.range(0.98, 1.02), tau: 0.10 * hard, a: 1.0, beat: 0.55, detune: 1.013 },
        { f: base * 1.593, tau: 0.075 * hard, a: 0.66, beat: 0.4, detune: 1.009 },
        { f: base * 2.295, tau: 0.052 * hard, a: 0.44, beat: 0.35 },
        { f: base * 3.512, tau: 0.034 * hard, a: 0.26 },
        { f: base * 4.760, tau: 0.020 * hard, a: 0.15 },
      ],
    });
    if (kind === 'dirt') {
      addGrains(out, sr, { rng, t0: t, dur: 0.05, count: 8, gain: 0.10 * g, fLo: 900, fHi: 4200, grainDecay: 0.0025 });
    }
    t += gap;
    gap *= rng.range(0.5, 0.68);
    g *= rng.range(0.5, 0.68);
  }
  // Final spin-to-rest: a rapid ticking that accelerates then dies.
  if (kind !== 'dirt' && rng.chance(0.7)) {
    let rt = t;
    let rg = g * 0.8;
    let rgap = gap;
    for (let i = 0; i < 10 && rt < 0.75; i++) {
      addClick(out, sr, { rng, t0: rt, gain: 0.16 * rg * hard, f: base * rng.range(1.2, 1.9), q: 1.4, decay: 0.0007 });
      rt += rgap;
      rgap *= 0.86;
      rg *= 0.85;
    }
  }
  normalize(out, 0.7);
  return trim(out, 1e-4, sr);
}

/* ==================================================================== */
/* misc one-shots                                                        */
/* ==================================================================== */

function makeWhizby(sr, rng) {
  const out = new Float32Array(Math.ceil(0.28 * sr));
  // The bow shock: extremely short, extremely bright.
  addNoiseBurst(out, sr, {
    rng, t0: 0.0, decay: 0.0022, attack: 0.00008, curve: 1.8, gain: 0.85,
    filters: [{ type: 'hp', f: 2600, q: 0.7 }, { type: 'peak', f: rng.range(5200, 7400), q: 1.2, g: 8 }],
  });
  // The doppler-swept zip that follows it past your ear.
  addSweptNoise(out, sr, {
    rng, t0: 0.0012, dur: 0.13, f0: rng.range(3600, 5200), f1: rng.range(620, 1000),
    q: rng.range(5, 11), decay: 0.038, attack: 0.0006, gain: 0.62, curve: 1.1,
  });
  addSweptNoise(out, sr, {
    rng, t0: 0.004, dur: 0.16, f0: rng.range(1500, 2200), f1: rng.range(320, 520),
    q: 3.2, decay: 0.055, attack: 0.003, gain: 0.24, curve: 0.95,
  });
  addSweep(out, sr, {
    t0: 0.002, f0: rng.range(900, 1400), f1: rng.range(210, 330), decay: 0.05,
    sweep: 0.045, gain: 0.12, attack: 0.002,
  });
  dcBlock(out, sr);
  normalize(out, 0.85);
  return trim(out, 1e-4, sr);
}

function makeExplosion(sr, rng) {
  const out = new Float32Array(Math.ceil(3.0 * sr));
  // Detonation front.
  addNoiseBurst(out, sr, {
    rng, t0: 0, decay: 0.014, attack: 0.0002, curve: 1.5, gain: 0.9,
    filters: [{ type: 'hp', f: 900, q: 0.7 }, { type: 'peak', f: 2600, q: 0.9, g: 6 }],
  });
  // Fireball body.
  addNoiseBurst(out, sr, {
    rng, t0: 0.001, decay: 0.34, attack: 0.0035, curve: 0.78, gain: 1.0, color: 'pink',
    filters: [{ type: 'lp', f: 1400, q: 0.8 }, { type: 'hp', f: 55, q: 0.7 }],
  });
  addNoiseBurst(out, sr, {
    rng, t0: 0.004, decay: 0.85, attack: 0.02, curve: 0.7, gain: 0.55, color: 'brown',
    filters: [{ type: 'lp', f: 420, q: 0.8 }],
  });
  // Overpressure sub.
  addSweep(out, sr, { t0: 0.0008, f0: 145, f1: 26, decay: 0.75, sweep: 0.30, gain: 1.1, attack: 0.003 });
  addSweep(out, sr, { t0: 0.010, f0: 62, f1: 19, decay: 1.15, sweep: 0.55, gain: 0.55, attack: 0.02 });
  // Debris rain and secondary clatter.
  addGrains(out, sr, { rng, t0: 0.09, dur: 1.5, count: 90, gain: 0.22, fLo: 900, fHi: 7000, grainDecay: 0.005, skew: 1.05, decayFall: 2.2 });
  for (let i = 0; i < 9; i++) {
    addModes(out, sr, {
      t0: 0.15 + rng.next() * 1.3, gain: 0.055,
      modes: [{ f: rng.range(900, 3200), tau: rng.range(0.03, 0.11), a: 1, beat: 0.5 }, { f: rng.range(2600, 6200), tau: 0.03, a: 0.4 }],
    });
  }
  // Rumble tail — the city answering.
  addNoiseBurst(out, sr, {
    rng, t0: 0.05, decay: 1.5, attack: 0.12, curve: 0.85, gain: 0.30, color: 'brown',
    filters: [{ type: 'lp', f: 240, q: 0.7 }],
  });
  softClip(out, 2.4, 0.05);
  dcBlock(out, sr);
  normalize(out, 0.97);
  fadeEdges(out, sr, 0.05, 60);
  return out;
}

/** Far-off small-arms fire for the ambience layer: no crack, all tail. */
function makeDistantShot(sr, rng) {
  const out = new Float32Array(Math.ceil(1.1 * sr));
  addNoiseBurst(out, sr, {
    rng, t0: 0, decay: 0.030, attack: 0.0016, curve: 1.1, gain: 0.55,
    filters: [{ type: 'lp', f: rng.range(900, 1600), q: 0.8 }, { type: 'hp', f: 120, q: 0.7 }],
  });
  addSweep(out, sr, { t0: 0, f0: rng.range(150, 220), f1: 62, decay: 0.10, sweep: 0.04, gain: 0.40, attack: 0.003 });
  addNoiseBurst(out, sr, {
    rng, t0: 0.02, decay: rng.range(0.28, 0.55), attack: 0.03, curve: 0.8, gain: 0.34, color: 'pink',
    filters: [{ type: 'lp', f: rng.range(500, 900), q: 0.7 }, { type: 'hp', f: 90, q: 0.7 }],
  });
  dcBlock(out, sr);
  normalize(out, 0.6);
  return trim(out, 1e-4, sr);
}

function makeDistantBoom(sr, rng) {
  const out = new Float32Array(Math.ceil(2.6 * sr));
  addSweep(out, sr, { t0: 0, f0: rng.range(70, 105), f1: 21, decay: 0.9, sweep: 0.4, gain: 0.8, attack: 0.02 });
  addNoiseBurst(out, sr, {
    rng, t0: 0, decay: 1.2, attack: 0.06, curve: 0.75, gain: 0.5, color: 'brown',
    filters: [{ type: 'lp', f: rng.range(180, 320), q: 0.7 }],
  });
  addNoiseBurst(out, sr, {
    rng, t0: 0.10, decay: 1.0, attack: 0.25, curve: 0.8, gain: 0.22, color: 'brown',
    filters: [{ type: 'lp', f: 140, q: 0.7 }],
  });
  dcBlock(out, sr);
  normalize(out, 0.55);
  fadeEdges(out, sr, 20, 90);
  return out;
}

function makeBodyFall(sr, rng) {
  const out = new Float32Array(Math.ceil(1.1 * sr));
  addSweep(out, sr, { t0: 0, f0: 108, f1: 40, decay: 0.13, sweep: 0.05, gain: 0.85, attack: 0.0035 });
  addNoiseBurst(out, sr, {
    rng, t0: 0.001, decay: 0.055, attack: 0.0016, curve: 1.05, gain: 0.42,
    filters: [{ type: 'lp', f: 1600, q: 0.7 }, { type: 'hp', f: 120, q: 0.7 }],
  });
  addCloth(out, sr, { rng, t0: 0.005, dur: 0.32, gain: 0.35, f0: 1400, f1: 500, grains: 24 });
  // Secondary limb impacts.
  for (let i = 0; i < rng.int(2, 3); i++) {
    const t = 0.12 + rng.next() * 0.4;
    addSweep(out, sr, { t0: t, f0: rng.range(90, 150), f1: 44, decay: 0.06, sweep: 0.025, gain: 0.22, attack: 0.003 });
    addCloth(out, sr, { rng, t0: t, dur: 0.14, gain: 0.14 });
  }
  // Gear rattle.
  for (let i = 0; i < 4; i++) {
    addMech(out, sr, { rng, t0: 0.02 + rng.next() * 0.45, gain: 0.09, f: rng.range(1800, 3400), mass: 0.8, ring: 0.4 });
  }
  normalize(out, 0.8);
  return trim(out, 1e-4, sr);
}

function makeBreath(sr, rng, kind) {
  const inhale = kind.startsWith('in');
  const hard = kind.endsWith('Hard');
  const dur = inhale ? (hard ? 0.42 : 0.55) : (hard ? 0.50 : 0.68);
  const out = new Float32Array(Math.ceil((dur + 0.15) * sr));
  const f0 = inhale ? rng.range(320, 430) : rng.range(560, 720);
  const f1 = inhale ? rng.range(760, 980) : rng.range(240, 330);
  addSweptNoise(out, sr, {
    rng, t0: 0, dur, f0, f1, q: hard ? 1.5 : 1.0, mode: 'band',
    decay: dur * (hard ? 0.42 : 0.55), attack: hard ? 0.02 : 0.055,
    gain: hard ? 0.9 : 0.55, curve: hard ? 1.4 : 1.0, color: 'pink',
  });
  // Throat formants keep it human instead of "wind sample".
  const tmp = new Float32Array(out.length);
  fillNoise(tmp, rng, 'pink');
  applyFilters(tmp, sr, [
    { type: 'bp', f: inhale ? 640 : 480, q: 2.6 },
    { type: 'peak', f: inhale ? 1750 : 1250, q: 2.2, g: 8 },
    { type: 'lp', f: hard ? 5200 : 3400, q: 0.7 },
  ]);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const e = Math.max(0, Math.sin(Math.PI * Math.min(1, t / dur)));
    out[i] += tmp[i] * Math.pow(e, hard ? 1.4 : 2.0) * (hard ? 0.36 : 0.20);
  }
  if (hard && inhale && rng.chance(0.5)) {
    // A rasp on a hard inhale.
    addSweptNoise(out, sr, { rng, t0: 0.02, dur: 0.14, f0: 1400, f1: 2600, q: 6, decay: 0.06, attack: 0.01, gain: 0.18 });
  }
  dcBlock(out, sr);
  normalize(out, hard ? 0.8 : 0.5);
  fadeEdges(out, sr, 3, 24);
  return trim(out, 6e-5, sr);
}

function makeHeartbeat(sr, rng) {
  const out = new Float32Array(Math.ceil(0.75 * sr));
  const lub = (t, g, f) => {
    addSweep(out, sr, { t0: t, f0: f, f1: f * 0.52, decay: 0.075, sweep: 0.045, gain: g, attack: 0.012 });
    addNoiseBurst(out, sr, {
      rng, t0: t, decay: 0.055, attack: 0.010, curve: 1.1, gain: g * 0.30, color: 'brown',
      filters: [{ type: 'lp', f: 190, q: 0.8 }],
    });
  };
  lub(0, 1.0, rng.range(52, 60));
  lub(0.205, 0.62, rng.range(44, 50));
  dcBlock(out, sr);
  normalize(out, 0.85);
  fadeEdges(out, sr, 5, 40);
  return trim(out, 1e-4, sr);
}

/* ==================================================================== */
/* UI                                                                    */
/* ==================================================================== */

function tone(out, sr, t0, f, dur, gain, shape = 'sin', bend = 1) {
  addSweep(out, sr, { t0, f0: f, f1: f * bend, decay: dur, sweep: dur * 0.8, gain, attack: 0.0025, shape });
  return out;
}

const UI_RECIPES = {
  click: (sr, rng) => {
    const out = new Float32Array(Math.ceil(0.12 * sr));
    addClick(out, sr, { rng, t0: 0, gain: 0.30, f: 3200, q: 1.0, decay: 0.0008 });
    tone(out, sr, 0.001, 1180, 0.030, 0.32, 'sin', 0.94);
    tone(out, sr, 0.001, 2360, 0.018, 0.12);
    return out;
  },
  hover: (sr, rng) => {
    const out = new Float32Array(Math.ceil(0.10 * sr));
    tone(out, sr, 0, 880, 0.026, 0.16, 'sin', 1.04);
    addNoiseBurst(out, sr, { rng, t0: 0, decay: 0.006, gain: 0.06, attack: 0.0004, filters: [{ type: 'bp', f: 4200, q: 1.6 }] });
    return out;
  },
  confirm: (sr, rng) => {
    const out = new Float32Array(Math.ceil(0.36 * sr));
    tone(out, sr, 0, 660, 0.075, 0.26);
    tone(out, sr, 0.06, 990, 0.11, 0.24);
    tone(out, sr, 0.06, 1980, 0.06, 0.08);
    addClick(out, sr, { rng, t0: 0, gain: 0.16, f: 3000, decay: 0.0008 });
    return out;
  },
  back: (sr, rng) => {
    const out = new Float32Array(Math.ceil(0.28 * sr));
    tone(out, sr, 0, 780, 0.06, 0.22);
    tone(out, sr, 0.055, 520, 0.10, 0.20);
    addClick(out, sr, { rng, t0: 0, gain: 0.12, f: 2600, decay: 0.0008 });
    return out;
  },
  deny: (sr, rng) => {
    const out = new Float32Array(Math.ceil(0.24 * sr));
    addSweep(out, sr, { t0: 0, f0: 210, f1: 140, decay: 0.11, sweep: 0.08, gain: 0.28, shape: 'sq', attack: 0.004 });
    addNoiseBurst(out, sr, { rng, t0: 0, decay: 0.05, gain: 0.10, attack: 0.003, filters: [{ type: 'lp', f: 1400, q: 0.8 }] });
    return out;
  },
  hitmarker: (sr, rng) => {
    const out = new Float32Array(Math.ceil(0.10 * sr));
    addClick(out, sr, { rng, t0: 0, gain: 0.34, f: 5200, q: 1.4, decay: 0.0007 });
    tone(out, sr, 0.0008, 2450, 0.017, 0.30);
    tone(out, sr, 0.0008, 3670, 0.012, 0.16);
    return out;
  },
  hitmarkerHead: (sr, rng) => {
    const out = new Float32Array(Math.ceil(0.14 * sr));
    addClick(out, sr, { rng, t0: 0, gain: 0.40, f: 6100, q: 1.5, decay: 0.0007 });
    tone(out, sr, 0.0008, 3100, 0.022, 0.34);
    tone(out, sr, 0.012, 4650, 0.020, 0.22);
    return out;
  },
  hitmarkerKill: (sr, rng) => {
    const out = new Float32Array(Math.ceil(0.34 * sr));
    addClick(out, sr, { rng, t0: 0, gain: 0.42, f: 5400, q: 1.4, decay: 0.0008 });
    tone(out, sr, 0.0008, 2600, 0.030, 0.34);
    tone(out, sr, 0.030, 1740, 0.075, 0.26, 'sin', 0.98);
    tone(out, sr, 0.030, 3480, 0.045, 0.12);
    addNoiseBurst(out, sr, { rng, t0: 0.03, decay: 0.05, gain: 0.10, attack: 0.002, filters: [{ type: 'hp', f: 3000, q: 0.7 }] });
    return out;
  },
  ammoLow: (sr, rng) => {
    const out = new Float32Array(Math.ceil(0.14 * sr));
    addClick(out, sr, { rng, t0: 0, gain: 0.22, f: 2300, q: 1.2, decay: 0.0009 });
    tone(out, sr, 0.001, 1560, 0.028, 0.14, 'sin', 0.9);
    return out;
  },
  objective: (sr, rng) => {
    const out = new Float32Array(Math.ceil(0.95 * sr));
    tone(out, sr, 0.00, 523.25, 0.22, 0.16);
    tone(out, sr, 0.10, 659.25, 0.24, 0.15);
    tone(out, sr, 0.20, 783.99, 0.42, 0.16);
    tone(out, sr, 0.20, 1567.98, 0.28, 0.05);
    return out;
  },
  damage: (sr, rng) => {
    const out = new Float32Array(Math.ceil(0.45 * sr));
    addSweep(out, sr, { t0: 0, f0: 180, f1: 62, decay: 0.14, sweep: 0.06, gain: 0.55, attack: 0.002 });
    addNoiseBurst(out, sr, {
      rng, t0: 0, decay: 0.09, gain: 0.32, attack: 0.001, curve: 1.1, color: 'pink',
      filters: [{ type: 'lp', f: 1100, q: 0.8 }],
    });
    return out;
  },
  death: (sr, rng) => {
    const out = new Float32Array(Math.ceil(2.4 * sr));
    addSweep(out, sr, { t0: 0, f0: 140, f1: 34, decay: 0.9, sweep: 0.6, gain: 0.6, attack: 0.006 });
    addNoiseBurst(out, sr, {
      rng, t0: 0, decay: 1.1, gain: 0.30, attack: 0.02, curve: 0.8, color: 'brown',
      filters: [{ type: 'lp', f: 300, q: 0.7 }],
    });
    addSweep(out, sr, { t0: 0.02, f0: 220, f1: 108, decay: 1.6, sweep: 1.2, gain: 0.10, shape: 'tri', attack: 0.15 });
    fadeEdges(out, sr, 5, 200);
    return out;
  },
};

/* ==================================================================== */
/* ambience bed                                                          */
/* ==================================================================== */

/**
 * A seamless 14-second stereo bed. Two decorrelated wind layers whose cutoffs
 * are dragged around by slow independent LFOs, a distant traffic/city rumble,
 * and a whisper of HF air. The last 1.6 s is crossfaded into the head so the
 * loop point is inaudible.
 */
function makeAmbience(sr, seed) {
  const loopSec = 14;
  const xf = 1.6;
  const n = Math.ceil(loopSec * sr);
  const nx = Math.ceil(xf * sr);
  const rng = new Rng(seed);
  const chans = [];
  for (let c = 0; c < 2; c++) {
    const raw = new Float32Array(n + nx);
    const wind = new Float32Array(n + nx);
    fillNoise(wind, rng, 'pink');
    // Slow, wandering lowpass — the single most important trick for wind.
    let low = 0;
    let band = 0;
    const p1 = rng.next() * 6.283;
    const p2 = rng.next() * 6.283;
    // The modulators run at 0.2 Hz; evaluating them per sample is meaningless
    // precision, so update the filter coefficient once per 128-sample block.
    let F = 0.1;
    let amp = 1;
    for (let i = 0; i < raw.length; i++) {
      if ((i & 127) === 0) {
        const t = i / sr;
        const mod = 0.5 + 0.5 * Math.sin(t * 0.19 + p1) * Math.sin(t * 0.071 + p2);
        const f = 180 * Math.pow(9, mod);
        F = 2 * Math.sin(Math.PI * Math.min(f, sr * 0.22) / sr);
        amp = 0.35 + 0.65 * mod;
      }
      const x = wind[i];
      const high = x - low - 1.2 * band;
      band += F * high;
      low += F * band;
      raw[i] += (low * 0.9 + band * 0.12) * amp;
    }
    // Distant city floor.
    const rumble = new Float32Array(n + nx);
    fillNoise(rumble, rng, 'brown');
    applyFilters(rumble, sr, [{ type: 'lp', f: 150, q: 0.7 }, { type: 'hp', f: 32, q: 0.7 }]);
    for (let i = 0; i < raw.length; i++) {
      const t = i / sr;
      raw[i] += rumble[i] * 0.30 * (0.7 + 0.3 * Math.sin(t * 0.11 + c));
    }
    // Occasional far-off swells (traffic, wind gust round a corner).
    for (let k = 0; k < 5; k++) {
      const t0 = rng.next() * loopSec * 0.85;
      const dur = rng.range(1.4, 3.6);
      const i0 = Math.round(t0 * sr);
      const len = Math.min(raw.length - i0, Math.ceil(dur * sr));
      const swell = new Float32Array(len);
      fillNoise(swell, rng, 'pink');
      applyFilters(swell, sr, [
        { type: 'bp', f: rng.range(180, 620), q: 0.8 },
        { type: 'lp', f: rng.range(700, 1800), q: 0.7 },
      ]);
      const g = rng.range(0.05, 0.13);
      for (let i = 0; i < len; i++) {
        const u = i / len;
        raw[i0 + i] += swell[i] * Math.sin(Math.PI * u) * g;
      }
    }
    // Air.
    const air = new Float32Array(n + nx);
    fillNoise(air, rng, 'white');
    applyFilters(air, sr, [{ type: 'hp', f: 4200, q: 0.7 }, { type: 'lp', f: 11000, q: 0.7 }]);
    for (let i = 0; i < raw.length; i++) raw[i] += air[i] * 0.012;

    dcBlock(raw, sr);

    // Seamless wrap.
    const outc = new Float32Array(n);
    outc.set(raw.subarray(0, n));
    for (let i = 0; i < nx; i++) {
      const u = i / nx;
      outc[i] = raw[i] * u + raw[n + i] * (1 - u);
    }
    normalize(outc, 0.34);
    chans.push(outc);
  }
  return chans;
}

/* ==================================================================== */
/* the bank                                                              */
/* ==================================================================== */

export const SURFACES = [
  'concrete', 'metal', 'wood', 'sand', 'glass', 'water', 'dirt', 'fabric', 'flesh', 'foliage',
];

const ALIASES = {
  gravel: 'dirt', rock: 'concrete', stone: 'concrete', brick: 'concrete',
  asphalt: 'concrete', tile: 'concrete', plaster: 'concrete', grass: 'foliage',
  leaves: 'foliage', mud: 'dirt', snow: 'sand', body: 'flesh', enemy: 'flesh',
  cloth: 'fabric', plastic: 'wood', default: 'concrete',
};

export function canonicalSurface(s) {
  if (!s) return 'concrete';
  const k = String(s).toLowerCase();
  if (SURFACES.includes(k)) return k;
  return ALIASES[k] || 'concrete';
}

export class SoundBank {
  constructor(ctx) {
    this.ctx = ctx;
    this.sr = ctx.sampleRate;
    this.lowSr = Math.min(this.sr, 32000);
    this.map = new Map();     // name -> AudioBuffer[]
    this.rng = new Rng(0xb1ac04);
    this.built = false;
  }

  add(name, buffers) {
    this.map.set(name, Array.isArray(buffers) ? buffers : [buffers]);
  }

  has(name) { return this.map.has(name); }

  /** Random variant, or null. Never throws on an unknown name. */
  get(name, rng) {
    const list = this.map.get(name);
    if (!list || !list.length) return null;
    if (list.length === 1) return list[0];
    const r = rng || this.rng;
    return list[Math.min(list.length - 1, Math.floor(r.next() * list.length))];
  }

  names() { return [...this.map.keys()]; }

  /* ------------------------------------------------------------------ */
  /* build                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Phases, in the order they are needed. The first three are on the boot
   * critical path; the rest are rendered after the game is already interactive,
   * one phase per macrotask, so a slow machine gets a responsive menu instead
   * of a longer loading bar. Every lookup is null-safe, so a sound that has not
   * been rendered yet is simply silent for the few hundred milliseconds it takes.
   */
  _phases() {
    return [
      ['weapons', () => this._buildShots()],
      ['mech', () => this._buildMech()],
      ['ui', () => this._buildUI()],
      ['footsteps', () => this._buildFootsteps()],
      ['impacts', () => this._buildImpacts()],
      ['debris', () => this._buildDebris()],
      ['body', () => this._buildBody()],
      ['ambience', () => this._buildAmbience()],
    ];
  }

  /** Render everything synchronously (used by tools and tests). */
  build() {
    for (const [, fn] of this._phases()) fn();
    this.built = true;
    return this;
  }

  /**
   * Render the critical phases now and the rest across subsequent macrotasks.
   * Resolves as soon as the critical set is done; `restPromise` completes later.
   */
  buildProgressive(critical = 3) {
    const phases = this._phases();
    for (let i = 0; i < Math.min(critical, phases.length); i++) phases[i][1]();
    this.critical = true;
    const rest = phases.slice(critical);
    this.restPromise = (async () => {
      for (const [, fn] of rest) {
        await new Promise((r) => setTimeout(r, 0));
        try { fn(); } catch (err) { console.warn('[audio] bank phase failed', err); }
      }
      this.built = true;
    })();
    return this;
  }

  /* ------------------------------------------------------------------ */

  _buildShots() {
    const ctx = this.ctx;
    const sr = this.sr;
    const R = (seed) => new Rng(seed);
    let seed = 1000;
    for (const id of Object.keys(WEAPON_VOICES)) {
      const v = WEAPON_VOICES[id];
      const variants = [];
      for (let i = 0; i < 4; i++) {
        const data = makeShot(sr, v, R(seed++));
        variants.push(toBuffer(ctx, [data], sr));
      }
      this.add(`weapon:${id}:shot`, variants);
    }
  }

  _buildMech() {
    const ctx = this.ctx;
    const lo = this.lowSr;
    const R = (seed) => new Rng(seed);
    let seed = 2000;
    for (const [key, fn] of Object.entries(MECH_RECIPES)) {
      const variants = [];
      for (let i = 0; i < 3; i++) {
        const rng = R(seed++);
        const data = fn(lo, rng);
        dcBlock(data, lo);
        normalize(data, 0.72);
        fadeEdges(data, lo, 0.5, 12);
        variants.push(toBuffer(ctx, [trim(data, 1e-4, lo)], lo));
      }
      this.add(`mech:${key}`, variants);
    }
  }

  _buildUI() {
    const ctx = this.ctx;
    const lo = this.lowSr;
    let seed = 3000;
    for (const [key, fn] of Object.entries(UI_RECIPES)) {
      const rng = new Rng(seed++);
      const data = fn(lo, rng);
      dcBlock(data, lo);
      normalize(data, 0.62);
      fadeEdges(data, lo, 0.5, 16);
      this.add(`ui:${key}`, [toBuffer(ctx, [trim(data, 6e-5, lo)], lo)]);
    }
  }

  _buildFootsteps() {
    const ctx = this.ctx;
    const lo = this.lowSr;
    const R = (seed) => new Rng(seed);
    let seed = 4000;
    for (const surf of SURFACES) {
      const fn = FOOT_RECIPES[surf] || FOOT_RECIPES.concrete;
      for (const gait of ['walk', 'run']) {
        const hard = gait === 'run' ? 1.28 : 0.82;
        const variants = [];
        for (let i = 0; i < 4; i++) {
          const rng = R(seed++);
          const data = new Float32Array(Math.ceil(0.46 * lo));
          fn(data, lo, rng, hard);
          // Kit foley on every step, louder when running.
          addCloth(data, lo, { rng, t0: rng.range(0, 0.02), dur: 0.13, gain: 0.10 * hard, grains: 8 });
          if (gait === 'run' && rng.chance(0.6)) {
            addMech(data, lo, { rng, t0: rng.range(0.01, 0.06), gain: 0.035, f: rng.range(1800, 3200), mass: 0.9, ring: 0.4 });
          }
          dcBlock(data, lo);
          normalize(data, gait === 'run' ? 0.78 : 0.58);
          fadeEdges(data, lo, 0.4, 14);
          variants.push(toBuffer(ctx, [trim(data, 8e-5, lo)], lo));
        }
        this.add(`foot:${surf}:${gait}`, variants);
      }
    }
  }

  _buildImpacts() {
    const ctx = this.ctx;
    const lo = this.lowSr;
    const R = (seed) => new Rng(seed);
    let seed = 5000;
    for (const surf of SURFACES) {
      const fn = IMPACT_RECIPES[surf] || IMPACT_RECIPES.concrete;
      const variants = [];
      for (let i = 0; i < 4; i++) {
        const rng = R(seed++);
        const data = new Float32Array(Math.ceil(0.7 * lo));
        fn(data, lo, rng);
        softClip(data, 1.25, 0.03);
        dcBlock(data, lo);
        normalize(data, 0.88);
        fadeEdges(data, lo, 0.25, 12);
        variants.push(toBuffer(ctx, [trim(data, 8e-5, lo)], lo));
      }
      this.add(`impact:${surf}`, variants);
    }
  }

  _buildDebris() {
    const ctx = this.ctx;
    const sr = this.sr;
    const lo = this.lowSr;
    const R = (seed) => new Rng(seed);
    let seed = 6000;
    for (const kind of ['concrete', 'metal', 'dirt']) {
      const variants = [];
      for (let i = 0; i < 6; i++) {
        const rng = R(seed++);
        const data = makeShell(lo, kind, rng, rng.range(0.9, 1.15));
        variants.push(toBuffer(ctx, [data], lo));
      }
      this.add(`shell:${kind}`, variants);
    }

    // --- whizby / explosion / distant -------------------------------------
    {
      const v = [];
      for (let i = 0; i < 6; i++) v.push(toBuffer(ctx, [makeWhizby(sr, R(seed++))], sr));
      this.add('whizby', v);
    }
    {
      const v = [];
      for (let i = 0; i < 3; i++) v.push(toBuffer(ctx, [makeExplosion(sr, R(seed++))], sr));
      this.add('explosion', v);
    }
    {
      const v = [];
      for (let i = 0; i < 5; i++) v.push(toBuffer(ctx, [makeDistantShot(lo, R(seed++))], lo));
      this.add('distant:shot', v);
    }
    {
      const v = [];
      for (let i = 0; i < 3; i++) v.push(toBuffer(ctx, [makeDistantBoom(lo, R(seed++))], lo));
      this.add('distant:boom', v);
    }
    {
      const v = [];
      for (let i = 0; i < 3; i++) v.push(toBuffer(ctx, [makeBodyFall(lo, R(seed++))], lo));
      this.add('body:fall', v);
    }
  }

  _buildBody() {
    const ctx = this.ctx;
    const lo = this.lowSr;
    const R = (seed) => new Rng(seed);
    let seed = 7000;
    for (const kind of ['in', 'out', 'inHard', 'outHard']) {
      const v = [];
      for (let i = 0; i < 3; i++) v.push(toBuffer(ctx, [makeBreath(lo, R(seed++), kind)], lo));
      this.add(`breath:${kind}`, v);
    }
    {
      const v = [];
      for (let i = 0; i < 3; i++) v.push(toBuffer(ctx, [makeHeartbeat(lo, R(seed++))], lo));
      this.add('heart', v);
    }
  }

  _buildAmbience() {
    const ambSr = Math.min(this.sr, 24000);
    const chans = makeAmbience(ambSr, 0x51ee7);
    this.add('amb:bed', [toBuffer(this.ctx, chans, ambSr)]);
  }
}
