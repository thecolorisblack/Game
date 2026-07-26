/**
 * OPERATION BLACKOUT — procedural impulse responses.
 *
 * Every space in the game is described by a handful of numbers and turned into a
 * stereo impulse response at boot: a sparse pattern of discrete early
 * reflections (the geometry you can actually localise) followed by a diffuse
 * exponentially-decaying noise field whose decay time is specified *per octave
 * band*, because a stairwell and a street differ far more in how fast their
 * highs die than in overall RT60.
 *
 * The second job of this file is the gunshot TAIL. In real recordings the dry
 * report is a few tens of milliseconds and everything else — the thing that
 * tells you whether you are in an alley or a car park — is the environment
 * answering back. We bake that answer offline: the dry shot is convolved with
 * the space IR through an OfflineAudioContext once at boot, so at fire time it
 * costs a single buffer source instead of a live convolution per shot.
 */

import {
  Rng, Biquad, fillNoise, toBuffer, fadeEdges, scale,
} from './Synth.js';

/* ==================================================================== */
/* space definitions                                                     */
/* ==================================================================== */

/**
 * bands: [{ f, decay, gain }] — decay is the -60 dB time for that band.
 * early: [{ t, g, pan }]      — discrete reflections, seconds / linear / -1..1
 */
export const SPACES = {
  /** A room: short, dense, bright-ish but damped above 5k by soft contents. */
  interior: {
    length: 1.05,
    predelay: 0.0032,
    diffusion: 0.92,
    buildup: 0.014,
    bands: [
      { f: 90, decay: 0.52, gain: 0.85 },
      { f: 220, decay: 0.48, gain: 1.0 },
      { f: 550, decay: 0.42, gain: 0.95 },
      { f: 1400, decay: 0.34, gain: 0.78 },
      { f: 3600, decay: 0.24, gain: 0.5 },
      { f: 8000, decay: 0.14, gain: 0.24 },
    ],
    early: [
      { t: 0.0041, g: 0.62, pan: -0.55 }, { t: 0.0068, g: 0.55, pan: 0.7 },
      { t: 0.0097, g: 0.48, pan: 0.2 }, { t: 0.0134, g: 0.42, pan: -0.85 },
      { t: 0.0171, g: 0.34, pan: 0.45 }, { t: 0.0218, g: 0.30, pan: -0.3 },
      { t: 0.0264, g: 0.25, pan: 0.9 }, { t: 0.0331, g: 0.20, pan: -0.15 },
    ],
    modes: [{ f: 47, tau: 0.20, a: 0.16 }, { f: 71, tau: 0.16, a: 0.11 }],
    seed: 1201,
  },

  /** Concrete stairwell: long, flutter-heavy, ugly low modes. */
  stairwell: {
    length: 2.35,
    predelay: 0.0048,
    diffusion: 0.7,
    buildup: 0.030,
    bands: [
      { f: 90, decay: 1.95, gain: 1.15 },
      { f: 220, decay: 1.85, gain: 1.05 },
      { f: 550, decay: 1.55, gain: 1.0 },
      { f: 1400, decay: 1.20, gain: 0.9 },
      { f: 3600, decay: 0.80, gain: 0.66 },
      { f: 8000, decay: 0.42, gain: 0.32 },
    ],
    // Flutter: a near-periodic reflection train is the signature of parallel walls.
    early: [
      { t: 0.0062, g: 0.70, pan: -0.4 }, { t: 0.0121, g: 0.64, pan: 0.5 },
      { t: 0.0186, g: 0.58, pan: -0.6 }, { t: 0.0248, g: 0.52, pan: 0.62 },
      { t: 0.0312, g: 0.46, pan: -0.35 }, { t: 0.0375, g: 0.41, pan: 0.28 },
      { t: 0.0441, g: 0.36, pan: -0.7 }, { t: 0.0503, g: 0.31, pan: 0.75 },
      { t: 0.0569, g: 0.27, pan: -0.2 }, { t: 0.0631, g: 0.23, pan: 0.15 },
    ],
    modes: [
      { f: 38, tau: 0.85, a: 0.24 }, { f: 63, tau: 0.62, a: 0.18 },
      { f: 148, tau: 0.44, a: 0.12 },
    ],
    seed: 4409,
  },

  /** Open street between buildings: big predelay, hard slap-backs, HF loss. */
  street: {
    length: 1.9,
    predelay: 0.0135,
    diffusion: 0.55,
    buildup: 0.055,
    bands: [
      { f: 90, decay: 1.45, gain: 0.9 },
      { f: 220, decay: 1.30, gain: 0.95 },
      { f: 550, decay: 1.05, gain: 0.85 },
      { f: 1400, decay: 0.78, gain: 0.62 },
      { f: 3600, decay: 0.48, gain: 0.34 },
      { f: 8000, decay: 0.22, gain: 0.12 },
    ],
    early: [
      { t: 0.0192, g: 0.52, pan: -0.8 }, { t: 0.0344, g: 0.46, pan: 0.85 },
      { t: 0.0521, g: 0.40, pan: -0.45 }, { t: 0.0715, g: 0.34, pan: 0.55 },
      { t: 0.0968, g: 0.28, pan: -0.9 }, { t: 0.1244, g: 0.22, pan: 0.35 },
      { t: 0.1631, g: 0.17, pan: -0.25 }, { t: 0.2118, g: 0.12, pan: 0.7 },
    ],
    modes: [],
    seed: 7717,
  },

  /**
   * The far outdoor tail — not a room at all, but the whole city answering a
   * rifle shot. Very long predelay, no discernible early structure, brutal
   * lowpass, and a slow build rather than an attack.
   */
  distant: {
    length: 2.6,
    predelay: 0.052,
    diffusion: 1.0,
    buildup: 0.16,
    bands: [
      { f: 70, decay: 2.30, gain: 1.2 },
      { f: 180, decay: 2.05, gain: 1.05 },
      { f: 420, decay: 1.65, gain: 0.72 },
      { f: 900, decay: 1.15, gain: 0.38 },
      { f: 2000, decay: 0.62, gain: 0.13 },
      { f: 4500, decay: 0.28, gain: 0.03 },
    ],
    early: [
      { t: 0.061, g: 0.22, pan: -0.7 }, { t: 0.108, g: 0.19, pan: 0.6 },
      { t: 0.174, g: 0.15, pan: 0.15 }, { t: 0.263, g: 0.11, pan: -0.4 },
      { t: 0.381, g: 0.08, pan: 0.8 },
    ],
    modes: [],
    seed: 3313,
  },
};

