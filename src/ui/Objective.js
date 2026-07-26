/**
 * OPERATION BLACKOUT — objective banner, hints, score popups and streaks.
 *
 * The banner announces a new objective full width and then retires to a compact
 * status line under the compass; re-emitting the same objective text with new
 * progress updates the line without replaying the announcement, because the AI
 * system pings progress on every kill.
 */

import { clamp01, damp, lerp, rgba, Ease, COLOR } from './Style.js';
import { drawText, measure } from './Type.js';
import { envelope, chamferPath } from './Draw.js';

const STREAKS = ['', '', 'DOUBLE KILL', 'TRIPLE KILL', 'MULTI KILL', 'RAMPAGE', 'UNSTOPPABLE'];

export class ObjectiveHUD {
  constructor(game) {
    this.game = game;

    this.text = '';
    this.progress = -1;
    this.shownProgress = 0;
    this.bannerT = 999;
    this.lineFade = 0;

    this.hint = '';
    this.hintT = 999;
    this.hintDur = 0;

    this.popups = [];
    this.score = 0;
    this.displayScore = 0;
    this.scoreFlash = 0;

    this.streakCount = 0;
    this.streakTimer = 0;
    this.streakText = '';
    this.streakT = 999;
  }

  /* ------------------------------------------------------------------ */

  setObjective(e) {
    const text = String(e?.text || '').toUpperCase();
    if (!text) return;
    if (text !== this.text) {
      this.text = text;
      this.bannerT = 0;
    }
    if (e?.progress !== undefined && Number.isFinite(e.progress)) this.progress = clamp01(e.progress);
  }

  showHint(text, duration = 4.5) {
    if (!text) return;
    this.hint = String(text).toUpperCase();
    this.hintT = 0;
    this.hintDur = duration;
  }

  addScore(points, label, kind = 'kill') {
    this.score += points;
    this.scoreFlash = 1;
    this.popups.push({
      t: 0,
      life: 1.5,
      points,
      label: String(label || '').toUpperCase(),
      kind,
      lane: this.popups.length % 3,
      offset: this.popups.length * 3,
    });
    if (this.popups.length > 10) this.popups.shift();
  }

  registerKill() {
    this.streakTimer = 4.0;
    this.streakCount++;
    if (this.streakCount >= 2) {
      this.streakText = STREAKS[Math.min(this.streakCount, STREAKS.length - 1)];
      this.streakT = 0;
    }
  }

  /* ------------------------------------------------------------------ */

