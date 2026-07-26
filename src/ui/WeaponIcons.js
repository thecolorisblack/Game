/**
 * OPERATION BLACKOUT — weapon silhouettes.
 *
 * Vector side-profiles used by the killfeed and the ammo block. Authored in a
 * unit box (x 0..1, y 0..0.8, y down) as filled polygons, so a single set of
 * coordinates covers a 16 px killfeed row and a 90 px HUD silhouette with the
 * same crispness. No sprite sheets, no fonts-as-icons.
 */

/** @type {Record<string, number[][][]>} */
const SHAPES = {
  rifle: [
    // upper receiver + rail
    [[0.20, 0.30], [0.74, 0.30], [0.74, 0.42], [0.20, 0.42]],
    [[0.30, 0.26], [0.62, 0.26], [0.62, 0.30], [0.30, 0.30]],
    // handguard
    [[0.74, 0.32], [0.92, 0.32], [0.92, 0.41], [0.74, 0.41]],
    [[0.74, 0.345], [0.92, 0.345], [0.92, 0.355], [0.74, 0.355]],
    // barrel + brake
    [[0.92, 0.345], [0.985, 0.345], [0.985, 0.385], [0.92, 0.385]],
    [[0.965, 0.315], [1.0, 0.315], [1.0, 0.415], [0.965, 0.415]],
    // optic
    [[0.36, 0.16], [0.58, 0.16], [0.58, 0.25], [0.36, 0.25]],
    [[0.40, 0.25], [0.44, 0.25], [0.44, 0.29], [0.40, 0.29]],
    [[0.52, 0.25], [0.56, 0.25], [0.56, 0.29], [0.52, 0.29]],
    // stock
    [[0.0, 0.27], [0.20, 0.31], [0.20, 0.44], [0.03, 0.47], [0.0, 0.43]],
    [[0.06, 0.36], [0.19, 0.35], [0.19, 0.40], [0.06, 0.41]],
    // grip
    [[0.27, 0.42], [0.38, 0.42], [0.345, 0.68], [0.245, 0.68]],
    // magazine
    [[0.45, 0.42], [0.58, 0.42], [0.615, 0.74], [0.485, 0.74]],
    // trigger guard
    [[0.38, 0.42], [0.46, 0.42], [0.46, 0.53], [0.38, 0.53]],
  ],

  smg: [
    [[0.26, 0.30], [0.70, 0.30], [0.70, 0.44], [0.26, 0.44]],
    [[0.36, 0.25], [0.60, 0.25], [0.60, 0.30], [0.36, 0.30]],
    [[0.70, 0.33], [0.86, 0.33], [0.86, 0.42], [0.70, 0.42]],
    [[0.86, 0.35], [0.96, 0.35], [0.96, 0.40], [0.86, 0.40]],
    [[0.94, 0.325], [1.0, 0.325], [1.0, 0.41], [0.94, 0.41]],
    // folding stock struts
    [[0.02, 0.30], [0.26, 0.32], [0.26, 0.355], [0.05, 0.335]],
    [[0.02, 0.30], [0.055, 0.30], [0.055, 0.46], [0.02, 0.46]],
    [[0.02, 0.435], [0.26, 0.415], [0.26, 0.45], [0.05, 0.465]],
    // grip + mag (grip integral, mag through it)
    [[0.33, 0.44], [0.45, 0.44], [0.435, 0.78], [0.315, 0.78]],
    [[0.46, 0.44], [0.52, 0.44], [0.52, 0.54], [0.46, 0.54]],
  ],

  sniper: [
    [[0.16, 0.31], [0.66, 0.31], [0.66, 0.43], [0.16, 0.43]],
    // long heavy barrel
    [[0.66, 0.345], [0.98, 0.345], [0.98, 0.39], [0.66, 0.39]],
    [[0.955, 0.325], [1.0, 0.325], [1.0, 0.41], [0.955, 0.41]],
    // big glass
    [[0.30, 0.12], [0.62, 0.12], [0.62, 0.24], [0.30, 0.24]],
    [[0.27, 0.10], [0.32, 0.10], [0.32, 0.26], [0.27, 0.26]],
    [[0.60, 0.11], [0.66, 0.11], [0.66, 0.25], [0.60, 0.25]],
    [[0.34, 0.24], [0.38, 0.24], [0.38, 0.30], [0.34, 0.30]],
    [[0.54, 0.24], [0.58, 0.24], [0.58, 0.30], [0.54, 0.30]],
    // skeleton stock
    [[0.0, 0.26], [0.16, 0.30], [0.16, 0.36], [0.0, 0.33]],
    [[0.0, 0.44], [0.16, 0.41], [0.16, 0.47], [0.02, 0.50]],
    [[0.0, 0.26], [0.04, 0.26], [0.04, 0.50], [0.0, 0.50]],
    [[0.22, 0.43], [0.33, 0.43], [0.30, 0.70], [0.20, 0.70]],
    [[0.42, 0.43], [0.54, 0.43], [0.56, 0.66], [0.44, 0.66]],
    // bipod
    [[0.80, 0.39], [0.83, 0.39], [0.74, 0.62], [0.71, 0.62]],
    [[0.82, 0.39], [0.85, 0.39], [0.90, 0.62], [0.87, 0.62]],
  ],

  pistol: [
    // slide
    [[0.30, 0.26], [0.98, 0.26], [0.98, 0.38], [0.30, 0.38]],
    [[0.34, 0.235], [0.42, 0.235], [0.42, 0.26], [0.34, 0.26]],
    [[0.88, 0.235], [0.94, 0.235], [0.94, 0.26], [0.88, 0.26]],
    // frame
    [[0.30, 0.38], [0.80, 0.38], [0.80, 0.45], [0.30, 0.45]],
    // grip
    [[0.30, 0.38], [0.50, 0.38], [0.44, 0.82], [0.22, 0.82]],
    // trigger guard
    [[0.50, 0.45], [0.62, 0.45], [0.62, 0.58], [0.50, 0.58]],
    [[0.50, 0.55], [0.66, 0.55], [0.66, 0.60], [0.50, 0.60]],
  ],

  shotgun: [
    [[0.18, 0.31], [0.62, 0.31], [0.62, 0.44], [0.18, 0.44]],
    [[0.62, 0.325], [1.0, 0.325], [1.0, 0.40], [0.62, 0.40]],
    [[0.66, 0.41], [0.86, 0.41], [0.86, 0.50], [0.66, 0.50]],
    [[0.0, 0.28], [0.18, 0.32], [0.18, 0.46], [0.02, 0.50], [0.0, 0.44]],
    [[0.28, 0.44], [0.39, 0.44], [0.36, 0.68], [0.26, 0.68]],
  ],

  knife: [
    [[0.10, 0.36], [0.62, 0.28], [0.94, 0.40], [0.62, 0.46], [0.10, 0.44]],
    [[0.02, 0.34], [0.12, 0.33], [0.12, 0.47], [0.02, 0.46]],
    [[0.0, 0.30], [0.04, 0.30], [0.04, 0.50], [0.0, 0.50]],
  ],

  grenade: [
    [[0.34, 0.24], [0.66, 0.24], [0.72, 0.38], [0.68, 0.62], [0.32, 0.62], [0.28, 0.38]],
    [[0.42, 0.16], [0.58, 0.16], [0.58, 0.24], [0.42, 0.24]],
    [[0.58, 0.14], [0.78, 0.14], [0.78, 0.19], [0.62, 0.19], [0.62, 0.40], [0.58, 0.40]],
  ],

  explosive: [
    [[0.30, 0.30], [0.70, 0.30], [0.76, 0.50], [0.50, 0.72], [0.24, 0.50]],
    [[0.44, 0.16], [0.56, 0.16], [0.56, 0.30], [0.44, 0.30]],
  ],
};

