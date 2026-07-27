/**
 * OPERATION BLACKOUT — the HUD typeface.
 *
 * There is no webfont here and no `ctx.font = "24px Rajdhani"` fallback lottery:
 * under headless Chromium every named face resolves to whatever DejaVu the
 * container happens to ship, which is the single most obvious "this is a web
 * demo" tell in a screenshot. So the HUD draws its own letters.
 *
 * Glyphs are stroke skeletons authored in an em box that runs x:[0..adv],
 * y:[0(cap height) .. 1(baseline)]. Corners are chamfered rather than rounded,
 * joins are mitred and caps are butt — the vocabulary of stencilled military
 * lettering and technical instrument faces, and it stays crisp at any size or
 * device pixel ratio because it is re-stroked, never scaled from a bitmap.
 *
 * Everything is uppercase by design. Lowercase input is folded up.
 */

/* Chamfer constant used across the round-ish glyphs. */
const C = 0.16;
const W = 0.62;

/** @type {Record<string,{a:number,s:number[][][]}>} advance + stroke list */
export const GLYPHS = {
  ' ': { a: 0.34, s: [] },

  A: { a: W, s: [[[0, 1], [0.31, 0], [0.62, 1]], [[0.115, 0.63], [0.505, 0.63]]] },
  B: {
    a: W,
    s: [
      [[0, 0], [0, 1]],
      [[0, 0], [0.44, 0], [0.60, 0.15], [0.60, 0.33], [0.45, 0.49], [0, 0.49]],
      [[0.45, 0.49], [0.62, 0.66], [0.62, 0.85], [0.46, 1], [0, 1]],
    ],
  },
  C: { a: W, s: [[[0.62, C], [0.46, 0], [0.16, 0], [0, C], [0, 1 - C], [0.16, 1], [0.46, 1], [0.62, 1 - C]]] },
  D: { a: W, s: [[[0, 0], [0, 1]], [[0, 0], [0.44, 0], [0.62, 0.19], [0.62, 0.81], [0.44, 1], [0, 1]]] },
  E: { a: 0.58, s: [[[0.58, 0], [0, 0], [0, 1], [0.58, 1]], [[0, 0.49], [0.46, 0.49]]] },
  F: { a: 0.56, s: [[[0.56, 0], [0, 0], [0, 1]], [[0, 0.49], [0.45, 0.49]]] },
  G: { a: W, s: [[[0.62, C], [0.46, 0], [0.16, 0], [0, C], [0, 1 - C], [0.16, 1], [0.46, 1], [0.62, 1 - C], [0.62, 0.56], [0.33, 0.56]]] },
  H: { a: W, s: [[[0, 0], [0, 1]], [[0.62, 0], [0.62, 1]], [[0, 0.50], [0.62, 0.50]]] },
  I: { a: 0.30, s: [[[0.15, 0], [0.15, 1]], [[0, 0], [0.30, 0]], [[0, 1], [0.30, 1]]] },
  J: { a: 0.56, s: [[[0.44, 0], [0.44, 0.82], [0.30, 1], [0.14, 1], [0, 0.84]]] },
  K: { a: W, s: [[[0, 0], [0, 1]], [[0.60, 0], [0.03, 0.55]], [[0.21, 0.39], [0.62, 1]]] },
  L: { a: 0.54, s: [[[0, 0], [0, 1], [0.54, 1]]] },
  M: { a: 0.80, s: [[[0, 1], [0, 0], [0.40, 0.52], [0.80, 0], [0.80, 1]]] },
  N: { a: 0.68, s: [[[0, 1], [0, 0], [0.68, 1], [0.68, 0]]] },
  O: { a: W, s: [[[0.16, 0], [0.46, 0], [0.62, C], [0.62, 1 - C], [0.46, 1], [0.16, 1], [0, 1 - C], [0, C], [0.16, 0]]] },
  P: { a: W, s: [[[0, 1], [0, 0], [0.46, 0], [0.62, C], [0.62, 0.38], [0.46, 0.53], [0, 0.53]]] },
  Q: {
    a: W,
    s: [
      [[0.16, 0], [0.46, 0], [0.62, C], [0.62, 1 - C], [0.46, 1], [0.16, 1], [0, 1 - C], [0, C], [0.16, 0]],
      [[0.38, 0.72], [0.68, 1.05]],
    ],
  },
  R: { a: W, s: [[[0, 1], [0, 0], [0.46, 0], [0.62, C], [0.62, 0.38], [0.46, 0.53], [0, 0.53]], [[0.30, 0.53], [0.62, 1]]] },
  S: {
    a: W,
    s: [[[0.62, 0.13], [0.46, 0], [0.16, 0], [0, C], [0, 0.34], [0.15, 0.49], [0.46, 0.49],
      [0.62, 0.64], [0.62, 0.85], [0.46, 1], [0.14, 1], [0, 0.86]]],
  },
  T: { a: W, s: [[[0, 0], [0.62, 0]], [[0.31, 0], [0.31, 1]]] },
  U: { a: W, s: [[[0, 0], [0, 0.82], [0.17, 1], [0.45, 1], [0.62, 0.82], [0.62, 0]]] },
  V: { a: W, s: [[[0, 0], [0.31, 1], [0.62, 0]]] },
  W: { a: 0.88, s: [[[0, 0], [0.16, 1], [0.44, 0.33], [0.72, 1], [0.88, 0]]] },
  X: { a: W, s: [[[0, 0], [0.62, 1]], [[0.62, 0], [0, 1]]] },
  Y: { a: W, s: [[[0, 0], [0.31, 0.51], [0.62, 0]], [[0.31, 0.51], [0.31, 1]]] },
  Z: { a: W, s: [[[0, 0], [0.62, 0], [0, 1], [0.62, 1]]] },

  0: {
    a: W,
    s: [
      [[0.16, 0], [0.46, 0], [0.62, C], [0.62, 1 - C], [0.46, 1], [0.16, 1], [0, 1 - C], [0, C], [0.16, 0]],
      [[0.12, 0.80], [0.50, 0.20]],
    ],
  },
  1: { a: W, s: [[[0.08, 0.21], [0.33, 0], [0.33, 1]], [[0.04, 1], [0.60, 1]]] },
  2: { a: W, s: [[[0, 0.17], [0.16, 0], [0.45, 0], [0.62, 0.17], [0.62, 0.35], [0.04, 1], [0.62, 1]]] },
  3: {
    a: W,
    s: [
      [[0.02, 0], [0.46, 0], [0.62, C], [0.62, 0.35], [0.47, 0.49], [0.62, 0.64], [0.62, 0.85], [0.46, 1], [0.03, 1]],
      [[0.22, 0.49], [0.47, 0.49]],
    ],
  },
  4: { a: W, s: [[[0.45, 1], [0.45, 0], [0, 0.68], [0.62, 0.68]]] },
  5: { a: W, s: [[[0.60, 0], [0.03, 0], [0, 0.43], [0.43, 0.43], [0.62, 0.60], [0.62, 0.85], [0.46, 1], [0.14, 1], [0, 0.87]]] },
  6: {
    a: W,
    s: [[[0.57, 0.11], [0.43, 0], [0.17, 0], [0, 0.20], [0, 0.85], [0.16, 1], [0.46, 1], [0.62, 0.85],
      [0.62, 0.62], [0.46, 0.46], [0.16, 0.46], [0, 0.61]]],
  },
  7: { a: W, s: [[[0, 0], [0.62, 0], [0.23, 1]], [[0.12, 0.52], [0.47, 0.52]]] },
  8: {
    a: W,
    s: [
      [[0.16, 0], [0.45, 0], [0.59, 0.13], [0.59, 0.35], [0.45, 0.49], [0.16, 0.49], [0.02, 0.35], [0.02, 0.13], [0.16, 0]],
      [[0.16, 0.49], [0.46, 0.49], [0.62, 0.65], [0.62, 0.85], [0.46, 1], [0.16, 1], [0, 0.85], [0, 0.65], [0.16, 0.49]],
    ],
  },
  9: {
    a: W,
    s: [[[0.05, 0.89], [0.19, 1], [0.45, 1], [0.62, 0.80], [0.62, C], [0.46, 0], [0.16, 0], [0, C],
      [0, 0.38], [0.16, 0.54], [0.46, 0.54], [0.62, 0.39]]],
  },

  '-': { a: 0.52, s: [[[0.05, 0.52], [0.47, 0.52]]] },
  '–': { a: 0.62, s: [[[0.02, 0.52], [0.60, 0.52]]] },
  '_': { a: 0.60, s: [[[0, 1.06], [0.60, 1.06]]] },
  '/': { a: 0.50, s: [[[0.46, -0.06], [0.04, 1.06]]] },
  '\\': { a: 0.50, s: [[[0.04, -0.06], [0.46, 1.06]]] },
  '.': { a: 0.26, s: [[[0.06, 0.96], [0.20, 0.96]]] },
  ',': { a: 0.26, s: [[[0.20, 0.92], [0.06, 1.12]]] },
  ':': { a: 0.24, s: [[[0.10, 0.28], [0.10, 0.40]], [[0.10, 0.82], [0.10, 0.94]]] },
  ';': { a: 0.24, s: [[[0.10, 0.28], [0.10, 0.40]], [[0.16, 0.82], [0.04, 1.02]]] },
  '+': { a: 0.58, s: [[[0.29, 0.24], [0.29, 0.78]], [[0.02, 0.51], [0.56, 0.51]]] },
  '!': { a: 0.24, s: [[[0.11, 0], [0.11, 0.68]], [[0.11, 0.93], [0.11, 1]]] },
  '?': { a: W, s: [[[0.02, C], [0.18, 0], [0.44, 0], [0.60, C], [0.60, 0.32], [0.31, 0.52], [0.31, 0.68]], [[0.31, 0.93], [0.31, 1]]] },
  '%': {
    a: 0.76,
    s: [
      [[0.62, 0.02], [0.10, 1.0]],
      [[0.04, 0.06], [0.20, 0.06], [0.20, 0.30], [0.04, 0.30], [0.04, 0.06]],
      [[0.52, 0.70], [0.68, 0.70], [0.68, 0.94], [0.52, 0.94], [0.52, 0.70]],
    ],
  },
  '(': { a: 0.30, s: [[[0.26, -0.04], [0.06, 0.24], [0.06, 0.76], [0.26, 1.04]]] },
  ')': { a: 0.30, s: [[[0.04, -0.04], [0.24, 0.24], [0.24, 0.76], [0.04, 1.04]]] },
  '[': { a: 0.30, s: [[[0.26, -0.04], [0.06, -0.04], [0.06, 1.04], [0.26, 1.04]]] },
  ']': { a: 0.30, s: [[[0.04, -0.04], [0.24, -0.04], [0.24, 1.04], [0.04, 1.04]]] },
  '<': { a: 0.46, s: [[[0.38, 0.14], [0.06, 0.52], [0.38, 0.90]]] },
  '>': { a: 0.46, s: [[[0.08, 0.14], [0.40, 0.52], [0.08, 0.90]]] },
  '°': { a: 0.34, s: [[[0.06, 0.04], [0.26, 0.04], [0.26, 0.26], [0.06, 0.26], [0.06, 0.04]]] },
  '×': { a: 0.46, s: [[[0.08, 0.30], [0.38, 0.72]], [[0.38, 0.30], [0.08, 0.72]]] },
  '•': { a: 0.30, s: [[[0.08, 0.50], [0.22, 0.50]]] },
  '→': { a: 0.72, s: [[[0.02, 0.52], [0.66, 0.52]], [[0.44, 0.32], [0.68, 0.52], [0.44, 0.72]]] },
  "'": { a: 0.20, s: [[[0.09, 0], [0.09, 0.22]]] },
  '"': { a: 0.34, s: [[[0.08, 0], [0.08, 0.22]], [[0.24, 0], [0.24, 0.22]]] },
  '#': {
    a: 0.72,
    s: [[[0.20, 0.02], [0.11, 1.0]], [[0.50, 0.02], [0.41, 1.0]], [[0.02, 0.34], [0.62, 0.34]], [[0.0, 0.70], [0.60, 0.70]]],
  },
  '=': { a: 0.58, s: [[[0.02, 0.36], [0.56, 0.36]], [[0.02, 0.66], [0.56, 0.66]]] },
  '‹': { a: 0.40, s: [[[0.30, 0.18], [0.06, 0.52], [0.30, 0.86]]] },
  '›': { a: 0.40, s: [[[0.10, 0.18], [0.34, 0.52], [0.10, 0.86]]] },
};

