import * as THREE from 'three';

/**
 * Procedural 32x32x32 colour LUT, baked into a 1024x32 slice strip.
 *
 * This is the "look" layer that sits on top of the tone mapper: split-toned
 * shadows/highlights, a filmic S-curve, a slight hue push that pulls foliage
 * and desert sand towards the olive/khaki palette modern military shooters
 * use, and a highlight desaturation that stops muzzle flashes and sun hits
 * from clipping to flat white.
 *
 * Everything runs in display-referred space (post tone map), which is what a
 * real 3D LUT from a DI suite expects.
 */

const SIZE = 32;

function clamp01( x ) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function lerp( a, b, t ) { return a + ( b - a ) * t; }
function smoothstep( e0, e1, x ) {
  const t = clamp01( ( x - e0 ) / ( e1 - e0 ) );
  return t * t * ( 3 - 2 * t );
}

function rgbToHsl( r, g, b, out ) {
  const max = Math.max( r, g, b ), min = Math.min( r, g, b );
  const l = ( max + min ) * 0.5;
  let h = 0, s = 0;
  if ( max !== min ) {
    const d = max - min;
    s = l > 0.5 ? d / ( 2 - max - min ) : d / ( max + min );
    if ( max === r ) h = ( g - b ) / d + ( g < b ? 6 : 0 );
    else if ( max === g ) h = ( b - r ) / d + 2;
    else h = ( r - g ) / d + 4;
    h /= 6;
  }
  out[ 0 ] = h; out[ 1 ] = s; out[ 2 ] = l;
  return out;
}

function hue2rgb( p, q, t ) {
  if ( t < 0 ) t += 1;
  if ( t > 1 ) t -= 1;
  if ( t < 1 / 6 ) return p + ( q - p ) * 6 * t;
  if ( t < 1 / 2 ) return q;
  if ( t < 2 / 3 ) return p + ( q - p ) * ( 2 / 3 - t ) * 6;
  return p;
}

function hslToRgb( h, s, l, out ) {
  if ( s === 0 ) { out[ 0 ] = out[ 1 ] = out[ 2 ] = l; return out; }
  const q = l < 0.5 ? l * ( 1 + s ) : l + s - l * s;
  const p = 2 * l - q;
  out[ 0 ] = hue2rgb( p, q, h + 1 / 3 );
  out[ 1 ] = hue2rgb( p, q, h );
  out[ 2 ] = hue2rgb( p, q, h - 1 / 3 );
  return out;
}

const LOOKS = {
  /** Default: cool shadows, warm skin/highlights, mild teal-orange separation. */
  blackout: {
    shadowTint: [ 0.86, 0.94, 1.09 ],
    midTint: [ 1.005, 1.0, 0.985 ],
    highTint: [ 1.055, 1.005, 0.935 ],
    contrast: 1.075,
    pivot: 0.42,
    saturation: 1.06,
    shadowSat: 0.88,
    highlightSat: 0.80,
    hueShift: -0.012,
    olive: 0.22,
    toe: 0.030,
    shoulder: 0.965,
  },
  neutral: {
    shadowTint: [ 1, 1, 1 ], midTint: [ 1, 1, 1 ], highTint: [ 1, 1, 1 ],
    contrast: 1.0, pivot: 0.435, saturation: 1.0, shadowSat: 1.0, highlightSat: 1.0,
    hueShift: 0, olive: 0, toe: 0, shoulder: 1.0,
  },
  nightvision: {
    shadowTint: [ 0.55, 1.12, 0.72 ], midTint: [ 0.62, 1.20, 0.70 ], highTint: [ 0.80, 1.15, 0.82 ],
    contrast: 1.18, pivot: 0.38, saturation: 0.35, shadowSat: 0.2, highlightSat: 0.3,
    hueShift: 0.0, olive: 0.0, toe: 0.02, shoulder: 0.98,
  },
};

const _hsl = [ 0, 0, 0 ];
const _rgb = [ 0, 0, 0 ];

