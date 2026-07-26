/**
 * OPERATION BLACKOUT — damage feedback.
 *
 * Two widgets that share a source of truth:
 *
 *   DamageIndicators — arcs at the edge of the reticle pointing at whoever is
 *     shooting you, in *camera* space so they stay honest while you turn.
 *   Vitals — the modern-shooter health read: no bar, a blood vignette and a
 *     desaturating, contracting screen that gets a heartbeat as you bleed out,
 *     plus a small numeric readout for players who want the number.
 *
 * The blood layers are baked once at boot into pre-tinted canvases; a
 * full-screen procedural splatter re-composited every frame would eat the
 * entire software-rasteriser budget on its own.
 */

import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, rgba, Ease, COLOR } from './Style.js';
import { bakeSplatter, makeCanvas, ctx2d } from './Draw.js';
import { drawText } from './Type.js';

const _v = new THREE.Vector3();
const _f = new THREE.Vector3();

/* ==================================================================== */
/* directional indicators                                                */
/* ==================================================================== */

export class DamageIndicators {
  constructor(game) {
    this.game = game;
    this.marks = [];
  }

  /** @param {{amount:number, from:THREE.Vector3|null}} e */
  add(e) {
    const cam = this.game.camera;
    const player = this.game.player;
    if (!cam) return;

    let bearing = null;
    const from = e?.from;
    if (from && Number.isFinite(from.x)) {
      const eye = player?.position
        ? _v.set(player.position.x, player.position.y + (player.eyeHeight ?? 1.63), player.position.z)
        : _v.copy(cam.position);
      _f.set(from.x - eye.x, 0, from.z - eye.z);
      if (_f.lengthSq() > 1e-5) {
        _f.normalize();
        const yaw = cam.rotation.y;
        // camera forward on the ground plane
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);
        const rx = Math.cos(yaw);
        const rz = -Math.sin(yaw);
        const dot = _f.x * fx + _f.z * fz;
        const side = _f.x * rx + _f.z * rz;
        bearing = Math.atan2(side, dot);   // 0 = dead ahead, +right
      }
    }
    if (bearing === null) bearing = (Math.random() - 0.5) * 0.5;

    const amount = clamp(e?.amount ?? 12, 1, 100);
    for (const m of this.marks) {
      if (Math.abs(m.bearing - bearing) < 0.36 && m.t < 1.1) {
        m.t = Math.min(m.t, 0.06);
        m.power = clamp01(m.power + amount / 90);
        m.bearing = lerp(m.bearing, bearing, 0.5);
        return;
      }
    }
    if (this.marks.length > 7) this.marks.shift();
    this.marks.push({ bearing, t: 0, life: 2.1, power: clamp01(0.35 + amount / 70) });
  }

  update(dt) {
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const m = this.marks[i];
      m.t += dt;
      if (m.t >= m.life) this.marks.splice(i, 1);
    }
  }

  draw(ctx, view) {
    if (!this.marks.length) return;
    const cx = view.cx;
    const cy = view.cy;
    const s = view.scale;
    const base = Math.min(view.w, view.h) * 0.185;

    for (const m of this.marks) {
      const k = clamp01(m.t / m.life);
      // punch out fast, then a long linear bleed-off
      const pop = m.t < 0.14 ? Ease.outQuart(m.t / 0.14) : 1;
      const fade = Math.pow(1 - k, 1.35);
      const a = fade * (0.70 + m.power * 0.30);
      if (a <= 0.012) continue;

      const r = base + (1 - pop) * 42 * s + k * 16 * s;
      const span = (0.30 + m.power * 0.11) * (1.25 - pop * 0.25);
      // canvas angles: 0 = +x (screen right); our bearing 0 must point up.
      const ang = m.bearing - Math.PI / 2;

      ctx.save();
      ctx.globalAlpha = a;
      ctx.lineCap = 'butt';

      const arcs = [
        { rr: r, span: span * 1.0, w: 8.0 * s * (0.6 + m.power * 0.6), al: 1.0 },
        { rr: r + 11 * s, span: span * 0.72, w: 3.0 * s, al: 0.6 },
        { rr: r - 10 * s, span: span * 0.48, w: 2.2 * s, al: 0.42 },
      ];
      for (const arc of arcs) {
        const grad = ctx.createLinearGradient(
          cx + Math.cos(ang - arc.span) * arc.rr, cy + Math.sin(ang - arc.span) * arc.rr,
          cx + Math.cos(ang + arc.span) * arc.rr, cy + Math.sin(ang + arc.span) * arc.rr,
        );
        grad.addColorStop(0, rgba(COLOR.dangerDeep, 0));
        grad.addColorStop(0.5, rgba(COLOR.danger, arc.al));
        grad.addColorStop(1, rgba(COLOR.dangerDeep, 0));
        ctx.strokeStyle = grad;
        ctx.lineWidth = arc.w;
        ctx.beginPath();
        ctx.arc(cx, cy, arc.rr, ang - arc.span, ang + arc.span);
        ctx.stroke();
      }

      // a hard notch at the centre of the arc reads as "this direction"
      ctx.globalAlpha = a * 0.9;
      ctx.strokeStyle = rgba('#ffd0c4', 0.9);
      ctx.lineWidth = 1.6 * s;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * (r - 3.5 * s), cy + Math.sin(ang) * (r - 3.5 * s));
      ctx.lineTo(cx + Math.cos(ang) * (r + 3.5 * s), cy + Math.sin(ang) * (r + 3.5 * s));
      ctx.stroke();
      ctx.restore();
    }
  }
}

