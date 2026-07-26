/**
 * Structural passes — the man-made geometry that noise alone can never produce.
 *
 * Every function is tileable and returns a bag of Float32 fields:
 *   h     height contribution (0..1)
 *   mask  "in the joint / gap / seam" coverage
 *   id    per-element random value (colour + height variation)
 *   edge  proximity to an element border, for chipping and edge wear
 *
 * Recipes compose these with the noise fields; the whole difference between a
 * WebGL demo wall and a shippable one is how many of these passes are stacked.
 */
import { mulberry32, hash2i } from './Noise.js';
import { clamp01, smoothstep } from './Fields.js';

const fract = (v) => v - Math.floor(v);

/**
 * Running-bond masonry. Courses stagger by half a brick, every brick gets its
 * own height, tilt and colour id, and the mortar bed sits proud-then-recessed
 * with a raked profile like real pointing.
 */
export function brickCourses(size, opts = {}) {
  const {
    rows = 14, cols = 7, stagger = 0.5, joint = 0.012, bevel = 0.008,
    heightJitter = 0.16, tilt = 0.06, seed = 17,
  } = opts;
  const rng = mulberry32(seed);
  const count = rows * cols;
  const bh = new Float32Array(count);
  const bid = new Float32Array(count);
  const tx = new Float32Array(count);
  const ty = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    bh[i] = 1 - rng() * heightJitter;
    bid[i] = rng();
    tx[i] = rng() - 0.5;
    ty[i] = rng() - 0.5;
  }

  const n = size * size;
  const h = new Float32Array(n);
  const mask = new Float32Array(n);
  const id = new Float32Array(n);
  const edge = new Float32Array(n);
  const inv = 1 / size;
  const halfJoint = joint * 0.5;

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) * inv;
    const rf = v * rows;
    const row = Math.floor(rf) % rows;
    const fv = rf - Math.floor(rf);
    const shift = (row & 1) * stagger / cols;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) * inv;
      const uu = fract(u + shift);
      const cf = uu * cols;
      const col = Math.floor(cf) % cols;
      const fu = cf - Math.floor(cf);

      const du = Math.min(fu, 1 - fu) / cols;
      const dv = Math.min(fv, 1 - fv) / rows;
      const d = Math.min(du, dv);
      const face = smoothstep(halfJoint, halfJoint + bevel, d);

      const i = row * cols + col;
      const o = y * size + x;
      const brick = bh[i] + (tx[i] * (fu - 0.5) + ty[i] * (fv - 0.5)) * tilt;
      // Raked joint: mortar recedes, but sits slightly proud right at the lip.
      const mortarH = 0.42 + smoothstep(0, halfJoint, d) * 0.14;
      h[o] = mortarH + (brick - mortarH) * face;
      mask[o] = 1 - face;
      id[o] = bid[i];
      edge[o] = 1 - smoothstep(halfJoint + bevel, halfJoint + bevel + 0.02, d);
    }
  }
  return { h, mask, id, edge };
}

/** Square/rect grid: ceramic tile, cladding, checker plate frames. */
export function tileGrid(size, opts = {}) {
  const { rows = 8, cols = 8, joint = 0.010, bevel = 0.012, heightJitter = 0.03, seed = 23, crownAmount = 0.10 } = opts;
  const rng = mulberry32(seed);
  const count = rows * cols;
  const th = new Float32Array(count);
  const tid = new Float32Array(count);
  for (let i = 0; i < count; i++) { th[i] = 1 - rng() * heightJitter; tid[i] = rng(); }

  const n = size * size;
  const h = new Float32Array(n);
  const mask = new Float32Array(n);
  const id = new Float32Array(n);
  const edge = new Float32Array(n);
  const inv = 1 / size;
  const hj = joint * 0.5;

  for (let y = 0; y < size; y++) {
    const rf = (y + 0.5) * inv * rows;
    const row = Math.floor(rf) % rows;
    const fv = rf - Math.floor(rf);
    for (let x = 0; x < size; x++) {
      const cf = (x + 0.5) * inv * cols;
      const col = Math.floor(cf) % cols;
      const fu = cf - Math.floor(cf);
      const du = Math.min(fu, 1 - fu) / cols;
      const dv = Math.min(fv, 1 - fv) / rows;
      const d = Math.min(du, dv);
      const face = smoothstep(hj, hj + bevel, d);
      const i = row * cols + col;
      const o = y * size + x;
      // Slight pillow crown so specular highlights bend across each tile.
      const crown = Math.sin(fu * Math.PI) * Math.sin(fv * Math.PI) * crownAmount;
      h[o] = 0.35 + (th[i] + crown - 0.35) * face;
      mask[o] = 1 - face;
      id[o] = tid[i];
      edge[o] = 1 - smoothstep(hj + bevel, hj + bevel + 0.025, d);
    }
  }
  return { h, mask, id, edge };
}

