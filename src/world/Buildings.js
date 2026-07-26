import * as THREE from 'three';
import {
  bevelBox, cylinderGeo, sphereGeo, latheGeo, torusGeo, clothGeo, awningGeo,
  catenaryPoints, tubeGeo, trs,
} from './GeoUtil.js';
import { clamp } from './Rng.js';

/**
 * Architectural building generator.
 *
 * Everything here is composed the way a mason would compose it, not the way a
 * box modeller would: walls have real thickness so every opening gets a reveal,
 * openings are formed by leaving gaps between pier / spandrel / apron segments
 * rather than by boolean subtraction, floors are slabs with a soffit, stairs
 * are individual treads with a stringer, and every parapet gets a coping stone
 * that oversails it by 40 mm. Each of those is a few extra boxes; together they
 * are the difference between a building and a cuboid with a texture on it.
 *
 * All geometry is authored in building-local space (origin at the footprint
 * centre, y = 0 at the ground) and pushed through one matrix, so a building can
 * be rotated a few degrees off the street grid for free.
 */

const WALL_T = 0.34;        // exterior wall thickness
const PART_T = 0.16;        // interior partition thickness
const SLAB_T = 0.28;        // floor slab
const _mA = new THREE.Matrix4();
const _mB = new THREE.Matrix4();

export class Buildings {
  constructor(world) {
    this.world = world;
    this.game = world.game;
    this.interiors = [];      // {id, bounds, floors} for AI/nav hints
  }

  build(spec, ctx) {
    const world = this.world;
    const rng = world.rng.fork(hashId(spec.id));
    // Sit on the natural terrain, not on the sand that has drifted against the
    // walls — otherwise the floor rises with its own drift and interiors end up
    // knee deep.
    const baseY = ctx.terrain.baseHeight(spec.cx, spec.cz);
    const rot = (spec.rot || 0) * Math.PI / 180;
    // Buildings are *not* given their own culling group: with four shadow
    // cascades, one draw call per (material, building) costs far more than the
    // triangles a tighter frustum test would save, so they fall into the shared
    // spatial chunks with everything else.
    const chunk = undefined;
    const M = new THREE.Matrix4().compose(
      new THREE.Vector3(spec.cx, baseY, spec.cz),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot),
      new THREE.Vector3(1, 1, 1),
    );

    const b = {
      spec, rng, M, baseY, rot,
      hw: spec.w * 0.5, hd: spec.d * 0.5,
      floors: spec.floors ?? 2,
      fh: spec.floorH ?? 3.5,
      batcher: ctx.batcher,
      instancer: ctx.instancer,
      terrain: ctx.terrain,
      lights: ctx.lights,
      chunk,
      put: (geo, local, def) => {
        ctx.batcher.add(geo, _mA.multiplyMatrices(M, local), { chunk, ...def });
      },
      inst: (key, geo, local, def) => {
        ctx.instancer.add(key, geo, _mB.multiplyMatrices(M, local).clone(), def);
      },
      world: (local) => new THREE.Vector3().setFromMatrixPosition(_mA.multiplyMatrices(M, local)),
    };

    this._plinth(b);

    switch (spec.style) {
      case 'hall': this._hall(b); break;
      case 'warehouse': this._warehouse(b); break;
      case 'tower': this._tower(b); break;
      case 'ruin': this._ruin(b); break;
      default: this._townhouse(b); break;
    }

