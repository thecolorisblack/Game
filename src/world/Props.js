import * as THREE from 'three';
import {
  bevelBox, cylinderGeo, sphereGeo, latheGeo, torusGeo, clothGeo, blobGeo,
  extrudeProfile, catenaryPoints, tubeGeo, trs,
} from './GeoUtil.js';
import { COVER, STALLS, POLES, WIRES, WALLS, MAP } from './Layout.js';

/**
 * Street dressing.
 *
 * A three-lane map lives or dies on what is standing in the lanes: what you can
 * break line of sight behind, what tells you which way you are facing, and what
 * makes a 140 m box feel like somewhere people actually live. Everything in
 * here is generated from primitives and pushed into the shared batcher, so a
 * few hundred props still resolve to a couple of dozen draw calls.
 *
 * Repeated small geometry (bricks, chunks, tyres, bottles) goes through the
 * instancer instead; anything the player can stand behind goes through the
 * merged batcher so the physics BVH gets a real collider for it.
 */

/* Cached prototype geometry: built once, reused by every instance. */
const PROTO = {};
function proto(key, make) {
  if (!PROTO[key]) PROTO[key] = make();
  return PROTO[key];
}

export class Props {
  constructor(world) {
    this.world = world;
    this.game = world.game;
  }

  build(ctx) {
    this.ctx = ctx;
    this.rng = this.world.rng.fork(0x9151);
    const t = ctx.terrain;

    for (const c of COVER) this._cover(c, t);
    for (const s of STALLS) this._stall(s, t);
    this._poles(t);
    this._compoundWalls(t);
    this._streetLamps(t);
    this._signs(t);
    this._streetLines(t);
    this._scatter(t);
    this._marketFloor(t);
    return this;
  }

  /* ---------------------------------------------------------------- */

  /**
   * Everything dropped in the street gets a ground reference so the vertex
   * paint can put a splash line on it: the bottom of a barrel, a kerbside crate
   * and a jersey barrier all pick up the same dirt at the same height, which is
   * what makes a set of props look like they have been standing there.
   */
  put(geo, matrix, def) {
    let d = def;
    if (matrix && d.groundY === undefined) {
      d = { ...d, groundY: this.ctx.terrain.heightAt(matrix.elements[12], matrix.elements[14]) };
    }
    this.ctx.batcher.add(geo, matrix, d);
  }

  inst(key, geo, matrix, def) { this.ctx.instancer.add(key, geo, matrix, def); }

  /* ---------------------------------------------------------------- */
  /* cover                                                             */
  /* ---------------------------------------------------------------- */

  _cover(c, terrain) {
    const y = terrain.heightAt(c.x, c.z);
    const yaw = (c.rot || 0) * Math.PI / 180;
    switch (c.kind) {
      case 'jersey': this._jersey(c.x, y, c.z, yaw); break;
      case 'sandbag': this._sandbags(c.x, y, c.z, yaw); break;
      case 'crates': this._crateStack(c.x, y, c.z, yaw); break;
      case 'barrels': this._barrels(c.x, y, c.z, yaw); break;
      case 'rubble': this._rubblePile(c.x, y, c.z, yaw); break;
      case 'car': this._car(c.x, y, c.z, yaw, terrain); break;
      default: break;
    }
  }

  /**
   * Jersey barrier: the real F-shape profile, extruded, with a lifting eye and
   * a scuffed base. Two or three are chained end to end with a small kink so
   * the run never reads as one long box.
   */
  _jersey(x, y, z, yaw) {
    const rng = this.rng;
    const geo = proto('jersey', () => extrudeProfile([
      [-0.30, 0], [0.30, 0], [0.30, 0.075], [0.235, 0.10],
      [0.125, 0.56], [0.105, 0.60], [0.105, 1.00], [0.09, 1.045], [-0.09, 1.045],
      [-0.105, 1.00], [-0.105, 0.60], [-0.125, 0.56], [-0.235, 0.10], [-0.30, 0.075],
    ], 2.4, { endBevel: 0.028 }));

    const count = rng.int(2, 3);
    const a = yaw;
    for (let i = 0; i < count; i++) {
      // The profile is extruded along local +Z, so the chain runs that way too.
      const off = (i - (count - 1) * 0.5) * 2.45;
      const bx = x + Math.sin(a) * off, bz = z + Math.cos(a) * off;
      const by = this.ctx.terrain.heightAt(bx, bz);
      const kink = rng.range(-0.06, 0.06);
      this.put(geo, trs(bx, by - 0.02, bz, a + kink, 1, 1, 1, rng.range(-0.01, 0.01), rng.range(-0.02, 0.02)),
        { mat: 'concrete', surface: 'concrete', tiling: 1 });
      // lifting eyes
      for (const s of [-1, 1]) {
        this.put(torusGeo(0.05, 0.012, 5, 10),
          trs(bx + Math.sin(a) * s * 0.6, by + 1.04, bz + Math.cos(a) * s * 0.6, a, 1, 1, 1, Math.PI / 2),
          { mat: 'metal_rusted', surface: 'metal', cast: false, collide: false });
      }
      // a reflective plate on the road side, half torn off
      if (rng.chance(0.5)) {
        this.put(bevelBox(0.22, 0.14, 0.02, 0.005),
          trs(bx + Math.cos(a) * 0.11, by + 0.75, bz - Math.sin(a) * 0.11, a),
          { mat: 'metal_painted', surface: 'metal', cast: false, collide: false });
      }
    }
  }

