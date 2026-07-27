/**
 * OPERATION BLACKOUT — objective banner, hints, score popups and streaks.
 *
 * ## Where this lives on screen, and for how long
 *
 * The announcement is a *notification*, not furniture. It occupies a narrow band
 * in the upper third, directly beneath the compass strip, and it is strictly
 * transient: wipe in, hold, fade out, gone. It never sits on the reticle, and it
 * never outstays the moment it is announcing.
 *
 * Two rules keep that promise:
 *
 *   1. Nothing in the announcement band is anchored to the frame centre. The
 *      band is `BAND_*` design units below the compass, so it scales and moves
 *      with the safe area rather than with the middle of the screen.
 *   2. The envelope only advances while the HUD is actually on screen. The world
 *      emits `objective` during boot, long before the player is looking at
 *      anything; without this gate the banner burns its whole lifetime behind a
 *      menu and either never appears or appears frozen at full opacity for the
 *      first frames of play. A pending announcement waits, then plays once.
 *
 * After the banner retires the objective persists as a compact status line under
 * the compass. Re-emitting the same text with new progress updates that line
 * without replaying the announcement, because the AI pings progress on every
 * kill.
 */

import { clamp01, damp, lerp, rgba, hair, Ease, COLOR } from './Style.js';
import { drawText, measure, inkBleed } from './Type.js';
import { envelope, chamferPath } from './Draw.js';

const STREAKS = ['', '', 'DOUBLE KILL', 'TRIPLE KILL', 'MULTI KILL', 'RAMPAGE', 'UNSTOPPABLE'];

/* --- announcement timing (seconds) ---------------------------------- */
const BANNER_IN = 0.42;
const BANNER_HOLD = 2.8;
const BANNER_OUT = 0.75;
const BANNER_LIFE = BANNER_IN + BANNER_HOLD + BANNER_OUT;

const HINT_IN = 0.30;
const HINT_OUT = 0.55;

/* --- announcement band, in design units below the compass strip ------ */
const BAND_LINE = 20;     // compact status line
const BAND_KICKER = 44;   // 'OBJECTIVE' kicker
const BAND_TITLE = 64;    // objective title baseline
const BAND_HINT = 104;    // subtitle / contextual hint

/** Bottom of the compass strip (including its numeric heading), in px. */
function compassBottom(view) {
  return view.top + 56 * view.scale;
}