    if (spec.enterable) {
      this.interiors.push({
        id: spec.id,
        centre: new THREE.Vector3(spec.cx, baseY, spec.cz),
        halfW: b.hw, halfD: b.hd, rot, floors: b.floors, floorH: b.fh,
      });
    }
    return b;
  }

  /* ================================================================ */
  /* shared pieces                                                     */
  /* ================================================================ */

  /**
   * A stepped plinth that follows the sand drift up the wall. Buildings that
   * meet the ground on a hard line look like decals.
   */
  _plinth(b) {
    const { spec } = b;
    const top = 0.14;                     // finished floor level, wall base
    b.put(bevelBox(spec.w + 0.55, 0.62, spec.d + 0.55, 0.05, { uvOffset: [0, 0, 0] }),
      trs(0, top - 0.31, 0),
      { mat: spec.accent === 'brick' ? 'brick' : 'concrete', surface: 'concrete' });
    // Skirting course: catches a shadow line where the render meets the plinth.
    b.put(bevelBox(spec.w + 0.20, 0.16, spec.d + 0.20, 0.03),
      trs(0, top - 0.08, 0),
      { mat: 'concrete', surface: 'concrete' });
    b.groundY = top;
  }

  /**
   * Straight wall run in local space from (x0,z0) to (x1,z1), between y0 and
   * y1, punched by `openings` given as {at, width, sill, head}. Returns the
   * run length so callers can lay openings out proportionally.
   */
  _wallRun(b, x0, z0, x1, z1, y0, y1, thickness, openings, def) {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) return 0;
    const ux = dx / len, uz = dz / len;
    const yaw = Math.atan2(-uz, ux);
    const put = (a1, a2, ya, yb, extraDef) => {
      const w = a2 - a1;
      if (w <= 0.02 || yb - ya <= 0.02) return;
      const mid = (a1 + a2) * 0.5;
      const cy = (ya + yb) * 0.5;
      b.put(
        bevelBox(w, yb - ya, thickness, 0.026, { uvOffset: [mid, cy, 0] }),
        trs(x0 + ux * mid, cy, z0 + uz * mid, yaw),
        { ...def, ...extraDef },
      );
    };

    const sorted = (openings || []).slice().sort((p, q) => p.at - q.at);
    let cursor = 0;
    for (const o of sorted) {
      const a = o.at - o.width * 0.5;
      const c = o.at + o.width * 0.5;
      put(cursor, a, y0, y1);
      if (o.sill > y0 + 0.01) put(a, c, y0, o.sill);
      if (o.head < y1 - 0.01) put(a, c, o.head, y1);
      // lintel: a slightly proud beam over every opening
      if (o.head < y1 - 0.01) {
        const mid = o.at;
        b.put(bevelBox(o.width + 0.5, 0.20, thickness + 0.10, 0.03, { uvOffset: [mid, o.head, 0] }),
          trs(x0 + ux * mid, o.head + 0.10, z0 + uz * mid, yaw),
          { mat: def.accent || 'concrete', surface: 'concrete' });
      }
      // sill: oversails the wall so rain streaks start somewhere
      if (o.sill > y0 + 0.4) {
        const mid = o.at;
        b.put(bevelBox(o.width + 0.34, 0.09, thickness + 0.18, 0.02, { uvOffset: [mid, o.sill, 0] }),
          trs(x0 + ux * mid, o.sill - 0.045, z0 + uz * mid, yaw),
          { mat: def.accent || 'concrete', surface: 'concrete' });
      }
      cursor = c;
    }
    put(cursor, len, y0, y1);
    return len;
  }

  /**
   * Wall-local frame for openings: `along` runs left-to-right across the
   * facade, `out` is the outward normal. Every offset below is expressed in
   * that frame, so the same code lays a window into any of the four walls of a
   * building sitting at any yaw.
   */
  _frame(yaw) {
    return {
      tx: Math.cos(yaw), tz: -Math.sin(yaw),
      ox: Math.sin(yaw), oz: Math.cos(yaw),
    };
  }

  /** Window: frame, mullions, glass, an interior light card and often shutters. */
  _window(b, x, z, yaw, y0, y1, width, opts = {}) {
    const rng = b.rng;
    const h = y1 - y0;
    const cy = (y0 + y1) * 0.5;
    const t = 0.07;
    const frameDef = { mat: 'wood', surface: 'wood' };
    const f = this._frame(yaw);
    const at = (along, out) => [x + f.tx * along + f.ox * out, z + f.tz * along + f.oz * out];

    // frame
    let p = at(0, 0);
    b.put(bevelBox(width, t, 0.13, 0.014), trs(p[0], y0 + t * 0.5, p[1], yaw), frameDef);
    b.put(bevelBox(width, t, 0.13, 0.014), trs(p[0], y1 - t * 0.5, p[1], yaw), frameDef);
    for (const s of [-1, 1]) {
      const q = at(s * (width - t) * 0.5, 0);
      b.put(bevelBox(t, h, 0.13, 0.014), trs(q[0], cy, q[1], yaw), frameDef);
    }
    // mullion + transom
    b.put(bevelBox(0.045, h - t * 2, 0.10, 0.01), trs(p[0], cy, p[1], yaw), frameDef);
    b.put(bevelBox(width - t * 2, 0.045, 0.10, 0.01), trs(p[0], cy + h * 0.18, p[1], yaw), frameDef);

    // the room behind: near-black by day, warm at night
    const inw = at(0, opts.inward ?? -0.10);
    b.put(bevelBox(width - 0.1, h - 0.1, 0.03, 0.008),
      trs(inw[0], cy, inw[1], yaw),
      { mat: 'windowLight', surface: 'glass', cast: false, collide: false });

    if (!opts.noGlass) {
      const gp = at(0, 0.005);
      b.put(bevelBox(width - 0.13, h - 0.13, 0.018, 0.004),
        trs(gp[0], cy, gp[1], yaw),
        { mat: 'glass', surface: 'glass', cast: false, collide: true });
    }

    // shutters, sometimes ajar, sometimes missing a leaf
    if (opts.shutters !== false && rng.chance(0.72)) {
      const leaf = width * 0.5 - 0.02;
      for (const s of [-1, 1]) {
        if (rng.chance(0.12)) continue;
        const swing = rng.chance(0.35) ? rng.range(0.5, 1.25) : 0;
        const cs = Math.cos(swing), sn = Math.sin(swing);
        // hinge on the outer jamb, leaf swings out into the street
        const hingeAlong = s * width * 0.5;
        const cAlong = hingeAlong - s * cs * leaf * 0.5;
        const cOut = 0.085 + sn * leaf * 0.5;
        const q = at(cAlong, cOut);
        const leafYaw = yaw - s * swing;
        b.put(bevelBox(leaf, h * 0.98, 0.05, 0.012, { uvOffset: [hingeAlong, cy, 0] }),
          trs(q[0], cy, q[1], leafYaw),
          { mat: 'wood', surface: 'wood', tiling: 1 });
        // Louvre slats. Unchamfered on purpose: a 22 mm slat never shows an
        // edge highlight and there are three thousand of them in the level.
        const lf = this._frame(leafYaw);
        const slats = Math.min(6, Math.max(3, Math.floor(h * 4)));
        for (let i = 0; i < slats; i++) {
          const sy = y0 + (i + 0.5) * (h / slats);
          b.put(bevelBox(leaf * 0.86, 0.052, 0.022, 0),
            trs(q[0] + lf.ox * 0.033, sy, q[1] + lf.oz * 0.033, leafYaw),
            { mat: 'wood', surface: 'wood', cast: false });
        }
      }
    }
  }

  /** Door: reveal frame, leaf, threshold, handle. */
  _door(b, x, z, yaw, width, height, opts = {}) {
    const rng = b.rng;
    const cy = height * 0.5;
    const f = this._frame(yaw);
    const at = (along, out) => [x + f.tx * along + f.ox * out, z + f.tz * along + f.oz * out];

    let p = at(0, 0);
    b.put(bevelBox(width + 0.24, 0.12, 0.22, 0.02), trs(p[0], height + 0.06, p[1], yaw),
      { mat: 'wood', surface: 'wood' });
    for (const s of [-1, 1]) {
      const q = at(s * (width * 0.5 + 0.06), 0);
      b.put(bevelBox(0.12, height, 0.22, 0.02), trs(q[0], cy, q[1], yaw),
        { mat: 'wood', surface: 'wood' });
    }
    const th = at(0, 0.08);
    b.put(bevelBox(width + 0.3, 0.10, 0.5, 0.02), trs(th[0], 0.05, th[1], yaw),
      { mat: 'concrete', surface: 'concrete', cast: false });

    if (opts.leaf !== false) {
      const open = opts.open ?? (rng.chance(0.4) ? rng.range(0.3, 1.5) : 0);
      const cs = Math.cos(open), sn = Math.sin(open);
      // hinged on the left jamb, swinging inward
      const cAlong = -width * 0.5 + cs * width * 0.5;
      const cOut = -sn * width * 0.5;
      const q = at(cAlong, cOut);
      const leafYaw = yaw + open;
      const lf = this._frame(leafYaw);
      b.put(bevelBox(width - 0.04, height - 0.04, 0.075, 0.014, { uvOffset: [0, cy, 0] }),
        trs(q[0], cy, q[1], leafYaw),
        { mat: 'metal_rusted', surface: 'metal', tiling: 1 });
      for (const py of [height * 0.28, height * 0.68]) {
        b.put(bevelBox(width * 0.62, height * 0.26, 0.02, 0.006),
          trs(q[0] + lf.ox * 0.05, py, q[1] + lf.oz * 0.05, leafYaw),
          { mat: 'metal_rusted', surface: 'metal', cast: false });
      }
      b.put(cylinderGeo(0.028, 0.028, 0.16, 8),
        trs(q[0] + lf.tx * width * 0.38 + lf.ox * 0.07, height * 0.48,
          q[1] + lf.tz * width * 0.38 + lf.oz * 0.07, leafYaw, 1, 1, 1, Math.PI / 2),
        { mat: 'metal', surface: 'metal', cast: false });
    }
  }

  /** Balcony: cantilevered slab, corbels, and a welded steel railing. */
  _balcony(b, x, z, yaw, width, y, depth = 1.15) {
    const ox = Math.sin(yaw), oz = Math.cos(yaw);   // outward normal of the wall
    const tx = Math.cos(yaw), tz = -Math.sin(yaw);  // along the wall
    b.put(bevelBox(width, 0.16, depth, 0.025, { uvOffset: [0, y, 0] }),
      trs(x + ox * depth * 0.5, y + 0.08, z + oz * depth * 0.5, yaw),
      { mat: 'concrete', surface: 'concrete' });
    // corbels
    for (const s of [-1, 0, 1]) {
      b.put(bevelBox(0.14, 0.26, depth * 0.8, 0.02),
        trs(x + tx * s * (width * 0.5 - 0.2) + ox * depth * 0.42,
          y - 0.10,
          z + tz * s * (width * 0.5 - 0.2) + oz * depth * 0.42, yaw),
        { mat: 'concrete', surface: 'concrete' });
    }
    this._railing(b, x + ox * (depth - 0.06), z + oz * (depth - 0.06), yaw, width, y + 0.16, 1.02, true);
    for (const s of [-1, 1]) {
      this._railing(b,
        x + tx * s * (width * 0.5 - 0.03) + ox * depth * 0.5,
        z + tz * s * (width * 0.5 - 0.03) + oz * depth * 0.5,
        yaw + s * Math.PI / 2, depth - 0.1, y + 0.16, 1.02, false);
    }
  }

  /** Steel railing: posts, top and mid rail, vertical bars, occasional bow. */
  _railing(b, x, z, yaw, width, y, height, ornate) {
    const rail = { mat: 'metal_rusted', surface: 'metal', tiling: 1 };
    const posts = Math.max(2, Math.round(width / 1.1));
    for (let i = 0; i <= posts; i++) {
      const px = x + (i / posts - 0.5) * width * Math.cos(yaw);
      const pz = z - (i / posts - 0.5) * width * Math.sin(yaw);
      b.put(bevelBox(0.05, height, 0.05, 0.008), trs(px, y + height * 0.5, pz, yaw), rail);
    }
    b.put(bevelBox(width, 0.055, 0.055, 0.01, { uvOffset: [0, y + height, 0] }),
      trs(x, y + height, z, yaw), rail);
    b.put(bevelBox(width, 0.035, 0.035, 0.008), trs(x, y + height * 0.45, z, yaw), rail);
    const bars = Math.max(3, Math.round(width / 0.16));
    for (let i = 1; i < bars; i++) {
      const f = i / bars - 0.5;
      const px = x + f * width * Math.cos(yaw);
      const pz = z - f * width * Math.sin(yaw);
      b.put(bevelBox(0.024, height - 0.05, 0.024, 0),
        trs(px, y + height * 0.5, pz, yaw), { ...rail, cast: false });
    }
    if (ornate) {
      // a scroll motif: two arcs per bay, built from thin torus quarters
      const bays = Math.max(1, Math.round(width / 1.1));
      for (let i = 0; i < bays; i++) {
        const f = (i + 0.5) / bays - 0.5;
        const px = x + f * width * Math.cos(yaw);
        const pz = z - f * width * Math.sin(yaw);
        b.put(torusGeo(0.17, 0.016, 5, 12),
          trs(px, y + height * 0.62, pz, yaw, 1, 1, 1, Math.PI / 2),
          { ...rail, cast: false });
      }
    }
  }

  /** Floor slab with a soffit band, leaving a stairwell void if asked. */
  _slab(b, y, opts) {
    opts = opts || {};
    const { hw, hd } = b;
    const void_ = opts.stairVoid;
    const inset = WALL_T * 0.5;
    const w = (hw - inset) * 2, d = (hd - inset) * 2;
    const def = { mat: 'concrete', surface: 'concrete' };
    if (!void_) {
      b.put(bevelBox(w, SLAB_T, d, 0.02, { uvOffset: [0, y, 0] }), trs(0, y - SLAB_T * 0.5, 0), def);
    } else {
      // four bands around the void
      const vx0 = void_.x0, vx1 = void_.x1, vz0 = void_.z0, vz1 = void_.z1;
      const x0 = -w * 0.5, x1 = w * 0.5, z0 = -d * 0.5, z1 = d * 0.5;
      const band = (a, c, e, g) => {
        if (c - a < 0.05 || g - e < 0.05) return;
        b.put(bevelBox(c - a, SLAB_T, g - e, 0.02, { uvOffset: [(a + c) * 0.5, y, (e + g) * 0.5] }),
          trs((a + c) * 0.5, y - SLAB_T * 0.5, (e + g) * 0.5), def);
      };
      band(x0, x1, z0, vz0);
      band(x0, x1, vz1, z1);
      band(x0, vx0, vz0, vz1);
      band(vx1, x1, vz0, vz1);
    }
    // soffit / string course visible from outside
    b.put(bevelBox(b.spec.w + 0.22, 0.16, b.spec.d + 0.22, 0.03, { uvOffset: [0, y, 0] }),
      trs(0, y - SLAB_T - 0.08, 0),
      { mat: b.spec.accent || 'concrete', surface: 'concrete', collide: false });
  }

  /** Straight flight of stairs with individual treads, stringer and handrail. */
  _stairs(b, x, z, yaw, rise, opts = {}) {
    const width = opts.width ?? 1.15;
    const steps = Math.max(6, Math.round(rise / 0.185));
    const stepH = rise / steps;
    const stepD = opts.tread ?? 0.29;
    const y0 = opts.y0 ?? 0;
    const def = { mat: 'concrete', surface: 'concrete' };
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    for (let i = 0; i < steps; i++) {
      const d = (i + 0.5) * stepD;
      const px = x + sn * d, pz = z + cs * d;
      const y = y0 + (i + 0.5) * stepH;
      b.put(bevelBox(width, stepH, stepD, 0.016, { uvOffset: [0, y, d] }),
        trs(px, y, pz, yaw), def);
      // nosing
      b.put(bevelBox(width, 0.035, 0.05, 0.008),
        trs(px - sn * (stepD * 0.5), y + stepH * 0.5, pz - cs * (stepD * 0.5), yaw),
        { ...def, cast: false });
    }
    const runLen = steps * stepD;
    // stringer
    for (const s of [-1, 1]) {
      b.put(bevelBox(0.1, 0.24, Math.hypot(runLen, rise), 0.02),
        trs(x + cs * s * (width * 0.5 + 0.05) + sn * runLen * 0.5,
          y0 + rise * 0.5 - 0.16,
          z - sn * s * (width * 0.5 + 0.05) + cs * runLen * 0.5,
          yaw, 1, 1, 1, -Math.atan2(rise, runLen)),
        def);
    }
    if (opts.rail !== false) {
      const n = 5;
      for (let i = 0; i <= n; i++) {
        const d = (i / n) * runLen;
        b.put(bevelBox(0.04, 0.95, 0.04, 0.008),
          trs(x + sn * d + cs * (width * 0.5 - 0.05), y0 + (i / n) * rise + 0.47, z + cs * d - sn * (width * 0.5 - 0.05), yaw),
          { mat: 'metal_rusted', surface: 'metal', cast: false });
      }
      b.put(bevelBox(0.05, 0.05, Math.hypot(runLen, rise), 0.01),
        trs(x + sn * runLen * 0.5 + cs * (width * 0.5 - 0.05),
          y0 + rise * 0.5 + 0.95,
          z + cs * runLen * 0.5 - sn * (width * 0.5 - 0.05),
          yaw, 1, 1, 1, -Math.atan2(rise, runLen)),
        { mat: 'metal_rusted', surface: 'metal', cast: false });
    }
    return runLen;
  }

  /** Parapet with coping, weep holes and, on older blocks, exposed rebar. */
  _parapet(b, y, height, opts = {}) {
    const { spec, hw, hd, rng } = b;
    const t = 0.22;
    const def = { mat: spec.wall, surface: 'concrete' };
    const sides = [
      [-hw, -hd, hw, -hd], [hw, -hd, hw, hd], [hw, hd, -hw, hd], [-hw, hd, -hw, -hd],
    ];
    for (const [x0, z0, x1, z1] of sides) {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const yaw = Math.atan2(-(z1 - z0) / len, (x1 - x0) / len);
      const mx = (x0 + x1) * 0.5, mz = (z0 + z1) * 0.5;
      b.put(bevelBox(len, height, t, 0.03, { uvOffset: [0, y + height * 0.5, 0] }),
        trs(mx, y + height * 0.5, mz, yaw), def);
      // coping stone oversails by 40 mm each side
      b.put(bevelBox(len + 0.08, 0.10, t + 0.14, 0.022, { uvOffset: [0, y + height, 0] }),
        trs(mx, y + height + 0.05, mz, yaw),
        { mat: spec.accent || 'concrete', surface: 'concrete' });
      // scuppers
      const holes = Math.max(1, Math.floor(len / 4));
      for (let i = 0; i < holes; i++) {
        const f = (i + 0.5) / holes - 0.5;
        b.put(cylinderGeo(0.05, 0.05, t + 0.3, 7),
          trs(mx + f * len * Math.cos(yaw), y + 0.12, mz - f * len * Math.sin(yaw), yaw, 1, 1, 1, Math.PI / 2, 0),
          { mat: 'metal_rusted', surface: 'metal', cast: false, collide: false });
      }
    }
    if (opts.rebar !== false) {
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        if (!rng.chance(0.7)) continue;
        const n = rng.int(2, 4);
        for (let i = 0; i < n; i++) {
          const h = rng.range(0.35, 0.95);
          b.put(cylinderGeo(0.012, 0.014, h, 5),
            trs(sx * (hw - 0.12) + rng.range(-0.16, 0.16),
              y + height + h * 0.5,
              sz * (hd - 0.12) + rng.range(-0.16, 0.16),
              0, 1, 1, 1, rng.range(-0.12, 0.12), rng.range(-0.12, 0.12)),
            { mat: 'metal_rusted', surface: 'metal', cast: true, collide: false });
        }
      }
    }
  }

  /** Roof clutter: tanks, AC units, dishes, laundry, aerials, a chair. */
  _roofClutter(b, y) {
    const { hw, hd, rng, spec } = b;
    const metal = { mat: 'metal_painted', surface: 'metal', tiling: 1 };

    // water tank on a stand
    if (rng.chance(0.85)) {
      const tx = rng.range(-hw + 1.2, hw - 1.2), tz = rng.range(-hd + 1.2, hd - 1.2);
      const r = rng.range(0.5, 0.72), th = rng.range(0.9, 1.35);
      for (let i = 0; i < 4; i++) {
        const a = i * Math.PI / 2 + 0.78;
        b.put(bevelBox(0.07, 0.55, 0.07, 0.01),
          trs(tx + Math.cos(a) * r * 0.75, y + 0.27, tz + Math.sin(a) * r * 0.75), metal);
      }
      b.put(cylinderGeo(r, r, th, 14), trs(tx, y + 0.55 + th * 0.5, tz),
        { mat: 'polymer', surface: 'metal', tiling: 1 });
      b.put(torusGeo(r + 0.01, 0.03, 5, 16), trs(tx, y + 0.55 + th * 0.82, tz),
        { ...metal, cast: false });
      b.put(cylinderGeo(0.14, 0.16, 0.12, 10), trs(tx, y + 0.55 + th + 0.05, tz), metal);
      // downpipe
      b.put(cylinderGeo(0.035, 0.035, 0.85, 7), trs(tx + r, y + 0.4, tz), { ...metal, cast: false });
    }

    // air-conditioning condensers
    const acs = rng.int(1, 3);
    for (let i = 0; i < acs; i++) {
      const ax = rng.range(-hw + 0.8, hw - 0.8), az = rng.range(-hd + 0.8, hd - 0.8);
      const ay = y + 0.22;
      b.put(bevelBox(0.86, 0.62, 0.42, 0.02), trs(ax, ay + 0.31, az, rng.range(0, 6.28)), metal);
      b.put(torusGeo(0.24, 0.02, 5, 14), trs(ax, ay + 0.62, az), { ...metal, cast: false });
      for (let f = 0; f < 3; f++) {
        b.put(bevelBox(0.42, 0.012, 0.06, 0.003),
          trs(ax, ay + 0.635, az, f * 1.05), { ...metal, cast: false, collide: false });
      }
      b.put(bevelBox(0.9, 0.09, 0.46, 0.015), trs(ax, ay + 0.02, az), { ...metal, cast: false });
    }

    // satellite dishes
    const dishes = rng.int(1, 3);
    for (let i = 0; i < dishes; i++) {
      const dx = rng.range(-hw + 0.7, hw - 0.7), dz = rng.range(-hd + 0.7, hd - 0.7);
      const tilt = rng.range(0.5, 0.95), spin = rng.range(0, 6.28);
      b.put(cylinderGeo(0.04, 0.05, 0.75, 8), trs(dx, y + 0.37, dz), metal);
      const dishR = rng.range(0.32, 0.48);
      const profile = [];
      for (let s = 0; s <= 8; s++) {
        const t = s / 8;
        profile.push([t * dishR, t * t * dishR * 0.42]);
      }
      profile.push([dishR, dishR * 0.42 + 0.02]);
      b.put(latheGeo(profile, 16),
        trs(dx, y + 0.78, dz, spin, 1, 1, 1, tilt),
        { mat: 'metal_painted', surface: 'metal', tiling: 1 });
      b.put(cylinderGeo(0.018, 0.018, dishR * 0.9, 6),
        trs(dx + Math.sin(spin) * dishR * 0.3, y + 0.78 + dishR * 0.42, dz + Math.cos(spin) * dishR * 0.3,
          spin, 1, 1, 1, tilt + Math.PI),
        { ...metal, cast: false, collide: false });
    }

    // TV aerial
    if (rng.chance(0.6)) {
      const ax = rng.range(-hw + 0.6, hw - 0.6), az = rng.range(-hd + 0.6, hd - 0.6);
      const mh = rng.range(1.4, 2.4);
      b.put(cylinderGeo(0.022, 0.028, mh, 6), trs(ax, y + mh * 0.5, az), { ...metal, collide: false });
      const arms = rng.int(4, 7);
      for (let i = 0; i < arms; i++) {
        const ay = y + mh * (0.45 + 0.5 * i / arms);
        b.put(cylinderGeo(0.008, 0.008, 0.5 - i * 0.04, 4),
          trs(ax, ay, az, 0.4, 1, 1, 1, 0, Math.PI / 2),
          { ...metal, cast: false, collide: false });
      }
    }

    // laundry line across the roof
    if (rng.chance(0.7)) {
      const y0 = y + 1.5;
      const a = new THREE.Vector3(-hw + 0.5, y0, rng.range(-hd + 1, hd - 1));
      const c = new THREE.Vector3(hw - 0.5, y0 + rng.range(-0.2, 0.2), rng.range(-hd + 1, hd - 1));
      for (const p of [a, c]) {
        b.put(cylinderGeo(0.035, 0.045, 1.6, 6), trs(p.x, y + 0.8, p.z), { ...metal, collide: false });
      }
      const pts = catenaryPoints(a, c, 0.35, 10);
      b.put(tubeGeo(pts, 0.011, 4), trs(0, 0, 0),
        { mat: 'metal', surface: 'metal', cast: false, collide: false });
      const items = b.rng.int(3, 6);
      for (let i = 0; i < items; i++) {
        const t = (i + 0.6) / (items + 0.4);
        const idx = Math.min(pts.length - 1, Math.round(t * (pts.length - 1)));
        const p = pts[idx];
        const w = b.rng.range(0.45, 0.85), hgt = b.rng.range(0.55, 1.05);
        b.put(clothGeo(w, hgt, { sag: 0.05, segX: 4, segZ: 5, wrinkle: 0.02 }),
          trs(p.x, p.y - hgt * 0.5, p.z, b.rng.range(-0.2, 0.2), 1, 1, 1, Math.PI / 2),
          { mat: 'fabric', surface: 'fabric', cast: true, collide: false, tiling: 1 });
      }
    }
  }

  /* ================================================================ */
  /* styles                                                            */
  /* ================================================================ */

  _townhouse(b) {
    const { spec, hw, hd, rng } = b;
    const floors = b.floors, fh = b.fh;
    const g = b.groundY;
    const wallDef = { mat: spec.wall, surface: 'concrete', accent: spec.accent };

    const sides = [
      { key: 'north', x0: hw, z0: -hd, x1: -hw, z1: -hd, yaw: Math.PI, out: new THREE.Vector2(0, -1) },
      { key: 'south', x0: -hw, z0: hd, x1: hw, z1: hd, yaw: 0, out: new THREE.Vector2(0, 1) },
      { key: 'east', x0: hw, z0: hd, x1: hw, z1: -hd, yaw: Math.PI / 2, out: new THREE.Vector2(1, 0) },
      { key: 'west', x0: -hw, z0: -hd, x1: -hw, z1: hd, yaw: -Math.PI / 2, out: new THREE.Vector2(-1, 0) },
    ];

    const doorSide = spec.doorSide || 'east';
    for (let f = 0; f < floors; f++) {
      const y0 = g + f * fh;
      const y1 = y0 + fh;
      for (const side of sides) {
        const len = Math.hypot(side.x1 - side.x0, side.z1 - side.z0);
        const openings = [];
        const bays = Math.max(1, Math.round(len / 3.3));
        const winW = clamp(len / bays * 0.42, 0.85, 1.5);
        for (let i = 0; i < bays; i++) {
          const at = (i + 0.5) * (len / bays);
          if (f === 0 && side.key === doorSide && i === Math.floor(bays / 2)) {
            openings.push({ at, width: 1.25, sill: y0, head: y0 + 2.32, door: true });
            continue;
          }
          if (f === 0 && rng.chance(0.18)) continue;   // blind bay
          openings.push({
            at, width: winW, sill: y0 + (f === 0 ? 1.05 : 0.92),
            head: y0 + fh - 0.85,
          });
        }
        this._wallRun(b, side.x0, side.z0, side.x1, side.z1, y0, y1, WALL_T, openings, wallDef);

        // fill the openings
        const ux = (side.x1 - side.x0) / len, uz = (side.z1 - side.z0) / len;
        for (const o of openings) {
          const px = side.x0 + ux * o.at + side.out.x * 0.01;
          const pz = side.z0 + uz * o.at + side.out.y * 0.01;
          if (o.door) {
            this._door(b, px, pz, side.yaw, o.width, o.head - o.sill, { open: rng.range(0, 1.2) });
          } else {
            this._window(b, px, pz, side.yaw, o.sill, o.head, o.width,
              { shutters: rng.chance(0.85), inward: -0.12 });
            // awning over ground-floor street windows
            if (f === 0 && rng.chance(0.35)) {
              const wf = this._frame(side.yaw);
              b.put(awningGeo(o.width + 0.7, 0.95, 0.42, { scallops: 5 }),
                trs(px + wf.ox * 0.06, o.head + 0.38, pz + wf.oz * 0.06, side.yaw),
                { mat: 'fabric', surface: 'fabric', tiling: 1, collide: false });
              for (const s of [-1, 1]) {
                const ax = px + wf.tx * s * (o.width * 0.5 + 0.28) + wf.ox * 0.42;
                const az = pz + wf.tz * s * (o.width * 0.5 + 0.28) + wf.oz * 0.42;
                b.put(cylinderGeo(0.016, 0.016, 1.05, 5),
                  trs(ax, o.head + 0.02, az, side.yaw, 1, 1, 1, 0.62),
                  { mat: 'metal_rusted', surface: 'metal', cast: false, collide: false });
              }
            }
          }
        }
      }

      if (f > 0) this._slab(b, y0, f === 1 && spec.enterable ? {
        stairVoid: { x0: hw - 2.6, x1: hw - 0.6, z0: -hd + 0.6, z1: -hd + 2.9 },
      } : null);
    }

    // ground floor slab, top flush with the plinth
    b.put(bevelBox(spec.w - WALL_T, 0.12, spec.d - WALL_T, 0.02, { uvOffset: [0, g, 0] }),
      trs(0, g - 0.06, 0),
      { mat: 'tile', surface: 'concrete', cast: false });

    if (spec.enterable) {
      // one partition per floor so the interior is not a shoebox
      for (let f = 0; f < floors; f++) {
        const y0 = g + f * fh;
        const px = rng.range(-hw * 0.35, hw * 0.35);
        const gapAt = rng.range(-hd * 0.4, hd * 0.4);
        this._wallRun(b, px, -hd + WALL_T, px, hd - WALL_T, y0, y0 + fh - 0.2, PART_T,
          [{ at: hd - WALL_T + gapAt, width: 1.15, sill: y0, head: y0 + 2.2 }],
          { mat: 'plaster', surface: 'concrete' });
      }
      // stairs in the north-east corner, aligned with the slab void
      for (let f = 0; f < floors - 1; f++) {
        this._stairs(b, hw - 1.6, -hd + 0.8, 0, fh, { y0: g + f * fh, width: 1.2 });
      }
      // interior practicals
      for (let f = 0; f < floors; f++) {
        const lx = rng.range(-hw * 0.4, hw * 0.4);
        const lz = rng.range(-hd * 0.4, hd * 0.4);
        const ceil = g + f * fh + fh - 0.28;
        b.lights.addHint({
          position: b.world(trs(lx, ceil - 0.42, lz)),
          color: 0xffb46a, intensity: 5.5, distance: 9.5,
        });
        // bare bulb on a flex
        b.put(cylinderGeo(0.004, 0.004, 0.34, 4), trs(lx, ceil - 0.17, lz),
          { mat: 'metal', surface: 'metal', cast: false, collide: false });
        b.put(latheGeo([[0, 0.10], [0.055, 0.03], [0.05, 0.0], [0, -0.02]], 8),
          trs(lx, ceil - 0.40, lz), { mat: 'lampGlow', surface: 'glass', cast: false, collide: false });
      }
    }

    const roofY = g + floors * fh;
    this._slab(b, roofY, spec.roofAccess && spec.enterable ? {
      stairVoid: { x0: hw - 2.6, x1: hw - 0.6, z0: -hd + 0.6, z1: -hd + 2.9 },
    } : null);
    this._parapet(b, roofY, spec.parapet ?? 0.9, { rebar: true });
    this._roofClutter(b, roofY);
    for (const side of sides) this._facade(b, side, g, floors * fh);

    for (const bal of spec.balconies || []) {
      const side = sides.find((s) => s.key === bal.side);
      if (!side) continue;
      const y = g + bal.floor * fh;
      const cx = (side.x0 + side.x1) * 0.5 + (side.x1 - side.x0) / Math.hypot(side.x1 - side.x0, side.z1 - side.z0) * bal.offset;
      const cz = (side.z0 + side.z1) * 0.5 + (side.z1 - side.z0) / Math.hypot(side.x1 - side.x0, side.z1 - side.z0) * bal.offset;
      this._balcony(b, cx + side.out.x * 0.02, cz + side.out.y * 0.02, side.yaw, bal.width, y);
    }

    if (spec.heroWall) this._heroWall(b, sides.find((s) => s.key === spec.heroWall));
  }

  /**
   * Services on every facade: rainwater goods, surface conduit, a meter box,
   * split-unit condensers and their drip stains, wall vents.
   *
   * This exists because of one specific failure mode. Between window bays a
   * procedural building has three or four metres of blank render, and if you
   * stand two metres from it — which is exactly where a shooter puts you — that
   * blank is 40% of the screen. Real walls are never blank: they are covered in
   * the ugly, cheap, bolted-on things that keep a building working.
   */
  _facade(b, side, g, height) {
    const rng = b.rng;
    const len = Math.hypot(side.x1 - side.x0, side.z1 - side.z0);
    const ux = (side.x1 - side.x0) / len, uz = (side.z1 - side.z0) / len;
    const ox = side.out.x, oz = side.out.y;
    const at = (along, out) => [side.x0 + ux * along + ox * out, side.z0 + uz * along + oz * out];
    const steel = { mat: 'metal_rusted', surface: 'metal', cast: false, collide: false };
    const painted = { mat: 'metal_painted', surface: 'metal', cast: false, collide: false, tiling: 1 };

    // rainwater downpipe with brackets and a shoe at the bottom
    for (const along of [0.55, len - 0.55]) {
      if (rng.chance(0.45)) continue;
      const p = at(along, 0.11);
      b.put(cylinderGeo(0.052, 0.052, height + 0.4, 9),
        trs(p[0], g + (height + 0.4) * 0.5, p[1]), steel);
      const brackets = Math.max(2, Math.round(height / 1.6));
      for (let i = 0; i < brackets; i++) {
        const q = at(along, 0.055);
        b.put(bevelBox(0.13, 0.045, 0.13, 0.012),
          trs(q[0], g + 0.6 + i * (height / brackets), q[1], side.yaw), steel);
      }
      const s = at(along, 0.20);
      b.put(cylinderGeo(0.055, 0.075, 0.34, 9),
        trs(s[0], g + 0.22, s[1], side.yaw, 1, 1, 1, 0.45), steel);
      // a hopper head where the parapet drains into it
      const hp = at(along, 0.14);
      b.put(latheGeo([[0, 0], [0.13, 0.03], [0.15, 0.26], [0.09, 0.32]], 10),
        trs(hp[0], g + height - 0.2, hp[1]), steel);
    }

    // surface conduit: a vertical drop feeding a horizontal run with junctions
    if (rng.chance(0.75)) {
      const along = rng.range(1.2, Math.max(1.4, len - 1.2));
      const drop = at(along, 0.045);
      const top = g + height - rng.range(0.4, 1.2);
      b.put(cylinderGeo(0.022, 0.022, top - g - 0.9, 6),
        trs(drop[0], g + 0.9 + (top - g - 0.9) * 0.5, drop[1]), painted);
      const boxAt = at(along, 0.075);
      b.put(bevelBox(0.20, 0.28, 0.11, 0.015), trs(boxAt[0], g + 1.55, boxAt[1], side.yaw),
        { ...painted, cast: true });
      b.put(bevelBox(0.13, 0.09, 0.03, 0.006), trs(boxAt[0], g + 1.42, boxAt[1], side.yaw), steel);
      // horizontal run to the next bay
      const run = rng.range(1.0, 3.0) * (rng.chance(0.5) ? 1 : -1);
      const mid = at(along + run * 0.5, 0.045);
      b.put(cylinderGeo(0.02, 0.02, Math.abs(run), 6),
        trs(mid[0], top, mid[1], side.yaw, 1, 1, 1, 0, Math.PI / 2), painted);
      for (let i = 0; i < 3; i++) {
        const c = at(along + run * (i / 2), 0.035);
        b.put(bevelBox(0.06, 0.05, 0.06, 0.01), trs(c[0], top, c[1], side.yaw), painted);
      }
    }

    // wall-mounted split unit on an upper floor, with its bracket and stain
    if (rng.chance(0.55) && height > 5) {
      const along = rng.range(1.5, Math.max(1.7, len - 1.5));
      const y = g + rng.range(3.4, height - 1.4);
      const p = at(along, 0.30);
      b.put(bevelBox(0.82, 0.56, 0.36, 0.025), trs(p[0], y, p[1], side.yaw),
        { mat: 'metal_painted', surface: 'metal', tiling: 1 });
      b.put(torusGeo(0.20, 0.018, 5, 12), trs(p[0], y, p[1], side.yaw, 1, 1, 1, Math.PI / 2),
        { ...painted });
      for (const s of [-1, 1]) {
        const q = at(along + s * 0.34, 0.16);
        b.put(bevelBox(0.05, 0.30, 0.30, 0.01), trs(q[0], y - 0.28, q[1], side.yaw), steel);
      }
      // condensate stain running down the render below it
      const st = at(along, 0.012);
      b.put(bevelBox(0.16, y - g - 0.4, 0.012, 0.004), trs(st[0], g + (y - g) * 0.5 - 0.2, st[1], side.yaw),
        { mat: 'concrete_cracked', surface: 'concrete', cast: false, collide: false, tiling: 2 });
    }

    // wall vents / weep grilles
    for (let i = 0, n = rng.int(1, 3); i < n; i++) {
      const p = at(rng.range(0.8, Math.max(1.0, len - 0.8)), 0.045);
      const y = g + rng.range(0.5, Math.min(2.6, height - 0.5));
      b.put(bevelBox(0.24, 0.18, 0.05, 0.012), trs(p[0], y, p[1], side.yaw), steel);
      for (let k = 0; k < 3; k++) {
        b.put(bevelBox(0.20, 0.022, 0.02, 0), trs(p[0], y - 0.05 + k * 0.05, p[1], side.yaw), steel);
      }
    }
  }

  /**
   * Extra dressing on one nominated facade: a peeling render patch that exposes
   * the brick underneath, conduit, a stencilled number plate and a drainpipe.
   * The material close-up shot is framed on this wall.
   */
  _heroWall(b, side) {
    if (!side) return;
    const rng = b.rng;
    const len = Math.hypot(side.x1 - side.x0, side.z1 - side.z0);
    const ux = (side.x1 - side.x0) / len, uz = (side.z1 - side.z0) / len;
    const at = (x) => ({ x: side.x0 + ux * x + side.out.x * 0.03, z: side.z0 + uz * x + side.out.y * 0.03 });

    // Exposed brick where the render has fallen away. One patch is placed
    // deterministically at the centre bay because the material close-up in the
    // shot list is framed on exactly that spot; the rest are scattered.
    const patches = [[len * 0.30, 1.05, 2.6, 1.5], [len * 0.30, 2.25, 1.1, 0.7]];
    for (let i = 0; i < 4; i++) {
      patches.push([rng.range(1.5, len - 1.5), rng.range(0.9, 3.6),
        rng.range(0.9, 2.4), rng.range(0.7, 2.0)]);
    }
    for (const [along, y, w, h] of patches) {
      const p = at(along);
      b.put(bevelBox(w, h, 0.055, 0.035, { uvOffset: [p.x, y, p.z] }),
        trs(p.x, y, p.z, side.yaw),
        { mat: 'brick', surface: 'concrete', cast: false, collide: false, tiling: 1 });
      // ragged render lip around the patch, so the transition has thickness
      for (const [dx, dy, sw, sh] of [[0, h * 0.5 + 0.03, w, 0.06], [0, -h * 0.5 - 0.03, w, 0.06],
        [w * 0.5 + 0.03, 0, 0.06, h], [-w * 0.5 - 0.03, 0, 0.06, h]]) {
        const q = at(along + dx);
        b.put(bevelBox(sw, sh, 0.075, 0.02), trs(q.x, y + dy, q.z, side.yaw),
          { mat: b.spec.wall, surface: 'concrete', cast: false, collide: false });
      }
    }
    // bullet pocks: shallow craters punched into the render around head height
    for (let i = 0; i < 22; i++) {
      const p = at(rng.range(1.0, len - 1.0));
      const s = rng.range(0.05, 0.13);
      b.put(sphereGeo(s, 7, 5), trs(p.x, rng.range(0.8, 3.0), p.z, 0, 1, 1, 0.35),
        { mat: 'concrete_cracked', surface: 'concrete', cast: false, collide: false, tiling: 1 });
    }
    // water staining below the sills, as thin proud strips
    for (let i = 0; i < 5; i++) {
      const p = at(rng.range(1.0, len - 1.0));
      b.put(bevelBox(rng.range(0.10, 0.26), rng.range(0.8, 2.2), 0.012, 0.004),
        trs(p.x, rng.range(1.2, 2.6), p.z, side.yaw),
        { mat: 'concrete_cracked', surface: 'concrete', cast: false, collide: false, tiling: 2 });
    }
    // conduit run
    const c0 = at(len * 0.34), c1 = at(len * 0.34);
    b.put(cylinderGeo(0.028, 0.028, 4.4, 7), trs(c0.x, 2.4, c0.z),
      { mat: 'metal_rusted', surface: 'metal', collide: false });
    for (let i = 0; i < 5; i++) {
      b.put(bevelBox(0.09, 0.05, 0.09, 0.01), trs(c1.x, 0.6 + i * 0.95, c1.z, side.yaw),
        { mat: 'metal', surface: 'metal', cast: false, collide: false });
    }
    // drainpipe with hopper
    const d = at(len - 0.8);
    b.put(cylinderGeo(0.055, 0.055, 6.6, 9), trs(d.x, 3.3, d.z),
      { mat: 'metal_rusted', surface: 'metal', collide: false });
    b.put(latheGeo([[0.0, 0], [0.12, 0.02], [0.14, 0.24], [0.08, 0.3]], 10),
      trs(d.x, 6.5, d.z), { mat: 'metal_rusted', surface: 'metal', collide: false });
    // number plaque
    const p = at(len * 0.5);
    b.put(bevelBox(0.34, 0.24, 0.03, 0.008), trs(p.x, 2.35, p.z, side.yaw),
      { mat: 'metal_painted', surface: 'metal', cast: false, collide: false, tiling: 4 });
  }

  /**
   * The souk hall: an arcaded market volume you can walk straight through, with
   * a first-floor loggia. The morning sun rakes in through the east arcade and
   * out of the west one, which is exactly what the god-ray shot is framed on.
   */
  _hall(b) {
    const { spec, hw, hd, rng } = b;
    const g = b.groundY;
    const fh = b.fh;
    const wallDef = { mat: spec.wall, surface: 'concrete', accent: spec.accent };

    const arcadeSides = [];
    if (spec.arcade?.west) arcadeSides.push('west');
    if (spec.arcade?.east) arcadeSides.push('east');

    // --- ground floor: arcades on the long faces, solid on the ends -------
    const bays = 5;
    for (const key of ['west', 'east']) {
      const x = key === 'west' ? -hw : hw;
      const yaw = key === 'west' ? -Math.PI / 2 : Math.PI / 2;
      if (arcadeSides.includes(key)) {
        const step = (hd * 2) / bays;
        for (let i = 0; i <= bays; i++) {
          const z = -hd + i * step;
          // pier
          b.put(bevelBox(0.62, fh - 0.1, 0.62, 0.04, { uvOffset: [0, g + fh * 0.5, 0] }),
            trs(x, g + (fh - 0.1) * 0.5, z), wallDef);
          b.put(bevelBox(0.78, 0.16, 0.78, 0.03), trs(x, g + fh - 0.12, z),
            { mat: spec.accent, surface: 'concrete' });
          b.put(bevelBox(0.74, 0.14, 0.74, 0.03), trs(x, g + 0.07, z),
            { mat: spec.accent, surface: 'concrete' });
          if (i < bays) this._arch(b, x, z + step * 0.5, yaw, step - 0.62, g + fh - 0.1, 0.5);
        }
      } else {
        this._wallRun(b, x, -hd, x, hd, g, g + fh, WALL_T, [], wallDef);
      }
    }
    for (const [x0, z0, x1, z1] of [[hw, -hd, -hw, -hd], [-hw, hd, hw, hd]]) {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const openings = [{ at: len * 0.5, width: 2.4, sill: g, head: g + 2.7 }];
      this._wallRun(b, x0, z0, x1, z1, g, g + fh, WALL_T, openings, wallDef);
    }

    // internal columns holding the first floor up
    for (let i = 1; i < bays; i++) {
      const z = -hd + (hd * 2 / bays) * i;
      b.put(bevelBox(0.5, fh - 0.1, 0.5, 0.035), trs(0, g + (fh - 0.1) * 0.5, z), wallDef);
      b.put(bevelBox(0.66, 0.18, 0.66, 0.03), trs(0, g + fh - 0.13, z),
        { mat: spec.accent, surface: 'concrete' });
    }
    // beams
    b.put(bevelBox(0.42, 0.34, hd * 2, 0.03), trs(0, g + fh - 0.36, 0),
      { mat: 'concrete', surface: 'concrete' });

    // floor
    b.put(bevelBox(spec.w - 0.3, 0.12, spec.d - 0.3, 0.02, { uvOffset: [0, g, 0] }),
      trs(0, g - 0.06, 0), { mat: 'tile', surface: 'concrete', cast: false });

    // --- first floor ------------------------------------------------------
    const y1 = g + fh;
    this._slab(b, y1, { stairVoid: { x0: -hw + 0.6, x1: -hw + 2.8, z0: hd - 3.0, z1: hd - 0.7 } });

    const loggia = spec.loggia?.west;
    for (const key of ['west', 'east']) {
      const x = key === 'west' ? -hw : hw;
      const yaw = key === 'west' ? -Math.PI / 2 : Math.PI / 2;
      if (loggia && key === 'west') {
        // open colonnade: this is what the light shafts pour through
        const step = (hd * 2) / bays;
        for (let i = 0; i <= bays; i++) {
          const z = -hd + i * step;
          b.put(cylinderGeo(0.16, 0.19, fh - 0.55, 12), trs(x, y1 + (fh - 0.55) * 0.5, z),
            { mat: spec.accent, surface: 'concrete', tiling: 1 });
          b.put(bevelBox(0.44, 0.16, 0.44, 0.025), trs(x, y1 + fh - 0.5, z),
            { mat: spec.accent, surface: 'concrete' });
          b.put(bevelBox(0.4, 0.1, 0.4, 0.02), trs(x, y1 + 0.05, z),
            { mat: spec.accent, surface: 'concrete' });
        }
        b.put(bevelBox(0.34, 0.3, hd * 2, 0.03), trs(x, y1 + fh - 0.28, 0),
          { mat: spec.wall, surface: 'concrete' });
        this._railing(b, x, -0.02, Math.PI / 2, hd * 2 - 0.4, y1 + 0.02, 0.95, true);
      } else {
        const len = hd * 2;
        const openings = [];
        for (let i = 0; i < 4; i++) {
          openings.push({ at: (i + 0.5) * len / 4, width: 1.25, sill: y1 + 0.95, head: y1 + fh - 0.9 });
        }
        this._wallRun(b, x, -hd, x, hd, y1, y1 + fh, WALL_T, openings, wallDef);
        for (const o of openings) {
          const z = -hd + o.at;
          this._window(b, x, z, yaw, o.sill, o.head, o.width, { shutters: rng.chance(0.5) });
          this._arch(b, x, z, yaw, o.width + 0.3, o.head + 0.05, 0.34, true);
        }
      }
    }
    for (const [x0, z0, x1, z1, yaw] of [[hw, -hd, -hw, -hd, Math.PI], [-hw, hd, hw, hd, 0]]) {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const openings = [
        { at: len * 0.3, width: 1.2, sill: y1 + 0.95, head: y1 + fh - 0.9 },
        { at: len * 0.7, width: 1.2, sill: y1 + 0.95, head: y1 + fh - 0.9 },
      ];
      this._wallRun(b, x0, z0, x1, z1, y1, y1 + fh, WALL_T, openings, wallDef);
      const ux = (x1 - x0) / len, uz = (z1 - z0) / len;
      for (const o of openings) {
        this._window(b, x0 + ux * o.at, z0 + uz * o.at, yaw, o.sill, o.head, o.width, { shutters: true });
      }
    }

    // stairs up from the hall, and a second flight to the roof
    this._stairs(b, -hw + 1.6, hd - 0.9, Math.PI, fh, { y0: g, width: 1.3 });
    const roofY = y1 + fh;
    this._slab(b, roofY, { stairVoid: { x0: -hw + 0.6, x1: -hw + 2.8, z0: hd - 3.0, z1: hd - 0.7 } });
    this._stairs(b, -hw + 1.6, hd - 0.9, Math.PI, fh, { y0: y1, width: 1.3 });
    this._parapet(b, roofY, spec.parapet ?? 1.0, { rebar: true });
    this._roofClutter(b, roofY);

    // hanging stall lamps under the arcade
    for (let i = 0; i < 3; i++) {
      const z = -hd + (i + 1) * (hd * 2 / 4);
      const p = b.world(trs(0, g + fh - 0.9, z));
      b.lights.addHint({ position: p, color: 0xffc07a, intensity: 7, distance: 11 });
      b.put(cylinderGeo(0.005, 0.005, 0.55, 4), trs(0, g + fh - 0.6, z),
        { mat: 'metal', surface: 'metal', cast: false, collide: false });
      b.put(latheGeo([[0, 0.22], [0.19, 0.02], [0.2, 0.0]], 10), trs(0, g + fh - 0.9, z),
        { mat: 'metal_painted', surface: 'metal', cast: false, collide: false });
      b.put(sphereGeo(0.055, 8, 6), trs(0, g + fh - 0.97, z),
        { mat: 'lampGlow', surface: 'glass', cast: false, collide: false });
    }
  }

  /** Semicircular arch built from voussoirs plus a keystone. */
  _arch(b, x, z, yaw, span, springY, depth, blind = false) {
    const r = span * 0.5;
    const n = 11;
    const def = { mat: b.spec.accent || 'concrete', surface: 'concrete' };
    const tx = Math.cos(yaw), tz = -Math.sin(yaw);   // along the wall
    for (let i = 0; i < n; i++) {
      const am = ((i + 0.5) / n) * Math.PI;
      const rr = r + 0.17;
      const along = Math.cos(am) * rr;
      const py = springY + Math.sin(am) * rr;
      const seg = (Math.PI / n) * rr * 1.18;
      b.put(bevelBox(seg, 0.34, depth, 0.022, { uvOffset: [along, py, 0] }),
        trs(x + tx * along, py, z + tz * along, yaw, 1, 1, 1, 0, am - Math.PI / 2),
        def);
    }
    // keystone
    b.put(bevelBox(0.26, 0.46, depth + 0.06, 0.02),
      trs(x, springY + r + 0.30, z, yaw), def);
    if (blind) {
      // tympanum fill so a decorative arch is not a hole
      b.put(bevelBox(span * 0.92, r * 0.9, depth * 0.6, 0.02),
        trs(x, springY + r * 0.45, z, yaw), { mat: b.spec.wall, surface: 'concrete' });
    }
  }

  _warehouse(b) {
    const { spec, hw, hd, rng } = b;
    const g = b.groundY;
    const h = b.fh;
    const wallDef = { mat: spec.wall, surface: 'concrete', accent: spec.accent };

    const sides = [
      [hw, -hd, -hw, -hd, Math.PI], [-hw, hd, hw, hd, 0],
      [hw, hd, hw, -hd, Math.PI / 2], [-hw, -hd, -hw, hd, -Math.PI / 2],
    ];
    for (const [x0, z0, x1, z1, yaw] of sides) {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const openings = [];
      const isDoorWall = Math.abs(z0 - z1) < 0.01 && z0 < 0;
      if (isDoorWall) {
        openings.push({ at: len * 0.5, width: Math.min(5.5, len * 0.5), sill: g, head: g + 4.2 });
      }
      // clerestory band
      const cls = Math.max(2, Math.round(len / 3.2));
      for (let i = 0; i < cls; i++) {
        openings.push({ at: (i + 0.5) * len / cls, width: 1.3, sill: g + h - 1.9, head: g + h - 0.7 });
      }
      this._wallRun(b, x0, z0, x1, z1, g, g + h, WALL_T, openings, wallDef);
      const ux = (x1 - x0) / len, uz = (z1 - z0) / len;
      for (const o of openings) {
        const px = x0 + ux * o.at, pz = z0 + uz * o.at;
        if (o.head - o.sill > 3) {
          // roller shutter, part raised
          const raise = rng.range(0.0, 0.55);
          const hh = (o.head - o.sill) * (1 - raise);
          b.put(bevelBox(o.width - 0.05, hh, 0.09, 0.012, { uvOffset: [0, o.sill + hh * 0.5, 0] }),
            trs(px, o.head - hh * 0.5, pz, yaw),
            { mat: 'metal_corrugated', surface: 'metal', tiling: 1 });
          for (let i = 0; i < Math.floor(hh * 8); i++) {
            b.put(bevelBox(o.width - 0.05, 0.02, 0.03, 0),
              trs(px, o.head - 0.06 - i * 0.125, pz, yaw),
              { mat: 'metal_corrugated', surface: 'metal', cast: false, collide: false });
          }
        } else {
          this._window(b, px, pz, yaw, o.sill, o.head, o.width, { shutters: false });
        }
      }
    }

    b.put(bevelBox(spec.w - 0.3, 0.14, spec.d - 0.3, 0.02, { uvOffset: [0, g, 0] }),
      trs(0, g - 0.07, 0), { mat: 'concrete', surface: 'concrete', cast: false });

    // shallow pitched corrugated roof on steel trusses
    const ridge = 1.5;
    const roofY = g + h;
    for (const s of [-1, 1]) {
      const slope = Math.atan2(ridge, hw);
      const len = Math.hypot(hw, ridge);
      b.put(bevelBox(len, 0.10, hd * 2 + 0.5, 0.02, { uvOffset: [0, roofY, 0] }),
        trs(s * hw * 0.5, roofY + ridge * 0.5, 0, 0, 1, 1, 1, 0, -s * slope),
        { mat: 'metal_corrugated', surface: 'metal', tiling: 1 });
    }
    b.put(bevelBox(0.5, 0.16, hd * 2 + 0.6, 0.02), trs(0, roofY + ridge + 0.02, 0),
      { mat: 'metal', surface: 'metal' });
    const trusses = Math.max(2, Math.round(hd * 2 / 3));
    for (let i = 0; i <= trusses; i++) {
      const z = -hd + (i / trusses) * hd * 2;
      b.put(bevelBox(hw * 2 - 0.4, 0.12, 0.12, 0.02), trs(0, roofY - 0.4, z),
        { mat: 'metal', surface: 'metal', collide: false });
      for (let k = -2; k <= 2; k++) {
        b.put(cylinderGeo(0.035, 0.035, 1.1, 5),
          trs(k * hw * 0.4, roofY - 0.1, z, 0, 1, 1, 1, 0, k * 0.35),
          { mat: 'metal', surface: 'metal', cast: false, collide: false });
      }
    }
    this._parapet(b, roofY, spec.parapet ?? 0.35, { rebar: false });
    if (spec.enterable) {
      const p = b.world(trs(0, roofY - 0.9, 0));
      b.lights.addHint({ position: p, color: 0xdfeaff, intensity: 9, distance: 16 });
    }
  }

  _tower(b) {
    const { spec, hw, rng } = b;
    const g = b.groundY;
    const floors = b.floors, fh = b.fh;
    const def = { mat: spec.wall, surface: 'concrete', accent: spec.accent };

    for (let f = 0; f < floors; f++) {
      const taper = 1 - f * 0.055;
      const s = hw * 2 * taper;
      const y0 = g + f * fh;
      const openings = [];
      if (f >= 1) openings.push({ at: s * 0.5, width: 0.62, sill: y0 + 1.4, head: y0 + fh - 0.75 });
      for (const [x0, z0, x1, z1, yaw] of [
        [s / 2, -s / 2, -s / 2, -s / 2, Math.PI], [-s / 2, s / 2, s / 2, s / 2, 0],
        [s / 2, s / 2, s / 2, -s / 2, Math.PI / 2], [-s / 2, -s / 2, -s / 2, s / 2, -Math.PI / 2],
      ]) {
        this._wallRun(b, x0, z0, x1, z1, y0, y0 + fh, WALL_T, openings, def);
        if (openings.length) {
          const len = s;
          const ux = (x1 - x0) / len, uz = (z1 - z0) / len;
          const o = openings[0];
          this._arch(b, x0 + ux * o.at, z0 + uz * o.at, yaw, o.width + 0.26, o.head, 0.3, true);
        }
      }
      // string course between stages
      b.put(bevelBox(s + 0.34, 0.16, s + 0.34, 0.03), trs(0, y0 + fh - 0.08, 0),
        { mat: spec.accent, surface: 'concrete' });
    }

    const top = g + floors * fh;
    // muezzin's gallery
    const gs = hw * 2 * (1 - (floors - 1) * 0.055) + 1.5;
    b.put(bevelBox(gs, 0.2, gs, 0.03), trs(0, top - fh * 0.35, 0),
      { mat: spec.accent, surface: 'concrete' });
    for (const [dx, dz, yaw] of [[0, -1, Math.PI], [0, 1, 0], [1, 0, Math.PI / 2], [-1, 0, -Math.PI / 2]]) {
      this._railing(b, dx * gs * 0.5, dz * gs * 0.5, yaw, gs - 0.1, top - fh * 0.35 + 0.2, 0.95, true);
    }
    // cap
    const capR = hw * 0.95;
    b.put(latheGeo([[capR, 0], [capR * 0.94, 0.5], [capR * 0.7, 1.0], [capR * 0.36, 1.42], [0, 1.62]], 16),
      trs(0, top, 0), { mat: spec.accent, surface: 'concrete', tiling: 1 });
    b.put(cylinderGeo(0.05, 0.07, 1.2, 8), trs(0, top + 2.1, 0),
      { mat: 'metal', surface: 'metal', collide: false });
    b.put(sphereGeo(0.16, 10, 8), trs(0, top + 2.75, 0), { mat: 'brass', surface: 'metal', collide: false });

    const p = b.world(trs(0, top - fh * 0.2, 0));
    b.lights.addHint({ position: p, color: 0x8fc4ff, intensity: 6, distance: 16 });
    if (rng.chance(1)) {
      b.lights.addHint({
        position: b.world(trs(0, top + 1.2, 0)), color: 0x66ff99, intensity: 2.2, distance: 8,
      });
    }
  }

  _ruin(b) {
    const { spec, hw, hd, rng } = b;
    const g = b.groundY;
    const fh = b.fh;
    const def = { mat: spec.wall, surface: 'concrete', accent: spec.accent };

    const sides = [
      [hw, -hd, -hw, -hd, Math.PI], [-hw, hd, hw, hd, 0],
      [hw, hd, hw, -hd, Math.PI / 2], [-hw, -hd, -hw, hd, -Math.PI / 2],
    ];
    for (const [x0, z0, x1, z1, yaw] of sides) {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const pieces = Math.max(3, Math.round(len / 2.2));
      const ux = (x1 - x0) / len, uz = (z1 - z0) / len;
      for (let i = 0; i < pieces; i++) {
        const a = (i / pieces) * len, c = ((i + 1) / pieces) * len;
        // Most of the shell is down: a "ruin" that is 70% full-height wall just
        // reads as a building with a jagged parapet.
        const roll = rng.next();
        const collapsed = roll < 0.34;
        const half = roll >= 0.34 && roll < 0.66;
        if (roll > 0.94) continue;                 // section gone entirely
        const top = collapsed ? g + rng.range(0.35, 1.5)
          : half ? g + rng.range(1.6, 3.0)
            : g + rng.range(fh * 1.15, fh * 2.05);
        const mid = (a + c) * 0.5;
        b.put(bevelBox(c - a, top - g, WALL_T, 0.04, { uvOffset: [mid, (g + top) * 0.5, 0] }),
          trs(x0 + ux * mid, (g + top) * 0.5, z0 + uz * mid, yaw), def);
        // ragged crown: a couple of broken blocks on top
        const chunks = rng.int(1, 3);
        for (let k = 0; k < chunks; k++) {
          const cw = rng.range(0.25, 0.7);
          b.put(bevelBox(cw, rng.range(0.12, 0.34), WALL_T * rng.range(0.5, 1), 0.03),
            trs(x0 + ux * (a + rng.range(0.2, (c - a) - 0.2)),
              top + 0.1, z0 + uz * (a + rng.range(0.2, (c - a) - 0.2)),
              yaw + rng.range(-0.2, 0.2)),
            { mat: spec.accent, surface: 'concrete' });
        }
        // rebar clawing out of the break
        if (rng.chance(0.5)) {
          const n = rng.int(2, 5);
          for (let k = 0; k < n; k++) {
            const rl = rng.range(0.3, 0.9);
            b.put(cylinderGeo(0.011, 0.013, rl, 5),
              trs(x0 + ux * (a + rng.range(0.1, c - a - 0.1)), top + rl * 0.4,
                z0 + uz * (a + rng.range(0.1, c - a - 0.1)),
                rng.range(0, 6.28), 1, 1, 1, rng.range(-0.5, 0.5), rng.range(-0.5, 0.5)),
              { mat: 'metal_rusted', surface: 'metal', collide: false });
          }
        }
      }
    }

    // half-fallen first floor: two slabs, one tipped into the room
    b.put(bevelBox(hw * 1.1, SLAB_T, hd * 1.6, 0.03), trs(-hw * 0.42, g + fh, 0),
      { mat: 'concrete_cracked', surface: 'concrete' });
    b.put(bevelBox(hw * 0.8, SLAB_T, hd * 0.7, 0.03),
      trs(hw * 0.4, g + fh * 0.55, hd * 0.35, 0.2, 1, 1, 1, 0.55, 0.15),
      { mat: 'concrete_cracked', surface: 'concrete' });
    // dangling rebar mat under the break
    for (let i = 0; i < 10; i++) {
      const rl = rng.range(0.4, 1.1);
      b.put(cylinderGeo(0.010, 0.010, rl, 4),
        trs(rng.range(-hw * 0.1, hw * 0.3), g + fh - rl * 0.4, rng.range(-hd * 0.6, hd * 0.6),
          rng.range(0, 6.28), 1, 1, 1, rng.range(-0.7, 0.7), rng.range(-0.7, 0.7)),
        { mat: 'metal_rusted', surface: 'metal', cast: false, collide: false });
    }

    // rubble mounds inside and against the walls
    for (let i = 0; i < 16; i++) {
      const rx = rng.range(-hw + 0.5, hw - 0.5), rz = rng.range(-hd + 0.5, hd - 0.5);
      const s = rng.range(0.35, 1.5);
      b.inst('rubble-chunk', RUBBLE_GEO(), trs(rx, g + s * 0.22, rz,
        rng.range(0, 6.28), s, s * rng.range(0.4, 0.8), s * rng.range(0.7, 1.2),
        rng.range(-0.3, 0.3), rng.range(-0.3, 0.3)),
      { mat: 'rubble', surface: 'concrete' });
    }
    b.put(bevelBox(hw * 1.8, 0.5, hd * 1.5, 0.15), trs(hw * 0.1, g + 0.12, -hd * 0.2, 0.3),
      { mat: 'rubble', surface: 'concrete' });

    // scorched brazier: a warm practical inside the shell at night
    b.lights.addHint({
      position: b.world(trs(-hw * 0.3, g + 0.7, hd * 0.2)),
      color: 0xff7a2a, intensity: 6.5, distance: 10, dayLit: false,
    });
  }
}

/* ------------------------------------------------------------------ */

let _rubbleGeo = null;
function RUBBLE_GEO() {
  if (!_rubbleGeo) _rubbleGeo = bevelBox(1, 1, 1, 0.12);
  return _rubbleGeo;
}

function hashId(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
