/**
 * OPERATION BLACKOUT — dynamic crosshair.
 *
 * The reticle is not decorative: the gap between the strokes tracks the *actual*
 * projected radius of the weapon's spread cone at the current stance, movement
 * and accumulated bloom, converted through the live camera FOV. If the strokes
 * are wide, your bullets really are going wide.
 *
 * Two things are deliberate here:
 *
 *   · **It is tight.** The cone radius is mapped through `GAP_K` rather than
 *     used raw. Drawn 1:1 the strokes sit 25-40 px off centre even standing
 *     still, which reads as four lonely ticks around a large hole. Compressing
 *     the mapping and shortening the arms keeps the whole reticle inside a small
 *     disc while preserving the *ordering* — more spread is always more gap.
 *   · **Bloom is legible.** Firing and moving each add their own term on top of
 *     the weapon's cone, and past a threshold a faint ring is drawn at the arm
 *     tips. A reticle whose bloom you cannot see is just a static crosshair.
 *
 * Reads `game.weapons.weapon.spread(ctx)` when it exists and degrades to a
 * static reticle when the weapon system is still a placeholder.
 */

import { clamp, clamp01, damp, rgba, hair, Ease, Spring, COLOR } from './Style.js';

/** Projected cone radius -> drawn gap. Sub-1 keeps the reticle compact. */
const GAP_K = 0.55;
/** Innermost gap, design units — the dot needs breathing room, not a courtyard. */
const GAP_MIN = 3.0;
/** How far a full fire-kick / full sprint pushes the arms out, design units. */
const FIRE_BLOOM = 15;
const MOVE_BLOOM = 8;

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
    this.moveBloom = 0;      // 0..1, how much of the gap movement is paying for
    this.bloom = 0;          // 0..1, total non-resting bloom — drives the ring
    this._noAmmoBlink = 0;
  }

  onFire() {
    this.fireKick = Math.min(1.8, this.fireKick + 0.62);
    this.gap.nudge(150);
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
    this.spreadPx = clamp(px, 0, h * 0.30);

    this.fireKick = damp(this.fireKick, 0, 8, dt);

    // Movement bloom is computed here rather than left to the weapon so the
    // reticle still breathes when you run, whatever `spread()` chooses to model.
    const maxSpeed = player?.sprintSpeed || player?.maxSpeed || 6.2;
    const moving = clamp01((player?.speed ?? 0) / maxSpeed) * (1 - this.adsFade * 0.75);
    this.moveBloom = damp(this.moveBloom, player?.grounded === false ? 1 : moving, 7, dt);

    const s = ctxState.scale;
    const rest = GAP_MIN * s + this.spreadPx * GAP_K;
    const fire = clamp01(this.fireKick / 1.8);
    const bloomPx = fire * FIRE_BLOOM * s + this.moveBloom * MOVE_BLOOM * s;
    this.bloom = clamp01(bloomPx / (18 * s));

    this.gap.target = rest + bloomPx;
    this.gap.update(dt);
    // Arms grow a little with bloom so the reticle gains weight as it opens
    // instead of just drifting apart.
    this.len.target = clamp(6.5 * s + this.spreadPx * 0.20 + bloomPx * 0.30, 6 * s, 18 * s);
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
    // The spring is allowed to overshoot on a burst — that punch is the point —
    // but never far enough to fling the arms out of the middle of the frame.
    const gap = clamp(this.gap.value, GAP_MIN * s, view.h * 0.22);
    const len = this.len.value;
    const flash = clamp01(this.flash);
    const kill = clamp01(this.kill);

    const core = kill > 0.02
      ? rgba(COLOR.danger, 1)
      : (flash > 0.02 ? '#ffffff' : rgba(COLOR.ink, 0.94));
    // Heavier than before and scaled purely by `s`: the old
    // `Math.max(1.7, 2.2 * s)` floor is what made the reticle read thin at
    // 1080p and chunky at 540p.
    const lw = hair(s, 2.6) * (1 + flash * 0.45 + kill * 0.5);

    ctx.save();
    ctx.globalAlpha = a;
    ctx.lineCap = 'butt';

    // Bloom ring at the arm tips. Only present while the reticle is actually
    // open, so it reads as "you are spraying / you are running", not as chrome.
    if (this.bloom > 0.04) {
      const ringR = gap + len * 0.5;
      ctx.globalAlpha = a * 0.30 * this.bloom;
      ctx.strokeStyle = core;
      ctx.lineWidth = hair(s, 1.1);
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = a;
    }

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
    ctx.lineWidth = lw + hair(s, 2.6);
    ctx.stroke(path);
    ctx.strokeStyle = core;
    ctx.lineWidth = lw;
    ctx.stroke(path);

    // centre dot
    const dotR = (1.5 + this.dotPulse * 2.0) * s;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.arc(cx, cy, dotR + hair(s, 1.0), 0, Math.PI * 2);
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
      ctx.lineWidth = hair(s, 1.4);
      ctx.beginPath();
      ctx.arc(cx, cy, (gap + len) * 0.9 + (1 - b) * 12 * s, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }
}