export class ObjectiveHUD {
  constructor(game) {
    this.game = game;

    this.text = '';
    this.progress = -1;
    this.shownProgress = 0;
    this.bannerT = BANNER_LIFE;   // "already retired"
    this.lineFade = 0;

    this.hint = '';
    this.hintT = 0;
    this.hintDur = 0;
    this.hintLife = 0;

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

  showHint(text, duration = 4.0) {
    if (!text) return;
    this.hint = String(text).toUpperCase();
    this.hintT = 0;
    this.hintDur = Math.max(0.3, duration);
    this.hintLife = HINT_IN + this.hintDur + HINT_OUT;
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
    // The announcement clock only runs while the player can actually see it.
    // `objective` is emitted from World.init and again on boot:complete, both of
    // which land while the title screen is still up.
    const onScreen = this.game.state === 'playing';

    if (onScreen && this.bannerT < BANNER_LIFE) this.bannerT += dt;
    this.streakT += dt;

    // A hint queued during the announcement waits for it rather than talking
    // over it — one line in the band at a time.
    const bannerBusy = this.bannerT < BANNER_LIFE - BANNER_OUT * 0.5;
    if (onScreen && !bannerBusy && this.hintT < this.hintLife) this.hintT += dt;

    // The status line only appears once the banner is completely gone, so the
    // band never carries two versions of the same sentence at once.
    const wantLine = !!this.text && this.bannerT >= BANNER_LIFE;
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
    const cx = view.cx;
    const y = compassBottom(view) + BAND_LINE * s;

    ctx.save();
    ctx.globalAlpha = a;
    const size = 9 * s;
    const w = measure(this.text, size, 0.42);
    drawText(ctx, this.text, cx, y, {
      size, weight: 0.15, tracking: 0.42, align: 'center',
      color: rgba(COLOR.ink, 0.78), halo: 1.4,
    });
    if (this.progress >= 0) {
      const bw = Math.max(w, 110 * s);
      const bx = cx - bw * 0.5;
      const by = y + 7 * s;
      ctx.fillStyle = 'rgba(6,10,13,0.6)';
      ctx.fillRect(bx, by, bw, 2.2 * s);
      ctx.fillStyle = rgba(COLOR.accent, 0.9);
      ctx.fillRect(bx, by, bw * this.shownProgress, 2.2 * s);
      drawText(ctx, `${Math.round(this.shownProgress * 100)}%`, cx + bw * 0.5 + 10 * s, by + 4 * s, {
        size: 7.5 * s, weight: 0.16, tracking: 0.2, color: rgba(COLOR.accent, 0.8), halo: 1.1,
      });
    }
    ctx.restore();
  }

  /**
   * The announcement. Compact, upper third, transient.
   *
   * Sized so the title is ~15 design units of cap height (a little over half
   * what it used to be) and auto-condensed if a long objective would otherwise
   * run wider than 44% of the frame. The whole block lives between the compass
   * and the top third line — the reticle sits ~28% of the frame below it.
   */
  _drawBanner(ctx, view) {
    const a = envelope(this.bannerT, BANNER_IN, BANNER_HOLD, BANNER_OUT);
    if (a <= 0.02 || !this.text) return;
    const s = view.scale;
    const cx = view.cx;
    const base = compassBottom(view);
    const yTitle = base + BAND_TITLE * s;
    const yKicker = base + BAND_KICKER * s;

    const inT = clamp01(this.bannerT / BANNER_IN);
    const rise = (1 - Ease.outQuint(inT)) * 10 * s;

    // Condense rather than overflow: the announcement is never allowed to run
    // wider than a comfortable measure, whatever the mission text says.
    let size = 15 * s;
    const maxW = view.w * 0.44;
    const natural = measure(this.text, size, 0.34);
    if (natural > maxW) size *= maxW / natural;
    const w = measure(this.text, size, 0.34);

    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(0, rise);

    drawText(ctx, 'OBJECTIVE', cx, yKicker, {
      size: 7.5 * s, weight: 0.18, tracking: 0.9, align: 'center',
      color: rgba(COLOR.accent, 0.95), halo: 1.3,
    });

    drawText(ctx, this.text, cx, yTitle, {
      size, weight: 0.12, tracking: 0.34, align: 'center',
      color: rgba(COLOR.ink, 0.98), halo: 1.8, glow: 0.14, glowColor: COLOR.accent,
    });

    // A single rule that wipes outward from the centre under the title. The old
    // banner flanked the text with rules as well, which at this size just reads
    // as noise.
    const wipe = Ease.outQuint(clamp01(this.bannerT / (BANNER_IN + 0.2)));
    const ruleW = (w * 0.5 + 14 * s) * wipe;
    const ruleY = Math.round(yTitle + 9 * s) + 0.5;
    const grad = ctx.createLinearGradient(cx - ruleW, 0, cx + ruleW, 0);
    grad.addColorStop(0, rgba(COLOR.accent, 0));
    grad.addColorStop(0.5, rgba(COLOR.accent, 0.55));
    grad.addColorStop(1, rgba(COLOR.accent, 0));
    ctx.strokeStyle = grad;
    ctx.lineWidth = hair(s, 1.1);
    ctx.beginPath();
    ctx.moveTo(cx - ruleW, ruleY);
    ctx.lineTo(cx + ruleW, ruleY);
    ctx.stroke();

    ctx.restore();
  }

  _drawStreak(ctx, view) {
    const a = envelope(this.streakT, 0.22, 1.0, 0.7);
    if (a <= 0.02 || !this.streakText) return;
    const s = view.scale;
    const cx = view.cx;
    // Above the reticle, not on it. Loud but short-lived.
    const y = view.h * 0.33;
    const pop = Ease.outBack(clamp01(this.streakT / 0.22));
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(cx, y);
    ctx.scale(lerp(0.86, 1, pop), lerp(0.86, 1, pop));
    drawText(ctx, this.streakText, 0, 0, {
      size: 15 * s, weight: 0.13, tracking: 0.5, align: 'center',
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
      const x = view.right - inkBleed(14 * s2, 0.13, 1.4);
      const y = view.bottom - 226 * s2;
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

  /**
   * Contextual subtitle. Same band as the banner, one step lower, same
   * transient contract — it used to be parked at 72% of the frame height, i.e.
   * straight through the lower half of the aim line.
   */
  _drawHint(ctx, view) {
    const a = envelope(this.hintT, HINT_IN, this.hintDur, HINT_OUT);
    if (a <= 0.02 || !this.hint) return;
    const s = view.scale;
    const cx = view.cx;
    const y = compassBottom(view) + BAND_HINT * s;

    let size = 8.5 * s;
    const maxW = view.w * 0.40;
    const natural = measure(this.hint, size, 0.44);
    if (natural > maxW) size *= maxW / natural;
    const w = measure(this.hint, size, 0.44);

    const padX = 10 * s;
    const boxH = 17 * s;

    ctx.save();
    ctx.globalAlpha = a;
    chamferPath(ctx, cx - w * 0.5 - padX, y - boxH * 0.72, w + padX * 2, boxH, 4.5 * s);
    ctx.fillStyle = 'rgba(5,8,11,0.5)';
    ctx.fill();
    ctx.strokeStyle = rgba(COLOR.accent, 0.20);
    ctx.lineWidth = hair(s, 1);
    ctx.stroke();
    drawText(ctx, this.hint, cx, y, {
      size, weight: 0.15, tracking: 0.44, align: 'center',
      color: rgba(COLOR.ink, 0.90), halo: 1.3,
    });
    ctx.restore();
  }
}