/**
 * Board rows with random plank lengths and per-plank cupping. Used for decking,
 * crates, boarded-up windows and the plywood in every breach room ever built.
 */
export function plankRows(size, opts = {}) {
  const { rows = 6, perRow = 2, gap = 0.006, bevel = 0.006, cup = 0.09, seed = 41 } = opts;
  const rng = mulberry32(seed);
  const phase = new Float32Array(rows);
  const count = rows * perRow;
  const ph = new Float32Array(count);
  const pid = new Float32Array(count);
  for (let i = 0; i < rows; i++) phase[i] = rng();
  for (let i = 0; i < count; i++) { ph[i] = 1 - rng() * 0.12; pid[i] = rng(); }

  const n = size * size;
  const h = new Float32Array(n);
  const mask = new Float32Array(n);
  const id = new Float32Array(n);
  const edge = new Float32Array(n);
  const along = new Float32Array(n); // 0..1 across the plank width, for cupping/grain
  const inv = 1 / size;
  const hg = gap * 0.5;

  for (let y = 0; y < size; y++) {
    const rf = (y + 0.5) * inv * rows;
    const row = Math.floor(rf) % rows;
    const fv = rf - Math.floor(rf);
    const dv = Math.min(fv, 1 - fv) / rows;
    for (let x = 0; x < size; x++) {
      const cf = fract((x + 0.5) * inv + phase[row]) * perRow;
      const col = Math.floor(cf) % perRow;
      const fu = cf - Math.floor(cf);
      const du = Math.min(fu, 1 - fu) / perRow;
      const d = Math.min(du, dv);
      const face = smoothstep(hg, hg + bevel, d);
      const i = row * perRow + col;
      const o = y * size + x;
      const cupped = ph[i] - Math.cos(fv * Math.PI * 2) * 0.5 * cup - cup * 0.5;
      h[o] = 0.30 + (cupped - 0.30) * face;
      mask[o] = 1 - face;
      id[o] = pid[i];
      edge[o] = 1 - smoothstep(hg + bevel, hg + bevel + 0.02, d);
      along[o] = fv;
    }
  }
  return { h, mask, id, edge, along };
}

/**
 * Riveted sheet-metal panels: recessed seams, chamfered panel lips and a row of
 * dome rivets inset from every edge.
 */
