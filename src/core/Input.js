import { bus } from './EventBus.js';

/**
 * Pointer-lock mouse + keyboard/gamepad input. Exposes an action map rather than
 * raw key codes so gameplay code never touches `event.code` directly.
 *
 * Mouse deltas accumulate between frames and are drained by the camera rig via
 * `consumeLook()` so sub-frame movement events are never dropped.
 */
const DEFAULT_BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['ControlLeft', 'KeyC'],
  sprint: ['ShiftLeft'],
  reload: ['KeyR'],
  use: ['KeyF'],
  melee: ['KeyV'],
  grenade: ['KeyG'],
  next: ['KeyQ'],
  swap: ['Digit1', 'Digit2'],
  flashlight: ['KeyL'],
  pause: ['Escape'],
};

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.bindings = { ...DEFAULT_BINDINGS };
    this.down = new Set();
    this.pressed = new Set();   // edge: went down this frame
    this.released = new Set();
    this.mouse = { dx: 0, dy: 0, wheel: 0 };
    this.buttons = new Set();
    this.buttonsPressed = new Set();
    this.locked = false;
    this.sensitivity = 0.0022;
    this.adsSensitivityScale = 0.72;
    this.invertY = false;
    this.gamepadIndex = null;
    this.gamepadLook = { x: 0, y: 0 };
    this.gamepadMove = { x: 0, y: 0 };
    this._bind();
  }

  _bind() {
    const kd = (e) => {
      if (e.repeat) return;
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
      if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    };
    const ku = (e) => {
      this.down.delete(e.code);
      this.released.add(e.code);
    };
    window.addEventListener('keydown', kd, { passive: false });
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', () => {
      this.down.clear();
      this.buttons.clear();
    });

    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) {
        this.requestLock();
        return;
      }
      if (!this.buttons.has(e.button)) this.buttonsPressed.add(e.button);
      this.buttons.add(e.button);
    });
    window.addEventListener('mouseup', (e) => this.buttons.delete(e.button));
    window.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // movementX/Y can spike on some drivers; clamp to a sane per-event budget.
      this.mouse.dx += Math.max(-400, Math.min(400, e.movementX || 0));
      this.mouse.dy += Math.max(-400, Math.min(400, e.movementY || 0));
    });

    window.addEventListener('wheel', (e) => {
      this.mouse.wheel += Math.sign(e.deltaY);
    }, { passive: true });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      bus.emit(this.locked ? 'input:locked' : 'input:unlocked');
    });

    window.addEventListener('gamepadconnected', (e) => { this.gamepadIndex = e.gamepad.index; });
    window.addEventListener('gamepaddisconnected', () => { this.gamepadIndex = null; });
  }

  requestLock() {
    this.canvas.requestPointerLock?.({ unadjustedMovement: true })?.catch?.(() => {
      this.canvas.requestPointerLock();
    });
  }

  exitLock() { document.exitPointerLock?.(); }

  action(name) {
    const keys = this.bindings[name];
    if (!keys) return false;
    for (const k of keys) if (this.down.has(k)) return true;
    return false;
  }

  actionPressed(name) {
    const keys = this.bindings[name];
    if (!keys) return false;
    for (const k of keys) if (this.pressed.has(k)) return true;
    return false;
  }

  keyPressed(code) { return this.pressed.has(code); }

  get fire() { return this.buttons.has(0) || this._gpTrigger(7); }
  get firePressed() { return this.buttonsPressed.has(0); }
  get ads() { return this.buttons.has(2) || this._gpTrigger(6); }

  _gpTrigger(i) {
    const gp = this._gamepad();
    return !!gp && (gp.buttons[i]?.value ?? 0) > 0.4;
  }

  _gamepad() {
    if (this.gamepadIndex === null) return null;
    return navigator.getGamepads?.()[this.gamepadIndex] ?? null;
  }

  /** Returns accumulated look delta in radians and clears it. */
  consumeLook(sensScale = 1) {
    const gp = this._gamepad();
    let gx = 0, gy = 0;
    if (gp) {
      const dz = (v) => (Math.abs(v) < 0.16 ? 0 : (v - Math.sign(v) * 0.16) / 0.84);
      // Cubic response curve gives fine control near center, fast turns at the edge.
      gx = Math.pow(dz(gp.axes[2] ?? 0), 3) * 3.2;
      gy = Math.pow(dz(gp.axes[3] ?? 0), 3) * 2.4;
      this.gamepadMove.x = dz(gp.axes[0] ?? 0);
      this.gamepadMove.y = dz(gp.axes[1] ?? 0);
    } else {
      this.gamepadMove.x = 0;
      this.gamepadMove.y = 0;
    }
    const yaw = -(this.mouse.dx * this.sensitivity * sensScale) - gx * 0.03 * sensScale;
    const pitchRaw = this.mouse.dy * this.sensitivity * sensScale + gy * 0.03 * sensScale;
    const pitch = (this.invertY ? -pitchRaw : pitchRaw);
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    return { yaw, pitch };
  }

  /** Movement axes combining WASD and left stick, normalized to unit length. */
  moveAxes() {
    let x = (this.action('right') ? 1 : 0) - (this.action('left') ? 1 : 0);
    let y = (this.action('forward') ? 1 : 0) - (this.action('back') ? 1 : 0);
    x += this.gamepadMove.x;
    y += -this.gamepadMove.y;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    return { x, y };
  }

  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.buttonsPressed.clear();
    this.mouse.wheel = 0;
  }
}
