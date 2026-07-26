import * as THREE from 'three';
import { createNoise4D } from 'simplex-noise';
import { Rng, clamp, saturate, lerp, smoothstep, TAU } from './Util.js';

/**
 * Every pixel the VFX module ever samples is generated here, at boot, from
 * noise and canvas 2D. Nothing is loaded, nothing is base64'd.
 *
 * Conventions
 *  - Sprite atlases are *data*, not colour: they are tagged `NoColorSpace` and
 *    the shader multiplies them by scene-referred (linear) particle colours.
 *  - "Lit" atlases (smoke, dust) store a **normal** in RGB derived from the
 *    density gradient and the density itself in A, so a smoke puff can be lit
 *    by the sun and pick up rim scatter instead of being a flat grey blob.
 *  - Decal atlases are a real PBR set: sRGB albedo + tangent-space normal baked
 *    from a height field + packed ORM. Bullet holes genuinely dent the wall.
 */

/* -------------------------------------------------------------------------- */
/* canvas helpers                                                              */
/* -------------------------------------------------------------------------- */

export function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, w, h);
  return { canvas: c, ctx };
}

/** DataTexture from a top-down RGBA byte array (flips to GL row order). */
function dataTexture(src, w, h, { format = THREE.RGBAFormat, colorSpace = THREE.NoColorSpace, name = 'vfx' } = {}) {
  const stride = format === THREE.RGBAFormat ? 4 : 3;
  const out = new Uint8Array(w * h * stride);
  for (let y = 0; y < h; y++) {
    const s = (h - 1 - y) * w * stride;
    out.set(src.subarray(s, s + w * stride), y * w * stride);
  }
  const tex = new THREE.DataTexture(out, w, h, format, THREE.UnsignedByteType);
  tex.colorSpace = colorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.name = name;
  tex.needsUpdate = true;
  return tex;
}

function canvasTexture(canvas, { colorSpace = THREE.NoColorSpace, name = 'vfx' } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = colorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.name = name;
  tex.needsUpdate = true;
  return tex;
}

/* -------------------------------------------------------------------------- */
/* noise fields                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Seamless fbm on a torus: sampling 4D simplex around two circles makes the
 * field tile exactly, which matters because these get scrolled and wrapped for
 * decades of frames without ever showing a seam.
 */
export function tilingFbm(size, { octaves = 4, freq = 3, seed = 1337, gain = 0.5, lacunarity = 2.05 } = {}) {
  const rng = new Rng(seed);
  const noise = createNoise4D(() => rng.float());
  const out = new Float32Array(size * size);
  let min = Infinity, max = -Infinity;
  for (let y = 0; y < size; y++) {
    const v = (y / size) * TAU;
    const cv = Math.cos(v), sv = Math.sin(v);
    for (let x = 0; x < size; x++) {
      const u = (x / size) * TAU;
      const cu = Math.cos(u), su = Math.sin(u);
      let amp = 1, f = freq, sum = 0, norm = 0;
      for (let o = 0; o < octaves; o++) {
        sum += amp * noise(cu * f, su * f, cv * f, sv * f);
        norm += amp;
        amp *= gain; f *= lacunarity;
      }
      const val = sum / norm;
      out[y * size + x] = val;
      if (val < min) min = val;
      if (val > max) max = val;
    }
  }
  const inv = 1 / Math.max(1e-5, max - min);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - min) * inv;
  return out;
}

/** Bilinear, wrapping sample of a square Float32Array field. */
function sampleField(field, size, x, y) {
  let fx = x - Math.floor(x / size) * size;
  let fy = y - Math.floor(y / size) * size;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const x1 = (x0 + 1) % size, y1 = (y0 + 1) % size;
  const a = field[y0 * size + x0], b = field[y0 * size + x1];
  const c = field[y1 * size + x0], d = field[y1 * size + x1];
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}

/**
 * Tangent-space normal map from a height field. `strength` is in height units
 * per texel; the Sobel keeps the result stable at the low resolutions we use.
 */
