import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep, damp, Rand, shortestAngle } from './Util.js';

/**
 * Perception, squad coordination and the combat state machine.
 *
 * The design goal is legible behaviour: at any moment a player should be able
 * to say "that one is suppressing me, that one is going wide". That comes from
 * three things — a shared blackboard that hands out one role at a time, cover
 * scored against where the player actually is, and a memory that decays instead
 * of snapping between omniscient and blind.
 */

export const STATE = {
  IDLE: 'idle',
  PATROL: 'patrol',
  ALERT: 'alert',
  ENGAGE: 'engage',
  FLANK: 'flank',
  SUPPRESS: 'suppress',
  REPOSITION: 'reposition',
  RETREAT: 'retreat',
  DEAD: 'dead',
};

/* ================================================================== */
/* squad blackboard                                                    */
/* ================================================================== */

export class Blackboard {
  constructor() {
    this.lastKnown = new THREE.Vector3();
    this.lastKnownVel = new THREE.Vector3();
    this.lastSeen = -999;
    this.confidence = 0;          // decays; 1 = someone has eyes on right now
    this.alert = 0;               // 0 unaware, 1 squad-wide contact
    this.contacts = 0;
    this.suppressor = null;
    this.flanker = null;
    this.claims = new Map();      // cover point -> enemy
    this.threatDir = new THREE.Vector3(0, 0, -1);
    this.lastRoleShuffle = -999;
    this.killCount = 0;
    this.time = 0;
  }

  /** Report a sighting. `quality` 1 = clear line of sight. */
  report(position, velocity, time, quality = 1) {
    if (quality >= this.confidence * 0.85 || time - this.lastSeen > 0.5) {
      this.lastKnown.copy(position);
      if (velocity) this.lastKnownVel.copy(velocity);
      this.lastSeen = time;
      this.confidence = Math.max(this.confidence, quality);
      this.alert = Math.min(1, this.alert + 0.55 * quality);
    }
  }

  /** A noise the squad heard but did not see. */
  reportNoise(position, time, weight = 0.5) {
    if (this.confidence > 0.6) return;
    this.lastKnown.copy(position);
    this.lastSeen = time;
    this.confidence = Math.max(this.confidence, weight * 0.5);
    this.alert = Math.min(1, this.alert + 0.35 * weight);
  }

  update(dt, time) {
    this.time = time;
    // memory of the player's position decays into a widening search area
    this.confidence = Math.max(0, this.confidence - dt * 0.22);
    if (this.confidence < 0.35) {
      // extrapolate along their last heading while the trail is warm
      this.lastKnown.addScaledVector(this.lastKnownVel, dt * this.confidence * 0.6);
    }
    if (time - this.lastSeen > 12) this.alert = Math.max(0, this.alert - dt * 0.12);
  }

  claim(point, enemy) {
    const owner = this.claims.get(point);
    if (owner && owner !== enemy && owner.alive) return false;
    this.claims.set(point, enemy);
    point.claimedBy = enemy;
    return true;
  }

  release(point, enemy) {
    if (!point) return;
    if (this.claims.get(point) === enemy) {
      this.claims.delete(point);
      point.claimedBy = null;
    }
  }

  /**
   * Hand out roles so the squad reads as a squad: one suppressor holds the
   * player down while one flanker moves. Everyone else fights from cover.
   */
  assignRoles(enemies, time) {
    if (time - this.lastRoleShuffle < 3.2) {
      if (this.suppressor && !this.suppressor.alive) this.suppressor = null;
      if (this.flanker && !this.flanker.alive) this.flanker = null;
      if (this.suppressor || this.flanker) return;
    }
    this.lastRoleShuffle = time;
    const live = enemies.filter((e) => e.alive && e.awareness > 0.6);
    if (live.length === 0) { this.suppressor = null; this.flanker = null; return; }

    // the one with the best current line on the player suppresses
    let bestS = null, bestSScore = -1;
    let bestF = null, bestFScore = -1;
    for (const e of live) {
      const d = e.position.distanceTo(this.lastKnown);
      const sScore = (e.canSeePlayer ? 2 : 0) + clamp01(1 - Math.abs(d - 18) / 22) + e.ammo / 30;
      if (sScore > bestSScore) { bestSScore = sScore; bestS = e; }
      const fScore = (e.canSeePlayer ? 0 : 1.2) + clamp01(d / 40) + (e.health / e.maxHealth) * 0.6;
      if (fScore > bestFScore) { bestFScore = fScore; bestF = e; }
    }
    this.suppressor = bestS;
    this.flanker = live.length > 1 && bestF !== bestS ? bestF : null;
  }
}