  /** Sandbag emplacement: courses of lumpy bags, stretcher-bonded, slumping. */
  _sandbags(x, y, z, yaw) {
    const rng = this.rng;
    const courses = rng.int(4, 6);
    const perCourse = rng.int(5, 7);
    const bagW = 0.46, bagH = 0.19;
    for (let c = 0; c < courses; c++) {
      const n = perCourse - Math.floor(c / 2);
      const stagger = (c % 2) * bagW * 0.5;
      for (let i = 0; i < n; i++) {
        const along = (i - (n - 1) * 0.5) * bagW + stagger;
        const px = x + Math.cos(yaw) * along;
        const pz = z - Math.sin(yaw) * along;
        const py = y + bagH * 0.5 + c * bagH * 0.92;
        const g = proto(`bag${(c + i) % 3}`, () => blobGeo(0.5, 9, 6, 0.16, (c + i) * 3 + 1));
        this.inst('sandbag', g, trs(px, py, pz,
          yaw + rng.range(-0.12, 0.12),
          bagW * 1.02, bagH * 1.15, 0.32,
          rng.range(-0.06, 0.06), rng.range(-0.08, 0.08)),
        { mat: 'sandbag', surface: 'sand', collide: false });
      }
    }
    // One merged collider so the physics BVH has a simple box to test against.
    // Kept strictly inside the bag silhouette — the bags overhang it on every
    // face, so it is never the thing you actually see.
    this.put(bevelBox((perCourse - 1.4) * bagW, courses * bagH * 0.9, 0.26, 0.04),
      trs(x, y + courses * bagH * 0.45, z, yaw),
      { mat: 'sandbag', surface: 'sand', cast: true, collide: true, chunk: 'cover-collide' });
    // an ammo tin and a helmet on top, because someone was here
    if (rng.chance(0.5)) {
      this.put(bevelBox(0.34, 0.18, 0.19, 0.015),
        trs(x + rng.range(-0.6, 0.6), y + courses * bagH * 0.92 + 0.09, z, yaw + rng.range(-0.4, 0.4)),
        { mat: 'metal_painted', surface: 'metal' });
    }
  }

  /** Timber crates: boards, corner battens, stencil panel, stacked askew. */
  _crateStack(x, y, z, yaw) {
    const rng = this.rng;
    const n = rng.int(3, 5);
    let level = 0;
    for (let i = 0; i < n; i++) {
      const s = rng.range(0.52, 0.78);
      const px = x + rng.range(-0.45, 0.45);
      const pz = z + rng.range(-0.45, 0.45);
      const py = y + level + s * 0.5;
      const a = yaw + rng.range(-0.5, 0.5);
      this.put(bevelBox(s, s, s * rng.range(0.85, 1.1), 0.018, { uvOffset: [px, py, pz] }),
        trs(px, py, pz, a), { mat: 'wood', surface: 'wood', tiling: 1 });
      // battens on the visible faces
      for (const sx of [-1, 1]) {
        this.put(bevelBox(0.045, s + 0.02, 0.045, 0.008),
          trs(px + Math.cos(a) * sx * s * 0.47, py, pz - Math.sin(a) * sx * s * 0.47, a),
          { mat: 'wood', surface: 'wood', cast: false, collide: false });
      }
      this.put(bevelBox(s * 0.98, 0.05, 0.05, 0.008), trs(px, py + s * 0.42, pz, a),
        { mat: 'wood', surface: 'wood', cast: false, collide: false });
      if (rng.chance(0.4)) level += s * 0.98; else level += 0;
      if (level > 1.3) break;
    }
  }

  /** Oil drums: ribbed lathe body, bung plugs, a puddle of rust at the base. */
  _barrels(x, y, z, yaw) {
    const rng = this.rng;
    const geo = proto('barrel', () => latheGeo([
      [0, 0], [0.28, 0], [0.285, 0.03], [0.30, 0.06],
      [0.30, 0.20], [0.315, 0.235], [0.30, 0.27],
      [0.30, 0.52], [0.315, 0.555], [0.30, 0.59],
      [0.30, 0.82], [0.285, 0.85], [0.28, 0.88], [0, 0.88],
    ], 16));
    const n = rng.int(2, 4);
    for (let i = 0; i < n; i++) {
      const a = yaw + (i / n) * 6.283;
      const r = i === 0 ? 0 : rng.range(0.5, 0.75);
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      const py = this.ctx.terrain.heightAt(px, pz);
      const tipped = rng.chance(0.2);
      const mat = rng.chance(0.5) ? 'metal_rusted' : 'metal_painted';
      this.put(geo, tipped
        ? trs(px, py + 0.30, pz, rng.range(0, 6.28), 1, 1, 1, Math.PI / 2, 0)
        : trs(px, py, pz, rng.range(0, 6.28)),
      { mat, surface: 'metal', tiling: 1 });
      if (!tipped) {
        this.put(cylinderGeo(0.05, 0.05, 0.03, 8), trs(px + 0.14, py + 0.885, pz, 0),
          { mat: 'metal', surface: 'metal', cast: false, collide: false });
      }
    }
  }