/* ==================================================================== */
/* vitals: blood, desaturation, heartbeat, readout                       */
/* ==================================================================== */

export class Vitals {
  constructor(game) {
    this.game = game;

    this.health = 1;          // smoothed 0..1
    this.rawHealth = 1;
    this.hurt = 0;            // smoothed 1-health with a slow tail
    this.flash = 0;           // white-hot sting on the frame you get hit
    this.beatPhase = 0;
    this.beat = 0;
    this.regen = 0;
    this.readoutFade = 0;
    this.deathFade = 0;
    this.lowPulse = 0;

    /** Read by HUD and pushed into a CSS backdrop-filter. */
    this.desaturation = 0;
    this.contrast = 0;

    this._blood = null;       // pre-tinted, edge-masked splatter frame
    this._vig = null;         // pre-tinted vignette frame
  }

  /**
   * Bake two full-frame layers. Both are edge-masked at bake time: a splatter
   * canvas with visible borders would show its own rectangle as a seam once it
   * is stretched over the frame, which is exactly the tell we are avoiding.
   */
  bake() {
    this._blood = this._bakeBlood(512, 288);
    this._vig = this._bakeVig(320, 180);
    return this;
  }

  _bakeBlood(w, h) {
    const c = makeCanvas(w, h);
    const g = ctx2d(c);
    // three splatter passes at different scales and rotations
    for (let i = 0; i < 3; i++) {
      const mask = bakeSplatter(320, 0x51F3 + i * 977);
      g.save();
      g.globalAlpha = [0.95, 0.75, 0.55][i];
      const sx = [-0.06, 0.34, 0.10][i] * w;
      const sy = [-0.10, -0.04, 0.24][i] * h;
      const sw = [0.78, 0.74, 0.92][i] * w;
      const sh = [1.16, 1.10, 0.92][i] * h;
      g.drawImage(mask, sx, sy, sw, sh);
      g.restore();
    }
    this._maskToEdges(g, w, h, 0.56, 1.00, 1.25);
    g.globalCompositeOperation = 'source-in';
    const tint = g.createLinearGradient(0, 0, 0, h);
    tint.addColorStop(0, '#8e1d12');
    tint.addColorStop(0.5, '#6d130c');
    tint.addColorStop(1, '#4d0d08');
    g.fillStyle = tint;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'source-over';
    return c;
  }

