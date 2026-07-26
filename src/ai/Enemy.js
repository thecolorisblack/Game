import * as THREE from 'three';
import { CharacterInstance, WEAPON_MUZZLE } from './Character.js';
import { Animator } from './Animation.js';
import { BONE_INDEX, BIND_POSITION, EYE_HEIGHT } from './Skeleton.js';
import { runBehaviour, setState, STATE, Perception } from './Behaviour.js';
import { clamp, clamp01, lerp, smoothstep, damp, dampAngle, shortestAngle, Rand, TAU } from './Util.js';

/**
 * One hostile.
 *
 * Owns its capsule movement (through `physics.capsuleMove`, never a private
 * collider list), its animation state, its weapon and its hit zones. The brain
 * lives in Behaviour.js; this file is the body.
 */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();

/**
 * Muzzle position in the right hand's local space. The weapon is rigid-skinned
 * to `handR`, whose bind rotation is identity, so this is just the muzzle's
 * bind position relative to the wrist — and it therefore tracks recoil, aim and
 * reload automatically.
 */
const MUZZLE_LOCAL = new THREE.Vector3().copy(WEAPON_MUZZLE).sub(BIND_POSITION[BONE_INDEX.handR]);
const BORE_LOCAL = new THREE.Vector3(0, 0, -1);

/** Hit zones, rebuilt from bone world positions each frame. */
const ZONES = [
  ['head', 'head', 'head', 0.118, 2.10, 0.10],
  ['neck', 'neck', 'head', 0.085, 1.60, 0],
  ['chest', 'spine3', 'neck', 0.185, 1.15, 0],
  ['chest', 'spine2', 'spine3', 0.195, 1.10, 0],
  ['stomach', 'pelvis', 'spine2', 0.180, 1.00, 0],
  ['arms', 'upperArmR', 'lowerArmR', 0.078, 0.82, 0],
  ['arms', 'lowerArmR', 'handR', 0.068, 0.75, 0],
  ['arms', 'upperArmL', 'lowerArmL', 0.078, 0.82, 0],
  ['arms', 'lowerArmL', 'handL', 0.068, 0.75, 0],
  ['legs', 'thighR', 'shinR', 0.105, 0.85, 0],
  ['legs', 'shinR', 'footR', 0.085, 0.75, 0],
  ['legs', 'thighL', 'shinL', 0.105, 0.85, 0],
  ['legs', 'shinL', 'footL', 0.085, 0.75, 0],
].map(([part, a, b, radius, mult, extend]) => ({
  part, a: BONE_INDEX[a], b: BONE_INDEX[b], radius, mult, extend,
}));

/** Bones that get a ragdoll particle, in hierarchy order. */
const RAGDOLL_MAP = [
  { bone: 'pelvis', parent: -1, radius: 0.15, mass: 3.2 },
  { bone: 'spine2', parent: 0, radius: 0.15, mass: 2.6 },
  { bone: 'spine3', parent: 1, radius: 0.15, mass: 2.2 },
  { bone: 'neck', parent: 2, radius: 0.08, mass: 0.8 },
  { bone: 'head', parent: 3, radius: 0.12, mass: 1.4 },
  { bone: 'upperArmR', parent: 2, radius: 0.07, mass: 0.9 },
  { bone: 'lowerArmR', parent: 5, radius: 0.06, mass: 0.7 },
  { bone: 'handR', parent: 6, radius: 0.05, mass: 0.4 },
  { bone: 'upperArmL', parent: 2, radius: 0.07, mass: 0.9 },
  { bone: 'lowerArmL', parent: 8, radius: 0.06, mass: 0.7 },
  { bone: 'handL', parent: 9, radius: 0.05, mass: 0.4 },
  { bone: 'thighR', parent: 0, radius: 0.10, mass: 1.8 },
  { bone: 'shinR', parent: 11, radius: 0.08, mass: 1.2 },
  { bone: 'footR', parent: 12, radius: 0.07, mass: 0.5 },
  { bone: 'thighL', parent: 0, radius: 0.10, mass: 1.8 },
  { bone: 'shinL', parent: 14, radius: 0.08, mass: 1.2 },
  { bone: 'footL', parent: 15, radius: 0.07, mass: 0.5 },
].map((d) => ({ ...d, index: BONE_INDEX[d.bone] }));

export const ENEMY_WEAPON = {
  id: 'ak74m',
  name: 'Hostile Rifle',
  damage: 15,
  rpm: 620,
  muzzleScale: 0.30,
  flashScale: 0.30,
  tracerColor: 0xff8a3a,
  tracerColorHostile: 0xff6a2a,
  tracerSpeed: 620,
  tracerWidth: 0.030,
  tracerEvery: 2,
  range: 180,
  suppressed: false,
  magSize: 30,
  hostile: true,
};

