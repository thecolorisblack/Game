import { buildRifle } from './Rifle.js';
import { buildSmg } from './Smg.js';
import { buildSniper } from './Sniper.js';
import { buildPistol } from './Pistol.js';

/** Model builder registry, keyed by `WEAPONS[].model`. */
export const MODEL_BUILDERS = {
  rifle: buildRifle,
  smg: buildSmg,
  sniper: buildSniper,
  pistol: buildPistol,
};

export { buildRifle, buildSmg, buildSniper, buildPistol };
export { buildPalette, WEAR } from './Palette.js';
export { buildHand, HAND_POSES } from './Hands.js';
