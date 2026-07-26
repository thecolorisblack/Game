/**
 * OPERATION BLACKOUT — offline DSP toolkit.
 *
 * Everything the game plays is generated here, sample by sample, at boot. There
 * are no audio files anywhere in this project; a "gunshot" is a stack of noise
 * bursts, resonant filter banks and decaying sinusoids summed into a
 * Float32Array and handed to `ctx.createBuffer`.
 *
 * The primitives below are deliberately low level and allocation-happy — they
 * only ever run during `AudioEngine.init()`, never on the frame path.
 *
 *   Rng          deterministic mulberry32, so a "variant 3" always sounds the same
 *   Biquad       RBJ cookbook filters, transposed direct form II
 *   addNoiseBurst  filtered noise + attack/decay envelope     (cracks, air, scuff)
 *   addResonance   noise excitation through a parallel bank   (barrel body, boxes)
 *   addModes       exponentially decaying sinusoids           (metal, glass, wood)
 *   addSweep       pitch-swept oscillator                     (thump, ricochet whine)
 *   addGrains      granular texture                           (gravel, sand, debris)
 *
 * Convention: every `add*` mixes *into* an existing Float32Array so a single
 * recipe can layer a dozen elements without intermediate buffers.
 */

const TAU = Math.PI * 2;

/* ==================================================================== */
/* random                                                                */
/* ==================================================================== */

/** mulberry32 — small, fast, and identical across runs so builds are stable. */
export class Rng {
  constructor(seed = 1) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }

  next() {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(a, b) { return a + (b - a) * this.next(); }
  bi(scale = 1) { return (this.next() * 2 - 1) * scale; }
  int(a, b) { return a + Math.floor(this.next() * (b - a + 1)); }
  pick(arr) { return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))]; }
  chance(p) { return this.next() < p; }

  /** Box–Muller; used wherever "human" variation reads better than uniform. */
  gauss(sigma = 1) {
    let u = 0;
    let v = 0;
    while (u <= 1e-7) u = this.next();
    while (v <= 1e-7) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v) * sigma;
  }
}

/* ==================================================================== */
/* filters                                                               */
/* ==================================================================== */

export class Biquad {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.z1 = 0; this.z2 = 0;
  }

  reset() { this.z1 = 0; this.z2 = 0; return this; }

  set(type, sr, freq, Q = 0.7071, gainDb = 0) {
    const f = Math.min(Math.max(freq, 5), sr * 0.4999);
    const w0 = TAU * f / sr;
    const cs = Math.cos(w0);
    const sn = Math.sin(w0);
    const q = Math.max(0.05, Q);
    const alpha = sn / (2 * q);
    const A = Math.pow(10, gainDb / 40);
    let b0 = 1; let b1 = 0; let b2 = 0; let a0 = 1; let a1 = 0; let a2 = 0;

    switch (type) {
      case 'lp':
        b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0;
        a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
        break;
      case 'hp':
        b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0;
        a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
        break;
      case 'bp': // constant 0 dB peak gain
        b0 = alpha; b1 = 0; b2 = -alpha;
        a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
        break;
      case 'bpq': // constant skirt gain — rings harder, used for resonators
        b0 = sn / 2; b1 = 0; b2 = -sn / 2;
        a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
        break;
      case 'notch':
        b0 = 1; b1 = -2 * cs; b2 = 1;
        a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
        break;
      case 'peak':
        b0 = 1 + alpha * A; b1 = -2 * cs; b2 = 1 - alpha * A;
        a0 = 1 + alpha / A; a1 = -2 * cs; a2 = 1 - alpha / A;
        break;
      case 'ls': {
        const s2 = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) - (A - 1) * cs + s2);
        b1 = 2 * A * ((A - 1) - (A + 1) * cs);
        b2 = A * ((A + 1) - (A - 1) * cs - s2);
        a0 = (A + 1) + (A - 1) * cs + s2;
        a1 = -2 * ((A - 1) + (A + 1) * cs);
        a2 = (A + 1) + (A - 1) * cs - s2;
        break;
      }
      case 'hs': {
        const s2 = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) + (A - 1) * cs + s2);
        b1 = -2 * A * ((A - 1) + (A + 1) * cs);
        b2 = A * ((A + 1) + (A - 1) * cs - s2);
        a0 = (A + 1) - (A - 1) * cs + s2;
        a1 = 2 * ((A - 1) - (A + 1) * cs);
        a2 = (A + 1) - (A - 1) * cs - s2;
        break;
      }
      default:
        break;
    }

    const inv = 1 / a0;
    this.b0 = b0 * inv; this.b1 = b1 * inv; this.b2 = b2 * inv;
    this.a1 = a1 * inv; this.a2 = a2 * inv;
    return this;
  }

  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  run(buf, from = 0, to = buf.length) {
    for (let i = from; i < to; i++) buf[i] = this.process(buf[i]);
    return buf;
  }
}

