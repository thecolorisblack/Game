/**
 * OPERATION BLACKOUT — compass strip.
 *
 * A 120°-wide slice of the horizon across the top of the frame: 5° minor ticks,
 * 15° majors, cardinal and inter-cardinal labels, live numeric heading and
 * world-space markers (objectives, last-known enemy contacts) that slide along
 * the strip and pin to the ends with a direction arrow when off-slice.
 *
 * Rendered into its own offscreen buffer so the ends can be feathered with a
 * destination-out gradient without punching a hole in the rest of the HUD.
 */

import { clamp, clamp01, damp, rgba, shortestAngle, COLOR, Ease } from './Style.js';
import { drawText, measure } from './Type.js';
import { makeCanvas, ctx2d, diamondPath } from './Draw.js';

const SPAN_DEG = 120;
const CARDINALS = [
  [0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'],
  [180, 'S'], [225, 'SW'], [270, 'W'], [315, 'NW'],
];

export class Compass {
  constructor(game) {
    this.game = game;
    this.bearing = 0;
    this.smoothBearing = 0;
    this._buf = null;
    this._bufW = 0;
    this._bufH = 0;
    this._dpr = 1;
  }

  _ensureBuffer(w, h, dpr) {
    const pw = Math.max(8, Math.round(w * dpr));
    const ph = Math.max(8, Math.round(h * dpr));
    if (!this._buf || this._bufW !== pw || this._bufH !== ph) {
      this._buf = makeCanvas(pw, ph, true);
      this._bufW = pw;
      this._bufH = ph;
      this._bufCtx = ctx2d(this._buf);
      this._sig = NaN;            // force a repaint into the new buffer
      // The end feather is baked once: evaluating a full-width gradient into a
      // destination-out pass every frame was, measurably, the single most
      // expensive thing in the entire HUD.
      this._mask = makeCanvas(pw, ph);
      const mg = ctx2d(this._mask);
      const fade = mg.createLinearGradient(0, 0, pw, 0);
      fade.addColorStop(0, 'rgba(0,0,0,0)');
      fade.addColorStop(0.15, 'rgba(0,0,0,1)');
      fade.addColorStop(0.85, 'rgba(0,0,0,1)');
      fade.addColorStop(1, 'rgba(0,0,0,0)');
      mg.fillStyle = fade;
      mg.fillRect(0, 0, pw, ph);
    }
    this._dpr = dpr;
    return this._bufCtx;
  }

  update(dt) {
    const cam = this.game.camera;
    const yaw = cam ? cam.rotation.y : (this.game.player?.yaw ?? 0);
    // +X east, -Z north: bearing clockwise from north is simply -yaw.
    let b = -yaw;
    b = ((b % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    this.bearing = b;
    // wrap-safe smoothing
    const d = shortestAngle(b - this.smoothBearing);
    this.smoothBearing = ((this.smoothBearing + d * (1 - Math.exp(-26 * dt))) + Math.PI * 2) % (Math.PI * 2);
  }

  /**
   * @param {Array<{label:string, bearing:number, kind:string, dist:number, alpha:number}>} markers
   */
  draw(ctx, view, markers = []) {
    const s = view.scale;
    const w = Math.min(view.w * 0.46, 660 * s);
    const h = 54 * s;
    const x = Math.round((view.w - w) * 0.5);
    const y = Math.round(view.pad * 0.45);
    const dpr = view.dpr;
    const g = this._ensureBuffer(w, h, dpr);

    const pxPerDeg = w / SPAN_DEG;
    const headDeg = this.smoothBearing * 180 / Math.PI;
    const cxLocal = w * 0.5;
    const ruleY = h * 0.68;

    // The strip only changes when the view turns or a marker moves. Standing
    // still — which is every frame of a screenshot — reuses the last buffer.
    let sig = Math.round(headDeg * 240) * 131 + markers.length;
    for (let i = 0; i < markers.length; i++) {
      sig = (sig * 31 + Math.round(markers[i].bearing * 240) + Math.round((markers[i].alpha ?? 1) * 32)) | 0;
    }
    if (sig === this._sig) {
      this._composite(ctx, view, x, y, w, h, ruleY, headDeg);
      return;
    }
    this._sig = sig;

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    // --- backing ------------------------------------------------------
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, 'rgba(4,7,10,0.0)');
    bg.addColorStop(0.30, 'rgba(4,7,10,0.46)');
    bg.addColorStop(0.68, 'rgba(4,7,10,0.62)');
    bg.addColorStop(1, 'rgba(4,7,10,0.0)');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h * 0.90);

    // --- ticks --------------------------------------------------------
    const first = Math.floor((headDeg - SPAN_DEG / 2) / 5) * 5;
    const last = headDeg + SPAN_DEG / 2 + 5;
    g.lineCap = 'butt';

    // Ticks batch into three paths by weight; 25 individual strokes per frame
    // is 25 rasteriser flushes for no visual gain.
    const pCard = new Path2D();
    const pMaj = new Path2D();
    const pMin = new Path2D();
    const labels = [];
    for (let d = first; d <= last; d += 5) {
      const off = shortestAngle((d - headDeg) * Math.PI / 180) * 180 / Math.PI;
      const px = cxLocal + off * pxPerDeg;
      if (px < -8 || px > w + 8) continue;
      const norm = ((d % 360) + 360) % 360;
      const isCardinal = norm % 45 === 0;
      const isMajor = norm % 15 === 0;
      const len = isCardinal ? 11 * s : isMajor ? 8 * s : 4.5 * s;
      const path = isCardinal ? pCard : isMajor ? pMaj : pMin;
      const xr = Math.round(px) + 0.5;
      path.moveTo(xr, ruleY - len);
      path.lineTo(xr, ruleY);
      if (isCardinal) labels.push([CARDINALS.find((c) => c[0] === norm)?.[1] ?? '', px, norm % 90 === 0]);
    }
    g.strokeStyle = rgba(COLOR.ink, 0.38);
    g.lineWidth = Math.max(1, 1.1 * s);
    g.stroke(pMin);
    g.strokeStyle = rgba(COLOR.ink, 0.62);
    g.stroke(pMaj);
    g.strokeStyle = rgba(COLOR.ink, 0.92);
    g.lineWidth = Math.max(1.4, 1.8 * s);
    g.stroke(pCard);

    for (const [label, px, cardinal] of labels) {
      drawText(g, label, px, ruleY - 14 * s, {
        size: (cardinal ? 12 : 9) * s,
        weight: 0.15,
        tracking: 0.24,
        align: 'center',
        color: cardinal ? rgba(COLOR.ink, 0.96) : rgba(COLOR.inkDim, 0.8),
        halo: 1.3,
      });
    }

    // baseline rule
    g.strokeStyle = rgba(COLOR.inkDim, 0.45);
    g.lineWidth = Math.max(1, 1.1 * s);
    g.beginPath();
    g.moveTo(0, Math.round(ruleY) + 0.5);
    g.lineTo(w, Math.round(ruleY) + 0.5);
    g.stroke();

    // --- world markers -------------------------------------------------
    for (const m of markers) {
      const off = shortestAngle(m.bearing - this.smoothBearing) * 180 / Math.PI;
      const clamped = clamp(off, -SPAN_DEG / 2 + 3, SPAN_DEG / 2 - 3);
      const pinned = Math.abs(off) > SPAN_DEG / 2 - 3;
      const px = cxLocal + clamped * pxPerDeg;
      const a = (m.alpha ?? 1) * (pinned ? 0.5 : 1);
      if (a <= 0.02) continue;
      const col = m.kind === 'hostile' ? COLOR.hostile : m.kind === 'friendly' ? COLOR.friendly : COLOR.accent;

      g.save();
      g.globalAlpha = a;
      if (m.kind === 'hostile') {
        g.fillStyle = col;
        g.beginPath();
        g.moveTo(px, ruleY - 3 * s);
        g.lineTo(px + 4 * s, ruleY - 11 * s);
        g.lineTo(px - 4 * s, ruleY - 11 * s);
        g.closePath();
        g.fill();
      } else {
        diamondPath(g, px, ruleY - 7.5 * s, 5.2 * s);
        g.fillStyle = rgba(col, 0.22);
        g.fill();
        g.strokeStyle = col;
        g.lineWidth = Math.max(1, 1.3 * s);
        g.stroke();
        if (m.label) {
          drawText(g, m.label, px, ruleY - 5 * s, {
            size: 7.5 * s, weight: 0.2, tracking: 0, align: 'center', color: col, halo: false,
          });
        }
      }
      if (pinned) {
        g.fillStyle = col;
        const dir = off > 0 ? 1 : -1;
        g.beginPath();
        g.moveTo(px + dir * 9 * s, ruleY - 7 * s);
        g.lineTo(px + dir * 4 * s, ruleY - 11 * s);
        g.lineTo(px + dir * 4 * s, ruleY - 3 * s);
        g.closePath();
        g.fill();
      }
      if (m.dist !== undefined && !pinned && m.kind !== 'hostile') {
        drawText(g, `${Math.round(m.dist)}M`, px, ruleY + 12 * s, {
          size: 7.5 * s, weight: 0.17, tracking: 0.24, align: 'center',
          color: rgba(col, 0.75), halo: 1.1,
        });
      }
      g.restore();
    }

    // --- feather the ends (baked mask, applied as one blit) --------------
    if (this._mask) {
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(this._mask, 0, 0);
      g.restore();
    }

    this._composite(ctx, view, x, y, w, h, ruleY, headDeg);
  }

  /** Blit the strip and draw the parts that must sit above it, unfeathered. */
  _composite(ctx, view, x, y, w, h, ruleY, headDeg) {
    const s = view.scale;
    ctx.save();
    ctx.drawImage(this._buf, x, y, w, h);

    const cx = view.w * 0.5;
    // centre chevron
    ctx.fillStyle = rgba(COLOR.accent, 0.95);
    ctx.beginPath();
    ctx.moveTo(cx, y + ruleY - 1 * s);
    ctx.lineTo(cx + 5.5 * s, y + ruleY - 9 * s);
    ctx.lineTo(cx - 5.5 * s, y + ruleY - 9 * s);
    ctx.closePath();
    ctx.fill();

    // numeric heading
    const deg = ((Math.round(headDeg) % 360) + 360) % 360;
    drawText(ctx, `${String(deg).padStart(3, '0')}°`, cx, y + ruleY + 15 * s, {
      size: 11 * s, weight: 0.14, tracking: 0.14, align: 'center',
      color: rgba(COLOR.accent, 0.92), halo: 1.5,
    });
    ctx.restore();

    this.rect = { x, y, w, h, ruleY: y + ruleY };
  }
}
