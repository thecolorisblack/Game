import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { CharacterTextures } from './Textures.js';
import { buildOperatorAsset, KITS } from './Character.js';
import { Enemy, ENEMY_WEAPON, raySegment } from './Enemy.js';
import { Blackboard, STATE, setState } from './Behaviour.js';
import { NavGrid } from './Navmesh.js';
import { clamp, clamp01, lerp, Rand } from './Util.js';

/**
 * OPERATION BLACKOUT — hostiles.
 *
 * Owns the enemy roster, the navigation grid, the squad blackboard and the
 * director that decides when the map should get busier. Everything the rest of
 * the game needs is on this object:
 *
 *   ai.enemies                     live agents (read by the weapon solver)
 *   ai.hitscan(o, d, dist, opts)   per-limb ray query, honours cover
 *   ai.damage(enemy, amount, info) fallback damage entry point
 *   ai.debugStage(name)            capture-harness set dressing
 *
 * Emits: enemy:spawn, enemy:killed, damage:dealt (hostile -> player),
 * weapon:fire / weapon:reload (hostile), bullet:impact, bullet:whizby,
 * camera:shake, objective.
 * Consumes: weapon:fire (player), player:footstep, explosion, state.
 */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _sphere = new THREE.Sphere(new THREE.Vector3(), 1.35);
const DOWN = new THREE.Vector3(0, -1, 0);

const MAX_ENEMIES = 14;

export class AISystem {
  constructor(game) {
    this.game = game;
    this.enemies = [];
    this.agents = this.enemies;        // alias some systems look for
    this.pool = [];
    this.assets = [];
    this.textures = null;
    this.nav = null;
    this.blackboard = new Blackboard();
    this.rand = new Rand(0xC0FFEE);
    this.time = 0;
    this.frame = 0;
    this.enabled = true;
    this.ready = false;

    this.ctx = { nav: null, blackboard: this.blackboard, game, time: 0, ai: this };

    // director
    this.director = {
      enabled: true,
      targetAlive: 5,
      maxAlive: 9,
      spawnTimer: 3,
      minInterval: 2.6,
      lastKill: 0,
      intensity: 0.35,
      wave: 0,
      holdUntil: 0,
    };

    this.stats = { alive: 0, updated: 0, animated: 0, spawned: 0, killed: 0, navMs: 0 };
    this.objectiveText = null;
    this.killCount = 0;

    this._frustum = new THREE.Frustum();
    this._projScreen = new THREE.Matrix4();
    this._unsubs = [];
    this._staged = false;
    this._scriptedFire = [];
  }

  /* ================================================================ */
  /* boot                                                              */
  /* ================================================================ */

  async init() {
    const t0 = now();
    this.textures = new CharacterTextures(this.game);
    this.textures.build();
    await yieldFrame();

    for (let i = 0; i < KITS.length; i++) {
      try {
        this.assets.push(buildOperatorAsset(this.textures, KITS[i], 1337 + i * 91));
      } catch (err) {
        console.warn('[AI] operator asset failed to build:', err);
      }
      await yieldFrame();
    }
    if (!this.assets.length) { this.ready = false; return this; }

    this.nav = new NavGrid(this.game, { cell: 1.25, half: 68 });
    this.ctx.nav = this.nav;
    try {
      await this.nav.build(yieldFrame);
    } catch (err) {
      console.warn('[AI] navigation build failed:', err);
    }

    // Warm the pathfinder: the first few A* calls are 10x the steady-state cost
    // while the JIT settles, and the first of those would land mid-firefight.
    if (this.nav?.ready) {
      const spawns = this.game?.world?.getSpawnPoints?.() || [];
      for (let i = 0; i < 6; i++) {
        const a = spawns[i % Math.max(1, spawns.length)]?.position || _v1.set(0, 0, 0);
        const b = spawns[(i + 3) % Math.max(1, spawns.length)]?.position || _v2.set(8, 0, -8);
        this.nav.findPath(a, b, { force: true });
      }
    }

    // Same reasoning for the ragdoll solver: the first death should not be the
    // frame that pays for compiling it.
    try {
      const warm = this.game?.physics?.createRagdoll?.([
        { name: 'a', parent: -1, position: new THREE.Vector3(0, -80, 0), radius: 0.1, mass: 1 },
        { name: 'b', parent: 0, position: new THREE.Vector3(0, -80.3, 0), radius: 0.1, mass: 1 },
      ], { iterations: 4 });
      warm?.update?.(1 / 60);
      warm?.dispose?.();
    } catch (err) { /* physics may not be ready; the real path is guarded too */ }

    this._bindEvents();
    this._seedPatrols();

    this.ready = true;
    console.info(`[AI] ${this.assets.length} kits, nav ${this.nav?.stats.walkable ?? 0}/${this.nav?.stats.cells ?? 0} cells, `
      + `${this.nav?.stats.cover ?? 0} cover points, ${(now() - t0).toFixed(0)} ms`);
    return this;
  }