  /** Rubble: a merged mound plus a scatter of instanced chunks and rebar. */
  _rubblePile(x, y, z, yaw) {
    const rng = this.rng;
    const w = rng.range(2.2, 3.4), d = rng.range(1.6, 2.6), h = rng.range(0.7, 1.25);
    this.put(blobGeo(0.5, 12, 8, 0.30, 7),
      trs(x, y + h * 0.25, z, yaw, w, h * 1.5, d),
      { mat: 'rubble', surface: 'concrete', tiling: 1 });
    const chunkGeo = proto('chunk', () => bevelBox(1, 1, 1, 0.1));
    for (let i = 0; i < 22; i++) {
      const a = rng.range(0, 6.283), r = rng.range(0, 1) ** 0.6;
      const px = x + Math.cos(a) * r * w * 0.7;
      const pz = z + Math.sin(a) * r * d * 0.7;
      const py = this.ctx.terrain.heightAt(px, pz);
      const s = rng.range(0.10, 0.42);
      this.inst('rubble-chunk', chunkGeo, trs(px, py + s * 0.3, pz,
        rng.range(0, 6.28), s, s * rng.range(0.4, 0.9), s * rng.range(0.6, 1.3),
        rng.range(-0.4, 0.4), rng.range(-0.4, 0.4)),
      { mat: 'rubble', surface: 'concrete' });
    }
    for (let i = 0; i < 5; i++) {
      const len = rng.range(0.5, 1.5);
      this.put(cylinderGeo(0.011, 0.013, len, 5),
        trs(x + rng.range(-1, 1), y + len * 0.3, z + rng.range(-1, 1),
          rng.range(0, 6.28), 1, 1, 1, rng.range(-1.1, 1.1), rng.range(-1.1, 1.1)),
        { mat: 'metal_rusted', surface: 'metal', collide: false });
    }
    // a broken slab leaning out of the pile
    this.put(bevelBox(rng.range(1.0, 1.8), 0.16, rng.range(0.7, 1.3), 0.03),
      trs(x + rng.range(-0.6, 0.6), y + 0.5, z + rng.range(-0.6, 0.6),
        rng.range(0, 6.28), 1, 1, 1, rng.range(0.4, 0.9), rng.range(-0.3, 0.3)),
      { mat: 'concrete_cracked', surface: 'concrete', tiling: 1 });
  }