function heightToNormal(height, w, h, strength, out, outStride, outOffset) {
  const at = (x, y) => height[clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv; ny *= inv; nz *= inv;
      const o = (y * w + x) * outStride + outOffset;
      // Canvas rows run top-down; tangent-space green is +Y up, hence the flip.
      out[o] = (nx * 0.5 + 0.5) * 255;
      out[o + 1] = (-ny * 0.5 + 0.5) * 255;
      out[o + 2] = (nz * 0.5 + 0.5) * 255;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* smoke / dust flipbook                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A volumetric-looking puff animation baked to a flipbook.
 *
 * Each frame is a metaball field of drifting blobs, modulated by a scrolling
 * fbm that expands with the puff (so detail grows with the cloud instead of
 * crawling across it), then eroded by a rising threshold so the cloud dissolves
 * into wisps instead of fading uniformly.
 */
export function buildPuffAtlas({
  tile = 128, tilesX = 8, tilesY = 8, blobs = 26, seed = 91,
  growth = 2.4, erode = 0.62, detail = 1.0, wispiness = 1.0, normalStrength = 2.4,
  name = 'vfxPuff',
} = {}) {
  const frames = tilesX * tilesY;
  const W = tile * tilesX, H = tile * tilesY;
  const rgba = new Uint8Array(W * H * 4);
  const rng = new Rng(seed);

  const NS = 192;
  const field = tilingFbm(NS, { octaves: 5, freq: 3, seed: seed + 7 });
  const field2 = tilingFbm(NS, { octaves: 3, freq: 7, seed: seed + 31 });

  // Blob definition — position on a squashed sphere with an outward drift.
  const bx = new Float32Array(blobs), by = new Float32Array(blobs);
  const dx = new Float32Array(blobs), dy = new Float32Array(blobs);
  const br = new Float32Array(blobs), bw = new Float32Array(blobs);
  for (let i = 0; i < blobs; i++) {
    const a = rng.float() * TAU;
    const rr = Math.pow(rng.float(), 0.55) * 0.140;
    bx[i] = Math.cos(a) * rr;
    by[i] = Math.sin(a) * rr * 0.92;
    const da = a + rng.gauss() * 0.5;
    const ds = 0.030 + rng.float() * 0.045;
    dx[i] = Math.cos(da) * ds;
    dy[i] = Math.sin(da) * ds - 0.02;
    br[i] = 0.150 + rng.float() * 0.090;
    bw[i] = 0.55 + rng.float() * 0.65;
  }

  const dens = new Float32Array(tile * tile);
  const hgt = new Float32Array(tile * tile);
  const nrm = new Uint8Array(tile * tile * 3);
  const inv = 1 / tile;

  for (let f = 0; f < frames; f++) {
    const t = frames > 1 ? f / (frames - 1) : 0;
    const grow = 1 + growth * Math.pow(t, 0.72);
    dens.fill(0);

    for (let i = 0; i < blobs; i++) {
      // The *framing* stays constant across the flipbook — the particle's own
      // size curve does the growing. What the frames show is turbulent
      // evolution and dissipation, which is what actually reads as smoke.
      const cx = (0.5 + (bx[i] + dx[i] * t)) * tile;
      const cy = (0.5 + (by[i] + dy[i] * t)) * tile;
      const rad = br[i] * tile * (1 + 0.25 * t);
      const w = bw[i] * (1 - 0.25 * t);
      const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(tile - 1, Math.ceil(cx + rad));
      const y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(tile - 1, Math.ceil(cy + rad));
      const r2 = rad * rad;
      for (let y = y0; y <= y1; y++) {
        const ddy = y + 0.5 - cy;
        for (let x = x0; x <= x1; x++) {
          const ddx = x + 0.5 - cx;
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 >= r2) continue;
          const k = 1 - d2 / r2;
          dens[y * tile + x] += w * k * k * k;
        }
      }
    }

    // fbm modulation: coordinates contract as the puff grows so features
    // appear to expand outward with the cloud.
    const nScale = (NS / tile) * (2.6 / grow) * detail;
    const nOff = t * 26;
    const threshold = erode * t;

    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        const i = y * tile + x;
        let d = dens[i];
        if (d <= 0.0005) { dens[i] = 0; hgt[i] = 0; continue; }
        const n1 = sampleField(field, NS, x * nScale + nOff * 0.6, y * nScale - nOff);
        const n2 = sampleField(field2, NS, x * nScale * 2.3 - nOff * 1.7, y * nScale * 2.3 + nOff * 0.9);
        const n = n1 * 0.72 + n2 * 0.28;
        // Wispy break-up: multiply, then erode with a rising floor.
        d *= 0.42 * lerp(1, 0.30 + 1.55 * n, 0.85 * wispiness);
        d -= threshold * (0.30 + 0.90 * (1 - n));
        // Soft clip rather than a hard saturate: a metaball sum of 4 and a sum
        // of 6 must not both flatten to solid white, or the puff reads as a
        // filled disc with a beaded rim instead of a cloud.
        d = d > 0 ? 1 - Math.exp(-d * 1.9) : 0;
        // Round vignette so nothing ever touches the tile edge (mip bleed).
        const ux = (x + 0.5) * inv - 0.5, uy = (y + 0.5) * inv - 0.5;
        const rr = Math.sqrt(ux * ux + uy * uy) * 2;
        d *= 1 - smoothstep((rr - 0.78) / 0.22);
        dens[i] = saturate(d);
        hgt[i] = dens[i];
      }
    }

    heightToNormal(hgt, tile, tile, normalStrength, nrm, 3, 0);

    const ox = (f % tilesX) * tile, oy = Math.floor(f / tilesX) * tile;
    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        const si = y * tile + x;
        const di = ((oy + y) * W + (ox + x)) * 4;
        rgba[di] = nrm[si * 3];
        rgba[di + 1] = nrm[si * 3 + 1];
        rgba[di + 2] = nrm[si * 3 + 2];
        rgba[di + 3] = Math.round(saturate(dens[si]) * 255);
      }
    }
  }

  return dataTexture(rgba, W, H, { name });
}

/* -------------------------------------------------------------------------- */
/* additive sprite atlas (sparks, flares, fire, droplets)                      */
/* -------------------------------------------------------------------------- */

function radial(ctx, x, y, r, stops) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(0.01, r));
  for (const [p, c] of stops) g.addColorStop(clamp(p, 0, 1), c);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
}