/* Glyphs whose skeleton stops short of the baseline get a tiny optical nudge so
 * a line of mixed digits and caps sits flat. */
const CAP = 1.0;

/**
 * @typedef {Object} TextOpts
 * @property {number} [size]     cap height in px
 * @property {number} [weight]   stroke width as a fraction of size (0.07 thin .. 0.18 heavy)
 * @property {number} [tracking] extra letterspacing as a fraction of size
 * @property {string} [align]    'left' | 'center' | 'right'
 * @property {string} [baseline] 'alphabetic' | 'middle' | 'top'
 * @property {string} [color]
 * @property {number} [alpha]
 * @property {number|false} [halo] dark outline width multiplier, false to skip
 * @property {number} [slant]    italic shear, fraction of size
 */

export function measure(text, size = 16, tracking = 0.18) {
  let w = 0;
  const t = String(text).toUpperCase();
  for (let i = 0; i < t.length; i++) {
    const g = GLYPHS[t[i]];
    w += (g ? g.a : 0.5) * size + tracking * size;
  }
  return w > 0 ? w - tracking * size : 0;
}

/**
 * Stroke a string of the HUD face.
 * Returns the advance width so callers can lay out rows without measuring twice.
 */
export function drawText(ctx, text, x, y, opts = {}) {
  const size = opts.size ?? 16;
  const weight = opts.weight ?? 0.115;
  const tracking = opts.tracking ?? 0.18;
  const slant = opts.slant ?? 0;
  const t = String(text).toUpperCase();
  const total = measure(t, size, tracking);

  let ox = x;
  if (opts.align === 'center') ox -= total * 0.5;
  else if (opts.align === 'right') ox -= total;

  let oy = y;
  if (opts.baseline === 'middle') oy += size * 0.5;
  else if (opts.baseline === 'top') oy += size;

  // Floors here are sub-pixel on purpose. A 1-CSS-px floor is a fixed physical
  // thickness, so at 960x540 it is twice the fraction of the frame it is at
  // 1920x1080 — which is most of why the old HUD read heavier the smaller the
  // window got. Stroke and halo are both strictly proportional to `size`.
  const lw = Math.max(0.45, size * weight);
  ctx.save();
  ctx.lineJoin = 'miter';
  ctx.miterLimit = 2.4;
  ctx.lineCap = opts.cap || 'butt';
  ctx.globalAlpha = (opts.alpha ?? 1) * (ctx.globalAlpha);

  // Build the whole run as one path so both passes cost one stroke each.
  const path = new Path2D();
  let cx = ox;
  for (let i = 0; i < t.length; i++) {
    const g = GLYPHS[t[i]] || GLYPHS['•'];
    for (let s = 0; s < g.s.length; s++) {
      const stroke = g.s[s];
      for (let p = 0; p < stroke.length; p++) {
        const gy = stroke[p][1] * CAP;
        const px = cx + stroke[p][0] * size + (1 - gy) * slant * size;
        const py = oy - size + gy * size;
        if (p === 0) path.moveTo(px, py);
        else path.lineTo(px, py);
      }
    }
    cx += g.a * size + tracking * size;
  }

  if (opts.halo !== false) {
    const grow = typeof opts.halo === 'number' ? opts.halo : 2.1;
    ctx.strokeStyle = opts.haloColor || 'rgba(2,4,6,0.62)';
    ctx.lineWidth = lw + Math.max(0.5, size * 0.10) * grow;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke(path);
    ctx.lineJoin = 'miter';
    ctx.lineCap = opts.cap || 'butt';
  }

  ctx.strokeStyle = opts.color || '#e6edf2';
  ctx.lineWidth = lw;
  ctx.stroke(path);

  if (opts.glow) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = opts.glowColor || opts.color || '#e6edf2';
    ctx.globalAlpha *= opts.glow;
    ctx.lineWidth = lw + size * 0.16;
    ctx.stroke(path);
  }

  ctx.restore();
  return total;
}

/**
 * Half-width that the stroke and its halo add *outside* a run's geometric box.
 *
 * `measure()` returns advances, not ink. A widget that anchors text flush to the
 * safe area therefore paints roughly this much past the inset — small, but it is
 * exactly the difference between "the layout respects the safe area" and "the
 * layout nearly respects the safe area". Edge-hugging callers subtract it.
 */
export function inkBleed(size = 16, weight = 0.115, halo = 2.1) {
  const lw = Math.max(0.45, size * weight);
  const grow = halo === false ? 0 : (typeof halo === 'number' ? halo : 2.1);
  return (lw + Math.max(0.5, size * 0.10) * grow) * 0.5;
}

/** Convenience: a label with the standard HUD kicker treatment. */
export function drawLabel(ctx, text, x, y, opts = {}) {
  return drawText(ctx, text, x, y, {
    size: 10, weight: 0.14, tracking: 0.42, color: '#93a3ad', ...opts,
  });
}