  /**
   * Burnt-out saloon. Built as a body tub, a stepped bonnet/boot, a caved-in
   * roof, four burnt wheels and a lot of missing trim — the silhouette matters
   * far more than the panel gaps at the distances this is seen from.
   */
  _car(x, y, z, yaw, terrain) {
    const rng = this.rng;
    const burnt = { mat: 'metal_rusted', surface: 'metal', tiling: 1 };
    const dark = { mat: 'metal_painted', surface: 'metal', tiling: 1 };
    const L = 4.25, W = 1.78;
    const sit = rng.range(-0.06, 0.02);

    // chassis tub
    this.put(bevelBox(W, 0.52, L, 0.06, { uvOffset: [0, 0.5, 0] }),
      trs(x, y + 0.62 + sit, z, yaw), burnt);
    // sills
    for (const s of [-1, 1]) {
      this.put(bevelBox(0.12, 0.22, L * 0.72, 0.03),
        trs(x + Math.cos(yaw) * s * W * 0.5, y + 0.44 + sit, z - Math.sin(yaw) * s * W * 0.5, yaw), dark);
    }
    // bonnet and boot, both sprung
    this.put(bevelBox(W * 0.95, 0.16, L * 0.30, 0.04),
      trs(x + Math.sin(yaw) * L * 0.34, y + 0.90 + sit, z + Math.cos(yaw) * L * 0.34, yaw, 1, 1, 1, -0.07),
      burnt);
    this.put(bevelBox(W * 0.93, 0.15, L * 0.24, 0.04),
      trs(x - Math.sin(yaw) * L * 0.36, y + 0.88 + sit, z - Math.cos(yaw) * L * 0.36, yaw, 1, 1, 1, 0.10),
      burnt);
    // cabin: A/B/C pillars and a collapsed roof
    const roofY = y + 1.36 + sit;
    for (const s of [-1, 1]) {
      for (const [f, tilt] of [[0.30, 0.45], [-0.02, 0.0], [-0.34, -0.38]]) {
        this.put(bevelBox(0.09, 0.62, 0.10, 0.02),
          trs(x + Math.sin(yaw) * L * f + Math.cos(yaw) * s * W * 0.46,
            y + 1.05 + sit,
            z + Math.cos(yaw) * L * f - Math.sin(yaw) * s * W * 0.46,
            yaw, 1, 1, 1, tilt),
          dark);
      }
    }
    this.put(bevelBox(W * 0.88, 0.10, L * 0.40, 0.05),
      trs(x - Math.sin(yaw) * L * 0.02, roofY - 0.10, z - Math.cos(yaw) * L * 0.02,
        yaw, 1, 1, 1, rng.range(-0.10, 0.10), rng.range(-0.14, 0.14)),
      burnt);
    // dashboard/engine block visible through the burnt-out front
    this.put(bevelBox(W * 0.6, 0.36, 0.5, 0.03),
      trs(x + Math.sin(yaw) * L * 0.30, y + 0.78 + sit, z + Math.cos(yaw) * L * 0.30, yaw), dark);
    // bumpers
    for (const s of [1, -1]) {
      this.put(bevelBox(W * 1.02, 0.18, 0.14, 0.03),
        trs(x + Math.sin(yaw) * s * L * 0.5, y + 0.55 + sit, z + Math.cos(yaw) * s * L * 0.5, yaw), dark);
    }
    // wheels: two burnt, one missing, one flat
    const wheel = proto('wheel', () => {
      const g = torusGeo(0.24, 0.11, 6, 14);
      g.rotateX(Math.PI / 2);
      return g;
    });
    const hub = proto('hub', () => cylinderGeo(0.15, 0.15, 0.1, 10));
    let i = 0;
    for (const fz of [0.32, -0.32]) {
      for (const sx of [-1, 1]) {
        const px = x + Math.sin(yaw) * L * fz + Math.cos(yaw) * sx * W * 0.52;
        const pz = z + Math.cos(yaw) * L * fz - Math.sin(yaw) * sx * W * 0.52;
        const py = terrain.heightAt(px, pz);
        i++;
        if (i === 3) continue;                     // one wheel taken
        const flat = i === 2 ? 0.55 : 1;
        this.put(wheel, trs(px, py + 0.24 * flat + 0.02, pz, yaw, 1, flat, 1),
          { mat: 'polymer', surface: 'metal', tiling: 1 });
        this.put(hub, trs(px, py + 0.24 * flat + 0.02, pz, yaw, 1, 1, 1, 0, Math.PI / 2),
          { mat: 'metal_rusted', surface: 'metal', cast: false });
      }
    }
    // scorch halo burnt into the road under the wreck
    this.put(bevelBox(W * 2.4, 0.014, L * 1.7, 0.03),
      trs(x, y + 0.055, z, yaw),
      { mat: 'scorch', surface: 'concrete', cast: false, collide: false, tiling: 1 });
  }

  /* ---------------------------------------------------------------- */
  /* market                                                            */
  /* ---------------------------------------------------------------- */

