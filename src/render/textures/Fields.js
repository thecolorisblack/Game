/**
 * Field arithmetic, height→normal derivation, ambient-occlusion estimation and
 * byte packing for the procedural PBR bake.
 *
 * A "field" is a Float32Array of size*size. A "Surface" is the authoring target
 * a recipe fills in: linear-ish height, sRGB albedo, roughness, metalness, AO
 * and an optional alpha/coverage channel. `packSurface()` turns that into the
 * three byte buffers we upload:
 *
 *   albedo : RGBA8 sRGB   — rgb = base colour, a = height (parallax) or coverage
 *   normal : RG8  linear  — tangent-space XY, Z reconstructed in the shader
 *   orm    : RGBA8 linear — r = AO, g = roughness, b = metalness, a = cavity
 *
 * Packing AO/rough/metal into one texture is the glTF convention and cuts both
 * sampler count and VRAM by two thirds versus three separate greyscale maps.
 */

import { upsample2 } from './Noise.js';

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const saturate = clamp01;

export function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
}

export function alloc(size, v = 0) {
  const f = new Float32Array(size * size);
  if (v !== 0) f.fill(v);
  return f;
}

/* ------------------------------------------------------------------ */
/* per-field operators (all in place on `a` unless noted)              */
/* ------------------------------------------------------------------ */

export function addF(a, b, s = 1) { for (let i = 0; i < a.length; i++) a[i] += b[i] * s; return a; }
export function addC(a, c) { for (let i = 0; i < a.length; i++) a[i] += c; return a; }
export function mulF(a, b) { for (let i = 0; i < a.length; i++) a[i] *= b[i]; return a; }
export function mulC(a, c) { for (let i = 0; i < a.length; i++) a[i] *= c; return a; }
export function mixF(a, b, t) { for (let i = 0; i < a.length; i++) a[i] += (b[i] - a[i]) * t; return a; }
export function mixMask(a, b, m) { for (let i = 0; i < a.length; i++) a[i] += (b[i] - a[i]) * m[i]; return a; }
export function mixConstMask(a, c, m) { for (let i = 0; i < a.length; i++) a[i] += (c - a[i]) * m[i]; return a; }
export function maxF(a, b) { for (let i = 0; i < a.length; i++) if (b[i] > a[i]) a[i] = b[i]; return a; }
export function minF(a, b) { for (let i = 0; i < a.length; i++) if (b[i] < a[i]) a[i] = b[i]; return a; }
export function invertF(a) { for (let i = 0; i < a.length; i++) a[i] = 1 - a[i]; return a; }
export function clampF(a, lo = 0, hi = 1) {
  for (let i = 0; i < a.length; i++) a[i] = a[i] < lo ? lo : a[i] > hi ? hi : a[i];
  return a;
}
export function copyF(a) { return Float32Array.from(a); }

/** Contrast around a pivot; c>1 hardens, c<1 softens. */
export function contrastF(a, c, pivot = 0.5) {
  for (let i = 0; i < a.length; i++) a[i] = clamp01((a[i] - pivot) * c + pivot);
  return a;
}

export function smoothstepF(a, e0, e1) {
  const inv = 1 / (e1 - e0 || 1e-6);
  for (let i = 0; i < a.length; i++) {
    const t = clamp01((a[i] - e0) * inv);
    a[i] = t * t * (3 - 2 * t);
  }
  return a;
}

export function powF(a, p) { for (let i = 0; i < a.length; i++) a[i] = Math.pow(a[i] < 0 ? 0 : a[i], p); return a; }

/** Screen blend: 1-(1-a)(1-b). Good for additive-looking grunge. */
export function screenF(a, b, s = 1) {
  for (let i = 0; i < a.length; i++) a[i] = 1 - (1 - a[i]) * (1 - clamp01(b[i] * s));
  return a;
}

