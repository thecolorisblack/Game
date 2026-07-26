/**
 * OPERATION BLACKOUT — dynamic procedural score.
 *
 * Four layers, all synthesised live (no buffers, no samples), each with its own
 * fade-in threshold against the combat intensity the AI director publishes:
 *
 *   drone    always present once the mission starts — detuned saws under a
 *            slowly breathing lowpass, the bed everything else sits on
 *   pulse    a driving eighth-note ostinato; enters as soon as contact starts
 *   perc     kick / taiko / snare / hats; enters in a real firefight
 *   tension  a bowed cluster with a minor second in it, for when it is bad
 *
 * The scheduler is a standard lookahead: `update()` runs at frame rate and
 * schedules every event that falls inside the next 350 ms, so audio timing is
 * sample-accurate and completely immune to frame hitches. Nothing is scheduled
 * while the context is suspended, and the clock resynchronises on resume.
 */

const LOOKAHEAD = 0.35;

/** D natural minor, expressed as semitone offsets from the root. */
const SCALE = [0, 2, 3, 5, 7, 8, 10];

/** Bass ostinato: [scaleDegree, accent] per 16th. -1 = rest. */
const BASS_PATTERN = [
  [0, 1], [-1, 0], [0, 0.5], [-1, 0], [0, 0.7], [-1, 0], [4, 0.6], [-1, 0],
  [0, 0.9], [-1, 0], [0, 0.5], [6, 0.6], [3, 0.7], [-1, 0], [4, 0.55], [2, 0.5],
];

const HAT_PATTERN = [0.5, 0.15, 0.3, 0.15, 0.45, 0.15, 0.3, 0.2, 0.5, 0.15, 0.3, 0.15, 0.45, 0.2, 0.35, 0.25];
const KICK_PATTERN = [1, 0, 0, 0, 0, 0, 0.55, 0, 0.8, 0, 0, 0.4, 0, 0, 0.5, 0];
const SNARE_PATTERN = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0.3, 0, 1, 0, 0, 0.45];

export class Music {
  constructor(engine) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.mixer = engine.mixer;

    this.enabled = true;
    this.running = false;
    this.mode = 'idle';       // idle | menu | combat | dead
    this.intensity = 0;
    this._intensityTarget = 0;

    this.root = 36.7081;      // D1
    this.tempo = 86;
    this.step = 0;
    this.nextStepTime = 0;

    this.layer = { drone: 0, pulse: 0, perc: 0, tension: 0 };
    this._layerTarget = { drone: 0, pulse: 0, perc: 0, tension: 0 };