export function panelSeams(size, opts = {}) {
  const { rows = 3, cols = 2, seam = 0.006, bevel = 0.010, rivets = 7, rivetR = 0.010,
          rivetInset = 0.026, heightJitter = 0.05, seed = 59 } = opts;
  const rng = mulberry32(seed);
  const count = rows * cols;
  const pnH = new Float32Array(count);
  const pnId = new Float32Array(count);
  for (let i = 0; i < count; i++) { pnH[i] = 1 - rng() * heightJitter; pnId[i] = rng(); }

  const n = size * size;
  const h = new Float32Array(n);
  const mask = new Float32Array(n);
  const id = new Float32Array(n);
  const edge = new Float32Array(n);
  const rivet = new Float32Array(n);
  const inv = 1 / size;
  const hs = seam * 0.5;

  for (let y = 0; y < size; y++) {
    const rf = (y + 0.5) * inv * rows;
    const row = Math.floor(rf) % rows;
    const fv = rf - Math.floor(rf);
    for (let x = 0; x < size; x++) {
      const cf = (x + 0.5) * inv * cols;
      const col = Math.floor(cf) % cols;
      const fu = cf - Math.floor(cf);
      const du = Math.min(fu, 1 - fu) / cols;
      const dv = Math.min(fv, 1 - fv) / rows;
      const d = Math.min(du, dv);
      const face = smoothstep(hs, hs + bevel, d);
      const i = row * cols + col;
      const o = y * size + x;
      h[o] = 0.34 + (pnH[i] - 0.34) * face;
      mask[o] = 1 - face;
      id[o] = pnId[i];
      edge[o] = 1 - smoothstep(hs + bevel, hs + bevel + 0.03, d);

      // Rivets: march along each panel border at a fixed inset. Written with
      // scalars rather than a per-pixel array — this loop runs a million times.
      let rv = 0;
      if (rivets > 0) {
        const bu = fu / cols, bv = fv / rows;
        const wu = 1 / cols, wv = 1 / rows;
        const alongV = Math.abs(fract(fv * rivets) - 0.5) / (rivets * rows);
        const alongU = Math.abs(fract(fu * rivets) - 0.5) / (rivets * cols);
        // Dome profile rather than a plateau: a rivet has to catch a moving
        // specular highlight across its crown or it reads as a painted circle.
        const dome = (dd) => {
          if (dd >= rivetR) return 0;
          const t = dd / rivetR;
          return Math.sqrt(Math.max(0, 1 - t * t)) * (1 - smoothstep(0.82, 1.0, t));
        };
        let perp = bu - rivetInset;
        rv = Math.max(rv, dome(Math.sqrt(perp * perp + alongV * alongV)));
        perp = (wu - bu) - rivetInset;
        rv = Math.max(rv, dome(Math.sqrt(perp * perp + alongV * alongV)));
        perp = bv - rivetInset;
        rv = Math.max(rv, dome(Math.sqrt(perp * perp + alongU * alongU)));
        perp = (wv - bv) - rivetInset;
        rv = Math.max(rv, dome(Math.sqrt(perp * perp + alongU * alongU)));
      }
      rivet[o] = rv;
      h[o] += rv * 0.16 * face;
    }
  }
  return { h, mask, id, edge, rivet };
}

/** Corrugated sheet: trapezoidal ribs with a crisp shoulder radius. */
export function corrugation(size, opts = {}) {
  const { ribs = 9, flat = 0.34, shoulder = 0.14, depth = 1, vertical = false, seed = 71 } = opts;
  const n = size * size;
  const h = new Float32Array(n);
  const crest = new Float32Array(n);
  const inv = 1 / size;
  const rng = mulberry32(seed);
  const wob = new Float32Array(ribs);
  for (let i = 0; i < ribs; i++) wob[i] = 1 - rng() * 0.07;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = (vertical ? (y + 0.5) : (x + 0.5)) * inv * ribs;
      const rib = Math.floor(t) % ribs;
      const f = t - Math.floor(t);
      // Trapezoid: flat top, sloped web, flat valley.
      const a = smoothstep(0, shoulder, f) - smoothstep(0.5 - shoulder * 0.5, 0.5 + shoulder * 0.5, f)
              + smoothstep(1 - shoulder, 1, f);
      const o = y * size + x;
      const v = clamp01(a);
      h[o] = (0.18 + v * 0.72 * depth) * wob[rib];
      crest[o] = smoothstep(flat, 1.0, v);
    }
  }
  return { h, crest };
}

/**
 * Stitched seam lines with visible thread bumps — sandbags, webbing, plate
 * carriers. `rows` seams run horizontally, `stitches` per unit length.
 */
