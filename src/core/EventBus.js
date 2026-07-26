/**
 * Tiny synchronous pub/sub. Subsystems communicate through this instead of
 * holding references to each other, so modules stay independently replaceable.
 */
export class EventBus {
  constructor() {
    this._handlers = new Map();
  }

  on(event, fn) {
    let set = this._handlers.get(event);
    if (!set) this._handlers.set(event, (set = new Set()));
    set.add(fn);
    return () => this.off(event, fn);
  }

  once(event, fn) {
    const off = this.on(event, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off(event, fn) {
    this._handlers.get(event)?.delete(fn);
  }

  emit(event, payload) {
    const set = this._handlers.get(event);
    if (!set) return;
    // Copy so handlers may unsubscribe during dispatch.
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[EventBus] handler for "${event}" threw`, err);
      }
    }
  }
}

export const bus = new EventBus();
