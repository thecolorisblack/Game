/**
 * OPERATION BLACKOUT — menu chrome.
 *
 * The stylesheet and the two procedural textures the menus sit on: a fine film
 * grain and a scanline field, both baked into canvases at boot and handed to
 * CSS as data URLs. No external font, no image, no CDN.
 *
 * Type is deliberately thin, uppercase and widely letterspaced; there is
 * exactly one accent colour and one danger colour, and motion is limited to
 * short opacity/translate transitions so the UI reads as equipment rather than
 * as a website.
 */

import { bakeGrain } from './Draw.js';

/** OffscreenCanvas has no toDataURL, so grain has to bake into a real element. */
function domCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function grainDataUrl() {
  const size = 128;
  const src = bakeGrain(size, 0x2F13, 3, 0.0);
  const c = domCanvas(size, size);
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0);
  try { return c.toDataURL('image/png'); } catch { return ''; }
}

function scanDataUrl() {
  const c = domCanvas(4, 4);
  const g = c.getContext('2d');
  g.clearRect(0, 0, 4, 4);
  g.fillStyle = 'rgba(0,0,0,0.42)';
  g.fillRect(0, 0, 4, 1);
  g.fillStyle = 'rgba(0,0,0,0.14)';
  g.fillRect(0, 2, 4, 1);
  try { return c.toDataURL('image/png'); } catch { return ''; }
}

