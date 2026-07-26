/**
 * OPERATION BLACKOUT — hitmarkers and hit-confirm screen pulse.
 *
 * Three distinct reads, in the order a player learns them:
 *   body     four thin diagonal ticks, white, quick snap
 *   headshot an eight-point star with a diamond collar, heavier and warmer
 *   kill     red, rotated, with an expanding ring and a chromatic screen pulse
 *
 * The audio module already answers `hitmarker` with its own cue, so this draws
 * only; doubling the sound here would flam.
 */

import { clamp01, rgba, Ease, COLOR } from './Style.js';
import { glowDot } from './Draw.js';

const MAX = 10;

export class Hitmarkers {
  constructor(game) {
    this.game = game;
    this.marks = [];
    this.pulse = 0;        // chromatic ring strength
    this.pulseAge = 0;
    this.pulseKill = false;
    this.flashAge = 99;
    this.flashStrength = 0;
  }

  spawn(headshot, kill) {
    if (this.marks.length >= MAX) this.marks.shift();
    this.marks.push({
      t: 0,
      life: kill ? 0.62 : headshot ? 0.46 : 0.34,
      headshot: !!headshot,
      kill: !!kill,
      spin: kill ? (Math.random() - 0.5) * 0.22 : 0,
    });
    // Only a kill earns the chromatic pulse. Firing it on every headshot leaves
    // a clean ring on screen often enough that it starts reading as an artifact
    // rather than as feedback.
    if (kill) {
      this.pulse = 1;
      this.pulseAge = 0;
      this.pulseKill = true;
    }
    this.flashAge = 0;
    this.flashStrength = kill ? 0.34 : headshot ? 0.22 : 0.12;
  }

  update(dt) {
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const m = this.marks[i];
      m.t += dt;
      if (m.t >= m.life) this.marks.splice(i, 1);
    }
    if (this.pulse > 0) {
      this.pulseAge += dt;
      if (this.pulseAge > 0.30) this.pulse = 0;
    }
    this.flashAge += dt;
  }

  /* ------------------------------------------------------------------ */

  draw(ctx, view) {
    const cx = view.cx;
    const cy = view.cy;
    const s = view.scale;

    // --- chromatic confirm pulse -------------------------------------
    if (this.pulse > 0) {
      const k = clamp01(this.pulseAge / 0.30);
      const e = Ease.outQuart(k);
      const r = (14 + e * 62) * s;
      const a = (1 - k) * (1 - k) * this.pulse * 0.30;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = (2.0 + (1 - k) * 3.5) * s;
      const warm = this.pulseKill ? '#ff2f22' : '#ffd08a';
      const cool = this.pulseKill ? '#2ad8ff' : '#7fe4ff';
      ctx.strokeStyle = rgba(warm, a);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = rgba(cool, a * 0.65);
      ctx.beginPath();
      ctx.arc(cx, cy, r - 2.6 * s - e * 5 * s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // --- central flash -----------------------------------------------
    if (this.flashAge < 0.2 && this.flashStrength > 0) {
      const k = 1 - clamp01(this.flashAge / 0.2);
      glowDot(ctx, cx, cy, 74 * s, this.pulseKill ? COLOR.danger : '#ffe6b8', k * k * this.flashStrength);
    }

    // --- the marks themselves ----------------------------------------
    for (const m of this.marks) {
      const k = clamp01(m.t / m.life);
      const pop = m.t < 0.10 ? Ease.outBack(m.t / 0.10) : 1;
      const fade = k < 0.42 ? 1 : 1 - Ease.inCubic((k - 0.42) / 0.58);
      const alpha = fade;
      if (alpha <= 0.01) continue;

      const scale = (0.55 + 0.45 * pop) * (1 + k * 0.22);
      const gap = (m.kill ? 7.5 : m.headshot ? 6.5 : 5.6) * s * scale;
      const len = (m.kill ? 10.5 : m.headshot ? 10 : 7.6) * s * scale;
      const lw = (m.kill ? 3.0 : m.headshot ? 2.7 : 2.0) * s;
      const color = m.kill ? COLOR.danger : m.headshot ? '#fff3dd' : '#ffffff';

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(m.spin * (1 - fade));
      ctx.globalAlpha = alpha;
      ctx.lineCap = 'butt';

      const path = new Path2D();
      const diag = Math.SQRT1_2;
      for (let i = 0; i < 4; i++) {
        const ax = (i === 0 || i === 3) ? -diag : diag;
        const ay = (i < 2) ? -diag : diag;
        path.moveTo(ax * gap, ay * gap);
        path.lineTo(ax * (gap + len), ay * (gap + len));
      }
      if (m.headshot || m.kill) {
        // axis ticks turn the X into an eight-point star
        const g2 = gap * 1.02;
        const l2 = len * 0.58;
        path.moveTo(-g2, 0); path.lineTo(-g2 - l2, 0);
        path.moveTo(g2, 0); path.lineTo(g2 + l2, 0);
        path.moveTo(0, -g2); path.lineTo(0, -g2 - l2);
        path.moveTo(0, g2); path.lineTo(0, g2 + l2);
      }

      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = lw + 2.4;
      ctx.stroke(path);
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.stroke(path);

      if (m.headshot && !m.kill) {
        // collar diamond: the headshot's signature
        const d = (gap + len) * 0.86;
        ctx.globalAlpha = alpha * 0.75;
        ctx.strokeStyle = rgba(COLOR.accentHot, 1);
        ctx.lineWidth = Math.max(1.1, 1.5 * s);
        ctx.beginPath();
        ctx.moveTo(0, -d); ctx.lineTo(d, 0); ctx.lineTo(0, d); ctx.lineTo(-d, 0);
        ctx.closePath();
        ctx.stroke();
      }

      if (m.kill) {
        const rr = (gap + len) * (1.0 + Ease.outCubic(k) * 0.9);
        ctx.globalAlpha = alpha * 0.55 * (1 - k);
        ctx.strokeStyle = rgba(COLOR.danger, 1);
        ctx.lineWidth = Math.max(1.2, 2.0 * s);
        ctx.beginPath();
        ctx.arc(0, 0, rr, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();
    }
  }
}
