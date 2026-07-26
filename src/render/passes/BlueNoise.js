import * as THREE from 'three';

/**
 * Procedural blue-noise (void-and-cluster, Ulichney 1993).
 *
 * White noise dithering is the single most obvious "web demo" tell in a dark
 * scene: it clumps, it crawls, and TAA cannot integrate it. Void-and-cluster
 * gives a mask whose energy sits entirely in the high frequencies, so a 1/255
 * dither disappears at any viewing distance and volumetric raymarch offsets
 * converge in a handful of frames instead of a hundred.
 *
 * Two independent masks are generated (~60 ms total for 64x64) and packed into
 * RGBA together with two toroidal shifts, giving four decorrelated channels.
 */

const SIZE = 64;
const SIGMA = 1.9;
const KERNEL_RADIUS = 6;

function buildKernel() {
  const d = KERNEL_RADIUS * 2 + 1;
  const k = new Float32Array( d * d );
  const inv = 1 / ( 2 * SIGMA * SIGMA );
  for ( let y = -KERNEL_RADIUS; y <= KERNEL_RADIUS; y++ ) {
    for ( let x = -KERNEL_RADIUS; x <= KERNEL_RADIUS; x++ ) {
      k[ ( y + KERNEL_RADIUS ) * d + ( x + KERNEL_RADIUS ) ] = Math.exp( -( x * x + y * y ) * inv );
    }
  }
  return k;
}

const KERNEL = buildKernel();
const KD = KERNEL_RADIUS * 2 + 1;

function splat( energy, index, sign ) {
  const px = index % SIZE;
  const py = ( index / SIZE ) | 0;
  for ( let ky = 0; ky < KD; ky++ ) {
    const y = ( py + ky - KERNEL_RADIUS + SIZE ) % SIZE;
    const row = y * SIZE;
    const krow = ky * KD;
    for ( let kx = 0; kx < KD; kx++ ) {
      const x = ( px + kx - KERNEL_RADIUS + SIZE ) % SIZE;
      energy[ row + x ] += sign * KERNEL[ krow + kx ];
    }
  }
}

function tightestCluster( energy, binary ) {
  let best = -1, bestE = -Infinity;
  for ( let i = 0; i < energy.length; i++ ) {
    if ( binary[ i ] === 1 && energy[ i ] > bestE ) { bestE = energy[ i ]; best = i; }
  }
  return best;
}

function largestVoid( energy, binary ) {
  let best = -1, bestE = Infinity;
  for ( let i = 0; i < energy.length; i++ ) {
    if ( binary[ i ] === 0 && energy[ i ] < bestE ) { bestE = energy[ i ]; best = i; }
  }
  return best;
}

/** Deterministic PRNG so the mask is identical on every machine and every run. */
function mulberry32( a ) {
  return function () {
    a |= 0; a = ( a + 0x6D2B79F5 ) | 0;
    let t = Math.imul( a ^ ( a >>> 15 ), 1 | a );
    t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
    return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;
  };
}

function generateMask( seed ) {
  const N = SIZE * SIZE;
  const rng = mulberry32( seed );
  const binary = new Uint8Array( N );
  const energy = new Float32Array( N );

  // --- initial pattern: 10% ones, scattered -------------------------------
  const M0 = Math.floor( N * 0.1 );
  let placed = 0;
  while ( placed < M0 ) {
    const i = ( rng() * N ) | 0;
    if ( binary[ i ] === 0 ) { binary[ i ] = 1; splat( energy, i, 1 ); placed++; }
  }

  // --- phase 0: relax into a prototype binary pattern ----------------------
  for ( let iter = 0; iter < N * 2; iter++ ) {
    const c = tightestCluster( energy, binary );
    binary[ c ] = 0; splat( energy, c, -1 );
    const v = largestVoid( energy, binary );
    if ( v === c ) { binary[ c ] = 1; splat( energy, c, 1 ); break; }
    binary[ v ] = 1; splat( energy, v, 1 );
  }

  const rank = new Int32Array( N ).fill( -1 );
  const M = placed;

  // --- phase 1: strip the prototype, ranking downwards --------------------
  {
    const b = binary.slice();
    const e = energy.slice();
    for ( let r = M - 1; r >= 0; r-- ) {
      const c = tightestCluster( e, b );
      if ( c < 0 ) break;
      b[ c ] = 0; splat( e, c, -1 );
      rank[ c ] = r;
    }
  }

  // --- phase 2: fill voids up to half density -----------------------------
  const b2 = binary.slice();
  const e2 = energy.slice();
  const half = N >> 1;
  for ( let r = M; r < half; r++ ) {
    const v = largestVoid( e2, b2 );
    if ( v < 0 ) break;
    b2[ v ] = 1; splat( e2, v, 1 );
    rank[ v ] = r;
  }

  // --- phase 3: minority flips to zeros; rank the tightest clusters of 0s --
  const e3 = new Float32Array( N );
  for ( let i = 0; i < N; i++ ) if ( b2[ i ] === 0 ) splat( e3, i, 1 );
  for ( let r = half; r < N; r++ ) {
    // tightest cluster of zeros == max energy among the zero set
    let best = -1, bestE = -Infinity;
    for ( let i = 0; i < N; i++ ) {
      if ( b2[ i ] === 0 && e3[ i ] > bestE ) { bestE = e3[ i ]; best = i; }
    }
    if ( best < 0 ) break;
    b2[ best ] = 1; splat( e3, best, -1 );
    rank[ best ] = r;
  }

  const out = new Float32Array( N );
  const inv = 1 / ( N - 1 );
  for ( let i = 0; i < N; i++ ) out[ i ] = Math.max( 0, rank[ i ] ) * inv;
  return out;
}

let _cached = null;

/**
 * @returns {THREE.DataTexture} 64x64 RGBA8, NearestFilter, RepeatWrapping.
 */
export function createBlueNoiseTexture() {
  if ( _cached ) return _cached;

  const N = SIZE * SIZE;
  const a = generateMask( 0x9e3779b9 );
  const b = generateMask( 0x517cc1b7 );

  const data = new Uint8Array( N * 4 );
  const shift = ( arr, dx, dy, i ) => {
    const x = ( i % SIZE + dx ) % SIZE;
    const y = ( ( ( i / SIZE ) | 0 ) + dy ) % SIZE;
    return arr[ y * SIZE + x ];
  };

  for ( let i = 0; i < N; i++ ) {
    data[ i * 4 + 0 ] = Math.round( a[ i ] * 255 );
    data[ i * 4 + 1 ] = Math.round( b[ i ] * 255 );
    data[ i * 4 + 2 ] = Math.round( shift( a, 29, 13, i ) * 255 );
    data[ i * 4 + 3 ] = Math.round( shift( b, 11, 41, i ) * 255 );
  }

  const tex = new THREE.DataTexture( data, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType );
  tex.name = 'blueNoise64';
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  _cached = tex;
  return tex;
}

export const BLUE_NOISE_SIZE = SIZE;
