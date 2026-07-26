import * as THREE from 'three';
import {
  PartBin, chamferBox, extrude, lathe, cylZ, tubeZ, taperZ, torusZ, place,
  roundedRectShape, roundedRectHole, circleHole, polyShape, annulusSectorShape,
  picatinnyRail, mlokPanel, slottedPanel, screwZ, hexZ, knurlBand, bendZ, mergeParts,
} from './Parts.js';

/**
 * Shared firearm sub-assemblies.
 *
 * Frame convention for every weapon in this project:
 *   -Z  muzzle / forward      +Y  up (sights)      +X  ejection side (right)
 * The origin sits on the bore axis at the rear face of the receiver, so recoil
 * rotation about the origin reads as muzzle climb without extra pivots.
 *
 * Every factory returns a `PartBin` keyed by palette material name, so a weapon
 * ends up as roughly six merged draw calls plus its animated parts.
 */

/* ==================================================================== */
/* magazine                                                              */
/* ==================================================================== */

/**
 * A curved box magazine. Built straight along +Z, arc-bent, then stood upright
 * so the feed lips sit at the origin and the body hangs down and forward.
 */
export function magazine(opts = {}) {
  const bin = new PartBin();
  const w = opts.width ?? 0.0298;
  const t = opts.depth ?? 0.0250;
  const len = opts.length ?? 0.183;
  const curve = opts.curve ?? -1 / 0.46;
  const mat = opts.material ?? 'polymer';

  const parts = [];
  // body: rounded-rect cross-section swept the length of the magazine
  parts.push(chamferBox(w, t, len, 0.0026, { round: 0.005, curveSegments: 3 }));

  // reinforcing ribs down both flats — the detail that reads as "polymer mag"
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const rib = chamferBox(0.0022, t * 0.72, len * 0.9, 0.0007);
      rib.translate(sx * (w * 0.5 - 0.0006), 0, -len * 0.02 + (i - 1) * 0.0075);
      parts.push(rib);
    }
    // witness-hole rims
    for (let i = 0; i < 4; i++) {
      const ring = torusZ(0.0030, 0.0008, 10, 5);
      ring.rotateY(Math.PI * 0.5);
      ring.translate(sx * (w * 0.5 - 0.0002), 0, -len * 0.28 + i * 0.030);
      parts.push(ring);
    }
  }
  // spine ridge on the rear face
  const spine = chamferBox(w * 0.45, 0.0022, len * 0.94, 0.0008);
  spine.translate(0, t * 0.5 - 0.0004, 0);
  parts.push(spine);

  let body = mergeParts(parts);
  bendZ(body, curve, -len * 0.5);
  body.rotateX(Math.PI * 0.5);
  body.translate(0, -len * 0.5 + 0.004, 0);
  bin.add(mat, body);

  // --- floor plate ---------------------------------------------------
  const floorY = -len * 0.985;
  const floorZ = ((1 / curve) - 0) * (1 - Math.cos(len * curve)) * -1;
  const plate = chamferBox(w + 0.0032, t + 0.0030, 0.0135, 0.0016, { round: 0.004 });
  plate.rotateX(Math.PI * 0.5);
  plate.rotateX(-len * curve * 0.5);
  plate.translate(0, floorY + 0.006, floorZ * 0.5);
  bin.add(opts.floorMaterial ?? 'grip', plate);

  const lip = chamferBox(w * 0.55, 0.0055, 0.004, 0.0008);
  lip.rotateX(Math.PI * 0.5);
  lip.translate(0, floorY + 0.014, floorZ * 0.5 - t * 0.5 - 0.0018);
  bin.add('steel', lip);

  // --- feed lips + a visible round under them -------------------------
  const lips = chamferBox(w * 0.96, t * 0.98, 0.010, 0.0012);
  lips.rotateX(Math.PI * 0.5);
  lips.translate(0, -0.004, 0);
  bin.add('steel', lips);

  if (opts.round !== false) {
    const ogive = lathe([
      [0.00285, 0], [0.0026, 0.004], [0.0016, 0.0088], [0.0005, 0.0112], [2e-5, 0.0118],
    ], 12);
    ogive.translate(0, 0, 0.010);
    const round = mergeParts([cylZ(0.00285, 0.020, 12, 0.0004), ogive]);
    round.rotateY(Math.PI * 0.5);
    round.translate(-0.002, 0.0025, 0);
    bin.add('brass', round);
  }

  return { bin, length: len, width: w, depth: t };
}

/* ==================================================================== */
/* grip / trigger group                                                  */
/* ==================================================================== */