let NEXT_ID = 1;

export class Enemy {
  constructor(ai, asset, opts = {}) {
    this.ai = ai;
    this.game = ai.game;
    this.id = NEXT_ID++;
    this.name = `hostile_${this.id}`;
    this.rand = new Rand(0x1000 + this.id * 2654435761);

    this.character = new CharacterInstance(asset, { scale: opts.scale ?? 1 });
    this.animator = new Animator(this.character, this.game);
    this.root = this.character.root;
    this.root.name = this.name;
    this.bones = this.character.rig.bones;

    // transform
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.targetYaw = 0;
    this.grounded = true;
    this.radius = 0.36;
    this.height = 1.82 * (opts.scale ?? 1);
    this.eyeHeight = EYE_HEIGHT * (opts.scale ?? 1);
    this.originIsCentre = false;

    // vitals
    this.maxHealth = opts.health ?? 100;
    this.health = this.maxHealth;
    this.alive = true;
    this.dead = false;
    this.armour = opts.armour ?? 0.18;

    // combat
    this.weapon = ENEMY_WEAPON;
    this.magSize = ENEMY_WEAPON.magSize;
    this.ammo = this.magSize;
    this.reserve = 240;
    this.reloading = false;
    this.reloadTimer = 0;
    this.fireTimer = 0;
    this.burstRemaining = 0;
    this.burstLength = 4;
    this.accuracyScale = 1;
    this.wantsToShoot = false;
    this.aimReady = 0;
    this.aimBlend = 0;
    this.shotsFired = 0;
    this.skill = clamp01(opts.skill ?? 0.55);

    // behaviour
    this.perception = new Perception(this);
    this.state = STATE.IDLE;
    this.prevState = STATE.IDLE;
    this.stateTime = 0;
    this.decisionTimer = 0;
    this.repathTimer = 0;
    this.awareness = 0;
    this.canSeePlayer = false;
    this.suppression = 0;
    this.morale = 1;
    this.alertness = 0;
    this.desiredSpeed = 0;
    this.desiredCrouch = 0;
    this.crouch = 0;
    this.aimAt = null;
    this.anchor = new THREE.Vector3();
    this.patrolTarget = null;
    this.flankTarget = null;
    this.flankSide = this.rand.bool() ? 1 : -1;
    this.coverPoint = null;

    // path
    this.path = null;
    this.pathIndex = 0;
    this.pathAge = 0;
    this.stuckTimer = 0;
    this.vaultTimer = 0;
    this._vaultDir = new THREE.Vector3();
    this._lastPos = new THREE.Vector3();

    // presentation
    this.lookTarget = null;
    this.lookWeight = 0;
    this.distanceToCamera = 0;
    this.visible = true;
    this.lodSkip = 0;
    this._animAccum = 0;

    // ragdoll
    this.ragdoll = null;
    this.ragdollBlend = 0;
    this.deathTime = 0;
    this._deathQuats = null;
    this.despawnTimer = 0;

    this.hitboxes = [];
    for (const z of ZONES) {
      this.hitboxes.push({
        part: z.part, multiplier: z.mult, radius: z.radius,
        center: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3(),
      });
    }
  }

  /* ================================================================ */
  /* lifecycle                                                         */
  /* ================================================================ */

  spawn(position, yaw = 0) {
    this.position.copy(position);
    this.anchor.copy(position);
    this.yaw = yaw;
    this.targetYaw = yaw;
    this.velocity.set(0, 0, 0);
    this.health = this.maxHealth;
    this.alive = true;
    this.dead = false;
    this.ammo = this.magSize;
    this.reloading = false;
    this.suppression = 0;
    this.awareness = 0;
    this.morale = 1;
    this.ragdoll = null;
    this.ragdollBlend = 0;
    this.animator.ragdollBlend = 0;
    this.animator.ikEnabled = true;
    this.path = null;
    this.moveGoal = null;
    this.vaultTimer = 0;
    this.scripted = null;
    this.scriptedNoDamage = false;
    this.coverPoint = null;
    this.state = STATE.IDLE;
    this.stateTime = 0;
    this.root.visible = true;
    this.character.mesh.castShadow = true;
    this._syncTransform();
    this._updateHitboxes(true);
    return this;
  }

  getEyePosition(out = new THREE.Vector3()) {
    return out.set(this.position.x, this.position.y + this.eyeHeight - this.crouch * 0.42, this.position.z);
  }

