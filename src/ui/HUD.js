/**
 * OPERATION BLACKOUT — heads-up display.
 *
 * One 2D canvas over the WebGL surface, drawn every frame by hand. DOM was the
 * wrong tool here: the HUD needs sub-frame motion (spring-driven reticle,
 * hitmarker snap, sliding killfeed rows), it needs to be crisp at any device
 * pixel ratio, and it must not touch layout while the renderer is working.
 *
 * Everything visual is procedural — the typeface, the weapon silhouettes, the
 * blood splatter, the minimap plate. Nothing is fetched.
 *
 * Lifecycle contract (ARCHITECTURE.md): constructor(game) / init() /
 * update(dt, time) / lateUpdate(dt). Draw happens in lateUpdate so the camera
 * has already been finalised by the player rig this frame.
 *
 * Consumes: weapon:ammo, weapon:switch, weapon:reload, weapon:fire,
 *   weapon:dryfire, hitmarker, damage:taken, enemy:killed, player:died,
 *   player:spawn, objective, state.
 * Emits: nothing. The HUD is a pure observer.
 */

import { bus } from '../core/EventBus.js';
import { clamp, clamp01, damp, rgba, uiScale, COLOR } from './Style.js';
import { drawText } from './Type.js';
import { Crosshair } from './Crosshair.js';
import { Hitmarkers } from './Hitmarker.js';
import { DamageIndicators, Vitals } from './Damage.js';
import { AmmoPanel } from './Ammo.js';
import { Killfeed } from './Killfeed.js';
import { Compass } from './Compass.js';
import { Minimap } from './Minimap.js';
import { ObjectiveHUD } from './Objective.js';

export class HUD {
  constructor(game) {
    this.game = game;

    this.crosshair = new Crosshair(game);
    this.hitmarkers = new Hitmarkers(game);
    this.damage = new DamageIndicators(game);
    this.vitals = new Vitals(game);
    this.ammo = new AmmoPanel(game);
    this.killfeed = new Killfeed(game);
    this.compass = new Compass(game);
    this.minimap = new Minimap(game);
    this.objective = new ObjectiveHUD(game);

    this.visible = true;
    this.alpha = 0;
    this.introT = 0;
    this.time = 0;

    this.canvas = null;
    this.ctx = null;
    this.dpr = 1;
    this.view = { w: 1, h: 1, cx: 0.5, cy: 0.5, scale: 1, pad: 26, dpr: 1 };

    this._unsub = [];
    this._compassMarkers = [];
    this._gradeApplied = -1;
    this._hintedSpawn = false;
  }

  /* ================================================================== */
  /* boot                                                               */
  /* ================================================================== */