/** Ergonomic pistol grip: silhouette extruded across, plus front-strap ridges. */
export function pistolGrip(opts = {}) {
  const bin = new PartBin();
  const width = opts.width ?? 0.0325;
  const mat = opts.material ?? 'grip';
  const profile = opts.profile ?? [
    [-0.004, 0.004], [0.008, -0.026], [0.017, -0.055], [0.024, -0.083],
    [0.029, -0.101], [0.049, -0.108], [0.058, -0.100], [0.058, -0.070],
    [0.052, -0.040], [0.045, -0.012], [0.038, 0.006],
  ];
  const body = extrude(polyShape(profile), width, 0.0075, { curveSegments: 3, bevelSegments: 3 });
  body.rotateY(-Math.PI * 0.5);
  bin.add(mat, body);

  // front-strap finger swells
  for (let i = 0; i < 3; i++) {
    const f = i / 2;
    const ridge = cylZ(0.0032 - i * 0.0002, width * 0.86, 10, 0.0006);
    ridge.rotateY(Math.PI * 0.5);
    ridge.rotateZ(0.30);
    ridge.translate(0, -0.028 - i * 0.026, 0.0075 + i * 0.0075);
    bin.add(mat, ridge);
  }
  // backstrap texture panel
  const back = chamferBox(width * 0.80, 0.062, 0.0042, 0.0010);
  back.rotateX(0.22);
  back.translate(0, -0.055, 0.052);
  bin.add(mat, back);

  // grip cap / storage door
  const cap = chamferBox(width * 0.86, 0.0130, 0.028, 0.0016);
  cap.rotateX(Math.PI * 0.5);
  cap.rotateX(0.30);
  cap.translate(0, -0.106, 0.041);
  bin.add(opts.capMaterial ?? 'polymer', cap);

  return { bin, width };
}

/**
 * Trigger guard (a real closed loop with a real opening), trigger blade,
 * magazine release and bolt catch. Returns the trigger as its own bin so the
 * viewmodel can animate the blade against the pull.
 */
export function triggerGroup(opts = {}) {
  const bin = new PartBin();
  const width = opts.width ?? 0.0098;
  const cz = opts.centerZ ?? -0.030;
  const cy = opts.centerY ?? -0.030;

  const guard = roundedRectShape(0.079, 0.050, 0.014);
  guard.holes.push(roundedRectHole(0.004, 0.002, 0.062, 0.034, 0.012));
  const gg = extrude(guard, width, 0.0016, { curveSegments: 5 });
  gg.rotateY(-Math.PI * 0.5);
  gg.translate(0, cy, cz);
  bin.add(opts.material ?? 'gunmetal', gg);

  // trigger blade — curved, grooved face
  const tri = new PartBin();
  const blade = extrude(polyShape([
    [0.0, 0.0], [0.0055, -0.004], [0.0085, -0.014], [0.0085, -0.026],
    [0.0045, -0.030], [-0.0015, -0.026], [-0.003, -0.012],
  ]), 0.0072, 0.0011, { curveSegments: 3 });
  blade.rotateY(-Math.PI * 0.5);
  tri.add('steel', blade);
  for (let i = 0; i < 3; i++) {
    const gr = cylZ(0.0005, 0.0068, 6, 0.0001);
    gr.rotateY(Math.PI * 0.5);
    gr.translate(0.0, -0.014 - i * 0.005, 0.0085);
    tri.add('steel', gr);
  }

  // magazine release button + fence
  const relFence = tubeZ(0.0088, 0.0055, 0.0075, 12, 0.0006);
  relFence.rotateY(Math.PI * 0.5);
  relFence.translate(0.019, cy + 0.026, cz + 0.030);
  bin.add(opts.material ?? 'gunmetal', relFence);
  const relBtn = cylZ(0.0053, 0.0090, 12, 0.0009);
  relBtn.rotateY(Math.PI * 0.5);
  relBtn.translate(0.0205, cy + 0.026, cz + 0.030);
  bin.add('blued', relBtn);

  // bolt catch on the left
  const catchArm = chamferBox(0.0060, 0.0125, 0.030, 0.0012);
  catchArm.translate(-0.0205, cy + 0.030, cz + 0.014);
  bin.add('blued', catchArm);
  const catchPad = chamferBox(0.0042, 0.0115, 0.0115, 0.0010);
  catchPad.translate(-0.0225, cy + 0.030, cz + 0.026);
  bin.add('blued', catchPad);

  return { bin, trigger: tri, triggerPivot: new THREE.Vector3(0, cy + 0.018, cz + 0.020) };
}

/* ==================================================================== */
/* muzzle devices                                                        */
/* ==================================================================== */

