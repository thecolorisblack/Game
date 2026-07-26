/**
 * OPERATION BLACKOUT — front end.
 *
 * Title, pause, settings, controls and the death/redeploy screen. DOM here (not
 * canvas): menus are layout, they are keyboard- and pointer-navigable, and they
 * only exist while the simulation is idle, so the cost of a few dozen elements
 * is irrelevant. The hero title is still drawn with the HUD's own vector
 * typeface so the brand reads identically in the menu and in the game.
 *
 * The scene keeps rendering behind everything — the title screen is a scrim
 * over a live frame, not a static image.
 *
 * Rules it must never break:
 *   · while `game.state === 'playing'` nothing here is visible, nothing here
 *     receives pointer or keyboard input, and the capture harness gets a clear
 *     screen even if it forces the state directly;
 *   · leaving a menu for gameplay re-acquires pointer lock from the click or
 *     key press that asked for it, and entering one releases it cleanly.
 */

import { bus } from '../core/EventBus.js';
import { clamp, clamp01, COLOR } from './Style.js';
import { drawText, measure } from './Type.js';
import { injectStyles } from './MenuStyle.js';

const BUILD = 'BUILD 0.1.0 · TASK FORCE BRAVO';

const KEY_LABELS = {
  KeyW: 'W', KeyA: 'A', KeyS: 'S', KeyD: 'D', KeyR: 'R', KeyF: 'F', KeyV: 'V',
  KeyG: 'G', KeyQ: 'Q', KeyC: 'C', KeyL: 'L', KeyE: 'E',
  Space: 'SPACE', ShiftLeft: 'L-SHIFT', ShiftRight: 'R-SHIFT',
  ControlLeft: 'L-CTRL', ControlRight: 'R-CTRL', AltLeft: 'L-ALT',
  Escape: 'ESC', Tab: 'TAB', Enter: 'ENTER',
  ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
  Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4',
};