    this._nodes = null;
    this._noise = null;
    this._voices = 0;
  }

  /* ------------------------------------------------------------------ */

  init() {
    const ctx = this.ctx;
    const out = this.mixer.bus('music');

    const gain = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };

    const droneGain = gain(0);
    const pulseGain = gain(0);
    const percGain = gain(0);
    const tensionGain = gain(0);

    // Shared colouring: a touch of shelf on the whole score keeps it under the
    // gunfire rather than competing with it.
    const tone = ctx.createBiquadFilter();
    tone.type = 'highshelf';
    tone.frequency.value = 3800;
    tone.gain.value = -3.5;
    tone.connect(out);

    droneGain.connect(tone);
    pulseGain.connect(tone);
    percGain.connect(tone);
    tensionGain.connect(tone);

    // --- persistent drone ------------------------------------------------
    const droneFilter = ctx.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 240;
    droneFilter.Q.value = 3.5;
    droneFilter.connect(droneGain);

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.055;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 190;
    lfo.connect(lfoAmt);
    lfoAmt.connect(droneFilter.frequency);

    const lfo2 = ctx.createOscillator();
    lfo2.frequency.value = 0.021;
    const lfo2Amt = ctx.createGain();
    lfo2Amt.gain.value = 90;
    lfo2.connect(lfo2Amt);
    lfo2Amt.connect(droneFilter.frequency);

    const oscs = [];
    const detunes = [-11, -4, 3, 9, -17];
    for (let i = 0; i < detunes.length; i++) {
      const o = ctx.createOscillator();
      o.type = i === 0 ? 'sine' : 'sawtooth';
      o.frequency.value = this.root * (i === 4 ? 1.4983 : 1); // add a fifth
      o.detune.value = detunes[i];
      const g = gain(i === 0 ? 0.5 : 0.16);
      o.connect(g);
      g.connect(droneFilter);
      oscs.push(o);
    }

    // Sub: pure sine an octave down, felt more than heard.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = this.root * 0.5;
    const subGain = gain(0.42);
    sub.connect(subGain);
    subGain.connect(droneGain);

    this._nodes = {
      out, tone, droneGain, pulseGain, percGain, tensionGain,
      droneFilter, oscs, sub, lfo, lfo2, started: false,
    };

    this._noise = this._makeNoise();
    return this;
  }

  _makeNoise() {
    const ctx = this.ctx;
    const n = Math.ceil(ctx.sampleRate * 0.6);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let s = 12345;
    for (let i = 0; i < n; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      d[i] = (s / 2147483648) - 1;
    }
    return buf;
  }

  _startOscillators() {
    const n = this._nodes;
    if (!n || n.started || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    try {
      for (const o of n.oscs) o.start(t);
      n.sub.start(t);
      n.lfo.start(t);
      n.lfo2.start(t);
      n.started = true;
    } catch { /* already started */ }
  }

  /* ------------------------------------------------------------------ */
  /* control                                                             */
  /* ------------------------------------------------------------------ */

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    if (mode === 'menu') {
      this._layerTarget.drone = 0.55;
      this._layerTarget.pulse = 0;
      this._layerTarget.perc = 0;
      this._layerTarget.tension = 0.12;
      this.running = true;
    } else if (mode === 'combat') {
      this.running = true;
    } else if (mode === 'dead') {
      this._layerTarget.drone = 0.7;
      this._layerTarget.pulse = 0;
      this._layerTarget.perc = 0;
      this._layerTarget.tension = 0.5;
      this.running = true;
    } else {
      this.running = false;
    }
    // Resync the sequencer whenever the mode changes.
    this.nextStepTime = 0;
  }

  setIntensity(v) {
    this._intensityTarget = Math.max(0, Math.min(1, v || 0));
  }

  /* ------------------------------------------------------------------ */

  update(dt) {
    const ctx = this.ctx;
    const n = this._nodes;
    if (!n || !this.enabled) return;
    if (ctx.state !== 'running') { this.nextStepTime = 0; return; }
    this._startOscillators();

    const d = Math.min(0.12, Math.max(0.0001, dt || 0.016));
    const rise = this._intensityTarget > this.intensity;
    const k = 1 - Math.exp(-d / (rise ? 0.9 : 5.5));
    this.intensity += (this._intensityTarget - this.intensity) * k;

    if (this.mode === 'combat') {
      const I = this.intensity;
      this._layerTarget.drone = 0.5 + 0.34 * I;
      this._layerTarget.pulse = smoothBand(I, 0.10, 0.34) * (0.55 + 0.35 * I);
      this._layerTarget.perc = smoothBand(I, 0.36, 0.62) * (0.5 + 0.5 * I);
      this._layerTarget.tension = smoothBand(I, 0.58, 0.86) * (0.35 + 0.45 * I);
      this.tempo = 84 + 44 * I;
    }

    const now = ctx.currentTime;
    for (const key of ['drone', 'pulse', 'perc', 'tension']) {
      const target = this.running ? this._layerTarget[key] : 0;
      const lk = 1 - Math.exp(-d / (target > this.layer[key] ? 1.6 : 2.6));
      this.layer[key] += (target - this.layer[key]) * lk;
      const node = n[`${key}Gain`];
      try { node.gain.setTargetAtTime(this.layer[key] * this.layer[key], now, 0.12); } catch { /* ignore */ }
    }

    if (!this.running) return;

    // --- sequencer -------------------------------------------------------
    const stepDur = 60 / this.tempo / 4;   // sixteenth notes
    if (this.nextStepTime <= 0 || this.nextStepTime < now - 0.6) {
      this.nextStepTime = now + 0.06;
      this.step = 0;
    }
    let guard = 0;
    while (this.nextStepTime < now + LOOKAHEAD && guard++ < 48) {
      this._scheduleStep(this.step, this.nextStepTime, stepDur);
      this.step = (this.step + 1) % 64;
      this.nextStepTime += stepDur;
    }
  }

  _scheduleStep(step, time, stepDur) {
    const s16 = step % 16;
    const bar = Math.floor(step / 16) % 4;
    const I = this.intensity;

    // --- pulse ------------------------------------------------------------
    if (this.layer.pulse > 0.02) {
      const [deg, accent] = BASS_PATTERN[s16];
      if (deg >= 0 && (accent > 0.45 || I > 0.35)) {
        const semi = SCALE[deg % SCALE.length] + 12 * Math.floor(deg / SCALE.length);
        const f = this.root * 2 * Math.pow(2, semi / 12);
        this._pluck(time, f, stepDur * 1.7, accent * 0.34, 'sawtooth', 900 + 2600 * I);
        if (I > 0.5 && s16 % 4 === 0) {
          this._pluck(time, f * 2, stepDur * 1.1, accent * 0.12, 'square', 2200 + 2400 * I);
        }
      }
    }

    // --- percussion -------------------------------------------------------
    if (this.layer.perc > 0.02) {
      const kick = KICK_PATTERN[s16];
      if (kick > 0) this._kick(time, kick * 0.85);
      const snare = SNARE_PATTERN[s16];
      if (snare > 0 && I > 0.42) this._snare(time, snare * 0.5);
      if (I > 0.55) {
        const hat = HAT_PATTERN[s16];
        if (hat > 0.14) this._hat(time, hat * 0.22 * (0.5 + I * 0.5));
      }
      // Taiko fill at the top of every fourth bar when things are hot.
      if (I > 0.7 && bar === 3 && s16 >= 12) {
        this._taiko(time, 0.35 + (s16 - 12) * 0.07);
      }
    }

    // --- tension cluster --------------------------------------------------
    if (this.layer.tension > 0.02 && s16 === 0 && (step % 32 === 0)) {
      const chord = I > 0.8 ? [0, 3, 7, 8, 13] : [0, 3, 7, 10];
      const dur = (60 / this.tempo) * 8;
      for (let i = 0; i < chord.length; i++) {
        const f = this.root * 4 * Math.pow(2, chord[i] / 12);
        this._bow(time + i * 0.05, f, dur, 0.062 * this.layer.tension);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* voices                                                              */
  /* ------------------------------------------------------------------ */

  _pluck(time, freq, dur, gain, type, cutoff) {
    const ctx = this.ctx;
    const n = this._nodes;
    try {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      const o2 = ctx.createOscillator();
      o2.type = type;
      o2.frequency.value = freq;
      o2.detune.value = 9;

      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(cutoff, time);
      f.frequency.exponentialRampToValueAtTime(Math.max(160, cutoff * 0.22), time + dur);
      f.Q.value = 5;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.linearRampToValueAtTime(gain, time + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, time + dur);

      o.connect(f); o2.connect(f); f.connect(g); g.connect(n.pulseGain);
      o.start(time); o2.start(time);
      o.stop(time + dur + 0.05); o2.stop(time + dur + 0.05);
    } catch { /* scheduling past the end of the context */ }
  }

  _kick(time, gain) {
    const ctx = this.ctx;
    const n = this._nodes;
    try {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(128, time);
      o.frequency.exponentialRampToValueAtTime(36, time + 0.09);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.linearRampToValueAtTime(gain, time + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, time + 0.30);
      o.connect(g); g.connect(n.percGain);
      o.start(time); o.stop(time + 0.34);

      // Beater click.
      const s = ctx.createBufferSource();
      s.buffer = this._noise;
      const bf = ctx.createBiquadFilter();
      bf.type = 'bandpass';
      bf.frequency.value = 2200;
      bf.Q.value = 1.1;
      const bg = ctx.createGain();
      bg.gain.setValueAtTime(gain * 0.22, time);
      bg.gain.exponentialRampToValueAtTime(0.0001, time + 0.02);
      s.connect(bf); bf.connect(bg); bg.connect(n.percGain);
      s.start(time); s.stop(time + 0.05);
    } catch { /* ignore */ }
  }

  _taiko(time, gain) {
    const ctx = this.ctx;
    const n = this._nodes;
    try {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(190, time);
      o.frequency.exponentialRampToValueAtTime(74, time + 0.16);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.linearRampToValueAtTime(gain * 0.5, time + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, time + 0.5);
      o.connect(g); g.connect(n.percGain);
      o.start(time); o.stop(time + 0.55);
    } catch { /* ignore */ }
  }

  _snare(time, gain) {
    const ctx = this.ctx;
    const n = this._nodes;
    try {
      const s = ctx.createBufferSource();
      s.buffer = this._noise;
      s.playbackRate.value = 1 + (Math.random() * 0.2 - 0.1);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1400;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 3200;
      bp.Q.value = 0.8;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.linearRampToValueAtTime(gain, time + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, time + 0.16);
      s.connect(hp); hp.connect(bp); bp.connect(g); g.connect(n.percGain);
      s.start(time); s.stop(time + 0.2);

      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(230, time);
      o.frequency.exponentialRampToValueAtTime(160, time + 0.09);
      const og = ctx.createGain();
      og.gain.setValueAtTime(gain * 0.4, time);
      og.gain.exponentialRampToValueAtTime(0.0001, time + 0.12);
      o.connect(og); og.connect(n.percGain);
      o.start(time); o.stop(time + 0.15);
    } catch { /* ignore */ }
  }

  _hat(time, gain) {
    const ctx = this.ctx;
    const n = this._nodes;
    try {
      const s = ctx.createBufferSource();
      s.buffer = this._noise;
      s.playbackRate.value = 1.7;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 7000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain, time);
      g.gain.exponentialRampToValueAtTime(0.0001, time + 0.045);
      s.connect(hp); hp.connect(g); g.connect(n.percGain);
      s.start(time); s.stop(time + 0.07);
    } catch { /* ignore */ }
  }

  /** Bowed string: slow attack, unison detune, tremolo. */
  _bow(time, freq, dur, gain) {
    const ctx = this.ctx;
    const n = this._nodes;
    try {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.linearRampToValueAtTime(gain, time + dur * 0.35);
      g.gain.setValueAtTime(gain, time + dur * 0.55);
      g.gain.exponentialRampToValueAtTime(0.0001, time + dur);

      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(700, time);
      f.frequency.linearRampToValueAtTime(2300, time + dur * 0.5);
      f.frequency.linearRampToValueAtTime(600, time + dur);
      f.Q.value = 2.2;
      f.connect(g);
      g.connect(n.tensionGain);

      const trem = ctx.createOscillator();
      trem.frequency.value = 5.4 + Math.random();
      const tremAmt = ctx.createGain();
      tremAmt.gain.value = gain * 0.28;
      trem.connect(tremAmt);
      tremAmt.connect(g.gain);
      trem.start(time);
      trem.stop(time + dur + 0.1);

      for (const dt of [-8, 0, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = freq;
        o.detune.value = dt;
        const og = ctx.createGain();
        og.gain.value = 0.33;
        o.connect(og); og.connect(f);
        o.start(time); o.stop(time + dur + 0.1);
      }
    } catch { /* ignore */ }
  }

  /** One-off dramatic hit — used on death and on big scripted moments. */
  sting(kind = 'death') {
    const ctx = this.ctx;
    const n = this._nodes;
    if (!n || ctx.state !== 'running') return;
    const t = ctx.currentTime + 0.01;
    if (kind === 'death') {
      this._bow(t, this.root * 2, 3.2, 0.16);
      this._bow(t + 0.1, this.root * 2 * Math.pow(2, 1 / 12), 3.0, 0.10);
      this._taiko(t, 0.8);
    } else {
      this._taiko(t, 0.6);
      this._bow(t, this.root * 4, 1.6, 0.12);
    }
  }

  stop() {
    this.running = false;
    for (const key of ['drone', 'pulse', 'perc', 'tension']) this._layerTarget[key] = 0;
  }
}

/** 0 below `lo`, 1 above `hi`, smoothstep between. */
function smoothBand(x, lo, hi) {
  if (x <= lo) return 0;
  if (x >= hi) return 1;
  const u = (x - lo) / (hi - lo);
  return u * u * (3 - 2 * u);
}