/** A2-style birdcage: real slots between real bars, closed bottom, crush washer. */
export function birdcage(opts = {}) {
  const bin = new PartBin();
  const rO = opts.radius ?? 0.0110;
  const rI = opts.bore ?? 0.0040;
  const len = opts.length ?? 0.050;
  const bars = opts.bars ?? 6;
  const gap = opts.gap ?? 0.30;      // fraction of each sector that is open
  const wall = rO - rI - 0.0012;

  // crush washer + rear collar
  const washer = lathe([[rI + 0.001, 0], [rO * 1.02, 0], [rO * 1.02, 0.0022], [rI + 0.001, 0.0022]], 18);
  washer.translate(0, 0, len * 0.5 - 0.0022);
  bin.add('steel', washer);
  const collar = tubeZ(rO, rI + 0.0006, 0.0125, 20, 0.0009);
  collar.translate(0, 0, len * 0.5 - 0.0085);
  bin.add('blued', collar);

  // slotted section
  const slotLen = len - 0.024;
  for (let i = 0; i < bars; i++) {
    const a0 = (i / bars) * Math.PI * 2 + (gap * Math.PI) / bars;
    const a1 = ((i + 1) / bars) * Math.PI * 2 - (gap * Math.PI) / bars;
    const bar = extrude(annulusSectorShape(rO * 0.96, rO * 0.96 - wall, a0, a1, 5), slotLen, 0.0006, { curveSegments: 4 });
    bar.translate(0, 0, -0.0025);
    bin.add('blued', bar);
  }
  // closed bottom (real A2 hiders are solid underneath so they don't kick dust)
  const floor = extrude(annulusSectorShape(rO * 0.96, rO * 0.96 - wall, Math.PI * 1.15, Math.PI * 1.85, 6), slotLen, 0.0006, { curveSegments: 5 });
  floor.translate(0, 0, -0.0025);
  bin.add('blued', floor);

  // front ring
  const ring = tubeZ(rO * 0.99, rI + 0.0004, 0.0055, 20, 0.0008);
  ring.translate(0, 0, -len * 0.5 + 0.0028);
  bin.add('blued', ring);

  // bore
  const bore = cylZ(rI, len * 0.98, 16, 0.0003);
  bin.add('bore', bore);

  return { bin, length: len, radius: rO };
}

/** Ported compensator/brake: stacked baffles with genuinely open side ports. */
export function muzzleBrake(opts = {}) {
  const bin = new PartBin();
  const rO = opts.radius ?? 0.0128;
  const rI = opts.bore ?? 0.0045;
  const len = opts.length ?? 0.072;
  const ports = opts.ports ?? 4;
  const step = (len - 0.018) / ports;

  const collar = tubeZ(rO * 0.94, rI + 0.0008, 0.014, 20, 0.0010);
  collar.translate(0, 0, len * 0.5 - 0.007);
  bin.add('blued', collar);

  for (let i = 0; i < ports; i++) {
    const z = len * 0.5 - 0.016 - i * step;
    // baffle plate
    const baffle = lathe([
      [rI + 0.0006, 0], [rO, 0], [rO, -0.0042], [rI + 0.0006, -0.0042],
    ], 22);
    baffle.translate(0, 0, z - step + 0.0042);
    bin.add('blued', baffle);
    // side walls that leave top + side ports open
    for (const a of [Math.PI * 1.12, Math.PI * 1.55]) {
      const wallSeg = extrude(annulusSectorShape(rO, rO - 0.0022, a, a + Math.PI * 0.33, 5), step - 0.0042, 0.0005, { curveSegments: 4 });
      wallSeg.translate(0, 0, z - step * 0.5 + 0.002);
      bin.add('blued', wallSeg);
    }
    // small top jet ports (open upward, for the muzzle-rise look)
    const strut = extrude(annulusSectorShape(rO, rO - 0.0022, Math.PI * 0.44, Math.PI * 0.56, 4), step - 0.0042, 0.0005, { curveSegments: 3 });
    strut.translate(0, 0, z - step * 0.5 + 0.002);
    bin.add('blued', strut);
  }

  const front = tubeZ(rO, rI + 0.0004, 0.0060, 22, 0.0008);
  front.translate(0, 0, -len * 0.5 + 0.003);
  bin.add('blued', front);
  bin.add('bore', cylZ(rI, len * 0.98, 16, 0.0003));

  return { bin, length: len, radius: rO };
}

/** Threaded barrel step + knurled thread protector, for pistols/SMGs. */
export function threadedTip(opts = {}) {
  const bin = new PartBin();
  const r = opts.radius ?? 0.0076;
  const len = opts.length ?? 0.016;
  bin.add('steel', knurlBand(r, len, 8, 0.0005, 18));
  bin.add('steel', place(tubeZ(r * 0.98, r * 0.62, 0.0035, 18, 0.0005), { p: [0, 0, -len * 0.5] }));
  bin.add('bore', cylZ(r * 0.6, len, 14, 0.0002));
  return { bin, length: len };
}

