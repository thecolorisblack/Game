/**
 * OPERATION BLACKOUT — minimap.
 *
 * The level's actual footprint, not a decorative squiggle: at boot it reads the
 * world layout (roads, building footprints, compound walls) and bakes a
 * top-down plate into an offscreen canvas once. Per frame that plate is drawn
 * rotated about the player, so the map turns under a fixed heading the way a
 * modern shooter's does, and only the live markers are re-drawn.
 *
 * Contacts follow the genre rule: hostiles appear as red chevrons *only* when
 * they fire un-suppressed, and decay over a few seconds.
 */

import { clamp, clamp01, rgba, COLOR } from './Style.js';
import { drawText } from './Type.js';
import { makeCanvas, ctx2d, chamferPath, cornerBrackets, diamondPath, glowDot } from './Draw.js';

const BAKE_PX = 768;
const WORLD_HALF = 84;        // metres covered by the baked plate, each side
const RANGE = 46;             // metres from the player to the map edge

export class Minimap {
  constructor(game) {
    this.game = game;
    this.plate = null;
    this.contacts = [];
    this.objectives = [];
    this.friendlies = [];
    this.ready = false;
    this.pulse = 0;
    this.zoom = 1;
    this._layout = null;
  }

  async init() {
    let layout = null;
    try {
      layout = await import('../world/Layout.js');
    } catch (err) {
      layout = null;
    }
    this._layout = layout;
    try {
      this.plate = this._bake(layout);
      this.ready = true;
    } catch (err) {
      console.warn('[HUD] minimap bake failed', err);
      this.ready = false;
    }
    this._collectObjectives(layout);
    this._collectFriendlies(layout);
    return this;
  }

  /* ------------------------------------------------------------------ */
  /* static plate                                                        */
  /* ------------------------------------------------------------------ */

  _bake(layout) {
    const c = makeCanvas(BAKE_PX, BAKE_PX);
    const g = ctx2d(c);
    const k = BAKE_PX / (WORLD_HALF * 2);
    const P = (v) => v * k + BAKE_PX * 0.5;

    g.clearRect(0, 0, BAKE_PX, BAKE_PX);

    // ground wash with a soft falloff to the map edge
    const wash = g.createRadialGradient(BAKE_PX / 2, BAKE_PX / 2, BAKE_PX * 0.14,
      BAKE_PX / 2, BAKE_PX / 2, BAKE_PX * 0.74);
    wash.addColorStop(0, 'rgba(26,32,36,0.94)');
    wash.addColorStop(0.72, 'rgba(19,24,28,0.90)');
    wash.addColorStop(1, 'rgba(11,15,18,0.76)');
    g.fillStyle = wash;
    g.fillRect(0, 0, BAKE_PX, BAKE_PX);

    const roads = layout?.ROADS || [];
    const buildings = layout?.BUILDINGS || this._fallbackBuildings();
    const walls = layout?.WALLS || [];
    const cover = layout?.COVER || [];
    const stalls = layout?.STALLS || [];

    // --- roads: a dark casing then a lighter carriageway ---------------
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const pass of [0, 1]) {
      for (const r of roads) {
        const dirt = r.kind === 'dirt';
        g.strokeStyle = pass === 0
          ? 'rgba(6,9,11,0.55)'
          : dirt ? 'rgba(96,84,64,0.30)' : 'rgba(122,134,142,0.26)';
        g.lineWidth = (r.w * 2 * k) + (pass === 0 ? 4 : 0);
        g.beginPath();
        g.moveTo(P(r.a[0]), P(r.a[1]));
        g.lineTo(P(r.b[0]), P(r.b[1]));
        g.stroke();
      }
    }
    // kerb hairlines
    for (const r of roads) {
      if (!r.kerb) continue;
      const dx = r.b[0] - r.a[0];
      const dz = r.b[1] - r.a[1];
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len;
      const nz = dx / len;
      g.strokeStyle = 'rgba(180,192,200,0.14)';
      g.lineWidth = 1;
      for (const sgn of [-1, 1]) {
        g.beginPath();
        g.moveTo(P(r.a[0] + nx * r.w * sgn), P(r.a[1] + nz * r.w * sgn));
        g.lineTo(P(r.b[0] + nx * r.w * sgn), P(r.b[1] + nz * r.w * sgn));
        g.stroke();
      }
    }