  _bakeVig(w, h) {
    const c = makeCanvas(w, h);
    const g = ctx2d(c);
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);
    this._maskToEdges(g, w, h, 0.40, 1.04, 2.4);
    g.globalCompositeOperation = 'source-in';
    const tint = g.createRadialGradient(w * 0.5, h * 0.5, w * 0.18, w * 0.5, h * 0.5, w * 0.72);
    tint.addColorStop(0, '#5c1008');
    tint.addColorStop(0.6, '#33070a');
    tint.addColorStop(1, '#120306');
    g.fillStyle = tint;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'source-over';
    return c;
  }

  /**
   * Keep only what is near the frame edge, with an aspect-correct falloff.
   * The scale is `h/w`, not `w/h`: we are turning a circle of radius w/2 into
   * an ellipse whose vertical radius is h/2, so the top and bottom edges get
   * the same treatment as the sides on a 16:9 frame.
   */
  _maskToEdges(g, w, h, inner, outer, power = 1) {
    g.save();
    g.globalCompositeOperation = 'destination-in';
    g.translate(w * 0.5, h * 0.5);
    g.scale(1, h / w);
    const r = w * 0.5;
    const grad = g.createRadialGradient(0, 0, r * inner, 0, 0, r * outer);
    const steps = 8;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      grad.addColorStop(t, `rgba(0,0,0,${Math.pow(t, power).toFixed(4)})`);
    }
    grad.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = grad;
    // generous in the scaled space so the (compressed) corners are still covered
    const reach = w * w / h;
    g.fillRect(-reach, -reach, reach * 2, reach * 2);
    g.restore();
  }

  onDamage(amount) {
    this.flash = clamp01(this.flash + 0.35 + (amount ?? 10) / 60);
    this.readoutFade = 1;
  }

  update(dt) {
    const p = this.game.player;
    const max = p?.maxHealth ?? 100;
    const hp = p?.health;
    this.rawHealth = clamp01((Number.isFinite(hp) ? hp : max) / Math.max(1, max));

    this.health = damp(this.health, this.rawHealth, 9, dt);
    const targetHurt = Math.pow(1 - this.rawHealth, 1.15);
    // rises fast, recovers slowly — the screen "remembers" the wound
    this.hurt = damp(this.hurt, targetHurt, targetHurt > this.hurt ? 14 : 1.6, dt);

    this.flash = damp(this.flash, 0, 6.5, dt);

    // heartbeat accelerates as you bleed
    const bpm = lerp(66, 148, Math.pow(clamp01(this.hurt), 0.75));
    this.beatPhase = (this.beatPhase + dt * (bpm / 60)) % 1;
    const p1 = Math.exp(-Math.pow((this.beatPhase - 0.02) / 0.055, 2));
    const p2 = 0.62 * Math.exp(-Math.pow((this.beatPhase - 0.17) / 0.070, 2));
    this.beat = (p1 + p2) * clamp01(this.hurt * 1.4);

    this.regen = damp(this.regen, p?.vitals?.regenActive ? 1 : 0, 5, dt);
    this.lowPulse = (this.lowPulse + dt * lerp(0.9, 2.4, this.hurt)) % 1;

    const dead = p?.alive === false || this.game.state === 'dead';
    this.deathFade = damp(this.deathFade, dead ? 1 : 0, dead ? 2.4 : 6, dt);

    const showReadout = this.rawHealth < 0.999 || this.flash > 0.02;
    this.readoutFade = damp(this.readoutFade, showReadout ? 1 : 0.28, 4, dt);

    this.desaturation = clamp01(this.hurt * 0.82 + this.deathFade * 0.6);
    this.contrast = clamp01(this.hurt * 0.35);
  }

  /** Blood + vignette. Drawn *under* every other HUD element. */
  drawScreen(ctx, view) {
    const w = view.w;
    const h = view.h;
    const hurt = clamp01(this.hurt);
    const flash = clamp01(this.flash);

    // The vignette carries the read at every wound level; the splatter only
    // arrives once you are genuinely in trouble.
    const vigA = clamp01(hurt * 0.70 * (1 + this.beat * 0.30) + flash * 0.38 + this.deathFade * 0.80);
    const bloodA = clamp01((hurt - 0.30) / 0.70) * (0.68 + this.beat * 0.20)
      + flash * 0.34 + this.deathFade * 0.30;

    if (this._vig && vigA > 0.006) {
      ctx.save();
      ctx.globalAlpha = clamp01(vigA);
      // heartbeat breathes the vignette in and out by a couple of percent
      const k = 1 + this.beat * 0.035;
      const ow = w * k;
      const oh = h * k;
      ctx.drawImage(this._vig, (w - ow) * 0.5, (h - oh) * 0.5, ow, oh);
      ctx.restore();
    }

    if (this._blood && bloodA > 0.01) {
      ctx.save();
      ctx.globalAlpha = clamp01(bloodA);
      ctx.drawImage(this._blood, 0, 0, w, h);
      ctx.restore();
    }

    // --- hit sting ----------------------------------------------------
    if (flash > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(view.cx, view.cy, Math.min(w, h) * 0.22,
        view.cx, view.cy, Math.max(w, h) * 0.60);
      g.addColorStop(0, rgba('#ff2a18', 0));
      g.addColorStop(1, rgba('#ff2a18', flash * 0.26));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }

  /** Small numeric readout, bottom-left, above the stance/stamina strip. */
  drawReadout(ctx, view) {
    const s = view.scale;
    const a = clamp01(this.readoutFade) * (this.game.state === 'dead' ? 0.3 : 1);
    if (a <= 0.02) return;

    const x = view.pad;
    const bottom = view.h - view.pad;
    const numY = bottom - 20 * s;          // baseline of the big number
    const hp = Math.round(this.rawHealth * (this.game.player?.maxHealth ?? 100));
    const crit = this.rawHealth < 0.34;
    const blink = crit ? 0.72 + 0.28 * Math.sin(this.lowPulse * Math.PI * 2) : 1;
    const col = crit ? COLOR.danger : this.rawHealth < 0.7 ? COLOR.accent : COLOR.ink;

    ctx.save();
    ctx.globalAlpha = a;

    drawText(ctx, crit ? 'CRITICAL' : 'VITALS', x, numY - 32 * s, {
      size: 8.5 * s, weight: 0.16, tracking: 0.52,
      color: crit ? rgba(COLOR.danger, blink) : rgba(COLOR.inkDim, 0.85), halo: 1.2,
    });

    drawText(ctx, String(hp).padStart(3, '0'), x, numY, {
      size: 24 * s, weight: 0.135, tracking: 0.10, color: rgba(col, blink),
      glow: crit ? 0.35 * blink : 0, glowColor: col,
    });

    // hairline condition bar, optically centred on the numerals
    const bw = 104 * s;
    const bx = x + 72 * s;
    const by = numY - 12 * s;
    ctx.globalAlpha = a * 0.9;
    ctx.fillStyle = 'rgba(6,10,13,0.55)';
    ctx.fillRect(bx, by, bw, 4 * s);
    ctx.fillStyle = rgba(col, 0.9 * blink);
    ctx.fillRect(bx, by, bw * this.health, 4 * s);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    for (let i = 1; i < 5; i++) ctx.fillRect(bx + (bw * i) / 5, by, 1 * s, 4 * s);

    if (this.regen > 0.05 && this.rawHealth < 0.999) {
      ctx.globalAlpha = a * this.regen * (0.5 + 0.3 * Math.sin(this.lowPulse * Math.PI * 4));
      drawText(ctx, 'RECOVERING', bx, by + 16 * s, {
        size: 8 * s, weight: 0.16, tracking: 0.46, color: COLOR.friendly, halo: 1.1,
      });
    }
    ctx.restore();
  }

  /** Stamina / sprint strip — sits directly under the vitals readout. */
  drawStamina(ctx, view) {
    const p = this.game.player;
    const st = p?.stamina;
    const maxSt = p?.maxStamina;
    if (!Number.isFinite(st) || !Number.isFinite(maxSt) || maxSt <= 0) return;
    const ratio = clamp01(st / maxSt);
    const a = clamp01((1 - ratio) * 3.2) * 0.9;
    if (a <= 0.02) return;
    const s = view.scale;
    const bw = 176 * s;
    const bx = view.pad;
    const by = view.h - view.pad - 5 * s;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(6,10,13,0.5)';
    ctx.fillRect(bx, by, bw, 2.5 * s);
    ctx.fillStyle = rgba(ratio < 0.25 ? COLOR.danger : COLOR.inkDim, 0.95);
    ctx.fillRect(bx, by, bw * ratio, 2.5 * s);
    ctx.restore();
  }
}