/* ==================================================================== */
/* barrel / gas system                                                   */
/* ==================================================================== */

/**
 * Stepped, fluted barrel. `profile` is [[radius, z], ...] from breech to muzzle
 * in the weapon frame (z decreasing).
 */
export function barrel(opts = {}) {
  const bin = new PartBin();
  const profile = opts.profile ?? [
    [0.0132, -0.060], [0.0132, -0.098], [0.0102, -0.104], [0.0102, -0.208],
    [0.0089, -0.214], [0.0089, -0.372], [0.0082, -0.378], [0.0082, -0.404],
  ];
  const pts = profile.map((p) => [p[0], p[1]]);
  // closed ends so the barrel is not a hollow shell in the ejection port
  const prof = [[2e-5, pts[0][1]], ...pts, [2e-5, pts[pts.length - 1][1]]];
  const g = lathe(prof.map((p) => [p[0], p[1]]), opts.segments ?? 22, { axis: 'z' });
  bin.add(opts.material ?? 'steel', g);

  if (opts.flutes) {
    const [z0, z1] = opts.flutes;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const fl = cylZ(0.0016, Math.abs(z1 - z0), 6, 0.0003);
      fl.scale(2.4, 1, 1);
      fl.rotateZ(a);
      fl.translate(Math.cos(a) * 0.0092, Math.sin(a) * 0.0092, (z0 + z1) * 0.5);
      bin.add('bore', fl);
    }
  }

  bin.add('bore', place(cylZ(opts.bore ?? 0.0040, 0.02, 14, 0.0002), {
    p: [0, 0, profile[profile.length - 1][1] + 0.006],
  }));
  return { bin };
}

/** Low-profile gas block with a gas tube running back over the barrel. */
export function gasBlock(opts = {}) {
  const bin = new PartBin();
  const z = opts.z ?? -0.235;
  const r = opts.barrelRadius ?? 0.0089;
  const body = chamferBox(0.0225, 0.0245, 0.036, 0.0018, { round: 0.0035 });
  body.translate(0, -0.0015, z);
  bin.add('blued', body);
  bin.add('blued', place(cylZ(r + 0.0022, 0.038, 16, 0.0008), { p: [0, 0, z] }));
  // gas tube
  const tubeLen = opts.tubeLength ?? 0.20;
  bin.add('steel', place(cylZ(0.0026, tubeLen, 10, 0.0004), { p: [0, 0.0088, z + tubeLen * 0.5 - 0.004] }));
  // set screws
  for (const sx of [-1, 1]) {
    bin.add('steel', place(screwZ(0.0019, 0.0009, 0.002), { r: [0, sx * Math.PI * 0.5, 0], p: [sx * 0.0114, -0.002, z + 0.008] }));
  }
  return { bin };
}

/* ==================================================================== */
/* handguard                                                             */
/* ==================================================================== */

/**
 * Free-float octagonal handguard: eight real panels with cut-through M-LOK
 * slots and vent holes, a full-length top rail, and machined end collars.
 */
export function handguard(opts = {}) {
  const bin = new PartBin();
  const len = opts.length ?? 0.225;
  const r = opts.radius ?? 0.0232;
  const z = opts.z ?? -0.185;
  const thick = opts.thickness ?? 0.0034;
  const mat = opts.material ?? 'alloy';
  const faces = 8;
  const faceW = 2 * r * Math.tan(Math.PI / faces) * 0.995;

  for (let i = 0; i < faces; i++) {
    const a = (i / faces) * Math.PI * 2;
    if (Math.abs(Math.sin(a) - 1) < 0.1) continue; // top facet carries the rail
    const isCardinal = Math.abs(Math.cos(a)) > 0.9 || Math.sin(a) < -0.9;
    const panel = isCardinal
      ? mlokPanel(len * 0.92, faceW, thick, { slotW: 0.0080, slotL: 0.0320, pitch: 0.0440, vents: true, ventR: 0.0030 })
      : slottedPanel(len * 0.92, faceW * 0.96, thick, 5, { slotW: faceW * 0.34, slotL: 0.020 });
    panel.rotateZ(a - Math.PI * 0.5);
    panel.translate(Math.cos(a) * (r - thick * 0.5), Math.sin(a) * (r - thick * 0.5), z);
    bin.add(mat, panel);
  }

  // structural spine under the top rail
  const spine = chamferBox(0.024, thick * 1.4, len * 0.96, 0.0008);
  spine.translate(0, r - thick, z);
  bin.add(mat, spine);

  // end collars
  bin.add(mat, place(tubeZ(r + 0.0012, r - thick - 0.0018, 0.0165, 26, 0.0012), { p: [0, 0, z + len * 0.5 - 0.008] }));
  bin.add(mat, place(tubeZ(r * 0.985, r - thick - 0.0016, 0.0125, 26, 0.0012), { p: [0, 0, z - len * 0.5 + 0.006] }));
  // barrel nut, knurled, just visible behind the rear collar
  bin.add('blued', place(knurlBand(r - 0.0018, 0.020, 14, 0.0007, 24), { p: [0, 0, z + len * 0.5 + 0.008] }));

  // anti-rotation screws around the rear collar, driven radially inward
  const collarZ = z + len * 0.5 - 0.008;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI * 0.25;
    const s = screwZ(0.0020, 0.0009, 0.0026);
    s.rotateX(-Math.PI * 0.5);            // head faces +Y
    s.rotateZ(a - Math.PI * 0.5);          // swing it round to this facet
    s.translate(Math.cos(a) * (r + 0.0013), Math.sin(a) * (r + 0.0013), collarZ);
    bin.add('steel', s);
  }

  return { bin, radius: r, length: len, z };
}