  /**
   * @param {THREE.Vector3[]|null} path
   * @param {THREE.Vector3} [goal] fallback destination used when pathfinding is
   *        budgeted out this frame — the agent steers straight at it rather
   *        than standing still waiting for a path.
   */
  setPath(path, goal) {
    if (goal) {
      this.moveGoal = this.moveGoal || new THREE.Vector3();
      this.moveGoal.copy(goal);
    }
    if (!path || !path.length) { this.path = null; return false; }
    this.path = path;
    this.pathIndex = 0;
    this.pathAge = 0;
    if (!goal) {
      this.moveGoal = this.moveGoal || new THREE.Vector3();
      this.moveGoal.copy(path[path.length - 1]);
    }
    return true;
  }

  takeCover(point, ctx) {
    if (this.coverPoint && this.coverPoint !== point) ctx.blackboard.release(this.coverPoint, this);
    if (!ctx.blackboard.claim(point, this)) return false;
    this.coverPoint = point;
    point.lastUsed = ctx.time;
    const path = ctx.nav?.findPath(this.position, point.position);
    if (path) this.setPath(path);
    // a short dive when the cover is close and we are under fire
    if (this.position.distanceTo(point.position) < 5 && this.suppression > 0.35
      && !this.animator.isPlaying('coverSlide')) {
      this.animator.play('coverSlide', { mask: 'all', fade: 0.1, priority: 1 });
    }
    return true;
  }

  /* ================================================================ */
  /* per frame                                                         */
  /* ================================================================ */

  update(dt, ctx) {
    if (!this.alive) { this._updateDead(dt); return; }

    const cam = this.game?.camera;
    if (cam) this.distanceToCamera = cam.position.distanceTo(this.position);

    this.perception.update(dt, ctx.time, this.game);
    this.awareness = this.perception.awareness;
    this.canSeePlayer = this.perception.canSee;
    if (this.canSeePlayer && this.game?.player) {
      ctx.blackboard.report(this.game.player.position, this.game.player.velocity, ctx.time,
        clamp01(this.perception.visibleFraction));
    }

    runBehaviour(this, dt, ctx);
    this._follow(dt, ctx);
    this._move(dt);
    this._face(dt, ctx);
    this._combat(dt, ctx);
    this._animate(dt, ctx);
    this._updateHitboxes(false);
  }

  /* ---------------------------------------------------------------- */
  /* movement                                                          */
  /* ---------------------------------------------------------------- */

  _follow(dt, ctx) {
    this._steer = this._steer || new THREE.Vector3();
    this._steer.set(0, 0, 0);
    if (!this.path || this.pathIndex >= this.path.length) {
      this.path = null;
      // no path (yet): head straight for the goal so the agent keeps its intent
      if (this.moveGoal && this.desiredSpeed > 0.2) {
        _v1.set(this.moveGoal.x - this.position.x, 0, this.moveGoal.z - this.position.z);
        const gd = _v1.length();
        if (gd > 1.0) this._steer.copy(_v1).multiplyScalar(1 / gd);
        else this.moveGoal = null;
      }
      return;
    }
    this.pathAge += dt;

    const wp = this.path[this.pathIndex];
    _v1.set(wp.x - this.position.x, 0, wp.z - this.position.z);
    const d = _v1.length();
    const arrive = this.pathIndex === this.path.length - 1 ? 0.55 : 0.95;
    if (d < arrive) {
      this.pathIndex++;
      if (this.pathIndex >= this.path.length) { this.path = null; return; }
      return;
    }
    _v1.multiplyScalar(1 / Math.max(1e-4, d));
    this._steer.copy(_v1);

    // look ahead one waypoint so corners are rounded instead of clipped
    if (this.pathIndex + 1 < this.path.length && d < 2.6) {
      const nx = this.path[this.pathIndex + 1];
      _v2.set(nx.x - this.position.x, 0, nx.z - this.position.z).normalize();
      this._steer.lerp(_v2, 1 - d / 2.6).normalize();
    }
    void ctx;
  }