/** Photoshop overlay — keeps midtone structure while adding detail. */
export function overlayF(a, b, s = 1) {
  for (let i = 0; i < a.length; i++) {
    const base = a[i];
    const ov = 0.5 + (b[i] - 0.5) * s;
    a[i] = base < 0.5 ? 2 * base * ov : 1 - 2 * (1 - base) * (1 - ov);
  }
  return a;
}

/** Ridge transform: turns smooth noise into sharp crests. */
export function ridgeF(a) { for (let i = 0; i < a.length; i++) a[i] = 1 - Math.abs(a[i] * 2 - 1); return a; }

export function remapF(a, inLo, inHi, outLo = 0, outHi = 1) {
  const s = (outHi - outLo) / (inHi - inLo || 1e-6);
  for (let i = 0; i < a.length; i++) a[i] = outLo + (a[i] - inLo) * s;
  return a;
}

/**
 * Separable wrapping box blur with a running sum, run twice for a near-Gaussian
 * kernel. Cost is O(n) in the radius, and every wrap is a bitmask rather than a
 * modulo — `size` is always a power of two here, and this runs eight million
 * times per hero material, so the difference is worth the assumption.
 */
export function blurWrap(src, size, radius, passes = 2) {
  if (radius < 1) return copyF(src);
  const r = Math.min(Math.max(1, Math.round(radius)), (size >> 1) - 1);
  const m = size - 1;
  let a = copyF(src);
  const b = new Float32Array(size * size);
  const norm = 1 / (2 * r + 1);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < size; y++) {
      const row = y * size;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += a[row + (k & m)];
      for (let x = 0; x < size; x++) {
        b[row + x] = sum * norm;
        sum += a[row + ((x + r + 1) & m)] - a[row + ((x - r) & m)];
      }
    }
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += b[(k & m) * size + x];
      for (let y = 0; y < size; y++) {
        a[y * size + x] = sum * norm;
        sum += b[((y + r + 1) & m) * size + x] - b[((y - r) & m) * size + x];
      }
    }
  }
  return a;
}

/* ------------------------------------------------------------------ */
/* colour                                                              */
/* ------------------------------------------------------------------ */

/**
 * Build a 256-entry sRGB gradient LUT from stops of [t, r, g, b] (0..255).
 * Authoring albedo through gradients rather than per-channel maths is what
 * keeps procedural surfaces from looking like tinted greyscale.
 */
export function gradientLUT(stops, n = 256) {
  const lut = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    let a = stops[0];
    let b = stops[stops.length - 1];
    for (let s = 0; s < stops.length - 1; s++) {
      if (t >= stops[s][0] && t <= stops[s + 1][0]) { a = stops[s]; b = stops[s + 1]; break; }
    }
    const span = b[0] - a[0] || 1e-6;
    const k = clamp01((t - a[0]) / span);
    lut[i * 3] = (a[1] + (b[1] - a[1]) * k) / 255;
    lut[i * 3 + 1] = (a[2] + (b[2] - a[2]) * k) / 255;
    lut[i * 3 + 2] = (a[3] + (b[3] - a[3]) * k) / 255;
  }
  return lut;
}

/** Write gradient(t) into the surface's rgb fields. */
export function applyGradient(surf, t, lut) {
  const { r, g, b } = surf;
  const n = (lut.length / 3) | 0;
  const last = n - 1;
  for (let i = 0; i < r.length; i++) {
    let idx = (t[i] * last) | 0;
    if (idx < 0) idx = 0; else if (idx > last) idx = last;
    const o = idx * 3;
    r[i] = lut[o];
    g[i] = lut[o + 1];
    b[i] = lut[o + 2];
  }
}

/** Blend gradient(t) over the existing albedo through a mask. */
export function blendGradient(surf, t, lut, mask, strength = 1) {
  const { r, g, b } = surf;
  const n = (lut.length / 3) | 0;
  const last = n - 1;
  for (let i = 0; i < r.length; i++) {
    const m = (mask ? mask[i] : 1) * strength;
    if (m <= 0.0005) continue;
    let idx = (t[i] * last) | 0;
    if (idx < 0) idx = 0; else if (idx > last) idx = last;
    const o = idx * 3;
    r[i] += (lut[o] - r[i]) * m;
    g[i] += (lut[o + 1] - g[i]) * m;
    b[i] += (lut[o + 2] - b[i]) * m;
  }
}