/* ==================================================================== */
/* stock                                                                 */
/* ==================================================================== */

/** Carbine buffer tube with real position notches. */
export function bufferTube(opts = {}) {
  const bin = new PartBin();
  const r = opts.radius ?? 0.0148;
  const len = opts.length ?? 0.205;
  const z = opts.z ?? 0.130;
  const prof = [[2e-5, -len * 0.5], [r, -len * 0.5]];
  const notches = opts.notches ?? 6;
  for (let i = 0; i < notches; i++) {
    const zz = -len * 0.5 + 0.036 + i * 0.0215;
    prof.push([r, zz - 0.004], [r - 0.0022, zz - 0.0018], [r - 0.0022, zz + 0.0018], [r, zz + 0.004]);
  }
  prof.push([r, len * 0.5 - 0.004], [r - 0.0018, len * 0.5], [2e-5, len * 0.5]);
  const g = lathe(prof, 22, {});
  g.translate(0, 0, z);
  bin.add(opts.material ?? 'alloy', g);

  // castle nut + receiver end plate
  bin.add('blued', place(knurlBand(r + 0.0032, 0.0115, 10, 0.0009, 20), { p: [0, 0, z - len * 0.5 + 0.006] }));
  bin.add('blued', place(chamferBox(0.032, 0.036, 0.0038, 0.0009), { p: [0, 0, z - len * 0.5 - 0.001] }));
  return { bin, radius: r, length: len, z };
}

/** Adjustable stock: body wrapping the tube, cheek riser, ribbed buttpad. */
export function adjustableStock(opts = {}) {
  const bin = new PartBin();
  const tubeR = opts.tubeRadius ?? 0.0148;
  const z = opts.z ?? 0.185;
  const len = opts.length ?? 0.100;
  const mat = opts.material ?? 'polymer';

  // body cross-section: tall slab with a hole for the buffer tube
  const body = roundedRectShape(0.0345, 0.075, 0.008);
  body.holes.push(circleHole(0, 0.008, tubeR + 0.0008, 16));
  const bg = extrude(body, len, 0.0026, { curveSegments: 4 });
  bg.translate(0, -0.005, z);
  bin.add(mat, bg);

  // toe / comb sculpting
  const comb = chamferBox(0.0300, 0.0155, len * 0.86, 0.0030, { round: 0.005 });
  comb.rotateX(-0.06);
  comb.translate(0, 0.0335, z - 0.004);
  bin.add(mat, comb);

  // cheek riser (adjustable, sits proud with a visible post)
  const riser = chamferBox(0.0290, 0.0130, len * 0.72, 0.0032, { round: 0.006 });
  riser.rotateX(-0.05);
  riser.translate(0, 0.0455 + (opts.riserHeight ?? 0), z - 0.006);
  bin.add(opts.riserMaterial ?? 'grip', riser);
  for (const sx of [-1, 1]) {
    bin.add('steel', place(cylZ(0.0022, 0.010, 8, 0.0003), {
      r: [Math.PI * 0.5, 0, 0], p: [sx * 0.0105, 0.0400, z - 0.012],
    }));
  }

  // sling loop through the body
  const loop = roundedRectShape(0.020, 0.026, 0.006);
  loop.holes.push(roundedRectHole(0, 0, 0.010, 0.014, 0.004));
  const lg = extrude(loop, 0.0075, 0.0010, { curveSegments: 4 });
  lg.rotateY(Math.PI * 0.5);
  lg.translate(-0.0185, -0.020, z + len * 0.5 - 0.020);
  bin.add(mat, lg);

  // adjustment lever under the tube
  const lever = extrude(polyShape([
    [0, 0], [0.030, 0], [0.034, -0.012], [0.026, -0.017], [0.004, -0.014],
  ]), 0.0135, 0.0014, { curveSegments: 2 });
  lever.rotateY(-Math.PI * 0.5);
  lever.translate(0, -0.030, z - 0.016);
  bin.add(mat, lever);

  // buttpad: rubber, with real ribs
  const padZ = z + len * 0.5 + 0.008;
  const pad = chamferBox(0.0335, 0.088, 0.0165, 0.0030, { round: 0.007 });
  pad.rotateX(0.10);
  pad.translate(0, 0.004, padZ);
  bin.add('rubber', pad);
  for (let i = 0; i < 4; i++) {
    const rib = chamferBox(0.0300, 0.0038, 0.0060, 0.0012);
    rib.rotateX(0.10);
    rib.translate(0, 0.028 - i * 0.0175, padZ + 0.0075 - i * 0.0004);
    bin.add('rubber', rib);
  }

  return { bin, z, length: len, buttZ: padZ + 0.009 };
}