  /** Market stall: timber frame, sagging canopy, counter, produce, price board. */
  _stall(s, terrain) {
    const rng = this.rng;
    const y = terrain.heightAt(s.x, s.z);
    const yaw = (s.rot || 0) * Math.PI / 180;
    const W = 2.6, D = 1.9, H = 2.25;
    const wood = { mat: 'wood', surface: 'wood', tiling: 1 };
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    const at = (ax, az) => [s.x + c * ax + sn * az, s.z - sn * ax + c * az];

    for (const [px, pz] of [at(-W / 2, -D / 2), at(W / 2, -D / 2), at(-W / 2, D / 2), at(W / 2, D / 2)]) {
      this.put(bevelBox(0.075, H, 0.075, 0.012), trs(px, y + H * 0.5, pz, yaw), wood);
    }
    // top rails
    for (const az of [-D / 2, D / 2]) {
      const [px, pz] = at(0, az);
      this.put(bevelBox(W, 0.07, 0.07, 0.012), trs(px, y + H, pz, yaw), wood);
    }
    for (const ax of [-W / 2, W / 2]) {
      const [px, pz] = at(ax, 0);
      this.put(bevelBox(0.07, 0.07, D, 0.012), trs(px, y + H - 0.005, pz, yaw), wood);
    }
    // canopy: two sagging panels striped by the material variant
    const canopyTint = [0xffffff, 0xc9553f, 0x3f6f8f][s.canopy % 3];
    const [cx0, cz0] = at(0, 0);
    this.put(clothGeo(W + 0.5, D + 0.5, { sag: 0.24, segX: 10, segZ: 8, wrinkle: 0.03 }),
      trs(cx0, y + H + 0.10, cz0, yaw),
      { mat: `stallCanopy${s.canopy % 3}`, surface: 'fabric', collide: false, chunk: 'canopies' });
    // valance hanging off the front
    const [vx, vz] = at(0, D / 2 + 0.22);
    this.put(clothGeo(W + 0.5, 0.42, { sag: 0.05, segX: 10, segZ: 3, wrinkle: 0.02 }),
      trs(vx, y + H - 0.10, vz, yaw, 1, 1, 1, Math.PI / 2),
      { mat: `stallCanopy${s.canopy % 3}`, surface: 'fabric', collide: false, chunk: 'canopies' });

    // counter
    const [tx, tz] = at(0, D * 0.18);
    this.put(bevelBox(W - 0.1, 0.08, D * 0.62, 0.015), trs(tx, y + 0.92, tz, yaw), wood);
    this.put(bevelBox(W - 0.3, 0.86, 0.06, 0.012), trs(...swapY(at(0, D * 0.18 + D * 0.30), y + 0.46), yaw), wood);

    // produce: crates of blobs
    for (let i = 0; i < 3; i++) {
      const ax = (i - 1) * 0.78;
      const [bx, bz] = at(ax, D * 0.18);
      this.put(bevelBox(0.6, 0.22, 0.44, 0.012), trs(bx, y + 1.07, bz, yaw + rng.range(-0.1, 0.1)), wood);
      const g = proto(`produce${i}`, () => blobGeo(0.5, 7, 5, 0.24, i * 5 + 2));
      for (let k = 0; k < 7; k++) {
        const r = 0.062;
        this.inst('produce', g, trs(
          bx + rng.range(-0.22, 0.22), y + 1.20 + rng.range(0, 0.05), bz + rng.range(-0.16, 0.16),
          rng.range(0, 6.28), r, r, r), {
          mat: 'produce', surface: 'fabric', collide: false, cast: false,
          color: new THREE.Color().setHSL(rng.range(0.02, 0.20), 0.78, 0.52),
        });
      }
    }

    // hanging scales and a bulb
    const [hx, hz] = at(W * 0.36, 0);
    this.put(cylinderGeo(0.004, 0.004, 0.4, 4), trs(hx, y + H - 0.22, hz), { mat: 'metal', surface: 'metal', collide: false });
    this.put(latheGeo([[0, 0.0], [0.14, 0.06], [0.13, 0.09], [0, 0.09]], 10),
      trs(hx, y + H - 0.44, hz), { mat: 'metal', surface: 'metal', collide: false });

    const light = new THREE.Vector3(cx0, y + H - 0.15, cz0);
    this.ctx.lights.addHint({ position: light, color: 0xffc27a, intensity: 4.5, distance: 7.5 });
  }

