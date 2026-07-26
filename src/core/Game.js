import { bus } from './EventBus.js';
import { Time } from './Time.js';
import { Input } from './Input.js';
import { Engine } from './Engine.js';
import { Settings } from './Settings.js';

/**
 * Service container + main loop. Subsystems register themselves here and are
 * ticked in a fixed order; anything cross-cutting goes over the event bus.
 *
 * Tick contract for a subsystem:
 *   fixedUpdate(dt)  - optional, called 0..n times per frame at FIXED_STEP
 *   update(dt, time) - optional, called once per frame with the variable delta
 *   lateUpdate(dt)   - optional, after update; camera-dependent work goes here
 */
export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.bus = bus;
    this.time = new Time();
    this.settings = new Settings();
    this.engine = new Engine(canvas);
    this.input = new Input(canvas);

    this.systems = [];
    this._byName = new Map();
    this.paused = false;
    this.running = false;
    this.state = 'boot'; // boot | menu | playing | dead | paused

    this.scene = this.engine.scene;
    this.camera = this.engine.camera;
    this.renderer = this.engine.renderer;

    bus.on('input:unlocked', () => {
      if (this.state === 'playing') this.setState('paused');
    });
  }

  register(name, system) {
    system.game = this;
    this.systems.push(system);
    this._byName.set(name, system);
    this[name] = system;
    return system;
  }

  get(name) { return this._byName.get(name); }

  setState(next) {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    bus.emit('state', { prev, next });
  }

  start() {
    this.running = true;
    const loop = (nowMs) => {
      if (!this.running) return;
      this._frameHandle = requestAnimationFrame(loop);
      this.tick(nowMs);
    };
    this._frameHandle = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._frameHandle);
  }

  tick(nowMs) {
    const t = this.time;
    t.begin(nowMs);
    this.renderer.info.reset();

    const simulating = this.state === 'playing';

    if (simulating) {
      let steps = 0;
      while (t.consumeFixed() && steps < 8) {
        for (const s of this.systems) s.fixedUpdate?.(1 / 120);
        steps++;
      }
      t.clampAccumulator();
    }

    for (const s of this.systems) s.update?.(t.delta, t);
    for (const s of this.systems) s.lateUpdate?.(t.delta, t);

    this.postfx?.render(t.delta);

    this.input.endFrame();
    bus.emit('frame:end', t);
  }
}
