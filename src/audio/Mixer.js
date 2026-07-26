/**
 * OPERATION BLACKOUT — bus architecture, dynamics and global colouring.
 *
 *   weapons ┐
 *   world   ├─ worldSum ─ deafen(LPF) ─ shelf ─ worldTrim ┐
 *   verb    │                                             │
 *   ambience(duck) ┘                                      ├─ master ─ limiter ─ clip ─ fader ─ out
 *   music (duck) ──────────────────────────────────────────┤
 *   ui   ───────────────────────────────────────────────── │
 *   body ────────────────────────────────────────────────── ┘
 *
 * Design notes:
 *
 *  - `deafen` sits on everything diegetic but *not* on UI or body. When you are
 *    bleeding out, the world goes underwater while your own heartbeat and the
 *    HUD stay crisp; that contrast is the whole effect.
 *  - Ambience and music duck independently, with different recovery times, so a
 *    burst of fire pushes the score down hard and lets it swell back while the
 *    room tone recovers almost immediately.
 *  - The master chain is a compressor used as a limiter followed by a tanh
 *    clipper. The compressor does the musical work; the clipper is the seatbelt
 *    that guarantees nothing above 0 dBFS ever reaches the DAC, which matters
 *    because a dozen procedural layers can constructively align by accident.
 */

const BUSES = ['weapons', 'world', 'ambience', 'ui', 'music', 'body', 'verb'];

export class Mixer {
  constructor(ctx, settings) {
    this.ctx = ctx;
    this.settings = settings || null;
    this.buses = {};

    this.masterVolume = 1;
    this._lastSettingsVolume = -1;

    // JS-side envelopes; written to AudioParams once per frame.
    this.ambienceDuckLevel = 1;
    this.musicDuckLevel = 1;
    this.worldDuckLevel = 1;
    this._ambTarget = 1;
    this._musTarget = 1;
    this._wldTarget = 1;
    this._ambHold = 0;
    this._musHold = 0;
    this._wldHold = 0;

    this.deafen = 0;         // 0 = clear, 1 = fully muffled
    this._deafenTarget = 0;
    this._deafenSmoothed = 0;

    this._build();
  }

  _build() {
    const ctx = this.ctx;
    const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };

    this.out = g(1);

    // --- master safety chain ------------------------------------------
    this.clipper = ctx.createWaveShaper();
    this.clipper.curve = makeClipCurve(1.05);
    this.clipper.oversample = '2x';

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -7;
    this.limiter.knee.value = 3;
    this.limiter.ratio.value = 14;
    this.limiter.attack.value = 0.0025;
    this.limiter.release.value = 0.14;

    this.master = g(1);
    this.master.connect(this.limiter);
    this.limiter.connect(this.clipper);
    this.clipper.connect(this.out);
    this.out.connect(ctx.destination);

    // Optional tap for the HUD; harmless if nobody reads it.
    try {
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.75;
      this.out.connect(this.analyser);
    } catch { this.analyser = null; }

    // --- diegetic sum -------------------------------------------------
    this.worldTrim = g(1);
    this.shelf = ctx.createBiquadFilter();
    this.shelf.type = 'highshelf';
    this.shelf.frequency.value = 3500;
    this.shelf.gain.value = 0;

    this.deafenFilter = ctx.createBiquadFilter();
    this.deafenFilter.type = 'lowpass';
    this.deafenFilter.frequency.value = 20000;
    this.deafenFilter.Q.value = 0.5;

    this.worldSum = g(1);
    this.worldSum.connect(this.deafenFilter);
    this.deafenFilter.connect(this.shelf);
    this.shelf.connect(this.worldTrim);
    this.worldTrim.connect(this.master);

    // --- buses ---------------------------------------------------------
    for (const name of BUSES) this.buses[name] = g(1);

    // Weapons get a fast glue compressor: 30 rounds a second of transients
    // otherwise ride straight into the master limiter and pump everything.
    this.weaponComp = ctx.createDynamicsCompressor();
    this.weaponComp.threshold.value = -18;
    this.weaponComp.knee.value = 8;
    this.weaponComp.ratio.value = 3.2;
    this.weaponComp.attack.value = 0.004;
    this.weaponComp.release.value = 0.19;

    this.buses.weapons.gain.value = 0.85;
    this.buses.weapons.connect(this.weaponComp);
    this.weaponComp.connect(this.worldSum);

    this.worldDuck = g(1);
    this.buses.world.gain.value = 0.9;
    this.buses.world.connect(this.worldDuck);
    this.worldDuck.connect(this.worldSum);

    this.buses.verb.gain.value = 1.0;
    this.buses.verb.connect(this.worldDuck);

    this.ambienceDuck = g(1);
    this.buses.ambience.gain.value = 0.5;
    this.buses.ambience.connect(this.ambienceDuck);
    this.ambienceDuck.connect(this.worldSum);

    this.musicDuck = g(1);
    this.buses.music.gain.value = 0.62;
    this.buses.music.connect(this.musicDuck);
    // Music is emotionally "outside" the world: it should not go underwater
    // when the player is deafened, only duck.
    this.musicDuck.connect(this.master);

    this.buses.ui.gain.value = 0.75;
    this.buses.ui.connect(this.master);

