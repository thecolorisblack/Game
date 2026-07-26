import * as THREE from 'three';
import { bus } from './EventBus.js';

/**
 * Test hook used by scripts/shoot.mjs. Not loaded in a normal play session's hot
 * path — it only reacts when `pose()` is called from the harness.
 *
 * It drives the *real* pipeline: no debug materials, no disabled effects. A shot
 * that looks good here is a shot that looks good in game.
 */
export class Capture {
  constructor(game) {
    this.game = game;
    this.settled = true;
    this._remaining = 0;
    this._onFrame = null;
    window.__CAPTURE__ = this;
  }

  init() {
    bus.on('frame:end', () => {
      if (this._remaining > 0) {
        this._remaining--;
        if (this._remaining === 0) {
          this.settled = true;
          this._onFrame?.();
        }
      }
    });
  }

  /** Place the camera, apply the shot's world/action setup, then settle N frames. */
  pose(shot, settleFrames = 24) {
    const g = this.game;
    this.settled = false;

    g.setState('playing');

    // Detach the player controller so scripted framing is exact and repeatable.
    if (g.player) g.player.scripted = true;

    const cam = g.engine.camera;
    if (shot.pos) cam.position.fromArray(shot.pos);
    if (shot.look) {
      const target = new THREE.Vector3().fromArray(shot.look);
      const dir = target.clone().sub(cam.position).normalize();
      cam.rotation.y = Math.atan2(-dir.x, -dir.z);
      cam.rotation.x = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
      cam.rotation.z = 0;
      if (g.player) {
        g.player.yaw = cam.rotation.y;
        g.player.pitch = cam.rotation.x;
        g.player.position?.set(cam.position.x, cam.position.y - (g.player.eyeHeight ?? 1.65), cam.position.z);
      }
    }
    if (shot.fov) g.engine.setHorizontalFov(shot.fov);
    if (shot.time !== undefined) g.world?.setTimeOfDay?.(shot.time);

    this._runAction(shot.action);

    // Reset temporal accumulation so TAA/motion blur converge on the new pose
    // instead of smearing the previous shot across this one.
    g.postfx?.resetHistory?.();

    this._remaining = Math.max(2, settleFrames);
    return true;
  }

  _runAction(action) {
    const g = this.game;
    switch (action) {
      case 'inspect':
        g.weapons?.debugPose?.('inspect');
        break;
      case 'ads':
        g.weapons?.debugPose?.('ads');
        break;
      case 'fire':
        g.weapons?.debugPose?.('ads');
        g.weapons?.debugFire?.(3);
        break;
      case 'combat':
        g.ai?.debugStage?.('firefight');
        g.weapons?.debugFire?.(6);
        break;
      case 'enemy-pose':
        g.ai?.debugStage?.('portrait');
        break;
      default:
        break;
    }
  }

  /**
   * Stop the rAF loop so the canvas holds a static frame. Playwright's
   * screenshot waits for page stability and will never fire against a
   * continuously animating page under software rendering.
   */
  freeze() { this.game.stop(); return true; }

  thaw() { if (!this.game.running) this.game.start(); return true; }

  stats() {
    const g = this.game;
    const info = g.renderer.info;
    return {
      fps: Math.round(g.time.fps),
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
      textures: info.memory.textures,
      geometries: info.memory.geometries,
    };
  }
}
