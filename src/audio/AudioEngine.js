/**
 * OPERATION BLACKOUT — audio.
 *
 * Everything you hear is generated in JavaScript at boot. There is not a single
 * audio file in this project: gunshots are stacked noise bursts and resonant
 * filter banks, rooms are procedurally generated impulse responses, the score is
 * four layers of live oscillators, and the tail of a rifle report is that shot
 * convolved with the city and played back a few milliseconds late.
 *
 * Layout
 *   Synth.js        offline DSP primitives
 *   Bank.js         every one-shot recipe, baked into AudioBuffers
 *   Impulse.js      procedural IRs per space + offline-baked gunshot tails
 *   Mixer.js        buses, ducking, deafness, master limiter
 *   Spatial.js      HRTF voice pool, air absorption, occlusion, verb routing
 *   Music.js        layered adaptive score
 *   PlayerAudio.js  breathing, heartbeat, tinnitus
 *
 * Contract
 *   - The AudioContext is created suspended and never blocks boot. In headless
 *     Chromium, where no user gesture ever arrives, every entry point is a
 *     silent no-op and nothing throws.
 *   - Every call into another system uses optional chaining; a placeholder
 *     `physics` or `player` costs us occlusion and breathing, not a frame.
 *
 * Public API (other systems may call any of these)
 *   audio.play(name, opts)              2D or 3D depending on opts.position
 *   audio.playAt(name, position, opts)  3D one-shot
 *   audio.play2D(name, opts)            head-locked one-shot
 *   audio.playUI(name, opts)            UI bus, never occluded or reverbed
 *   audio.setIntensity(v)               combat intensity for the score, 0..1
 *   audio.duck(amount, seconds)         push ambience + music down
 *   audio.concussion(strength)          tinnitus + global duck
 *   audio.resume() / audio.suspend()
 *   audio.ready                         boolean — context actually running
 *   audio.names()                       every sound id in the bank
 */

import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { Rng } from './Synth.js';
import { SoundBank, WEAPON_VOICES, canonicalSurface } from './Bank.js';
import { Mixer } from './Mixer.js';
import { SpatialField } from './Spatial.js';
import { Music } from './Music.js';
import { PlayerAudio } from './PlayerAudio.js';
import { SPACES, bakeTail, synthTail } from './Impulse.js';

/* -------------------------------------------------------------------- */

const TAIL_CLASSES = {
  rifle: { gain: 1.0, pre: 9000, bright: -3 },
  smg: { gain: 0.72, pre: 10000, bright: -1 },
  sniper: { gain: 1.5, pre: 7000, bright: -5 },
};

const TAIL_SECONDS = { interior: 1.15, stairwell: 2.2, street: 1.85, distant: 2.6 };