  _bindEvents() {
    const on = (name, fn) => {
      const wrapped = (e) => {
        try { fn(e); } catch (err) {
          if (!this._loggedError) { this._loggedError = true; console.error(`[AI] handler "${name}" failed`, err); }
        }
      };
      bus.on(name, wrapped);
      this._unsubs.push(() => bus.off(name, wrapped));
    };

    on('weapon:fire', (e) => { if (!e?.enemy) this._onPlayerFire(e); });
    on('damage:dealt', (e) => this._onDamageDealt(e));
    on('player:footstep', (e) => this._onFootstep(e));
    on('explosion', (e) => this._onExplosion(e));
    on('objective', (e) => { if (e?.text && !e.fromAI) this.objectiveText = e.text; });
    on('state', (e) => {
      if (e?.next === 'playing' && e?.prev === 'menu') this._reset();
    });
    on('player:died', () => { this.director.holdUntil = this.time + 6; });
  }

  /** A couple of hostiles on patrol so the world is not empty before contact. */
  _seedPatrols() {
    const spawns = this.game?.world?.getSpawnPoints?.('hostile') || [];
    const wanted = Math.min(4, spawns.length || 3);
    for (let i = 0; i < wanted; i++) {
      const s = spawns[i % Math.max(1, spawns.length)];
      const pos = s ? s.position.clone() : new THREE.Vector3(0, 0, -30 - i * 6);
      pos.y = this._groundAt(pos.x, pos.z);
      const e = this.spawn(pos, s?.yaw ?? Math.PI);
      if (e) e.anchor.copy(pos);
    }
  }

  _reset() {
    for (const e of [...this.enemies]) this.retire(e);
    this.blackboard = new Blackboard();
    this.ctx.blackboard = this.blackboard;
    this.killCount = 0;
    this.director.intensity = 0.35;
    this.director.spawnTimer = 4;
    this._staged = false;
    this._seedPatrols();
  }

  /* ================================================================ */
  /* roster                                                            */
  /* ================================================================ */

  _groundAt(x, z) {
    const physics = this.game?.physics;
    if (physics?.raycast) {
      const base = this.game?.world?.heightAt?.(x, z) ?? 0;
      _v1.set(x, base + 4, z);
      const hit = physics.raycast(_v1, DOWN, 8, null);
      if (hit) return hit.point.y;
    }
    return this.game?.world?.heightAt?.(x, z) ?? 0;
  }

  /**
   * @param {THREE.Vector3} position feet
   * @param {number} yaw
   * @returns {Enemy|null}
   */
  spawn(position, yaw = 0, opts = {}) {
    if (!this.assets.length) return null;
    if (this.enemies.length >= MAX_ENEMIES) return null;
    let e = this.pool.pop();
    if (!e) {
      const asset = this.assets[this.rand.int(0, this.assets.length - 1)];
      const scale = lerp(0.965, 1.035, this.rand.next());
      e = new Enemy(this, asset, {
        scale,
        skill: clamp01(lerp(0.32, 0.78, this.rand.next()) + this.director.intensity * 0.2),
        health: opts.health ?? 100,
      });
      this.game.scene.add(e.root);
    }
    e.spawn(position, yaw);
    if (opts.state) setState(e, opts.state, this.ctx);
    this.enemies.push(e);
    this.stats.spawned++;
    bus.emit('enemy:spawn', { enemy: e });
    return e;
  }