function star(ctx, x, y, r, points, inner, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const a = (i / (points * 2)) * TAU - Math.PI / 2;
    const rr = i % 2 === 0 ? r : r * inner;
    const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

/**
 * 4x4 additive atlas. The stretched-billboard modes put the particle *head* at
 * v = 1, i.e. the top of the canvas, so streaks are drawn head-up.
 */
export function buildSparkAtlas({ tile = 128, seed = 5 } = {}) {
  const tiles = 4;
  const size = tile * tiles;
  const { canvas, ctx } = newCanvas(size, size);
  const rng = new Rng(seed);
  ctx.clearRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'lighter';

  const cellAt = (i) => [(i % tiles) * tile, Math.floor(i / tiles) * tile];

  const streak = (i, width, headGlow, segments) => {
    const [ox, oy] = cellAt(i);
    ctx.save();
    ctx.translate(ox, oy);
    ctx.beginPath();
    ctx.rect(2, 2, tile - 4, tile - 4);
    ctx.clip();
    const cx = tile * 0.5;
    // tail -> head vertical gradient
    const g = ctx.createLinearGradient(0, tile, 0, 0);
    g.addColorStop(0.0, 'rgba(255,120,30,0)');
    g.addColorStop(0.35, 'rgba(255,150,50,0.20)');
    g.addColorStop(0.78, 'rgba(255,215,150,0.70)');
    g.addColorStop(0.94, 'rgba(255,255,250,1)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    for (let s = 0; s < 3; s++) {
      const w = width * tile * (1 + s * 1.9);
      ctx.globalAlpha = s === 0 ? 1 : 0.30 / s;
      ctx.fillStyle = g;
      ctx.fillRect(cx - w * 0.5, 0, w, tile);
    }
    ctx.globalAlpha = 1;
    if (segments) {
      // Broken ricochet trail: bright beads along the streak.
      ctx.globalCompositeOperation = 'lighter';
      for (let s = 0; s < 7; s++) {
        const y = tile * (0.10 + 0.80 * rng.float());
        const r = tile * (0.012 + rng.float() * 0.03);
        radial(ctx, cx + (rng.float() - 0.5) * tile * 0.05, y, r * 3.2, [
          [0, 'rgba(255,240,210,0.95)'], [0.4, 'rgba(255,170,70,0.35)'], [1, 'rgba(255,120,30,0)'],
        ]);
      }
    }
    radial(ctx, cx, tile * headGlow, tile * 0.16, [
      [0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,235,190,0.85)'],
      [0.6, 'rgba(255,150,60,0.28)'], [1, 'rgba(255,90,20,0)'],
    ]);
    ctx.restore();
  };

  // 0..3 : streaks
  streak(0, 0.028, 0.09, false);
  streak(1, 0.045, 0.10, false);
  streak(2, 0.020, 0.08, true);
  streak(3, 0.060, 0.12, true);

  // 4..6 : glints with star flares
  for (let i = 4; i <= 6; i++) {
    const [ox, oy] = cellAt(i);
    const cx = ox + tile * 0.5, cy = oy + tile * 0.5;
    const pts = i === 4 ? 4 : i === 5 ? 6 : 5;
    ctx.save();
    ctx.globalAlpha = 0.55;
    star(ctx, cx, cy, tile * 0.46, pts, 0.075, 'rgba(255,225,175,0.55)');
    ctx.globalAlpha = 1;
    radial(ctx, cx, cy, tile * 0.30, [
      [0, 'rgba(255,255,255,1)'], [0.14, 'rgba(255,246,225,0.95)'],
      [0.35, 'rgba(255,180,90,0.42)'], [0.7, 'rgba(255,110,30,0.10)'], [1, 'rgba(255,80,10,0)'],
    ]);
    ctx.restore();
  }

  // 7 : soft radial glow (muzzle/explosion light card)
  {
    const [ox, oy] = cellAt(7);
    radial(ctx, ox + tile * 0.5, oy + tile * 0.5, tile * 0.49, [
      [0, 'rgba(255,255,255,1)'], [0.18, 'rgba(255,244,220,0.72)'],
      [0.42, 'rgba(255,190,110,0.30)'], [0.72, 'rgba(255,120,40,0.08)'], [1, 'rgba(255,90,20,0)'],
    ]);
  }

  // 8..9 : fire wisps — lumpy blobs with a hot core
  for (let i = 8; i <= 9; i++) {
    const [ox, oy] = cellAt(i);
    const cx = ox + tile * 0.5, cy = oy + tile * 0.52;
    for (let b = 0; b < 9; b++) {
      const a = rng.float() * TAU, rr = rng.float() * tile * 0.18;
      radial(ctx, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 1.15, tile * (0.14 + rng.float() * 0.16), [
        [0, 'rgba(255,236,200,0.55)'], [0.35, 'rgba(255,160,60,0.30)'],
        [0.75, 'rgba(190,60,10,0.08)'], [1, 'rgba(120,30,0,0)'],
      ]);
    }
    radial(ctx, cx, cy - tile * 0.05, tile * 0.16, [
      [0, 'rgba(255,255,250,0.95)'], [0.4, 'rgba(255,215,150,0.45)'], [1, 'rgba(255,140,50,0)'],
    ]);
  }

  // 10..11 : droplets (head up), for water and blood in flight
  for (let i = 10; i <= 11; i++) {
    const [ox, oy] = cellAt(i);
    ctx.save();
    ctx.translate(ox + tile * 0.5, oy);
    const w = tile * (i === 10 ? 0.16 : 0.11);
    ctx.beginPath();
    ctx.moveTo(0, tile * 0.10);
    ctx.bezierCurveTo(w, tile * 0.26, w, tile * 0.60, 0, tile * 0.90);
    ctx.bezierCurveTo(-w, tile * 0.60, -w, tile * 0.26, 0, tile * 0.10);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, tile * 0.1, 0, tile * 0.9);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.45, 'rgba(215,225,235,0.75)');
    g.addColorStop(1, 'rgba(160,175,190,0.15)');
    ctx.fillStyle = g;
    ctx.fill();
    radial(ctx, -w * 0.25, tile * 0.34, w * 0.55, [
      [0, 'rgba(255,255,255,0.9)'], [1, 'rgba(255,255,255,0)'],
    ]);
    ctx.restore();
  }

  // 12..15 : soft dots of varying hardness (embers, glints, mist cores)
  for (let i = 12; i <= 15; i++) {
    const [ox, oy] = cellAt(i);
    const hard = (i - 12) / 3;
    radial(ctx, ox + tile * 0.5, oy + tile * 0.5, tile * 0.46, [
      [0, 'rgba(255,255,255,1)'],
      [lerp(0.08, 0.42, hard), `rgba(255,248,232,${lerp(0.55, 0.95, hard)})`],
      [lerp(0.35, 0.72, hard), 'rgba(255,205,150,0.18)'],
      [1, 'rgba(255,160,90,0)'],
    ]);
  }

  return canvasTexture(canvas, { name: 'vfxSparkAtlas' });
}

/* -------------------------------------------------------------------------- */
/* debris chip atlas                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Solid tumbling fragments: rock chips, wood splinters, glass shards, leaves.
 * RGB carries a baked shading gradient (so a spinning chip flickers between
 * lit and shadowed faces) and A is the silhouette.
 */
export function buildChipAtlas({ tile = 96, seed = 17 } = {}) {
  const tiles = 4;
  const size = tile * tiles;
  const { canvas, ctx } = newCanvas(size, size);
  const rng = new Rng(seed);

  const polygon = (ox, oy, verts, jag, aspect, rot) => {
    ctx.save();
    ctx.translate(ox + tile * 0.5, oy + tile * 0.5);
    ctx.rotate(rot);
    ctx.scale(1, aspect);
    ctx.beginPath();
    for (let i = 0; i < verts; i++) {
      const a = (i / verts) * TAU;
      const r = tile * 0.30 * (1 - jag * rng.float());
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.restore();
  };

  const shade = (ox, oy, top, bottom, edge) => {
    const g = ctx.createLinearGradient(ox, oy, ox + tile * 0.35, oy + tile);
    g.addColorStop(0, top);
    g.addColorStop(0.55, bottom);
    g.addColorStop(1, edge);
    return g;
  };

  const cell = (i) => [(i % tiles) * tile, Math.floor(i / tiles) * tile];

  // 0..5 rock / concrete chips
  for (let i = 0; i <= 5; i++) {
    const [ox, oy] = cell(i);
    polygon(ox, oy, 7 + rng.int(4), 0.42, 0.6 + rng.float() * 0.7, rng.float() * TAU);
    ctx.fillStyle = shade(ox, oy, 'rgba(255,255,255,1)', 'rgba(150,150,152,1)', 'rgba(58,58,62,1)');
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.stroke();
  }

  // 6..9 wood splinters — long slivers with a fibre gradient
  for (let i = 6; i <= 9; i++) {
    const [ox, oy] = cell(i);
    ctx.save();
    ctx.translate(ox + tile * 0.5, oy + tile * 0.5);
    ctx.rotate(rng.float() * TAU);
    const L = tile * (0.27 + rng.float() * 0.08), Wd = tile * (0.030 + rng.float() * 0.04);
    ctx.beginPath();
    ctx.moveTo(-L, -Wd * 0.4);
    ctx.lineTo(L * 0.2, -Wd);
    ctx.lineTo(L, -Wd * 0.15);
    ctx.lineTo(L, Wd * 0.2);
    ctx.lineTo(-L * 0.1, Wd);
    ctx.lineTo(-L, Wd * 0.5);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, -Wd, 0, Wd);
    g.addColorStop(0, 'rgba(255,246,232,1)');
    g.addColorStop(0.45, 'rgba(188,150,104,1)');
    g.addColorStop(1, 'rgba(78,55,32,1)');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
  }

  // 10..12 glass shards — sharp triangles with a bright refracting edge
  for (let i = 10; i <= 12; i++) {
    const [ox, oy] = cell(i);
    ctx.save();
    ctx.translate(ox + tile * 0.5, oy + tile * 0.5);
    ctx.rotate(rng.float() * TAU);
    ctx.beginPath();
    const p = [];
    for (let k = 0; k < 3 + (i === 12 ? 1 : 0); k++) {
      const a = (k / 3.4) * TAU + rng.float() * 0.6;
      p.push([Math.cos(a) * tile * (0.16 + rng.float() * 0.26), Math.sin(a) * tile * (0.16 + rng.float() * 0.26)]);
    }
    ctx.moveTo(p[0][0], p[0][1]);
    for (let k = 1; k < p.length; k++) ctx.lineTo(p[k][0], p[k][1]);
    ctx.closePath();
    const g = ctx.createLinearGradient(-tile * 0.3, -tile * 0.3, tile * 0.3, tile * 0.3);
    g.addColorStop(0, 'rgba(255,255,255,0.92)');
    g.addColorStop(0.4, 'rgba(190,225,235,0.30)');
    g.addColorStop(0.75, 'rgba(235,250,255,0.72)');
    g.addColorStop(1, 'rgba(255,255,255,0.95)');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.stroke();
    ctx.restore();
  }

  // 13..15 foliage / fabric scraps — flat leaves with a midrib
  for (let i = 13; i <= 15; i++) {
    const [ox, oy] = cell(i);
    ctx.save();
    ctx.translate(ox + tile * 0.5, oy + tile * 0.5);
    ctx.rotate(rng.float() * TAU);
    ctx.beginPath();
    const L = tile * 0.36, Wd = tile * (0.12 + rng.float() * 0.08);
    ctx.moveTo(-L, 0);
    ctx.quadraticCurveTo(0, -Wd, L, 0);
    ctx.quadraticCurveTo(0, Wd, -L, 0);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, -Wd, 0, Wd);
    g.addColorStop(0, 'rgba(240,255,225,1)');
    g.addColorStop(0.5, 'rgba(150,180,110,1)');
    g.addColorStop(1, 'rgba(60,80,45,1)');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(230,245,210,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-L, 0); ctx.lineTo(L, 0);
    ctx.stroke();
    ctx.restore();
  }

  return canvasTexture(canvas, { name: 'vfxChipAtlas' });
}