/**
 * Apply a descriptor chain in place.
 * `[{type:'hp', f:600, q:0.8}, {type:'peak', f:3200, q:1.1, g:6}]`
 */
export function applyFilters(buf, sr, list, from = 0, to = buf.length) {
  if (!list) return buf;
  const bq = new Biquad();
  for (const d of list) {
    bq.set(d.type, sr, d.f, d.q ?? 0.7071, d.g ?? 0).reset();
    bq.run(buf, from, to);
  }
  return buf;
}

/* ==================================================================== */
/* noise sources                                                         */
/* ==================================================================== */

export function fillNoise(buf, rng, color = 'white') {
  const n = buf.length;
  if (color === 'white') {
    for (let i = 0; i < n; i++) buf[i] = rng.next() * 2 - 1;
    return buf;
  }
  if (color === 'pink') {
    // Paul Kellet's economy pink filter — flat enough for our purposes.
    let b0 = 0; let b1 = 0; let b2 = 0; let b3 = 0; let b4 = 0; let b5 = 0; let b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = rng.next() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      buf[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.16;
      b6 = w * 0.115926;
    }
    return buf;
  }
  if (color === 'brown') {
    let last = 0;
    for (let i = 0; i < n; i++) {
      const w = rng.next() * 2 - 1;
      last = (last + 0.035 * w) / 1.035;
      buf[i] = last * 4.2;
    }
    return buf;
  }
  if (color === 'velvet') {
    // Sparse ±1 impulses: the ideal excitation for reverb tails, no low rumble.
    buf.fill(0);
    const density = Math.max(2, Math.floor(n / 12));
    for (let i = 0; i < density; i++) {
      buf[Math.floor(rng.next() * n)] += rng.next() < 0.5 ? -1 : 1;
    }
    return buf;
  }
  return fillNoise(buf, rng, 'white');
}

/* ==================================================================== */
/* envelopes                                                             */
/* ==================================================================== */

/**
 * Percussive envelope. `attack` is a time constant (reaches ~95% at t=attack),
 * `curve` bends the decay: 1 = exponential, 2 = gaussian (more "closed"),
 * 0.6 = long smeared tail.
 */
export function envAt(t, attack, decay, curve = 1) {
  if (t < 0) return 0;
  const a = attack > 1e-6 ? 1 - Math.exp(-t / (attack * 0.34)) : 1;
  const d = Math.exp(-Math.pow(t / decay, curve));
  return a * d;
}

/**
 * The whole bank is millions of samples of `exp(-(t/d)^curve)`, and `Math.pow`
 * in a per-sample loop is the single biggest cost in the boot budget. The decay
 * shape depends only on `t/decay`, so tabulate it once per distinct curve and
 * interpolate. 1024 entries over 8 time constants is well below the noise floor
 * of the material it shapes.
 */
const CURVE_TABLES = new Map();
const CURVE_N = 1024;
const CURVE_UMAX = 8;

function decayTable(curve) {
  const key = Math.round(curve * 1000);
  let t = CURVE_TABLES.get(key);
  if (t) return t;
  const tbl = new Float32Array(CURVE_N + 2);
  for (let i = 0; i <= CURVE_N; i++) {
    const u = (i * CURVE_UMAX) / CURVE_N;
    tbl[i] = Math.exp(-Math.pow(u, curve));
  }
  tbl[CURVE_N + 1] = 0;
  t = { tbl, scale: CURVE_N / CURVE_UMAX };
  CURVE_TABLES.set(key, t);
  return t;
}

/**
 * Damped sinusoid via a two-pole recurrence: `y[n] = 2r·cos(w)·y[n-1] - r²·y[n-2]`
 * generates `r^n·sin(w(n+1))` with two multiplies and no transcendentals at all.
 * `bendK` glides the frequency (metal under stress) by refreshing the
 * coefficient every 32 samples, which is inaudible and costs nothing.
 */