/* ==================================================================== */
/* controls                                                              */
/* ==================================================================== */

/** Ambidextrous charging handle: shaft plus a latch wing. */
export function chargingHandle(opts = {}) {
  const bin = new PartBin();
  const len = opts.length ?? 0.080;
  const shaft = chamferBox(0.0195, 0.0082, len, 0.0013, { round: 0.0022 });
  shaft.translate(0, 0, len * 0.5);
  bin.add('alloy', shaft);
  const latch = extrude(polyShape([
    [0, 0], [0.030, 0], [0.033, 0.0075], [0.028, 0.011], [0.004, 0.010], [0, 0.006],
  ]), 0.0052, 0.0010, { curveSegments: 2 });
  latch.rotateX(Math.PI * 0.5);
  latch.rotateZ(Math.PI * 0.5);
  latch.translate(-0.0125, 0.0005, len - 0.012);
  bin.add('alloy', latch);
  const latch2 = latch.clone();
  latch2.scale(-1, 1, 1);
  bin.add('alloy', latch2);
  // serrations on the wing
  for (let i = 0; i < 4; i++) {
    bin.add('alloy', place(chamferBox(0.0060, 0.0016, 0.0022, 0.0004), {
      p: [-0.0245, 0.0055, len - 0.020 + i * 0.005],
    }));
  }
  return { bin, length: len };
}

/** Ejection-port dust cover: a real hinged door with a spring pin. */
export function dustCover(opts = {}) {
  const bin = new PartBin();
  const w = opts.width ?? 0.052;
  const h = opts.height ?? 0.030;
  const door = extrude(roundedRectShape(w, h, 0.0035), 0.0028, 0.0009, { curveSegments: 3 });
  door.rotateY(Math.PI * 0.5);
  bin.add('blued', door);
  // stiffening rib and the "port" lettering ledge
  bin.add('blued', place(chamferBox(0.0028, h * 0.62, w * 0.86, 0.0006), { p: [0.0022, 0, 0] }));
  bin.add('blued', place(chamferBox(0.0034, 0.0050, w * 0.94, 0.0008), { p: [0.0016, h * 0.42, 0] }));
  // hinge knuckles
  for (const s of [-1, 1]) {
    bin.add('steel', place(cylZ(0.0028, 0.010, 10, 0.0004), { p: [0.0012, -h * 0.5 - 0.001, s * (w * 0.5 - 0.008)] }));
  }
  return { bin, width: w, height: h };
}