  update(dt) {
    this.bannerT += dt;
    this.hintT += dt;
    this.streakT += dt;

    const wantLine = !!this.text && this.bannerT > 2.6;
    this.lineFade = damp(this.lineFade, wantLine ? 1 : 0, 5, dt);
    if (this.progress >= 0) this.shownProgress = damp(this.shownProgress, this.progress, 6, dt);

    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i];
      p.t += dt;
      if (p.t >= p.life) this.popups.splice(i, 1);
    }

    this.displayScore = damp(this.displayScore, this.score, 8, dt);
    this.scoreFlash = damp(this.scoreFlash, 0, 4, dt);

    if (this.streakTimer > 0) {
      this.streakTimer -= dt;
      if (this.streakTimer <= 0) this.streakCount = 0;
    }
  }

  /* ------------------------------------------------------------------ */

  draw(ctx, view) {
    this._drawLine(ctx, view);
    this._drawBanner(ctx, view);
    this._drawStreak(ctx, view);
    this._drawPopups(ctx, view);
    this._drawHint(ctx, view);
  }

  /** Compact status line, tucked under the compass. */
  _drawLine(ctx, view) {
    const a = this.lineFade;
    if (a <= 0.02 || !this.text) return;
    const s = view.scale;
    const cx = view.w * 0.5;
    const y = view.pad * 0.45 + 76 * s;

    ctx.save();
    ctx.globalAlpha = a;
    const size = 10 * s;
    const w = measure(this.text, size, 0.42);
    drawText(ctx, this.text, cx, y, {
      size, weight: 0.15, tracking: 0.42, align: 'center',
      color: rgba(COLOR.ink, 0.82), halo: 1.4,
    });
    if (this.progress >= 0) {
      const bw = Math.max(w, 120 * s);
      const bx = cx - bw * 0.5;
      const by = y + 8 * s;
      ctx.fillStyle = 'rgba(6,10,13,0.6)';
      ctx.fillRect(bx, by, bw, 2.4 * s);
      ctx.fillStyle = rgba(COLOR.accent, 0.9);
      ctx.fillRect(bx, by, bw * this.shownProgress, 2.4 * s);
      drawText(ctx, `${Math.round(this.shownProgress * 100)}%`, cx + bw * 0.5 + 11 * s, by + 4.5 * s, {
        size: 8 * s, weight: 0.16, tracking: 0.2, color: rgba(COLOR.accent, 0.8), halo: 1.1,
      });
    }
    ctx.restore();
  }

  /** Full announcement. */
  _drawBanner(ctx, view) {
    const a = envelope(this.bannerT, 0.55, 2.6, 0.9);
    if (a <= 0.02) return;
    const s = view.scale;
    const cx = view.w * 0.5;
    const y = view.h * 0.30;
    const inT = clamp01(this.bannerT / 0.55);
    const slide = (1 - Ease.outQuint(inT)) * 26 * s;

    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(0, slide);

    const size = 26 * s;
    const w = measure(this.text, size, 0.36);
    const ruleW = Math.max(w * 0.62, 130 * s);

    drawText(ctx, 'OBJECTIVE', cx, y - 30 * s, {
      size: 9.5 * s, weight: 0.17, tracking: 0.85, align: 'center',
      color: rgba(COLOR.accent, 0.95), halo: 1.4,
    });

    // rules that wipe outward from behind the title, flanking it
    const wipe = Ease.outQuint(clamp01(this.bannerT / 0.7));
    const midY = y - size * 0.34;
    ctx.strokeStyle = rgba(COLOR.accent, 0.5);
    ctx.lineWidth = Math.max(1, 1.1 * s);
    ctx.beginPath();
    ctx.moveTo(cx - ruleW * 0.5 * wipe - w * 0.5 - 22 * s, midY);
    ctx.lineTo(cx - w * 0.5 - 18 * s, midY);
    ctx.moveTo(cx + w * 0.5 + 18 * s, midY);
    ctx.lineTo(cx + ruleW * 0.5 * wipe + w * 0.5 + 22 * s, midY);
    ctx.stroke();

    drawText(ctx, this.text, cx, y + 8 * s, {
      size, weight: 0.115, tracking: 0.36, align: 'center',
      color: rgba(COLOR.ink, 0.98), halo: 2.0, glow: 0.16, glowColor: COLOR.accent,
    });

    ctx.strokeStyle = rgba(COLOR.accent, 0.30);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - (w * 0.5 + 24 * s) * wipe, y + 20 * s);
    ctx.lineTo(cx + (w * 0.5 + 24 * s) * wipe, y + 20 * s);
    ctx.stroke();

    ctx.restore();
  }

  _drawStreak(ctx, view) {
    const a = envelope(this.streakT, 0.22, 1.0, 0.7);
    if (a <= 0.02 || !this.streakText) return;
    const s = view.scale;
    const cx = view.w * 0.5;
    const y = view.h * 0.40;
    const pop = Ease.outBack(clamp01(this.streakT / 0.22));
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(cx, y);
    ctx.scale(lerp(0.86, 1, pop), lerp(0.86, 1, pop));
    drawText(ctx, this.streakText, 0, 0, {
      size: 19 * s, weight: 0.13, tracking: 0.5, align: 'center',
      color: rgba(COLOR.accentHot, 1), halo: 1.9, glow: 0.3, glowColor: COLOR.accent,
    });
    ctx.restore();
  }

  _drawPopups(ctx, view) {
    const s = view.scale;
    const baseX = view.cx + 96 * s;
    const baseY = view.cy + 54 * s;

    for (const p of this.popups) {
      const k = clamp01(p.t / p.life);
      const rise = Ease.outQuart(k) * 52 * s;
      const alpha = k < 0.1 ? Ease.outCubic(k / 0.1) : (k > 0.62 ? 1 - Ease.inCubic((k - 0.62) / 0.38) : 1);
      if (alpha <= 0.02) continue;
      const x = baseX + p.offset * s;
      const y = baseY - rise;
      const col = p.kind === 'headshot' ? COLOR.accentHot : p.kind === 'assist' ? COLOR.friendly : COLOR.accent;

      ctx.save();
      ctx.globalAlpha = alpha;
      const pts = `+${p.points}`;
      const ptsW = measure(pts, 15 * s, 0.1);
      drawText(ctx, pts, x, y, {
        size: 15 * s, weight: 0.14, tracking: 0.1, color: rgba(col, 1), halo: 1.6,
        glow: 0.2, glowColor: col,
      });
      if (p.label) {
        drawText(ctx, p.label, x + ptsW + 8 * s, y - 1 * s, {
          size: 9.5 * s, weight: 0.16, tracking: 0.4, color: rgba(COLOR.ink, 0.85), halo: 1.3,
        });
      }
      ctx.restore();
    }

    // running score, parked clear above the ammo block
    if (this.score > 0) {
      const s2 = view.scale;
      const x = view.w - view.pad;
      const y = view.h - view.pad - 214 * s2;
      ctx.save();
      ctx.globalAlpha = 0.55 + this.scoreFlash * 0.45;
      drawText(ctx, 'SCORE', x - 52 * s2, y, {
        size: 8.5 * s2, weight: 0.16, tracking: 0.5, align: 'right',
        color: rgba(COLOR.inkFaint, 0.9), halo: 1.2,
      });
      drawText(ctx, String(Math.round(this.displayScore)).padStart(4, '0'), x, y, {
        size: 14 * s2, weight: 0.13, tracking: 0.14, align: 'right',
        color: rgba(COLOR.accent, 0.9 + this.scoreFlash * 0.1), halo: 1.4,
      });
      ctx.restore();
    }
  }

  _drawHint(ctx, view) {
    const a = envelope(this.hintT, 0.35, Math.max(0.3, this.hintDur), 0.6);
    if (a <= 0.02 || !this.hint) return;
    const s = view.scale;
    const cx = view.w * 0.5;
    const y = view.h * 0.72;
    const size = 11 * s;
    const w = measure(this.hint, size, 0.44);

    ctx.save();
    ctx.globalAlpha = a;
    chamferPath(ctx, cx - w * 0.5 - 14 * s, y - 15 * s, w + 28 * s, 24 * s, 6 * s);
    ctx.fillStyle = 'rgba(5,8,11,0.55)';
    ctx.fill();
    ctx.strokeStyle = rgba(COLOR.accent, 0.22);
    ctx.lineWidth = 1;
    ctx.stroke();
    drawText(ctx, this.hint, cx, y + 2.5 * s, {
      size, weight: 0.145, tracking: 0.44, align: 'center',
      color: rgba(COLOR.ink, 0.92), halo: 1.4,
    });
    ctx.restore();
  }
}