const ACTION_LABELS = [
  ['forward', 'MOVE FORWARD'], ['back', 'MOVE BACK'], ['left', 'MOVE LEFT'], ['right', 'MOVE RIGHT'],
  ['sprint', 'SPRINT'], ['jump', 'JUMP / MANTLE'], ['crouch', 'CROUCH / SLIDE'],
  ['reload', 'RELOAD'], ['use', 'INTERACT'], ['melee', 'MELEE'], ['grenade', 'THROW GRENADE'],
  ['next', 'CYCLE WEAPON'], ['swap', 'SELECT WEAPON'], ['flashlight', 'WEAPON LIGHT'], ['pause', 'PAUSE'],
];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class Menu {
  constructor(game) {
    this.game = game;

    this.screen = null;         // null | 'title' | 'pause' | 'settings' | 'controls' | 'dead'
    this.returnTo = 'title';
    this.active = false;
    this.screens = {};

    this.deadTimer = 0;
    this.deadReady = false;

    this._nav = new Map();      // screen -> {items:[], index:number}
    this._unsub = [];
    this._ateEscape = 0;
    this._saveTimer = 0;
    this._saveDirty = false;
    this._drag = null;
  }

  /* ================================================================== */
  /* boot                                                               */
  /* ================================================================== */

  async init() {
    injectStyles();

    const host = document.getElementById('ui-root') || document.body;
    this.root = el('div', 'ob-root');
    host.appendChild(this.root);

    this._buildTitle();
    this._buildPause();
    this._buildSettings();
    this._buildControls();
    this._buildDead();

    this._onKeyDown = (e) => this._handleKey(e);
    window.addEventListener('keydown', this._onKeyDown);
    this._onPointerMove = (e) => this._onDragMove(e);
    this._onPointerUp = () => { this._drag = null; };
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);

    this._unsub.push(bus.on('state', ({ next }) => this._onState(next)));
    this._unsub.push(bus.on('player:died', (e) => this._onDied(e)));

    this._onState(this.game.state);
    return this;
  }

  /* ================================================================== */
  /* screen construction                                                */
  /* ================================================================== */

  _screen(id, extraClass = '') {
    const s = el('div', `ob-screen ob-screen-${id} ${extraClass}`.trim());
    this.root.appendChild(s);
    return s;
  }

  _corners(parent) {
    for (const c of ['tl', 'tr', 'bl', 'br']) parent.appendChild(el('div', `ob-corner ${c}`));
  }

  _texture(parent, scrimClass = '') {
    parent.appendChild(el('div', `ob-scrim ${scrimClass}`.trim()));
    parent.appendChild(el('div', 'ob-tex'));
    parent.appendChild(el('div', 'ob-scan'));
    parent.appendChild(el('div', 'ob-edge'));
  }

  _buildTitle() {
    const s = this._screen('title');
    this._texture(s);
    this._corners(s);

    const wrap = el('div', 'ob-title-wrap');
    wrap.appendChild(this._titleCanvas());
    wrap.appendChild(el('div', 'ob-sub', 'MARKET DISTRICT · OPERATION BLACKOUT'));
    wrap.appendChild(el('div', 'ob-rule'));

    const list = el('ul', 'ob-list');
    const items = [
      ['PLAY', () => this._startGame()],
      ['SETTINGS', () => this.show('settings', 'title')],
      ['CONTROLS', () => this.show('controls', 'title')],
    ];
    const nav = { items: [], index: 0 };
    items.forEach(([label, fn], i) => {
      const li = el('li', 'ob-item');
      li.appendChild(el('span', 'ob-idx', String(i + 1).padStart(2, '0')));
      li.appendChild(el('span', 'ob-label', label));
      list.appendChild(li);
      const item = { el: li, activate: fn };
      nav.items.push(item);
      this._wireItem('title', item, nav.items.length - 1);
    });
    wrap.appendChild(list);
    s.appendChild(wrap);

    const foot = el('div', 'ob-foot');
    foot.appendChild(el('span', null, BUILD));
    const hint = el('span');
    hint.innerHTML = '<b>W/S</b> NAVIGATE &nbsp;·&nbsp; <b>ENTER</b> SELECT';
    foot.appendChild(hint);
    s.appendChild(foot);

    this._nav.set('title', nav);
    this.screens.title = s;
  }

  /** The hero lockup, stroked with the HUD typeface at 2x for retina. */
  _titleCanvas() {
    const dpr = 2;
    const kicker = 'OPERATION';
    const hero = 'BLACKOUT';
    const kSize = 26;
    const hSize = 104;
    const w = Math.ceil(Math.max(measure(kicker, kSize, 0.72), measure(hero, hSize, 0.06)) + 28);
    const h = 200;

    const c = document.createElement('canvas');
    c.className = 'ob-title-canvas';
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    drawText(g, kicker, 6, 40, {
      size: kSize, weight: 0.15, tracking: 0.72,
      color: COLOR.accent, halo: false,
    });

    drawText(g, hero, 2, 158, {
      size: hSize, weight: 0.088, tracking: 0.06,
      color: '#f2f6f8', halo: 0.6, haloColor: 'rgba(0,0,0,0.45)',
      glow: 0.14, glowColor: COLOR.accent,
    });

    // underline with a warm falloff and a hard stub at the left
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, 'rgba(232,181,98,0.95)');
    grad.addColorStop(0.55, 'rgba(232,181,98,0.22)');
    grad.addColorStop(1, 'rgba(232,181,98,0)');
    g.fillStyle = grad;
    g.fillRect(2, 172, w - 6, 2);
    g.fillStyle = COLOR.accent;
    g.fillRect(2, 168, 34, 6);

    c.style.maxWidth = `${w}px`;
    return c;
  }

  _buildPause() {
    const s = this._screen('pause');
    this._texture(s, 'is-light');
    this._corners(s);

    const panel = el('div', 'ob-panel');
    const head = el('div', 'ob-panel-head');
    head.appendChild(el('div', 'ob-panel-title', 'PAUSED'));
    head.appendChild(el('div', 'ob-panel-kicker', 'MISSION HELD'));
    panel.appendChild(head);

    const body = el('div', 'ob-panel-body');
    const list = el('ul', 'ob-list');
    const items = [
      ['RESUME', () => this._resume()],
      ['SETTINGS', () => this.show('settings', 'pause')],
      ['CONTROLS', () => this.show('controls', 'pause')],
      ['ABORT TO TITLE', () => this._toTitle()],
    ];
    const nav = { items: [], index: 0 };
    items.forEach(([label, fn], i) => {
      const li = el('li', 'ob-item');
      li.appendChild(el('span', 'ob-idx', String(i + 1).padStart(2, '0')));
      li.appendChild(el('span', 'ob-label', label));
      list.appendChild(li);
      const item = { el: li, activate: fn };
      nav.items.push(item);
      this._wireItem('pause', item, nav.items.length - 1);
    });
    body.appendChild(list);
    panel.appendChild(body);

    const foot = el('div', 'ob-panel-foot');
    foot.appendChild(el('span', null, 'ESC — RESUME'));
    foot.appendChild(el('span', null, BUILD));
    panel.appendChild(foot);

    s.appendChild(panel);
    this._nav.set('pause', nav);
    this.screens.pause = s;
  }

  /* ---------------------------------------------------------------- */

  _buildSettings() {
    const st = this.game.settings;
    const s = this._screen('settings');
    this._texture(s, 'is-light');
    this._corners(s);

    const panel = el('div', 'ob-panel');
    const head = el('div', 'ob-panel-head');
    head.appendChild(el('div', 'ob-panel-title', 'SETTINGS'));
    head.appendChild(el('div', 'ob-panel-kicker', 'APPLIES LIVE'));
    panel.appendChild(head);

    const body = el('div', 'ob-panel-body');
    const nav = { items: [], index: 0 };

    const defs = [
      {
        type: 'segment', label: 'QUALITY PRESET',
        options: ['LOW', 'MEDIUM', 'HIGH', 'ULTRA'],
        get: () => String(st.preset || 'high').toUpperCase(),
        set: (v) => { st.applyPreset?.(v.toLowerCase()); },
      },
      { type: 'slider', label: 'FIELD OF VIEW', min: 65, max: 120, step: 1, unit: '°', key: 'fov' },
      { type: 'slider', label: 'LOOK SENSITIVITY', min: 0.2, max: 3, step: 0.05, key: 'sensitivity', digits: 2 },
      { type: 'toggle', label: 'INVERT LOOK', key: 'invertY' },
      { type: 'slider', label: 'EXPOSURE', min: 0.4, max: 2.0, step: 0.02, key: 'exposure', digits: 2 },
      { type: 'slider', label: 'FILM GRAIN', min: 0, max: 1, step: 0.02, key: 'filmGrain', digits: 2 },
      { type: 'slider', label: 'CHROMATIC ABERRATION', min: 0, max: 1, step: 0.02, key: 'chromaticAberration', digits: 2 },
      { type: 'slider', label: 'VIGNETTE', min: 0, max: 1, step: 0.02, key: 'vignette', digits: 2 },
      { type: 'slider', label: 'SHARPEN', min: 0, max: 1, step: 0.02, key: 'sharpen', digits: 2 },
      { type: 'slider', label: 'MASTER VOLUME', min: 0, max: 1, step: 0.02, key: 'masterVolume', digits: 2, onSet: (v) => this._applyVolume(v) },
      { type: 'toggle', label: 'PERFORMANCE READOUT', key: 'showFps' },
    ];

    for (const d of defs) {
      const row = this._settingsRow(d, st);
      body.appendChild(row.el);
      nav.items.push(row);
      this._wireItem('settings', row, nav.items.length - 1);
    }

    panel.appendChild(body);
    const foot = el('div', 'ob-panel-foot');
    foot.appendChild(el('span', null, 'ESC — BACK'));
    foot.appendChild(el('span', null, 'A / D — ADJUST'));
    panel.appendChild(foot);
    s.appendChild(panel);

    this._nav.set('settings', nav);
    this.screens.settings = s;
    this._settingRows = nav.items;
  }

  _settingsRow(def, st) {
    const row = el('div', 'ob-row');
    row.appendChild(el('div', 'ob-row-label', def.label));
    const mid = el('div', 'ob-row-mid');
    const val = el('div', 'ob-row-value');
    row.appendChild(mid);
    row.appendChild(val);

    const item = { el: row, def, refresh: () => {} };

    if (def.type === 'slider') {
      const track = el('div', 'ob-track');
      const fill = el('div', 'ob-track-fill');
      const knob = el('div', 'ob-track-knob');
      const ticks = el('div', 'ob-track-ticks');
      for (let i = 0; i < 5; i++) ticks.appendChild(el('i'));
      track.appendChild(ticks);
      track.appendChild(fill);
      track.appendChild(knob);
      mid.appendChild(track);

      const apply = (v) => {
        const q = Math.round(v / def.step) * def.step;
        st[def.key] = clamp(q, def.min, def.max);
        def.onSet?.(st[def.key]);
        this._markDirty();
        item.refresh();
      };
      item.refresh = () => {
        const v = clamp(Number(st[def.key] ?? def.min), def.min, def.max);
        const t = (v - def.min) / (def.max - def.min);
        fill.style.width = `${(t * 100).toFixed(2)}%`;
        knob.style.left = `${(t * 100).toFixed(2)}%`;
        val.textContent = `${def.digits ? v.toFixed(def.digits) : Math.round(v)}${def.unit || ''}`;
      };
      item.adjust = (dir) => apply(Number(st[def.key] ?? def.min) + dir * def.step * (def.max - def.min > 20 ? 1 : 1));
      item.activate = () => {};
      track.addEventListener('pointerdown', (e) => {
        this._drag = { track, apply, def };
        this._select('settings', this._indexOf('settings', item));
        this._onDragMove(e);
        this._click();
      });
    } else if (def.type === 'toggle') {
      const tog = el('div', 'ob-toggle');
      tog.appendChild(el('i'));
      row.replaceChild(tog, mid);
      const flip = () => {
        st[def.key] = !st[def.key];
        def.onSet?.(st[def.key]);
        this._markDirty();
        item.refresh();
        this._click();
      };
      item.refresh = () => {
        const on = !!st[def.key];
        tog.classList.toggle('is-on', on);
        val.textContent = on ? 'ON' : 'OFF';
      };
      item.activate = flip;
      item.adjust = flip;
      tog.addEventListener('click', (e) => { e.stopPropagation(); flip(); });
    } else if (def.type === 'segment') {
      const seg = el('div', 'ob-seg');
      const buttons = def.options.map((opt) => {
        const b = el('button', null, opt);
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          def.set(opt);
          this._markDirty();
          item.refresh();
          this._click();
        });
        seg.appendChild(b);
        return b;
      });
      mid.appendChild(seg);
      item.refresh = () => {
        const cur = def.get();
        buttons.forEach((b, i) => b.classList.toggle('is-on', def.options[i] === cur));
        val.textContent = '';
      };
      item.adjust = (dir) => {
        const cur = def.options.indexOf(def.get());
        const next = clamp((cur < 0 ? 0 : cur) + dir, 0, def.options.length - 1);
        def.set(def.options[next]);
        this._markDirty();
        item.refresh();
      };
      item.activate = () => item.adjust(1);
    }

    item.refresh();
    return item;
  }

  _applyVolume(v) {
    const audio = this.game.audio;
    audio?.mixer?.setMasterVolume?.(v);
  }

  /* ---------------------------------------------------------------- */

  _buildControls() {
    const s = this._screen('controls');
    this._texture(s, 'is-light');
    this._corners(s);

    const panel = el('div', 'ob-panel');
    const head = el('div', 'ob-panel-head');
    head.appendChild(el('div', 'ob-panel-title', 'CONTROLS'));
    head.appendChild(el('div', 'ob-panel-kicker', 'KEYBOARD & MOUSE'));
    panel.appendChild(head);

    const body = el('div', 'ob-panel-body');
    const grid = el('div', 'ob-keys');
    const bindings = this.game.input?.bindings || {};

    const addRow = (label, caps) => {
      const r = el('div', 'ob-key-row');
      r.appendChild(el('span', null, label));
      const wrap = el('span', 'ob-key-caps');
      for (const c of caps) wrap.appendChild(el('span', 'ob-cap', c));
      r.appendChild(wrap);
      grid.appendChild(r);
    };

    addRow('FIRE', ['LMB']);
    addRow('AIM DOWN SIGHT', ['RMB']);
    for (const [action, label] of ACTION_LABELS) {
      const keys = bindings[action];
      if (!keys?.length) continue;
      addRow(label, keys.slice(0, 2).map((k) => KEY_LABELS[k] || k.replace(/^Key|^Digit/, '')));
    }

    body.appendChild(grid);
    panel.appendChild(body);

    const foot = el('div', 'ob-panel-foot');
    foot.appendChild(el('span', null, 'ESC — BACK'));
    foot.appendChild(el('span', null, 'GAMEPAD SUPPORTED'));
    panel.appendChild(foot);
    s.appendChild(panel);

    this._nav.set('controls', { items: [], index: 0 });
    this.screens.controls = s;
  }

  _buildDead() {
    const s = this._screen('dead');
    this._texture(s, 'is-dead');

    const wrap = el('div', 'ob-dead-wrap');
    wrap.appendChild(el('div', 'ob-dead-title', 'KILLED IN ACTION'));
    this.deadSub = el('div', 'ob-dead-sub', 'ELIMINATED BY HOSTILE FIRE');
    wrap.appendChild(this.deadSub);
    const bar = el('div', 'ob-dead-bar');
    this.deadBar = el('i');
    bar.appendChild(this.deadBar);
    wrap.appendChild(bar);
    this.deadPrompt = el('div', 'ob-dead-prompt', 'PRESS [SPACE] TO REDEPLOY');
    wrap.appendChild(this.deadPrompt);
    s.appendChild(wrap);

    s.addEventListener('click', () => { if (this.deadReady) this._respawn(); });

    this._nav.set('dead', { items: [], index: 0 });
    this.screens.dead = s;
  }

  /* ================================================================== */
  /* navigation plumbing                                                */
  /* ================================================================== */

  _wireItem(screen, item, index) {
    item.el.addEventListener('mouseenter', () => {
      if (this.screen !== screen) return;
      this._select(screen, index);
      this._hover();
    });
    item.el.addEventListener('click', () => {
      if (this.screen !== screen) return;
      this._select(screen, index);
      item.activate?.();
      if (item.def?.type !== 'slider') this._click();
    });
  }

  _indexOf(screen, item) {
    const nav = this._nav.get(screen);
    return nav ? nav.items.indexOf(item) : 0;
  }

  _select(screen, index) {
    const nav = this._nav.get(screen);
    if (!nav || !nav.items.length) return;
    nav.index = clamp(index, 0, nav.items.length - 1);
    nav.items.forEach((it, i) => it.el.classList.toggle('is-sel', i === nav.index));
  }

  _move(dir) {
    const nav = this._nav.get(this.screen);
    if (!nav || !nav.items.length) return;
    let i = nav.index;
    for (let n = 0; n < nav.items.length; n++) {
      i = (i + dir + nav.items.length) % nav.items.length;
      if (!nav.items[i].disabled) break;
    }
    this._select(this.screen, i);
    this._hover();
  }

  _current() {
    const nav = this._nav.get(this.screen);
    return nav?.items[nav.index] || null;
  }

  /* ================================================================== */
  /* screen state                                                       */
  /* ================================================================== */

  show(screen, returnTo) {
    if (returnTo !== undefined) this.returnTo = returnTo;
    this.screen = screen;
    this.active = !!screen;

    for (const [id, node] of Object.entries(this.screens)) {
      node.classList.toggle('is-on', id === screen);
    }
    this.root.classList.toggle('is-active', this.active);

    if (screen === 'settings') this._settingRows?.forEach((r) => r.refresh());
    const nav = this._nav.get(screen);
    if (nav?.items.length) this._select(screen, nav.index);
  }

  _onState(next) {
    if (next === 'playing') {
      this.show(null);
    } else if (next === 'paused') {
      this.game.input?.exitLock?.();
      this.show('pause');
    } else if (next === 'dead') {
      this.deadTimer = 0;
      this.deadReady = false;
      this.deadPrompt?.classList.remove('is-on');
      this.game.input?.exitLock?.();
      this.show('dead');
    } else if (next === 'menu') {
      this.game.input?.exitLock?.();
      this.show('title');
    } else {
      this.show(null);
    }
  }

  _onDied(e) {
    if (this.deadSub) {
      const type = e?.type === 'explosion' ? 'EXPLOSIVE ORDNANCE' : 'HOSTILE FIRE';
      this.deadSub.textContent = `ELIMINATED BY ${type}`;
    }
  }

  /* ================================================================== */
  /* actions                                                            */
  /* ================================================================== */

  _startGame() {
    this._confirm();
    this.show(null);
    this.game.setState('playing');
    this.game.input?.requestLock?.();
    this.game.audio?.resume?.();
  }

  _resume() {
    this._confirm();
    this.show(null);
    this.game.setState('playing');
    this.game.input?.requestLock?.();
  }

  _toTitle() {
    this._back();
    this.game.input?.exitLock?.();
    this.game.setState('menu');
    this.show('title');
  }

  _respawn() {
    if (!this.deadReady) return;
    this._confirm();
    this.deadReady = false;
    this.show(null);
    const p = this.game.player;
    if (p?.respawn) p.respawn();
    else this.game.setState('playing');
    this.game.input?.requestLock?.();
  }

  _goBack() {
    if (this.screen === 'settings' || this.screen === 'controls') {
      this._back();
      const to = this.returnTo || 'title';
      this.show(to);
      if (to === 'pause' && this.game.state !== 'paused') this.game.setState('paused');
      return true;
    }
    if (this.screen === 'pause') { this._resume(); return true; }
    return false;
  }

  /* ================================================================== */
  /* input                                                              */
  /* ================================================================== */

  _handleKey(e) {
    if (!this.active) return;

    switch (e.code) {
      case 'ArrowUp': case 'KeyW': this._move(-1); e.preventDefault(); break;
      case 'ArrowDown': case 'KeyS': this._move(1); e.preventDefault(); break;
      case 'ArrowLeft': case 'KeyA': this._current()?.adjust?.(-1); e.preventDefault(); break;
      case 'ArrowRight': case 'KeyD': this._current()?.adjust?.(1); e.preventDefault(); break;
      case 'Enter': case 'NumpadEnter':
        if (this.screen === 'dead') this._respawn();
        else { this._current()?.activate?.(); this._click(); }
        e.preventDefault();
        break;
      case 'Space':
        if (this.screen === 'dead') this._respawn();
        else if (this.screen !== 'settings') { this._current()?.activate?.(); this._click(); }
        e.preventDefault();
        break;
      case 'Escape':
        this._ateEscape = 2;
        if (this._goBack()) e.preventDefault();
        break;
      default: break;
    }
  }

  _onDragMove(e) {
    const d = this._drag;
    if (!d) return;
    const r = d.track.getBoundingClientRect();
    const t = clamp01((e.clientX - r.left) / Math.max(1, r.width));
    d.apply(d.def.min + t * (d.def.max - d.def.min));
  }

  /* ================================================================== */
  /* per-frame                                                          */
  /* ================================================================== */

  update(dt) {
    const d = Math.min(dt || 0, 0.1);
    const game = this.game;

    if (this._ateEscape > 0) this._ateEscape--;

    // Pause from gameplay. The pointer-lock exit path already routes through
    // Game, this covers the un-locked (harness, windowed) case.
    if (game.state === 'playing' && this._ateEscape <= 0) {
      if (game.input?.actionPressed?.('pause')) {
        game.input.exitLock?.();
        game.setState('paused');
      }
    }

    if (game.state === 'dead') {
      this.deadTimer += d;
      const k = clamp01(this.deadTimer / 2.2);
      if (this.deadBar) this.deadBar.style.width = `${(k * 100).toFixed(1)}%`;
      if (!this.deadReady && k >= 1) {
        this.deadReady = true;
        this.deadPrompt?.classList.add('is-on');
      }
      // Never strand a player (or the harness) on the death screen.
      if (this.deadTimer > 9) this._respawn();
    }

    if (this._saveDirty) {
      this._saveTimer -= d;
      if (this._saveTimer <= 0) {
        this._saveDirty = false;
        try { this.game.settings?.save?.(); } catch { /* private mode */ }
      }
    }
  }

  _markDirty() {
    this._saveDirty = true;
    this._saveTimer = 0.35;
  }

  /* ---- audio cues (all optional-chained; audio may be gesture-gated) -- */
  _hover() { this.game.audio?.playUI?.('ui:hover', { volume: 0.22 }); }
  _click() { this.game.audio?.playUI?.('ui:click', { volume: 0.3 }); }
  _confirm() { this.game.audio?.playUI?.('ui:confirm', { volume: 0.42 }); }
  _back() { this.game.audio?.playUI?.('ui:back', { volume: 0.32 }); }

  dispose() {
    for (const off of this._unsub) { try { off?.(); } catch { /* gone */ } }
    this._unsub.length = 0;
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    this.root?.remove();
  }
}
