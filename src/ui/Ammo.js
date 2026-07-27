/**
 * OPERATION BLACKOUT — ammunition and weapon status block.
 *
 * Bottom right, in the stencil face: magazine over reserve, a segmented round
 * strip that empties left to right, the weapon's name and class, a fire-mode
 * chip and a drawn silhouette of the gun in your hands. Low ammo turns the
 * numbers amber, empty turns them red and raises the reload prompt.
 *
 * State comes from the `weapon:ammo` / `weapon:switch` / `weapon:reload`
 * events, with `game.weapons.weapon` used only for names and fire mode.
 */

import { clamp, clamp01, damp, rgba, hair, Ease, Spring, COLOR } from './Style.js';
import { drawText, measure, inkBleed } from './Type.js';
import { chamferPath } from './Draw.js';
import { drawWeaponIcon, iconIdFor } from './WeaponIcons.js';

export class AmmoPanel {
  constructor(game) {
    this.game = game;

    this.mag = 0;
    this.reserve = 0;
    this.max = 1;
    this.displayMag = 0;
    this.displayReserve = 0;

    this.punch = new Spring(0, 260, 20);
    this.slide = new Spring(1, 150, 19);   // 1 = docked, 0 = off-screen right
    this.reloadT = 0;
    this.reloading = false;
    this.reloadDur = 1;
    this.promptPulse = 0;
    this.lowPulse = 0;
    this.modeFlash = 0;
    this._lastMag = 0;
    this._segFlash = new Float32Array(64);
  }

  onAmmo(e) {
    const mag = e?.mag ?? 0;
    if (mag !== this.mag) {
      this.punch.nudge(mag < this.mag ? 9 : 16);
      if (mag < this.mag) {
        for (let i = mag; i < Math.min(this.mag, this._segFlash.length); i++) this._segFlash[i] = 1;
      }
    }
    this.mag = mag;
    this.reserve = e?.reserve ?? this.reserve;
    this.max = Math.max(1, e?.max ?? this.max);
  }

  onSwitch() {
    this.slide.value = 0.12;
    this.slide.velocity = 0;
    this.punch.nudge(10);
  }

  onReload(e, duration = 1.6) {
    this.reloading = true;
    this.reloadT = 0;
    this.reloadDur = Math.max(0.35, duration);
    this.tactical = !!e?.tactical;
  }

  onFireMode() { this.modeFlash = 1; }

  /* ------------------------------------------------------------------ */

  update(dt) {
    const w = this.game.weapons;
    const weapon = w?.weapon;
    if (weapon) {
      // The event is authoritative, but a placeholder weapon system that never
      // emits still gets a readout from polling.
      if (this.max <= 1 && weapon.magSize) {
        this.mag = weapon.mag ?? 0;
        this.reserve = weapon.reserve ?? 0;
        this.max = weapon.magSize;
      }
    }

    this.displayMag = damp(this.displayMag, this.mag, 26, dt);
    this.displayReserve = damp(this.displayReserve, this.reserve, 14, dt);
    this.punch.target = 0;
    this.punch.update(dt);
    this.slide.target = 1;
    this.slide.update(dt);

    if (this.reloading) {
      this.reloadT += dt;
      const busy = w?.state === 'reloading';
      if (this.reloadT > this.reloadDur && !busy) this.reloading = false;
      if (this.reloadT > this.reloadDur * 2.6) this.reloading = false;
    }

    this.promptPulse = (this.promptPulse + dt * 1.9) % 1;
    this.lowPulse = (this.lowPulse + dt * 2.6) % 1;
    this.modeFlash = damp(this.modeFlash, 0, 5, dt);
    for (let i = 0; i < this._segFlash.length; i++) {
      if (this._segFlash[i] > 0) this._segFlash[i] = Math.max(0, this._segFlash[i] - dt * 3.4);
    }
  }

  /* ------------------------------------------------------------------ */

