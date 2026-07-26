/**
 * OPERATION BLACKOUT — dynamic crosshair.
 *
 * The reticle is not decorative: the gap between the strokes is the *actual*
 * projected radius of the weapon's spread cone at the current stance, movement
 * and accumulated bloom, converted through the live camera FOV. If the strokes
 * are wide, your bullets really are going wide.
 *
 * Reads `game.weapons.weapon.spread(ctx)` when it exists and degrades to a
 * static reticle when the weapon system is still a placeholder.
 */

import { clamp, clamp01, damp, rgba, Ease, Spring, COLOR } from './Style.js';

export class Crosshair {
  constructor(game) {
    this.game = game;

    this.gap = new Spring(9, 210, 26);
    this.len = new Spring(7, 190, 24);
    this.opacity = 1;
    this.flash = 0;          // hit feedback brighten
    this.kill = 0;           // kill feedback tint
    this.fireKick = 0;
    this.spreadPx = 9;
    this.adsFade = 0;
    this.sprintFade = 0;
    this.dotPulse = 0;
    this._noAmmoBlink = 0;
  }

  onFire() {
    this.fireKick = Math.min(1.6, this.fireKick + 0.55);
    this.gap.nudge(120);
  }

  onHit(headshot, kill) {
    this.flash = 1;
    if (kill) this.kill = 1;
    if (headshot) this.flash = 1.25;
    this.dotPulse = 1;
  }

  onDryFire() {
    this._noAmmoBlink = 1;
  }

  /* ------------------------------------------------------------------ */

  update(dt, ctxState) {
    const g = this.game;
    const weapons = g.weapons;
    const weapon = weapons?.weapon;
    const player = g.player;

    const ads = clamp01(weapons?.adsAmount ?? 0);
    this.adsFade = damp(this.adsFade, ads, 18, dt);

    // --- projected spread radius -------------------------------------
    let coneRad = 0.028;
    if (weapon?.spread) {
      try {
        coneRad = weapon.spread({
          adsAmount: ads,
          speed: player?.speed ?? 0,
          grounded: player?.grounded !== false,
          crouched: player?.stance === 'crouch' || player?.crouched === true,
        });
      } catch { coneRad = 0.028; }
    }
    if (!Number.isFinite(coneRad)) coneRad = 0.028;

    const vfov = (g.camera?.fov ?? 70) * Math.PI / 180;
    const h = ctxState.h;
    const half = Math.tan(vfov * 0.5);
    const px = half > 1e-4 ? (h * 0.5) * Math.tan(coneRad) / half : 12;
    this.spreadPx = clamp(px, 4, h * 0.34);

    this.fireKick = damp(this.fireKick, 0, 9, dt);

    const s = ctxState.scale;
    this.gap.target = this.spreadPx + this.fireKick * 5 * s;
    this.gap.update(dt);
    this.len.target = clamp(9 * s + this.spreadPx * 0.14, 8 * s, 22 * s);
    this.len.update(dt);

    // --- visibility ---------------------------------------------------
    const sprinting = (player?.tacticalSprint || player?.sprinting) && !ads;
    this.sprintFade = damp(this.sprintFade, sprinting ? 1 : 0, 10, dt);

    this.flash = damp(this.flash, 0, 11, dt);
    this.kill = damp(this.kill, 0, 7, dt);
    this.dotPulse = damp(this.dotPulse, 0, 13, dt);
    this._noAmmoBlink = Math.max(0, this._noAmmoBlink - dt * 2.2);

    const alive = player?.alive !== false;
    const target = (!alive || g.state !== 'playing') ? 0 : 1;
    this.opacity = damp(this.opacity, target, 9, dt);
  }

  /* ------------------------------------------------------------------ */

  draw(ctx, view) {
    const a = this.opacity * (1 - this.adsFade * 0.94) * (1 - this.sprintFade * 0.62);
    if (a <= 0.01) return;

    const cx = view.cx;
    const cy = view.cy;
    const s = view.scale;
    const gap = Math.max(2, this.gap.value);
    const len = this.len.value;
    const flash = clamp01(this.flash);
    const kill = clamp01(this.kill);

    const core = kill > 0.02
      ? rgba(COLOR.danger, 1)
      : (flash > 0.02 ? '#ffffff' : rgba(COLOR.ink, 0.94));
    const lw = Math.max(1.7, 2.2 * s) * (1 + flash * 0.45 + kill * 0.5);

    ctx.save();
    ctx.globalAlpha = a;
    ctx.lineCap = 'butt';

    // dark backing so the reticle survives a bright skyline
    const path = new Path2D();
    const add = (x0, y0, x1, y1) => { path.moveTo(x0, y0); path.lineTo(x1, y1); };
    const r = Math.round(gap) + 0.5;
    const L = Math.round(len);
    add(cx - r, cy, cx - r - L, cy);
    add(cx + r, cy, cx + r + L, cy);
    add(cx, cy - r, cx, cy - r - L);
    add(cx, cy + r, cx, cy + r + L);

    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = lw + 2.2;
    ctx.stroke(path);
    ctx.strokeStyle = core;
    ctx.lineWidth = lw;
    ctx.stroke(path);

    // outward taper marks: a second, shorter pair sitting just outside the
    // main strokes gives the reticle body without thickening it.
    if (gap > 14 * s) {
      const t = clamp01((gap - 14 * s) / (34 * s));
      ctx.globalAlpha = a * 0.42 * t;
      const p2 = new Path2D();
      const r2 = r + L + 3 * s;
      p2.moveTo(cx - r2, cy - 0); p2.lineTo(cx - r2 - 3 * s, cy);
      p2.moveTo(cx + r2, cy - 0); p2.lineTo(cx + r2 + 3 * s, cy);
      ctx.strokeStyle = core;
      ctx.lineWidth = lw * 0.8;
      ctx.stroke(p2);
      ctx.globalAlpha = a;
    }

    // centre dot
    const dotR = (1.5 + this.dotPulse * 2.0) * s;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.arc(cx, cy, dotR + 1.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = kill > 0.02 ? rgba(COLOR.danger, 1) : rgba(COLOR.ink, 0.98);
    ctx.beginPath();
    ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
    ctx.fill();

    // empty-magazine tell: the reticle blinks amber for a beat on a dry trigger
    if (this._noAmmoBlink > 0.01) {
      const b = Ease.outCubic(this._noAmmoBlink);
      ctx.globalAlpha = a * b * 0.8;
      ctx.strokeStyle = rgba(COLOR.accent, 1);
      ctx.lineWidth = 1.4 * s;
      ctx.beginPath();
      ctx.arc(cx, cy, (gap + len) * 0.72 + (1 - b) * 12 * s, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }
}
