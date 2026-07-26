import * as THREE from 'three';
import {
  PartBin, chamferBox, extrude, lathe, cylZ, tubeZ, place, polyShape, screwZ,
  roundedRectShape, roundedRectHole, circleHole, knurlBand, picatinnyRail, mergeParts,
} from './Parts.js';
import {
  magazine, pistolGrip, triggerGroup, birdcage, barrel, gasBlock, handguard,
  bufferTube, adjustableStock, chargingHandle, dustCover, boltCarrier, selector,
  slingMount, frontSight, rearSight, railClamp, binToMeshes, binToGroup,
  handSocket, GRIP_BASIS, SUPPORT_BASIS,
} from './Common.js';
import { WEAR } from './Palette.js';
import { redDotSight } from './Optics.js';

/**
 * AR-70 "WARDEN" — 5.56 assault rifle.
 *
 * The hero weapon, so it carries the most geometry: a two-piece receiver with a
 * real machined cavity behind a real ejection port (the bolt carrier is visible
 * through it and cycles), a free-float M-LOK handguard with cut-through slots, a
 * birdcage with genuine open ports, an adjustable stock with a cheek riser and
 * a tube reflex sight with a collimated reticle.
 */

const BORE_Y = 0;
const RAIL_Y = 0.0315;
const PORT_Z = -0.036;
const PORT_LEN = 0.054;