export function stitchRows(size, opts = {}) {
  const { rows = 3, stitches = 42, thread = 0.35, depth = 0.10, wander = 0.010, seed = 83 } = opts;
  const n = size * size;
  const h = new Float32Array(n);
  const mask = new Float32Array(n);
  const inv = 1 / size;
  const rng = mulberry32(seed);
  const rowY = new Float32Array(rows);
  for (let i = 0; i < rows; i++) rowY[i] = (i + 0.5) / rows;

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) * inv;
      const o = y * size + x;
      let best = 0;
      for (let i = 0; i < rows; i++) {
        const yy = rowY[i] + Math.sin(u * Math.PI * 2 * 3 + i * 2.1) * wander;
        let dv = Math.abs(v - yy);
        dv = Math.min(dv, 1 - dv);
        const line = 1 - smoothstep(0.004, 0.012, dv);
        if (line <= 0) continue;
        const s = fract(u * stitches);
        const bead = (1 - smoothstep(thread * 0.5, thread, Math.abs(s - 0.5))) * line;
        // seam pucker: fabric pulls in toward the stitch line
        const pucker = -(1 - smoothstep(0.004, 0.030, dv)) * depth;
        const val = pucker + bead * depth * 1.6;
        if (Math.abs(val) > Math.abs(best)) best = val;
        if (line > mask[o]) mask[o] = line;
      }
      h[o] = best;
    }
  }
  // rng consumed for determinism parity with other passes
  rng();
  return { h, mask };
}

/**
 * Board-formed concrete: horizontal shutter impressions with a slight lip at
 * every board joint, plus form-tie cone holes on a regular grid.
 */
export function formBoards(size, opts = {}) {
  const { boards = 5, lip = 0.020, ties = 2, tieR = 0.020, seed = 97 } = opts;
  const n = size * size;
  const h = new Float32Array(n);
  const mask = new Float32Array(n);
  const inv = 1 / size;
  const rng = mulberry32(seed);
  const bOff = new Float32Array(boards);
  const bTilt = new Float32Array(boards);
  for (let i = 0; i < boards; i++) { bOff[i] = (rng() - 0.5) * 0.03; bTilt[i] = (rng() - 0.5) * 0.02; }
  const tieX = new Float32Array(ties * ties);
  const tieY = new Float32Array(ties * ties);
  for (let i = 0; i < ties * ties; i++) {
    tieX[i] = ((i % ties) + 0.5) / ties + (rng() - 0.5) * 0.04;
    tieY[i] = (Math.floor(i / ties) + 0.5) / ties + (rng() - 0.5) * 0.04;
  }

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) * inv;
    const bf = v * boards;
    const bi = Math.floor(bf) % boards;
    const fv = bf - Math.floor(bf);
    const dv = Math.min(fv, 1 - fv) / boards;
    const joint = 1 - smoothstep(0.0015, 0.006, dv);
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) * inv;
      const o = y * size + x;
      let hv = 0.5 + bOff[bi] + bTilt[bi] * (u - 0.5);
      // grout ridge squeezed out between shutter boards
      hv += joint * lip - (1 - smoothstep(0.004, 0.020, dv)) * lip * 0.35;
      let tie = 0;
      for (let i = 0; i < ties * ties; i++) {
        let dx = u - tieX[i]; dx -= Math.round(dx);
        let dy = v - tieY[i]; dy -= Math.round(dy);
        const d = Math.sqrt(dx * dx + dy * dy);
        const cone = 1 - smoothstep(tieR * 0.35, tieR, d);
        if (cone > tie) tie = cone;
      }
      hv -= tie * 0.16;
      h[o] = hv;
      mask[o] = Math.max(joint, tie);
    }
  }
  return { h, mask };
}

/**
 * Over-under woven cloth. `threads` warp/weft pairs across the tile; `twill`
 * shifts the interlace per row to make a diagonal rather than a plain weave.
 */