/** Multiply albedo by a per-pixel scalar field (shading / dirt darkening). */
export function shadeAlbedo(surf, f, amount = 1) {
  const { r, g, b } = surf;
  for (let i = 0; i < r.length; i++) {
    const k = 1 + (f[i] - 1) * amount;
    r[i] *= k; g[i] *= k; b[i] *= k;
  }
}

/** Push albedo toward a flat colour through a mask (paint, dust, frost). */
export function tintMask(surf, col, mask, strength = 1) {
  const { r, g, b } = surf;
  const cr = col[0] / 255;
  const cg = col[1] / 255;
  const cb = col[2] / 255;
  for (let i = 0; i < r.length; i++) {
    const m = clamp01(mask[i]) * strength;
    if (m <= 0.0005) continue;
    r[i] += (cr - r[i]) * m;
    g[i] += (cg - g[i]) * m;
    b[i] += (cb - b[i]) * m;
  }
}

/* ------------------------------------------------------------------ */
/* height → normal / AO                                                */
/* ------------------------------------------------------------------ */

/**
 * Sobel-derived tangent-space normal, packed to RG8.
 * Real derivative of the real height field — no faked normals anywhere.
 * `strength` is in "height units per texel of slope"; it is scaled by size so
 * a 512 and a 1024 bake of the same recipe read identically.
 */
export function normalFromHeight(height, size, strength = 1) {
  const out = new Uint8Array(size * size * 2);
  const s = strength * size * 0.0045;
  for (let y = 0; y < size; y++) {
    const ym = (y === 0 ? size - 1 : y - 1) * size;
    const y0 = y * size;
    const yp = (y === size - 1 ? 0 : y + 1) * size;
    for (let x = 0; x < size; x++) {
      const xm = x === 0 ? size - 1 : x - 1;
      const xp = x === size - 1 ? 0 : x + 1;
      const h00 = height[ym + xm], h10 = height[ym + x], h20 = height[ym + xp];
      const h01 = height[y0 + xm], h21 = height[y0 + xp];
      const h02 = height[yp + xm], h12 = height[yp + x], h22 = height[yp + xp];
      const gx = (h20 + 2 * h21 + h22) - (h00 + 2 * h01 + h02);
      const gy = (h02 + 2 * h12 + h22) - (h00 + 2 * h10 + h20);
      let nx = -gx * s;
      let ny = -gy * s;
      const nz = 4;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv; ny *= inv;
      const o = (y0 + x) * 2;
      out[o] = Math.max(0, Math.min(255, (nx * 0.5 + 0.5) * 255 + 0.5)) | 0;
      out[o + 1] = Math.max(0, Math.min(255, (ny * 0.5 + 0.5) * 255 + 0.5)) | 0;
    }
  }
  return out;
}

/**
 * Cavity / crevice occlusion: compare the height against blurred versions of
 * itself at two radii. Cheap, stable, and reads convincingly because the broad
 * term darkens whole recesses while the tight term catches every pore.
 */
export function occlusionFromHeight(height, size, opts = {}) {
  const { fine = size / 128, broad = size / 24, fineAmt = 0.55, broadAmt = 0.85, floor = 0.25 } = opts;
  const bf = blurWrap(height, size, fine, 1);
  // The broad term is low frequency by definition, so blur it on a half-res
  // pyramid level and upsample — a quarter of the work, no visible difference.
  let bb;
  if (size >= 256) {
    const half = size >> 1;
    bb = upsample2(blurWrap(downsampleHalf(height, size), half, broad * 0.5, 2), half);
  } else {
    bb = blurWrap(height, size, broad, 2);
  }
  const ao = new Float32Array(size * size);
  for (let i = 0; i < ao.length; i++) {
    const h = height[i];
    const dFine = clamp01((bf[i] - h) * 4.0);
    const dBroad = clamp01((bb[i] - h) * 2.4);
    let v = 1 - dFine * fineAmt - dBroad * broadAmt;
    if (v < floor) v = floor;
    ao[i] = v > 1 ? 1 : v;
  }
  return ao;
}

