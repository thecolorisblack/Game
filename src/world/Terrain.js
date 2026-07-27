import * as THREE from 'three';
import { MAP, ROADS, POTHOLES, BUILDINGS } from './Layout.js';
import { fbm2, ridge2, smoothstep, clamp, lerp } from './Rng.js';
import { bevelBox, heightfieldGeo, trs, ensureColor } from './GeoUtil.js';

/**
 * Ground.
 *
 * A flat plane with boxes on it is the single most damning thing a shooter can
 * show you, so the ground here is a real heightfield: long-wavelength dune
 * undulation, a raised terrace in the south-west, roads cut into it as smoothed
 * channels with a crown camber and potholes, and wind-blown sand drifted up
 * against every wall in the level. Roads are laid as separate asphalt ribbons
 * sunk into that channel, with kerb stones covering the seam — which is both
 * how a real street is built and the only way to hide a hard material
 * transition without a splat map.
 *
 * `heightAt(x, z)` is the authority: props, buildings and spawn points all sit
 * on it, so nothing ever floats or sinks.
 */

function distToSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz || 1e-6;
  let t = ((px - ax) * dx + (pz - az) * dz) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t, cz = az + dz * t;
  const ex = px - cx, ez = pz - cz;
  return { d: Math.sqrt(ex * ex + ez * ez), t, cx, cz };
}

export class Terrain {
  constructor(world) {
    this.world = world;
    this.game = world.game;
    this.footprints = BUILDINGS.map((b) => {
      const r = (b.rot || 0) * Math.PI / 180;
      return { cx: b.cx, cz: b.cz, hw: b.w * 0.5, hd: b.d * 0.5, cos: Math.cos(-r), sin: Math.sin(-r) };
    });
    this._cache = new Map();
  }

  /* ---------------------------------------------------------------- */
  /* the height field                                                  */
  /* ---------------------------------------------------------------- */

  /** Terrain before roads are cut into it. */
  baseHeight(x, z) {
    let h = fbm2(x * 0.0115, z * 0.0115, 4, 2.03, 0.5, 17) * 0.62;
    h += fbm2(x * 0.041, z * 0.041, 3, 2.11, 0.5, 91) * 0.16;
    // south-west terrace: gives the establishing shot a natural vantage
    h += 1.35 * smoothstep(-6, -26, x) * smoothstep(16, 30, z);
    // the north-east corner falls away toward the wadi
    h -= 0.85 * smoothstep(12, 46, x) * smoothstep(-12, -46, z);
    return h;
  }

  /** Road influence at a point: 0 outside, 1 on the carriageway. */
  roadAt(x, z) {
    let best = null;
    for (const r of ROADS) {
      const s = distToSegment(x, z, r.a[0], r.a[1], r.b[0], r.b[1]);
      const w = 1 - smoothstep(r.w, r.w + 3.6, s.d);
      if (w <= 0.001) continue;
      if (!best || w > best.w) best = { w, road: r, ...s };
    }
    return best;
  }

  height(x, z) {
    let h = this.baseHeight(x, z);

    const r = this.roadAt(x, z);
    if (r) {
      // The carriageway follows a smoothed version of the terrain sampled on
      // the centreline, so a street never inherits the dunes it crosses.
      const base = this.baseHeight(r.cx, r.cz) * 0.5
        + this.baseHeight(r.cx + 5, r.cz) * 0.125
        + this.baseHeight(r.cx - 5, r.cz) * 0.125
        + this.baseHeight(r.cx, r.cz + 5) * 0.125
        + this.baseHeight(r.cx, r.cz - 5) * 0.125;
      const across = clamp(r.d / r.road.w, 0, 1);
      const camber = r.road.kind === 'asphalt' ? 0.105 * (1 - across * across) : 0.03;
      const sink = r.road.kind === 'asphalt' ? 0.17 : 0.06;
      h = lerp(h, base - sink + camber, r.w);
    }

    // Sand drifted against the buildings. The signed distance is used rather
    // than the clamped one so the drift ramps *down* to nothing a metre inside
    // the footprint — otherwise every interior floor sits under its own dune.
    let drift = 0;
    for (const f of this.footprints) {
      const dx = x - f.cx, dz = z - f.cz;
      const lx = dx * f.cos - dz * f.sin;
      const lz = dx * f.sin + dz * f.cos;
      const ox = Math.abs(lx) - f.hw, oz = Math.abs(lz) - f.hd;
      const sd = (ox > 0 || oz > 0)
        ? Math.hypot(Math.max(ox, 0), Math.max(oz, 0))
        : Math.max(ox, oz);
      if (sd > 3.2) continue;
      const inward = smoothstep(-1.6, -0.1, sd);
      const bias = 0.55 + 0.45 * fbm2(x * 0.09, z * 0.09, 2, 2, 0.5, 5);
      drift = Math.max(drift, 0.44 * bias * inward * Math.exp(-(Math.max(sd, 0) ** 2) / 2.1));
    }
    h += drift;

    for (const p of POTHOLES) {
      const dx = x - p[0], dz = z - p[1];
      const d2 = (dx * dx + dz * dz) / (p[2] * p[2]);
      if (d2 < 6) h -= p[3] * Math.exp(-d2 * 1.4);
    }
    return h;
  }