/* -------------------------------------------------------------------------- */
/* blood atlas                                                                 */
/* -------------------------------------------------------------------------- */

/** Airborne blood: fine mist, fat droplets, ropey streaks. RGB = shading. */
export function buildBloodAtlas({ tile = 96, seed = 404 } = {}) {
  const tiles = 4;
  const size = tile * tiles;
  const { canvas, ctx } = newCanvas(size, size);
  const rng = new Rng(seed);
  const cell = (i) => [(i % tiles) * tile, Math.floor(i / tiles) * tile];

  // 0..5 mist clusters
  for (let i = 0; i <= 5; i++) {
    const [ox, oy] = cell(i);
    const cx = ox + tile * 0.5, cy = oy + tile * 0.5;
    for (let b = 0; b < 26; b++) {
      const a = rng.float() * TAU;
      const rr = Math.pow(rng.float(), 0.6) * tile * 0.36;
      const r = tile * (0.012 + rng.float() * 0.055);
      radial(ctx, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, r, [
        [0, 'rgba(255,235,235,0.95)'], [0.5, 'rgba(200,140,140,0.55)'], [1, 'rgba(120,60,60,0)'],
      ]);
    }
  }
  // 6..9 fat droplets with a specular pip
  for (let i = 6; i <= 9; i++) {
    const [ox, oy] = cell(i);
    const cx = ox + tile * 0.5, cy = oy + tile * 0.5;
    const r = tile * (0.22 + rng.float() * 0.13);
    radial(ctx, cx, cy, r, [
      [0, 'rgba(255,225,225,1)'], [0.55, 'rgba(215,150,150,1)'],
      [0.9, 'rgba(120,55,55,0.9)'], [1, 'rgba(80,30,30,0)'],
    ]);
    radial(ctx, cx - r * 0.32, cy - r * 0.34, r * 0.34, [
      [0, 'rgba(255,255,255,0.95)'], [1, 'rgba(255,255,255,0)'],
    ]);
  }
  // 10..12 ropey streaks
  for (let i = 10; i <= 12; i++) {
    const [ox, oy] = cell(i);
    ctx.save();
    ctx.translate(ox + tile * 0.5, oy + tile * 0.5);
    ctx.rotate(rng.float() * TAU);
    ctx.beginPath();
    ctx.moveTo(-tile * 0.34, 0);
    ctx.quadraticCurveTo(0, tile * (rng.float() - 0.5) * 0.3, tile * 0.34, 0);
    ctx.lineWidth = tile * (0.06 + rng.float() * 0.06);
    ctx.lineCap = 'round';
    const g = ctx.createLinearGradient(-tile * 0.34, 0, tile * 0.34, 0);
    g.addColorStop(0, 'rgba(150,80,80,0)');
    g.addColorStop(0.4, 'rgba(235,180,180,0.9)');
    g.addColorStop(1, 'rgba(255,225,225,1)');
    ctx.strokeStyle = g;
    ctx.stroke();
    ctx.restore();
  }
  // 13..15 soft haze cores for the mist cloud
  for (let i = 13; i <= 15; i++) {
    const [ox, oy] = cell(i);
    radial(ctx, ox + tile * 0.5, oy + tile * 0.5, tile * 0.47, [
      [0, 'rgba(255,225,225,0.85)'], [0.35, 'rgba(210,140,140,0.45)'],
      [0.7, 'rgba(140,70,70,0.15)'], [1, 'rgba(90,40,40,0)'],
    ]);
  }

  return canvasTexture(canvas, { name: 'vfxBloodAtlas' });
}

/* -------------------------------------------------------------------------- */
/* decal atlas (albedo + normal + ORM)                                         */
/* -------------------------------------------------------------------------- */

export const DECAL = {
  HOLE_CONCRETE: 0, HOLE_CONCRETE_B: 1, HOLE_METAL: 2, HOLE_METAL_B: 3,
  HOLE_WOOD: 4, HOLE_SAND: 5, HOLE_SOFT: 6, GLASS_CRACK: 7,
  GLASS_HOLE: 8, SCORCH: 9, CRATER: 10, BLOOD_A: 11,
  BLOOD_B: 12, BLOOD_DRIP: 13, BLOOD_POOL: 14, DUST_RING: 15,
};

/**
 * 4x4 decal sheet. Each tile is authored as albedo + height + roughness; the
 * normal map is a Sobel of the height, so a 9 mm hole in concrete has a real
 * lip and a real crater that catches the sun from the correct side.
 */