  /** A dusting of trodden produce, crates and matting down the souk. */
  _marketFloor(terrain) {
    const rng = this.rng;
    const brick = proto('brick', () => bevelBox(0.22, 0.07, 0.105, 0.008));
    const plank = proto('plank', () => bevelBox(1.1, 0.035, 0.14, 0.008));
    for (let i = 0; i < 90; i++) {
      const x = rng.range(-11, 5.5), z = rng.range(-52, 52);
      if (terrain.insideBuilding(x, z, 0.4)) continue;
      const y = terrain.heightAt(x, z);
      if (rng.chance(0.5)) {
        this.inst('brick', brick, trs(x, y + 0.035, z, rng.range(0, 6.28), 1, 1, 1,
          rng.range(-0.1, 0.1), rng.range(-0.1, 0.1)),
        { mat: 'brick', surface: 'concrete', collide: false, cast: true });
      } else {
        this.inst('plank', plank, trs(x, y + 0.02, z, rng.range(0, 6.28), 1, 1, 1, 0, rng.range(-0.06, 0.06)),
          { mat: 'wood', surface: 'wood', collide: false, cast: true });
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* infrastructure                                                    */
  /* ---------------------------------------------------------------- */

  /** Power poles with cross-arms, insulators and catenary-sagged spans. */
  _poles(terrain) {
    const rng = this.rng;
    const tops = [];
    for (const p of POLES) {
      const y = terrain.heightAt(p.x, p.z);
      const lean = rng.range(-0.035, 0.035);
      this.put(cylinderGeo(0.11, 0.16, p.h, 9),
        trs(p.x, y + p.h * 0.5, p.z, rng.range(0, 6.28), 1, 1, 1, lean, lean * 0.6),
        { mat: 'wood', surface: 'wood', tiling: 1 });
      // concrete collar at the base
      this.put(cylinderGeo(0.24, 0.30, 0.35, 10), trs(p.x, y + 0.14, p.z),
        { mat: 'concrete', surface: 'concrete' });
      // cross-arms
      const armY = y + p.h - 0.55;
      this.put(bevelBox(1.9, 0.09, 0.09, 0.015), trs(p.x, armY, p.z, rng.range(0, 3.14)),
        { mat: 'wood', surface: 'wood', collide: false });
      this.put(bevelBox(1.35, 0.08, 0.08, 0.015), trs(p.x, armY - 0.55, p.z, rng.range(0, 3.14)),
        { mat: 'wood', surface: 'wood', collide: false });
      for (const s of [-1, 0, 1]) {
        this.put(latheGeo([[0, 0], [0.045, 0.01], [0.035, 0.055], [0.05, 0.07], [0.03, 0.12], [0, 0.13]], 8),
          trs(p.x + s * 0.8, armY + 0.06, p.z),
          { mat: 'glass', surface: 'glass', cast: false });
      }
      // a transformer can on every third pole
      if (rng.chance(0.34)) {
        this.put(cylinderGeo(0.22, 0.22, 0.6, 10), trs(p.x + 0.3, y + p.h - 1.8, p.z),
          { mat: 'metal_painted', surface: 'metal', tiling: 1 });
      }
      tops.push(new THREE.Vector3(p.x, armY + 0.1, p.z));
    }
    for (const [a, c] of WIRES) {
      if (!tops[a] || !tops[c]) continue;
      const span = tops[a].distanceTo(tops[c]);
      for (const off of [-0.8, 0, 0.8]) {
        const p0 = tops[a].clone(); p0.x += off * 0.2;
        const p1 = tops[c].clone(); p1.x += off * 0.2;
        p0.y -= Math.abs(off) * 0.05; p1.y -= Math.abs(off) * 0.05;
        this.put(tubeGeo(catenaryPoints(p0, p1, span * 0.035 + 0.25, 10), 0.014, 4), null,
          { mat: 'polymer', surface: 'metal', cast: false, collide: false, chunk: 'wires' });
      }
    }
  }

  /** Street lamps: a cast column, a swan neck and a shielded head. */
  _streetLamps(terrain) {
    const rng = this.rng;
    const spots = [
      [5.2, 24], [5.4, -2], [5.0, -30], [-11.2, 10], [-11.4, -12],
      [-31.6, 22], [-31.4, -2], [-31.8, -26], [27.2, 18], [27.4, -8],
      [-45.4, 4], [-45.2, -20], [18, 27], [-18, 27],
    ];
    for (const [x, z] of spots) {
      const y = terrain.heightAt(x, z);
      const h = 5.4;
      this.put(bevelBox(0.34, 0.42, 0.34, 0.03), trs(x, y + 0.2, z), { mat: 'concrete', surface: 'concrete' });
      this.put(cylinderGeo(0.055, 0.085, h, 10), trs(x, y + h * 0.5 + 0.3, z),
        { mat: 'metal_painted', surface: 'metal', tiling: 1 });
      const dir = x > 0 ? -1 : 1;
      const armPts = [
        new THREE.Vector3(x, y + h + 0.2, z),
        new THREE.Vector3(x + dir * 0.35, y + h + 0.62, z),
        new THREE.Vector3(x + dir * 1.05, y + h + 0.70, z),
      ];
      this.put(tubeGeo(armPts, 0.045, 6), null,
        { mat: 'metal_painted', surface: 'metal', collide: false, chunk: 'lamps' });
      const hx = x + dir * 1.15, hz = z;
      this.put(latheGeo([[0, 0], [0.20, -0.02], [0.24, -0.12], [0.20, -0.2], [0, -0.22]], 12),
        trs(hx, y + h + 0.70, hz), { mat: 'metal_painted', surface: 'metal', collide: false });
      this.put(sphereGeo(0.11, 10, 7), trs(hx, y + h + 0.58, hz),
        { mat: 'lampGlow', surface: 'glass', cast: false, collide: false });
      this.ctx.lights.addHint({
        position: new THREE.Vector3(hx, y + h + 0.5, hz),
        color: 0xffc07a, intensity: 26, distance: 22, decay: 1.7,
        spot: true, dir: new THREE.Vector3(0, -1, 0),
      });
      // a second, cheap point hint so the pool of light survives the spot budget
      this.ctx.lights.addHint({
        position: new THREE.Vector3(hx, y + h + 0.45, hz),
        color: 0xffb972, intensity: 7, distance: 15,
      });
      if (rng.chance(0.3)) {
        // dead lamp: no hint, and a smashed diffuser
        this.put(bevelBox(0.05, 0.03, 0.05, 0.01), trs(hx, y + h + 0.45, hz),
          { mat: 'glass', surface: 'glass', cast: false });
      }
    }
  }

  /** Compound walls: coursed blocks, a coping, and razor wire on the tall ones. */
  _compoundWalls(terrain) {
    const rng = this.rng;
    for (const w of WALLS) {
      for (let i = 0; i < w.pts.length - 1; i++) {
        const [x0, z0] = w.pts[i];
        const [x1, z1] = w.pts[i + 1];
        const len = Math.hypot(x1 - x0, z1 - z0);
        const yaw = Math.atan2(-(z1 - z0) / len, (x1 - x0) / len);
        const panels = Math.max(1, Math.round(len / 2.4));
        for (let k = 0; k < panels; k++) {
          const t0 = k / panels, t1 = (k + 1) / panels;
          const mx = x0 + (x1 - x0) * (t0 + t1) * 0.5;
          const mz = z0 + (z1 - z0) * (t0 + t1) * 0.5;
          const y = terrain.heightAt(mx, mz);
          const h = w.h * rng.range(0.94, 1.02);
          this.put(bevelBox(len / panels, h, 0.28, 0.03, { uvOffset: [len * (t0 + t1) * 0.5, h * 0.5, 0] }),
            trs(mx, y + h * 0.5, mz, yaw),
            { mat: w.mat, surface: 'concrete', tiling: 1, tint: w.tint });
          this.put(bevelBox(len / panels + 0.02, 0.12, 0.40, 0.025),
            trs(mx, y + h + 0.06, mz, yaw), { mat: 'concrete', surface: 'concrete' });
          // pilaster every other panel
          if (k % 2 === 0) {
            this.put(bevelBox(0.36, h + 0.24, 0.42, 0.03),
              trs(x0 + (x1 - x0) * t0, y + (h + 0.24) * 0.5, z0 + (z1 - z0) * t0, yaw),
              { mat: w.mat, surface: 'concrete', tiling: 1 });
          }
        }
        // razor coil on the taller compounds
        if (w.h > 2.5) {
          const pts = [];
          const coils = Math.max(6, Math.round(len / 0.5));
          for (let k = 0; k <= coils; k++) {
            const t = k / coils;
            const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
            const y = terrain.heightAt(x, z) + w.h + 0.35;
            pts.push(new THREE.Vector3(
              x + Math.sin(t * 34) * 0.17, y + Math.cos(t * 34) * 0.17, z + Math.cos(t * 27) * 0.05,
            ));
          }
          this.put(tubeGeo(pts, 0.012, 4), null,
            { mat: 'metal', surface: 'metal', cast: false, collide: false, chunk: 'wire-coil' });
        }
      }
    }
  }

  /** Street signage: post, plate, arabic-styled bar glyphs, a bullet dent. */
  _signs(terrain) {
    const rng = this.rng;
    const spots = [
      [5.9, 31.5, 200], [-11.8, 1.5, 20], [5.9, -33.5, 160],
      [-31.9, 31.0, 250], [-31.6, -33.0, 70], [27.9, 30.5, 210], [27.6, -1.5, 30],
    ];
    for (const [x, z, deg] of spots) {
      const y = terrain.heightAt(x, z);
      const yaw = deg * Math.PI / 180;
      const h = 2.5;
      this.put(cylinderGeo(0.035, 0.045, h, 8), trs(x, y + h * 0.5, z),
        { mat: 'metal_painted', surface: 'metal' });
      const plate = { mat: 'metal_painted', surface: 'metal' };
      this.put(bevelBox(0.9, 0.34, 0.02, 0.008), trs(x, y + h - 0.1, z, yaw, 1, 1, 1, 0, rng.range(-0.08, 0.08)), plate);
      for (let i = 0; i < 5; i++) {
        this.put(bevelBox(rng.range(0.05, 0.11), 0.09, 0.006, 0.002),
          trs(x + Math.cos(yaw) * (i - 2) * 0.15, y + h - 0.10, z - Math.sin(yaw) * (i - 2) * 0.15, yaw),
          { mat: 'metal', surface: 'metal', cast: false, collide: false });
      }
      if (rng.chance(0.5)) {
        this.put(bevelBox(0.62, 0.24, 0.02, 0.006),
          trs(x, y + h - 0.52, z, yaw + rng.range(-0.3, 0.3), 1, 1, 1, 0, rng.range(-0.2, 0.2)),
          plate);
      }
    }
  }

  /** Laundry and bunting strung across the souk between facing balconies. */
  _streetLines(terrain) {
    const rng = this.rng;
    const spans = [
      [[5.6, -8, 6.4], [-11.6, -8, 6.0]],
      [[5.6, 4, 6.8], [-11.6, 4, 6.4]],
      [[5.6, 18, 6.2], [-11.6, 18, 6.6]],
      [[5.6, -26, 7.0], [-11.6, -26, 6.4]],
      [[27.4, 6, 6.0], [40.4, 6, 5.6]],
    ];
    for (const [a, c] of spans) {
      const p0 = new THREE.Vector3(a[0], terrain.heightAt(a[0], a[1]) + a[2], a[1]);
      const p1 = new THREE.Vector3(c[0], terrain.heightAt(c[0], c[1]) + c[2], c[1]);
      const sag = p0.distanceTo(p1) * 0.06;
      const pts = catenaryPoints(p0, p1, sag, 12);
      this.put(tubeGeo(pts, 0.012, 4), null,
        { mat: 'metal', surface: 'metal', cast: false, collide: false, chunk: 'laundry' });
      const n = rng.int(5, 9);
      for (let i = 0; i < n; i++) {
        const t = (i + 0.7) / (n + 0.4);
        const idx = Math.min(pts.length - 1, Math.round(t * (pts.length - 1)));
        const p = pts[idx];
        const w = rng.range(0.5, 1.0), hh = rng.range(0.6, 1.25);
        this.put(clothGeo(w, hh, { sag: 0.06, segX: 5, segZ: 6, wrinkle: 0.025 }),
          trs(p.x, p.y - hh * 0.5 - 0.03, p.z, rng.range(-0.25, 0.25), 1, 1, 1, Math.PI / 2),
          { mat: `laundry${i % 3}`, surface: 'fabric', collide: false, chunk: 'laundry' });
        this.put(bevelBox(0.02, 0.05, 0.015, 0.004), trs(p.x, p.y + 0.01, p.z),
          { mat: 'wood', surface: 'wood', cast: false, collide: false });
      }
    }
  }

  /**
   * Global scatter: tyres, pallets, bottles, cans, cardboard and pipe offcuts,
   * biased toward walls and away from the middle of the carriageway.
   */
  _scatter(terrain) {
    const rng = this.rng;
    const tyre = proto('tyre', () => {
      const g = torusGeo(0.31, 0.115, 6, 14);
      g.rotateX(Math.PI / 2);
      return g;
    });
    const pallet = proto('pallet', () => bevelBox(1.15, 0.13, 0.85, 0.012));
    const bottle = proto('bottle', () => latheGeo([[0, 0], [0.035, 0], [0.037, 0.13], [0.014, 0.17], [0.013, 0.22], [0, 0.225]], 8));
    const can = proto('can', () => cylinderGeo(0.033, 0.033, 0.11, 8));
    const card = proto('card', () => bevelBox(0.6, 0.02, 0.44, 0.006));
    const pipe = proto('pipe', () => cylinderGeo(0.09, 0.09, 1.4, 10));

    const H = MAP.half - 4;
    let placed = 0;
    for (let i = 0; i < 900 && placed < 420; i++) {
      const x = rng.range(-H, H), z = rng.range(-H, H);
      if (terrain.insideBuilding(x, z, 0.6)) continue;
      const road = terrain.roadAt(x, z);
      const near = road ? road.w : 0;
      // favour the gutters: right at the kerb, not in the middle of the street
      if (near > 0.75 && rng.chance(0.85)) continue;
      const y = terrain.heightAt(x, z);
      const r = rng.next();
      placed++;
      if (r < 0.14) {
        this.inst('tyre', tyre, trs(x, y + 0.11, z, rng.range(0, 6.28), 1, 1, 1, Math.PI / 2 + rng.range(-0.2, 0.2)),
          { mat: 'polymer', surface: 'metal', collide: false });
      } else if (r < 0.24) {
        this.inst('pallet', pallet, trs(x, y + 0.07, z, rng.range(0, 6.28), 1, 1, 1, rng.range(-0.15, 0.15), rng.range(-0.15, 0.15)),
          { mat: 'wood', surface: 'wood', collide: false });
      } else if (r < 0.42) {
        this.inst('bottle', bottle, trs(x, y + 0.005, z, rng.range(0, 6.28), 1, 1, 1,
          rng.chance(0.6) ? Math.PI / 2 : 0), { mat: 'glass', surface: 'glass', collide: false, cast: false });
      } else if (r < 0.62) {
        this.inst('can', can, trs(x, y + 0.055, z, rng.range(0, 6.28), 1, 1, 1,
          rng.chance(0.7) ? Math.PI / 2 : 0), { mat: 'metal', surface: 'metal', collide: false, cast: false });
      } else if (r < 0.78) {
        this.inst('card', card, trs(x, y + 0.012, z, rng.range(0, 6.28), 1, 1, 1, rng.range(-0.1, 0.1), rng.range(-0.1, 0.1)),
          { mat: 'cardboard', surface: 'wood', collide: false, cast: false });
      } else if (r < 0.9) {
        this.inst('pipe', pipe, trs(x, y + 0.09, z, rng.range(0, 6.28), 1, 1, 1, Math.PI / 2),
          { mat: 'metal_rusted', surface: 'metal', collide: false });
      } else {
        const s = rng.range(0.12, 0.34);
        this.inst('rubble-chunk', proto('chunk', () => bevelBox(1, 1, 1, 0.1)),
          trs(x, y + s * 0.3, z, rng.range(0, 6.28), s, s * rng.range(0.4, 0.9), s * rng.range(0.6, 1.3),
            rng.range(-0.4, 0.4), rng.range(-0.4, 0.4)),
          { mat: 'rubble', surface: 'concrete', collide: false });
      }
    }

    // stacked tyre piles at three garage-ish spots
    for (const [x, z] of [[44, 20], [24, -40], [-52, 30]]) {
      const y = terrain.heightAt(x, z);
      for (let i = 0; i < 6; i++) {
        this.inst('tyre', tyre, trs(x + rng.range(-0.1, 0.1), y + 0.12 + i * 0.2, z + rng.range(-0.1, 0.1),
          rng.range(0, 6.28), 1, 1, 1, Math.PI / 2), { mat: 'polymer', surface: 'metal', collide: false });
      }
    }
  }
}

function swapY(xz, y) { return [xz[0], y, xz[1]]; }