  /** Public sampler used by every other generator. */
  heightAt(x, z) { return this.height(x, z); }

  /** True inside (or within `margin` of) any building footprint. */
  insideBuilding(x, z, margin = 0) {
    for (const f of this.footprints) {
      const dx = x - f.cx, dz = z - f.cz;
      const lx = dx * f.cos - dz * f.sin;
      const lz = dx * f.sin + dz * f.cos;
      if (Math.abs(lx) < f.hw + margin && Math.abs(lz) < f.hd + margin) return true;
    }
    return false;
  }

  /** Distant silhouette: dunes and ridges beyond the playable bowl. */
  farHeight(x, z) {
    const r = Math.hypot(x, z);
    const t = smoothstep(MAP.terrainHalf - 8, MAP.terrainHalf + 90, r);
    const dune = ridge2(x * 0.0032, z * 0.0032, 4, 301) * 26 + 10;
    const rough = fbm2(x * 0.011, z * 0.011, 3, 2.1, 0.5, 77) * 4.5;
    const rim = smoothstep(0, MAP.terrainHalf * 0.6, r) * 2.0;
    return lerp(this.baseHeight(x, z), Math.max(-4, dune + rough), t) + rim * t;
  }

  /* ---------------------------------------------------------------- */
  /* meshes                                                            */
  /* ---------------------------------------------------------------- */

  build(batcher) {
    const world = this.world;
    const half = MAP.terrainHalf;
    const step = this.game.settings?.preset === 'low' ? 1.9 : 1.3;

    /* --- playable ground ------------------------------------------- */
    const ground = heightfieldGeo(-half, -half, half, half, step,
      (x, z) => this.height(x, z), 1);
    this._paintGround(ground);
    const groundMesh = new THREE.Mesh(ground, world.mat('sand', { tiling: 1, triplanar: false }));
    groundMesh.name = 'terrain.ground';
    groundMesh.receiveShadow = true;
    groundMesh.castShadow = false;
    groundMesh.matrixAutoUpdate = false;
    world.root.add(groundMesh);
    this.game.physics?.addStatic?.(groundMesh, { surface: 'sand' });
    this.groundMesh = groundMesh;

    /* --- distant terrain ------------------------------------------- */
    const far = this._farRing(half - 4, MAP.farRadius);
    ensureColor(far);
    // Background only: no macro variation, no detail normal, no parallax.
    // It covers a third of the screen and none of that detail survives 200 m.
    const farMesh = new THREE.Mesh(far, world.mat('dirt', {
      tiling: 0.35, key: 'far', macro: 0, detailStrength: 0, parallax: 0,
    }));
    farMesh.name = 'terrain.far';
    farMesh.receiveShadow = false;
    farMesh.castShadow = false;
    farMesh.matrixAutoUpdate = false;
    world.root.add(farMesh);

    /* --- roads ------------------------------------------------------ */
    for (const r of ROADS) this._road(batcher, r);

    /* --- kerbs and sidewalks ---------------------------------------- */
    for (const r of ROADS) if (r.kerb) this._kerbs(batcher, r);

    return this;
  }

