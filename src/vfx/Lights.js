import * as THREE from 'three';
import { clamp } from './Util.js';

/**
 * Pooled flash lights.
 *
 * Lights are added to the scene **once, at boot, and never removed**: changing
 * the light count in a three.js scene invalidates every program that uses
 * lighting, and recompiling forty materials because somebody fired a rifle is
 * the single most visible hitch a web renderer can produce. Idle lights sit at
 * zero intensity with a tiny radius instead.
 *
 * Each entry runs a scripted intensity curve — muzzle flashes get a double
 * pulse (primary detonation, then the muzzle gases igniting), explosions get a
 * fast rise and a long exponential decay.
 */
export class LightPool {
  constructor(scene, count, { distance = 14, decay = 2, castShadow = false } = {}) {
    this.entries = [];
    this.scene = scene;
    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight(0xffffff, 0, distance, decay);
      light.castShadow = castShadow;
      light.visible = true;
      light.matrixAutoUpdate = true;
      light.userData.postfxIgnore = true;
      scene?.add(light);
      this.entries.push({
        light, active: false, age: 0, life: 0, peak: 0, shape: 0, seed: i * 0.37,
      });
    }
    this._cursor = 0;
  }

  /**
   * @param {THREE.Vector3} position
   * @param {number} intensity peak intensity (candela-ish; three's PointLight)
   * @param {number} life seconds
   * @param {THREE.Color|number} color
   * @param {number} shape 0 = double-pulse muzzle, 1 = explosion, 2 = spark ping
   * @param {number} distance falloff radius
   */
  flash(position, intensity, life, color, shape = 0, distance = 14) {
    const n = this.entries.length;
    if (!n) return null;
    let e = null;
    for (let i = 0; i < n; i++) {
      const c = this.entries[(this._cursor + i) % n];
      if (!c.active) { e = c; this._cursor = (this._cursor + i + 1) % n; break; }
    }
    if (!e) {
      // Steal the weakest: a new flash always beats a dying one.
      let weakest = this.entries[0];
      for (const c of this.entries) if (c.light.intensity < weakest.light.intensity) weakest = c;
      e = weakest;
    }
    e.active = true;
    e.age = 0;
    e.life = Math.max(0.01, life);
    e.peak = intensity;
    e.shape = shape;
    e.light.position.copy(position);
    e.light.distance = distance;
    if (color !== undefined && color !== null) {
      if (color.isColor) e.light.color.copy(color);
      else e.light.color.set(color);
    }
    e.light.intensity = intensity;
    return e;
  }

  update(dt) {
    for (const e of this.entries) {
      if (!e.active) continue;
      e.age += dt;
      const t = e.age / e.life;
      if (t >= 1) {
        e.active = false;
        e.light.intensity = 0;
        continue;
      }
      let k;
      if (e.shape === 0) {
        // Muzzle: instant peak, hard drop, secondary gas flare at ~35 %.
        k = Math.exp(-t * 7.5) * (1 + 0.55 * Math.exp(-Math.pow((t - 0.34) / 0.16, 2)));
      } else if (e.shape === 1) {
        // Explosion: 15 ms rise, long exponential tail.
        k = (t < 0.06 ? t / 0.06 : Math.exp(-(t - 0.06) * 4.2)) * (1 - t * 0.25);
      } else {
        k = Math.pow(1 - t, 2.2);
      }
      e.light.intensity = clamp(e.peak * k, 0, e.peak * 1.6);
    }
  }

  clear() {
    for (const e of this.entries) { e.active = false; e.light.intensity = 0; }
  }

  dispose() {
    for (const e of this.entries) {
      e.light.parent?.remove(e.light);
      e.light.dispose?.();
    }
    this.entries.length = 0;
  }
}
