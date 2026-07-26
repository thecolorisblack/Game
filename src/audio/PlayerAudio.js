/**
 * OPERATION BLACKOUT — the operator's own body.
 *
 * Breathing, heartbeat, tinnitus and the near-death muffle. These are the
 * sounds nobody consciously notices and everybody feels: the difference between
 * "the health bar is low" and "I am about to die" is almost entirely carried by
 * a lowpass, a heartbeat and the fact that your own breathing suddenly got
 * louder than the firefight.
 *
 * Drives `game.player.vitals.criticality` (0..1, how close to death) and
 * `.windedness` (0..1, exertion) when they exist, and degrades to a calm idle
 * breath loop when the player module is still a placeholder.
 */

export class PlayerAudio {
  constructor(engine) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.mixer = engine.mixer;

    this.exertion = 0;
    this.criticality = 0;
    this.alive = true;

    this._breathT = 0;
    this._breathPhase = 0;     // 0 = about to inhale, 1 = about to exhale
    this._heartT = 0;
    this._lastGrunt = -10;

    this.tinnitus = 0;
    this._tinnitusTarget = 0;
    this._deafPunch = 0;

    this.enabled = true;
  }

  init() {
    const ctx = this.ctx;
    const body = this.mixer.bus('body');

    // --- tinnitus ring ---------------------------------------------------
    // Two close, slightly detuned tones plus a narrow noise band: a single sine
    // reads as a test tone, three partials read as damaged hearing.
    this.ringGain = ctx.createGain();
    this.ringGain.gain.value = 0.0001;
    this.ringGain.connect(body);

    this._ringOscs = [];
    for (const [f, g, type] of [[4680, 0.5, 'sine'], [7340, 0.22, 'sine'], [3130, 0.14, 'sine']]) {
      try {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = f;
        const og = ctx.createGain();
        og.gain.value = g;
        o.connect(og);
        og.connect(this.ringGain);
        this._ringOscs.push(o);
      } catch { /* ignore */ }
    }

    // A slow beat between the partials keeps the ring alive instead of static.
    try {
      this._ringLfo = ctx.createOscillator();
      this._ringLfo.frequency.value = 0.37;
      this._ringLfoAmt = ctx.createGain();
      this._ringLfoAmt.gain.value = 6;
      this._ringLfo.connect(this._ringLfoAmt);
      this._ringLfoAmt.connect(this._ringOscs[0].detune);
    } catch { /* ignore */ }

    this._started = false;
    return this;
  }

  _start() {
    if (this._started || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    try {
      for (const o of this._ringOscs) o.start(t);
      this._ringLfo?.start(t);
      this._started = true;
    } catch { this._started = true; }
  }

  /* ------------------------------------------------------------------ */

  /** Called on `explosion` and on any big concussive event. */
  concussion(strength = 1) {
    const s = Math.max(0, Math.min(1.4, strength));
    this._tinnitusTarget = Math.max(this._tinnitusTarget, 0.16 + 0.5 * s);
    this._deafPunch = Math.max(this._deafPunch, 0.55 + 0.45 * s);
    this.mixer.duckWorld(Math.max(0.16, 0.45 - 0.3 * s), 0.22 + 0.3 * s, 1.4 + s);
    this.mixer.duckMusic(0.35, 0.4, 1.6);
  }

  /** Pain reaction — a short involuntary exhale, rate-limited. */
  hurt(amount = 20) {
    const now = this.engine.clock;
    if (now - this._lastGrunt < 0.55) return;
    this._lastGrunt = now;
    const heavy = amount > 28;
    this.engine.play2D('breath:outHard', {
      bus: 'body',
      volume: 0.55 + Math.min(0.45, amount / 90),
      rate: (heavy ? 0.68 : 0.82) + this.engine.rng.bi(0.05),
      pan: this.engine.rng.bi(0.15),
      lowpass: heavy ? 2600 : 4200,
      send: 0.05,
    });
    // Skip the next inhale so the breath loop doesn't talk over the grunt.
    this._breathT = Math.max(this._breathT, 0.35);
  }

  died() {
    this.alive = false;
    this._tinnitusTarget = Math.max(this._tinnitusTarget, 0.30);
    this.engine.play2D('breath:outHard', { bus: 'body', volume: 0.8, rate: 0.6, lowpass: 1800 });
  }

  respawned() {
    this.alive = true;
    this._tinnitusTarget = 0;
    this._deafPunch = 0;
    this.criticality = 0;
    this.exertion = 0;
  }

  /* ------------------------------------------------------------------ */

  update(dt) {
    if (!this.enabled) return;
    this._start();
    const d = Math.min(0.1, Math.max(0.0001, dt));

    const p = this.engine.game?.player;
    const v = p?.vitals;
    const targetCrit = this.alive ? (v?.criticality ?? 0) : 1;
    const sprint = p?.sprinting ? 1 : 0;
    const speedRatio = p?.speedRatio ?? 0;
    const targetExert = Math.max(
      v?.windedness ?? 0,
      Math.min(1, speedRatio * 0.55 + sprint * 0.45),
    );

    this.criticality += (targetCrit - this.criticality) * (1 - Math.exp(-d / 0.5));
    this.exertion += (targetExert - this.exertion) * (1 - Math.exp(-d / (targetExert > this.exertion ? 0.9 : 2.4)));

    // --- tinnitus + muffle -----------------------------------------------
    this._tinnitusTarget *= Math.exp(-d / 3.4);
    if (this._tinnitusTarget < 0.0005) this._tinnitusTarget = 0;
    this._deafPunch *= Math.exp(-d / 1.7);

    const ringTarget = Math.max(this._tinnitusTarget, this.criticality * 0.12);
    this.tinnitus += (ringTarget - this.tinnitus) * (1 - Math.exp(-d / (ringTarget > this.tinnitus ? 0.05 : 1.6)));
    if (this._started) {
      try {
        this.ringGain.gain.setTargetAtTime(Math.max(0.00005, this.tinnitus * 0.10), this.ctx.currentTime, 0.08);
      } catch { /* ignore */ }
    }

    // Near-death is a heavy lowpass; a blast is a shorter, deeper one.
    const deaf = Math.min(1, Math.max(this.criticality * 0.72, this._deafPunch));
    this.mixer.setDeafen(deaf);

    if (this.ctx.state !== 'running') return;
    const state = this.engine.game?.state;
    if (state !== 'playing' && state !== 'dead') return;

    // --- breathing --------------------------------------------------------
    this._breathT -= d;
    if (this._breathT <= 0) {
      const e = this.exertion;
      const c = this.criticality;
      const hard = e > 0.42 || c > 0.5;
      const rng = this.engine.rng;
      const inhale = this._breathPhase === 0;
      const name = inhale ? (hard ? 'breath:inHard' : 'breath:in') : (hard ? 'breath:outHard' : 'breath:out');
      const level = 0.16 + 0.62 * Math.max(e, c * 0.85);
      if (level > 0.19 || this.engine.spatial.enclosure > 0.35) {
        this.engine.play2D(name, {
          bus: 'body',
          volume: level * (inhale ? 1 : 0.85),
          rate: (hard ? 1.06 : 0.97) + rng.bi(0.06),
          pan: rng.bi(0.12),
          lowpass: 12000 - 5000 * c,
          send: 0.10 + 0.25 * this.engine.spatial.enclosure,
        });
      }
      // Cadence: 4.2 s at rest collapsing to 1.05 s when blown.
      const cycle = 4.2 - 3.15 * Math.max(e, c * 0.7);
      this._breathT = (inhale ? cycle * 0.42 : cycle * 0.58) * (0.9 + rng.next() * 0.2);
      this._breathPhase = 1 - this._breathPhase;
    }

    // --- heartbeat ---------------------------------------------------------
    const heartDrive = Math.max(this.criticality, this.exertion * 0.55);
    if (heartDrive > 0.16) {
      this._heartT -= d;
      if (this._heartT <= 0) {
        const bpm = 62 + 96 * heartDrive;
        this._heartT = 60 / bpm;
        this.engine.play2D('heart', {
          bus: 'body',
          volume: 0.12 + 0.85 * Math.pow(Math.max(0, heartDrive - 0.16) / 0.84, 1.4),
          rate: 0.94 + heartDrive * 0.18,
          lowpass: 400,
          send: 0,
        });
      }
    } else {
      this._heartT = 0;
    }
  }
}