export function buildDecalAtlas({ tile = 256, seed = 777 } = {}) {
  const tiles = 4;
  const W = tile * tiles;
  const rng = new Rng(seed);
  const noise = tilingFbm(128, { octaves: 5, freq: 4, seed: seed + 3 });
  const noiseB = tilingFbm(128, { octaves: 3, freq: 11, seed: seed + 9 });

  const albedo = new Uint8Array(W * W * 4);
  const normal = new Uint8Array(W * W * 4);
  const orm = new Uint8Array(W * W * 4);
  const height = new Float32Array(tile * tile);
  const nrmTile = new Uint8Array(tile * tile * 3);

  const { canvas, ctx } = newCanvas(tile, tile);

  const blit = (index) => {
    const img = ctx.getImageData(0, 0, tile, tile).data;
    heightToNormal(height, tile, tile, 3.2, nrmTile, 3, 0);
    const ox = (index % tiles) * tile, oy = Math.floor(index / tiles) * tile;
    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        const si = (y * tile + x);
        const di = ((oy + y) * W + (ox + x));
        albedo[di * 4] = img[si * 4];
        albedo[di * 4 + 1] = img[si * 4 + 1];
        albedo[di * 4 + 2] = img[si * 4 + 2];
        albedo[di * 4 + 3] = img[si * 4 + 3];
        normal[di * 4] = nrmTile[si * 3];
        normal[di * 4 + 1] = nrmTile[si * 3 + 1];
        normal[di * 4 + 2] = nrmTile[si * 3 + 2];
        normal[di * 4 + 3] = 255;
        orm[di * 4] = ormBuf[si * 3];
        orm[di * 4 + 1] = ormBuf[si * 3 + 1];
        orm[di * 4 + 2] = ormBuf[si * 3 + 2];
        orm[di * 4 + 3] = 255;
      }
    }
  };

  const ormBuf = new Uint8Array(tile * tile * 3);

  const beginTile = () => {
    ctx.clearRect(0, 0, tile, tile);
    height.fill(0.5);
    for (let i = 0; i < ormBuf.length; i += 3) { ormBuf[i] = 255; ormBuf[i + 1] = 200; ormBuf[i + 2] = 0; }
  };

  /** Per-pixel pass: cb(x, y, u, v, r, n1, n2) -> [r,g,b,a, height, ao, rough, metal] | null */
  const pixels = (cb) => {
    const img = ctx.getImageData(0, 0, tile, tile);
    const d = img.data;
    const inv = 1 / tile;
    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        const u = (x + 0.5) * inv * 2 - 1;
        const v = (y + 0.5) * inv * 2 - 1;
        const r = Math.sqrt(u * u + v * v);
        const n1 = sampleField(noise, 128, x * 0.5, y * 0.5);
        const n2 = sampleField(noiseB, 128, x * 0.5, y * 0.5);
        const out = cb(x, y, u, v, r, n1, n2);
        if (!out) continue;
        const i = (y * tile + x);
        d[i * 4] = clamp(out[0] * 255, 0, 255);
        d[i * 4 + 1] = clamp(out[1] * 255, 0, 255);
        d[i * 4 + 2] = clamp(out[2] * 255, 0, 255);
        d[i * 4 + 3] = clamp(out[3] * 255, 0, 255);
        height[i] = out[4];
        ormBuf[i * 3] = clamp(out[5] * 255, 0, 255);
        ormBuf[i * 3 + 1] = clamp(out[6] * 255, 0, 255);
        ormBuf[i * 3 + 2] = clamp((out[7] || 0) * 255, 0, 255);
      }
    }
    ctx.putImageData(img, 0, 0);
  };

  /* ---- bullet holes ---------------------------------------------------- */

  const bulletHole = (index, opts) => {
    const {
      coreR = 0.13, lipR = 0.30, ringR = 0.62, jag = 0.35,
      core = [0.012, 0.010, 0.009], lip = [0.30, 0.28, 0.26], ring = [0.55, 0.53, 0.50],
      dust = [0.72, 0.70, 0.66], cracks = 0, crackLen = 0.9, depth = 0.42,
      rimRough = 0.9, coreRough = 0.85, metal = 0, petals = 0, spread = 1,
    } = opts;
    beginTile();

    // Crack rays are precomputed as angular masks so they can perturb both the
    // alpha and the height field consistently.
    const rays = [];
    for (let i = 0; i < cracks; i++) {
      rays.push({ a: rng.float() * TAU, len: crackLen * (0.4 + rng.float() * 0.85), w: 0.012 + rng.float() * 0.02 });
    }
    const petalPhase = rng.float() * TAU;

    pixels((x, y, u, v, r, n1, n2) => {
      const ang = Math.atan2(v, u);
      const wob = (n1 - 0.5) * jag + (n2 - 0.5) * jag * 0.5;
      let rr = r * (1 + wob * 0.55) / spread;
      if (petals) rr *= 1 - 0.095 * Math.cos(ang * petals + petalPhase);

      let a = 1 - smoothstep((rr - ringR) / 0.30);
      // crack rays extend the footprint
      let crack = 0;
      for (let i = 0; i < rays.length; i++) {
        const ray = rays[i];
        let da = ang - ray.a;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        const along = rr / Math.max(0.05, ray.len);
        if (along > 1) continue;
        const w = ray.w * (1 - along * 0.8) + 0.004;
        const m = (1 - smoothstep((Math.abs(da) * Math.max(0.12, rr) - w) / (w * 1.6))) * (1 - along);
        crack = Math.max(crack, m);
      }
      a = Math.max(a, crack * 0.9);
      if (a <= 0.004) return null;

      const inCore = 1 - smoothstep((rr - coreR) / 0.06);
      const inLip = (1 - smoothstep((rr - lipR) / 0.14)) * (1 - inCore);
      const inRing = (1 - smoothstep((rr - ringR) / 0.26)) * (1 - inCore) * (1 - inLip * 0.6);

      const grain = 0.82 + n2 * 0.36;
      let cr = core[0] * inCore + lip[0] * inLip + ring[0] * inRing + dust[0] * (1 - inCore) * (1 - inLip) * a * 0.25;
      let cg = core[1] * inCore + lip[1] * inLip + ring[1] * inRing + dust[1] * (1 - inCore) * (1 - inLip) * a * 0.25;
      let cb = core[2] * inCore + lip[2] * inLip + ring[2] * inRing + dust[2] * (1 - inCore) * (1 - inLip) * a * 0.25;
      cr *= grain; cg *= grain; cb *= grain;
      cr = Math.max(cr, crack * 0.62); cg = Math.max(cg, crack * 0.60); cb = Math.max(cb, crack * 0.58);

      // Coverage: only the crater and its lip fully replace the wall. The
      // powder ring is a thin veil — a decal that reads as an opaque donut is
      // the classic tell of a stamped quad.
      a *= saturate(inCore + inLip * 0.92 + inRing * 0.42 + crack * 0.9 + 0.10)
         * (0.62 + 0.62 * n2);
      a = saturate(a);

      // height: crater in the middle, raised lip, gentle spall outward
      const h = 0.5
        - depth * inCore
        - depth * 0.45 * inLip * (1 - inCore)
        + 0.16 * inLip
        + 0.05 * (n1 - 0.5) * a
        - crack * 0.14;

      const ao = 1 - 0.85 * inCore - 0.25 * inLip;
      const rough = coreRough * inCore + rimRough * (1 - inCore) - 0.15 * (n2 - 0.5);
      return [cr, cg, cb, a, h, ao, rough, metal * (inLip + inCore)];
    });
    blit(index);
  };

  bulletHole(DECAL.HOLE_CONCRETE, {
    cracks: 7, crackLen: 0.95, jag: 0.42, ringR: 0.55,
    core: [0.010, 0.009, 0.008], lip: [0.30, 0.285, 0.27], ring: [0.50, 0.487, 0.462], dust: [0.60, 0.585, 0.555],
  });
  bulletHole(DECAL.HOLE_CONCRETE_B, {
    cracks: 4, crackLen: 0.7, jag: 0.55, coreR: 0.10, lipR: 0.26, ringR: 0.55,
    core: [0.014, 0.012, 0.011], lip: [0.26, 0.25, 0.235], ring: [0.46, 0.452, 0.428], dust: [0.56, 0.55, 0.52],
  });
  bulletHole(DECAL.HOLE_METAL, {
    cracks: 0, jag: 0.22, coreR: 0.12, lipR: 0.26, ringR: 0.46, petals: 6, depth: 0.30,
    core: [0.006, 0.006, 0.007], lip: [0.62, 0.60, 0.58], ring: [0.26, 0.24, 0.26], dust: [0.30, 0.28, 0.30],
    rimRough: 0.34, coreRough: 0.55, metal: 0.85,
  });
  bulletHole(DECAL.HOLE_METAL_B, {
    cracks: 0, jag: 0.30, coreR: 0.09, lipR: 0.21, ringR: 0.40, petals: 5, depth: 0.26,
    core: [0.008, 0.007, 0.007], lip: [0.70, 0.66, 0.60], ring: [0.20, 0.19, 0.20], dust: [0.24, 0.23, 0.24],
    rimRough: 0.28, coreRough: 0.5, metal: 0.9,
  });
  bulletHole(DECAL.HOLE_WOOD, {
    cracks: 9, crackLen: 1.15, jag: 0.5, coreR: 0.11, lipR: 0.28, ringR: 0.5, depth: 0.5,
    core: [0.012, 0.008, 0.005], lip: [0.30, 0.19, 0.10], ring: [0.44, 0.30, 0.17], dust: [0.52, 0.38, 0.22],
    rimRough: 0.92, coreRough: 0.95,
  });
  bulletHole(DECAL.HOLE_SAND, {
    cracks: 0, jag: 0.62, coreR: 0.18, lipR: 0.40, ringR: 0.80, depth: 0.30, spread: 1.15,
    core: [0.18, 0.14, 0.10], lip: [0.36, 0.29, 0.20], ring: [0.52, 0.44, 0.32], dust: [0.66, 0.58, 0.44],
    rimRough: 0.98, coreRough: 1.0,
  });
  bulletHole(DECAL.HOLE_SOFT, {
    cracks: 3, crackLen: 0.5, jag: 0.5, coreR: 0.09, lipR: 0.20, ringR: 0.36, depth: 0.22,
    core: [0.02, 0.02, 0.02], lip: [0.24, 0.23, 0.22], ring: [0.40, 0.39, 0.38], dust: [0.5, 0.49, 0.48],
  });

  /* ---- glass ----------------------------------------------------------- */

  const glass = (index, holed) => {
    beginTile();
    const rays = [];
    const n = 11 + rng.int(6);
    for (let i = 0; i < n; i++) {
      rays.push({
        a: (i / n) * TAU + rng.gauss() * 0.18,
        len: 0.55 + rng.float() * 0.5,
        w: 0.010 + rng.float() * 0.016,
        bend: rng.gauss() * 0.35,
      });
    }
    const rings = [];
    for (let i = 0; i < 5; i++) rings.push({ r: 0.16 + i * 0.16 + rng.float() * 0.05, w: 0.008 + rng.float() * 0.01 });

    pixels((x, y, u, v, r, n1, n2) => {
      const ang = Math.atan2(v, u);
      let line = 0;
      for (let i = 0; i < rays.length; i++) {
        const ray = rays[i];
        const along = r / ray.len;
        if (along > 1) continue;
        let da = ang - (ray.a + ray.bend * along * along);
        da = Math.atan2(Math.sin(da), Math.cos(da));
        const w = ray.w * (1 - along * 0.55) + 0.003;
        const m = (1 - smoothstep((Math.abs(da) * Math.max(0.10, r) - w) / (w * 1.2))) * (1 - along * 0.7);
        line = Math.max(line, m);
      }
      for (let i = 0; i < rings.length; i++) {
        const rg = rings[i];
        const wob = rg.r * (1 + (n1 - 0.5) * 0.28);
        const m = (1 - smoothstep((Math.abs(r - wob) - rg.w) / (rg.w * 1.5))) * (1 - smoothstep((r - 0.92) / 0.1));
        // Concentric cracks only exist where a radial crack already passes.
        line = Math.max(line, m * 0.85 * smoothstep(line * 3));
      }
      const hole = holed ? 1 - smoothstep((r * (1 + (n1 - 0.5) * 0.5) - 0.15) / 0.07) : 0;
      let a = saturate(line * 0.95 + hole);
      a *= 1 - smoothstep((r - 0.92) / 0.08);
      if (a <= 0.004) return null;
      const white = 0.42 + n2 * 0.22;
      const h = 0.5 + line * 0.22 - hole * 0.6;
      return [white, white * 1.01, white * 1.04, a * 0.62, h, 1 - hole * 0.6, 0.12 + 0.3 * (1 - line), 0];
    });
    blit(index);
  };
  glass(DECAL.GLASS_CRACK, false);
  glass(DECAL.GLASS_HOLE, true);

  /* ---- scorch / crater -------------------------------------------------- */

  const scorch = (index, { big = false } = {}) => {
    beginTile();
    pixels((x, y, u, v, r, n1, n2) => {
      const wob = 1 + (n1 - 0.5) * (big ? 0.75 : 0.5);
      const rr = r * wob;
      let a = 1 - smoothstep((rr - (big ? 0.42 : 0.34)) / (big ? 0.5 : 0.42));
      a *= 0.55 + 0.6 * n2;
      a = saturate(a);
      if (a <= 0.004) return null;
      const core = 1 - smoothstep((rr - 0.16) / 0.30);
      const soot = lerp(0.095, 0.030, core) * (0.6 + n2 * 0.8);
      const h = 0.5 - (big ? 0.32 : 0.12) * core + (n1 - 0.5) * 0.06;
      return [soot * 1.02, soot * 0.94, soot * 0.88, a * (big ? 0.95 : 0.85), h, 1 - core * 0.5, 0.94, 0];
    });
    blit(index);
  };
  scorch(DECAL.SCORCH, {});
  scorch(DECAL.CRATER, { big: true });

  /* ---- blood ------------------------------------------------------------ */

  const spatter = (index, { drips = 0, directional = 1, pool = false } = {}) => {
    beginTile();
    // Canvas pass first: blobs and drips as real shapes, then a pixel pass adds
    // the wet-film height, the darkened rim and the roughness.
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#ffffff';
    const cx = tile * 0.5, cy = pool ? tile * 0.5 : tile * (0.5 - 0.06 * directional);
    if (pool) {
      ctx.beginPath();
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * TAU;
        const rr = tile * (0.30 + 0.09 * Math.sin(a * 3 + 1.2) + 0.06 * Math.sin(a * 5.3 + 0.4) + 0.03 * Math.sin(a * 9.1));
        const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr * 0.92;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    } else {
      const blobs = 7;
      for (let i = 0; i < blobs; i++) {
        const a = rng.float() * TAU;
        const rr = Math.pow(rng.float(), 0.7) * tile * 0.20;
        const R = tile * (0.05 + rng.float() * 0.11);
        ctx.beginPath();
        ctx.ellipse(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, R, R * (0.7 + rng.float() * 0.5), rng.float() * TAU, 0, TAU);
        ctx.fill();
      }
      // satellite droplets, biased along the impact direction (down-canvas)
      for (let i = 0; i < 90; i++) {
        const a = rng.float() * TAU;
        const bias = 0.35 + 0.65 * Math.pow(rng.float(), 0.5);
        const rr = bias * tile * 0.46 * (1 + directional * 0.35 * Math.sin(a));
        const R = tile * (0.004 + Math.pow(rng.float(), 2.4) * 0.045);
        ctx.beginPath();
        ctx.ellipse(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * (1 + directional * 0.25), R, R * (1 + rng.float() * 0.9), a, 0, TAU);
        ctx.fill();
      }
      // ropey connecting streaks
      for (let i = 0; i < 8; i++) {
        const a = rng.float() * TAU;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * tile * 0.08, cy + Math.sin(a) * tile * 0.08);
        ctx.quadraticCurveTo(
          cx + Math.cos(a) * tile * 0.26 + rng.gauss() * 10,
          cy + Math.sin(a) * tile * 0.26 + rng.gauss() * 10,
          cx + Math.cos(a) * tile * (0.30 + rng.float() * 0.16),
          cy + Math.sin(a) * tile * (0.30 + rng.float() * 0.16),
        );
        ctx.lineWidth = tile * (0.006 + rng.float() * 0.014);
        ctx.lineCap = 'round';
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }
    }
    for (let i = 0; i < drips; i++) {
      const x0 = cx + rng.gauss() * tile * 0.14;
      const len = tile * (0.10 + rng.float() * 0.32);
      const w = tile * (0.008 + rng.float() * 0.016);
      ctx.beginPath();
      ctx.moveTo(x0 - w, cy);
      ctx.lineTo(x0 + w, cy);
      ctx.lineTo(x0 + w * 0.55, cy + len);
      ctx.lineTo(x0 - w * 0.55, cy + len);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x0, cy + len, w * 1.25, 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    // Blur the mask slightly for a wet edge, using a cheap two-pass box on the
    // alpha we just drew.
    const img = ctx.getImageData(0, 0, tile, tile);
    const src = img.data;
    const mask = new Float32Array(tile * tile);
    for (let i = 0; i < tile * tile; i++) mask[i] = src[i * 4 + 3] / 255;
    const tmp = new Float32Array(tile * tile);
    const R = 1;
    for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) {
      let s = 0, c = 0;
      for (let k = -R; k <= R; k++) { const xx = clamp(x + k, 0, tile - 1); s += mask[y * tile + xx]; c++; }
      tmp[y * tile + x] = s / c;
    }
    for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) {
      let s = 0, c = 0;
      for (let k = -R; k <= R; k++) { const yy = clamp(y + k, 0, tile - 1); s += tmp[yy * tile + x]; c++; }
      mask[y * tile + x] = s / c;
    }

    pixels((x, y, u, v, r, n1, n2) => {
      const m = mask[y * tile + x];
      if (m <= 0.005) return null;
      const edge = smoothstep(m * 2.2);
      const thick = smoothstep((m - 0.35) / 0.5);
      // Fresh blood is dark and glossy in the body, brighter and matte at the
      // dried edge. Values stay low: this is albedo, not "red paint".
      const base = lerp(0.16, 0.045, thick);
      const cr = base * lerp(1.6, 1.0, thick);
      const cg = base * lerp(0.30, 0.13, thick);
      const cb = base * lerp(0.24, 0.11, thick);
      const h = 0.5 + thick * 0.10 + (n2 - 0.5) * 0.02;
      const rough = lerp(0.62, 0.14, thick * edge);
      return [cr, cg, cb, saturate(m * 1.35), h, 1 - thick * 0.15, rough, 0];
    });
    blit(index);
  };
  spatter(DECAL.BLOOD_A, { drips: 0, directional: 1 });
  spatter(DECAL.BLOOD_B, { drips: 5, directional: 0.6 });
  spatter(DECAL.BLOOD_DRIP, { drips: 11, directional: 0.2 });
  spatter(DECAL.BLOOD_POOL, { drips: 0, directional: 0, pool: true });

  /* ---- dust ring -------------------------------------------------------- */

  {
    beginTile();
    pixels((x, y, u, v, r, n1, n2) => {
      const rr = r * (1 + (n1 - 0.5) * 0.55);
      const ring = (1 - smoothstep((Math.abs(rr - 0.5) - 0.16) / 0.30));
      let a = saturate(ring * (0.35 + n2 * 0.75)) * (1 - smoothstep((r - 0.9) / 0.12));
      if (a <= 0.004) return null;
      const g = 0.55 + n2 * 0.3;
      return [g, g * 0.98, g * 0.94, a * 0.6, 0.5 + a * 0.03, 1, 0.97, 0];
    });
    blit(DECAL.DUST_RING);
  }

  return {
    albedo: dataTexture(albedo, W, W, { colorSpace: THREE.SRGBColorSpace, name: 'vfxDecalAlbedo' }),
    normal: dataTexture(normal, W, W, { format: THREE.RGBAFormat, name: 'vfxDecalNormal' }),
    orm: dataTexture(orm, W, W, { format: THREE.RGBAFormat, name: 'vfxDecalORM' }),
    tiles,
  };
}

