/**
 * OPERATION BLACKOUT — 2D drawing primitives shared by every HUD widget.
 *
 * The HUD's whole visual language lives here: chamfered plates, corner
 * brackets, tick rules, chevrons and the procedurally baked textures (blood
 * splatter mask, grain, scanlines) that keep the overlay from looking like flat
 * vector art. Everything is generated at boot into offscreen canvases; nothing
 * is fetched and nothing is a pasted blob.
 */

import { rgba, Ease } from './Style.js';

/* ==================================================================== */
/* offscreen canvases                                                    */
/* ==================================================================== */

/**
 * @param {boolean} dom force a DOM canvas. An OffscreenCanvas that is *redrawn
 *   every frame* and then blitted into an on-screen context can cost a full
 *   upload per frame in Chromium; a DOM canvas stays in the same backing store.
 *   Static bakes are fine (and cheaper) as OffscreenCanvas.
 */
export function makeCanvas(w, h, dom = false) {
  const cw = Math.max(1, w | 0);
  const ch = Math.max(1, h | 0);
  if (!dom && typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(cw, ch);
  return Object.assign(document.createElement('canvas'), { width: cw, height: ch });
}

export function ctx2d(canvas, opts) {
  return canvas.getContext('2d', opts || { alpha: true });
}

/* ==================================================================== */
/* paths                                                                 */
/* ==================================================================== */

/** Chamfered (corner-cut) rectangle — the module's signature plate shape. */
export function chamferPath(ctx, x, y, w, h, c = 8, corners = 0b1111) {
  const tl = (corners & 0b1000) ? c : 0;
  const tr = (corners & 0b0100) ? c : 0;
  const br = (corners & 0b0010) ? c : 0;
  const bl = (corners & 0b0001) ? c : 0;
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.lineTo(x + w, y + tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.lineTo(x + w - br, y + h);
  ctx.lineTo(x + bl, y + h);
  ctx.lineTo(x, y + h - bl);
  ctx.lineTo(x, y + tl);
  ctx.closePath();
}

/** Four L-shaped corner brackets — reads as a targeting frame. */
export function cornerBrackets(ctx, x, y, w, h, len, lw, color, alpha = 1) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(x, y + len); ctx.lineTo(x, y); ctx.lineTo(x + len, y);
  ctx.moveTo(x + w - len, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + len);
  ctx.moveTo(x + w, y + h - len); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - len, y + h);
  ctx.moveTo(x + len, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - len);
  ctx.stroke();
  ctx.restore();
}

export function diamondPath(ctx, cx, cy, r) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
}

/* ==================================================================== */
/* procedural textures                                                   */
/* ==================================================================== */

/**
 * Blood / impact splatter mask. Metaball blobs with satellite droplets, blurred
 * through repeated low-alpha compositing so the edges break up like real spray
 * rather than reading as clean circles.
 */
export function bakeSplatter(size = 512, seed = 1) {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  let s = seed >>> 0 || 1;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };

  g.clearRect(0, 0, size, size);
  g.globalCompositeOperation = 'source-over';

  // Big irregular masses, each a ring of overlapping radial gradients.
  for (let m = 0; m < 7; m++) {
    const mx = size * (0.12 + rnd() * 0.76);
    const my = size * (0.12 + rnd() * 0.76);
    const mr = size * (0.06 + rnd() * 0.13);
    const lobes = 5 + (rnd() * 6) | 0;
    for (let l = 0; l < lobes; l++) {
      const a = (l / lobes) * Math.PI * 2 + rnd() * 0.6;
      const d = mr * (0.2 + rnd() * 0.9);
      const r = mr * (0.35 + rnd() * 0.65);
      const x = mx + Math.cos(a) * d;
      const y = my + Math.sin(a) * d;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(255,255,255,0.95)');
      grad.addColorStop(0.55, 'rgba(255,255,255,0.55)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
  }
  // Droplets and cast-off streaks.
  for (let d = 0; d < 260; d++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = 0.6 + rnd() * rnd() * size * 0.012;
    g.fillStyle = `rgba(255,255,255,${0.25 + rnd() * 0.7})`;
    g.beginPath();
    if (rnd() < 0.24) {
      const a = rnd() * Math.PI * 2;
      g.ellipse(x, y, r * (1.6 + rnd() * 3.4), r * 0.7, a, 0, Math.PI * 2);
    } else {
      g.arc(x, y, r, 0, Math.PI * 2);
    }
    g.fill();
  }
  return c;
}

/**
 * Fine monochrome grain plus a faint horizontal scan structure, baked once and
 * tiled. Menus use it as a texture layer; the HUD uses it under the vignette.
 */
export function bakeGrain(size = 256, seed = 7, scanEvery = 3, scanStrength = 0.10) {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  const img = g.createImageData(size, size);
  const d = img.data;
  let s = seed >>> 0 || 3;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  for (let y = 0; y < size; y++) {
    const scan = (y % scanEvery === 0) ? scanStrength : 0;
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const n = rnd();
      const v = 128 + (n - 0.5) * 190;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = Math.min(255, (28 + n * 40) + scan * 255);
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/* ==================================================================== */
/* misc helpers                                                          */
/* ==================================================================== */

/** Standard fade-in / hold / fade-out envelope. */
export function envelope(t, inDur, hold, outDur, easeIn = Ease.outCubic, easeOut = Ease.inCubic) {
  if (t < 0) return 0;
  if (t < inDur) return easeIn(t / inDur);
  if (t < inDur + hold) return 1;
  const k = (t - inDur - hold) / outDur;
  if (k >= 1) return 0;
  return 1 - easeOut(k);
}

/** Additive glow blob, cheap and used for hit flashes and ping halos. */
export function glowDot(ctx, x, y, r, color, alpha = 1) {
  if (alpha <= 0.003 || r <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(color, 0.85 * alpha));
  g.addColorStop(0.4, rgba(color, 0.30 * alpha));
  g.addColorStop(1, rgba(color, 0));
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
