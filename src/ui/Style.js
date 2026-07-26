/**
 * OPERATION BLACKOUT — UI design tokens.
 *
 * One accent colour, one danger colour, one friendly colour, everything else is
 * a value of near-black or near-white. Sizes are authored against a 1600x900
 * reference frame and scaled by `uiScale()` so the HUD keeps its proportions
 * from a laptop panel to a 4K ultrawide without ever touching CSS pixels.
 */

export const REF_W = 1600;
export const REF_H = 900;

export const COLOR = {
  accent: '#e8b562',
  accentDim: '#a8834a',
  accentHot: '#ffd79a',
  ink: '#e6edf2',
  inkDim: '#93a3ad',
  inkFaint: '#5d6b75',
  danger: '#ff4b3a',
  dangerDeep: '#b21f16',
  blood: '#8e1a12',
  friendly: '#63c8e6',
  hostile: '#ff5546',
  black: '#04070a',
  panel: 'rgba(6,10,13,0.62)',
  panelEdge: 'rgba(232,181,98,0.30)',
};

/** rgba() from a hex string plus alpha — avoids a per-frame string template. */
const _rgbCache = new Map();
export function rgba(hex, a = 1) {
  let base = _rgbCache.get(hex);
  if (!base) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16);
    base = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    _rgbCache.set(hex, base);
  }
  return `rgba(${base[0]},${base[1]},${base[2]},${a < 0 ? 0 : a > 1 ? 1 : a})`;
}

export function rgbOf(hex) {
  rgba(hex, 1);
  return _rgbCache.get(hex);
}

/* ==================================================================== */
/* easing + framerate-independent smoothing                              */
/* ==================================================================== */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
export const invLerp = (a, b, v) => (b === a ? 0 : clamp01((v - a) / (b - a)));

export const Ease = {
  linear: (t) => t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inCubic: (t) => t * t * t,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outQuint: (t) => 1 - Math.pow(1 - t, 5),
  outQuart: (t) => 1 - Math.pow(1 - t, 4),
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  outBack: (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.4 * Math.pow(t - 1, 2),
  outElastic: (t) => (t <= 0 ? 0 : t >= 1 ? 1
    : Math.pow(2, -9 * t) * Math.sin((t * 10 - 0.75) * (Math.PI * 2) / 3) + 1),
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
};

/** Exponential approach that behaves identically at 30 and 240 fps. */
export function damp(current, target, rate, dt) {
  return target + (current - target) * Math.exp(-rate * dt);
}

/**
 * Critically-damped-ish spring. Used for the crosshair, the ammo punch and the
 * killfeed row positions so nothing in the HUD ever pops.
 */
export class Spring {
  constructor(value = 0, stiffness = 180, damping = 22) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.k = stiffness;
    this.d = damping;
  }

  set(v) { this.value = this.target = v; this.velocity = 0; return this; }
  nudge(v) { this.velocity += v; return this; }

  update(dt) {
    // Sub-step so a 60ms hitch cannot make the spring explode.
    const steps = dt > 1 / 45 ? Math.min(4, Math.ceil(dt * 90)) : 1;
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = (this.target - this.value) * this.k - this.velocity * this.d;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }
}

/* ==================================================================== */
/* layout                                                                */
/* ==================================================================== */

/**
 * Scale factor for HUD elements. Sub-linear in the vertical so a very tall
 * window does not blow the ammo counter up to billboard size.
 */
export function uiScale(w, h) {
  const s = Math.min(w / REF_W, h / REF_H);
  return clamp(Math.pow(s, 0.82), 0.62, 2.2);
}

export function shortestAngle(a) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

export const DEG = Math.PI / 180;

/** Deterministic hash noise — used for jitter that must not flicker per frame. */
export function hash01(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}