/* -------------------------------------------------------------------------- */
/* gradient ramp LUT                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Colour-over-life and size-over-life curves for every particle profile, baked
 * into one texture. Row `2i` is RGBA colour/alpha, row `2i+1` packs
 * R = size envelope, G = emissive boost, B = unused, A = unused.
 *
 * Colours are scene-referred and are allowed to exceed 1: they are stored
 * divided by `EMISSIVE_RANGE` and re-expanded in the shader.
 */
export const EMISSIVE_RANGE = 16;

export function buildRampTexture(profiles, width = 128) {
  const rows = profiles.length * 2;
  const data = new Uint8Array(width * rows * 4);
  const tmp = new THREE.Vector4();
  for (let p = 0; p < profiles.length; p++) {
    const prof = profiles[p];
    for (let x = 0; x < width; x++) {
      const t = width > 1 ? x / (width - 1) : 0;
      sampleGradient4(prof.color, t, tmp);
      const i0 = ((p * 2) * width + x) * 4;
      data[i0] = clamp((tmp.x / EMISSIVE_RANGE) * 255, 0, 255);
      data[i0 + 1] = clamp((tmp.y / EMISSIVE_RANGE) * 255, 0, 255);
      data[i0 + 2] = clamp((tmp.z / EMISSIVE_RANGE) * 255, 0, 255);
      data[i0 + 3] = clamp(tmp.w * 255, 0, 255);

      const i1 = ((p * 2 + 1) * width + x) * 4;
      data[i1] = clamp(curveAt(prof.size, t) * 255, 0, 255);
      data[i1 + 1] = clamp(curveAt(prof.emissive, t, 0) * 255, 0, 255);
      data[i1 + 2] = clamp(curveAt(prof.turbulence, t, 0) * 255, 0, 255);
      data[i1 + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, width, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.name = 'vfxRamps';
  tex.needsUpdate = true;
  return tex;
}

function sampleGradient4(stops, t, out) {
  if (!stops || !stops.length) return out.set(1, 1, 1, 1);
  if (t <= stops[0][0]) { const s = stops[0]; return out.set(s[1], s[2], s[3], s[4]); }
  for (let i = 1; i < stops.length; i++) {
    const s1 = stops[i];
    if (t <= s1[0]) {
      const s0 = stops[i - 1];
      const k = (t - s0[0]) / Math.max(1e-5, s1[0] - s0[0]);
      return out.set(
        lerp(s0[1], s1[1], k), lerp(s0[2], s1[2], k),
        lerp(s0[3], s1[3], k), lerp(s0[4], s1[4], k),
      );
    }
  }
  const s = stops[stops.length - 1];
  return out.set(s[1], s[2], s[3], s[4]);
}

function curveAt(stops, t, fallback = 1) {
  if (!stops || !stops.length) return fallback;
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const a = stops[i - 1], b = stops[i];
      const k = (t - a[0]) / Math.max(1e-5, b[0] - a[0]);
      return lerp(a[1], b[1], k);
    }
  }
  return stops[stops.length - 1][1];
}

/* -------------------------------------------------------------------------- */
/* misc utility textures                                                       */
/* -------------------------------------------------------------------------- */

/** Single-tile soft glow with a faint anamorphic streak, for flash cards. */
export function buildGlowTexture({ size = 256, streak = 0.35 } = {}) {
  const { canvas, ctx } = newCanvas(size, size);
  const c = size * 0.5;
  ctx.globalCompositeOperation = 'lighter';
  radial(ctx, c, c, size * 0.48, [
    [0, 'rgba(255,255,255,1)'], [0.10, 'rgba(255,250,236,0.86)'],
    [0.26, 'rgba(255,214,158,0.42)'], [0.52, 'rgba(255,150,70,0.14)'],
    [0.78, 'rgba(255,110,40,0.04)'], [1, 'rgba(255,90,20,0)'],
  ]);
  if (streak > 0) {
    const g = ctx.createLinearGradient(0, c, size, c);
    g.addColorStop(0, 'rgba(255,190,120,0)');
    g.addColorStop(0.5, `rgba(255,225,180,${streak})`);
    g.addColorStop(1, 'rgba(255,190,120,0)');
    ctx.fillStyle = g;
    const h = size * 0.045;
    ctx.fillRect(0, c - h * 0.5, size, h);
    const g2 = ctx.createLinearGradient(c, 0, c, size);
    g2.addColorStop(0, 'rgba(255,190,120,0)');
    g2.addColorStop(0.5, `rgba(255,225,180,${streak * 0.55})`);
    g2.addColorStop(1, 'rgba(255,190,120,0)');
    ctx.fillStyle = g2;
    ctx.fillRect(c - h * 0.35, 0, h * 0.7, size);
  }
  return canvasTexture(canvas, { name: 'vfxGlow' });
}

/** Seamless RGB noise used for fireball turbulence and heat-haze advection. */
export function buildNoiseTexture(size = 256, seed = 24) {
  const a = tilingFbm(size, { octaves: 5, freq: 3, seed });
  const b = tilingFbm(size, { octaves: 4, freq: 7, seed: seed + 101 });
  const c = tilingFbm(size, { octaves: 3, freq: 13, seed: seed + 211 });
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = a[i] * 255;
    data[i * 4 + 1] = b[i] * 255;
    data[i * 4 + 2] = c[i] * 255;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.name = 'vfxNoise';
  tex.needsUpdate = true;
  return tex;
}

/** 1D blackbody-ish fire ramp for the explosion shader. */
export function buildFireRamp(width = 128) {
  const data = new Uint8Array(width * 4);
  const stops = [
    [0.00, 0.02, 0.02, 0.03],
    [0.14, 0.55, 0.13, 0.03],
    [0.32, 1.60, 0.42, 0.06],
    [0.55, 3.20, 1.30, 0.24],
    [0.76, 6.00, 3.40, 1.10],
    [1.00, 9.00, 7.20, 4.60],
  ];
  const v = new THREE.Vector4();
  for (let x = 0; x < width; x++) {
    const t = x / (width - 1);
    sampleGradient4(stops.map((s) => [s[0], s[1], s[2], s[3], 1]), t, v);
    data[x * 4] = clamp((v.x / EMISSIVE_RANGE) * 255, 0, 255);
    data[x * 4 + 1] = clamp((v.y / EMISSIVE_RANGE) * 255, 0, 255);
    data[x * 4 + 2] = clamp((v.z / EMISSIVE_RANGE) * 255, 0, 255);
    data[x * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, width, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.name = 'vfxFireRamp';
  tex.needsUpdate = true;
  return tex;
}
