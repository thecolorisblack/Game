import * as THREE from 'three';
import {
  PartBin, chamferBox, extrude, cylZ, tubeZ, lathe, place, polyShape, screwZ,
  roundedRectShape, roundedRectHole, circleHole, knurlBand, picatinnyRail, torusZ,
} from './Parts.js';
import {
  magazine, triggerGroup, binToMeshes, binToGroup, handSocket, GRIP_BASIS,
  PISTOL_SUPPORT_BASIS,
} from './Common.js';
import { WEAR } from './Palette.js';
import { pistolSights } from './Optics.js';

/**
 * P-45 "SIDEARM" — .45 service pistol.
 *
 * Everything on a handgun is close to the camera, so this one gets the tightest
 * detail budget per square centimetre: cocking serrations that are real cut
 * geometry, an open ejection port with the barrel hood visible in it, a
 * skeletonised hammer, an undercut trigger guard, an accessory rail with real
 * cross slots, and tritium three-dot sights.
 */

const SLIDE_Y = 0.0000;   // bore axis
const PORT_Z = -0.028;

export function buildPistol(palette, opts = {}) {
  const frameBin = new PartBin();
  const slideBin = new PartBin();

  /* ================= slide ================= */
  const slideW = 0.0268;
  const slideH = 0.0300;
  const slideLen = 0.1900;
  const slideZ = -0.0140;

  // slide body: a squared-off C-section open at the bottom for the barrel
  const slideShape = polyShape([
    [-slideW * 0.5, -0.0155], [slideW * 0.5, -0.0155],
    [slideW * 0.5, 0.0125], [slideW * 0.5 - 0.0035, 0.0145],
    [-slideW * 0.5 + 0.0035, 0.0145], [-slideW * 0.5, 0.0125],
  ]);
  slideShape.holes.push(roundedRectHole(0, -0.0055, slideW - 0.0090, 0.0170, 0.0030));
  slideBin.add('blued', place(extrude(slideShape, slideLen, 0.0022, { curveSegments: 3 }), { p: [0, 0, slideZ] }));

  // ejection port: a real notch cut through the right wall
  slideBin.add('bore', place(chamferBox(0.0060, 0.0170, 0.0420, 0.0010), { p: [slideW * 0.5 - 0.0028, 0.0010, PORT_Z] }));
  slideBin.add('blued', place(chamferBox(0.0050, 0.0060, 0.0460, 0.0010), { p: [slideW * 0.5 - 0.0020, 0.0125, PORT_Z] }));
  // extractor
  slideBin.add('steel', place(chamferBox(0.0044, 0.0070, 0.0230, 0.0008), { p: [slideW * 0.5 - 0.0018, 0.0060, PORT_Z + 0.0270] }));

  // cocking serrations, front and rear — real cut geometry, not a normal map
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 7; i++) {
      slideBin.add('blued', place(chamferBox(0.0022, 0.0190, 0.0028, 0.0005), {
        r: [0, 0, 0], p: [sx * (slideW * 0.5 - 0.0006), -0.0020, slideZ + 0.0640 - i * 0.0075],
      }));
    }
    for (let i = 0; i < 5; i++) {
      slideBin.add('blued', place(chamferBox(0.0022, 0.0160, 0.0028, 0.0005), {
        p: [sx * (slideW * 0.5 - 0.0006), -0.0025, slideZ - 0.0640 + i * 0.0075],
      }));
    }
    // top-edge chamfer relief
    slideBin.add('blued', place(chamferBox(0.0030, 0.0034, slideLen * 0.92, 0.0007), {
      r: [0, 0, sx * 0.6], p: [sx * (slideW * 0.5 - 0.0026), 0.0132, slideZ],
    }));
  }
  // top flat with a shallow sight rib and lightening cut
  slideBin.add('blued', place(chamferBox(0.0130, 0.0032, 0.0620, 0.0008), { p: [0, 0.0150, slideZ - 0.0300] }));
  slideBin.add('bore', place(chamferBox(0.0090, 0.0034, 0.0440, 0.0008), { p: [0, 0.0148, slideZ + 0.0200] }));

  // barrel + hood visible through the port, and the muzzle crown
  slideBin.add('steel', place(lathe([
    [2e-5, 0.0980], [0.0088, 0.0980], [0.0088, 0.0420], [0.0102, 0.0380],
    [0.0102, -0.0180], [0.0086, -0.0240], [0.0086, -0.0700], [2e-5, -0.0700],
  ], 20), { p: [0, -0.0055, slideZ] }));
  slideBin.add('bore', place(cylZ(0.0056, 0.1700, 14, 0.0004), { p: [0, -0.0055, slideZ] }));
  slideBin.add('steel', place(chamferBox(0.0110, 0.0090, 0.0260, 0.0010), { p: [0, 0.0040, PORT_Z + 0.0060] }));
  // recoil spring guide under the barrel, visible at the muzzle
  slideBin.add('steel', place(cylZ(0.0044, 0.0180, 12, 0.0006), { p: [0, -0.0165, slideZ - 0.0870] }));

  /* ================= frame ================= */
  const frameShape = polyShape([
    [-0.0140, 0.0000], [0.0140, 0.0000], [0.0140, -0.0180],
    [0.0125, -0.0230], [-0.0125, -0.0230], [-0.0140, -0.0180],
  ]);
  frameBin.add('polymer', place(extrude(frameShape, 0.1780, 0.0026, { curveSegments: 3 }), { p: [0, -0.0165, -0.0180] }));
  // dust cover with an accessory rail
  frameBin.add('polymer', place(chamferBox(0.0250, 0.0180, 0.0640, 0.0026, { round: 0.004 }), { p: [0, -0.0290, -0.0740] }));
  frameBin.add('polymer', place(picatinnyRail(0.0520, { width: 0.0200, pitch: 0.0100, slot: 0.0052, baseH: 0.0026, cleatH: 0.0044, topW: 0.0140 }), { r: [Math.PI, 0, 0], p: [0, -0.0378, -0.0760] }));

  // grip: raked, with a beavertail and a magwell funnel
  const gripProfile = [
    [-0.0060, -0.0060], [0.0060, -0.0330], [0.0135, -0.0620], [0.0200, -0.0900],
    [0.0250, -0.1080], [0.0455, -0.1140], [0.0545, -0.1060], [0.0555, -0.0740],
    [0.0500, -0.0420], [0.0430, -0.0140], [0.0380, 0.0040], [0.0180, 0.0010],
  ];
  frameBin.add('polymer', place(extrude(polyShape(gripProfile), 0.0320, 0.0060, { curveSegments: 3, bevelSegments: 3 }), {
    r: [0, -Math.PI * 0.5, 0], p: [0, -0.0180, 0.0030],
  }));
  // stippled side panels + front/back strap texture
  for (const sx of [-1, 1]) {
    frameBin.add('grip', place(chamferBox(0.0034, 0.0620, 0.0330, 0.0014), {
      r: [-0.28, 0, 0], p: [sx * 0.0158, -0.0640, 0.0290],
    }));
  }
  frameBin.add('grip', place(chamferBox(0.0300, 0.0640, 0.0044, 0.0012), { r: [-0.28, 0, 0], p: [0, -0.0640, 0.0090] }));
  frameBin.add('grip', place(chamferBox(0.0300, 0.0660, 0.0044, 0.0012), { r: [-0.28, 0, 0], p: [0, -0.0650, 0.0470] }));
  // beavertail
  frameBin.add('polymer', place(chamferBox(0.0290, 0.0140, 0.0260, 0.0035, { round: 0.006 }), { r: [0.30, 0, 0], p: [0, -0.0135, 0.0400] }));
  // magwell flare
  {
    const s = roundedRectShape(0.0340, 0.0300, 0.0050);
    s.holes.push(roundedRectHole(0, 0, 0.0268, 0.0232, 0.0040));
    frameBin.add('polymer', place(extrude(s, 0.0140, 0.0022, { curveSegments: 3 }), { r: [-0.28, 0, 0], p: [0, -0.1180, 0.0400] }));
  }

  // trigger guard with an undercut
  const guard = roundedRectShape(0.0620, 0.0430, 0.0110);
  guard.holes.push(roundedRectHole(0.0020, 0.0010, 0.0450, 0.0290, 0.0100));
  frameBin.add('polymer', place(extrude(guard, 0.0100, 0.0018, { curveSegments: 5 }), { r: [0, -Math.PI * 0.5, 0], p: [0, -0.0430, -0.0180] }));

  // controls: slide catch, safety, takedown lever, magazine release
  frameBin.add('blued', place(chamferBox(0.0044, 0.0080, 0.0300, 0.0010), { p: [-0.0152, -0.0170, 0.0000] }));
  frameBin.add('blued', place(chamferBox(0.0048, 0.0130, 0.0130, 0.0012), { p: [-0.0156, -0.0180, 0.0130] }));
  frameBin.add('blued', place(cylZ(0.0060, 0.0060, 12, 0.0008), { r: [0, Math.PI * 0.5, 0], p: [0.0155, -0.0180, 0.0180] }));
  frameBin.add('blued', place(chamferBox(0.0050, 0.0100, 0.0200, 0.0010), { r: [0, 0, 0.2], p: [0.0160, -0.0210, 0.0270] }));
  frameBin.add('blued', place(cylZ(0.0055, 0.0070, 12, 0.0009), { r: [0, Math.PI * 0.5, 0], p: [0.0158, -0.0330, 0.0100] }));
  frameBin.add('steel', place(cylZ(0.0028, 0.0300, 10, 0.0004), { r: [0, Math.PI * 0.5, 0], p: [0, -0.0250, -0.0300] }));

  /* ================= assembly ================= */
  const root = new THREE.Group();
  root.name = 'P45';
  for (const m of binToMeshes(frameBin, palette, WEAR, { prefix: 'p45' })) root.add(m);

  const slideNode = binToGroup(slideBin, palette, WEAR, { name: 'slide' });
  root.add(slideNode);

  // sights ride on the slide
  const sights = pistolSights(palette, { height: 0.0160, frontZ: slideZ - 0.0860, rearZ: slideZ + 0.0830 });
  for (const m of binToMeshes(sights.bin, palette, WEAR, { prefix: 'sights' })) slideNode.add(m);
  for (const m of sights.meshes) slideNode.add(m);

  // hammer: skeletonised, animated
  const hammerBin = new PartBin();
  const hs = roundedRectShape(0.0120, 0.0300, 0.0050);
  hs.holes.push(circleHole(0, 0.0060, 0.0034, 12));
  hammerBin.add('blued', place(extrude(hs, 0.0055, 0.0009, { curveSegments: 4 }), { r: [0, Math.PI * 0.5, 0], p: [0, 0.0100, 0] }));
  hammerBin.add('blued', place(chamferBox(0.0058, 0.0090, 0.0060, 0.0010), { p: [0, 0.0230, 0.0020] }));
  const hammerNode = binToGroup(hammerBin, palette, WEAR, { name: 'hammer' });
  hammerNode.position.set(0, -0.0110, 0.0530);
  root.add(hammerNode);

  const trg = triggerGroup({ centerZ: -0.0180, centerY: -0.0430, width: 0.0072, material: 'polymer' });
  const triggerNode = binToGroup(trg.trigger, palette, WEAR, { name: 'trigger' });
  triggerNode.position.set(0, -0.0250, -0.0100);
  root.add(triggerNode);

  const mag = magazine({
    width: 0.0250, depth: 0.0225, length: 0.1080, curve: -1 / 1.6,
    material: 'blued', floorMaterial: 'polymer',
  });
  const magazineNode = binToGroup(mag.bin, palette, WEAR, { name: 'magazine' });
  magazineNode.position.set(0, -0.0290, 0.0310);
  magazineNode.rotation.x = -0.28;
  root.add(magazineNode);

  const sockets = {
    muzzle: mkNode(root, 'muzzle', [0, -0.0055, -0.1090]),
    eject: mkNode(root, 'eject', [0.0190, 0.0040, PORT_Z]),
    grip: handSocket('gripSocket', [0.0350, -0.0440, 0.0810], GRIP_BASIS, [-0.30, 0, 0]),
    support: handSocket('supportSocket', [-0.0700, -0.0880, -0.0270], PISTOL_SUPPORT_BASIS, [0.10, 0, 0.22]),
    magwell: mkNode(root, 'magwell', [0, -0.0290, 0.0310]),
  };
  root.add(sockets.grip, sockets.support);

  return {
    root,
    parts: { magazine: magazineNode, slide: slideNode, hammer: hammerNode, trigger: triggerNode },
    sockets,
    optic: sights,
    forearm: { right: [0.30, 0.60, 0], left: [0.34, -0.62, 0] },
    sightHeight: 0.0210,
    sightZ: slideZ + 0.0830,
    slideTravel: 0.0420,
  };
}

function mkNode(parent, name, p) {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.fromArray(p);
  parent.add(o);
  return o;
}