/** Class-name / id fuzzy resolve so a new weapon never draws nothing. */
export function iconIdFor(weapon) {
  if (!weapon) return 'rifle';
  const key = String(weapon.id || weapon.model || weapon.name || weapon.className || '').toLowerCase();
  if (SHAPES[key]) return key;
  if (/knife|melee|blade|bayonet/.test(key)) return 'knife';
  if (/nade|frag|grenade/.test(key)) return 'grenade';
  if (/rpg|rocket|launch|explos|c4/.test(key)) return 'explosive';
  if (/shotgun|buck|slug/.test(key)) return 'shotgun';
  if (/sniper|dmr|marksman|longbow|bolt/.test(key)) return 'sniper';
  if (/smg|wraith|sub/.test(key)) return 'smg';
  if (/pistol|sidearm|handgun|p-?45/.test(key)) return 'pistol';
  return 'rifle';
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} id     one of the SHAPES keys, or anything iconIdFor resolves
 * @param {number} x      left
 * @param {number} y      vertical centre of the silhouette
 * @param {number} w      icon width in px
 */
export function drawWeaponIcon(ctx, id, x, y, w, color = '#e6edf2', alpha = 1, opts = {}) {
  const shape = SHAPES[id] || SHAPES[iconIdFor({ id })];
  if (!shape) return;
  const s = w;
  const flip = opts.flip ? -1 : 1;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x + (opts.flip ? w : 0), y - s * 0.46 * 0.8);
  ctx.scale(flip, 1);

  const path = new Path2D();
  for (const poly of shape) {
    for (let i = 0; i < poly.length; i++) {
      const px = poly[i][0] * s;
      const py = poly[i][1] * s * 0.8;
      if (i === 0) path.moveTo(px, py);
      else path.lineTo(px, py);
    }
    path.closePath();
  }

  if (opts.halo !== false) {
    ctx.strokeStyle = opts.haloColor || 'rgba(2,4,6,0.55)';
    ctx.lineWidth = Math.max(1.2, s * 0.035);
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  }
  ctx.fillStyle = color;
  ctx.fill(path);
  ctx.restore();
}

export { SHAPES as WEAPON_SHAPES };
