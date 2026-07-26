import * as THREE from 'three';
import { cylinderGeo, latheGeo, sphereGeo, cardGeo, normalizeGeo, trs } from './GeoUtil.js';
import { PALMS, MAP } from './Layout.js';

/**
 * Vegetation.
 *
 * Everything green is alpha-tested cards on real supporting geometry: a date
 * palm is a fibrous lathe-turned trunk carrying fourteen individually curved
 * fronds, not a billboard. The fronds are built as tapering strips swept along
 * a droop curve with a twist, so the crown has depth from every angle and
 * catches translucency from behind — the materials library's foliage shader
 * adds the back-light term, which is most of what sells a palm at golden hour.
 *
 * Scrub and grass are instanced crossed cards, scattered away from the roads
 * and clustered against walls where wind-blown seed actually collects.
 */

/**
 * One palm frond: a strip that starts narrow at the rachis, widens, then tapers,
 * following a curve that droops under its own weight and twists along its span.
 */
export function frondGeo(len = 2.4, width = 0.42, droop = 0.55, segs = 9) {
  const pos = [], nrm = [], uvs = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    // spine: forward, rising then falling
    const x = len * t;
    const y = len * (0.30 * t - droop * t * t);
    const twist = t * 0.9;
    const w = width * Math.sin(Math.PI * Math.min(1, t * 1.15)) * (1 - t * 0.35) + 0.02;
    const cw = Math.cos(twist), sw = Math.sin(twist);
    for (let s = -1; s <= 1; s += 2) {
      pos.push(x, y + s * w * sw * 0.35, s * w * cw);
      nrm.push(0, 1, 0);
      uvs.push(t, (s + 1) * 0.5);
    }
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return normalizeGeo(g);
}

export class Foliage {
  constructor(world) {
    this.world = world;
    this.game = world.game;
  }

  build(ctx) {
    this.ctx = ctx;
    this.rng = this.world.rng.fork(0x0f01);
    this._protos();
    for (const [x, z] of PALMS) this._palm(x, z, ctx.terrain);
    this._scrub(ctx.terrain);
    this._grass(ctx.terrain);
    return this;
  }

  _protos() {
    this.frondA = frondGeo(2.5, 0.44, 0.55, 9);
    this.frondB = frondGeo(2.0, 0.38, 0.78, 8);
    this.bushCard = cardGeo(1.15, 0.95, 0.22, 3, 3);
    this.grassCard = cardGeo(0.5, 0.42, 0.16, 2, 2);
  }

  /**
   * Date palm: stepped trunk with the diamond scar pattern approximated by
   * alternating collar rings, a fibrous crownshaft, fronds in two whorls, and a
   * cluster of dates on the mature ones.
   */
  _palm(x, z, terrain) {
    const rng = this.rng;
    const y = terrain.heightAt(x, z);
    const h = rng.range(5.2, 9.0);
    const lean = rng.range(-0.07, 0.07);
    const leanDir = rng.range(0, 6.283);
    const rBase = 0.26, rTop = 0.17;

    const profile = [[0, 0]];
    const rings = Math.max(7, Math.round(h / 0.42));
    for (let i = 0; i <= rings; i++) {
      const t = i / rings;
      const r = rBase + (rTop - rBase) * t;
      const bulge = (i % 2 === 0) ? 1.07 : 0.985;
      profile.push([r * bulge, t * h]);
      profile.push([r * 0.99, t * h + h / rings * 0.45]);
    }
    profile.push([rTop * 0.9, h + 0.05], [0, h + 0.08]);

    const put = (geo, m, def) => this.ctx.batcher.add(geo, m, { chunk: 'palms', ...def });
    put(latheGeo(profile, 12),
      trs(x, y, z, leanDir, 1, 1, 1, lean, lean * 0.6),
      { mat: 'wood', surface: 'wood', tiling: 1 });

    // crown position, following the lean
    const tipX = x + Math.sin(lean) * h * Math.cos(leanDir);
    const tipZ = z + Math.sin(lean) * h * Math.sin(leanDir);
    const tipY = y + h * Math.cos(lean);

    // crownshaft
    put(latheGeo([[rTop, 0], [rTop * 1.35, 0.22], [rTop * 1.1, 0.5], [0, 0.62]], 12),
      trs(tipX, tipY - 0.1, tipZ), { mat: 'wood', surface: 'wood', tiling: 1 });

    const fronds = rng.int(11, 16);
    for (let i = 0; i < fronds; i++) {
      const a = (i / fronds) * Math.PI * 2 + rng.range(-0.14, 0.14);
      const outer = i % 3 !== 0;
      const pitch = outer ? rng.range(-0.35, 0.05) : rng.range(0.25, 0.75);
      const s = rng.range(0.85, 1.18);
      this.ctx.instancer.add(outer ? 'frondA' : 'frondB',
        outer ? this.frondA : this.frondB,
        trs(tipX, tipY + 0.30, tipZ, a, s, s, s, 0, pitch),
        { mat: 'foliage', surface: 'foliage', cast: true, receive: true, collide: false });
    }

    // dates
    if (rng.chance(0.45)) {
      const bunches = rng.int(2, 4);
      for (let i = 0; i < bunches; i++) {
        const a = rng.range(0, 6.283);
        const bx = tipX + Math.cos(a) * 0.45, bz = tipZ + Math.sin(a) * 0.45;
        put(sphereGeo(0.22, 8, 6), trs(bx, tipY - 0.05, bz, 0, 1, 1.5, 1),
          { mat: 'foliage', surface: 'foliage', cast: true, collide: false });
      }
    }

    // trunk collar of dead fronds
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * 6.283 + rng.range(-0.2, 0.2);
      this.ctx.instancer.add('frondB', this.frondB,
        trs(tipX, tipY - 0.15, tipZ, a, 0.7, 0.7, 0.7, 0, rng.range(1.15, 1.5)),
        { mat: 'foliage', surface: 'foliage', cast: true, collide: false });
    }