export function weave(size, opts = {}) {
  const { threads = 48, twill = 0, gap = 0.16, round = 1.6, seed = 101 } = opts;
  const n = size * size;
  const h = new Float32Array(n);
  const warpMask = new Float32Array(n);
  const inv = 1 / size;
  const rng = mulberry32(seed);
  const jitter = new Float32Array(threads * 2);
  for (let i = 0; i < threads * 2; i++) jitter[i] = 1 - rng() * 0.22;

  for (let y = 0; y < size; y++) {
    const tv = (y + 0.5) * inv * threads;
    const ry = Math.floor(tv) % threads;
    const fv = tv - Math.floor(tv);
    for (let x = 0; x < size; x++) {
      const tu = (x + 0.5) * inv * threads;
      const rx = Math.floor(tu) % threads;
      const fu = tu - Math.floor(tu);
      const o = y * size + x;

      const su = Math.max(0, 1 - Math.pow(Math.abs(fu - 0.5) * 2 / (1 - gap), round));
      const sv = Math.max(0, 1 - Math.pow(Math.abs(fv - 0.5) * 2 / (1 - gap), round));
      const over = ((rx + ry + (twill ? Math.floor(ry / Math.max(1, twill)) : 0)) & 1) === 0;
      const warpH = su * jitter[rx];
      const weftH = sv * jitter[threads + ry];
      const top = over ? warpH : weftH;
      const bot = over ? weftH * 0.55 : warpH * 0.55;
      h[o] = 0.22 + Math.max(top, bot) * 0.78;
      warpMask[o] = over ? 1 : 0;
    }
  }
  return { h, mask: warpMask };
}

/**
 * Crack network from a Worley F2−F1 ridge, thinned and randomly broken so it
 * reads like fatigue cracking rather than a Voronoi diagram.
 */
export function crackNetwork(size, cellField, breakField, opts = {}) {
  const { width = 0.055, softness = 0.09, breakThreshold = 0.42, depth = 1 } = opts;
  const n = size * size;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ridge = 1 - smoothstep(width, width + softness, cellField[i]);
    const alive = smoothstep(breakThreshold, breakThreshold + 0.22, breakField[i]);
    out[i] = ridge * alive * depth;
  }
  return out;
}

/**
 * Directional scratches — brushed metal, drag marks, machining passes.
 * Uses a hashed line lattice rather than noise so the strokes stay coherent
 * over long distances the way real abrasion does.
 */
export function scratches(size, opts = {}) {
  const { count = 220, angle = 0.0, spread = 0.25, lengthMin = 0.05, lengthMax = 0.5,
          width = 1.4, seed = 131 } = opts;
  const n = size * size;
  const out = new Float32Array(n);
  const rng = mulberry32(seed);
  for (let s = 0; s < count; s++) {
    const a = angle + (rng() - 0.5) * spread * Math.PI;
    const len = (lengthMin + rng() * (lengthMax - lengthMin)) * size;
    const x0 = rng() * size;
    const y0 = rng() * size;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const amp = 0.25 + rng() * 0.75;
    const w = width * (0.5 + rng());
    const steps = Math.ceil(len);
    for (let t = 0; t < steps; t++) {
      const fade = Math.sin((t / steps) * Math.PI);
      const px = x0 + dx * t;
      const py = y0 + dy * t;
      const ix = Math.round(px);
      const iy = Math.round(py);
      const rad = Math.ceil(w);
      for (let oy = -rad; oy <= rad; oy++) {
        for (let ox = -rad; ox <= rad; ox++) {
          const d = Math.sqrt((ix + ox - px) ** 2 + (iy + oy - py) ** 2);
          const v = Math.max(0, 1 - d / w) * fade * amp;
          if (v <= 0) continue;
          const xx = ((ix + ox) % size + size) % size;
          const yy = ((iy + oy) % size + size) % size;
          const o = yy * size + xx;
          if (v > out[o]) out[o] = v;
        }
      }
    }
  }
  return out;
}