export function injectStyles() {
  if (document.getElementById('ob-menu-style')) return document.getElementById('ob-menu-style');
  const grain = grainDataUrl();
  const scan = scanDataUrl();

  const css = `
:root {
  --ob-accent: #e8b562;
  --ob-accent-hot: #ffd79a;
  --ob-ink: #e6edf2;
  --ob-ink-dim: #93a3ad;
  --ob-ink-faint: #5d6b75;
  --ob-danger: #ff4b3a;
  --ob-bg: #04070a;
  --ob-face: "Rajdhani","DIN Alternate","Bahnschrift","Oswald","Roboto Condensed",system-ui,sans-serif;
}

.ob-root {
  position: absolute; inset: 0;
  pointer-events: none;
  font-family: var(--ob-face);
  color: var(--ob-ink);
  -webkit-font-smoothing: antialiased;
  cursor: default;
  z-index: 4;
}
.ob-root.is-active { pointer-events: auto; }

.ob-screen {
  position: absolute; inset: 0;
  opacity: 0;
  visibility: hidden;
  transition: opacity .26s cubic-bezier(.22,.61,.36,1);
}
.ob-screen.is-on { opacity: 1; visibility: visible; }

/* ---- shared surfaces ------------------------------------------------ */

.ob-scrim {
  position: absolute; inset: 0;
  background:
    radial-gradient(120% 90% at 18% 50%, rgba(4,7,10,0.94) 0%, rgba(4,7,10,0.72) 38%, rgba(4,7,10,0.30) 68%, rgba(4,7,10,0.55) 100%);
  backdrop-filter: blur(9px) saturate(0.72) brightness(0.72);
  -webkit-backdrop-filter: blur(9px) saturate(0.72) brightness(0.72);
}
.ob-scrim.is-light {
  background: linear-gradient(180deg, rgba(4,7,10,0.86) 0%, rgba(4,7,10,0.74) 45%, rgba(4,7,10,0.90) 100%);
}
.ob-scrim.is-dead {
  background:
    radial-gradient(120% 110% at 50% 46%, rgba(60,6,4,0.28) 0%, rgba(9,3,3,0.86) 62%, rgba(4,2,2,0.97) 100%);
  backdrop-filter: blur(5px) saturate(0.28) brightness(0.55);
  -webkit-backdrop-filter: blur(5px) saturate(0.28) brightness(0.55);
}

.ob-tex {
  position: absolute; inset: 0;
  pointer-events: none;
  background-image: url("${grain}");
  background-size: 180px 180px;
  opacity: .28;
  mix-blend-mode: overlay;
}
.ob-scan {
  position: absolute; inset: 0;
  pointer-events: none;
  background-image: url("${scan}");
  background-size: 100% 4px;
  opacity: .30;
}
.ob-edge {
  position: absolute; inset: 0;
  pointer-events: none;
  box-shadow: inset 0 0 180px 40px rgba(0,0,0,0.72);
}

/* ---- title screen ---------------------------------------------------- */

.ob-title-wrap {
  position: absolute;
  left: clamp(36px, 7vw, 132px);
  top: 50%;
  transform: translateY(-50%);
  max-width: min(46vw, 720px);
}
.ob-title-canvas { display: block; width: 100%; height: auto; margin-bottom: 6px; }

.ob-sub {
  font-size: clamp(10px, 0.86vw, 13px);
  letter-spacing: .58em;
  text-transform: uppercase;
  color: var(--ob-ink-dim);
  margin: 4px 0 0 3px;
}
.ob-rule {
  height: 1px; margin: 22px 0 26px 3px;
  background: linear-gradient(90deg, rgba(232,181,98,.85), rgba(232,181,98,.10) 62%, transparent);
}

/* ---- menu list ------------------------------------------------------- */

.ob-list { list-style: none; margin: 0; padding: 0; }
.ob-item {
  position: relative;
  display: flex; align-items: baseline; gap: 16px;
  padding: 9px 0 9px 22px;
  font-size: clamp(15px, 1.35vw, 22px);
  font-weight: 500;
  letter-spacing: .34em;
  text-transform: uppercase;
  color: var(--ob-ink-dim);
  cursor: pointer;
  transition: color .16s ease, transform .18s cubic-bezier(.22,.61,.36,1), letter-spacing .18s ease;
  user-select: none;
}
.ob-item::before {
  content: ""; position: absolute; left: 0; top: 50%;
  width: 3px; height: 0; transform: translateY(-50%);
  background: var(--ob-accent);
  transition: height .18s cubic-bezier(.22,.61,.36,1);
}
.ob-item .ob-idx {
  font-size: .52em; letter-spacing: .18em; color: var(--ob-ink-faint);
  transition: color .16s ease;
}
.ob-item.is-sel { color: var(--ob-ink); transform: translateX(9px); letter-spacing: .40em; }
.ob-item.is-sel::before { height: 62%; }
.ob-item.is-sel .ob-idx { color: var(--ob-accent); }
.ob-item.is-disabled { opacity: .35; cursor: default; }

/* ---- pause / panel --------------------------------------------------- */

.ob-panel {
  position: absolute; left: 50%; top: 50%;
  transform: translate(-50%, -50%);
  width: min(760px, 84vw);
  max-height: 84vh;
  padding: 34px 40px 30px;
  background: linear-gradient(180deg, rgba(8,12,16,.86), rgba(4,7,10,.92));
  border: 1px solid rgba(150,170,182,.16);
  box-shadow: 0 40px 120px rgba(0,0,0,.6);
  clip-path: polygon(0 14px, 14px 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%);
  display: flex; flex-direction: column;
}
.ob-panel-head {
  display: flex; align-items: flex-end; justify-content: space-between;
  border-bottom: 1px solid rgba(232,181,98,.24);
  padding-bottom: 12px; margin-bottom: 18px;
}
.ob-panel-title {
  font-size: clamp(16px, 1.6vw, 24px);
  letter-spacing: .46em; text-transform: uppercase; font-weight: 600;
}
.ob-panel-kicker {
  font-size: 10px; letter-spacing: .46em; text-transform: uppercase;
  color: var(--ob-accent);
}
.ob-panel-body { overflow-y: auto; overflow-x: hidden; padding-right: 6px; }
.ob-panel-body::-webkit-scrollbar { width: 4px; }
.ob-panel-body::-webkit-scrollbar-thumb { background: rgba(232,181,98,.42); }
.ob-panel-foot {
  margin-top: 18px; padding-top: 12px;
  border-top: 1px solid rgba(150,170,182,.14);
  display: flex; justify-content: space-between;
  font-size: 10px; letter-spacing: .32em; color: var(--ob-ink-faint);
  text-transform: uppercase;
}

/* ---- settings rows --------------------------------------------------- */

.ob-row {
  display: grid; grid-template-columns: 1fr minmax(180px, 46%) 62px;
  align-items: center; gap: 18px;
  padding: 11px 12px; margin: 2px 0;
  border-left: 2px solid transparent;
  cursor: pointer;
  transition: background .16s ease, border-color .16s ease;
}
.ob-row:hover { background: rgba(232,181,98,.05); }
.ob-row.is-sel { background: rgba(232,181,98,.09); border-left-color: var(--ob-accent); }
.ob-row-label {
  font-size: 12px; letter-spacing: .26em; text-transform: uppercase;
  color: var(--ob-ink-dim);
}
.ob-row.is-sel .ob-row-label { color: var(--ob-ink); }
.ob-row-value {
  font-size: 12px; letter-spacing: .16em; text-align: right;
  color: var(--ob-accent); font-variant-numeric: tabular-nums;
}

.ob-track {
  position: relative; height: 3px;
  background: rgba(150,170,182,.18);
}
.ob-track-fill { position: absolute; left: 0; top: 0; bottom: 0; background: var(--ob-accent); }
.ob-track-knob {
  position: absolute; top: 50%; width: 3px; height: 13px;
  transform: translate(-50%, -50%);
  background: var(--ob-accent-hot);
  box-shadow: 0 0 8px rgba(232,181,98,.55);
  transition: height .16s ease;
}
.ob-row.is-sel .ob-track-knob { height: 17px; }
.ob-track-ticks { position: absolute; inset: 0; display: flex; justify-content: space-between; }
.ob-track-ticks i { width: 1px; height: 3px; background: rgba(150,170,182,.30); }

.ob-seg { display: flex; gap: 3px; }
.ob-seg button {
  flex: 1; appearance: none; background: rgba(150,170,182,.06);
  border: 1px solid rgba(150,170,182,.16); color: var(--ob-ink-dim);
  font: inherit; font-size: 10px; letter-spacing: .22em; text-transform: uppercase;
  padding: 6px 2px; cursor: pointer;
  transition: background .14s ease, color .14s ease, border-color .14s ease;
}
.ob-seg button:hover { color: var(--ob-ink); border-color: rgba(232,181,98,.40); }
.ob-seg button.is-on {
  background: rgba(232,181,98,.16); border-color: var(--ob-accent); color: var(--ob-accent-hot);
}

.ob-toggle {
  position: relative; width: 46px; height: 16px; justify-self: end;
  border: 1px solid rgba(150,170,182,.26); background: rgba(150,170,182,.06);
}
.ob-toggle i {
  position: absolute; top: 2px; left: 2px; width: 18px; height: 10px;
  background: var(--ob-ink-faint);
  transition: transform .18s cubic-bezier(.22,.61,.36,1), background .18s ease;
}
.ob-toggle.is-on { border-color: rgba(232,181,98,.6); }
.ob-toggle.is-on i { transform: translateX(24px); background: var(--ob-accent); }

/* ---- controls table --------------------------------------------------- */

.ob-keys { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 34px; }
.ob-key-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 4px; border-bottom: 1px solid rgba(150,170,182,.08);
  font-size: 11px; letter-spacing: .24em; text-transform: uppercase;
  color: var(--ob-ink-dim);
}
.ob-key-caps { display: flex; gap: 5px; }
.ob-cap {
  min-width: 26px; padding: 3px 7px; text-align: center;
  border: 1px solid rgba(232,181,98,.34); color: var(--ob-accent);
  font-size: 10px; letter-spacing: .12em;
  background: rgba(232,181,98,.07);
}

/* ---- death screen ----------------------------------------------------- */

.ob-dead-wrap {
  position: absolute; left: 50%; top: 46%; transform: translate(-50%, -50%);
  text-align: center; width: min(720px, 90vw);
}
.ob-dead-title {
  font-size: clamp(20px, 2.9vw, 44px); font-weight: 600;
  letter-spacing: .30em; text-transform: uppercase; color: #f0e2d8;
  text-shadow: 0 0 40px rgba(190,30,20,.55);
  white-space: nowrap;
}
.ob-dead-sub {
  margin-top: 14px; font-size: 12px; letter-spacing: .42em;
  text-transform: uppercase; color: var(--ob-ink-dim);
}
.ob-dead-bar {
  margin: 30px auto 0; width: min(420px, 70%); height: 2px;
  background: rgba(150,170,182,.18);
}
.ob-dead-bar i { display: block; height: 100%; width: 0%; background: var(--ob-danger); }
.ob-dead-prompt {
  margin-top: 22px; font-size: 12px; letter-spacing: .40em; text-transform: uppercase;
  color: var(--ob-accent); opacity: 0; transition: opacity .3s ease;
}
.ob-dead-prompt.is-on { opacity: 1; }

/* ---- corners + footer ------------------------------------------------- */

.ob-corner {
  position: absolute; width: 26px; height: 26px;
  border: 1px solid rgba(232,181,98,.5); pointer-events: none;
}
.ob-corner.tl { left: 22px; top: 22px; border-right: 0; border-bottom: 0; }
.ob-corner.tr { right: 22px; top: 22px; border-left: 0; border-bottom: 0; }
.ob-corner.bl { left: 22px; bottom: 22px; border-right: 0; border-top: 0; }
.ob-corner.br { right: 22px; bottom: 22px; border-left: 0; border-top: 0; }

.ob-foot {
  position: absolute; left: 0; right: 0; bottom: 26px;
  display: flex; justify-content: space-between;
  padding: 0 clamp(36px, 7vw, 132px);
  font-size: 10px; letter-spacing: .38em; text-transform: uppercase;
  color: var(--ob-ink-faint);
}
.ob-foot b { color: var(--ob-accent); font-weight: 500; }
`;

  const style = document.createElement('style');
  style.id = 'ob-menu-style';
  style.textContent = css;
  document.head.appendChild(style);
  return style;
}
