import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { clamp01, damp } from './Springs.js';

/**
 * Health, regeneration and stamina.
 *
 * Regen is the modern-shooter model: a flat delay after the last hit, then a
 * ramped heal that starts slow and accelerates, so surviving a fight at 8 HP
 * still feels dangerous for a couple of seconds. `criticality` and `windedness`
 * are published for the camera rig (breathing) and for the HUD/post chain to
 * drive a damage vignette without needing to know these numbers.
 */

const TUNE = {
  maxHealth: 100,
  regenDelay: 4.1,
  regenDelayCritical: 5.4,
  regenRate: 30,
  regenRamp: 1.5,        // seconds to reach full regen rate
  criticalThreshold: 34,

  maxStamina: 100,
  sprintDrain: 11.5,
  tacticalDrain: 26,
  staminaRegen: 19,
  staminaRegenDelay: 0.85,
  windedBelow: 42,
  sprintLockout: 14,     // must climb back above this before sprinting again

  deathRespawnDelay: 4.6,
};

export class Vitals {
  constructor(player) {
    this.player = player;
    this.game = player.game;
    this.tune = TUNE;

    this.maxHealth = TUNE.maxHealth;
    this.health = TUNE.maxHealth;
    this.stamina = TUNE.maxStamina;
    this.maxStamina = TUNE.maxStamina;

    this.alive = true;
    this.invulnerable = false;
    this.timeSinceDamage = 999;
    this.timeSinceStaminaUse = 999;
    this.regenActive = false;
    this.deathTimer = 0;
    this.lastDamageDir = new THREE.Vector3();
    this.lastDamageAmount = 0;
    this.totalDamageTaken = 0;

    // 0..1 smoothed presentation channels.
    this.criticality = 0;
    this.windedness = 0;
    this._staminaLocked = false;

    this._onDamageDealt = (e) => {
      if (!e || e.target !== this.player) return;
      this.damage(e.amount ?? 0, e.point || e.from || null, { headshot: !!e.headshot });
    };
    this._onExplosion = (e) => {
      if (!e || !e.position) return;
      this._explosion(e);
    };
  }

  init() {
    bus.on('damage:dealt', this._onDamageDealt);
    bus.on('explosion', this._onExplosion);
  }

  dispose() {
    bus.off('damage:dealt', this._onDamageDealt);
    bus.off('explosion', this._onExplosion);
  }

  /* ================================================================== */

  /**
   * @param {number} amount
   * @param {THREE.Vector3|{x,y,z}|null} from  world position the hit came from
   * @param {{type?:string, headshot?:boolean, noFlinch?:boolean}} [meta]
   */
  damage(amount, from, meta = null) {
    if (!this.alive || this.invulnerable) return 0;
    const dmg = Math.max(0, Number(amount) || 0);
    if (dmg <= 0) return 0;

    this.health = Math.max(0, this.health - dmg);
    this.timeSinceDamage = 0;
    this.regenActive = false;
    this.lastDamageAmount = dmg;
    this.totalDamageTaken += dmg;

    const p = this.player;
    if (from && from.x !== undefined) {
      this.lastDamageDir.set(from.x, from.y ?? p.position.y, from.z).sub(p.position);
      if (this.lastDamageDir.lengthSq() < 1e-8) this.lastDamageDir.set(0, 0, -1);
      else this.lastDamageDir.normalize();
    } else {
      this.lastDamageDir.set(0, 0, 0);
    }

    bus.emit('damage:taken', {
      amount: dmg,
      from: from ? new THREE.Vector3(from.x, from.y ?? p.position.y, from.z) : null,
      health: this.health,
      max: this.maxHealth,
      type: meta?.type || 'bullet',
    });

    if (!meta?.noFlinch) {
      p.rig?.damageFlinch?.(dmg / this.maxHealth, this.lastDamageDir, meta?.type);
    }

    if (this.health <= 0) this._die(from, meta);
    return dmg;
  }

  /** Aliases so no other agent has to guess the verb. */
  applyDamage(a, f, m) { return this.damage(a, f, m); }
  takeDamage(a, f, m) { return this.damage(a, f, m); }
  hurt(a, f, m) { return this.damage(a, f, m); }

  heal(amount) {
    if (!this.alive) return 0;
    const before = this.health;
    this.health = Math.min(this.maxHealth, this.health + Math.max(0, amount || 0));
    return this.health - before;
  }

  spendStamina(amount) {
    this.stamina = Math.max(0, this.stamina - Math.max(0, amount || 0));
    this.timeSinceStaminaUse = 0;
    if (this.stamina <= 0.5) this._staminaLocked = true;
  }

