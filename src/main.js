import { Game } from './core/Game.js';
import { bus } from './core/EventBus.js';
import { Capture } from './core/Capture.js';

import { Physics } from './physics/Physics.js';
import { Materials } from './render/Materials.js';
import { World } from './world/World.js';
import { PostFX } from './render/PostFX.js';
import { Player } from './player/Player.js';
import { WeaponSystem } from './weapons/WeaponSystem.js';
import { VFX } from './vfx/VFX.js';
import { AISystem } from './ai/AISystem.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { HUD } from './ui/HUD.js';
import { Menu } from './ui/Menu.js';

const bootLabel = document.getElementById('boot-label');
const bootBar = document.getElementById('boot-bar');
const boot = document.getElementById('boot');

function progress(label, pct) {
  if (bootLabel) bootLabel.textContent = label;
  if (bootBar) bootBar.style.width = `${Math.round(pct * 100)}%`;
}

async function main() {
  const canvas = document.getElementById('game');
  const game = new Game(canvas);
  window.__GAME__ = game; // capture harness + debug console hook

  // Order matters: later systems read what earlier ones publish.
  const steps = [
    ['Compiling materials', () => game.register('materials', new Materials(game)).init(progress)],
    ['Building world', () => game.register('physics', new Physics(game)) && game.register('world', new World(game)).build()],
    ['Linking optics', () => game.register('postfx', new PostFX(game)).init()],
    ['Deploying operator', () => game.register('player', new Player(game)).init()],
    ['Racking weapons', () => game.register('weapons', new WeaponSystem(game)).init()],
    ['Priming effects', () => game.register('vfx', new VFX(game)).init()],
    ['Briefing hostiles', () => game.register('ai', new AISystem(game)).init()],
    ['Calibrating audio', () => game.register('audio', new AudioEngine(game)).init()],
    ['Painting HUD', () => game.register('hud', new HUD(game)).init()],
    ['Ready', () => game.register('menu', new Menu(game)).init()],
    ['Ready', () => game.register('capture', new Capture(game)).init()],
  ];

  for (let i = 0; i < steps.length; i++) {
    const [label, fn] = steps[i];
    progress(label, i / steps.length);
    await fn();
    // Yield so the boot bar actually paints between heavy steps.
    await new Promise((r) => requestAnimationFrame(r));
  }
  progress('Ready', 1);

  // Warm the shader cache before the first interactive frame; a hitch on the
  // first shot is the most obvious "this is a web demo" tell there is.
  await game.postfx.precompile?.();

  boot?.remove();
  game.start();
  game.setState('menu');
  bus.emit('boot:complete');
  window.__READY__ = true;
}

main().catch((err) => {
  console.error(err);
  window.__BOOT_ERROR__ = String(err?.stack || err);
  if (boot) {
    boot.innerHTML = `<pre style="color:#e06c5a;font:12px/1.5 monospace;padding:24px;white-space:pre-wrap">${
      String(err?.stack || err).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))
    }</pre>`;
  }
});