  /** Separation so squadmates do not stack up in a doorway. */
  _separate(list) {
    _v3.set(0, 0, 0);
    let n = 0;
    for (const other of list) {
      if (other === this || !other.alive) continue;
      _v2.set(this.position.x - other.position.x, 0, this.position.z - other.position.z);
      const d2 = _v2.lengthSq();
      if (d2 > 2.9 * 2.9 || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      _v2.multiplyScalar((1 / d) * (1 - d / 2.9));
      _v3.add(_v2);
      n++;
    }
    if (n) _v3.multiplyScalar(1.35 / n);
    return _v3;
  }

  _move(dt) {
    const physics = this.game?.physics;
    const speed = this.desiredSpeed * lerp(1, 0.55, this.crouch);
    const steer = this._steer || _v1.set(0, 0, 0);

    _v4.copy(steer).multiplyScalar(speed);
    const sep = this._separate(this.ai.enemies);
    _v4.addScaledVector(sep, Math.min(2.2, speed + 0.8));

    // horizontal acceleration
    const accel = speed > 0.1 ? 16 : 22;
    this.velocity.x = damp(this.velocity.x, _v4.x, accel * 0.5, dt);
    this.velocity.z = damp(this.velocity.z, _v4.z, accel * 0.5, dt);
    this.velocity.y -= 19 * dt;

    _v2.set(this.velocity.x * dt, this.velocity.y * dt, this.velocity.z * dt);
    const height = lerp(this.height, this.height * 0.66, this.crouch);

    if (physics?.capsuleMove) {
      const res = physics.capsuleMove(this.position, _v2, this.radius, height, {
        stepUp: true, snapToGround: true, wasGrounded: this.grounded, slopeLimit: 0.72,
      });
      const moved = _v3.copy(res.position).sub(this.position);
      this.position.copy(res.position);
      this.grounded = res.grounded;
      if (res.grounded && this.velocity.y < 0) this.velocity.y = 0;
      if (res.hitWall) {
        // slide response already happened; kill the component into the wall so
        // we do not grind and so the stuck detector reads honestly
        const n = res.wallNormal;
        if (n) {
          const dot = this.velocity.x * n.x + this.velocity.z * n.z;
          if (dot < 0) { this.velocity.x -= n.x * dot; this.velocity.z -= n.z * dot; }
        }
      }
      void moved;
    } else {
      this.position.addScaledVector(_v2, 1);
      const g = this.game?.world?.heightAt?.(this.position.x, this.position.z) ?? 0;
      if (this.position.y <= g) { this.position.y = g; this.velocity.y = 0; this.grounded = true; }
    }

    // stuck detection: vault it if it is low, repath if it is not
    if (this.desiredSpeed > 0.5 && (this.path || this.moveGoal)) {
      // "stuck" is relative to what we asked for: a crouch-walker is not stuck
      const travelled = this.position.distanceTo(this._lastPos);
      const expected = this.desiredSpeed * lerp(1, 0.55, this.crouch) * dt;
      this.stuckTimer = travelled < expected * 0.3 ? this.stuckTimer + dt : 0;
      if (this.stuckTimer > 0.30 && this.vaultTimer <= 0 && this._tryVault()) {
        this.stuckTimer = 0;
      } else if (this.stuckTimer > 0.75) {
        this.stuckTimer = 0;
        this.repathTimer = 0;
        this.path = null;
      }
    } else this.stuckTimer = 0;

    if (this.vaultTimer > 0) {
      this.vaultTimer -= dt;
      // carry the agent over the obstacle: the clip supplies the body, this
      // supplies the trajectory
      this.velocity.x += this._vaultDir.x * 17 * dt;
      this.velocity.z += this._vaultDir.z * 17 * dt;
    }
    this._lastPos.copy(this.position);

    this.crouch = damp(this.crouch, clamp01(this.desiredCrouch), 6, dt);
  }

  /**
   * Waist-high obstacle in the way? Go over it. Blocked low and clear high is
   * exactly the signature of a wall, a jersey barrier or a market stall.
   */
  _tryVault() {
    const physics = this.game?.physics;
    if (!physics?.raycast || !this.grounded) return false;
    const steer = this._steer;
    if (!steer || steer.lengthSq() < 0.25) return false;

    _v1.set(this.position.x, this.position.y + 0.42, this.position.z);
    const low = physics.raycast(_v1, steer, 0.95, null);
    if (!low || low.distance > 0.85) return false;
    _v1.set(this.position.x, this.position.y + 1.32, this.position.z);
    const high = physics.raycast(_v1, steer, 1.35, null);
    if (high) return false;

    this._vaultDir = this._vaultDir || new THREE.Vector3();
    this._vaultDir.copy(steer).setY(0).normalize();
    this.vaultTimer = 0.55;
    this.velocity.y = 4.6;
    this.animator.play('vault', { mask: 'all', fade: 0.07, priority: 3, speed: 1.05 });
    return true;
  }

  _face(dt, ctx) {
    const target = this.aimAt;
    let desired = this.targetYaw;
    if (target) {
      _v1.set(target.x - this.position.x, 0, target.z - this.position.z);
      if (_v1.lengthSq() > 1e-4) desired = Math.atan2(-_v1.x, -_v1.z);
    } else if (this.velocity.lengthSq() > 0.35) {
      desired = Math.atan2(-this.velocity.x, -this.velocity.z);
    }
    this.targetYaw = desired;
    const rate = target ? 7.5 : 5.0;
    this.yaw = dampAngle(this.yaw, desired, rate, dt);
    void ctx;
  }

  /* ---------------------------------------------------------------- */
  /* combat                                                            */
  /* ---------------------------------------------------------------- */

  _combat(dt, ctx) {
    const player = this.game?.player;
    this.fireTimer -= dt;

    if (this.reloading) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        this.reloading = false;
        const want = this.magSize - this.ammo;
        const take = Math.min(want, this.reserve);
        this.ammo += take;
        this.reserve -= take;
        if (this.reserve <= 0) this.reserve = 240;   // hostiles do not run dry
      }
      return;
    }
    if (this.ammo <= 0) { this._startReload(); return; }