/** Scattered blobs — bullet pitting, rust bloom seeds, gravel highlights. */
export function pitting(size, opts = {}) {
  const { count = 900, rMin = 0.6, rMax = 3.2, depth = 1, seed = 149 } = opts;
  const n = size * size;
  const out = new Float32Array(n);
  const rng = mulberry32(seed);
  for (let i = 0; i < count; i++) {
    const cx = rng() * size;
    const cy = rng() * size;
    const r = rMin + rng() * (rMax - rMin);
    const amp = (0.35 + rng() * 0.65) * depth;
    const rad = Math.ceil(r) + 1;
    for (let oy = -rad; oy <= rad; oy++) {
      for (let ox = -rad; ox <= rad; ox++) {
        const d = Math.sqrt(ox * ox + oy * oy);
        if (d > r) continue;
        const v = Math.cos((d / r) * Math.PI * 0.5) ** 2 * amp;
        const xx = ((Math.round(cx) + ox) % size + size) % size;
        const yy = ((Math.round(cy) + oy) % size + size) % size;
        const o = yy * size + xx;
        if (v > out[o]) out[o] = v;
      }
    }
  }
  return out;
}

/**
 * Leaf-cluster rasteriser for foliage cards: scatters rotated leaf blades with
 * a midrib and a coverage mask so the card silhouette is actually leaf-shaped.
 */
export function leafCluster(size, opts = {}) {
  const { count = 46, lenMin = 0.12, lenMax = 0.30, ratio = 0.34, seed = 163, midrib = 0.5 } = opts;
  const n = size * size;
  const cover = new Float32Array(n);
  const height = new Float32Array(n);
  const tint = new Float32Array(n);
  const rng = mulberry32(seed);

  for (let i = 0; i < count; i++) {
    const cx = rng() * size;
    const cy = rng() * size;
    const a = rng() * Math.PI * 2;
    const L = (lenMin + rng() * (lenMax - lenMin)) * size;
    const W = L * ratio;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const shade = 0.35 + rng() * 0.65;
    const lift = 0.4 + rng() * 0.6;
    const rad = Math.ceil(L * 0.6) + 2;
    for (let oy = -rad; oy <= rad; oy++) {
      for (let ox = -rad; ox <= rad; ox++) {
        // rotate into leaf space
        const lx = (ox * ca + oy * sa) / (L * 0.5);
        const ly = (-ox * sa + oy * ca) / (W * 0.5);
        if (lx < -1 || lx > 1) continue;
        // lanceolate profile: widest at 40% of the blade
        const prof = Math.pow(Math.max(0, 1 - lx * lx), 0.55) * (0.55 + 0.45 * Math.cos(lx * 1.2));
        if (Math.abs(ly) > prof) continue;
        const t = Math.abs(ly) / Math.max(prof, 1e-4);
        const xx = ((Math.round(cx) + ox) % size + size) % size;
        const yy = ((Math.round(cy) + oy) % size + size) % size;
        const o = yy * size + xx;
        cover[o] = 1;
        const rib = (1 - smoothstep(0.0, midrib * 0.25, t)) * 0.5;
        const veins = Math.abs(Math.sin(lx * 22 + ly * 6)) * 0.12;
        const hv = lift * (0.55 + rib * 0.45 - t * 0.22 + veins * 0.4);
        if (hv > height[o]) { height[o] = hv; tint[o] = shade; }
      }
    }
  }
  return { cover, height, tint };
}

/** Deterministic per-cell scatter value; helper for recipes that need it. */
export function cellNoise(size, cells, seed = 7) {
  const out = new Float32Array(size * size);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    const cy = Math.floor((y + 0.5) * inv * cells);
    for (let x = 0; x < size; x++) {
      const cx = Math.floor((x + 0.5) * inv * cells);
      out[y * size + x] = hash2i(cx, cy, seed);
    }
  }
  return out;
}
