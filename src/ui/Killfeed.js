/**
 * OPERATION BLACKOUT — killfeed.
 *
 * Top right. Attacker, weapon silhouette, optional headshot mark, victim.
 * Rows slide in from the right on a spring, hold ~5 s, then collapse; the rows
 * beneath ease up into the gap rather than jumping, which is the difference
 * between a feed that reads as designed and one that reads as a log.
 */

import { clamp01, damp, rgba, Ease, Spring, COLOR } from './Style.js';
import { drawText, measure } from './Type.js';
import { chamferPath } from './Draw.js';
import { drawWeaponIcon, iconIdFor } from './WeaponIcons.js';

const CALLSIGNS = [
  'VIPER', 'JACKAL', 'KESTREL', 'MARAUDER', 'ONYX', 'CINDER', 'HAVOC', 'RAVEN',
  'DRIFTER', 'WARLOCK', 'SABLE', 'GHOUL', 'REAPER', 'THORN', 'BRIAR', 'VULTURE',
];

const LIFETIME = 5.0;

export class Killfeed {
  constructor(game) {
    this.game = game;
    this.rows = [];
    this.playerName = 'BRAVO SIX';
    this._names = new Map();
  }

  nameFor(entity, fallback = 'HOSTILE') {
    if (!entity) return fallback;
    if (entity.callsign) return String(entity.callsign).toUpperCase();
    const key = entity.id ?? entity.name ?? entity;
    let n = this._names.get(key);
    if (!n) {
      const idx = typeof key === 'number' ? key : Math.abs(String(key).split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7));
      n = `${CALLSIGNS[idx % CALLSIGNS.length]}-${String((idx * 7) % 90 + 10)}`;
      this._names.set(key, n);
    }
    return n;
  }

  /**
   * @param {Object} e {attacker, victim, weapon, headshot, byPlayer, victimIsPlayer}
   */
  push(e) {
    const row = {
      attacker: (e.attacker || 'UNKNOWN').toUpperCase(),
      victim: (e.victim || 'UNKNOWN').toUpperCase(),
      icon: iconIdFor(e.weapon),
      headshot: !!e.headshot,
      byPlayer: !!e.byPlayer,
      victimIsPlayer: !!e.victimIsPlayer,
      t: 0,
      slide: new Spring(0, 200, 22),
      y: null,
      yTarget: 0,
      alpha: 0,
    };
    row.slide.target = 1;
    this.rows.push(row);
    if (this.rows.length > 6) this.rows.shift();
  }

  update(dt, view) {
    const s = view.scale;
    const rowH = 23 * s;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const r = this.rows[i];
      r.t += dt;
      if (r.t > LIFETIME + 0.5) this.rows.splice(i, 1);
    }
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      r.slide.update(dt);
      r.yTarget = i * rowH;
      r.y = (r.y === null) ? r.yTarget : damp(r.y, r.yTarget, 16, dt);
      const fadeIn = clamp01(r.t / 0.18);
      const fadeOut = r.t > LIFETIME ? 1 - clamp01((r.t - LIFETIME) / 0.45) : 1;
      r.alpha = Ease.outCubic(fadeIn) * fadeOut;
    }
  }

  draw(ctx, view) {
    if (!this.rows.length) return;
    const s = view.scale;
    const right = view.w - view.pad;
    const top = view.pad + 2 * s;
    const rowH = 23 * s;
    const fs = 11 * s;
    const tracking = 0.22;

    for (const r of this.rows) {
      if (r.alpha <= 0.015) continue;
      const y = top + r.y;
      const slideOff = (1 - Ease.outCubic(clamp01(r.slide.value))) * 46 * s;

      const aName = r.byPlayer ? COLOR.accent : rgba(COLOR.ink, 0.92);
      const vName = r.victimIsPlayer ? COLOR.danger : rgba(COLOR.hostile, 0.92);

      const attW = measure(r.attacker, fs, tracking);
      const vicW = measure(r.victim, fs, tracking);
      const iconW = 34 * s;
      const skullW = r.headshot ? 13 * s : 0;
      const padIn = 8 * s;
      const totalW = attW + padIn + iconW + (skullW ? skullW + 5 * s : 0) + padIn + vicW;

      const x0 = right - totalW - slideOff;
      const cy = y + rowH * 0.5;

      ctx.save();
      ctx.globalAlpha = r.alpha;

      // backing plate
      const plw = totalW + 18 * s;
      chamferPath(ctx, x0 - 9 * s, y + 1.5 * s, plw, rowH - 4 * s, 5 * s, 0b0110);
      ctx.fillStyle = r.byPlayer ? 'rgba(30,20,6,0.52)' : 'rgba(6,10,13,0.44)';
      ctx.fill();
      if (r.byPlayer) {
        ctx.strokeStyle = rgba(COLOR.accent, 0.30);
        ctx.lineWidth = Math.max(1, 1 * s);
        ctx.stroke();
      }

      let x = x0;
      drawText(ctx, r.attacker, x, cy + fs * 0.42, {
        size: fs, weight: 0.14, tracking, color: aName, halo: 1.3,
      });
      x += attW + padIn;

      drawWeaponIcon(ctx, r.icon, x, cy, iconW, rgba(COLOR.ink, 0.85), 0.95, { flip: true });
      x += iconW;

      if (r.headshot) {
        x += 5 * s;
        drawSkull(ctx, x, cy, skullW, rgba(COLOR.accentHot, 0.95));
        x += skullW;
      }
      x += padIn;

      drawText(ctx, r.victim, x, cy + fs * 0.42, {
        size: fs, weight: 0.14, tracking, color: vName, halo: 1.3,
      });

      ctx.restore();
    }
  }
}

/** Compact skull mark used for headshot kills. */
function drawSkull(ctx, x, cy, w, color) {
  const h = w * 1.06;
  const y = cy - h * 0.5;
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(2,4,6,0.55)';
  ctx.lineWidth = Math.max(1, w * 0.10);
  const p = new Path2D();
  // cranium
  p.moveTo(x + w * 0.12, y + h * 0.42);
  p.lineTo(x + w * 0.22, y + h * 0.10);
  p.lineTo(x + w * 0.78, y + h * 0.10);
  p.lineTo(x + w * 0.88, y + h * 0.42);
  p.lineTo(x + w * 0.78, y + h * 0.62);
  p.lineTo(x + w * 0.66, y + h * 0.62);
  p.lineTo(x + w * 0.64, y + h * 0.86);
  p.lineTo(x + w * 0.36, y + h * 0.86);
  p.lineTo(x + w * 0.34, y + h * 0.62);
  p.lineTo(x + w * 0.22, y + h * 0.62);
  p.closePath();
  ctx.stroke(p);
  ctx.fill(p);
  // sockets and nasal aperture, drawn dark rather than punched so the mark
  // never cuts a hole in the plate behind it
  ctx.fillStyle = 'rgba(4,7,10,0.92)';
  ctx.fillRect(x + w * 0.24, y + h * 0.28, w * 0.20, h * 0.20);
  ctx.fillRect(x + w * 0.56, y + h * 0.28, w * 0.20, h * 0.20);
  ctx.fillRect(x + w * 0.44, y + h * 0.60, w * 0.12, h * 0.16);
  ctx.restore();
}