  draw(ctx, view) {
    const w = this.game.weapons;
    const weapon = w?.weapon;
    const s = view.scale;
    // The reserve numerals are the widest-stroked thing hugging the right edge;
    // everything in the block shares their anchor so the whole column lines up.
    const right = view.right - inkBleed(19 * s, 0.13, 1.4);
    const bottom = view.bottom;

    const slide = clamp01(this.slide.value);
    const dx = (1 - Ease.outCubic(slide)) * 120 * s;
    const alpha = Ease.outCubic(slide) * (this.game.state === 'dead' ? 0.25 : 1);
    if (alpha <= 0.02) return;

    const magSize = Math.max(1, this.max);
    const ratio = clamp01(this.mag / magSize);
    const empty = this.mag <= 0;
    const low = ratio <= 0.3;
    const blink = empty
      ? 0.55 + 0.45 * Math.sin(this.promptPulse * Math.PI * 2)
      : low ? 0.78 + 0.22 * Math.sin(this.lowPulse * Math.PI * 2) : 1;
    const numColor = empty ? COLOR.danger : low ? COLOR.accent : COLOR.ink;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(dx, 0);

    /* --- vertical rhythm, stacked up from the bottom margin --------- */
    const magSizePx = 52 * s * (1 + this.punch.value * 0.006);
    const resSizePx = 19 * s;
    const stripH = 3.4 * s;
    const stripY = bottom - stripH;
    const baseY = stripY - 13 * s;                     // numeral baseline
    const infoY = baseY - magSizePx - 15 * s;          // class + fire mode
    const nameY = infoY - 18 * s;                      // weapon name

    /* --- numbers --------------------------------------------------- */
    const magText = String(Math.max(0, Math.round(this.mag))).padStart(2, '0');
    const resText = String(Math.max(0, Math.round(this.reserve))).padStart(3, '0');

    const resW = measure(resText, resSizePx, 0.12);
    const slashW = measure('/', magSizePx * 0.58, 0.1);

    const resX = right;
    drawText(ctx, resText, resX, baseY, {
      size: resSizePx, weight: 0.13, tracking: 0.12, align: 'right',
      color: rgba(COLOR.inkDim, 0.92), halo: 1.4,
    });

    const slashX = resX - resW - 15 * s;
    ctx.save();
    ctx.globalAlpha *= 0.5;
    drawText(ctx, '/', slashX, baseY, {
      size: magSizePx * 0.58, weight: 0.09, align: 'right', color: COLOR.inkFaint, halo: 1.2,
    });
    ctx.restore();

    const magX = slashX - slashW - 14 * s;
    drawText(ctx, magText, magX, baseY, {
      size: magSizePx, weight: 0.125, tracking: 0.06, align: 'right',
      color: rgba(numColor, blink), halo: 2.0,
      glow: empty ? 0.5 * blink : low ? 0.28 : 0.10,
      glowColor: numColor,
    });
    const magW = measure(magText, magSizePx, 0.06);
    const groupLeft = magX - magW;

    /* --- segmented round strip -------------------------------------- */
    const stripW = Math.min(right - groupLeft, 200 * s);
    const stripX = right - stripW;
    const segCount = clamp(magSize, 1, 42);
    const gapSeg = hair(s, 1.4);
    const segW = (stripW - gapSeg * (segCount - 1)) / segCount;
    const perSeg = magSize / segCount;
    for (let i = 0; i < segCount; i++) {
      const filled = (i + 1) * perSeg <= this.mag + 0.001;
      const partial = !filled && i * perSeg < this.mag;
      const x = stripX + i * (segW + gapSeg);
      const flash = this._segFlash[Math.min(this._segFlash.length - 1, Math.round(i * perSeg))] || 0;
      ctx.globalAlpha = alpha * (filled ? 0.95 : partial ? 0.6 : 0.20);
      ctx.fillStyle = filled || partial
        ? rgba(empty ? COLOR.danger : low ? COLOR.accent : COLOR.ink, 1)
        : rgba(COLOR.inkFaint, 1);
      ctx.fillRect(x, stripY, partial ? segW * clamp01((this.mag - i * perSeg) / perSeg) : segW, stripH);
      if (flash > 0.01) {
        ctx.globalAlpha = alpha * flash * 0.9;
        ctx.fillStyle = rgba(COLOR.accentHot, 1);
        ctx.fillRect(x, stripY - 1 * s, segW, stripH + 2 * s);
      }
    }
    ctx.globalAlpha = alpha;

    /* --- reload state: parked in the clear space left of the numerals -- */
    const promptRight = groupLeft - 26 * s;
    if (this.reloading) {
      const k = clamp01(this.reloadT / this.reloadDur);
      ctx.globalAlpha = alpha * 0.95;
      ctx.fillStyle = 'rgba(6,10,13,0.7)';
      ctx.fillRect(stripX, stripY, stripW, stripH);
      ctx.fillStyle = rgba(COLOR.accent, 1);
      ctx.fillRect(stripX, stripY, stripW * Ease.outQuad(k), stripH);
      ctx.globalAlpha = alpha * (0.6 + 0.4 * Math.sin(this.promptPulse * Math.PI * 4));
      drawText(ctx, 'RELOADING', promptRight, baseY - 6 * s, {
        size: 11 * s, weight: 0.16, tracking: 0.5, align: 'right', color: COLOR.accent, halo: 1.4,
      });
      ctx.globalAlpha = alpha;
    } else if (empty && this.reserve > 0) {
      const pulse = 0.5 + 0.5 * Math.sin(this.promptPulse * Math.PI * 2);
      const chipW = 21 * s;
      const chipH = 16 * s;
      const labelW = measure('RELOAD', 11 * s, 0.5);
      const x0 = promptRight - (chipW + 10 * s + labelW);
      const py = baseY - 6 * s;
      ctx.globalAlpha = alpha * (0.7 + 0.3 * pulse);
      chamferPath(ctx, x0, py - 12 * s, chipW, chipH, 3.5 * s);
      ctx.fillStyle = rgba(COLOR.danger, 0.16);
      ctx.fill();
      ctx.strokeStyle = rgba(COLOR.danger, 0.85);
      ctx.lineWidth = hair(s, 1.1);
      ctx.stroke();
      drawText(ctx, 'R', x0 + chipW * 0.5, py - 3.6 * s, {
        size: 9 * s, weight: 0.18, tracking: 0, align: 'center', color: COLOR.danger, halo: false,
      });
      ctx.globalAlpha = alpha * (0.55 + 0.45 * pulse);
      drawText(ctx, 'RELOAD', x0 + chipW + 10 * s, py, {
        size: 11 * s, weight: 0.16, tracking: 0.5, color: COLOR.danger, halo: 1.4,
      });
      ctx.globalAlpha = alpha;
    }

    /* --- weapon identity -------------------------------------------- */
    const name = weapon?.displayName || weapon?.name || 'UNARMED';
    const cls = weapon?.className || '';
    const mode = (weapon?.fireMode || '').toUpperCase();

    drawText(ctx, name, right, nameY, {
      size: 15 * s, weight: 0.115, tracking: 0.30, align: 'right',
      color: rgba(COLOR.ink, 0.95), halo: 1.6,
    });

    let cursorX = right;
    if (mode) {
      const mw = measure(mode, 9.5 * s, 0.44);
      const chipW = mw + 16 * s;
      const chipH = 15 * s;
      const chipY = infoY - chipH + 3 * s;
      const flash = clamp01(this.modeFlash);
      chamferPath(ctx, right - chipW, chipY, chipW, chipH, 4 * s);
      ctx.fillStyle = rgba(COLOR.accent, 0.10 + flash * 0.30);
      ctx.fill();
      ctx.strokeStyle = rgba(COLOR.accent, 0.42 + flash * 0.5);
      ctx.lineWidth = hair(s, 1.1);
      ctx.stroke();
      drawText(ctx, mode, right - chipW * 0.5, chipY + chipH * 0.5 + 3.4 * s, {
        size: 9.5 * s, weight: 0.155, tracking: 0.44, align: 'center',
        color: rgba(COLOR.accentHot, 0.7 + flash * 0.3), halo: false,
      });
      cursorX = right - chipW - 12 * s;
    }
    if (cls) {
      drawText(ctx, cls, cursorX, infoY, {
        size: 9 * s, weight: 0.15, tracking: 0.46, align: 'right',
        color: rgba(COLOR.inkFaint, 0.95), halo: 1.2,
      });
    }

    // hairline under the name, tying the block together
    ctx.globalAlpha = alpha * 0.5;
    const ruleW = Math.min(230 * s, stripW);
    const ruleGrad = ctx.createLinearGradient(right - ruleW, 0, right, 0);
    ruleGrad.addColorStop(0, rgba(COLOR.accent, 0));
    ruleGrad.addColorStop(1, rgba(COLOR.accent, 0.55));
    ctx.fillStyle = ruleGrad;
    ctx.fillRect(right - ruleW, nameY + 7 * s, ruleW, hair(s, 1));
    ctx.globalAlpha = alpha;

    /* --- silhouette --------------------------------------------------- */
    if (weapon) {
      const iw = 132 * s;
      const iy = nameY - 62 * s;
      ctx.globalAlpha = alpha * 0.5;
      drawWeaponIcon(ctx, iconIdFor(weapon), right - iw, iy, iw, rgba(COLOR.ink, 0.9), 1, { halo: true });
      ctx.globalAlpha = alpha;
    }

    ctx.restore();
  }
}
