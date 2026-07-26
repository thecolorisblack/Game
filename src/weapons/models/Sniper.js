import * as THREE from 'three';
import {
  PartBin, chamferBox, extrude, cylZ, tubeZ, lathe, place, polyShape, screwZ,
  roundedRectShape, roundedRectHole, circleHole, knurlBand, picatinnyRail,
  mlokPanel, torusZ, mergeParts,
} from './Parts.js';
import {
  magazine, pistolGrip, triggerGroup, muzzleBrake, barrel, slingMount,
  binToMeshes, binToGroup, handSocket, GRIP_BASIS, SUPPORT_BASIS, railClamp,
} from './Common.js';
import { WEAR } from './Palette.js';
import { magnifiedScope } from './Optics.js';

/**
 * DMR-338 "LONGBOW" — bolt-action precision rifle.
 *
 * Aluminium chassis, heavy fluted barrel, three-port brake, folded bipod and a
 * 6x first-focal-plane optic that renders the world through a second camera.
 * The bolt is a separate animated assembly: lift, draw, push, lock — four timed
 * phases the viewmodel drives against the fire cycle.
 */

const RAIL_Y = 0.0340;
const PORT_Z = -0.020;

export function buildSniper(palette, opts = {}) {
  const bin = new PartBin();

  /* ---------------- receiver ---------------- */
  const recv = roundedRectShape(0.0400, 0.0480, 0.0080);
  bin.add('blued', place(extrude(recv, 0.2260, 0.0028, { curveSegments: 4 }), { p: [0, 0.0060, -0.0700] }));
  // machined lightening cuts along the flanks
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      bin.add('blued', place(chamferBox(0.0030, 0.0180, 0.0360, 0.0010), {
        p: [sx * 0.0192, 0.0040, -0.0250 - i * 0.0480],
      }));
    }
  }
  // ejection port: an open trough on the right of the receiver
  bin.add('bore', place(chamferBox(0.0100, 0.0250, 0.0560, 0.0012), { p: [0.0165, 0.0090, PORT_Z] }));
  bin.add('blued', place(chamferBox(0.0060, 0.0090, 0.0600, 0.0012), { p: [0.0180, 0.0250, PORT_Z] }));

  bin.add('blued', place(picatinnyRail(0.2100), { p: [0, RAIL_Y, -0.0700] }));

  /* ---------------- chassis ---------------- */
  const chassisShape = roundedRectShape(0.0430, 0.0620, 0.0070);
  chassisShape.holes.push(roundedRectHole(0, 0.0140, 0.0330, 0.0270, 0.0050));
  bin.add('alloy', place(extrude(chassisShape, 0.2000, 0.0030, { curveSegments: 4 }), { p: [0, -0.0270, -0.0600] }));
  // skeletonised side windows
  for (const sx of [-1, 1]) {
    for (const dz of [-0.0250, -0.0900]) {
      bin.add('alloy', place(chamferBox(0.0040, 0.0230, 0.0420, 0.0018), { p: [sx * 0.0206, -0.0400, dz] }));
    }
  }
  // forend with M-LOK, hanging below the barrel
  const feZ = -0.2600;
  const feLen = 0.2600;
  bin.add('alloy', place(chamferBox(0.0420, 0.0130, feLen, 0.0028, { round: 0.005 }), { p: [0, -0.0300, feZ] }));
  for (const sx of [-1, 1]) {
    const panel = mlokPanel(feLen * 0.92, 0.0330, 0.0038, { slotW: 0.0080, slotL: 0.0330, pitch: 0.0450, vents: true, ventR: 0.0032 });
    panel.rotateZ(sx * Math.PI * 0.5);
    panel.translate(sx * 0.0208, -0.0180, feZ);
    bin.add('alloy', panel);
  }
  bin.add('alloy', place(mlokPanel(feLen * 0.92, 0.0330, 0.0038, { slotW: 0.0080, slotL: 0.0330, pitch: 0.0450 }), { r: [Math.PI, 0, 0], p: [0, -0.0368, feZ] }));
  bin.add('alloy', place(picatinnyRail(0.0900), { p: [0, -0.0370, feZ - 0.0700] }));

  /* ---------------- grip / trigger ---------------- */
  bin.absorb(pistolGrip({
    width: 0.0340, material: 'grip', capMaterial: 'alloy',
    profile: [
      [-0.006, 0.006], [0.006, -0.028], [0.014, -0.058], [0.021, -0.088],
      [0.027, -0.108], [0.049, -0.114], [0.058, -0.104], [0.058, -0.072],
      [0.052, -0.042], [0.045, -0.014], [0.038, 0.008],
    ],
  }).bin, { p: [0, -0.0540, 0.0140] });

  const trg = triggerGroup({ centerZ: -0.0280, centerY: -0.0530, width: 0.0100, material: 'alloy' });
  bin.absorb(trg.bin);
  // two-stage trigger shoe adjuster
  bin.add('steel', place(screwZ(0.0022, 0.0010, 0.004), { r: [0, Math.PI * 0.5, 0], p: [0.0150, -0.0410, -0.0140] }));

  /* ---------------- barrel + brake ---------------- */
  bin.absorb(barrel({
    profile: [
      [0.0190, -0.1800], [0.0190, -0.2000], [0.0170, -0.2060], [0.0170, -0.3600],
      [0.0148, -0.3680], [0.0148, -0.5200], [0.0132, -0.5280], [0.0132, -0.5720],
      [0.0118, -0.5780], [0.0118, -0.6000],
    ],
    bore: 0.0060,
    flutes: [-0.230, -0.500],
  }).bin);
  // barrel flutes as real relieved channels
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    const fl = cylZ(0.0034, 0.2600, 8, 0.0006);
    fl.scale(1.0, 0.55, 1.0);
    fl.rotateZ(a);
    fl.translate(Math.cos(a) * 0.0168, Math.sin(a) * 0.0168, -0.3650);
    bin.add('bore', fl);
  }
  bin.add('steel', place(knurlBand(0.0126, 0.0180, 10, 0.0007, 22), { p: [0, 0, -0.6120] }));
  bin.absorb(muzzleBrake({ radius: 0.0182, bore: 0.0062, length: 0.0880, ports: 4 }).bin, { p: [0, 0, -0.6640] });

  /* ---------------- stock ---------------- */
  const stockZ = 0.1450;
  const stockShape = roundedRectShape(0.0400, 0.0900, 0.0110);
  stockShape.holes.push(roundedRectHole(0.0000, -0.0140, 0.0230, 0.0400, 0.0080));
  bin.add('alloy', place(extrude(stockShape, 0.1900, 0.0032, { curveSegments: 4 }), { p: [0, -0.0100, stockZ] }));
  // adjustable cheek riser on twin posts
  bin.add('grip', place(chamferBox(0.0330, 0.0180, 0.1300, 0.0040, { round: 0.007 }), { r: [-0.04, 0, 0], p: [0, 0.0430 + (opts.riser ?? 0), stockZ - 0.0100] }));
  for (const sx of [-1, 1]) {
    bin.add('steel', place(cylZ(0.0026, 0.0220, 8, 0.0004), { r: [Math.PI * 0.5, 0, 0], p: [sx * 0.0120, 0.0330, stockZ - 0.0300] }));
    bin.add('steel', place(knurlBand(0.0044, 0.0080, 6, 0.0004, 10), { r: [0, Math.PI * 0.5, 0], p: [sx * 0.0205, 0.0300, stockZ - 0.0300] }));
  }
  // length-of-pull spacer stack + rubber pad
  const buttZ = stockZ + 0.1050;
  for (let i = 0; i < 3; i++) {
    bin.add('alloy', place(chamferBox(0.0380, 0.0860, 0.0060, 0.0014), { r: [0.09, 0, 0], p: [0, -0.0110, buttZ - 0.0210 + i * 0.0068] }));
  }
  bin.add('rubber', place(chamferBox(0.0390, 0.0940, 0.0200, 0.0035, { round: 0.008 }), { r: [0.09, 0, 0], p: [0, -0.0110, buttZ + 0.0060] }));
  for (let i = 0; i < 4; i++) {
    bin.add('rubber', place(chamferBox(0.0350, 0.0040, 0.0070, 0.0012), { r: [0.09, 0, 0], p: [0, 0.0240 - i * 0.0190, buttZ + 0.0155 - i * 0.0006] }));
  }
  // monopod / toe hook
  bin.add('alloy', place(chamferBox(0.0200, 0.0300, 0.0250, 0.0022), { p: [0, -0.0640, buttZ - 0.0300] }));
  bin.add('steel', place(knurlBand(0.0060, 0.0180, 8, 0.0005, 12), { r: [Math.PI * 0.5, 0, 0], p: [0, -0.0790, buttZ - 0.0300] }));

  bin.absorb(slingMount({ radius: 0.0062 }).bin, { p: [-0.0225, -0.0300, feZ + 0.0700] });
  bin.absorb(slingMount({ radius: 0.0062 }).bin, { p: [-0.0225, -0.0180, stockZ + 0.0200] });

  /* ---------------- folded bipod ---------------- */
  {
    const bp = new PartBin();
    bp.add('blued', chamferBox(0.0260, 0.0220, 0.0300, 0.0022, { round: 0.004 }));
    for (const sx of [-1, 1]) {
      const leg = mergeParts([
        cylZ(0.0044, 0.1050, 10, 0.0006),
        place(cylZ(0.0034, 0.0500, 8, 0.0005), { p: [0, 0, -0.0700] }),
        place(chamferBox(0.0080, 0.0080, 0.0110, 0.0012), { p: [0, 0, -0.0960] }),
      ]);
      leg.rotateY(sx * 0.10);
      leg.translate(sx * 0.0130, -0.0030, -0.0420);
      bp.add('blued', leg);
      bp.add('rubber', place(cylZ(0.0056, 0.0090, 10, 0.0010), { r: [0, sx * 0.10, 0], p: [sx * 0.0130 - sx * 0.010, -0.0030, -0.0960] }));
    }
    bin.absorb(bp, { p: [0, -0.0430, feZ - 0.0850] });
  }

  /* ================= assembly ================= */
  const root = new THREE.Group();
  root.name = 'DMR338';
  for (const m of binToMeshes(bin, palette, WEAR, { prefix: 'dmr338' })) root.add(m);

  const mag = magazine({ width: 0.0330, depth: 0.0330, length: 0.1100, curve: -1 / 0.90, material: 'blued', floorMaterial: 'polymer' });
  const magazineNode = binToGroup(mag.bin, palette, WEAR, { name: 'magazine' });
  magazineNode.position.set(0, -0.0300, -0.0620);
  root.add(magazineNode);

  /* ---- bolt assembly: body + handle, animated as one ---- */
  const boltBin = new PartBin();
  boltBin.add('steel', cylZ(0.0128, 0.1500, 20, 0.0012));
  boltBin.add('steel', place(lathe([
    [2e-5, 0], [0.0110, 0], [0.0110, 0.0080], [0.0080, 0.0084], [0.0080, 0.0160], [2e-5, 0.0160],
  ], 18), { r: [Math.PI * 0.5, 0, 0], p: [0, 0, -0.0800] }));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    boltBin.add('steel', place(chamferBox(0.0055, 0.0055, 0.0130, 0.0008), {
      p: [Math.cos(a) * 0.0104, Math.sin(a) * 0.0104, -0.0810],
    }));
  }
  // handle root, arm and knob
  boltBin.add('steel', place(cylZ(0.0090, 0.0180, 14, 0.0012), { p: [0, 0, 0.0300] }));
  boltBin.add('steel', place(cylZ(0.0044, 0.0400, 10, 0.0006), { r: [0, Math.PI * 0.5, 0], p: [0.0250, 0, 0.0300] }));
  boltBin.add('blued', place(lathe([
    [2e-5, 0], [0.0090, 0.0010], [0.0112, 0.0090], [0.0100, 0.0170], [2e-5, 0.0180],
  ], 16), { r: [0, Math.PI * 0.5, 0], p: [0.0450, 0, 0.0300] }));
  boltBin.add('blued', place(knurlBand(0.0106, 0.0110, 8, 0.0007, 16), { r: [0, Math.PI * 0.5, 0], p: [0.0510, 0, 0.0300] }));
  // shroud / cocking indicator at the rear
  boltBin.add('blued', place(tubeZ(0.0140, 0.0128, 0.0220, 18, 0.0010), { p: [0, 0, 0.0820] }));
  boltBin.add('fibre', place(cylZ(0.0030, 0.0100, 8, 0.0004), { p: [0, 0, 0.0940] }));

  const boltNode = binToGroup(boltBin, palette, WEAR, { name: 'bolt' });
  boltNode.position.set(0, 0.0075, PORT_Z + 0.0100);
  root.add(boltNode);

  const triggerNode = binToGroup(trg.trigger, palette, WEAR, { name: 'trigger' });
  triggerNode.position.set(0, -0.0330, -0.0210);
  root.add(triggerNode);

  /* ================= optic ================= */
  const optic = magnifiedScope(palette, {
    radius: 0.0172, objective: 0.0290, ocular: 0.0245, length: 0.3200,
    mountHeight: 0.0405, baseMag: opts.magnification ?? 6, fov: 7.6,
    renderSize: opts.renderSize ?? 512, reticleColor: 0xff2a12,
  });
  const opticNode = new THREE.Group();
  opticNode.name = 'optic';
  opticNode.position.set(0, RAIL_Y, -0.0640);
  for (const m of binToMeshes(optic.bin, palette, WEAR, { prefix: 'scope' })) opticNode.add(m);
  for (const m of optic.meshes) opticNode.add(m);
  root.add(opticNode);

  const sockets = {
    muzzle: mkNode(root, 'muzzle', [0, 0, -0.7080]),
    eject: mkNode(root, 'eject', [0.0230, 0.0110, PORT_Z]),
    grip: handSocket('gripSocket', [0.0370, -0.0400, 0.0950], GRIP_BASIS, [-0.26, 0, 0]),
    support: handSocket('supportSocket', [-0.0610, -0.0640, -0.2450], SUPPORT_BASIS, [0, -0.08, 0.34]),
    magwell: mkNode(root, 'magwell', [0, -0.0300, -0.0620]),
    boltKnob: mkNode(root, 'boltKnob', [0.0510, 0.0075, PORT_Z + 0.0400]),
  };
  root.add(sockets.grip, sockets.support);

  return {
    root,
    parts: { magazine: magazineNode, bolt: boltNode, trigger: triggerNode, optic: opticNode },
    sockets,
    optic,
    forearm: { right: [0.28, 0.62, 0], left: [0.55, -0.85, 0] },
    sightHeight: RAIL_Y + optic.sightHeight,
    sightZ: -0.0640,
    boltTravel: 0.0900,
    boltLift: 1.15,
  };
}

function mkNode(parent, name, p) {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.fromArray(p);
  parent.add(o);
  return o;
}
