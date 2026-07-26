/**
 * Deterministic gradient noise, generated in code — no tables shipped, no assets.
 *
 * The camera rig needs *coherent* randomness rather than white noise: a shake
 * built from `Math.random()` reads as static, while band-limited noise reads as
 * a hand-held camera. Everything here is a classic Perlin construction with a
 * permutation table shuffled by a seeded xorshift at module load, so the same
 * frame in the capture harness always produces the same shake.
 */

const PERM = new Uint8Array(512);
const GRAD1 = new Float32Array(256);

(function buildTables() {
  const src = new Uint8Array(256);
  for (let i = 0; i < 256; i++) src[i] = i;

  let s = 0x9e3779b9 >>> 0;
  const rnd = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };

  for (let i = 255; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = src[i]; src[i] = src[j]; src[j] = t;
  }
  for (let i = 0; i < 512; i++) PERM[i] = src[i & 255];

  // 1D gradients spread over [-1,1] but never near zero, which would flatten
  // the curve into visible dead spots.
  for (let i = 0; i < 256; i++) {
    const u = src[i] / 255;
    const g = u * 2 - 1;
    GRAD1[i] = g >= 0 ? 0.35 + g * 0.65 : -0.35 + g * 0.65;
  }
})();

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a, b, t) { return a + (b - a) * t; }

/** 1D Perlin noise, roughly in [-1, 1]. The workhorse for shake and sway. */
export function noise1(x) {
  const xi = Math.floor(x);
  const xf = x - xi;
  const u = fade(xf);
  const g0 = GRAD1[xi & 255];
  const g1 = GRAD1[(xi + 1) & 255];
  return lerp(g0 * xf, g1 * (xf - 1), u) * 2.2;
}

const G2 = [
  1, 1, -1, 1, 1, -1, -1, -1,
  0.7071, 0, -0.7071, 0, 0, 0.7071, 0, -0.7071,
];

function grad2(hash, x, y) {
  const h = (hash & 7) * 2;
  return G2[h] * x + G2[h + 1] * y;
}

/** 2D Perlin noise in roughly [-1, 1]; used where two decorrelated axes matter. */
export function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = fade(xf), v = fade(yf);
  const X = xi & 255, Y = yi & 255;
  const aa = PERM[PERM[X] + Y];
  const ab = PERM[PERM[X] + Y + 1];
  const ba = PERM[PERM[X + 1] + Y];
  const bb = PERM[PERM[X + 1] + Y + 1];
  const x1 = lerp(grad2(aa, xf, yf), grad2(ba, xf - 1, yf), u);
  const x2 = lerp(grad2(ab, xf, yf - 1), grad2(bb, xf - 1, yf - 1), u);
  return lerp(x1, x2, v) * 1.4;
}

/** Fractal 1D noise. `octaves` beyond 3 is wasted on a 60 Hz camera. */
export function fbm1(x, octaves = 3, lacunarity = 2.03, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise1(x * freq + i * 41.7) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Deterministic hash -> [0,1), for per-shake seeds. */
export function hash01(i) {
  const h = PERM[(i * 37) & 255] * 256 + PERM[(i * 91 + 13) & 255];
  return h / 65536;
}