    // aim convergence: how close the weapon is to the target line
    let aimError = Math.PI;
    if (this.aimAt) {
      const muzzle = this.getMuzzle(_v1, _v2);
      _v3.copy(this.aimAt);
      _v3.y += 1.0;
      _v3.sub(muzzle);
      const len = _v3.length() || 1;
      _v3.multiplyScalar(1 / len);
      aimError = Math.acos(clamp(_v3.dot(_v2), -1, 1));
    }
    this.aimReady = damp(this.aimReady, clamp01(1 - aimError / 0.30), 8, dt);
    this.aimBlend = damp(this.aimBlend, this.wantsToShoot || this.canSeePlayer ? 1 : this.alertness * 0.5, 5, dt);

    if (!this.wantsToShoot || !player) { this.burstRemaining = 0; return; }
    if (this.fireTimer > 0) return;

    if (this.burstRemaining <= 0) {
      this.burstRemaining = this.burstLength;
      this.fireTimer = 0;
      this._burstStart = ctx.time;
    }
    this._fire(ctx);
    this.burstRemaining--;
    if (this.burstRemaining <= 0) {
      const pause = lerp(1.35, 0.42, this.skill) * (0.7 + this.rand.next() * 0.9);
      this.fireTimer = pause;
      this.burstLength = this.state === STATE.SUPPRESS ? 6 + this.rand.int(0, 3) : 2 + this.rand.int(0, 3);
    } else {
      this.fireTimer = 60 / this.weapon.rpm;
    }
  }

  _startReload() {
    if (this.reloading) return;
    this.reloading = true;
    this.reloadTimer = 2.55;
    this.animator.play('reload', { mask: 'upper', fade: 0.14, priority: 1 });
    this.ai.emit('weapon:reload', { weapon: this.weapon, tactical: this.ammo > 0, enemy: this });
  }

  /** Muzzle world position (out) and bore direction (dirOut). */
  getMuzzle(out, dirOut) {
    const hand = this.bones[BONE_INDEX.handR];
    out.copy(MUZZLE_LOCAL).applyMatrix4(hand.matrixWorld);
    if (dirOut) {
      _q1.setFromRotationMatrix(hand.matrixWorld);
      dirOut.copy(BORE_LOCAL).applyQuaternion(_q1).normalize();
    }
    return out;
  }

  _fire(ctx) {
    const game = this.game;
    const player = game?.player;
    if (!player) return;
    this.ammo--;
    this.shotsFired++;

    const muzzle = this.getMuzzle(_v1, _v2);
    // aim at the centre of mass, with the error the difficulty model allows
    _v3.set(player.position.x, player.position.y + (player.eyeHeight ?? 1.6) * 0.60, player.position.z);
    const dist = muzzle.distanceTo(_v3);
    _v3.sub(muzzle).multiplyScalar(1 / Math.max(1e-4, dist));

    const firstShot = this.burstRemaining === this.burstLength;
    let sigma = lerp(0.055, 0.014, this.skill);
    sigma *= lerp(1, 2.1, clamp01(this.suppression));
    sigma *= lerp(1, 1.55, clamp01(dist / 45));
    sigma *= this.accuracyScale ? 1 / clamp(this.accuracyScale, 0.35, 2) : 1;
    sigma *= firstShot ? 0.75 : 1 + (this.burstLength - this.burstRemaining) * 0.10;
    sigma *= lerp(1.35, 1.0, clamp01(this.aimReady));
    if (player.velocity && player.velocity.lengthSq() > 9) sigma *= 1.25;

    // Gaussian-ish cone
    const a = this.rand.next() * TAU;
    const r = Math.abs(this.rand.next() + this.rand.next() - 1) * sigma * 3;
    _v4.set(Math.cos(a), Math.sin(a), 0);
    const dir = _v3.clone();
    // build a basis around the aim direction
    _v2.set(0, 1, 0);
    if (Math.abs(dir.y) > 0.94) _v2.set(1, 0, 0);
    const right = new THREE.Vector3().crossVectors(dir, _v2).normalize();
    const up = new THREE.Vector3().crossVectors(right, dir).normalize();
    dir.addScaledVector(right, _v4.x * r).addScaledVector(up, _v4.y * r).normalize();

    this.animator.kick(1);
    this.ai.onEnemyFire(this, muzzle, dir, dist);
  }

  /* ---------------------------------------------------------------- */
  /* damage                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * @param {number} amount
   * @param {Object} info {headshot, point, direction, part, weapon, source}
   */
  applyDamage(amount, info = {}) {
    if (!this.alive) return 0;
    // stamped so an echoing `damage:dealt` for the same hit is ignored
    this._damageFrame = this.ai.frame;
    this._damageAmount = amount;
    let dmg = Math.max(0, amount || 0);
    if (info.part && info.part !== 'head') dmg *= (1 - this.armour * (info.part === 'chest' ? 1 : 0.4));
    this.health -= dmg;
    this.suppression = Math.min(1.4, this.suppression + 0.5);
    this.awareness = 1.4;
    this.perception.awareness = 1.4;

    // knowing where it came from is the point of taking a hit
    if (info.point || info.direction) {
      const src = _v1.copy(this.position);
      if (info.direction) src.addScaledVector(info.direction, -12);
      this.ai.blackboard.report(this.game?.player?.position || src, null, this.ai.time, 0.55);
    }

    if (this.health <= 0) {
      this.kill(info);
      return dmg;
    }
    const region = info.part === 'head' ? 'head'
      : info.part === 'legs' ? 'legs'
        : info.part === 'arms' ? (info.point && info.point.x > this.position.x ? 'armR' : 'armL')
          : 'torso';
    this.animator.hitReact(region, clamp01(dmg / 40) * 0.7 + 0.35);
    if (this.state === STATE.IDLE || this.state === STATE.PATROL || this.state === STATE.ALERT) {
      setState(this, STATE.ENGAGE, this.ai.ctx);
    }
    return dmg;
  }

  damage(a, i) { return this.applyDamage(a, i); }
  takeDamage(a, i) { return this.applyDamage(a, i); }

  kill(info = {}) {
    if (!this.alive) return;
    this.alive = false;
    this.dead = true;
    this.health = 0;
    this.wantsToShoot = false;
    this.deathTime = 0;
    this.despawnTimer = 26;
    this.state = STATE.DEAD;
    this.ai.blackboard.release(this.coverPoint, this);
    this.coverPoint = null;
    this.path = null;
    this.character.mesh.castShadow = true;
    this._spawnRagdoll(info);
    this.ai.onEnemyKilled(this, info);
  }

  _spawnRagdoll(info) {
    const physics = this.game?.physics;
    this.root.updateMatrixWorld(true);
    // freeze the last animated pose so the blend has something to come from
    this._deathQuats = this.bones.map((b) => b.quaternion.clone());

    if (!physics?.createRagdoll) { this.animator.ikEnabled = false; return; }
    const defs = RAGDOLL_MAP.map((d) => ({
      name: d.bone,
      parent: d.parent,
      radius: d.radius,
      mass: d.mass,
      position: new THREE.Vector3().setFromMatrixPosition(this.bones[d.index].matrixWorld),
      velocity: _v1.copy(this.velocity).multiplyScalar(0.85).clone(),
    }));
    try {
      this.ragdoll = physics.createRagdoll(defs, {
        iterations: 7, damping: 0.992, friction: 0.7, selfCollide: true,
      });
    } catch (err) {
      this.ragdoll = null;
    }
    if (this.ragdoll && info.direction) {
      const impulse = _v2.copy(info.direction).normalize()
        .multiplyScalar(info.part === 'head' ? 4.2 : 2.6);
      impulse.y += 1.2;
      const point = info.point || this.getEyePosition(_v3);
      try { this.ragdoll.applyImpulse(point, impulse, 0.75); } catch (err) { /* ignore */ }
    }
    this.animator.ikEnabled = false;
  }

  _updateDead(dt) {
    this.despawnTimer -= dt;
    this.deathTime += dt;
    this.ragdollBlend = Math.min(1, this.ragdollBlend + dt / 0.16);
    this.animator.ragdollBlend = this.ragdollBlend;

    if (!this.ragdoll) {
      // no physics ragdoll available: collapse with a canned settle
      const t = clamp01(this.deathTime / 1.1);
      const fall = smoothstep(0, 1, t);
      this.root.position.y = this.position.y - fall * 0.05;
      this.root.rotation.z = fall * 0.9;
      return;
    }
    if (this.deathTime < 12) this._applyRagdollPose();
    if (this.despawnTimer <= 0) this.ai.retire(this);
  }

  /**
   * Drive the skeleton from the ragdoll's particles: the root follows the
   * pelvis, every mapped bone swings to point at its child particle, and the
   * whole thing is blended in from the last animated pose over ~0.16 s so the
   * body never snaps.
   */
  _applyRagdollPose() {
    const rd = this.ragdoll;
    if (!rd || rd.disposed) return;
    const blend = this.ragdollBlend;

    // root follows the pelvis particle
    const pelvis = rd.bones[0].position;
    _q1.copy(this.root.quaternion);
    _v1.copy(BIND_POSITION[BONE_INDEX.pelvis]).applyQuaternion(_q1).multiplyScalar(this.character.scale || 1);
    this.root.position.set(pelvis.x - _v1.x, pelvis.y - _v1.y, pelvis.z - _v1.z);
    this.root.updateMatrixWorld(true);

    for (let i = 0; i < RAGDOLL_MAP.length; i++) {
      const d = RAGDOLL_MAP[i];
      // find this particle's first child so we have a direction to aim along
      let childIdx = -1;
      for (let j = i + 1; j < RAGDOLL_MAP.length; j++) {
        if (RAGDOLL_MAP[j].parent === i) { childIdx = j; break; }
      }
      if (childIdx < 0) continue;
      const bone = this.bones[d.index];
      const childBone = this.bones[RAGDOLL_MAP[childIdx].index];
      _v1.setFromMatrixPosition(bone.matrixWorld);
      _v2.setFromMatrixPosition(childBone.matrixWorld).sub(_v1);
      _v3.copy(rd.bones[childIdx].position).sub(rd.bones[i].position);
      if (_v2.lengthSq() < 1e-8 || _v3.lengthSq() < 1e-8) continue;
      _v2.normalize(); _v3.normalize();
      if (_v2.dot(_v3) > 0.99999) continue;
      _q1.setFromUnitVectors(_v2, _v3);
      if (blend < 1) _q1.slerp(_IDENT, 1 - blend);
      // world rotation after the swing, back into the parent's frame
      const worldQ = _tmpQ2.setFromRotationMatrix(_tmpM.extractRotation(bone.matrixWorld));
      worldQ.premultiply(_q1);
      const parentQ = _tmpQ3.setFromRotationMatrix(_tmpM.extractRotation(bone.parent.matrixWorld)).invert();
      bone.quaternion.copy(parentQ).multiply(worldQ);
      bone.updateMatrixWorld(true);
    }
  }

  /* ---------------------------------------------------------------- */
  /* hit zones                                                         */
  /* ---------------------------------------------------------------- */

  _updateHitboxes(force) {
    if (!force && this.lodSkip > 1 && this.distanceToCamera > 45) return;
    for (let i = 0; i < ZONES.length; i++) {
      const z = ZONES[i];
      const hb = this.hitboxes[i];
      hb.a.setFromMatrixPosition(this.bones[z.a].matrixWorld);
      hb.b.setFromMatrixPosition(this.bones[z.b].matrixWorld);
      if (z.extend) {
        _v1.copy(hb.b).sub(hb.a);
        const l = _v1.length() || 1;
        hb.b.addScaledVector(_v1, z.extend / l);
      }
      hb.center.copy(hb.a).add(hb.b).multiplyScalar(0.5);
    }
  }

  /**
   * Ray against this enemy's capsule hit zones.
   * @returns {{distance, point, normal, part, multiplier}|null}
   */
  raycast(origin, dir, maxDist) {
    if (!this.alive && this.deathTime > 0.6) return null;
    let best = null;
    for (const hb of this.hitboxes) {
      const t = raySegment(origin, dir, hb.a, hb.b, hb.radius, maxDist);
      if (t === null) continue;
      if (!best || t.distance < best.distance) {
        best = { distance: t.distance, point: t.point, normal: t.normal, part: hb.part, multiplier: hb.multiplier };
      }
    }
    return best;
  }

  /* ---------------------------------------------------------------- */
  /* presentation                                                      */
  /* ---------------------------------------------------------------- */

  _syncTransform() {
    this.root.position.copy(this.position);
    this.root.rotation.set(0, this.yaw, 0);
  }

  _animate(dt, ctx) {
    this._syncTransform();

    // movement direction in the character's own frame
    const vx = this.velocity.x;
    const vz = this.velocity.z;
    const speed = Math.hypot(vx, vz);
    // +moveAngle means "moving to my left", which is what the blend tree wants
    let moveAngle = 0;
    if (speed > 0.05) moveAngle = shortestAngle(this.yaw, Math.atan2(-vx, -vz));

    // aim offsets relative to the body
    let aimYaw = 0;
    let aimPitch = 0;
    if (this.aimAt) {
      _v1.set(this.aimAt.x - this.position.x, 0, this.aimAt.z - this.position.z);
      const desired = Math.atan2(-_v1.x, -_v1.z);
      aimYaw = shortestAngle(this.yaw, desired);
      const dy = (this.aimAt.y + 1.0) - (this.position.y + this.eyeHeight);
      const flat = Math.hypot(this.aimAt.x - this.position.x, this.aimAt.z - this.position.z);
      aimPitch = Math.atan2(dy, Math.max(0.4, flat));
    }

    // head look-at: leads the aim when idle, follows the weapon when engaging
    let lookYaw = 0, lookPitch = 0, lookWeight = 0;
    const lookAt = this.lookTarget || (this.canSeePlayer ? this.game?.player?.position : null);
    if (lookAt && !this.aimAt) {
      _v1.set(lookAt.x - this.position.x, 0, lookAt.z - this.position.z);
      const desired = Math.atan2(-_v1.x, -_v1.z);
      lookYaw = shortestAngle(this.yaw, desired);
      const dy = (lookAt.y + 1.4) - (this.position.y + this.eyeHeight);
      lookPitch = Math.atan2(dy, Math.max(0.5, _v1.length()));
      lookWeight = clamp01(1 - Math.abs(lookYaw) / 1.6) * 0.9;
    }

    this.animator.setVelocity(this.velocity);
    this.animator.update(dt, {
      speed,
      moveAngle,
      crouch: this.crouch,
      alertness: clamp01(this.alertness + this.awareness * 0.5),
      aimYaw, aimPitch,
      lookYaw, lookPitch, lookWeight,
      aimBlend: this.aimBlend,
    });
    void ctx;
  }

  dispose() {
    this.ragdoll?.dispose?.();
    this.ragdoll = null;
    this.character.dispose();
  }
}

