/**
 * Frame clock with a fixed-step accumulator for deterministic simulation and a
 * separate variable delta for presentation (camera, viewmodel, post-processing).
 */
export const FIXED_STEP = 1 / 120;

export class Time {
  constructor() {
    this.now = 0;          // seconds since start, scaled
    this.raw = 0;          // seconds since start, unscaled
    this.delta = 0;        // scaled frame delta, clamped
    this.rawDelta = 0;     // unscaled frame delta, clamped
    this.scale = 1;        // slow-motion / hit-stop multiplier
    this.frame = 0;
    this.fps = 0;
    this._accumulator = 0;
    this._last = 0;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this.alpha = 0;        // interpolation factor between fixed steps
  }

  begin(nowMs) {
    const t = nowMs * 0.001;
    if (this._last === 0) this._last = t;
    // Clamp to survive tab-out / breakpoints without exploding the simulation.
    this.rawDelta = Math.min(t - this._last, 0.25);
    this._last = t;
    this.delta = this.rawDelta * this.scale;
    this.raw += this.rawDelta;
    this.now += this.delta;
    this.frame++;
    this._accumulator += this.delta;

    this._fpsAccum += this.rawDelta;
    this._fpsFrames++;
    if (this._fpsAccum >= 0.25) {
      this.fps = this._fpsFrames / this._fpsAccum;
      this._fpsAccum = 0;
      this._fpsFrames = 0;
    }
  }

  /** Consume one fixed step; call in a while loop. Caps steps to avoid spirals. */
  consumeFixed() {
    if (this._accumulator >= FIXED_STEP) {
      this._accumulator -= FIXED_STEP;
      return true;
    }
    this.alpha = this._accumulator / FIXED_STEP;
    return false;
  }

  /** Called after the fixed loop drains to bound catch-up work. */
  clampAccumulator(maxSteps = 8) {
    const max = maxSteps * FIXED_STEP;
    if (this._accumulator > max) this._accumulator = max;
  }
}