function gradePixel( r, g, b, L ) {
  // --- split tone -----------------------------------------------------------
  let lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const shadowW = 1 - smoothstep( 0.0, 0.42, lum );
  const highW = smoothstep( 0.55, 1.0, lum );
  const midW = 1 - shadowW - highW;

  const tr = L.shadowTint[ 0 ] * shadowW + L.midTint[ 0 ] * midW + L.highTint[ 0 ] * highW;
  const tg = L.shadowTint[ 1 ] * shadowW + L.midTint[ 1 ] * midW + L.highTint[ 1 ] * highW;
  const tb = L.shadowTint[ 2 ] * shadowW + L.midTint[ 2 ] * midW + L.highTint[ 2 ] * highW;
  r *= tr; g *= tg; b *= tb;

  // --- filmic contrast around a photographic pivot --------------------------
  r = ( r - L.pivot ) * L.contrast + L.pivot;
  g = ( g - L.pivot ) * L.contrast + L.pivot;
  b = ( b - L.pivot ) * L.contrast + L.pivot;

  // --- toe / shoulder: never let the image reach absolute black or white ----
  const toe = L.toe, sh = L.shoulder;
  r = toe + ( sh - toe ) * clamp01( r );
  g = toe + ( sh - toe ) * clamp01( g );
  b = toe + ( sh - toe ) * clamp01( b );

  // --- saturation, luminance dependent --------------------------------------
  lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const satW = L.saturation * lerp( L.shadowSat, 1.0, smoothstep( 0.0, 0.35, lum ) )
                            * lerp( 1.0, L.highlightSat, smoothstep( 0.6, 1.0, lum ) );
  r = lum + ( r - lum ) * satW;
  g = lum + ( g - lum ) * satW;
  b = lum + ( b - lum ) * satW;

  // --- hue work: global rotation + a targeted pull of greens toward olive ----
  if ( L.hueShift !== 0 || L.olive !== 0 ) {
    rgbToHsl( clamp01( r ), clamp01( g ), clamp01( b ), _hsl );
    _hsl[ 0 ] = ( _hsl[ 0 ] + L.hueShift + 1 ) % 1;
    if ( L.olive > 0 ) {
      // 0.25..0.42 in hue == the green band; drag it towards 0.19 (khaki)
      const inBand = smoothstep( 0.20, 0.28, _hsl[ 0 ] ) * ( 1 - smoothstep( 0.40, 0.50, _hsl[ 0 ] ) );
      _hsl[ 0 ] = lerp( _hsl[ 0 ], 0.185, inBand * L.olive );
      _hsl[ 1 ] *= 1 - inBand * L.olive * 0.35;
    }
    hslToRgb( _hsl[ 0 ], _hsl[ 1 ], _hsl[ 2 ], _rgb );
    r = _rgb[ 0 ]; g = _rgb[ 1 ]; b = _rgb[ 2 ];
  }

  return [ clamp01( r ), clamp01( g ), clamp01( b ) ];
}

/**
 * @param {string} look key into LOOKS
 * @returns {THREE.DataTexture} 1024x32 RGBA8 slice strip
 */
export function createLUTTexture( look = 'blackout' ) {
  const L = LOOKS[ look ] || LOOKS.blackout;
  const w = SIZE * SIZE, h = SIZE;
  const data = new Uint8Array( w * h * 4 );
  const inv = 1 / ( SIZE - 1 );

  for ( let bz = 0; bz < SIZE; bz++ ) {
    const bv = bz * inv;
    for ( let gy = 0; gy < SIZE; gy++ ) {
      const gv = gy * inv;
      for ( let rx = 0; rx < SIZE; rx++ ) {
        const rv = rx * inv;
        const c = gradePixel( rv, gv, bv, L );
        const o = ( gy * w + bz * SIZE + rx ) * 4;
        data[ o ] = Math.round( c[ 0 ] * 255 );
        data[ o + 1 ] = Math.round( c[ 1 ] * 255 );
        data[ o + 2 ] = Math.round( c[ 2 ] * 255 );
        data[ o + 3 ] = 255;
      }
    }
  }

  const tex = new THREE.DataTexture( data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType );
  tex.name = `colorLUT_${look}`;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export const LUT_SIZE = SIZE;
export const LUT_LOOKS = Object.keys( LOOKS );