export function buildRifle(palette, opts = {}) {
  const bin = new PartBin();

  /* ---------------- upper receiver ---------------- */
  // full cross-section: closed box with a rounded profile
  const full = roundedRectShape(0.0386, 0.0470, 0.0050);
  // port cross-section: a real cavity opened on the ejection side
  const port = polyShape([
    [0.0193, -0.0070], [0.0193, -0.0155], [-0.0193, -0.0155],
    [-0.0193, 0.0315], [0.0193, 0.0315], [0.0193, 0.0210],
    [-0.0128, 0.0210], [-0.0128, -0.0070],
  ]);
  const upFront = extrude(full, 0.070, 0.0022, { curveSegments: 3 });
  upFront.translate(0, 0.0080, PORT_Z - PORT_LEN * 0.5 - 0.035);
  const upPort = extrude(port, PORT_LEN, 0.0016, { curveSegments: 2 });
  upPort.translate(0, 0.0080, PORT_Z);
  const upRear = extrude(full, 0.048, 0.0022, { curveSegments: 3 });
  upRear.translate(0, 0.0080, PORT_Z + PORT_LEN * 0.5 + 0.024);
  bin.add('gunmetal', upFront, upPort, upRear);

  // receiver panel lines: two engraved grooves down each flank
  for (const sx of [-1, 1]) {
    for (const dy of [0.0245, -0.0105]) {
      bin.add('gunmetal', place(chamferBox(0.0022, 0.0020, 0.150, 0.0004), {
        p: [sx * 0.0184, 0.0080 + dy, PORT_Z - 0.006],
      }));
    }
  }
  // top rail
  bin.add('gunmetal', place(picatinnyRail(0.176), { p: [0, RAIL_Y, PORT_Z - 0.012] }));

  // charging handle recess + rear plate
  bin.add('gunmetal', place(chamferBox(0.0300, 0.0180, 0.0180, 0.0018), { p: [0, 0.0195, 0.018] }));
  bin.add('gunmetal', place(chamferBox(0.0386, 0.0470, 0.0060, 0.0016, { round: 0.005 }), { p: [0, 0.0080, 0.0295] }));

  // forward assist + brass deflector
  bin.add('blued', place(cylZ(0.0068, 0.0170, 14, 0.0009), { r: [0, Math.PI * 0.5, 0], p: [0.0230, 0.0150, 0.0010] }));
  bin.add('blued', place(knurlBand(0.0052, 0.0060, 6, 0.0004, 12), { r: [0, Math.PI * 0.5, 0], p: [0.0300, 0.0150, 0.0010] }));
  bin.add('gunmetal', place(extrude(polyShape([
    [0, 0], [0.0230, 0], [0.0230, 0.0090], [0.0130, 0.0175], [0, 0.0175],
  ]), 0.0090, 0.0012, { curveSegments: 2 }), { r: [0, Math.PI * 0.5, 0], p: [0.0230, 0.0020, -0.0030] }));

  // takedown pins
  for (const z of [-0.098, 0.014]) {
    bin.add('steel', place(screwZ(0.0038, 0.0014, 0.005), { r: [0, Math.PI * 0.5, 0], p: [0.0198, -0.0075, z] }));
    bin.add('steel', place(screwZ(0.0038, 0.0014, 0.005), { r: [0, -Math.PI * 0.5, 0], p: [-0.0198, -0.0075, z] }));
  }

  /* ---------------- lower receiver ---------------- */
  const lowerShape = roundedRectShape(0.0356, 0.0400, 0.0055);
  const lower = extrude(lowerShape, 0.118, 0.0024, { curveSegments: 3 });
  lower.translate(0, -0.0345, -0.0180);
  bin.add('gunmetal', lower);
  // magwell: flared funnel
  const wellOuter = roundedRectShape(0.0410, 0.0330, 0.0055);
  wellOuter.holes.push(roundedRectHole(0, 0, 0.0322, 0.0262, 0.0045));
  const well = extrude(wellOuter, 0.056, 0.0020, { curveSegments: 3 });
  well.rotateX(Math.PI * 0.5);
  well.translate(0, -0.0560, -0.0500);
  bin.add('gunmetal', well);
  const flareShape = roundedRectShape(0.0452, 0.0372, 0.0060);
  flareShape.holes.push(roundedRectHole(0, 0, 0.0332, 0.0272, 0.0045));
  const flare = extrude(flareShape, 0.0132, 0.0020, { curveSegments: 3 });
  flare.rotateX(Math.PI * 0.5);
  flare.translate(0, -0.0828, -0.0500);
  bin.add('polymer', flare);

  /* ---------------- grip / trigger ---------------- */
  const grip = pistolGrip({ width: 0.0330, material: 'grip', capMaterial: 'polymer' });
  bin.absorb(grip.bin, { p: [0, -0.0480, 0.0040] });

  const trg = triggerGroup({ centerZ: -0.0335, centerY: -0.0490, material: 'gunmetal' });
  bin.absorb(trg.bin);

  const sel = selector();
  bin.absorb(sel.bin, { p: [0.0170, -0.0330, 0.0000] });
  // ambidextrous: the mirror is a 180° yaw, never a negative scale (that would
  // invert the winding and light the lever from inside)
  bin.absorb(selector().bin, { r: [0, Math.PI, 0], p: [-0.0170, -0.0330, 0.0000] });

  /* ---------------- barrel / gas / muzzle ---------------- */
  const brl = barrel({
    profile: [
      [0.0140, -0.0620], [0.0140, -0.0980], [0.0108, -0.1040], [0.0108, -0.2180],
      [0.0092, -0.2240], [0.0092, -0.3760], [0.0086, -0.3820], [0.0086, -0.4180],
    ],
    bore: 0.0040,
    flutes: [-0.115, -0.205],
  });
  bin.absorb(brl.bin);
  bin.absorb(gasBlock({ z: -0.2960, barrelRadius: 0.0092, tubeLength: 0.196 }).bin);

  const muzzle = birdcage({ radius: 0.0112, bore: 0.0040, length: 0.0520, bars: 6, gap: 0.34 });
  bin.absorb(muzzle.bin, { p: [0, 0, -0.4430] });

  /* ---------------- handguard ---------------- */
  const hg = handguard({ length: 0.2380, radius: 0.0238, z: -0.2170, thickness: 0.0036, material: 'alloy' });
  bin.absorb(hg.bin);
  // short top rail continuing the receiver rail over the handguard
  bin.add('alloy', place(picatinnyRail(0.2280), { p: [0, 0.0238 - 0.0006, -0.2170] }));
  // handstop / index block on the 6 o'clock M-LOK
  bin.absorb(railClamp({ width: 0.0200, height: 0.0195, depth: 0.0300, material: 'polymer' }).bin,
    { r: [0, 0, Math.PI], p: [0, -0.0330, -0.2760] });
  // QD sling socket forward left
  bin.absorb(slingMount({ radius: 0.0060 }).bin, { p: [-0.0230, -0.0090, -0.1350] });

  /* ---------------- stock ---------------- */
  const buf = bufferTube({ radius: 0.0150, length: 0.2060, z: 0.1340 });
  bin.absorb(buf.bin);
  const stock = adjustableStock({ tubeRadius: 0.0150, z: 0.1820, length: 0.1040, material: 'polymer', riserMaterial: 'grip' });
  bin.absorb(stock.bin);

  /* ---------------- back-up irons (folded) ---------------- */
  const fs = frontSight({ height: 0.0200, material: 'blued' });
  bin.absorb(fs.bin, { r: [-1.32, 0, 0], p: [0, RAIL_Y + 0.0055, -0.3060] });
  const rs = rearSight({ height: 0.0180, material: 'blued' });
  bin.absorb(rs.bin, { r: [1.32, 0, 0], p: [0, RAIL_Y + 0.0050, 0.0040] });

  /* ================= animated parts ================= */
  const root = new THREE.Group();
  root.name = 'AR70';
  for (const m of binToMeshes(bin, palette, WEAR, { prefix: 'ar70' })) root.add(m);

  // magazine
  const mag = magazine({ width: 0.0300, depth: 0.0252, length: 0.1860, curve: -1 / 0.48, material: 'polymer' });
  const magazineNode = binToGroup(mag.bin, palette, WEAR, { name: 'magazine' });
  magazineNode.position.set(0, -0.0405, -0.0500);
  root.add(magazineNode);

  // bolt carrier, visible through the port
  const bcg = boltCarrier({ radius: 0.0122, length: 0.0960 });
  const boltNode = binToGroup(bcg.bin, palette, WEAR, { name: 'bolt' });
  boltNode.position.set(0, 0.0060, PORT_Z - 0.0060);
  root.add(boltNode);

  // charging handle
  const ch = chargingHandle({ length: 0.0820 });
  const chargeNode = binToGroup(ch.bin, palette, WEAR, { name: 'charging' });
  chargeNode.position.set(0, 0.0215, 0.0080);
  root.add(chargeNode);

  // dust cover on a real hinge
  const dc = dustCover({ width: PORT_LEN - 0.002, height: 0.0290 });
  const dustPivot = new THREE.Group();
  dustPivot.name = 'dustCover';
  dustPivot.position.set(0.0203, -0.0080, PORT_Z);
  const dustDoor = binToGroup(dc.bin, palette, WEAR, { name: 'dustDoor' });
  dustDoor.position.set(0.0010, 0.0155, 0);
  dustPivot.add(dustDoor);
  root.add(dustPivot);

  // trigger blade
  const triggerNode = binToGroup(trg.trigger, palette, WEAR, { name: 'trigger' });
  triggerNode.position.set(0, -0.0310, -0.0270);
  root.add(triggerNode);

  /* ================= optic ================= */
  const optic = redDotSight(palette, {
    radius: 0.0182, length: 0.0740, mountHeight: 0.0300,
    color: opts.reticleColor ?? 0xff2a12, dotSize: 0.0040, brightness: 8.0,
  });
  const opticNode = new THREE.Group();
  opticNode.name = 'optic';
  opticNode.position.set(0, RAIL_Y, -0.0620);
  for (const m of binToMeshes(optic.bin, palette, WEAR, { prefix: 'optic' })) opticNode.add(m);
  for (const m of optic.meshes) opticNode.add(m);
  root.add(opticNode);

  /* ================= sockets ================= */
  const sockets = {
    muzzle: (() => { const o = new THREE.Object3D(); o.name = 'muzzle'; o.position.set(0, 0, -0.4700); root.add(o); return o; })(),
    eject: (() => {
      const o = new THREE.Object3D(); o.name = 'eject';
      o.position.set(0.0250, 0.0070, PORT_Z);
      o.rotation.set(0, 0, 0.35);
      root.add(o); return o;
    })(),
    grip: handSocket('gripSocket', [0.0360, -0.0340, 0.0850], GRIP_BASIS, [-0.26, 0, 0]),
    support: handSocket('supportSocket', [-0.0600, -0.0500, -0.1930], SUPPORT_BASIS, [0, -0.10, 0.30]),
    magwell: (() => { const o = new THREE.Object3D(); o.name = 'magwell'; o.position.set(0, -0.0405, -0.0500); root.add(o); return o; })(),
  };
  root.add(sockets.grip, sockets.support);

  return {
    root,
    parts: {
      magazine: magazineNode,
      bolt: boltNode,
      charging: chargeNode,
      dustCover: dustPivot,
      trigger: triggerNode,
      optic: opticNode,
    },
    sockets,
    optic,
    forearm: { right: [0.28, 0.62, 0], left: [0.55, -0.85, 0] },
    sightHeight: RAIL_Y + optic.sightHeight,
    sightZ: -0.0620,
    boltTravel: 0.0330,
    chargeTravel: 0.0620,
  };
}