/**
 * Horizon-scan AO for the hero surfaces: marches a handful of directions and
 * measures the highest elevation angle blocking the sky. Much more expensive
 * than the cavity approximation but it produces the directional contact
 * darkening under brick lips and sandbag folds that sells close-up geometry.
 */
export function horizonAO(height, size, opts = {}) {
  const { dirs = 6, steps = 4, radius = size / 20, scale = 1.0, strength = 1.0 } = opts;
  const ao = new Float32Array(size * size);
  const m = size - 1;
  let shift = 0;
  while ((1 << shift) < size) shift++;

  // Precompute every tap as an integer offset + reciprocal distance so the
  // inner loop is two adds, a mask, a multiply and a compare.
  const n = dirs * steps;
  const offX = new Int32Array(n);
  const offY = new Int32Array(n);
  const invD = new Float32Array(n);
  for (let d = 0; d < dirs; d++) {
    const a = (d / dirs) * Math.PI * 2 + 0.37;
    const cx = Math.cos(a);
    const cy = Math.sin(a);
    for (let s = 1; s <= steps; s++) {
      const dist = (s / steps) * radius;
      const i = d * steps + s - 1;
      offX[i] = Math.round(cx * dist);
      offY[i] = Math.round(cy * dist);
      invD[i] = 1 / Math.max(dist, 1e-3);
    }
  }

  const hScale = size * 0.06 * scale;
  const invDirs = strength / dirs;
  for (let y = 0; y < size; y++) {
    const row = y << shift;
    for (let x = 0; x < size; x++) {
      const o = row + x;
      const h0 = height[o] * hScale;
      let occ = 0;
      for (let d = 0; d < dirs; d++) {
        let maxTan = 0;
        const base = d * steps;
        for (let s = 0; s < steps; s++) {
          const i = base + s;
          const sx = (x + offX[i]) & m;
          const sy = (y + offY[i]) & m;
          const dh = height[(sy << shift) + sx] * hScale - h0;
          if (dh > 0) {
            const t = dh * invD[i];
            if (t > maxTan) maxTan = t;
          }
        }
        occ += maxTan / Math.sqrt(1 + maxTan * maxTan);
      }
      ao[o] = clamp01(1 - occ * invDirs);
    }
  }
  return ao;
}

/** 2x2 box reduction of a field; the input size must be even. */
export function downsampleHalf(src, size) {
  const half = size >> 1;
  const out = new Float32Array(half * half);
  for (let y = 0; y < half; y++) {
    const a = y * 2 * size;
    const b = a + size;
    for (let x = 0; x < half; x++) {
      out[y * half + x] = (src[a + x * 2] + src[a + x * 2 + 1] + src[b + x * 2] + src[b + x * 2 + 1]) * 0.25;
    }
  }
  return out;
}

/** Curvature (convexity) mask — drives edge wear, paint chipping, rust rims. */
export function curvatureFromHeight(height, size, radius = size / 200) {
  const b = blurWrap(height, size, Math.max(1, radius), 1);
  const c = new Float32Array(size * size);
  for (let i = 0; i < c.length; i++) c[i] = clamp01((height[i] - b[i]) * 6 + 0.5);
  return c;
}

/* ------------------------------------------------------------------ */
/* Surface container + packing                                         */
/* ------------------------------------------------------------------ */