export const SPACE_IDS = Object.keys(SPACES);

/* ==================================================================== */
/* IR synthesis                                                          */
/* ==================================================================== */

/**
 * Build one stereo impulse response.
 *
 * The diffuse field is generated per band: velvet noise (sparse ±1 impulses —
 * no low-frequency wander, perfectly flat) is bandpassed and multiplied by that
 * band's exponential decay, then all bands are summed. Left and right use
 * independent noise so the tail is genuinely decorrelated, which is what makes
 * a convolution reverb feel like a space rather than a delay.
 */
export function buildIR(ctx, def, opts = {}) {
  const sr = opts.sampleRate || ctx.sampleRate;
  const len = Math.ceil(def.length * sr);
  const rng = new Rng(def.seed ?? 99);
  const chans = [new Float32Array(len), new Float32Array(len)];
  const pre = Math.round((def.predelay ?? 0.003) * sr);
  const buildup = Math.max(0.001, def.buildup ?? 0.02);
  const bq = new Biquad();

  for (let c = 0; c < 2; c++) {
    const out = chans[c];
    const noise = new Float32Array(len);
    const band = new Float32Array(len);

    for (const b of def.bands) {
      fillNoise(noise, rng, 'velvet');
      // Two cascaded bandpasses per band: steeper skirts, less inter-band mush.
      band.set(noise);
      bq.set('bp', sr, b.f, 1.15).reset().run(band);
      bq.set('bp', sr, b.f, 1.15).reset().run(band);

      const tau = Math.max(0.02, b.decay) / 6.9078;  // -60 dB => e^(-t/tau)
      const g = b.gain;
      // Both envelopes as multiplicative recurrences: an IR is a million
      // samples per band and `Math.exp` per sample is pure waste.
      const dK = Math.exp(-1 / (tau * sr));
      const gK = Math.exp(-1 / (buildup * sr));
      let dE = 1;
      let gE = 1;
      const n = len - pre;
      for (let i = 0; i < n; i++) {
        // Density build-up: real rooms take a moment to become diffuse.
        out[i + pre] += band[i] * dE * (1 - gE) * g;
        dE *= dK;
        gE *= gK;
      }
    }

    // Discrete early reflections, panned and slightly lowpassed per bounce.
    for (const e of def.early) {
      const idx = pre + Math.round(e.t * sr);
      if (idx >= len - 8) continue;
      const w = c === 0 ? Math.sqrt(Math.max(0, 0.5 - e.pan * 0.5)) : Math.sqrt(Math.max(0, 0.5 + e.pan * 0.5));
      // A reflection is not a dirac: give it a couple of samples of smear.
      const smear = 3 + Math.floor(rng.next() * 6);
      for (let k = 0; k < smear; k++) {
        out[idx + k] += e.g * w * (1 - k / smear) * (rng.next() * 0.5 + 0.75) * (k === 0 ? 1 : rng.bi(1));
      }
    }

    // Room modes: slow decaying low sinusoids under the diffuse field.
    for (const m of def.modes || []) {
      const w = (Math.PI * 2 * m.f) / sr;
      const r = Math.exp(-1 / (m.tau * sr));
      const c = 2 * r * Math.cos(w);
      const rr = r * r;
      let y1 = 0;
      let y0 = Math.sin(w + rng.next() * 0.5);
      for (let i = 0; i < len; i++) {
        out[i] += y0 * m.a;
        const y = c * y0 - rr * y1;
        y1 = y0;
        y0 = y;
      }
    }

    // Diffusion control: blending toward a smoothed copy thins the density,
    // which is how an open street differs from a reverb chamber.
    if ((def.diffusion ?? 1) < 0.99) {
      const d = def.diffusion ?? 1;
      let s = 0;
      for (let i = 0; i < len; i++) {
        s += (out[i] - s) * 0.35;
        out[i] = out[i] * d + s * (1 - d) * 1.6;
      }
    }

    fadeEdges(out, sr, 0.05, 40);
  }

  // Match perceived loudness across spaces by RMS, not peak: peak-normalising a
  // reverb makes short IRs quiet and long ones deafening.
  let rms = 0;
  for (let c = 0; c < 2; c++) {
    const out = chans[c];
    for (let i = 0; i < out.length; i++) rms += out[i] * out[i];
  }
  rms = Math.sqrt(rms / (len * 2)) || 1e-6;
  const target = (opts.rms ?? 0.028) / rms;
  scale(chans[0], target);
  scale(chans[1], target);

  return toBuffer(ctx, chans, sr);
}