function addDampedSine(out, i0, n, amp, w0, r, bendK = 1) {
  let w = w0;
  let c = 2 * r * Math.cos(w);
  const rr = r * r;
  const bend32 = bendK === 1 ? 1 : Math.pow(bendK, 32);
  let y1 = 0;
  let y0 = Math.sin(w);
  for (let i = 0; i < n; i++) {
    out[i0 + i] += amp * y0;
    const y = c * y0 - rr * y1;
    y1 = y0;
    y0 = y;
    if (bend32 !== 1 && (i & 31) === 31) {
      w *= bend32;
      if (w > 3.0) w = 3.0;
      c = 2 * r * Math.cos(w);
    }
  }
}

/** Fast tanh — 5 flops instead of a libm call, indistinguishable as a saturator. */
function ftanh(x) {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

/* ==================================================================== */
/* layer generators                                                      */
/* ==================================================================== */

/**
 * Filtered noise burst. Filtering happens *before* the envelope so the attack
 * stays razor sharp instead of being smeared by filter ring-in.
 */
export function addNoiseBurst(out, sr, o) {
  const t0 = o.t0 ?? 0;
  const decay = Math.max(1e-4, o.decay ?? 0.03);
  const curve = o.curve ?? 1;
  // 4 time constants is -35 dB; past that the layer is below the noise floor of
  // everything stacked on top of it, and rendering it is pure boot cost.
  const dur = o.dur ?? decay * (curve >= 2 ? 1.8 : 4.0);
  const i0 = Math.round(t0 * sr);
  if (i0 >= out.length) return out;
  const n = Math.min(Math.ceil(dur * sr), out.length - i0);
  if (n <= 0) return out;

  const src = new Float32Array(n);
  fillNoise(src, o.rng, o.color ?? 'white');
  if (o.filters) applyFilters(src, sr, o.filters);

  const gain = o.gain ?? 1;
  const attack = o.attack ?? 0.0006;
  const wobble = o.wobble ?? 0;
  const wobbleHz = o.wobbleHz ?? 30;

  const { tbl, scale: tscale } = decayTable(curve);
  const uStep = 1 / (decay * sr);
  const aK = attack > 1e-6 ? Math.exp(-1 / (attack * 0.34 * sr)) : 0;
  let a = 1;
  let u = 0;
  const wStep = TAU * wobbleHz / sr;
  let wPh = o.wobblePhase ?? 0;

  for (let i = 0; i < n; i++) {
    const x = u * tscale;
    const xi = x | 0;
    const d = xi >= CURVE_N ? 0 : tbl[xi] + (tbl[xi + 1] - tbl[xi]) * (x - xi);
    let e = (1 - a) * d;
    if (wobble) { e *= 1 + wobble * Math.sin(wPh); wPh += wStep; }
    out[i0 + i] += src[i] * e * gain;
    a *= aK;
    u += uStep;
  }
  return out;
}

/**
 * The barrel. A very short excitation is pushed through a bank of high-Q
 * bandpasses whose ring-down times are given directly as decay constants; the
 * result is the "body" that separates a rifle report from a firecracker.
 *
 * modes: [{f, tau, a, color?}]  tau = -60 dB-ish ring time in seconds
 */
export function addResonance(out, sr, o) {
  const t0 = o.t0 ?? 0;
  const i0 = Math.round(t0 * sr);
  if (i0 >= out.length) return out;

  const excite = Math.max(1e-4, o.excite ?? 0.0016);
  const gain = o.gain ?? 1;
  const modes = o.modes || [];
  let longest = 0;
  for (const m of modes) longest = Math.max(longest, m.tau);
  const n = Math.min(Math.ceil((longest * 4.2 + excite) * sr), out.length - i0);
  if (n <= 0) return out;

  // Shared excitation: a click plus a tiny puff of noise.
  const ex = new Float32Array(n);
  fillNoise(ex, o.rng, o.color ?? 'white');
  const exK = Math.exp(-1 / (excite * sr));
  let exE = 1;
  for (let i = 0; i < n; i++) {
    ex[i] *= exE;
    exE *= exK;
  }
  ex[0] += 1;

  const bq = new Biquad();
  const tmp = new Float32Array(n);
  for (const m of modes) {
    // Q that yields the requested ring time: tau ≈ Q / (pi * f)
    const q = Math.max(0.6, Math.min(180, m.tau * Math.PI * m.f));
    bq.set('bpq', sr, m.f, q).reset();
    const a = (m.a ?? 1) * gain;
    for (let i = 0; i < n; i++) tmp[i] = bq.process(ex[i]);
    // Normalise by peak so high-Q modes don't dominate purely through gain.
    let peak = 1e-6;
    for (let i = 0; i < n; i++) { const v = Math.abs(tmp[i]); if (v > peak) peak = v; }
    const k = a / peak;
    for (let i = 0; i < n; i++) out[i0 + i] += tmp[i] * k;
  }
  return out;
}

/**
 * Explicit modal synthesis: exponentially decaying sinusoids with optional
 * pitch bend (metal under stress) and beating partners. This is what makes
 * casings and ricochets sound like metal instead of like noise.
 *
 * modes: [{f, tau, a, phase?, bend?, beat?}]
 */
export function addModes(out, sr, o) {
  const i0 = Math.round((o.t0 ?? 0) * sr);
  if (i0 >= out.length) return out;
  const gain = o.gain ?? 1;
  for (const m of o.modes) {
    const tau = Math.max(1e-4, m.tau);
    const n = Math.min(Math.ceil(tau * 4.4 * sr), out.length - i0);
    if (n <= 0) continue;
    const a = (m.a ?? 1) * gain;
    const bend = m.bend ?? 1;
    const beat = m.beat ?? 0;
    const detune = m.detune ?? 1.0032;
    const kf = TAU / sr;
    const r = Math.exp(-1 / (tau * sr));
    // Frequency glide expressed per sample: bend is defined over one time
    // constant, so the per-sample ratio is bend^(1/(tau*sr)).
    const bendK = bend === 1 ? 1 : Math.pow(bend, 1 / (tau * sr));
    addDampedSine(out, i0, n, a, kf * m.f, r, bendK);
    if (beat) addDampedSine(out, i0, n, a * beat, kf * m.f * detune, r, bendK);
  }
  return out;
}

/**
 * Pitch-swept oscillator — the low thump of a muzzle blast, the descending
 * whine of a ricochet, the body of an explosion.
 */
export function addSweep(out, sr, o) {
  const i0 = Math.round((o.t0 ?? 0) * sr);
  if (i0 >= out.length) return out;
  const decay = Math.max(1e-4, o.decay ?? 0.12);
  const n = Math.min(Math.ceil(decay * 4.2 * sr), out.length - i0);
  if (n <= 0) return out;
  const f0 = o.f0 ?? 120;
  const f1 = o.f1 ?? 45;
  const sweep = Math.max(1e-4, o.sweep ?? decay * 0.5);
  const gain = o.gain ?? 1;
  const attack = o.attack ?? 0.0015;
  const shape = o.shape ?? 'sin';
  const vib = o.vib ?? 0;
  const vibHz = o.vibHz ?? 7;
  const kf = TAU / sr;
  let ph = o.phase ?? 0;

  const curve = o.curve ?? 1;
  const { tbl, scale: tscale } = decayTable(curve);
  const uStep = 1 / (decay * sr);
  const aK = attack > 1e-6 ? Math.exp(-1 / (attack * 0.34 * sr)) : 0;
  let av = 1;
  let ue = 0;

  const ratio = f1 / f0;
  const invSweep = 1 / sweep;
  const vibStep = TAU * vibHz / sr;
  let vibPh = 0;
  let inc = 0;

  for (let i = 0; i < n; i++) {
    // The sweep is smooth; recomputing its (expensive) pow every 16 samples is
    // a sub-cent frequency error and roughly a tenfold saving.
    if ((i & 15) === 0) {
      const t = i / sr;
      const u = Math.min(1, t * invSweep);
      let f = f0 * Math.pow(ratio, u * u * (3 - 2 * u));
      if (vib) { f *= 1 + vib * Math.sin(vibPh); vibPh += vibStep * 16; }
      inc = kf * f;
    }
    ph += inc;
    let v;
    if (shape === 'tri') v = Math.asin(Math.sin(ph)) * 0.6366;
    else if (shape === 'saw') v = ((ph / TAU) % 1) * 2 - 1;
    else if (shape === 'sq') v = Math.sin(ph) >= 0 ? 1 : -1;
    else v = Math.sin(ph);

    const x = ue * tscale;
    const xi = x | 0;
    const d = xi >= CURVE_N ? 0 : tbl[xi] + (tbl[xi + 1] - tbl[xi]) * (x - xi);
    out[i0 + i] += v * (1 - av) * d * gain;
    av *= aK;
    ue += uStep;
  }
  return out;
}

/**
 * Granular texture: many tiny randomised bursts scattered over a window.
 * Sand crunch, gravel skitter, glass shards, debris rain — all the same
 * generator with different grain filters and time distributions.
 */
export function addGrains(out, sr, o) {
  const rng = o.rng;
  const count = o.count ?? 40;
  const t0 = o.t0 ?? 0;
  const dur = o.dur ?? 0.18;
  const gain = o.gain ?? 1;
  const skew = o.skew ?? 2.0;      // >1 front-loads the grains
  const fLo = o.fLo ?? 1200;
  const fHi = o.fHi ?? 7000;
  const grainDecay = o.grainDecay ?? 0.006;
  const decayFall = o.decayFall ?? 1;
  for (let g = 0; g < count; g++) {
    const u = Math.pow(rng.next(), skew);
    const t = t0 + u * dur;
    const level = gain * (1 - u * 0.85) * (0.35 + 0.65 * rng.next());
    const f = fLo * Math.pow(fHi / fLo, rng.next());
    addNoiseBurst(out, sr, {
      rng,
      t0: t,
      decay: grainDecay * (0.5 + rng.next() * 1.5) * (1 + u * (decayFall - 1)),
      attack: 0.00012,
      gain: level,
      curve: 1.3,
      filters: [
        { type: 'bp', f, q: o.grainQ ?? 2.4 },
        { type: 'hp', f: fLo * 0.6, q: 0.7 },
      ],
    });
  }
  return out;
}

/** A single dry click — the tick of a firing pin, the tap of a shell nose. */
export function addClick(out, sr, o) {
  const i0 = Math.round((o.t0 ?? 0) * sr);
  if (i0 < 0 || i0 >= out.length) return out;
  const decay = o.decay ?? 0.0009;
  const n = Math.min(Math.ceil(decay * 8 * sr), out.length - i0);
  const gain = o.gain ?? 1;
  const f = o.f ?? 4200;
  const bq = new Biquad().set('bp', sr, f, o.q ?? 1.1);
  const k = Math.exp(-1 / (decay * sr));
  const k2 = Math.exp(-1 / (decay * 0.4 * sr));
  let e = 1;
  let e2 = 1;
  for (let i = 0; i < n; i++) {
    const x = (i === 0 ? 1 : 0) + (o.rng ? o.rng.bi(0.6) * e2 : 0);
    out[i0 + i] += bq.process(x) * e * gain * 6;
    e *= k;
    e2 *= k2;
  }
  return out;
}

/* ==================================================================== */
/* shaping / finishing                                                   */
/* ==================================================================== */

/** Asymmetric soft clip — adds the even harmonics that make loud things loud. */
export function softClip(buf, drive = 1.6, asym = 0.12) {
  const k = drive;
  const norm = 1 / ftanh(k > 1 ? k : 1);
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    buf[i] = ftanh(v * k + asym * v * v) * norm;
  }
  return buf;
}