export class Surface {
  /**
   * Pass the BakeContext so the seven megabyte-scale channel buffers come from
   * its recycling pool. Baking 26 materials churns well over a gigabyte of
   * Float32Array otherwise, and the resulting major GCs cost more than the
   * arithmetic does.
   */
  constructor(size, ctx = null) {
    this.size = size;
    const n = size * size;
    const take = ctx ? (v) => ctx.alloc(v) : (v) => { const a = new Float32Array(n); if (v) a.fill(v); return a; };
    this.ctx = ctx;
    this.h = take(0.5);
    // rgb start at zero: every recipe writes them through applyGradient.
    this.r = take(0);
    this.g = take(0);
    this.b = take(0);
    this.rough = take(0.8);
    this.metal = take(0);
    this.ao = take(1);
    this.cavity = null;   // optional 4th ORM channel (emissive/wet/thickness mask)
    this.alpha = null;    // optional coverage; replaces height in albedo.a
  }
  alloc(v = 0) { return this.ctx ? this.ctx.alloc(v) : alloc(this.size, v); }
}

function downsample2RGBA(src, size) {
  const half = size >> 1;
  const out = new Uint8Array(half * half * 4);
  for (let y = 0; y < half; y++) {
    const s0 = (y * 2) * size;
    const s1 = (y * 2 + 1) * size;
    for (let x = 0; x < half; x++) {
      const a = (s0 + x * 2) * 4;
      const b = (s0 + x * 2 + 1) * 4;
      const c = (s1 + x * 2) * 4;
      const d = (s1 + x * 2 + 1) * 4;
      const o = (y * half + x) * 4;
      for (let k = 0; k < 4; k++) out[o + k] = (src[a + k] + src[b + k] + src[c + k] + src[d + k] + 2) >> 2;
    }
  }
  return out;
}

const toByte = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0);

/**
 * Turn an authored Surface into upload-ready byte buffers.
 * `normalStrength` scales the sobel; `ormHalf` bakes the ORM set at half
 * resolution (AO/roughness/metalness are low frequency enough that nobody can
 * tell, and it saves 75% of that texture's memory).
 */
export function packSurface(surf, opts = {}) {
  const { normalStrength = 1, ormHalf = true, ao = null, saturation = 0.76, gain = 0.90 } = opts;
  const size = surf.size;
  const n = size * size;

  const albedo = new Uint8Array(n * 4);
  const alpha = surf.alpha || surf.h;
  // Single global grade on the way out. Every recipe is authored at "reference"
  // saturation; pulling the whole library down together is how you get the
  // cohesive, desaturated look of a modern military shooter rather than
  // twenty-six individually plausible but collectively garish surfaces.
  const graded = saturation !== 1 || gain !== 1;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    let r = surf.r[i];
    let g = surf.g[i];
    let b = surf.b[i];
    if (graded) {
      const lum = r * 0.2126 + g * 0.7152 + b * 0.0722;
      r = (lum + (r - lum) * saturation) * gain;
      g = (lum + (g - lum) * saturation) * gain;
      b = (lum + (b - lum) * saturation) * gain;
    }
    albedo[o] = toByte(r);
    albedo[o + 1] = toByte(g);
    albedo[o + 2] = toByte(b);
    albedo[o + 3] = toByte(alpha[i]);
  }

  const normal = normalFromHeight(surf.h, size, normalStrength);

  const aoField = ao || surf.ao;
  let orm = new Uint8Array(n * 4);
  const cav = surf.cavity;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    orm[o] = toByte(aoField[i]);
    orm[o + 1] = toByte(surf.rough[i]);
    orm[o + 2] = toByte(surf.metal[i]);
    orm[o + 3] = cav ? toByte(cav[i]) : 255;
  }
  let ormSize = size;
  if (ormHalf && size >= 256) { orm = downsample2RGBA(orm, size); ormSize = size >> 1; }

  return { size, albedo, normal, orm, ormSize };
}

/** Pack an RG8 normal buffer straight from a height field (detail normals). */
export function packDetailNormal(height, size, strength) {
  return normalFromHeight(height, size, strength);
}