/* ================================================================== */
/* perception                                                          */
/* ================================================================== */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

export class Perception {
  constructor(enemy) {
    this.enemy = enemy;
    this.fov = Math.cos(55 * Math.PI / 180);   // half-angle cosine
    this.peripheral = Math.cos(85 * Math.PI / 180);
    this.range = 62;
    this.closeRange = 9;                       // always noticed inside this
    this.awareness = 0;
    this.canSee = false;
    this.lastSeeTime = -999;
    this.timeSinceCheck = Math.random() * 0.12;
    this.visibleFraction = 0;
  }

  /**
   * @returns {boolean} whether the enemy has line of sight to the player now
   */
  update(dt, time, game) {
    const e = this.enemy;
    this.timeSinceCheck -= dt;
    const player = game?.player;
    if (!player || player.vitals?.alive === false) {
      this.canSee = false;
      this.awareness = Math.max(0, this.awareness - dt * 0.5);
      return false;
    }

    if (this.timeSinceCheck <= 0) {
      this.timeSinceCheck = 0.11 + Math.random() * 0.06;
      this.canSee = this._test(game, player, time);
    }

    if (this.canSee) {
      this.lastSeeTime = time;
      const d = e.position.distanceTo(player.position);
      const rate = lerp(3.4, 1.0, clamp01(d / this.range)) * lerp(0.55, 1.0, this.visibleFraction);
      this.awareness = Math.min(1.4, this.awareness + dt * rate);
    } else {
      this.awareness = Math.max(0, this.awareness - dt * 0.28);
    }
    return this.canSee;
  }

  _test(game, player, time) {
    const e = this.enemy;
    e.getEyePosition(_v1);
    const pp = player.position;
    _v2.set(pp.x, pp.y + (player.eyeHeight ?? 1.6) * 0.62, pp.z);
    const to = _v3.copy(_v2).sub(_v1);
    const dist = to.length();
    if (dist > this.range) { this.visibleFraction = 0; return false; }
    to.multiplyScalar(1 / dist);

    // vision cone: full attention ahead, degraded peripherally, plus a bubble
    const fwdX = -Math.sin(e.yaw);
    const fwdZ = -Math.cos(e.yaw);
    const dot = to.x * fwdX + to.z * fwdZ;
    if (dist > this.closeRange) {
      if (dot < this.peripheral) { this.visibleFraction = 0; return false; }
    }

    const physics = game.physics;
    if (!physics?.lineOfSight) { this.visibleFraction = 1; return true; }

    let hits = 0;
    // chest, head and a hip sample: partial cover reads as partial visibility
    const samples = [
      [0, (player.eyeHeight ?? 1.6) * 0.62, 0],
      [0, (player.eyeHeight ?? 1.6) * 0.95, 0],
      [0, 0.35, 0],
    ];
    for (const s of samples) {
      _v2.set(pp.x + s[0], pp.y + s[1], pp.z + s[2]);
      if (physics.lineOfSight(_v1, _v2, null)) hits++;
    }
    this.visibleFraction = hits / samples.length;
    if (hits === 0) return false;
    // peripheral contacts need more of the target exposed to register
    if (dot < this.fov && dist > this.closeRange && this.visibleFraction < 0.67) return false;
    void time;
    return true;
  }
}

/* ================================================================== */
/* cover selection                                                     */
/* ================================================================== */

/**
 * Score cover points around `origin` against a threat.
 *
 * The winning point is not simply the safest: it has to be reachable, roughly
 * in the direction we want to fight from, and able to see the threat when the
 * agent leans out — cover with no firing position is a hiding spot, not cover.
 */