  /** Return an enemy to the pool; the mesh stays allocated for reuse. */
  retire(enemy) {
    const i = this.enemies.indexOf(enemy);
    if (i >= 0) this.enemies.splice(i, 1);
    this.blackboard.release(enemy.coverPoint, enemy);
    enemy.coverPoint = null;
    enemy.root.visible = false;
    enemy.alive = false;
    enemy.ragdoll?.dispose?.();
    enemy.ragdoll = null;
    enemy.root.rotation.set(0, 0, 0);
    enemy.scripted = null;
    enemy.scriptedNoDamage = false;
    if (this.pool.length < 8) this.pool.push(enemy);
    else { enemy.dispose(); }
  }

  /* ================================================================ */
  /* per frame                                                         */
  /* ================================================================ */

  update(dt, time) {
    if (!this.ready || !this.enabled) return;
    const d = Math.min(dt || 0, 0.1);
    this.time += d;
    this.frame++;
    this.ctx.time = this.time;
    this.blackboard.update(d, this.time);
    this.nav?.decayOccupancy(d);
    // A* is the only unbounded cost in here; cap it per frame rather than
    // letting six agents all repath on the same tick.
    this.nav?.beginFrame(2);

    const cam = this.game?.camera;
    if (cam) {
      this._projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      this._frustum.setFromProjectionMatrix(this._projScreen);
    }

    // roles are a squad-level decision, made a few times a second
    this.blackboard.assignRoles(this.enemies, this.time);

    let animated = 0;
    let alive = 0;
    let shadowBudget = 4;

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.alive) {
        alive++;
        this.nav?.stampOccupancy(e.position, 0.7 * d * 6);
      }

      // level of detail: distance + frustum decide how much of the agent runs
      const dist = cam ? cam.position.distanceTo(e.position) : 0;
      e.distanceToCamera = dist;
      _sphere.center.set(e.position.x, e.position.y + 0.95, e.position.z);
      const onScreen = cam ? this._frustum.intersectsSphere(_sphere) : true;
      e.visible = onScreen;
      let lod = 0;
      if (!onScreen) lod = dist < 26 ? 1 : 3;
      else if (dist > 70) lod = 2;
      else if (dist > 34) lod = 1;
      e.lodSkip = lod;
      e.animator.ikEnabled = e.alive && lod <= 1 && dist < 45;
      const wantsShadow = onScreen && dist < 42 && shadowBudget > 0;
      if (wantsShadow) shadowBudget--;
      if (e.character.mesh.castShadow !== wantsShadow) e.character.mesh.castShadow = wantsShadow;