  async init() {
    const root = document.getElementById('ui-root') || document.body;
    this.root = root;

    // Backdrop grade layer sits *under* the HUD canvas so the overlay itself is
    // never desaturated along with the world.
    const grade = document.createElement('div');
    grade.id = 'hud-grade';
    grade.style.cssText = 'position:absolute;inset:0;pointer-events:none;display:none;';
    root.appendChild(grade);
    this.gradeEl = grade;

    const canvas = document.createElement('canvas');
    canvas.id = 'hud-canvas';
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
    root.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });

    this.vitals.bake();
    await this.minimap.init();

    this.resize();
    if (this.game.engine?.onResize) {
      this._unsub.push(this.game.engine.onResize(() => this.resize()));
    }
    this._onWinResize = () => this.resize();
    window.addEventListener('resize', this._onWinResize);

    this._bind();

    // Prime the ammo readout from whatever the weapon system already holds.
    const st = this.game.weapons?.ammoState?.();
    if (st) this.ammo.onAmmo(st);

    return this;
  }

  _bind() {
    const on = (name, fn) => this._unsub.push(bus.on(name, fn));

    on('weapon:ammo', (e) => this.ammo.onAmmo(e));
    on('weapon:switch', () => {
      this.ammo.onSwitch();
      const st = this.game.weapons?.ammoState?.();
      if (st) this.ammo.onAmmo(st);
    });
    on('weapon:firemode', () => this.ammo.onFireMode());
    on('weapon:reload', (e) => {
      const def = this.game.weapons?.weapon?.def;
      const dur = e?.tactical ? (def?.reloadTime ?? 1.9) : (def?.reloadEmptyTime ?? def?.reloadTime ?? 2.4);
      this.ammo.onReload(e, dur);
    });
    on('weapon:dryfire', () => this.crosshair.onDryFire());

    on('weapon:fire', (e) => {
      if (e?.hostile || e?.enemy) {
        // A hostile firing paints them onto the radar for a few seconds.
        const src = e.enemy?.position || e.origin;
        if (src) this.minimap.addContact(src, e.enemy?.yaw ?? 0, true);
        return;
      }
      this.crosshair.onFire();
    });

    on('hitmarker', (e) => {
      this.hitmarkers.spawn(!!e?.headshot, !!e?.kill);
      this.crosshair.onHit(!!e?.headshot, !!e?.kill);
    });

    on('damage:taken', (e) => {
      this.damage.add(e);
      this.vitals.onDamage(e?.amount ?? 10);
    });

    on('enemy:killed', (e) => this._onKill(e));

    on('player:died', () => {
      this.killfeed.push({
        attacker: 'HOSTILE', victim: this.killfeed.playerName,
        weapon: { id: 'rifle' }, headshot: false, victimIsPlayer: true,
      });
    });

    on('player:spawn', () => {
      this.objective.showHint('MOVE UP — [SHIFT] SPRINT · [F] INTERACT · [R] RELOAD', 5);
    });

    on('objective', (e) => this.objective.setObjective(e));

    on('state', ({ next }) => {
      if (next === 'playing' && !this._hintedSpawn) {
        this._hintedSpawn = true;
        this.objective.showHint('CONTACT EXPECTED — WATCH YOUR SECTORS', 5.5);
      }
    });
  }

  _isPlayerWeapon(w) {
    if (!w) return false;
    const list = this.game.weapons?.weapons;
    if (list?.length) {
      for (const cand of list) {
        if (cand === w || cand.def === w || cand.id === w.id) return true;
      }
      return false;
    }
    return w.id !== 'ak74m';
  }

  _onKill(e) {
    const byPlayer = this._isPlayerWeapon(e?.weapon);
    const victim = this.killfeed.nameFor(e?.enemy);
    // Squad-on-squad kills get a stable but varied attacker drawn from the same
    // callsign pool, offset so it can never collide with the victim's name.
    const squadId = ((e?.enemy?.id ?? 0) + 7) * 3 + 1;
    this.killfeed.push({
      attacker: byPlayer ? this.killfeed.playerName : this.killfeed.nameFor({ id: squadId }, 'HOSTILE'),
      victim,
      weapon: e?.weapon || { id: 'rifle' },
      headshot: !!e?.headshot,
      byPlayer,
    });
    if (byPlayer) {
      this.objective.addScore(e?.headshot ? 150 : 100, e?.headshot ? 'HEADSHOT' : 'KILL',
        e?.headshot ? 'headshot' : 'kill');
      this.objective.registerKill();
    }
  }

  /* ================================================================== */
  /* layout                                                             */
  /* ================================================================== */

  resize() {
    const engine = this.game.engine;
    const w = Math.max(2, engine?.width || window.innerWidth);
    const h = Math.max(2, engine?.height || window.innerHeight);
    const dpr = clamp(engine?.pixelRatio || window.devicePixelRatio || 1, 1, 2);
    if (!this.canvas) return;

    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    this.dpr = dpr;

    const scale = uiScale(w, h);
    this.view.w = w;
    this.view.h = h;
    this.view.cx = w * 0.5;
    this.view.cy = h * 0.5;
    this.view.scale = scale;
    this.view.pad = Math.round(clamp(28 * scale, 16, 60));
    this.view.dpr = dpr;
  }

  /* ================================================================== */
  /* per-frame                                                          */
  /* ================================================================== */

  update(dt, time) {
    const d = Math.min(dt || 0, 0.1);
    this.time = time?.now ?? (this.time + d);

    const state = this.game.state;
    const playing = state === 'playing' || state === 'dead';
    // Dead and paused both keep the HUD faintly present so the frame does not
    // lose its furniture, but neither competes with the overlay on top of it.
    const target = this.visible
      ? (state === 'playing' ? 1 : state === 'dead' ? 0.30 : state === 'paused' ? 0.26 : 0)
      : 0;
    this.alpha = damp(this.alpha, target, 11, d);
    // Snap the tail so a menu never shows a ghost of the HUD underneath it.
    if (Math.abs(this.alpha - target) < 0.02) this.alpha = target;
    if (!playing) this.introT = Math.min(this.introT, 0.9);
    if (playing) this.introT = Math.min(1.6, this.introT + d);

    this.crosshair.update(d, this.view);
    this.hitmarkers.update(d);
    this.damage.update(d);
    this.vitals.update(d);
    this.ammo.update(d);
    this.killfeed.update(d, this.view);
    this.compass.update(d);
    this.minimap.update(d, this.time);
    this.objective.update(d);

    this._applyGrade();
  }

  lateUpdate() {
    this.draw();
  }

  /** Screen-space desaturation driven by how hurt the player is. */
  _applyGrade() {
    const el = this.gradeEl;
    if (!el) return;
    // The threshold is deliberately high: backdrop-filter promotes the whole
    // frame to a composited readback, so it only earns its keep once the
    // desaturation is actually legible.
    const v = this.alpha > 0.05 && this.vitals.desaturation > 0.12 ? this.vitals.desaturation : 0;
    if (Math.abs(v - this._gradeApplied) < 0.025) return;
    this._gradeApplied = v;
    if (v <= 0.02) {
      el.style.display = 'none';
      return;
    }
    const sat = (1 - v * 0.72).toFixed(3);
    const contrast = (1 + this.vitals.contrast * 0.22).toFixed(3);
    const filter = `saturate(${sat}) contrast(${contrast})`;
    el.style.display = 'block';
    el.style.backdropFilter = filter;
    el.style.webkitBackdropFilter = filter;
  }

  /* ------------------------------------------------------------------ */

  draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const view = this.view;
    const dpr = this.dpr;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.alpha <= 0.01) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.lineJoin = 'miter';
    ctx.textBaseline = 'alphabetic';

    // Screen effects run at full strength even while the rest of the HUD fades:
    // pausing at 4 health should not look healthy.
    this._safe('vitals', () => this.vitals.drawScreen(ctx, view));

    const a = this.alpha;
    const intro = clamp01(this.introT / 0.9);
    const ease = intro * intro * (3 - 2 * intro);

    ctx.globalAlpha = a * ease;

    this._safe('minimap', () => {
      ctx.save();
      ctx.translate(-(1 - ease) * 26 * view.scale, 0);
      this.minimap.draw(ctx, view);
      ctx.restore();
    });

    this._safe('compass', () => {
      ctx.save();
      ctx.translate(0, -(1 - ease) * 20 * view.scale);
      this.compass.draw(ctx, view, this._buildCompassMarkers());
      ctx.restore();
    });

    this._safe('killfeed', () => this.killfeed.draw(ctx, view));
    this._safe('objective', () => this.objective.draw(ctx, view));

    this._safe('ammo', () => {
      ctx.save();
      ctx.translate(0, (1 - ease) * 22 * view.scale);
      this.ammo.draw(ctx, view);
      ctx.restore();
    });

    this._safe('readout', () => {
      ctx.save();
      ctx.translate(-(1 - ease) * 18 * view.scale, 0);
      this.vitals.drawReadout(ctx, view);
      this.vitals.drawStamina(ctx, view);
      ctx.restore();
    });

    ctx.globalAlpha = a;
    this._safe('damage', () => this.damage.draw(ctx, view));
    this._safe('crosshair', () => this.crosshair.draw(ctx, view));
    this._safe('hitmarkers', () => this.hitmarkers.draw(ctx, view));

    if (this.game.settings?.showFps) this._safe('fps', () => this._drawFps(ctx, view));

    ctx.restore();
  }

  _buildCompassMarkers() {
    const out = this._compassMarkers;
    out.length = 0;
    const p = this.game.player?.position;
    if (!p) return out;

    for (const o of this.minimap.objectives) {
      const dx = o.x - p.x;
      const dz = o.z - p.z;
      out.push({
        label: o.label,
        bearing: Math.atan2(dx, -dz),
        dist: Math.hypot(dx, dz),
        kind: 'objective',
        alpha: 1,
      });
    }
    for (const c of this.minimap.contacts) {
      const dx = c.x - p.x;
      const dz = c.z - p.z;
      out.push({
        bearing: Math.atan2(dx, -dz),
        dist: Math.hypot(dx, dz),
        kind: 'hostile',
        alpha: Math.pow(1 - clamp01(c.t / c.life), 0.7),
      });
    }
    return out;
  }

  _drawFps(ctx, view) {
    const s = view.scale;
    const fps = Math.round(this.game.time?.fps ?? 0);
    const calls = this.game.renderer?.info?.render?.calls ?? 0;
    const below = (this.minimap.rect?.y ?? view.pad) + (this.minimap.rect?.size ?? 200 * s) + 18 * s;
    ctx.save();
    ctx.globalAlpha = 0.7;
    drawText(ctx, `${fps} FPS · ${calls} DC`, view.pad, below, {
      size: 9 * s, weight: 0.15, tracking: 0.3,
      color: rgba(fps >= 55 ? COLOR.friendly : fps >= 30 ? COLOR.accent : COLOR.danger, 0.9),
      halo: 1.2,
    });
    ctx.restore();
  }

  _safe(label, fn) {
    try { fn(); } catch (err) { this._warn(label, err); }
  }

  _warn(label, err) {
    if (!this._warned) this._warned = new Set();
    if (this._warned.has(label)) return;
    this._warned.add(label);
    console.warn(`[HUD] ${label} draw failed`, err);
  }

  /* ================================================================== */
  /* public helpers other systems may call                               */
  /* ================================================================== */

  /** Contextual one-liner at the bottom of the screen. */
  hint(text, duration = 4.5) { this.objective.showHint(text, duration); }

  /** Manual killfeed insert, for scripted or non-AI kills. */
  notifyKill(opts) { this.killfeed.push(opts || {}); }

  setVisible(v) { this.visible = !!v; }

  dispose() {
    for (const off of this._unsub) { try { off?.(); } catch { /* already gone */ } }
    this._unsub.length = 0;
    if (this._onWinResize) window.removeEventListener('resize', this._onWinResize);
    this.canvas?.remove();
    this.gradeEl?.remove();
  }
}