    this.buses.body.gain.value = 0.8;
    this.buses.body.connect(this.master);
  }

  /* ------------------------------------------------------------------ */

  bus(name) { return this.buses[name] || this.buses.world; }

  /**
   * The fader sits *after* the limiter deliberately: putting it before would
   * make the amount of limiting depend on the volume knob, so the mix would
   * change character as the player turned it down.
   */
  setMasterVolume(v) {
    this.masterVolume = Math.max(0, Math.min(2, v ?? 1));
    const now = this.ctx.currentTime;
    // Perceptual curve: linear faders sound wrong above about 0.5.
    const gain = Math.pow(this.masterVolume, 1.6);
    try {
      this.out.gain.setTargetAtTime(gain, now, 0.03);
    } catch {
      this.out.gain.value = gain;
    }
  }

  /**
   * Duck ambience/music. `amount` is the multiplier to fall to (0.4 = -8 dB).
   * Repeated calls take the lowest value; recovery starts after `hold`.
   */
  duckAmbience(amount, hold = 0.08, release = 0.35) {
    this._ambTarget = Math.min(this._ambTarget, amount);
    this._ambHold = Math.max(this._ambHold, hold);
    this._ambRelease = release;
    this.ambienceDuckLevel = Math.min(this.ambienceDuckLevel, amount);
  }

  duckMusic(amount, hold = 0.12, release = 0.6) {
    this._musTarget = Math.min(this._musTarget, amount);
    this._musHold = Math.max(this._musHold, hold);
    this._musRelease = release;
    this.musicDuckLevel = Math.min(this.musicDuckLevel, amount);
  }

  /** Global world duck — used by the explosion "hearing punch". */
  duckWorld(amount, hold = 0.3, release = 1.2) {
    this._wldTarget = Math.min(this._wldTarget, amount);
    this._wldHold = Math.max(this._wldHold, hold);
    this._wldRelease = release;
    this.worldDuckLevel = Math.min(this.worldDuckLevel, amount);
  }

  /**
   * Cancel every outstanding duck immediately. `duck*` deliberately takes the
   * *lowest* requested level and the *longest* hold, so a long hold (the pause
   * menu) can only be cleared explicitly — otherwise unpausing would leave the
   * world ducked for the rest of the hold.
   */
  releaseDucks() {
    this._ambTarget = 1; this._musTarget = 1; this._wldTarget = 1;
    this._ambHold = 0; this._musHold = 0; this._wldHold = 0;
    this._ambRelease = 0.25; this._musRelease = 0.4; this._wldRelease = 0.3;
  }

  /** 0 = normal hearing, 1 = blown eardrums / near death. */
  setDeafen(x) {
    this._deafenTarget = Math.max(0, Math.min(1, x || 0));
  }

  update(dt) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const d = Math.min(0.1, Math.max(0.0001, dt || 0.016));

    if (this.settings) {
      const v = this.settings.masterVolume ?? 0.9;
      if (v !== this._lastSettingsVolume) {
        this._lastSettingsVolume = v;
        this.setMasterVolume(v);
      }
    }

    // --- duck envelopes -------------------------------------------------
    const step = (level, hold, target, release) => {
      if (hold > 0) return { level, hold: hold - d };
      const k = 1 - Math.exp(-d / Math.max(0.02, release));
      return { level: level + (1 - level) * k, hold: 0 };
    };

    let r = step(this.ambienceDuckLevel, this._ambHold, this._ambTarget, this._ambRelease ?? 0.35);
    this.ambienceDuckLevel = r.level; this._ambHold = r.hold;
    r = step(this.musicDuckLevel, this._musHold, this._musTarget, this._musRelease ?? 0.6);
    this.musicDuckLevel = r.level; this._musHold = r.hold;
    r = step(this.worldDuckLevel, this._wldHold, this._wldTarget, this._wldRelease ?? 1.2);
    this.worldDuckLevel = r.level; this._wldHold = r.hold;

    if (this.ambienceDuckLevel > 0.999) this._ambTarget = 1;
    if (this.musicDuckLevel > 0.999) this._musTarget = 1;
    if (this.worldDuckLevel > 0.999) this._wldTarget = 1;

    try {
      this.ambienceDuck.gain.setTargetAtTime(this.ambienceDuckLevel, now, 0.012);
      this.musicDuck.gain.setTargetAtTime(this.musicDuckLevel, now, 0.02);
      this.worldDuck.gain.setTargetAtTime(this.worldDuckLevel, now, 0.012);
    } catch { /* context torn down */ }

    // --- deafness -------------------------------------------------------
    const dk = 1 - Math.exp(-d / (this._deafenTarget > this.deafen ? 0.06 : 0.55));
    this.deafen += (this._deafenTarget - this.deafen) * dk;
    if (Math.abs(this.deafen - this._deafenSmoothed) > 0.002) {
      this._deafenSmoothed = this.deafen;
      const x = this.deafen;
      const f = 20000 * Math.pow(320 / 20000, x);
      try {
        this.deafenFilter.frequency.setTargetAtTime(f, now, 0.05);
        this.deafenFilter.Q.setTargetAtTime(0.5 + x * 0.6, now, 0.05);
        this.shelf.gain.setTargetAtTime(-16 * x, now, 0.05);
        this.worldTrim.gain.setTargetAtTime(1 - 0.35 * x, now, 0.05);
      } catch { /* ignore */ }
    }
  }

  dispose() {
    try { this.out.disconnect(); } catch { /* ignore */ }
  }
}

/** tanh-shaped soft clipper table. */
function makeClipCurve(drive = 1.05, n = 2048) {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  return curve;
}