      if (lod >= 2) {
        e._animAccum += d;
        const period = lod === 3 ? 0.25 : 0.1;
        if (e._animAccum < period) {
          // still run the cheap half: behaviour keeps ticking, the skeleton waits
          if (e.alive) this._updateLogicOnly(e, d);
          continue;
        }
        this._safeUpdate(e, e._animAccum);
        e._animAccum = 0;
      } else {
        this._safeUpdate(e, d);
      }
      animated++;
    }

    this.stats.alive = alive;
    this.stats.animated = animated;
    this.stats.updated = this.enemies.length;

    this._updateScriptedFire(d);
    this._updateDirector(d, alive);
  }

  _safeUpdate(e, dt) {
    try {
      if (e.scripted) this._updateScripted(e, dt);
      else e.update(dt, this.ctx);
    } catch (err) {
      if (!this._loggedUpdate) {
        this._loggedUpdate = true;
        console.error('[AI] enemy update failed; agent parked', err);
      }
      e.desiredSpeed = 0;
    }
  }

  /** Behaviour without the skeleton, for agents nobody can see. */
  _updateLogicOnly(e, dt) {
    try {
      e.perception.update(dt, this.time, this.game);
      e.awareness = e.perception.awareness;
      e.canSeePlayer = e.perception.canSee;
      if (e.canSeePlayer && this.game?.player) {
        this.blackboard.report(this.game.player.position, this.game.player.velocity, this.time,
          clamp01(e.perception.visibleFraction));
      }
      e.stateTime += dt;
    } catch (err) { /* one bad agent must not stop the frame */ }
  }

  /* ================================================================ */
  /* hit detection                                                     */
  /* ================================================================ */

  /**
   * Ray against every live enemy's limb capsules. Used by the weapon solver.
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} dir must be normalised
   * @param {number} maxDist
   * @param {{exclude?:Object}} [opts]
   * @returns {{enemy, object, point, normal, distance, part, multiplier}|null}
   */
  hitscan(origin, dir, maxDist = 300, opts = null) {
    let best = null;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (opts?.exclude === e) continue;
      // cheap reject against the body sphere first
      _v1.set(e.position.x, e.position.y + 0.95, e.position.z).sub(origin);
      const along = _v1.dot(dir);
      if (along < -1.5 || along > maxDist + 1.5) continue;
      if (_v1.lengthSq() - along * along > 1.6 * 1.6) continue;
      const hit = e.raycast(origin, dir, maxDist);
      if (hit && (!best || hit.distance < best.distance)) {
        best = {
          enemy: e,
          object: e.character.mesh,
          point: hit.point,
          normal: hit.normal,
          distance: hit.distance,
          part: hit.part,
          multiplier: hit.multiplier,
        };
      }
    }
    return best;
  }

  /** Fallback damage entry point (the weapon solver prefers `enemy.applyDamage`). */
  damage(enemy, amount, info) {
    if (!enemy?.applyDamage) return 0;
    return enemy.applyDamage(amount, info);
  }

  /**
   * `damage:dealt` aimed at one of ours. The weapon solver calls
   * `enemy.applyDamage` directly and *then* announces it, so the same hit would
   * otherwise land twice; the stamp written by applyDamage identifies the echo.
   */
  _onDamageDealt(e) {
    const target = e?.target;
    if (!target || typeof target.applyDamage !== 'function') return;
    if (this.enemies.indexOf(target) < 0) return;
    if (target._damageFrame === this.frame && Math.abs((target._damageAmount ?? -1) - (e.amount ?? 0)) < 0.01) return;
    target.applyDamage(e.amount ?? 0, {
      headshot: !!e.headshot,
      point: e.point,
      direction: e.direction || null,
      part: e.part || (e.headshot ? 'head' : 'chest'),
      weapon: e.weapon ?? null,
      source: e.source ?? 'external',
    });
  }

  onEnemyKilled(enemy, info = {}) {
    this.killCount++;
    this.stats.killed++;
    this.blackboard.killCount++;
    this.director.lastKill = this.time;
    this.director.intensity = clamp01(this.director.intensity + 0.08);
    bus.emit('enemy:killed', {
      enemy,
      headshot: !!info.headshot || info.part === 'head',
      weapon: info.weapon ?? null,
      point: (info.point ? info.point.clone() : enemy.getEyePosition(new THREE.Vector3())),
    });
    if (this.objectiveText) {
      bus.emit('objective', {
        text: this.objectiveText,
        progress: clamp01(this.killCount / 18),
        fromAI: true,
      });
    }
    // the squad notices one of theirs going down
    for (const e of this.enemies) {
      if (!e.alive || e === enemy) continue;
      if (e.position.distanceTo(enemy.position) < 26) {
        e.suppression = Math.min(1.2, e.suppression + 0.3);
        e.perception.awareness = Math.max(e.perception.awareness, 0.7);
      }
    }
  }

  /* ================================================================ */
  /* hostile fire                                                      */
  /* ================================================================ */

  emit(name, payload) { bus.emit(name, payload); }

  /**
   * Resolve one hostile shot: muzzle flash and tracer through the normal VFX
   * path, then a real trace so cover works in both directions.
   */
  onEnemyFire(enemy, muzzle, dir, distance) {
    const game = this.game;
    const origin = muzzle.clone();
    const direction = dir.clone().normalize();

    bus.emit('weapon:fire', {
      weapon: ENEMY_WEAPON,
      origin,
      dir: direction,
      spread: 0.02,
      isADS: true,
      enemy,
      hostile: true,
    });

    const physics = game?.physics;
    const player = game?.player;
    let worldDist = ENEMY_WEAPON.range;
    let worldHit = null;
    if (physics?.raycast) {
      worldHit = physics.raycast(origin, direction, ENEMY_WEAPON.range, null);
      if (worldHit) worldDist = worldHit.distance;
    }

    // friendly fire on other hostiles is resolved too, so flanking has a cost
    const other = this.hitscan(origin, direction, worldDist, { exclude: enemy });

    let hitPlayer = null;
    // `player.scripted` means the capture harness owns the camera: hostiles put
    // rounds downrange for the screenshot but must not kill the subject.
    if (player && player.vitals?.alive !== false && !enemy.scriptedNoDamage && !player.scripted) {
      hitPlayer = this._rayPlayer(origin, direction, Math.min(worldDist, other ? other.distance : worldDist), player);
    }

    if (hitPlayer) {
      const falloff = lerp(1, 0.55, clamp01((hitPlayer.distance - 18) / 55));
      const amount = ENEMY_WEAPON.damage * falloff * (hitPlayer.headshot ? 2.1 : 1);
      bus.emit('damage:dealt', {
        target: player,
        amount,
        headshot: hitPlayer.headshot,
        point: origin.clone(),
        from: origin.clone(),
        source: enemy,
        weapon: ENEMY_WEAPON.id,
      });
      bus.emit('bullet:impact', {
        point: hitPlayer.point,
        normal: direction.clone().negate(),
        surface: 'flesh',
        object: null,
        dir: direction.clone(),
      });
    } else if (other) {
      other.enemy.applyDamage(ENEMY_WEAPON.damage * 0.8, {
        headshot: other.part === 'head', point: other.point, direction, part: other.part,
        weapon: ENEMY_WEAPON.id, source: 'hostile',
      });
    } else if (worldHit) {
      bus.emit('bullet:impact', {
        point: worldHit.point,
        normal: worldHit.normal,
        surface: worldHit.surface || 'concrete',
        object: worldHit.object,
        dir: direction,
      });
      // a round cracking past is the main reason a player takes cover
      if (player) this._whizby(origin, direction, worldDist, player);
    } else if (player) {
      this._whizby(origin, direction, worldDist, player);
    }
    void distance;
  }

  _rayPlayer(origin, dir, maxDist, player) {
    const feet = player.position;
    const h = (player.eyeHeight ?? 1.63) + 0.12;
    _v1.set(feet.x, feet.y + 0.32, feet.z);
    _v2.set(feet.x, feet.y + h - 0.24, feet.z);
    const hit = raySegment(origin, dir, _v1, _v2, 0.34, maxDist);
    if (!hit) return null;
    const headY = feet.y + h - 0.30;
    return { ...hit, headshot: hit.point.y > headY };
  }

  _whizby(origin, dir, maxDist, player) {
    _v3.set(player.position.x, player.position.y + (player.eyeHeight ?? 1.63), player.position.z);
    _v4.copy(_v3).sub(origin);
    const along = clamp(_v4.dot(dir), 0, maxDist);
    _v4.copy(origin).addScaledVector(dir, along);
    const miss = _v4.distanceTo(_v3);
    if (miss < 3.2) {
      bus.emit('bullet:whizby', { distance: miss });
      if (miss < 1.1) {
        bus.emit('camera:shake', { amplitude: 0.05 * (1 - miss), frequency: 26, duration: 0.12 });
      }
    }
  }

  /* ================================================================ */
  /* player-side stimuli                                               */
  /* ================================================================ */

  _onPlayerFire(e) {
    if (!e?.origin) return;
    const origin = e.origin;
    const dir = e.dir;
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      const dist = enemy.position.distanceTo(origin);
      if (dist < 85) {
        this.blackboard.reportNoise(origin, this.time, clamp01(1 - dist / 85) * 0.8);
        enemy.perception.awareness = Math.min(1.4,
          enemy.perception.awareness + clamp01(1 - dist / 85) * 0.55);
      }
      // suppression from rounds passing close by
      if (dir) {
        _v1.set(enemy.position.x, enemy.position.y + 1.0, enemy.position.z).sub(origin);
        const along = _v1.dot(dir);
        if (along > 0 && along < 140) {
          const perp = Math.sqrt(Math.max(0, _v1.lengthSq() - along * along));
          if (perp < 2.6) {
            enemy.suppression = Math.min(1.4, enemy.suppression + (1 - perp / 2.6) * 0.34);
            enemy.animator.flinch.kick(2.2 * (1 - perp / 2.6));
          }
        }
      }
    }
  }

  _onFootstep(e) {
    if (!e?.position) return;
    const radius = e.running ? 19 : 9.5;
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      const d = enemy.position.distanceTo(e.position);
      if (d > radius) continue;
      const w = clamp01(1 - d / radius);
      enemy.perception.awareness = Math.min(1.2, enemy.perception.awareness + w * 0.28);
      this.blackboard.reportNoise(e.position, this.time, w * 0.55);
    }
  }

  _onExplosion(e) {
    if (!e?.position) return;
    const radius = e.radius ?? 6;
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      const d = enemy.position.distanceTo(e.position);
      if (d > radius * 2.4) continue;
      enemy.suppression = Math.min(1.4, enemy.suppression + clamp01(1 - d / (radius * 2)) * 1.1);
      if (d < radius) {
        const falloff = 1 - d / radius;
        enemy.applyDamage((e.power ?? 14) * 6 * falloff * falloff, {
          point: e.position.clone(),
          direction: _v1.copy(enemy.position).sub(e.position).normalize().clone(),
          part: 'chest', weapon: 'explosive', source: 'explosion',
        });
      }
    }
  }

  /* ================================================================ */
  /* director                                                          */
  /* ================================================================ */

  /**
   * Keeps something interesting on screen: tops the roster back up when the
   * player is winning, backs off right after a kill so the beat lands, and
   * refuses to spawn anything the player can see appear.
   */
  _updateDirector(dt, alive) {
    const dir = this.director;
    if (!dir.enabled || this._staged || this.time < dir.holdUntil) return;
    if (this.game?.state !== 'playing') return;
    const player = this.game?.player;
    if (!player) return;

    dir.spawnTimer -= dt;
    const engaged = this.blackboard.alert > 0.5;
    const target = Math.round(lerp(3, dir.maxAlive, dir.intensity)) + (engaged ? 1 : 0);
    dir.targetAlive = target;

    if (alive >= target || this.enemies.length >= MAX_ENEMIES) return;
    if (dir.spawnTimer > 0) return;
    // let a kill breathe before the replacement walks in
    if (this.time - dir.lastKill < 1.6) return;

    const spot = this._findSpawnPoint(player);
    if (!spot) { dir.spawnTimer = 1.2; return; }

    const e = this.spawn(spot.position, spot.yaw, { state: engaged ? STATE.ALERT : STATE.PATROL });
    if (e) {
      dir.spawnTimer = dir.minInterval * lerp(1.6, 0.7, dir.intensity);
      dir.wave++;
      if (engaged) {
        e.perception.awareness = 0.75;
        e.alertness = 1;
      }
    } else {
      dir.spawnTimer = 1.5;
    }
  }

  _findSpawnPoint(player) {
    const nav = this.nav;
    const eye = _v1.set(player.position.x, player.position.y + (player.eyeHeight ?? 1.63), player.position.z);
    const spawns = this.game?.world?.getSpawnPoints?.('hostile') || [];
    const physics = this.game?.physics;

    const candidates = [];
    for (const s of spawns) {
      candidates.push({ position: s.position.clone(), yaw: s.yaw ?? Math.PI });
    }
    if (nav?.ready) {
      for (let i = 0; i < 6; i++) {
        const a = this.rand.next() * Math.PI * 2;
        const r = lerp(26, 58, this.rand.next());
        _v2.set(player.position.x + Math.cos(a) * r, player.position.y, player.position.z + Math.sin(a) * r);
        const p = nav.nearestWalkable(_v2, 6, _v3);
        if (p) candidates.push({ position: p.clone(), yaw: Math.atan2(-(player.position.x - p.x), -(player.position.z - p.z)) });
      }
    }

    let best = null;
    let bestScore = -Infinity;
    for (const c of candidates) {
      const d = c.position.distanceTo(player.position);
      if (d < 18 || d > 78) continue;
      let score = 1 - Math.abs(d - 38) / 40;
      // never pop into view
      if (physics?.lineOfSight) {
        _v4.set(c.position.x, c.position.y + 1.2, c.position.z);
        if (physics.lineOfSight(eye, _v4, null)) score -= 3.5;
      }
      // spread the pressure around the player rather than piling on one side
      let crowd = 0;
      for (const e of this.enemies) {
        if (e.alive && e.position.distanceTo(c.position) < 12) crowd++;
      }
      score -= crowd * 0.6;
      score += this.rand.next() * 0.4;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (!best || bestScore < -1.5) return null;
    best.position.y = this._groundAt(best.position.x, best.position.z);
    return best;
  }

  /* ================================================================ */
  /* scripted stages for the capture harness                           */
  /* ================================================================ */

  /**
   * `debugStage(name)` must leave a visually complete frame with no further
   * simulation required.
   *   'firefight' — a squad mid-contact in front of the camera
   *   'portrait'  — one hostile in a clean hero pose, dead ahead
   */
  debugStage(name = 'firefight') {
    if (!this.ready) return false;
    const cam = this.game?.camera;
    for (const e of [...this.enemies]) this.retire(e);
    this._staged = true;
    this.director.holdUntil = this.time + 120;

    const camPos = cam ? cam.position : new THREE.Vector3(2, 1.7, 2);
    const camDir = new THREE.Vector3(0, 0, -1);
    if (cam) camDir.set(0, 0, -1).applyQuaternion(cam.quaternion);
    camDir.y = 0;
    if (camDir.lengthSq() < 1e-5) camDir.set(0, 0, -1);
    camDir.normalize();
    const right = new THREE.Vector3(-camDir.z, 0, camDir.x);

    if (name === 'portrait') {
      this._stagePortrait(camPos, camDir, right);
    } else {
      this._stageFirefight(camPos, camDir, right);
    }

    // settle the skeletons so the very first captured frame is already correct
    for (let i = 0; i < 6; i++) {
      for (const e of this.enemies) this._updateScripted(e, 1 / 30);
    }
    return true;
  }

  _place(offsetAlong, offsetSide, camPos, camDir, right, faceCamera = true) {
    const pos = new THREE.Vector3()
      .copy(camPos)
      .addScaledVector(camDir, offsetAlong)
      .addScaledVector(right, offsetSide);
    if (this.nav?.ready) {
      const snapped = this.nav.nearestWalkable(pos, 4, _v1);
      if (snapped) pos.set(snapped.x, snapped.y, snapped.z);
    }
    pos.y = this._groundAt(pos.x, pos.z);
    const yaw = faceCamera
      ? Math.atan2(-(camPos.x - pos.x), -(camPos.z - pos.z))
      : Math.atan2(-camDir.x, -camDir.z);
    return { pos, yaw };
  }

  _stagePortrait(camPos, camDir, right) {
    const { pos, yaw } = this._place(5.4, 0.12, camPos, camDir, right, true);
    // three-quarter view: dead-on reads as a mugshot, this reads as a soldier
    const e = this.spawn(pos, yaw - 0.30);
    if (!e) return;
    e.scripted = {
      speed: 0, moveAngle: 0, crouch: 0, alertness: 0.85, aimBlend: 0.35,
      aimYaw: 0.16, aimPitch: -0.06, lookYaw: 0.30, lookPitch: -0.05, lookWeight: 1,
      fireEvery: 0, phase: 0.18,
    };
    e.scriptedNoDamage = true;
    e.animator.phase = 0.18;
    e.animator.time = 3.1;
    // weight on the back leg, shoulders open to camera: a hero stance, not a T
    e.animator.leanSpring.set(-1.4);
  }

  _stageFirefight(camPos, camDir, right) {
    // Fire intervals are deliberately shorter than a muzzle flash's life so a
    // flash is on screen whichever frame the harness decides to grab.
    const layout = [
      { along: 7.5, side: 1.4, crouch: 0.9, fire: 0.10, alert: 1, aimBlend: 1, speed: 0 },
      { along: 12.0, side: -4.4, crouch: 0, fire: 0.13, alert: 1, aimBlend: 1, speed: 0 },
      { along: 15.5, side: 5.2, crouch: 0, fire: 0, alert: 1, aimBlend: 0.4, speed: 4.2, moveAngle: -1.25 },
      { along: 19.0, side: -6.6, crouch: 0.35, fire: 0.17, alert: 1, aimBlend: 1, speed: 0 },
      { along: 23.0, side: 2.1, crouch: 0, fire: 0, alert: 1, aimBlend: 0.8, speed: 2.6, moveAngle: 0.2 },
      { along: 10.5, side: 7.2, crouch: 0, fire: 0, alert: 1, aimBlend: 0.7, speed: 0, hit: true },
    ];

    for (let i = 0; i < layout.length; i++) {
      const L = layout[i];
      const { pos, yaw } = this._place(L.along, L.side, camPos, camDir, right, true);
      const e = this.spawn(pos, yaw + (L.speed > 0.5 ? 0.5 * Math.sign(L.moveAngle || 1) : 0));
      if (!e) continue;
      e.scripted = {
        speed: L.speed, moveAngle: L.moveAngle ?? 0, crouch: L.crouch,
        alertness: L.alert, aimBlend: L.aimBlend,
        aimYaw: (this.rand.next() - 0.5) * 0.25,
        aimPitch: -0.04 + (this.rand.next() - 0.5) * 0.06,
        lookYaw: 0, lookPitch: 0, lookWeight: L.speed > 0.5 ? 0.4 : 0,
        fireEvery: L.fire, fireTimer: this.rand.next() * 0.2, phase: this.rand.next(),
      };
      e.scriptedNoDamage = true;
      e.animator.phase = e.scripted.phase;
      e.animator.time = this.rand.next() * 8;
      if (L.hit) {
        e.animator.hitReact('torso', 1);
        e.animator.flinch.kick(9);
      }
      if (L.fire > 0) e.animator.kick(1.1);
    }
  }

  /** A staged agent: pose and weapon only, no navigation, no decisions. */
  _updateScripted(e, dt) {
    const s = e.scripted;
    if (!s) return;
    e.root.position.copy(e.position);
    e.root.rotation.set(0, e.yaw, 0);
    e.crouch = s.crouch;
    e.alertness = s.alertness;
    e.aimBlend = s.aimBlend;

    if (s.speed > 0.05) {
      // fake forward travel so the stride phase and gear springs look alive
      const fwd = _v1.set(-Math.sin(e.yaw), 0, -Math.cos(e.yaw)).multiplyScalar(s.speed);
      e.velocity.set(fwd.x, 0, fwd.z);
    } else {
      e.velocity.set(0, 0, 0);
    }
    e.animator.setVelocity(e.velocity);
    e.animator.update(dt, {
      speed: s.speed, moveAngle: s.moveAngle, crouch: s.crouch, alertness: s.alertness,
      aimYaw: s.aimYaw, aimPitch: s.aimPitch,
      lookYaw: s.lookYaw, lookPitch: s.lookPitch, lookWeight: s.lookWeight,
      aimBlend: s.aimBlend,
    });
    e._updateHitboxes(true);

    if (s.fireEvery > 0) {
      s.fireTimer = (s.fireTimer ?? 0) - dt;
      if (s.fireTimer <= 0) {
        s.fireTimer = s.fireEvery;
        this._scriptedFire.push(e);
      }
    }
  }

  /** Staged muzzle flashes are dispatched outside the pose loop. */
  _updateScriptedFire() {
    if (!this._scriptedFire.length) return;
    for (const e of this._scriptedFire) {
      try {
        const muzzle = e.getMuzzle(_v1, _v2);
        const dir = _v2.clone();
        e.animator.kick(1);
        this.onEnemyFire(e, muzzle, dir, 20);
      } catch (err) { /* staging must never throw */ }
    }
    this._scriptedFire.length = 0;
  }

  /* ================================================================ */

  report() {
    return {
      ...this.stats,
      nav: this.nav?.stats,
      alert: this.blackboard.alert.toFixed(2),
      confidence: this.blackboard.confidence.toFixed(2),
      states: this.enemies.map((e) => `${e.id}:${e.state}`),
    };
  }

  dispose() {
    for (const u of this._unsubs) u();
    this._unsubs.length = 0;
    for (const e of [...this.enemies, ...this.pool]) e.dispose();
    this.enemies.length = 0;
    this.pool.length = 0;
    this.nav?.dispose();
    this.textures?.dispose();
  }
}

/* ------------------------------------------------------------------ */

function now() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }

function yieldFrame() {
  if (typeof MessageChannel === 'function') {
    return new Promise((resolve) => {
      const mc = new MessageChannel();
      mc.port1.onmessage = () => { mc.port1.close(); resolve(); };
      mc.port2.postMessage(0);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export { STATE };