/** Bolt carrier group — visible through the ejection port when it cycles. */
export function boltCarrier(opts = {}) {
  const bin = new PartBin();
  const r = opts.radius ?? 0.0122;
  const len = opts.length ?? 0.098;
  bin.add('steel', place(cylZ(r, len, 18, 0.0010), { p: [0, 0, 0] }));
  // gas key
  bin.add('blued', place(chamferBox(0.0135, 0.0105, 0.026, 0.0012), { p: [0, r + 0.0038, len * 0.5 - 0.020] }));
  bin.add('steel', place(cylZ(0.0030, 0.020, 10, 0.0004), { p: [0, r + 0.0072, len * 0.5 - 0.006] }));
  // cam pin
  bin.add('blued', place(cylZ(0.0035, 0.0075, 10, 0.0005), { r: [Math.PI * 0.5, 0, 0], p: [0, r - 0.0005, 0.006] }));
  // bolt face with lugs
  const face = lathe([
    [2e-5, 0], [0.0088, 0], [0.0088, 0.0055], [0.0062, 0.0058], [0.0062, 0.0125], [2e-5, 0.0125],
  ], 16);
  face.rotateX(Math.PI * 0.5);
  face.rotateX(Math.PI);
  face.translate(0, 0, -len * 0.5 - 0.006);
  bin.add('steel', face);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    bin.add('steel', place(chamferBox(0.0030, 0.0030, 0.0065, 0.0004), {
      p: [Math.cos(a) * 0.0075, Math.sin(a) * 0.0075, -len * 0.5 - 0.0095],
    }));
  }
  // extractor claw
  bin.add('blued', place(chamferBox(0.0048, 0.0060, 0.0180, 0.0007), { p: [0.0068, 0.0030, -len * 0.5 + 0.004] }));
  return { bin, length: len, radius: r };
}

/** Selector switch: safe / semi / auto lever with a detent boss. */
export function selector(opts = {}) {
  const bin = new PartBin();
  const boss = cylZ(0.0072, 0.0100, 14, 0.0009);
  boss.rotateY(Math.PI * 0.5);
  bin.add('blued', boss);
  const lever = extrude(polyShape([
    [-0.0028, 0.0], [0.0028, 0.0], [0.0032, -0.0175], [0.0, -0.0215], [-0.0032, -0.0175],
  ]), 0.0038, 0.0007, { curveSegments: 2 });
  lever.rotateY(-Math.PI * 0.5);
  lever.translate(0.0072, 0, 0);
  bin.add('blued', lever);
  bin.add('blued', place(chamferBox(0.0035, 0.0035, 0.0135, 0.0006), { p: [0.0068, -0.0035, -0.006] }));
  return { bin };
}

/** QD sling socket. */
export function slingMount(opts = {}) {
  const bin = new PartBin();
  const r = opts.radius ?? 0.0058;
  bin.add('blued', place(tubeZ(r, r * 0.55, 0.0075, 14, 0.0006), { r: [0, Math.PI * 0.5, 0] }));
  bin.add('bore', place(cylZ(r * 0.52, 0.0080, 10, 0.0002), { r: [0, Math.PI * 0.5, 0] }));
  return { bin };
}

/* ==================================================================== */
/* iron sights                                                           */
/* ==================================================================== */

/** Flip-up front sight: hooded post between two ears, on a rail-mount base. */
export function frontSight(opts = {}) {
  const bin = new PartBin();
  const h = opts.height ?? 0.040;
  const mat = opts.material ?? 'blued';
  const base = chamferBox(0.0235, 0.0105, 0.026, 0.0014, { round: 0.0022 });
  bin.add(mat, base);
  for (const sx of [-1, 1]) {
    const ear = extrude(polyShape([
      [-0.0055, 0], [0.0055, 0], [0.0060, h * 0.72], [0.0038, h], [-0.0038, h], [-0.0060, h * 0.72],
    ]), 0.0034, 0.0007, { curveSegments: 2 });
    ear.rotateY(-Math.PI * 0.5);
    ear.translate(sx * 0.0080, 0.0045, 0);
    bin.add(mat, ear);
  }
  bin.add(mat, place(chamferBox(0.0175, 0.0035, 0.0060, 0.0007), { p: [0, 0.0045 + h - 0.0015, 0] }));
  bin.add('steel', place(chamferBox(0.0022, h * 0.62, 0.0030, 0.0004), { p: [0, 0.0045 + h * 0.46, 0] }));
  bin.add('steel', place(cylZ(0.0018, 0.0075, 10, 0.0003), { r: [Math.PI * 0.5, 0, 0], p: [0, 0.0045 + h * 0.78, 0] }));
  return { bin, sightHeight: 0.0045 + h * 0.62 };
}

/** Flip-up rear: aperture ring with a real hole, windage drum, detent clicks. */
export function rearSight(opts = {}) {
  const bin = new PartBin();
  const h = opts.height ?? 0.034;
  const mat = opts.material ?? 'blued';
  bin.add(mat, chamferBox(0.0235, 0.0100, 0.022, 0.0014, { round: 0.0022 }));

  const leafShape = roundedRectShape(0.0235, h, 0.004);
  leafShape.holes.push(circleHole(0, h * 0.16, 0.0042, 14));
  const leaf = extrude(leafShape, 0.0032, 0.0007, { curveSegments: 4 });
  leaf.rotateY(Math.PI * 0.5);
  leaf.translate(0.0, 0.0050 + h * 0.5, 0.0);
  bin.add(mat, leaf);

  // protective wings
  for (const sx of [-1, 1]) {
    bin.add(mat, place(chamferBox(0.0038, h * 0.86, 0.0135, 0.0007), { p: [sx * 0.0098, 0.0050 + h * 0.5, 0] }));
  }
  // windage drum
  bin.add('steel', place(knurlBand(0.0048, 0.0075, 8, 0.0004, 12), { r: [0, Math.PI * 0.5, 0], p: [0.0130, 0.0050 + h * 0.30, 0] }));
  return { bin, apertureY: 0.0050 + h * 0.5 + h * 0.16, apertureR: 0.0042 };
}