    // a collider so the player cannot walk through the trunk
    this.ctx.batcher.add(cylinderGeo(rTop, rBase, h, 7), trs(x, y + h * 0.5, z),
      { mat: 'wood', surface: 'wood', cast: false, receive: false, collide: true, chunk: 'palm-collide' });
  }

  /** Desert scrub: crossed cards, densest against walls and kerbs. */
  _scrub(terrain) {
    const rng = this.rng;
    const H = MAP.half - 3;
    let placed = 0;
    for (let i = 0; i < 1400 && placed < 260; i++) {
      const x = rng.range(-H, H), z = rng.range(-H, H);
      if (terrain.insideBuilding(x, z, 0.4)) continue;
      const road = terrain.roadAt(x, z);
      if (road && road.w > 0.35) continue;
      // cluster: reject most isolated points so bushes come in clumps
      const clump = Math.abs(Math.sin(x * 0.31) * Math.cos(z * 0.27));
      if (clump < 0.42 && rng.chance(0.8)) continue;
      const y = terrain.heightAt(x, z);
      placed++;
      const cards = rng.int(3, 5);
      const s = rng.range(0.55, 1.25);
      for (let k = 0; k < cards; k++) {
        this.ctx.instancer.add('bush', this.bushCard,
          trs(x + rng.range(-0.2, 0.2), y - 0.06, z + rng.range(-0.2, 0.2),
            rng.range(0, 6.283), s, s * rng.range(0.8, 1.2), s,
            rng.range(-0.18, 0.18), rng.range(-0.18, 0.18)),
          { mat: 'foliage', surface: 'foliage', cast: true, collide: false });
      }
    }
  }

  /** Grass and weed tufts in the gutters and against the walls. */
  _grass(terrain) {
    const rng = this.rng;
    const H = MAP.half - 2;
    let placed = 0;
    for (let i = 0; i < 3000 && placed < 620; i++) {
      const x = rng.range(-H, H), z = rng.range(-H, H);
      if (terrain.insideBuilding(x, z, 0.2)) continue;
      const road = terrain.roadAt(x, z);
      // weeds grow at the kerb line, not on the carriageway
      const edge = road ? 1 - Math.abs(road.w - 0.55) * 2.2 : 0.25;
      if (edge < 0.15 && rng.chance(0.7)) continue;
      const y = terrain.heightAt(x, z);
      placed++;
      const s = rng.range(0.5, 1.15);
      for (let k = 0; k < 2; k++) {
        this.ctx.instancer.add('grass', this.grassCard,
          trs(x + rng.range(-0.12, 0.12), y - 0.04, z + rng.range(-0.12, 0.12),
            rng.range(0, 6.283), s, s * rng.range(0.7, 1.3), s,
            rng.range(-0.12, 0.12), rng.range(-0.12, 0.12)),
          { mat: 'foliage', surface: 'foliage', cast: false, collide: false });
      }
    }
  }
}