  /**
   * Ground value.
   *
   * One sand material stretched over 190 m is the flattest thing in the level:
   * every square metre sits at the same brightness, so the eye reads it as
   * paper. This breaks it into large patches of bleached sand and darker
   * gravelly ground, then lays a cooler, dirtier apron either side of every
   * carriageway where the traffic drags grit off the asphalt. It costs one
   * float3 per vertex on a grid that is already built.
   */
  _paintGround(geo) {
    const col = ensureColor(geo);
    const pos = geo.attributes.position;
    const arr = col.array;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      // Two scales: broad drifts, then a finer break so the patches have edges.
      const broad = fbm2(x * 0.021, z * 0.021, 3, 2.07, 0.5, 41);
      const fine = fbm2(x * 0.115, z * 0.115, 2, 2.0, 0.5, 613);
      const patch = clamp(broad * 0.78 + fine * 0.22, 0, 1);
      let v = lerp(0.68, 1.16, patch);
      let r = v, g = v * (0.96 + 0.06 * patch), b = v * (0.88 + 0.14 * patch);

      const road = this.roadAt(x, z);
      if (road) {
        // Grit and oil either side of the carriageway: darker and much cooler.
        const k = road.w * road.w * 0.62;
        r *= 1 - 0.34 * k; g *= 1 - 0.30 * k; b *= 1 - 0.16 * k;
      }
      const o = i * 3;
      arr[o] = r; arr[o + 1] = g; arr[o + 2] = b;
    }
    col.needsUpdate = true;
    return geo;
  }

  _farRing(r0, r1) {
    const radial = 72;
    const rings = 22;
    const verts = (radial + 1) * (rings + 1);
    const pos = new Float32Array(verts * 3);
    const nor = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    let p = 0;
    for (let j = 0; j <= rings; j++) {
      const f = j / rings;
      const rad = r0 * Math.pow(r1 / r0, f);
      for (let i = 0; i <= radial; i++) {
        const a = (i / radial) * Math.PI * 2;
        const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
        const y = j === 0 ? this.height(x, z) : this.farHeight(x, z);
        pos[p * 3] = x; pos[p * 3 + 1] = y; pos[p * 3 + 2] = z;
        const h = Math.max(2, rad * 0.02);
        const gx = (this.farHeight(x + h, z) - this.farHeight(x - h, z)) / (2 * h);
        const gz = (this.farHeight(x, z + h) - this.farHeight(x, z - h)) / (2 * h);
        const inv = 1 / Math.sqrt(gx * gx + gz * gz + 1);
        nor[p * 3] = -gx * inv; nor[p * 3 + 1] = inv; nor[p * 3 + 2] = -gz * inv;
        uv[p * 2] = x * 0.5; uv[p * 2 + 1] = z * 0.5;
        p++;
      }
    }
    // `b` steps around the ring and `c` steps outward: (a,b,c) faces up.
    const idx = new Uint32Array(radial * rings * 6);
    let k = 0;
    for (let j = 0; j < rings; j++) {
      for (let i = 0; i < radial; i++) {
        const a = j * (radial + 1) + i, b = a + 1;
        const c = a + radial + 1, d = c + 1;
        idx[k++] = a; idx[k++] = b; idx[k++] = c;
        idx[k++] = b; idx[k++] = d; idx[k++] = c;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    return g;
  }

  /** A road ribbon: a strip that follows the channel cut into the terrain. */
  _road(batcher, r) {
    const ax = r.a[0], az = r.a[1], bx = r.b[0], bz = r.b[1];
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    const ux = dx / len, uz = dz / len;
    const nx = -uz, nz = ux;
    const along = Math.max(2, Math.round(len / 2.2));
    const across = 8;
    const w = r.w;

    const verts = (along + 1) * (across + 1);
    const pos = new Float32Array(verts * 3);
    const nor = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    const rgb = new Float32Array(verts * 3);
    const asphalt = r.kind === 'asphalt';
    let p = 0;
    for (let j = 0; j <= along; j++) {
      const t = j / along;
      for (let i = 0; i <= across; i++) {
        const s = (i / across - 0.5) * 2 * w;
        const x = ax + dx * t + nx * s;
        const z = az + dz * t + nz * s;
        const y = this.height(x, z) + 0.035;
        pos[p * 3] = x; pos[p * 3 + 1] = y; pos[p * 3 + 2] = z;
        const h = 0.6;
        const gx = (this.height(x + h, z) - this.height(x - h, z)) / (2 * h);
        const gz = (this.height(x, z + h) - this.height(x, z - h)) / (2 * h);
        const inv = 1 / Math.sqrt(gx * gx + gz * gz + 1);
        nor[p * 3] = -gx * inv; nor[p * 3 + 1] = inv; nor[p * 3 + 2] = -gz * inv;
        uv[p * 2] = s; uv[p * 2 + 1] = t * len;

        // The road is the darkest value in the level and the sand is nearly the
        // brightest — that contrast is what makes the street plan legible at a
        // glance. It is only believable if the transition is not a hard line, so
        // the outer eighth of the carriageway lifts steeply toward sand as the
        // drift creeps over the edge, and the two wheel tracks polish down.
        const across01 = Math.abs(s) / w;
        const drift = smoothstep(0.74, 1.0, across01);
        const rut = Math.exp(-((across01 - 0.46) ** 2) * 26) * 0.18;
        const grain = fbm2(x * 0.16, z * 0.16, 2, 2.0, 0.5, 907);
        let v = asphalt ? 0.60 + 0.30 * grain - rut : 0.86 + 0.30 * grain;
        v *= 1 + drift * (asphalt ? 5.4 : 0.55);
        rgb[p * 3] = v * (asphalt ? 1.0 + drift * 0.16 : 1.04);
        rgb[p * 3 + 1] = v * (asphalt ? 1.0 + drift * 0.04 : 0.98);
        rgb[p * 3 + 2] = v * (asphalt ? 1.02 - drift * 0.24 : 0.88);
        p++;
      }
    }
    // Winding note: `b` steps across the carriageway and `c` steps along it, so
    // the front face is (a,b,c). The transposed order the terrain grid uses
    // would point the road at the ground and cull it away completely.
    const idx = new Uint32Array(along * across * 6);
    let k = 0;
    for (let j = 0; j < along; j++) {
      for (let i = 0; i < across; i++) {
        const a = j * (across + 1) + i, b = a + 1;
        const c = a + across + 1, d = c + 1;
        idx[k++] = a; idx[k++] = b; idx[k++] = c;
        idx[k++] = b; idx[k++] = d; idx[k++] = c;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));

    batcher.add(g, null, {
      mat: asphalt ? 'asphalt' : 'dirt',
      surface: asphalt ? 'concrete' : 'dirt',
      cast: false, receive: true, collide: true,
      chunk: `road-${r.id}`,
      paint: false,          // the ribbon carries its own hand-authored colour
    });
    g.dispose();
  }

  /**
   * Kerb stones and the sidewalk slab behind them. Laid as discrete blocks with
   * per-stone jitter and the occasional missing or sunken piece — a continuous
   * extrusion reads as a CAD model from ten metres away.
   */
  _kerbs(batcher, r) {
    const rng = this.world.rng.fork(r.id.length * 31 + r.a[0]);
    const ax = r.a[0], az = r.a[1], bx = r.b[0], bz = r.b[1];
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    const ux = dx / len, uz = dz / len;
    const nx = -uz, nz = ux;
    const yaw = Math.atan2(ux, uz);
    const stone = 1.6;
    const count = Math.floor(len / stone);

    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < count; i++) {
        const t = (i + 0.5) * stone;
        // Height comes off the carriageway, not off the sand behind the kerb:
        // a kerb line that follows local terrain noise reads as a broken pavement.
        const roadY = this.height(ax + ux * t, az + uz * t);
        const off = r.w + 0.16 + rng.range(-0.03, 0.03);
        const x = ax + ux * t + nx * off * side;
        const z = az + uz * t + nz * off * side;
        if (Math.abs(x) > MAP.terrainHalf - 3 || Math.abs(z) > MAP.terrainHalf - 3) continue;
        if (this.insideBuilding(x, z, 0.4)) continue;
        if (rng.chance(0.05)) continue;                       // missing stone
        const sunk = rng.chance(0.12) ? rng.range(0.04, 0.10) : 0;
        const h = 0.42;
        // The kerb is the brightest thing at ground level and the pavement
        // behind it sits a stop down, so the line between road and footway reads
        // from the far end of the boulevard. Per-stone value jitter stops the
        // run from looking extruded.
        const jitter = rng.range(-0.09, 0.09);
        batcher.add(
          bevelBox(0.30, h, stone * rng.range(0.93, 0.99), 0.022,
            { uvOffset: [x, 0, z] }),
          trs(x, roadY + 0.15 - h * 0.5 - sunk, z, yaw + rng.range(-0.02, 0.02)),
          {
            mat: 'concrete', surface: 'concrete', cast: true, receive: true,
            tint: [1.20 + jitter, 1.15 + jitter, 1.04 + jitter],
            groundY: roadY + 0.15,
          },
        );

        // sidewalk slab, flush with the top of the kerb
        const sx = x + nx * side * 1.25;
        const sz = z + nz * side * 1.25;
        if (this.insideBuilding(sx, sz, 0.2)) continue;
        batcher.add(
          bevelBox(2.1, 0.5, stone * 0.98, 0.02, { uvOffset: [sx, 0, sz] }),
          trs(sx, roadY + 0.14 - 0.25 - sunk, sz, yaw + rng.range(-0.015, 0.015)),
          {
            mat: 'concrete', surface: 'concrete', cast: false, receive: true, tiling: 1,
            tint: [0.86 + jitter * 0.5, 0.84 + jitter * 0.5, 0.80 + jitter * 0.5],
            groundY: roadY + 0.14,
          },
        );
      }
    }
  }

  dispose() {
    this.groundMesh?.geometry?.dispose();
  }
}
