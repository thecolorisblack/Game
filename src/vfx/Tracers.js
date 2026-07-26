import * as THREE from 'three';
import { P } from './Profiles.js';
import { V, clamp } from './Util.js';

/**
 * Tracers.
 *
 * A tracer is a real object in flight, not an instant line: it leaves the
 * muzzle at ~380 m/s (fast enough to read as a bullet, slow enough that the eye
 * catches the travel), stretches along its velocity by a fixed world length,
 * and carries a hot core plus a dim, wide warm halo standing in for the heat
 * shimmer trailing the round. Only a fraction of rounds get one — the counter
 * lives here so every weapon inherits the same 1-in-N cadence.
 */
export class Tracers {
  constructor(game, layer, hazeLayer) {
    this.game = game;
    this.layer = layer;
    this.hazeLayer = hazeLayer || layer;
    this.counter = 0;
    this.every = 3;
    this.enabled = true;
  }

  /** True on rounds that should carry a tracer. */
  shouldTrace(force = false) {
    this.counter++;
    if (force) return true;
    return this.enabled && (this.counter % this.every) === 0;
  }

  /**
   * @param {Object} o
   *  origin     THREE.Vector3
   *  direction  THREE.Vector3 (normalised)
   *  distance   metres to travel before dying (defaults to 140)
   *  speed      m/s (defaults 380)
   *  length     stretched length in metres
   *  width      metres
   *  color      {r,g,b} multiplier
   */
  fire(o = {}) {
    const layer = this.layer;
    if (!layer || !o.origin || !o.direction) return;

    const dir = V.a.copy(o.direction);
    if (dir.lengthSq() < 1e-8) return;
    dir.normalize();

    const speed = o.speed ?? 380;
    const dist = clamp(o.distance ?? 140, 1.5, 400);
    const life = clamp(dist / speed, 0.008, 1.2);
    const len = o.length ?? clamp(speed * 0.0055, 0.9, 3.2);
    const width = o.width ?? 0.032;
    const c = o.color;
    const r = c?.r ?? 1, g = c?.g ?? 1, b = c?.b ?? 1;

    const px = o.origin.x, py = o.origin.y, pz = o.origin.z;
    const vx = dir.x * speed, vy = dir.y * speed, vz = dir.z * speed;

    // Core: hot, thin, world-stretched.
    layer.spawn(
      px, py, pz, vx, vy, vz, life,
      width, width * 0.75, 0, 0, 0.0, 0.02, len,
      r, g, b, 1, P.TRACER, 0, 0, 0.35, Math.random(),
    );
    // Halo: five times wider, a twentieth as bright, slightly shorter — reads
    // as the pressure/heat wake around the round.
    layer.spawn(
      px, py, pz, vx, vy, vz, life,
      width * 5.5, width * 4.0, 0, 0, 0.0, 0.02, len * 0.7,
      r * 0.55, g * 0.42, b * 0.30, 0.16, P.TRACER, 12, 0, 1.2, Math.random(),
    );
  }

  /**
   * A round cracking past the player: a very short, very fast streak offset to
   * the side, which is what sells `bullet:whizby` visually.
   */
  whizby(distance, camera) {
    if (!camera || !this.layer) return;
    const d = clamp(distance ?? 1.5, 0.3, 6);
    const forward = V.a.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const side = V.b.set(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = V.c.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const a = Math.random() * Math.PI * 2;
    const p = V.d.copy(camera.position)
      .addScaledVector(forward, 3.5)
      .addScaledVector(side, Math.cos(a) * d)
      .addScaledVector(up, Math.sin(a) * d);
    const speed = 320;
    this.layer.spawn(
      p.x, p.y, p.z,
      forward.x * speed, forward.y * speed, forward.z * speed, 0.05,
      0.028, 0.02, 0, 0, 0, 0.02, 1.6,
      1, 0.85, 0.6, 0.7, P.TRACER, 0, 0, 0.3, Math.random(),
    );
  }
}

export const TRACER_COLORS = {
  standard: new THREE.Color(1.0, 0.62, 0.22),
  green: new THREE.Color(0.35, 1.0, 0.35),
  red: new THREE.Color(1.0, 0.22, 0.14),
};