/* ------------------------------------------------------------------ */

const _IDENT = new THREE.Quaternion();
const _tmpQ2 = new THREE.Quaternion();
const _tmpQ3 = new THREE.Quaternion();
const _tmpM = new THREE.Matrix4();
const _rsA = new THREE.Vector3();
const _rsB = new THREE.Vector3();
const _rsC = new THREE.Vector3();

/**
 * Ray versus capsule (segment a-b with `radius`).
 * @returns {{distance, point, normal}|null}
 */
export function raySegment(origin, dir, a, b, radius, maxDist = 500) {
  _rsA.copy(b).sub(a);                     // segment direction
  _rsB.copy(origin).sub(a);
  const baba = _rsA.dot(_rsA);
  const bard = _rsA.dot(dir);
  const baoa = _rsA.dot(_rsB);
  const rdoa = dir.dot(_rsB);
  const oaoa = _rsB.dot(_rsB);
  const A = baba - bard * bard;
  const B = baba * rdoa - baoa * bard;
  const C = baba * oaoa - baoa * baoa - radius * radius * baba;
  let t = -1;
  if (Math.abs(A) > 1e-9) {
    const h = B * B - A * C;
    if (h >= 0) {
      const tt = (-B - Math.sqrt(h)) / A;
      const y = baoa + tt * bard;
      if (tt >= 0 && y >= 0 && y <= baba) t = tt;
    }
  }
  if (t < 0) {
    // caps
    for (const cap of [a, b]) {
      _rsC.copy(origin).sub(cap);
      const bb = _rsC.dot(dir);
      const cc = _rsC.dot(_rsC) - radius * radius;
      const h = bb * bb - cc;
      if (h < 0) continue;
      const tt = -bb - Math.sqrt(h);
      if (tt >= 0 && (t < 0 || tt < t)) t = tt;
    }
  }
  if (t < 0 || t > maxDist) return null;
  const point = new THREE.Vector3().copy(origin).addScaledVector(dir, t);
  // normal: from the closest point on the segment
  _rsB.copy(point).sub(a);
  const h2 = clamp(_rsB.dot(_rsA) / baba, 0, 1);
  const normal = new THREE.Vector3().copy(point).sub(_rsC.copy(a).addScaledVector(_rsA, h2));
  if (normal.lengthSq() < 1e-9) normal.copy(dir).negate();
  else normal.normalize();
  return { distance: t, point, normal };
}