    // --- buildings -----------------------------------------------------
    for (const b of buildings) {
      const cx = P(b.cx);
      const cz = P(b.cz);
      const hw = (b.w * 0.5) * k;
      const hd = (b.d * 0.5) * k;
      const rot = (b.rot || 0) * Math.PI / 180;
      g.save();
      g.translate(cx, cz);
      g.rotate(rot);
      // drop
      g.fillStyle = 'rgba(0,0,0,0.42)';
      g.fillRect(-hw + 2.5, -hd + 2.5, hw * 2, hd * 2);
      // body: enterable volumes read lighter so players can see what they can
      // actually push into
      const grad = g.createLinearGradient(-hw, -hd, hw, hd);
      if (b.enterable) {
        grad.addColorStop(0, 'rgba(58,66,72,0.94)');
        grad.addColorStop(1, 'rgba(40,47,53,0.94)');
      } else {
        grad.addColorStop(0, 'rgba(30,36,41,0.95)');
        grad.addColorStop(1, 'rgba(20,25,29,0.95)');
      }
      g.fillStyle = grad;
      g.fillRect(-hw, -hd, hw * 2, hd * 2);
      g.strokeStyle = b.enterable ? 'rgba(190,205,214,0.34)' : 'rgba(150,166,176,0.20)';
      g.lineWidth = 1.4;
      g.strokeRect(-hw, -hd, hw * 2, hd * 2);
      // interior division hairlines for the bigger volumes
      if (b.enterable && hw > 24 && hd > 24) {
        g.strokeStyle = 'rgba(190,205,214,0.12)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(-hw, 0); g.lineTo(hw, 0);
        g.moveTo(0, -hd); g.lineTo(0, hd);
        g.stroke();
      }
      g.restore();
    }

    // --- free-standing walls -------------------------------------------
    g.strokeStyle = 'rgba(160,175,185,0.34)';
    g.lineWidth = 2.4;
    g.lineCap = 'square';
    for (const wl of walls) {
      const pts = wl.pts || [];
      if (pts.length < 2) continue;
      g.beginPath();
      g.moveTo(P(pts[0][0]), P(pts[0][1]));
      for (let i = 1; i < pts.length; i++) g.lineTo(P(pts[i][0]), P(pts[i][1]));
      g.stroke();
    }

    // --- cover + stalls: small ticks that give the map texture ----------
    g.fillStyle = 'rgba(150,164,174,0.24)';
    for (const cv of cover) {
      const size = 2.2 * k * 0.5;
      g.save();
      g.translate(P(cv.x), P(cv.z));
      g.rotate((cv.rot || 0) * Math.PI / 180);
      g.fillRect(-size, -size * 0.42, size * 2, size * 0.84);
      g.restore();
    }
    g.fillStyle = 'rgba(196,158,96,0.26)';
    for (const st of stalls) {
      g.save();
      g.translate(P(st.x), P(st.z));
      g.rotate((st.rot || 0) * Math.PI / 180);
      const sz = 1.6 * k;
      g.fillRect(-sz, -sz * 0.6, sz * 2, sz * 1.2);
      g.restore();
    }

    // --- playable boundary ---------------------------------------------
    const half = (layout?.MAP?.half ?? 70) * k;
    g.save();
    g.setLineDash([9, 7]);
    g.strokeStyle = 'rgba(232,181,98,0.24)';
    g.lineWidth = 2;
    g.strokeRect(BAKE_PX * 0.5 - half, BAKE_PX * 0.5 - half, half * 2, half * 2);
    g.restore();