  get canSprint() {
    return this.alive && (!this._staminaLocked || this.stamina > TUNE.sprintLockout);
  }

  _explosion(e) {
    const p = this.player;
    const d = p.position.distanceTo(e.position);
    const radius = e.radius ?? 6;
    if (d > radius) return;
    const falloff = Math.pow(1 - d / radius, 1.4);
    const power = e.power ?? 14;

    // Knockback and shake are ours; the damage number belongs to whoever fired.
    const dir = new THREE.Vector3().subVectors(p.position, e.position);
    if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0); else dir.normalize();
    const shakeDir = dir.clone().negate();   // bias the view toward the blast
    dir.y = Math.max(dir.y, 0.35);
    p.movement?.addImpulse?.(dir.multiplyScalar(power * falloff * 0.42));

    p.rig?.addShake?.(0.55 * falloff + 0.15, 26, 0.45 + falloff * 0.35, shakeDir);
    p.rig?.concuss?.(falloff);
  }

  _die(from, meta) {
    if (!this.alive) return;
    this.alive = false;
    this.health = 0;
    this.deathTimer = 0;
    const p = this.player;
    p.stanceCtrl?.set?.('dead', true);
    p.rig?.death?.(this.lastDamageDir);
    bus.emit('player:died', {
      from: from ? new THREE.Vector3(from.x, from.y ?? p.position.y, from.z) : null,
      type: meta?.type || 'bullet',
    });
    bus.emit('camera:shake', { amplitude: 0.7, frequency: 12, duration: 0.9 });
    try { this.game?.setState?.('dead'); } catch { /* state machine owned elsewhere */ }
  }

  /* ================================================================== */

  /** Runs from Player.update so vitals keep ticking while dead/paused. */
  update(dt) {
    const d = Math.min(dt || 0, 0.1);
    if (d <= 0) return;

    if (!this.alive) {
      this.deathTimer += d;
      this.criticality = damp(this.criticality, 1, 3, d);
      if (this.deathTimer > TUNE.deathRespawnDelay && this.game?.state === 'dead') {
        this.player.respawn();
      }
      return;
    }

    this.timeSinceDamage += d;
    this.timeSinceStaminaUse += d;

    // --- health regen
    const critical = this.health < TUNE.criticalThreshold;
    const delay = critical ? TUNE.regenDelayCritical : TUNE.regenDelay;
    if (this.health < this.maxHealth && this.timeSinceDamage > delay) {
      this.regenActive = true;
      const ramp = clamp01((this.timeSinceDamage - delay) / TUNE.regenRamp);
      const rate = TUNE.regenRate * (0.35 + 0.65 * ramp * ramp);
      this.health = Math.min(this.maxHealth, this.health + rate * d);
    } else if (this.health >= this.maxHealth) {
      this.regenActive = false;
    }

    // --- stamina
    const mv = this.player.movement;
    const sprinting = !!mv?.sprinting;
    const tactical = !!mv?.tactical;
    if (sprinting && (mv?.horizontalSpeed ?? 0) > 1.5) {
      const drain = tactical ? TUNE.tacticalDrain : TUNE.sprintDrain;
      this.stamina = Math.max(0, this.stamina - drain * d);
      this.timeSinceStaminaUse = 0;
      if (this.stamina <= 0.5) this._staminaLocked = true;
    } else if (this.timeSinceStaminaUse > TUNE.staminaRegenDelay) {
      const ramp = clamp01((this.timeSinceStaminaUse - TUNE.staminaRegenDelay) / 1.2);
      this.stamina = Math.min(
        this.maxStamina, this.stamina + TUNE.staminaRegen * (0.5 + 0.5 * ramp) * d,
      );
      if (this.stamina > TUNE.sprintLockout) this._staminaLocked = false;
    }

    // --- presentation channels
    const critTarget = clamp01((TUNE.criticalThreshold - this.health) / TUNE.criticalThreshold);
    this.criticality = damp(this.criticality, critTarget, 4.5, d);

    const windTarget = clamp01((TUNE.windedBelow - this.stamina) / TUNE.windedBelow);
    // Breathing catches up fast when you stop and recovers slowly.
    this.windedness = damp(this.windedness, windTarget, windTarget > this.windedness ? 2.6 : 0.85, d);
  }

  reset() {
    this.health = this.maxHealth;
    this.stamina = this.maxStamina;
    this.alive = true;
    this.timeSinceDamage = 999;
    this.timeSinceStaminaUse = 999;
    this.regenActive = false;
    this.deathTimer = 0;
    this.criticality = 0;
    this.windedness = 0;
    this._staminaLocked = false;
    this.lastDamageDir.set(0, 0, 0);
  }
}

export { TUNE as VITALS_TUNING };