/* ==================================================================== */
/* misc detail                                                           */
/* ==================================================================== */

/** Row of rail-mount screws / recoil lugs for an accessory clamp. */
export function railClamp(opts = {}) {
  const bin = new PartBin();
  const w = opts.width ?? 0.030;
  const h = opts.height ?? 0.014;
  const d = opts.depth ?? 0.020;
  bin.add(opts.material ?? 'alloy', chamferBox(w, h, d, 0.0014, { round: 0.0022 }));
  bin.add('alloy', place(chamferBox(w * 0.30, h * 0.9, d * 0.9, 0.0010), { p: [w * 0.5 - 0.0015, -0.0018, 0] }));
  for (const dz of [-d * 0.26, d * 0.26]) {
    bin.add('steel', place(screwZ(0.0024, 0.0011, 0.004), { r: [0, Math.PI * 0.5, 0], p: [w * 0.5 + 0.0012, -0.0018, dz] }));
  }
  return { bin };
}

/** Engraved panel-gap line: a thin recessed strip that catches the key light. */
export function panelLine(len, opts = {}) {
  const g = chamferBox(opts.width ?? 0.0016, opts.depth ?? 0.0012, len, 0.0003);
  return g;
}

/* ==================================================================== */
/* assembly helpers                                                      */
/* ==================================================================== */

/**
 * Bake a PartBin into meshes — one per material, wear baked in.
 * @returns {THREE.Mesh[]}
 */
export function binToMeshes(bin, palette, wear, opts = {}) {
  const out = [];
  for (const { material, geometry } of bin.bake({ uvScale: opts.uvScale ?? 3.0, wear })) {
    const mat = palette[material] || palette.gunmetal;
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.name = opts.prefix ? `${opts.prefix}_${material}` : material;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = opts.static === true ? false : true;
    out.push(mesh);
  }
  return out;
}

/** Wrap a bin's meshes in a group, ready to be animated as a unit. */
export function binToGroup(bin, palette, wear, opts = {}) {
  const g = new THREE.Group();
  g.name = opts.name || 'part';
  for (const m of binToMeshes(bin, palette, wear, opts)) g.add(m);
  return g;
}

const _X = /* @__PURE__ */ new THREE.Vector3(1, 0, 0);
const _Y = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);
const _Z = /* @__PURE__ */ new THREE.Vector3(0, 0, 1);

/**
 * Build a hand attachment socket from an explicit basis. `basis` maps the
 * hand's local X/Y/Z axes into weapon space (see models/Hands.js for the
 * convention), and `tilt` is an extra parent-space XYZ rotation in radians.
 */
export function handSocket(name, position, basis, tilt = [0, 0, 0]) {
  const o = new THREE.Object3D();
  o.name = name;
  const m = new THREE.Matrix4().makeBasis(
    new THREE.Vector3().fromArray(basis[0]),
    new THREE.Vector3().fromArray(basis[1]),
    new THREE.Vector3().fromArray(basis[2]),
  );
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  const pre = new THREE.Quaternion();
  if (tilt[0]) { pre.setFromAxisAngle(_X, tilt[0]); q.premultiply(pre); }
  if (tilt[1]) { pre.setFromAxisAngle(_Y, tilt[1]); q.premultiply(pre); }
  if (tilt[2]) { pre.setFromAxisAngle(_Z, tilt[2]); q.premultiply(pre); }
  o.quaternion.copy(q);
  o.position.fromArray(position);
  return o;
}

/** Right hand on a pistol grip: thumb up-forward, palm inboard, fingers ahead. */
export const GRIP_BASIS = [[0, 1, 0], [1, 0, 0], [0, 0, -1]];
/** Left hand under a handguard: thumb forward, palm up, fingers across. */
export const SUPPORT_BASIS = [[0, 0, 1], [0, -1, 0], [1, 0, 0]];
/** Left hand cupping a two-handed pistol grip: fingers across the frontstrap. */
export const PISTOL_SUPPORT_BASIS = [[0, -1, 0], [0, 0, -1], [1, 0, 0]];

export { PartBin };