    return c;
  }

  /** If the world module never loads we still want *something* structural. */
  _fallbackBuildings() {
    const interiors = this.game.world?.buildings?.interiors;
    if (!interiors?.length) return [];
    return interiors.map((it) => ({
      cx: it.centre?.x ?? 0,
      cz: it.centre?.z ?? 0,
      w: (it.halfW ?? 6) * 2,
      d: (it.halfD ?? 6) * 2,
      rot: (it.rot ?? 0) * 180 / Math.PI,
      enterable: true,
    }));
  }

  _collectObjectives(layout) {
    const pts = [];
    const spawns = this.game.world?.spawnPoints;
    if (spawns?.length) {
      const contest = spawns.filter((s) => s.role === 'contest');
      for (let i = 0; i < Math.min(3, contest.length); i++) {
        pts.push({ label: 'ABC'[i], x: contest[i].position.x, z: contest[i].position.z });
      }
    }
    if (!pts.length && layout?.SPAWNS) {
      const contest = layout.SPAWNS.filter((s) => s.role === 'contest');
      for (let i = 0; i < Math.min(3, contest.length); i++) {
        pts.push({ label: 'ABC'[i], x: contest[i].position[0], z: contest[i].position[2] });
      }
    }
    this.objectives = pts;
  }

  _collectFriendlies(layout) {
    const out = [];
    const spawns = this.game.world?.spawnPoints;
    const src = spawns?.length
      ? spawns.filter((s) => s.role === 'friendly').map((s) => ({ x: s.position.x, z: s.position.z }))
      : (layout?.SPAWNS || []).filter((s) => s.role === 'friendly').map((s) => ({ x: s.position[0], z: s.position[2] }));
    for (let i = 0; i < src.length; i++) {
      out.push({ x: src[i].x, z: src[i].z, phase: i * 1.7, yaw: 0 });
    }
    this.friendlies = out;
  }

  /* ------------------------------------------------------------------ */
  /* live contacts                                                       */
  /* ------------------------------------------------------------------ */

  addContact(position, yaw = 0, strong = true) {
    if (!position) return;
    for (const c of this.contacts) {
      if (Math.abs(c.x - position.x) < 2.2 && Math.abs(c.z - position.z) < 2.2) {
        c.t = 0;
        c.x = position.x;
        c.z = position.z;
        c.yaw = yaw;
        c.ping = Math.max(c.ping, strong ? 1 : 0.5);
        return;
      }
    }
    if (this.contacts.length > 16) this.contacts.shift();
    this.contacts.push({ x: position.x, z: position.z, yaw, t: 0, life: 3.4, ping: strong ? 1 : 0.5 });
  }

  update(dt, time) {
    for (let i = this.contacts.length - 1; i >= 0; i--) {
      const c = this.contacts[i];
      c.t += dt;
      c.ping = Math.max(0, c.ping - dt * 1.6);
      if (c.t > c.life) this.contacts.splice(i, 1);
    }
    this.pulse = (this.pulse + dt * 0.55) % 1;
    // friendlies drift slightly so the squad never reads as frozen pins
    const t = time || 0;
    for (const f of this.friendlies) {
      f.dx = Math.sin(t * 0.23 + f.phase) * 2.6;
      f.dz = Math.cos(t * 0.19 + f.phase * 1.7) * 2.6;
      f.yaw = Math.atan2(-Math.cos(t * 0.19 + f.phase * 1.7), -Math.sin(t * 0.23 + f.phase));
    }
  }

  /* ------------------------------------------------------------------ */
  /* draw                                                                */
  /* ------------------------------------------------------------------ */

  draw(ctx, view) {
    const s = view.scale;
    const size = Math.round(clamp(196 * s, 130, 300));
    const x = view.pad;
    const y = view.pad;
    const cx = x + size * 0.5;
    const cy = y + size * 0.5;
    const cham = 12 * s;

    const player = this.game.player;
    const px = player?.position?.x ?? 0;
    const pz = player?.position?.z ?? 0;
    const yaw = this.game.camera ? this.game.camera.rotation.y : (player?.yaw ?? 0);
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const ppm = (size * 0.5) / RANGE;

    const toScreen = (wx, wz, out) => {
      const dx = wx - px;
      const dz = wz - pz;
      out[0] = cx + (dx * cosY - dz * sinY) * ppm;
      out[1] = cy + (dx * sinY + dz * cosY) * ppm;
      return out;
    };
    const _p = [0, 0];

    ctx.save();

    // --- plate + frame -------------------------------------------------
    chamferPath(ctx, x, y, size, size, cham);
    ctx.fillStyle = 'rgba(4,7,10,0.72)';
    ctx.fill();

    ctx.save();
    chamferPath(ctx, x, y, size, size, cham);
    ctx.clip();

    if (this.plate) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(yaw);
      const span = WORLD_HALF * 2 * ppm;
      ctx.drawImage(this.plate, -px * ppm - span * 0.5, -pz * ppm - span * 0.5, span, span);
      ctx.restore();
    }

    // grid overlay, rotating with the map
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(yaw);
    ctx.strokeStyle = 'rgba(140,158,170,0.075)';
    ctx.lineWidth = 1;
    const grid = 10 * ppm;
    const gx = -((px * ppm) % grid);
    const gz = -((pz * ppm) % grid);
    const reach = size * 0.78;
    ctx.beginPath();
    for (let i = -Math.ceil(reach / grid); i <= Math.ceil(reach / grid); i++) {
      ctx.moveTo(gx + i * grid, -reach); ctx.lineTo(gx + i * grid, reach);
      ctx.moveTo(-reach, gz + i * grid); ctx.lineTo(reach, gz + i * grid);
    }
    ctx.stroke();
    ctx.restore();

    // --- objectives ----------------------------------------------------
    const objPulse = 0.5 + 0.5 * Math.sin(this.pulse * Math.PI * 2);
    for (const o of this.objectives) {
      toScreen(o.x, o.z, _p);
      const clamped = this._clampToPlate(_p, cx, cy, size * 0.5 - 9 * s);
      const r = 7 * s;
      ctx.globalAlpha = clamped ? 0.55 : 1;
      diamondPath(ctx, _p[0], _p[1], r + objPulse * 2 * s);
      ctx.fillStyle = rgba(COLOR.accent, 0.20);
      ctx.fill();
      ctx.strokeStyle = rgba(COLOR.accent, 0.95);
      ctx.lineWidth = Math.max(1, 1.4 * s);
      ctx.stroke();
      drawText(ctx, o.label, _p[0], _p[1] + 3.4 * s, {
        size: 9 * s, weight: 0.2, tracking: 0, align: 'center',
        color: rgba(COLOR.accentHot, 1), halo: false,
      });
      ctx.globalAlpha = 1;
    }

    // --- friendlies ----------------------------------------------------
    for (const f of this.friendlies) {
      toScreen(f.x + (f.dx || 0), f.z + (f.dz || 0), _p);
      if (this._clampToPlate(_p, cx, cy, size * 0.5 - 7 * s)) continue;
      // world facing -> screen: the plate is already rotated by `yaw`, so a
      // marker's own heading enters as the difference, not the sum.
      this._chevron(ctx, _p[0], _p[1], 5.4 * s, yaw - (f.yaw || 0), COLOR.friendly, 0.85);
    }

    // --- hostile contacts ----------------------------------------------
    for (const c of this.contacts) {
      const k = clamp01(c.t / c.life);
      const a = Math.pow(1 - k, 0.8);
      toScreen(c.x, c.z, _p);
      const off = this._clampToPlate(_p, cx, cy, size * 0.5 - 7 * s);
      if (c.ping > 0.02 && !off) {
        glowDot(ctx, _p[0], _p[1], 16 * s * (1 + (1 - c.ping) * 1.6), COLOR.hostile, c.ping * 0.5);
        ctx.strokeStyle = rgba(COLOR.hostile, c.ping * 0.5);
        ctx.lineWidth = Math.max(1, 1.2 * s);
        ctx.beginPath();
        ctx.arc(_p[0], _p[1], (1 - c.ping) * 22 * s + 4 * s, 0, Math.PI * 2);
        ctx.stroke();
      }
      this._chevron(ctx, _p[0], _p[1], 6.2 * s, yaw - (c.yaw || 0), COLOR.hostile, a * (off ? 0.5 : 1));
    }

    // --- the player ------------------------------------------------------
    // view cone
    const coneLen = 34 * s;
    const halfFov = ((this.game.camera?.fov ?? 70) * Math.PI / 180) * 0.5 * (this.game.camera?.aspect ?? 1.7);
    const cone = ctx.createRadialGradient(cx, cy, 2, cx, cy, coneLen);
    cone.addColorStop(0, rgba(COLOR.accent, 0.34));
    cone.addColorStop(1, rgba(COLOR.accent, 0));
    ctx.fillStyle = cone;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, coneLen, -Math.PI / 2 - halfFov * 0.5, -Math.PI / 2 + halfFov * 0.5);
    ctx.closePath();
    ctx.fill();

    this._chevron(ctx, cx, cy, 7.6 * s, 0, COLOR.accentHot, 1, true);

    ctx.restore(); // clip

    // --- frame furniture ---------------------------------------------
    chamferPath(ctx, x, y, size, size, cham);
    ctx.strokeStyle = rgba(COLOR.ink, 0.22);
    ctx.lineWidth = Math.max(1, 1.2 * s);
    ctx.stroke();
    cornerBrackets(ctx, x, y, size, size, 16 * s, Math.max(1.2, 1.8 * s), rgba(COLOR.accent, 0.75));

    // north pip rides the frame
    const nAng = -yaw - Math.PI / 2;
    const rad = size * 0.5 - 1;
    const nx = cx + Math.cos(nAng) * rad * 0.99;
    const ny = cy + Math.sin(nAng) * rad * 0.99;
    const nxc = clamp(nx, x + 10 * s, x + size - 10 * s);
    const nyc = clamp(ny, y + 10 * s, y + size - 10 * s);
    ctx.fillStyle = 'rgba(4,7,10,0.8)';
    ctx.beginPath();
    ctx.arc(nxc, nyc, 8 * s, 0, Math.PI * 2);
    ctx.fill();
    drawText(ctx, 'N', nxc, nyc + 3.6 * s, {
      size: 9.5 * s, weight: 0.18, tracking: 0, align: 'center', color: rgba(COLOR.ink, 0.95), halo: false,
    });

    // scale + grid reference
    drawText(ctx, `${RANGE * 2}M`, x + 6 * s, y + size - 6 * s, {
      size: 8 * s, weight: 0.16, tracking: 0.38, color: rgba(COLOR.inkFaint, 0.9), halo: 1.2,
    });
    const gridRef = `${String.fromCharCode(65 + clamp(Math.floor((px + 84) / 12), 0, 13))}${String(clamp(Math.floor((pz + 84) / 12), 0, 13)).padStart(2, '0')}`;
    drawText(ctx, gridRef, x + size - 6 * s, y + size - 6 * s, {
      size: 8 * s, weight: 0.16, tracking: 0.38, align: 'right',
      color: rgba(COLOR.accent, 0.75), halo: 1.2,
    });

    ctx.restore();
    this.rect = { x, y, size };
  }

  /** Push a point onto the plate edge; returns true if it was outside. */
  _clampToPlate(p, cx, cy, r) {
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    const d = Math.hypot(dx, dy);
    if (d <= r) return false;
    const k = r / (d || 1);
    p[0] = cx + dx * k;
    p[1] = cy + dy * k;
    return true;
  }

  _chevron(ctx, x, y, r, angle, color, alpha = 1, outline = false) {
    if (alpha <= 0.02) return;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r * 0.74, r * 0.72);
    ctx.lineTo(0, r * 0.30);
    ctx.lineTo(-r * 0.74, r * 0.72);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(2,4,6,0.8)';
    ctx.lineWidth = Math.max(1.1, r * 0.26);
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fill();
    if (outline) {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = Math.max(0.8, r * 0.12);
      ctx.stroke();
    }
    ctx.restore();
  }
}