/** Friendly aliases so HUD/Menu can call `audio.playUI('click')` and be right. */
const NAME_ALIASES = {
  click: 'ui:click', hover: 'ui:hover', select: 'ui:confirm', accept: 'ui:confirm',
  confirm: 'ui:confirm', back: 'ui:back', cancel: 'ui:back', error: 'ui:deny',
  deny: 'ui:deny', hit: 'ui:hitmarker', hitmarker: 'ui:hitmarker',
  kill: 'ui:hitmarkerKill', headshot: 'ui:hitmarkerHead', objective: 'ui:objective',
  lowammo: 'ui:ammoLow', ammo: 'ui:ammoLow', damage: 'ui:damage', death: 'ui:death',
  explosion: 'explosion', whizby: 'whizby',
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/* ==================================================================== */

export class AudioEngine {
  constructor(game) {
    this.game = game;

    this.ctx = null;
    this.mixer = null;
    this.bank = null;
    this.spatial = null;
    this.music = null;
    this.body = null;

    this.available = false;     // an AudioContext exists
    this.booted = false;        // init() completed
    this.clock = 0;             // seconds of gameplay time since init
    this.rng = new Rng(0x5eed17);

    this.intensity = 0;
    this._intensityFloor = 0;
    this._externalIntensity = -1;

    this.tails = {};
    this.fallbackTails = {};

    this._timers = [];
    this._probeT = 0;
    this._hookT = 0;
    this._battleT = 6;
    this._ambienceSrc = null;
    this._lastShot = -10;
    this._lastNearTail = -10;
    this._lastFarTail = -10;
    this._lastWhizby = -10;
    this._lastDebris = -10;
    this._lowAmmoAt = -10;
    this._vmHooked = null;
    this._reloadFallback = true;
    this._resumed = false;

    this._v = new THREE.Vector3();
    this._probeDir = new THREE.Vector3();
    this._offs = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      this._offs.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
    }

    this._unsubs = [];
  }

  /* ================================================================== */
  /* lifecycle                                                           */
  /* ================================================================== */

  async init() {
    if (!this._createContext()) {
      // No Web Audio at all: keep every entry point callable and silent.
      this._wireEvents();
      this.booted = true;
      return this;
    }

    this.mixer = new Mixer(this.ctx, this.game?.settings);
    this.mixer.setMasterVolume(this.game?.settings?.masterVolume ?? 0.9);

    // Only weapons, mechanics and UI are rendered synchronously — about a
    // quarter of a second. Rooms, footsteps, impacts, breathing and the
    // ambience bed are rendered one phase per macrotask after boot, because a
    // loading bar that sits still is worse than a menu whose reverb arrives
    // half a second late. Every lookup is null-safe until then.
    this.bank = new SoundBank(this.ctx);
    try {
      this.bank.buildProgressive(3);
    } catch (err) {
      console.warn('[audio] bank build failed', err);
    }

    this.spatial = new SpatialField(this);
    try {
      this.spatial.init();
    } catch (err) {
      console.warn('[audio] spatial init failed', err);
    }

    this.music = new Music(this);
    try { this.music.init(); } catch (err) { console.warn('[audio] music init failed', err); }

    this.body = new PlayerAudio(this);
    try { this.body.init(); } catch (err) { console.warn('[audio] body init failed', err); }

    this._installGestureHooks();
    this._wireEvents();

    this._backgroundPromise = this._background().catch(() => {});

    this.booted = true;
    return this;
  }

  /**
   * Everything that does not have to exist before the first frame: the four
   * room impulse responses, their immediate synthesised tails, the remaining
   * sound-bank phases, and finally the offline-convolved gunshot tails. One
   * unit of work per macrotask so nothing ever lands inside a frame.
   */
  async _background() {
    const tick = () => new Promise((r) => setTimeout(r, 0));
    for (const id of Object.keys(SPACES)) {
      await tick();
      this.spatial?.buildSpaceIR(id);
      try {
        this.fallbackTails[id] = synthTail(this.ctx, SPACES[id], {
          sampleRate: 28000, seconds: TAIL_SECONDS[id],
        });
      } catch { /* ignore */ }
    }
    try { await this.bank?.restPromise; } catch { /* ignore */ }
    await tick();
    await this._bakeTails();
    this.fullyLoaded = true;
  }

  _createContext() {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return false;
    try {
      this.ctx = new AC({ latencyHint: 'interactive', sampleRate: 48000 });
    } catch {
      try {
        this.ctx = new AC();
      } catch {
        this.ctx = null;
      }
    }
    if (!this.ctx) return false;
    this.available = true;
    // Chrome creates the context suspended without a gesture. That is fine and
    // expected: every play path checks `ctx.state` before touching anything.
    if (this.ctx.state === 'running') this._resumed = true;
    return true;
  }

  get ready() { return !!this.ctx && this.ctx.state === 'running'; }

  /** Safe to call at any time, from anywhere; never throws, never blocks. */
  resume() {
    if (!this.ctx) return Promise.resolve(false);
    if (this.ctx.state === 'running') { this._onResumed(); return Promise.resolve(true); }
    try {
      return this.ctx.resume().then(() => { this._onResumed(); return true; }).catch(() => false);
    } catch {
      return Promise.resolve(false);
    }
  }

  suspend() {
    if (!this.ctx || this.ctx.state !== 'running') return Promise.resolve(false);
    try { return this.ctx.suspend().then(() => true).catch(() => false); } catch { return Promise.resolve(false); }
  }

  _onResumed() {
    if (this._resumed) { this._startAmbience(); return; }
    this._resumed = true;
    this._startAmbience();
    const state = this.game?.state;
    if (state === 'playing') this.music?.setMode('combat');
    else if (state === 'menu' || state === 'boot') this.music?.setMode('menu');
  }

  _installGestureHooks() {
    const fire = () => { this.resume(); };
    const opts = { passive: true };
    const targets = ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'wheel'];
    for (const ev of targets) {
      const fn = () => {
        fire();
        if (this.ctx?.state === 'running') {
          for (const e2 of targets) window.removeEventListener(e2, this._gestureFns[e2], opts);
        }
      };
      (this._gestureFns ||= {})[ev] = fn;
      window.addEventListener(ev, fn, opts);
    }
    // The pointer lock that starts a match is also a gesture.
    this._unsubs.push(bus.on('input:locked', fire));
  }

  dispose() {
    for (const off of this._unsubs) { try { off(); } catch { /* ignore */ } }
    this._unsubs.length = 0;
    this.spatial?.stopAll();
    this.music?.stop();
    try { this._ambienceSrc?.stop(); } catch { /* ignore */ }
    this.mixer?.dispose();
    try { this.ctx?.close(); } catch { /* ignore */ }
  }

  /* ================================================================== */
  /* baked tails                                                         */
  /* ================================================================== */

  async _bakeTails() {
    const irs = this.spatial?.irs;
    if (!irs) return;
    for (const space of Object.keys(SPACES)) {
      const ir = irs[space];
      if (!ir) continue;
      this.tails[space] ||= {};
      for (const cls of Object.keys(TAIL_CLASSES)) {
        const t = TAIL_CLASSES[cls];
        const weaponId = cls === 'sniper' ? 'sniper' : cls === 'smg' ? 'smg' : 'rifle';
        const dry = this.bank?.get(`weapon:${weaponId}:shot`);
        if (!dry) continue;
        const buf = await bakeTail(dry, ir, {
          // Must match the IR's rate: a ConvolverNode rejects a buffer whose
          // sample rate differs from its context.
          sampleRate: ir.sampleRate || this.ctx.sampleRate,
          seconds: TAIL_SECONDS[space],
          preLowpass: space === 'distant' ? 2400 : t.pre,
          preHighpass: 70,
          postHighpass: space === 'distant' ? 55 : 110,
          brightness: t.bright + (space === 'distant' ? -6 : 0),
          gain: 1,
          predelay: space === 'distant' ? 0.02 : 0,
        });
        if (buf) this.tails[space][cls] = buf;
        // Yield between renders so a slow software backend cannot stall a frame.
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }

  _tailFor(space, cls) {
    return this.tails[space]?.[cls] || this.fallbackTails[space] || null;
  }

  /* ================================================================== */
  /* playback API                                                        */
  /* ================================================================== */

  _buffer(name) {
    if (!this.bank) return null;
    let b = this.bank.get(name, this.rng);
    if (b) return b;
    const alias = NAME_ALIASES[String(name).toLowerCase()];
    if (alias) b = this.bank.get(alias, this.rng);
    if (b) return b;
    if (!String(name).includes(':')) b = this.bank.get(`ui:${name}`, this.rng);
    return b || null;
  }

  /** 2D or 3D depending on `opts.position`. Returns a handle or null. */
  play(name, opts = {}) {
    if (!this.ready) return null;
    const buf = this._buffer(name);
    if (!buf) return null;
    return this.spatial.play(buf, opts);
  }

  playAt(name, position, opts = {}) {
    if (!this.ready || !position) return null;
    const buf = this._buffer(name);
    if (!buf) return null;
    return this.spatial.play(buf, { ...opts, position });
  }

  play2D(name, opts = {}) {
    if (!this.ready) return null;
    const buf = this._buffer(name);
    if (!buf) return null;
    return this.spatial.play(buf, { ...opts, position: null, spatial: false });
  }

  playUI(name, opts = {}) {
    return this.play2D(name, { bus: 'ui', send: 0, sendFar: 0, ...opts });
  }

  playBuffer(buffer, opts = {}) {
    if (!this.ready || !buffer) return null;
    return this.spatial.play(buffer, opts);
  }

  names() { return this.bank?.names() ?? []; }

  /* ------------------------------------------------------------------ */

  setIntensity(v) {
    this._externalIntensity = clamp01(v);
  }

  bumpIntensity(v) {
    this._intensityFloor = Math.min(1, this._intensityFloor + v);
  }

  duck(amount = 0.6, seconds = 0.5) {
    this.mixer?.duckAmbience(amount, seconds * 0.25, seconds);
    this.mixer?.duckMusic(Math.min(1, amount + 0.15), seconds * 0.3, seconds * 1.4);
  }

  concussion(strength = 1) { this.body?.concussion(strength); }

  /** Schedule work on the gameplay clock (survives pause, unlike setTimeout). */
  _after(seconds, fn) {
    if (this._timers.length > 160) return;
    this._timers.push({ t: this.clock + seconds, fn });
  }

  /* ================================================================== */
  /* ambience                                                            */
  /* ================================================================== */

  _startAmbience() {
    if (!this.ready || this._ambienceSrc) return;
    const buf = this.bank?.get('amb:bed');
    if (!buf) return;
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = this.ctx.createGain();
      g.gain.value = 0.0001;
      g.gain.setTargetAtTime(1, this.ctx.currentTime, 1.5);
      src.connect(g);
      g.connect(this.mixer.bus('ambience'));
      src.start(0);
      this._ambienceSrc = src;
      this._ambienceGain = g;
    } catch { /* ignore */ }
  }

  /** Sporadic far-off firefights and artillery, scaled by combat intensity. */
  _updateDistantBattle(dt) {
    if (this.game?.state !== 'playing' || !this.ready) return;
    this._battleT -= dt;
    if (this._battleT > 0) return;
    const I = this.intensity;
    this._battleT = this.rng.range(5, 15) * (1.35 - 0.6 * I);

    const pan = this.rng.bi(0.85);
    const base = (0.10 + 0.16 * I) * this.rng.range(0.6, 1.2);
    if (this.rng.chance(0.22)) {
      this.play2D('distant:boom', { bus: 'ambience', volume: base * 1.5, pan, rate: this.rng.range(0.88, 1.12), send: 0.1, sendFar: 0.5 });
      return;
    }
    const shots = this.rng.int(2, 7);
    let t = 0;
    for (let i = 0; i < shots; i++) {
      const vol = base * this.rng.range(0.7, 1.15);
      this.play2D('distant:shot', {
        bus: 'ambience', volume: vol, pan: pan + this.rng.bi(0.12),
        rate: this.rng.range(0.9, 1.14), delay: t, send: 0.08, sendFar: 0.45,
        lowpass: this.rng.range(1400, 3200),
      });
      t += this.rng.range(0.075, 0.16);
    }
  }

  /* ================================================================== */
  /* acoustic probe                                                      */
  /* ================================================================== */

  /**
   * Classify the listener's surroundings by casting a handful of rays. Cheap,
   * runs three times a second, and is the only thing standing between "every
   * room sounds like a car park" and a mix that changes as you move.
   */
  _probeEnvironment() {
    const phys = this.game?.physics;
    const spatial = this.spatial;
    if (!spatial) return;
    if (!phys?.raycast) { spatial.setEnvironment('street', 0.4); return; }

    const o = spatial.listenerPos;
    let ceil = 20;
    try {
      const up = phys.raycast(o, this._probeDir.set(0, 1, 0), 14, null);
      if (up) ceil = up.distance;
    } catch { /* ignore */ }

    let sum = 0;
    let hits = 0;
    const MAX = 22;
    for (const d of this._offs) {
      let dist = MAX;
      try {
        const r = phys.raycast(o, this._probeDir.copy(d), MAX, null);
        if (r) { dist = r.distance; hits++; }
      } catch { /* ignore */ }
      sum += Math.min(dist, MAX);
    }
    const mean = sum / this._offs.length;

    const roofed = clamp01((8 - ceil) / 5.5);
    const tight = clamp01((14 - mean) / 10);
    const indoor = clamp01(roofed * (0.35 + 0.65 * tight) * clamp01(hits / 4));
    const stairFrac = clamp01((4.6 - mean) / 3.0) * clamp01((ceil - 2.2) / 2.5);

    spatial.setEnvironment({
      interior: indoor * (1 - stairFrac),
      stairwell: indoor * stairFrac,
      street: 1 - indoor,
    }, 0.10 + 0.45 * (1 - indoor));

    if (this.spatial) this.spatial.airDistance = 40 + 30 * (1 - indoor);
  }

  /* ================================================================== */
  /* tick                                                                */
  /* ================================================================== */

  update(dt, time) {
    if (!this.booted || !this.ctx) return;
    const d = Math.min(0.1, Math.max(0, (time?.rawDelta ?? dt) || 0.016));
    this.clock += d;

    try {
      this.mixer.update(d);
      this.spatial.update(d, this.game?.camera);
      this._updateIntensity(d);
      this.music.update(d);
      this.body.update(d);
    } catch (err) {
      // A thrown error here would kill the frame loop for every other system.
      if (!this._warned) { this._warned = true; console.warn('[audio] update failed', err); }
    }

    // Deferred one-shots (shell drops, delayed body falls, reload fallbacks).
    if (this._timers.length) {
      for (let i = this._timers.length - 1; i >= 0; i--) {
        if (this._timers[i].t <= this.clock) {
          const fn = this._timers[i].fn;
          this._timers.splice(i, 1);
          try { fn(); } catch { /* a dead timer must not kill the frame */ }
        }
      }
    }

    this._probeT -= d;
    if (this._probeT <= 0) {
      this._probeT = 0.34;
      try { this._probeEnvironment(); } catch { /* ignore */ }
    }

    this._hookT -= d;
    if (this._hookT <= 0) {
      this._hookT = 1.0;
      this._hookWeaponClips();
      // The ambience bed is one of the last things to finish rendering; retry
      // until the buffer exists.
      if (!this._ambienceSrc && this.ready) this._startAmbience();
    }

    this._pollHandling();
    this._updateDistantBattle(d);
  }

  /**
   * Foley that has no event to hang off: shouldering the weapon and dropping
   * out of a sprint. Polled because these are continuous states, not messages.
   */
  _pollHandling() {
    if (!this.ready) return;
    const p = this.game?.player;
    const w = this.game?.weapons;
    const ads = !!(w?.ads ?? p?.ads);
    if (ads !== this._wasAds) {
      this._wasAds = ads;
      this.play2D('mech:ads', {
        bus: 'weapons', volume: ads ? 0.30 : 0.22,
        rate: (ads ? 1.0 : 1.15) + this.rng.bi(0.05),
        pan: this.rng.bi(0.12), send: 0.10 + 0.3 * this.spatial.enclosure,
      });
    }
    const sprint = !!p?.sprinting;
    if (sprint !== this._wasSprint) {
      this._wasSprint = sprint;
      if (this.game?.state === 'playing') {
        this.play2D('mech:cloth', {
          bus: 'world', volume: 0.18, rate: sprint ? 0.95 : 1.1,
          pan: this.rng.bi(0.2), send: 0.1,
        });
      }
    }
  }

  _updateIntensity(d) {
    // Decay whatever combat has accumulated, then take the loudest opinion:
    // ours, or the AI director's if it has one.
    this._intensityFloor *= Math.exp(-d / 7.5);
    let I = this._intensityFloor;

    const ai = this.game?.ai;
    const aiI = ai?.combatIntensity ?? ai?.intensity ?? ai?.director?.intensity;
    if (typeof aiI === 'number' && Number.isFinite(aiI)) I = Math.max(I, clamp01(aiI));
    if (this._externalIntensity >= 0) I = Math.max(I, this._externalIntensity);

    const crit = this.body?.criticality ?? 0;
    I = Math.max(I, crit * 0.75);

    this.intensity = clamp01(I);
    this.music?.setIntensity(this.intensity);
  }

  /* ================================================================== */
  /* event wiring                                                        */
  /* ================================================================== */

  _wireEvents() {
    const on = (ev, fn) => this._unsubs.push(bus.on(ev, (p) => {
      try { fn(p); } catch (err) {
        if (!this._evWarned) { this._evWarned = true; console.warn(`[audio] handler ${ev}`, err); }
      }
    }));

    on('state', (e) => this._onState(e));
    on('boot:complete', () => { if (this.ready) this._startAmbience(); });

    on('weapon:fire', (e) => this._onWeaponFire(e));
    on('weapon:dryfire', () => this.play2D('mech:dryfire', { bus: 'weapons', volume: 0.55, pan: this.rng.bi(0.08), send: 0.18 }));
    on('weapon:reload', (e) => this._onReload(e));
    on('weapon:switch', (e) => this._onSwitch(e));
    on('weapon:firemode', () => this.play2D('mech:firemode', { bus: 'weapons', volume: 0.4, send: 0.12 }));
    on('weapon:ammo', (e) => this._onAmmo(e));

    on('bullet:impact', (e) => this._onImpact(e));
    on('bullet:whizby', (e) => this._onWhizby(e));
    on('debris:impact', (e) => this._onDebris(e));

    on('damage:dealt', (e) => this._onDamageDealt(e));
    on('damage:taken', (e) => this._onDamageTaken(e));
    on('hitmarker', (e) => this._onHitmarker(e));
    on('enemy:killed', (e) => this._onEnemyKilled(e));
    on('enemy:footstep', (e) => this._onEnemyFootstep(e));

    on('player:footstep', (e) => this._onFootstep(e));
    on('player:land', (e) => this._onLand(e));
    on('player:stance', (e) => this._onStance(e));
    on('player:died', () => this._onDied());
    on('player:spawn', () => this.body?.respawned());

    on('explosion', (e) => this._onExplosion(e));
    on('objective', () => this.playUI('ui:objective', { volume: 0.55 }));

    this._hookWeaponClips();
  }

  _onState(e) {
    if (!e) return;
    const s = e.next;
    if (s === 'playing') {
      this.music?.setMode('combat');
      this.resume();
      this._startAmbience();
      this.mixer?.setDeafen(0);
    } else if (s === 'menu' || s === 'boot') {
      this.music?.setMode('menu');
    } else if (s === 'paused') {
      this.mixer?.duckAmbience(0.35, 10, 0.4);
      this.mixer?.duckWorld(0.25, 10, 0.4);
      this.mixer?.duckMusic(0.55, 10, 0.6);
    } else if (s === 'dead') {
      this.music?.setMode('dead');
    }
    if (e.prev === 'paused' && s !== 'paused') this.mixer?.releaseDucks();
  }

  /* ------------------------------------------------------------------ */
  /* weapons                                                             */
  /* ------------------------------------------------------------------ */

  _weaponDef(id) {
    const ws = this.game?.weapons;
    const w = ws?.weapon;
    if (w && w.id === id) return w.def || null;
    const list = ws?.weapons || ws?.slots;
    if (Array.isArray(list)) {
      for (const item of list) if (item?.id === id) return item.def || item;
    }
    return null;
  }

  _onWeaponFire(e) {
    if (!this.ready || !e) return;
    const id = e.weapon || 'rifle';
    const voice = WEAPON_VOICES[id] || WEAPON_VOICES.rifle;
    const cls = voice.tailClass || 'rifle';

    const listener = this.spatial.listenerPos;
    const pos = e.origin || null;
    const dist = pos ? listener.distanceTo(pos) : 0;
    const firstPerson = !pos || dist < 3.2;

    const rate = 1 + this.rng.bi(0.035);
    const level = voice.level ?? 1;
    const enclosure = this.spatial.enclosure;

    // --- dry report ------------------------------------------------------
    if (firstPerson) {
      // Head-locked, very slightly off-centre, plus a tiny opposite-ear copy at
      // a Haas delay so it occupies the whole stereo field the way a rifle
      // beside your face does. Shouldered, the muzzle is closer and more
      // on-axis to the ear: a shade louder, a shade more centred.
      const ads = e.isADS ? 1 : 0;
      this.play2D(`weapon:${id}:shot`, {
        bus: 'weapons', volume: (0.92 + 0.05 * ads) * level, rate,
        pan: this.rng.range(0.05, 0.14) * (1 - 0.45 * ads),
        send: 0.10 + 0.55 * enclosure, sendFar: 0.35 * (1 - enclosure),
      });
      this.play2D(`weapon:${id}:shot`, {
        bus: 'weapons', volume: (0.34 - 0.08 * ads) * level, rate: rate * 0.997,
        pan: -0.55, delay: 0.0022, lowpass: 9000, send: 0.06,
      });
    } else {
      this.playAt(`weapon:${id}:shot`, pos, {
        bus: 'weapons', volume: 1.35 * level, rate,
        refDistance: 6, rolloff: 0.9, maxDistance: 600,
        send: 0.12 + 0.5 * enclosure, sendFar: 0.5, airScale: 1.25,
      });
    }

    // --- environment tail -------------------------------------------------
    // In a real recording this is most of what you hear. Indoors it is the room
    // slapping back; outdoors it is the whole street answering a few tens of
    // milliseconds later, and it is what sells the scale of the place.
    const space = this.spatial.environment;
    const speedDelay = Math.min(0.45, dist / 343);

    // Retriggering a full 2 s tail on every round of a 760 rpm burst would both
    // exhaust the voice pool and pile up into mush louder than the gun. Real
    // mixes re-fire the tail sparsely and lean on the one already ringing, so
    // rate-limit it and drop its level inside a burst.
    const sinceShot = this.clock - this._lastShot;
    const burst = sinceShot < 0.28 ? 0.45 : 1;

    const near = this._tailFor(space, cls);
    if (near && this.clock - this._lastNearTail > 0.085) {
      this._lastNearTail = this.clock;
      this.playBuffer(near, {
        bus: 'weapons',
        volume: (voice.tailGain ?? 1) * (firstPerson ? 0.62 : 0.5) * (0.55 + 0.65 * enclosure) * level * burst,
        rate: 1 + this.rng.bi(0.02),
        pan: this.rng.bi(0.25),
        delay: speedDelay,
        send: 0,
        lowpass: firstPerson ? 20000 : Math.max(1400, 16000 - dist * 60),
      });
    }
    const far = this._tailFor('distant', cls);
    if (far && (1 - enclosure) > 0.18 && this.clock - this._lastFarTail > 0.2) {
      this._lastFarTail = this.clock;
      // The far field grows with distance far more slowly than the crack decays,
      // which is why a shot at 150 m is nearly all tail.
      const farGain = (voice.tailGain ?? 1) * (1 - enclosure) * (0.30 + Math.min(0.85, dist / 90)) * level;
      this.playBuffer(far, {
        bus: 'weapons', volume: farGain * 0.6 * burst, rate: 1 + this.rng.bi(0.02),
        pan: this.rng.bi(0.4), delay: speedDelay + this.rng.range(0.01, 0.035),
        send: 0, lowpass: Math.max(900, 6000 - dist * 22),
      });
    }

    // --- consequences -----------------------------------------------------
    this.mixer.duckAmbience(0.45, 0.06, 0.45);
    this.mixer.duckMusic(0.66, 0.09, 0.55);
    this.bumpIntensity(firstPerson ? 0.055 : 0.075);

    if (firstPerson) this._scheduleShell(id);
    this._lastShot = this.clock;
  }

  _scheduleShell(id) {
    const def = this._weaponDef(id);
    if (def?.boltAction) return;
    const p = this.game?.player;
    const surf = canonicalSurface(p?.groundSurface || 'concrete');
    const kind = surf === 'metal' ? 'metal' : (surf === 'sand' || surf === 'dirt' || surf === 'foliage' || surf === 'fabric') ? 'dirt' : 'concrete';
    const delay = this.rng.range(0.34, 0.62);
    const rng = this.rng;
    this._after(delay, () => {
      if (!this.ready) return;
      const cam = this.game?.camera;
      if (!cam) return;
      // Roughly a metre to the shooter's right, on the deck.
      this._v.set(0.8 + rng.range(-0.3, 0.5), 0, -0.5 + rng.range(-0.4, 0.4)).applyQuaternion(cam.quaternion);
      this._v.x += cam.position.x;
      this._v.z += cam.position.z;
      this._v.y = cam.position.y - 1.5;
      this.playAt(`shell:${kind}`, this._v, {
        bus: 'world', volume: 0.34 * (WEAPON_VOICES[id]?.level ?? 1),
        rate: rng.range(0.9, 1.14), refDistance: 1.6, rolloff: 1.5,
        send: 0.16 + 0.4 * this.spatial.enclosure, occlude: false,
      });
    });
  }

  _onAmmo(e) {
    if (!e || typeof e.mag !== 'number') return;
    const max = e.max || 30;
    if (e.mag > 0 && e.mag <= Math.max(2, Math.ceil(max * 0.2)) && this.clock - this._lowAmmoAt > 0.4) {
      this._lowAmmoAt = this.clock;
      this.playUI('ui:ammoLow', { volume: 0.3 });
    }
  }

  /**
   * Reload mechanics. Preferred path: wrap the viewmodel's clip-event callback
   * so each mechanical sound lands exactly on the animation key that produces
   * it. Fallback: schedule by fractions of the weapon's reload duration.
   */
  _hookWeaponClips() {
    const vm = this.game?.weapons?.viewmodel;
    if (!vm) return;
    if (this._vmHooked && vm.onClipEvent === this._vmHooked) return;
    const prev = typeof vm.onClipEvent === 'function' ? vm.onClipEvent : null;
    const wrapped = (name, data, clip) => {
      let r;
      try { r = prev?.(name, data, clip); } finally {
        try { this._onClipEvent(name); } catch { /* never break the weapon */ }
      }
      return r;
    };
    vm.onClipEvent = wrapped;
    this._vmHooked = wrapped;
    this._reloadFallback = false;
  }

  _onClipEvent(name) {
    if (!this.ready) return;
    const V = { bus: 'weapons', send: 0.14 + 0.5 * this.spatial.enclosure };
    const r = () => this.rng.range(0.94, 1.07);
    switch (name) {
      case 'magRelease': this.play2D('mech:magRelease', { ...V, volume: 0.5, rate: r(), pan: this.rng.bi(0.2) }); break;
      case 'magDrop': this.play2D('mech:magOut', { ...V, volume: 0.62, rate: r(), pan: this.rng.range(-0.3, -0.05) }); break;
      case 'magNew': this.play2D('mech:magIn', { ...V, volume: 0.5, rate: r(), pan: this.rng.range(0.02, 0.28) }); break;
      case 'magSeated': this.play2D('mech:magSeated', { ...V, volume: 0.85, rate: r(), pan: this.rng.bi(0.12) }); break;
      case 'chargePull': this.play2D('mech:chargePull', { ...V, volume: 0.7, rate: r(), pan: this.rng.bi(0.16) }); break;
      case 'boltRelease':
      case 'boltForward': this.play2D('mech:boltRelease', { ...V, volume: 0.8, rate: r(), pan: this.rng.bi(0.12) }); break;
      case 'boltBack': this.play2D('mech:boltBack', { ...V, volume: 0.72, rate: r(), pan: this.rng.bi(0.12) }); break;
      case 'meleeHit': this.play2D('mech:melee', { ...V, volume: 0.85, rate: r() }); break;
      default: break;
    }
    // A dropped magazine hits the floor a beat later.
    if (name === 'magDrop') {
      const p = this.game?.player;
      const surf = canonicalSurface(p?.groundSurface || 'concrete');
      const kind = (surf === 'sand' || surf === 'dirt' || surf === 'foliage') ? 'dirt' : surf === 'metal' ? 'metal' : 'concrete';
      this._after(this.rng.range(0.30, 0.44), () => {
        const cam = this.game?.camera;
        if (!cam || !this.ready) return;
        this._v.set(this.rng.range(-0.3, 0.3), 0, -0.6).applyQuaternion(cam.quaternion);
        this._v.x += cam.position.x;
        this._v.z += cam.position.z;
        this._v.y = cam.position.y - 1.55;
        this.playAt(`shell:${kind}`, this._v, {
          bus: 'world', volume: 0.42, rate: this.rng.range(0.5, 0.62),
          refDistance: 1.4, rolloff: 1.6, occlude: false, send: 0.2,
        });
      });
    }
  }

  _onReload(e) {
    this.play2D('mech:cloth', { bus: 'weapons', volume: 0.3, rate: this.rng.range(0.95, 1.08), send: 0.14 });
    if (!this._reloadFallback) return;

    const def = this._weaponDef(e?.weapon);
    const empty = e && e.tactical === false;
    const T = (empty ? def?.reloadEmptyTime : def?.reloadTime) || (empty ? 2.7 : 2.1);
    this._after(T * 0.10, () => this._onClipEvent('magRelease'));
    this._after(T * 0.22, () => this._onClipEvent('magDrop'));
    this._after(T * 0.50, () => this._onClipEvent('magNew'));
    this._after(T * 0.63, () => this._onClipEvent('magSeated'));
    if (empty) this._after(T * 0.86, () => this._onClipEvent('boltRelease'));
  }

  _onSwitch() {
    this.play2D('mech:lower', { bus: 'weapons', volume: 0.5, rate: this.rng.range(0.95, 1.06), send: 0.12 });
    this._after(0.22, () => this.play2D('mech:raise', {
      bus: 'weapons', volume: 0.55, rate: this.rng.range(0.95, 1.06), send: 0.12,
    }));
  }

  /* ------------------------------------------------------------------ */
  /* projectiles                                                         */
  /* ------------------------------------------------------------------ */

  _onImpact(e) {
    if (!this.ready || !e?.point) return;
    const surf = canonicalSurface(e.surface);
    const dist = this.spatial.listenerPos.distanceTo(e.point);
    if (dist > 140) return;
    this.playAt(`impact:${surf}`, e.point, {
      bus: 'world',
      volume: (surf === 'flesh' ? 0.9 : 0.8) * this.rng.range(0.85, 1.1),
      rate: this.rng.range(0.88, 1.14),
      refDistance: 4,
      rolloff: 1.15,
      maxDistance: 200,
      send: 0.16 + 0.4 * this.spatial.enclosure,
      sendFar: 0.2,
    });
    // A close impact also throws a little debris past your feet.
    if (dist < 9 && surf !== 'flesh' && surf !== 'water' && this.rng.chance(0.35)) {
      this._after(this.rng.range(0.12, 0.3), () => {
        this.playAt(`impact:${surf === 'glass' ? 'glass' : 'dirt'}`, e.point, {
          bus: 'world', volume: 0.16, rate: this.rng.range(1.2, 1.7),
          refDistance: 3, rolloff: 1.4, send: 0.2,
        });
      });
    }
  }

  _onWhizby(e) {
    if (!this.ready) return;
    // Cap the rate: suppressing fire can fire this a dozen times a frame.
    if (this.clock - this._lastWhizby < 0.045) return;
    this._lastWhizby = this.clock;
    const dist = Math.max(0.2, e?.distance ?? 1.5);
    const close = clamp01(1 - dist / 4.5);
    this.play2D('whizby', {
      bus: 'world',
      volume: (0.22 + 0.7 * close) * this.rng.range(0.85, 1.12),
      // Faster playback = higher perceived doppler = "that one nearly hit me".
      rate: (0.94 + close * 0.24) * this.rng.range(0.95, 1.06),
      pan: this.rng.bi(0.9),
      lowpass: 3000 + 16000 * close,
      send: 0.10 + 0.35 * this.spatial.enclosure,
    });
    this.bumpIntensity(0.05 + 0.1 * close);
    if (close > 0.55) this.mixer.duckAmbience(0.7, 0.05, 0.3);
  }

  _onDebris(e) {
    if (!this.ready || !e?.point) return;
    if (this.clock - this._lastDebris < 0.05) return;
    if ((e.speed ?? 0) < 1.4) return;
    this._lastDebris = this.clock;
    const surf = canonicalSurface(e.surface);
    this.playAt(`impact:${surf}`, e.point, {
      bus: 'world',
      volume: Math.min(0.5, 0.06 + (e.speed ?? 1) * 0.035),
      rate: this.rng.range(1.05, 1.5),
      refDistance: 3,
      rolloff: 1.4,
      maxDistance: 90,
      send: 0.16,
    });
  }

  /* ------------------------------------------------------------------ */
  /* damage / death                                                      */
  /* ------------------------------------------------------------------ */

  _onDamageDealt(e) {
    if (!this.ready || !e?.point) return;
    this.bumpIntensity(0.05);
    this.playAt('impact:flesh', e.point, {
      bus: 'world', volume: e.headshot ? 0.95 : 0.7,
      rate: e.headshot ? this.rng.range(0.82, 0.92) : this.rng.range(0.95, 1.12),
      refDistance: 4, rolloff: 1.2, send: 0.14,
    });
  }

  _onDamageTaken(e) {
    if (!this.ready) return;
    const amt = e?.amount ?? 15;
    this.playUI('ui:damage', { volume: Math.min(0.85, 0.3 + amt / 70), rate: this.rng.range(0.92, 1.08) });
    this.body?.hurt(amt);
    this.bumpIntensity(0.22);
    this.mixer.duckAmbience(0.7, 0.08, 0.45);
  }

  _onHitmarker(e) {
    const name = e?.kill ? 'ui:hitmarkerKill' : e?.headshot ? 'ui:hitmarkerHead' : 'ui:hitmarker';
    this.playUI(name, { volume: e?.kill ? 0.55 : 0.4, rate: this.rng.range(0.97, 1.04) });
  }

  _onEnemyKilled(e) {
    this.bumpIntensity(0.16);
    const p = e?.point || e?.enemy?.position;
    if (!p || !this.ready) return;
    // Captured per kill: two enemies dying inside the delay window must not
    // both collapse at the second one's feet.
    const where = new THREE.Vector3().copy(p);
    this._after(this.rng.range(0.16, 0.42), () => {
      this.playAt('body:fall', where, {
        bus: 'world', volume: 0.6, rate: this.rng.range(0.92, 1.08),
        refDistance: 5, rolloff: 1.2, maxDistance: 120, send: 0.2, sendFar: 0.15,
      });
    });
  }

  _onEnemyFootstep(e) {
    if (!this.ready || !e?.position) return;
    const surf = canonicalSurface(e.surface);
    const gait = e.running ? 'run' : 'walk';
    this.playAt(`foot:${surf}:${gait}`, e.position, {
      bus: 'world', volume: (e.running ? 0.55 : 0.4) * this.rng.range(0.85, 1.1),
      rate: this.rng.range(0.9, 1.12), refDistance: 2.5, rolloff: 1.5,
      maxDistance: 45, send: 0.18 + 0.4 * this.spatial.enclosure,
    });
  }

  _onDied() {
    this.music?.setMode('dead');
    this.music?.sting('death');
    this.playUI('ui:death', { volume: 0.7 });
    this.body?.died();
    this.mixer?.duckAmbience(0.4, 0.6, 2.0);
  }

  /* ------------------------------------------------------------------ */
  /* player locomotion                                                   */
  /* ------------------------------------------------------------------ */

  _onFootstep(e) {
    if (!this.ready) return;
    const surf = canonicalSurface(e?.surface || this.game?.player?.groundSurface);
    const gait = e?.running ? 'run' : 'walk';
    const enclosure = this.spatial.enclosure;
    const vol = (e?.volume ?? 1) * (e?.running ? 0.52 : 0.34) * this.rng.range(0.85, 1.12);
    // Own footsteps are head-locked and alternate slightly across the stereo
    // field; spatialising them at the feet puts them behind the camera and
    // makes the player sound like somebody else is walking.
    this.play2D(`foot:${surf}:${gait}`, {
      bus: 'world',
      volume: vol,
      rate: this.rng.range(0.92, 1.10),
      pan: (e?.foot === 'left' ? -1 : 1) * this.rng.range(0.12, 0.26),
      lowpass: 20000,
      send: 0.12 + 0.55 * enclosure,
      sendFar: 0.12 * (1 - enclosure),
    });
  }

  _onLand(e) {
    if (!this.ready) return;
    const impact = clamp01((e?.impact ?? 0.4));
    const surf = canonicalSurface(this.game?.player?.groundSurface);
    this.play2D(`foot:${surf}:run`, {
      bus: 'world', volume: 0.4 + 0.55 * impact, rate: 0.78 - impact * 0.12,
      pan: this.rng.bi(0.1), send: 0.14 + 0.5 * this.spatial.enclosure,
    });
    this.play2D('mech:cloth', { bus: 'world', volume: 0.2 + 0.3 * impact, rate: 0.9, send: 0.1 });
    if (impact > 0.6) {
      this.play2D('mech:lower', { bus: 'weapons', volume: 0.25 * impact, rate: 1.2, send: 0.1 });
      this.body?.hurt(6 * impact);
    }
  }

  _onStance(e) {
    if (!this.ready || !e) return;
    const s = e.stance;
    if (s === 'crouch' || s === 'stand') {
      this.play2D('mech:cloth', {
        bus: 'world', volume: 0.22, rate: s === 'crouch' ? 0.9 : 1.05,
        pan: this.rng.bi(0.15), send: 0.12,
      });
    } else if (s === 'slide') {
      const surf = canonicalSurface(this.game?.player?.groundSurface);
      this.play2D(`foot:${surf}:run`, { bus: 'world', volume: 0.5, rate: 0.55, send: 0.2 });
      this.play2D('mech:cloth', { bus: 'world', volume: 0.4, rate: 0.7, send: 0.15 });
    }
  }

  /* ------------------------------------------------------------------ */
  /* explosions                                                          */
  /* ------------------------------------------------------------------ */

  _onExplosion(e) {
    if (!this.ready) return;
    const pos = e?.position;
    const power = e?.power ?? 1;
    const dist = pos ? this.spatial.listenerPos.distanceTo(pos) : 0;
    const near = clamp01(1 - dist / Math.max(6, (e?.radius ?? 8) * 2.2));
    const delay = Math.min(0.6, dist / 343);

    if (pos && dist > 4) {
      this.playAt('explosion', pos, {
        bus: 'weapons', volume: 1.2 * Math.min(1.6, power), rate: this.rng.range(0.9, 1.08),
        refDistance: 8, rolloff: 0.75, maxDistance: 800, delay,
        send: 0.2 + 0.4 * this.spatial.enclosure, sendFar: 0.75, airScale: 1.6,
      });
    } else {
      this.play2D('explosion', {
        bus: 'weapons', volume: 1.1 * Math.min(1.6, power), rate: this.rng.range(0.92, 1.05),
        pan: this.rng.bi(0.2), send: 0.25, sendFar: 0.6,
      });
    }

    // The city answering — arrives late and is what makes it feel outdoors.
    const far = this._tailFor('distant', 'sniper');
    if (far) {
      this.playBuffer(far, {
        bus: 'weapons', volume: 0.75 * Math.min(1.5, power) * (0.4 + 0.6 * (1 - this.spatial.enclosure)),
        rate: this.rng.range(0.82, 0.95), pan: this.rng.bi(0.35),
        delay: delay + 0.05, lowpass: 2600, send: 0,
      });
    }
    this._after(delay + 0.25, () => this.play2D('distant:boom', {
      bus: 'world', volume: 0.5 * Math.min(1.4, power), rate: this.rng.range(0.7, 0.9),
      pan: this.rng.bi(0.5), send: 0.1, sendFar: 0.6,
    }));

    if (near > 0.05) this.body?.concussion(near * Math.min(1.4, power));
    this.mixer.duckAmbience(0.25, 0.35, 1.6);
    this.bumpIntensity(0.4);
  }
}

export default AudioEngine;