/** Build every space's IR. Returns `{interior, stairwell, street, distant}`. */
export function buildAllIRs(ctx, opts = {}) {
  const out = {};
  for (const id of SPACE_IDS) out[id] = buildIR(ctx, SPACES[id], opts);
  return out;
}

/* ==================================================================== */
/* baked gunshot tails                                                   */
/* ==================================================================== */

/**
 * Render `dry` through a space and return the *wet only* result: the crack is
 * highpassed out of the tail so it can be layered under the dry shot without
 * doubling the transient.
 *
 * Uses OfflineAudioContext; returns null (never throws) if that is unavailable
 * so the caller can fall back to a synthesised tail.
 */
export async function bakeTail(dry, ir, opts = {}) {
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OAC) return null;
  const sr = opts.sampleRate || 32000;
  const seconds = opts.seconds || 2.2;
  let octx;
  try {
    octx = new OAC(2, Math.ceil(sr * seconds), sr);
  } catch {
    return null;
  }

  try {
    const src = octx.createBufferSource();
    src.buffer = dry;

    // Distance colouring applied *before* the convolution: air eats the highs
    // on the way out, so the room is excited by an already-dull signal.
    const pre = octx.createBiquadFilter();
    pre.type = 'lowpass';
    pre.frequency.value = opts.preLowpass ?? 9000;
    pre.Q.value = 0.6;

    const hp = octx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = opts.preHighpass ?? 60;

    const conv = octx.createConvolver();
    conv.normalize = false;
    conv.buffer = ir;

    // Strip the direct transient out of the wet path.
    const post = octx.createBiquadFilter();
    post.type = 'highpass';
    post.frequency.value = opts.postHighpass ?? 90;

    const shelf = octx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 2600;
    shelf.gain.value = opts.brightness ?? -4;

    const g = octx.createGain();
    g.gain.value = opts.gain ?? 1;

    const delay = octx.createDelay(1.0);
    delay.delayTime.value = Math.min(0.95, opts.predelay ?? 0);

    src.connect(hp);
    hp.connect(pre);
    pre.connect(delay);
    delay.connect(conv);
    conv.connect(post);
    post.connect(shelf);
    shelf.connect(g);
    g.connect(octx.destination);
    src.start(0);

    const rendered = await octx.startRendering();
    // Convolution sums energy: the raw render peaks 30-80x above unity. Bring
    // every space to the same perceived level so the play-time gains below mean
    // the same thing whichever room the listener is standing in.
    normalizeRendered(rendered, opts.targetRms ?? 0.09, opts.targetPeak ?? 0.95);
    return rendered;
  } catch {
    return null;
  }
}