export function pickCover(nav, blackboard, enemy, threat, opts = {}) {
  if (!nav?.ready) return null;
  const radius = opts.radius ?? 16;
  const list = nav.coverNear(enemy.position, radius, enemy._coverScratch || (enemy._coverScratch = []));
  if (!list.length) return null;

  const idealMin = opts.idealMin ?? 8;
  const idealMax = opts.idealMax ?? 26;
  const forward = opts.forward || null;
  let best = null;
  let bestScore = -Infinity;

  for (const p of list) {
    if (p.claimedBy && p.claimedBy !== enemy && p.claimedBy.alive) continue;
    const quality = nav.coverQuality(p, threat);
    if (quality < 0.35) continue;

    const toThreat = p.position.distanceTo(threat);
    const travel = p.position.distanceTo(enemy.position);
    let score = quality * 3.2;
    score -= Math.abs(toThreat - clamp(toThreat, idealMin, idealMax)) * 0.11;
    score -= travel * 0.075;
    if (forward) {
      _v1.copy(p.position).sub(enemy.position);
      const l = _v1.length();
      if (l > 0.5) score += (_v1.dot(forward) / l) * (opts.forwardWeight ?? 1.4);
    }
    if (p === enemy.coverPoint) score += 1.1;              // hysteresis: do not thrash
    if (blackboard.time - p.lastUsed < 6) score -= 0.8;
    // a shallow height advantage is worth a lot in a firefight
    score += clamp((p.position.y - threat.y) * 0.35, -0.6, 1.0);

    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

/* ================================================================== */
/* state machine                                                       */
/* ================================================================== */

const rand = new Rand(0xB33F);

/**
 * One tick of the combat brain. Deliberately flat: every state is a small
 * function of the blackboard, perception and a couple of timers, so the whole
 * thing can be read top to bottom.
 */
export function runBehaviour(e, dt, ctx) {
  const { nav, blackboard, game, time } = ctx;
  e.stateTime += dt;
  e.fireTimer -= dt;
  e.repathTimer -= dt;
  e.decisionTimer -= dt;

  const player = game?.player;
  const playerAlive = !!player && player.vitals?.alive !== false;
  const threat = blackboard.lastKnown;
  const distToThreat = playerAlive ? e.position.distanceTo(threat) : Infinity;

  // suppression decays; being shot at pins you down
  e.suppression = Math.max(0, e.suppression - dt * 0.55);
  e.morale = damp(e.morale, e.health / e.maxHealth, 0.6, dt);

  switch (e.state) {
    /* ---------------------------------------------------------- */
    case STATE.IDLE:
    case STATE.PATROL: {
      e.desiredCrouch = 0;
      e.alertness = clamp01(blackboard.alert * 0.7 + e.awareness);
      if (e.awareness > 0.85 || (blackboard.alert > 0.75 && blackboard.confidence > 0.4)) {
        setState(e, STATE.ENGAGE, ctx);
        break;
      }
      if (e.awareness > 0.25 || blackboard.alert > 0.3) {
        setState(e, STATE.ALERT, ctx);
        break;
      }
      if (e.repathTimer <= 0 && (!e.path || e.pathIndex >= e.path.length)) {
        e.repathTimer = 1.5 + rand.next() * 2;
        const dest = e.patrolTarget && e.position.distanceTo(e.patrolTarget) > 2.5
          ? e.patrolTarget
          : nav?.randomPointNear(e.anchor, 14, _v1);
        if (dest) {
          e.patrolTarget = e.patrolTarget || new THREE.Vector3();
          e.patrolTarget.copy(dest);
          e.setPath(nav?.findPath(e.position, dest), dest);
        }
      }
      e.desiredSpeed = e.path ? 1.5 : 0;
      e.aimAt = null;
      break;
    }

    /* ---------------------------------------------------------- */
    case STATE.ALERT: {
      // move to the last known position and check it
      e.alertness = 1;
      e.desiredCrouch = 0;
      e.desiredSpeed = 3.1;
      e.aimAt = threat;
      if (e.awareness > 0.8 && e.canSeePlayer) { setState(e, STATE.ENGAGE, ctx); break; }
      if (e.repathTimer <= 0) {
        e.repathTimer = 0.9 + rand.next() * 0.5;
        e.setPath(nav?.findPath(e.position, threat), threat);
      }
      if (distToThreat < 3.5 || e.stateTime > 16) {
        // nothing here: sweep the area, then stand down
        if (e.stateTime > 20 || blackboard.alert < 0.2) setState(e, STATE.PATROL, ctx);
        else if (e.repathTimer <= 0.4) {
          const p = nav?.randomPointNear(threat, 9, _v1);
          if (p) e.setPath(nav?.findPath(e.position, p), p);
        }
      }
      break;
    }

    /* ---------------------------------------------------------- */
    case STATE.ENGAGE: {
      e.alertness = 1;
      e.aimAt = threat;
      const inCover = e.coverPoint && e.position.distanceToSquared(e.coverPoint.position) < 1.4;
      const quality = e.coverPoint ? nav.coverQuality(e.coverPoint, threat) : 0;

      // wounded and losing: break contact
      if (e.morale < 0.3 && e.health < e.maxHealth * 0.32 && rand.next() < dt * 1.4) {
        setState(e, STATE.RETREAT, ctx);
        break;
      }
      if (blackboard.flanker === e && e.stateTime > 1.2 && distToThreat > 9) {
        setState(e, STATE.FLANK, ctx);
        break;
      }
      if (blackboard.suppressor === e && e.canSeePlayer && e.ammo > 8) {
        setState(e, STATE.SUPPRESS, ctx);
        break;
      }
      // cover gone stale or overrun
      if (e.decisionTimer <= 0) {
        e.decisionTimer = 1.1 + rand.next() * 0.9;
        if (!e.coverPoint || quality < 0.4 || (inCover && e.stateTime > 7 && rand.next() < 0.4)) {
          const c = pickCover(nav, blackboard, e, threat, {
            radius: 18, idealMin: 8, idealMax: 30,
            forward: _v2.copy(threat).sub(e.position).setY(0).normalize(),
          });
          if (c && c !== e.coverPoint) e.takeCover(c, ctx);
          else if (!c && e.canSeePlayer === false && e.repathTimer <= 0) {
            e.repathTimer = 1.2;
            e.setPath(nav?.findPath(e.position, threat), threat);
          }
        }
      }

      if (e.coverPoint) {
        const d = e.position.distanceTo(e.coverPoint.position);
        e.desiredSpeed = d > 2.2 ? 3.6 : (d > 0.35 ? 1.5 : 0);
        // crouch when the cover is only good low, stand to shoot otherwise
        const standing = nav.coverQuality(e.coverPoint, threat) > 0.75;
        e.desiredCrouch = d < 1.4 ? (standing && e.wantsToShoot ? 0.25 : 0.9) : 0;
      } else {
        e.desiredSpeed = distToThreat > 22 ? 3.4 : 1.4;
        e.desiredCrouch = 0;
      }

      e.wantsToShoot = e.canSeePlayer && distToThreat < 55 && e.aimReady > 0.55;
      if (e.suppression > 0.75 && rand.next() < dt * 0.8) setState(e, STATE.REPOSITION, ctx);
      break;
    }

    /* ---------------------------------------------------------- */
    case STATE.SUPPRESS: {
      e.alertness = 1;
      e.aimAt = threat;
      e.desiredSpeed = 0;
      e.desiredCrouch = e.coverPoint ? 0.25 : 0;
      e.wantsToShoot = distToThreat < 60 && (e.canSeePlayer || time - blackboard.lastSeen < 2.5);
      e.burstLength = 7;
      e.accuracyScale = 0.55;                 // volume, not precision
      if (e.ammo <= 2 || e.stateTime > 6 || blackboard.suppressor !== e) {
        e.burstLength = 4;
        e.accuracyScale = 1;
        setState(e, STATE.ENGAGE, ctx);
      }
      break;
    }

    /* ---------------------------------------------------------- */
    case STATE.FLANK: {
      e.alertness = 1;
      e.desiredCrouch = 0;
      e.desiredSpeed = 4.3;
      e.aimAt = e.canSeePlayer ? threat : null;
      e.wantsToShoot = e.canSeePlayer && distToThreat < 30 && e.aimReady > 0.7;
      if (e.repathTimer <= 0) {
        e.repathTimer = 1.6 + rand.next() * 0.8;
        if (!e.flankTarget) e.flankTarget = new THREE.Vector3();
        // swing wide: a point off the axis between us and the player
        _v1.copy(threat).sub(e.position).setY(0);
        const len = _v1.length() || 1;
        _v1.multiplyScalar(1 / len);
        _v2.set(-_v1.z, 0, _v1.x).multiplyScalar(e.flankSide * lerp(9, 17, rand.next()));
        _v3.copy(threat).addScaledVector(_v1, -lerp(5, 12, rand.next())).add(_v2);
        const p = nav?.nearestWalkable(_v3, 7, e.flankTarget);
        if (p) e.setPath(nav?.findPath(e.position, p), p);
        else e.flankSide *= -1;
      }
      if (blackboard.flanker !== e || e.stateTime > 14
        || (e.flankTarget && e.position.distanceTo(e.flankTarget) < 2.5)) {
        setState(e, STATE.ENGAGE, ctx);
      }
      if (e.suppression > 0.85) setState(e, STATE.ENGAGE, ctx);
      break;
    }

    /* ---------------------------------------------------------- */
    case STATE.REPOSITION: {
      e.alertness = 1;
      e.desiredCrouch = 0;
      e.desiredSpeed = 4.4;
      e.wantsToShoot = false;
      e.aimAt = e.canSeePlayer ? threat : null;
      if (e.stateTime < 0.05) {
        const c = pickCover(nav, blackboard, e, threat, {
          radius: 20, idealMin: 10, idealMax: 32,
          forward: _v2.copy(e.position).sub(threat).setY(0).normalize(),
          forwardWeight: 0.6,
        });
        if (c) e.takeCover(c, ctx);
        else if (nav) {
          const p = nav.randomPointNear(e.position, 10, _v1);
          if (p) e.setPath(nav.findPath(e.position, p), p);
        }
      }
      if (e.stateTime > 5 || (e.coverPoint && e.position.distanceTo(e.coverPoint.position) < 1.0)) {
        setState(e, STATE.ENGAGE, ctx);
      }
      break;
    }

    /* ---------------------------------------------------------- */
    case STATE.RETREAT: {
      e.alertness = 1;
      e.desiredCrouch = 0;
      e.desiredSpeed = 4.6;
      e.wantsToShoot = false;
      e.aimAt = null;
      if (e.repathTimer <= 0) {
        e.repathTimer = 1.8;
        _v1.copy(e.position).sub(threat).setY(0).normalize().multiplyScalar(18);
        _v1.add(e.position);
        const p = nav?.nearestWalkable(_v1, 8, _v2);
        if (p) e.setPath(nav?.findPath(e.position, p), p);
      }
      // patched up and angry again
      if (e.stateTime > 7 && e.health > e.maxHealth * 0.45) setState(e, STATE.ENGAGE, ctx);
      if (e.stateTime > 14) setState(e, STATE.ENGAGE, ctx);
      break;
    }

    default: break;
  }

  // shared modifiers
  if (e.suppression > 0.4 && e.state !== STATE.RETREAT) {
    e.desiredCrouch = Math.max(e.desiredCrouch, smoothstep(0.4, 0.9, e.suppression) * 0.9);
    e.desiredSpeed *= lerp(1, 0.55, clamp01(e.suppression));
  }
  if (e.reloading) e.wantsToShoot = false;
}

export function setState(e, state, ctx) {
  if (e.state === state) return;
  e.prevState = e.state;
  e.state = state;
  e.stateTime = 0;
  e.decisionTimer = 0;
  e.repathTimer = 0;
  e.burstLength = state === STATE.SUPPRESS ? 7 : 3 + Math.floor(rand.next() * 3);
  e.accuracyScale = 1;
  if (state !== STATE.ENGAGE && state !== STATE.SUPPRESS) e.wantsToShoot = false;
  if (state === STATE.FLANK && ctx) {
    e.flankSide = rand.next() < 0.5 ? -1 : 1;
    e.flankTarget = null;
  }
  if (state === STATE.DEAD && ctx) ctx.blackboard.release(e.coverPoint, e);
  void shortestAngle;
}
