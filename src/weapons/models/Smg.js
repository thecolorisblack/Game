import * as THREE from 'three';
import {
  PartBin, chamferBox, extrude, cylZ, tubeZ, place, polyShape, screwZ, lathe,
  roundedRectShape, roundedRectHole, knurlBand, picatinnyRail, mlokPanel, torusZ,
} from './Parts.js';
import {
  magazine, pistolGrip, triggerGroup, muzzleBrake, barrel, chargingHandle,
  boltCarrier, selector, slingMount, railClamp, binToMeshes, binToGroup,
  handSocket, GRIP_BASIS, SUPPORT_BASIS,
} from './Common.js';
import { WEAR } from './Palette.js';
import { redDotSight } from './Optics.js';

/**
 * SMG-9 "WRAITH" — 9mm compact.
 *
 * Polymer monocoque upper, side-folding stock, vertical foregrip and a
 * micro reflex. Short, top-heavy silhouette so it reads instantly different
 * from the rifle at a glance, which is the point of having two automatics.
 */

const RAIL_Y = 0.0288;
const PORT_Z = -0.030;
const PORT_LEN = 0.046;

export function buildSmg(palette, opts = {}) {
  const bin = new PartBin();

  /* ---------------- receiver ---------------- */
  const full = roundedRectShape(0.0360, 0.0430, 0.0060);
  const port = polyShape([
    [0.0180, -0.0060], [0.0180, -0.0145], [-0.0180, -0.0145],
    [-0.0180, 0.0285], [0.0180, 0.0285], [0.0180, 0.0195],
    [-0.0120, 0.0195], [-0.0120, -0.0060],
  ]);
  bin.add('polymer', place(extrude(full, 0.062, 0.0026, { curveSegments: 3 }), { p: [0, 0.0072, PORT_Z - PORT_LEN * 0.5 - 0.031] }));
  bin.add('polymer', place(extrude(port, PORT_LEN, 0.0018, { curveSegments: 2 }), { p: [0, 0.0072, PORT_Z] }));
  bin.add('polymer', place(extrude(full, 0.058, 0.0026, { curveSegments: 3 }), { p: [0, 0.0072, PORT_Z + PORT_LEN * 0.5 + 0.029] }));

  // moulded-in reinforcement and a soft-touch panel on each flank
  for (const sx of [-1, 1]) {
    bin.add('grip', place(chamferBox(0.0030, 0.0230, 0.0640, 0.0008), { p: [sx * 0.0172, 0.0000, -0.0130] }));
    bin.add('polymer', place(chamferBox(0.0026, 0.0044, 0.1200, 0.0007), { p: [sx * 0.0176, 0.0225, -0.0300] }));
  }

  bin.add('alloy', place(picatinnyRail(0.1620), { p: [0, RAIL_Y, PORT_Z - 0.010] }));
  bin.add('polymer', place(chamferBox(0.0360, 0.0430, 0.0055, 0.0016, { round: 0.005 }), { p: [0, 0.0072, 0.0268] }));

  /* ---------------- grip / trigger ---------------- */
  bin.absorb(pistolGrip({
    width: 0.0310, material: 'grip', capMaterial: 'polymer',
    profile: [
      [-0.004, 0.004], [0.007, -0.024], [0.015, -0.050], [0.021, -0.076],
      [0.026, -0.094], [0.045, -0.100], [0.053, -0.092], [0.053, -0.064],
      [0.047, -0.036], [0.041, -0.010], [0.035, 0.006],
    ],
  }).bin, { p: [0, -0.0440, 0.0050] });

  const trg = triggerGroup({ centerZ: -0.0300, centerY: -0.0450, material: 'polymer' });
  bin.absorb(trg.bin);
  bin.absorb(selector().bin, { p: [0.0158, -0.0300, 0.0030] });
  bin.absorb(selector().bin, { r: [0, Math.PI, 0], p: [-0.0158, -0.0300, 0.0030] });

  /* ---------------- barrel / muzzle ---------------- */
  bin.absorb(barrel({
    profile: [
      [0.0116, -0.0500], [0.0116, -0.0760], [0.0088, -0.0820],
      [0.0088, -0.2260], [0.0080, -0.2320], [0.0080, -0.2560],
    ],
    bore: 0.0046,
  }).bin);
  const comp = muzzleBrake({ radius: 0.0122, bore: 0.0048, length: 0.0480, ports: 3 });
  bin.absorb(comp.bin, { p: [0, 0, -0.2790] });

  /* ---------------- handguard ---------------- */
  const hgZ = -0.1560;
  const hgLen = 0.1560;
  const hgR = 0.0212;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    if (Math.abs(Math.sin(a) - 1) < 0.1) continue;
    const fw = 2 * hgR * Math.tan(Math.PI / 8) * 0.99;
    const panel = mlokPanel(hgLen * 0.9, fw, 0.0032, { slotW: 0.0074, slotL: 0.0280, pitch: 0.0400, vents: true, ventR: 0.0028 });
    panel.rotateZ(a - Math.PI * 0.5);
    panel.translate(Math.cos(a) * (hgR - 0.0016), Math.sin(a) * (hgR - 0.0016), hgZ);
    bin.add('alloy', panel);
  }
  bin.add('alloy', place(chamferBox(0.0230, 0.0038, hgLen * 0.94, 0.0008), { p: [0, hgR - 0.0032, hgZ] }));
  bin.add('alloy', place(picatinnyRail(hgLen * 0.94), { p: [0, hgR - 0.0012, hgZ] }));
  bin.add('alloy', place(tubeZ(hgR + 0.0012, hgR - 0.0052, 0.0140, 24, 0.0011), { p: [0, 0, hgZ + hgLen * 0.5 - 0.007] }));
  bin.add('alloy', place(tubeZ(hgR * 0.99, hgR - 0.0050, 0.0110, 24, 0.0011), { p: [0, 0, hgZ - hgLen * 0.5 + 0.006] }));

  /* ---------------- vertical foregrip ---------------- */
  const vgZ = -0.2060;
  bin.absorb(railClamp({ width: 0.0230, height: 0.0130, depth: 0.0280, material: 'polymer' }).bin,
    { r: [0, 0, Math.PI], p: [0, -hgR - 0.0055, vgZ] });
  const vg = lathe([
    [0.0132, 0], [0.0140, -0.0100], [0.0128, -0.0300], [0.0136, -0.0420],
    [0.0122, -0.0560], [0.0128, -0.0680], [0.0100, -0.0770], [2e-5, -0.0790],
  ], 20, { axis: 'y' });
  vg.translate(0, -hgR - 0.0120, vgZ);
  bin.add('grip', vg);
  for (let i = 0; i < 3; i++) {
    bin.add('grip', place(torusZ(0.0132, 0.0016, 16, 5), { r: [Math.PI * 0.5, 0, 0], p: [0, -hgR - 0.0260 - i * 0.0150, vgZ] }));
  }

  /* ---------------- folding stock ---------------- */
  const stock = new PartBin();
  stock.add('alloy', place(chamferBox(0.0300, 0.0300, 0.0180, 0.0022, { round: 0.004 }), { p: [0, 0.0060, 0.0110] }));
  for (const sy of [-1, 1]) {
    stock.add('alloy', place(chamferBox(0.0078, 0.0090, 0.1180, 0.0016), { p: [0, 0.0060 + sy * 0.0150, 0.0790] }));
  }
  stock.add('alloy', place(chamferBox(0.0300, 0.0400, 0.0090, 0.0018, { round: 0.004 }), { p: [0, 0.0060, 0.1390] }));
  stock.add('rubber', place(chamferBox(0.0290, 0.0680, 0.0130, 0.0028, { round: 0.006 }), { p: [0, 0.0060, 0.1480] }));
  for (let i = 0; i < 3; i++) {
    stock.add('rubber', place(chamferBox(0.0250, 0.0034, 0.0050, 0.0010), { p: [0, 0.0250 - i * 0.0170, 0.1540] }));
  }
  stock.add('grip', place(chamferBox(0.0250, 0.0130, 0.0620, 0.0026, { round: 0.005 }), { p: [0, 0.0270, 0.0820] }));
  bin.absorb(stock, { p: [0, 0.0035, 0.0290] });

  bin.absorb(slingMount({ radius: 0.0056 }).bin, { p: [-0.0195, 0.0100, 0.0320] });

  // magwell collar, so the magazine reads as inserted rather than glued on
  {
    const s = roundedRectShape(0.0330, 0.0290, 0.0050);
    s.holes.push(roundedRectHole(0, 0, 0.0276, 0.0238, 0.0040));
    bin.add('polymer', place(extrude(s, 0.0420, 0.0018, { curveSegments: 3 }),
      { r: [Math.PI * 0.5, 0, 0], p: [0, -0.0300, -0.0420] }));
  }

  /* ================= assembly ================= */
  const root = new THREE.Group();
  root.name = 'SMG9';
  for (const m of binToMeshes(bin, palette, WEAR, { prefix: 'smg9' })) root.add(m);

  const mag = magazine({ width: 0.0268, depth: 0.0230, length: 0.1680, curve: -1 / 0.62, material: 'polymer' });
  const magazineNode = binToGroup(mag.bin, palette, WEAR, { name: 'magazine' });
  magazineNode.position.set(0, -0.0330, -0.0420);
  root.add(magazineNode);

  const boltNode = binToGroup(boltCarrier({ radius: 0.0110, length: 0.0820 }).bin, palette, WEAR, { name: 'bolt' });
  boltNode.position.set(0, 0.0060, PORT_Z - 0.0040);
  root.add(boltNode);

  const chargeNode = binToGroup(chargingHandle({ length: 0.0620 }).bin, palette, WEAR, { name: 'charging' });
  chargeNode.position.set(-0.0150, 0.0195, -0.0640);
  chargeNode.rotation.z = -0.18;
  root.add(chargeNode);

  const triggerNode = binToGroup(trg.trigger, palette, WEAR, { name: 'trigger' });
  triggerNode.position.set(0, -0.0280, -0.0240);
  root.add(triggerNode);

  /* ================= optic ================= */
  const optic = redDotSight(palette, {
    radius: 0.0148, length: 0.0560, mountHeight: 0.0250,
    color: opts.reticleColor ?? 0xff4a1c, dotSize: 0.0046, brightness: 7.0, ring: false,
  });
  const opticNode = new THREE.Group();
  opticNode.name = 'optic';
  opticNode.position.set(0, RAIL_Y, -0.0500);
  for (const m of binToMeshes(optic.bin, palette, WEAR, { prefix: 'optic' })) opticNode.add(m);
  for (const m of optic.meshes) opticNode.add(m);
  root.add(opticNode);

  const sockets = {
    muzzle: mkNode(root, 'muzzle', [0, 0, -0.3050]),
    eject: mkNode(root, 'eject', [0.0230, 0.0060, PORT_Z]),
    grip: handSocket('gripSocket', [0.0350, -0.0320, 0.0840], GRIP_BASIS, [-0.28, 0, 0]),
    support: handSocket('supportSocket', [-0.0570, -0.0430, -0.1420], SUPPORT_BASIS, [0, -0.10, 0.30]),
    magwell: mkNode(root, 'magwell', [0, -0.0330, -0.0420]),
  };
  root.add(sockets.grip, sockets.support);

  return {
    root,
    parts: { magazine: magazineNode, bolt: boltNode, charging: chargeNode, trigger: triggerNode, optic: opticNode },
    sockets,
    optic,
    forearm: { right: [0.28, 0.62, 0], left: [0.55, -0.85, 0] },
    sightHeight: RAIL_Y + optic.sightHeight,
    sightZ: -0.0500,
    boltTravel: 0.0300,
    chargeTravel: 0.0500,
  };
}

function mkNode(parent, name, p) {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.fromArray(p);
  parent.add(o);
  return o;
}