/** In-place loudness match: RMS-first, with a peak ceiling as the backstop. */
export function normalizeRendered(buffer, targetRms = 0.09, targetPeak = 0.95) {
  let peak = 1e-9;
  let sum = 0;
  let n = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sum += v * v;
      n++;
    }
  }
  const rms = Math.sqrt(sum / Math.max(1, n)) || 1e-9;
  const k = Math.min(targetRms / rms, targetPeak / peak);
  if (!Number.isFinite(k) || k === 1) return buffer;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= k;
  }
  return buffer;
}

/**
 * Fallback tail when OfflineAudioContext is unavailable or failed: a purely
 * synthetic answer built from the same band-decay description. Less accurate
 * than convolution but far better than silence.
 */
export function synthTail(ctx, def, opts = {}) {
  const sr = opts.sampleRate || 32000;
  const len = Math.ceil((opts.seconds || def.length) * sr);
  const rng = new Rng((def.seed ?? 1) * 7 + 13);
  const chans = [new Float32Array(len), new Float32Array(len)];
  const bq = new Biquad();
  const pre = Math.round((def.predelay ?? 0.01) * sr);
  const buildup = Math.max(0.004, def.buildup ?? 0.02);

  for (let c = 0; c < 2; c++) {
    const out = chans[c];
    const noise = new Float32Array(len);
    const band = new Float32Array(len);
    for (const b of def.bands) {
      fillNoise(noise, rng, 'white');
      band.set(noise);
      bq.set('bp', sr, b.f, 1.0).reset().run(band);
      const tau = Math.max(0.02, b.decay) / 6.9078;
      const dK = Math.exp(-1 / (tau * sr));
      const gK = Math.exp(-1 / (buildup * sr));
      let dE = 1;
      let gE = 1;
      const n = len - pre;
      for (let i = 0; i < n; i++) {
        out[i + pre] += band[i] * dE * (1 - gE) * b.gain;
        dE *= dK;
        gE *= gK;
      }
    }
    fadeEdges(out, sr, 1, 60);
  }
  // Match the loudness convention of the baked tails so the two are
  // interchangeable at play time.
  const buf = toBuffer(ctx, chans, sr);
  normalizeRendered(buf, opts.targetRms ?? 0.09, opts.targetPeak ?? 0.95);
  return buf;
}