export function dcBlock(buf, sr) {
  const r = 1 - 12 / sr;
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const y = x - x1 + r * y1;
    x1 = x; y1 = y;
    buf[i] = y;
  }
  return buf;
}

export function normalize(buf, peak = 0.92) {
  let m = 1e-9;
  for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > m) m = v; }
  const k = peak / m;
  for (let i = 0; i < buf.length; i++) buf[i] *= k;
  return buf;
}

export function scale(buf, k) {
  for (let i = 0; i < buf.length; i++) buf[i] *= k;
  return buf;
}

/** Kill start/end discontinuities so a one-shot never clicks. */
export function fadeEdges(buf, sr, headMs = 0.4, tailMs = 6) {
  const h = Math.min(buf.length, Math.round(sr * headMs * 0.001));
  const t = Math.min(buf.length, Math.round(sr * tailMs * 0.001));
  for (let i = 0; i < h; i++) buf[i] *= i / h;
  for (let i = 0; i < t; i++) buf[buf.length - 1 - i] *= i / t;
  return buf;
}

/** Trim trailing silence so buffers stay small. */
export function trim(buf, threshold = 1e-4, sr = 48000) {
  let end = buf.length;
  while (end > 64 && Math.abs(buf[end - 1]) < threshold) end--;
  end = Math.min(buf.length, end + Math.round(sr * 0.004));
  return end === buf.length ? buf : buf.slice(0, end);
}

/* ==================================================================== */
/* AudioBuffer plumbing                                                  */
/* ==================================================================== */

export function toBuffer(ctx, channels, sr) {
  const chans = Array.isArray(channels) ? channels : [channels];
  const len = chans[0].length;
  const buf = ctx.createBuffer(chans.length, len, sr);
  for (let c = 0; c < chans.length; c++) {
    if (buf.copyToChannel) buf.copyToChannel(chans[c], c);
    else buf.getChannelData(c).set(chans[c]);
  }
  return buf;
}

export { TAU };
