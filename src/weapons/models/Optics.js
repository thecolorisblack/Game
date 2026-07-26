import * as THREE from 'three';
import {
  PartBin, chamferBox, extrude, lathe, cylZ, tubeZ, torusZ, place, knurlBand,
  screwZ, roundedRectShape, circleHole, polyShape, mergeParts, applyBoxUV, flatColor,
} from './Parts.js';

/**
 * Optics.
 *
 * Two things here are worth more than all the geometry: the red dot's reticle is
 * genuinely collimated — it is computed from the *angle* between the eye ray and
 * the optic axis, not stamped at a fixed spot on the glass, so it floats at
 * infinity and stays put as the head moves — and the magnified scope renders the
 * world through a second camera into a texture, then puts it behind a lens
 * shader with barrel distortion, chromatic fringing, an anti-reflective coating
 * rim and the black scope shadow that appears the moment your eye leaves the
 * exit pupil.
 */

/* ==================================================================== */
/* shaders                                                               */
/* ==================================================================== */

const RETICLE_VERT = /* glsl */`
  varying vec3 vLocal;
  void main() {
    vLocal = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

/**
 * Collimated reticle. `uCamLocal` is the eye position expressed in the optic's
 * own space; the dot is drawn wherever the eye ray is parallel to the optic
 * axis, which is exactly what a real reflex sight does.
 */
const RETICLE_FRAG = /* glsl */`
  uniform vec3  uCamLocal;
  uniform vec3  uColor;
  uniform float uBrightness;
  uniform float uSize;      // angular radius of the dot, radians
  uniform float uWindow;    // lens radius in local units
  uniform float uRing;      // 0 = plain dot, 1 = dot inside a ring
  varying vec3  vLocal;

  void main() {
    float r = length( vLocal.xy );
    if ( r > uWindow ) discard;

    vec3 d = normalize( vLocal - uCamLocal );
    float fwd = max( 1e-4, -d.z );
    vec2 ang = d.xy / fwd;
    float a = length( ang );

    float dot0 = 1.0 - smoothstep( uSize * 0.45, uSize, a );
    float glow = exp( -( a * a ) / ( uSize * uSize * 9.0 ) ) * 0.30;
    float ring = uRing * (
        smoothstep( uSize * 3.6, uSize * 3.2, a ) * smoothstep( uSize * 2.6, uSize * 3.0, a ) );

    // ghost ring: the faint secondary reflection every reflex sight has
    float ghost = 0.05 * smoothstep( uWindow * 0.95, uWindow * 0.62, r )
                       * smoothstep( uWindow * 0.30, uWindow * 0.55, r );

    float e = dot0 + glow + ring * 0.65 + ghost;
    e *= 1.0 - smoothstep( uWindow * 0.88, uWindow, r );
    if ( e <= 0.0005 ) discard;
    gl_FragColor = vec4( uColor * uBrightness * e, e );
  }
`;

const SCOPE_VERT = /* glsl */`
  varying vec2 vUv;
  varying vec3 vLocal;
  void main() {
    vUv = uv;
    vLocal = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

const SCOPE_FRAG = /* glsl */`
  uniform sampler2D tScope;
  uniform vec3  uCamLocal;
  uniform float uAberration;
  uniform float uShadow;      // 0 = perfect eye position, 1 = fully occluded
  uniform float uReticle;     // reticle opacity
  uniform vec3  uReticleColor;
  uniform float uWindow;
  uniform float uActive;
  varying vec2  vUv;
  varying vec3  vLocal;

  float line( float v, float w, float soft ) {
    return 1.0 - smoothstep( w, w + soft, abs( v ) );
  }

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length( p );
    if ( r > 1.0 ) discard;

    // eye-position dependent parallax + scope shadow
    vec3 d = normalize( vLocal - uCamLocal );
    vec2 off = ( d.xy / max( 1e-4, -d.z ) ) * 2.2;
    float eye = length( off );

    // slight pincushion so the edge of the image bends like real glass
    vec2 q = p * ( 1.0 + 0.055 * r * r ) + off * 0.35;
    vec2 uv = q * 0.5 + 0.5;

    float k = uAberration * ( 0.35 + r * r );
    vec3 col;
    col.r = texture2D( tScope, ( uv - 0.5 ) * ( 1.0 + k ) + 0.5 ).r;
    col.g = texture2D( tScope, uv ).g;
    col.b = texture2D( tScope, ( uv - 0.5 ) * ( 1.0 - k ) + 0.5 ).b;
    col = mix( vec3( 0.004, 0.006, 0.009 ), col, uActive );

    // ---- reticle: duplex crosshair with mil dots -----------------------
    float px = fwidth( p.x ) * 1.2;
    float thin = 0.006;
    float thick = 0.026;
    float cross = 0.0;
    cross += line( p.y, thin, px ) * step( abs( p.x ), 0.62 );
    cross += line( p.x, thin, px ) * step( abs( p.y ), 0.62 );
    cross += line( p.y, thick, px ) * step( 0.62, abs( p.x ) );
    cross += line( p.x, thick, px ) * step( 0.62, abs( p.y ) );
    float dots = 0.0;
    for ( int i = 1; i < 4; i ++ ) {
      float t = float( i ) * 0.155;
      dots += 1.0 - smoothstep( 0.011, 0.011 + px, length( p - vec2( 0.0,  t ) ) );
      dots += 1.0 - smoothstep( 0.011, 0.011 + px, length( p - vec2( 0.0, -t ) ) );
      dots += 1.0 - smoothstep( 0.011, 0.011 + px, length( p - vec2(  t, 0.0 ) ) );
      dots += 1.0 - smoothstep( 0.011, 0.011 + px, length( p - vec2( -t, 0.0 ) ) );
    }
    float ret = clamp( cross + dots, 0.0, 1.0 ) * uReticle;
    // centre aiming dot, slightly emissive
    float centre = 1.0 - smoothstep( 0.010, 0.016, r );
    col = mix( col, uReticleColor * 0.06, ret );
    col += uReticleColor * centre * 0.35 * uReticle;

    // ---- glass + tube --------------------------------------------------
    // anti-reflective coating: cool rim sheen
    float rim = smoothstep( 0.72, 0.99, r );
    col += vec3( 0.030, 0.055, 0.090 ) * rim * 0.9 * uActive;

    // scope shadow: hard black crescent driven by eye offset, plus the fixed
    // exit-pupil vignette
    float shadow = smoothstep( 0.68, 1.0, r + eye * 1.15 + uShadow * 0.55 );
    col *= 1.0 - shadow;

    float alpha = 1.0;
    gl_FragColor = vec4( col, alpha );
  }
`;

/* ==================================================================== */
/* red dot                                                               */
/* ==================================================================== */

/**
 * Tube reflex sight. Returns the housing bin plus loose meshes (glass +
 * reticle) that must stay separate because they use bespoke materials.
 *
 * @returns {{bin:PartBin, meshes:THREE.Object3D[], sightHeight:number, update:Function}}
 */
export function redDotSight(palette, opts = {}) {
  const bin = new PartBin();
  const rTube = opts.radius ?? 0.0180;
  const len = opts.length ?? 0.072;
  const mountH = opts.mountHeight ?? 0.0300;   // bore axis -> optic axis
  const mat = opts.material ?? 'alloy';
  const meshes = [];

  // --- mount ---------------------------------------------------------
  const foot = chamferBox(0.0330, 0.0075, 0.048, 0.0016, { round: 0.0025 });
  foot.translate(0, 0.0038, 0);
  bin.add(mat, foot);
  const riser = chamferBox(0.0270, mountH - 0.019, 0.040, 0.0020, { round: 0.0035 });
  riser.translate(0, (mountH - 0.019) * 0.5 + 0.0075, 0);
  bin.add(mat, riser);
  // clamp bar + cross bolts
  bin.add(mat, place(chamferBox(0.0075, 0.0130, 0.042, 0.0012), { p: [0.0180, 0.0075, 0] }));
  for (const dz of [-0.013, 0.013]) {
    bin.add('steel', place(screwZ(0.0030, 0.0013, 0.006), { r: [0, Math.PI * 0.5, 0], p: [0.0215, 0.0075, dz] }));
  }

  // --- body ----------------------------------------------------------
  const bodyY = mountH;
  const body = tubeZ(rTube, rTube - 0.0028, len, 26, 0.0012);
  body.translate(0, bodyY, 0);
  bin.add(mat, body);
  // objective + ocular bells
  for (const [z, rr] of [[-len * 0.5 + 0.006, rTube + 0.0018], [len * 0.5 - 0.006, rTube + 0.0022]]) {
    const bell = tubeZ(rr, rTube - 0.0030, 0.0125, 26, 0.0012);
    bell.translate(0, bodyY, z);
    bin.add(mat, bell);
  }
  // turret bosses with knurled caps
  for (const [ax, ay, rot] of [[0, rTube, 0], [rTube, 0, Math.PI * 0.5]]) {
    const boss = cylZ(0.0092, 0.0125, 16, 0.0010);
    boss.rotateX(rot === 0 ? -Math.PI * 0.5 : 0);
    if (rot !== 0) boss.rotateY(Math.PI * 0.5);
    boss.translate(ax * 1.0, bodyY + ay * 1.0, -0.004);
    bin.add(mat, boss);
    const cap = knurlBand(0.0082, 0.0095, 10, 0.0006, 16);
    cap.rotateX(rot === 0 ? -Math.PI * 0.5 : 0);
    if (rot !== 0) cap.rotateY(Math.PI * 0.5);
    cap.translate(ax * 1.55, bodyY + ay * 1.55, -0.004);
    bin.add('blued', cap);
  }
  // battery / brightness dial on the left
  const dial = knurlBand(0.0098, 0.0088, 12, 0.0007, 18);
  dial.rotateY(Math.PI * 0.5);
  dial.translate(-rTube - 0.0035, bodyY, 0.010);
  bin.add('blued', dial);
  bin.add('steel', place(cylZ(0.0022, 0.004, 8, 0.0003), { r: [0, Math.PI * 0.5, 0], p: [-rTube - 0.0085, bodyY, 0.010] }));

  // internal shade tube (kills the "cardboard ring" look from inside)
  const shade = tubeZ(rTube - 0.0031, rTube - 0.0042, len * 0.92, 20, 0.0004);
  shade.translate(0, bodyY, 0);
  bin.add('rubber', shade);

  // --- glass ---------------------------------------------------------
  const glassR = rTube - 0.0034;
  const frontGlass = new THREE.Mesh(
    applyBoxUV(new THREE.CircleGeometry(glassR, 28), 3),
    palette.lens,
  );
  frontGlass.position.set(0, bodyY, -len * 0.5 + 0.010);
  frontGlass.rotation.y = Math.PI;
  frontGlass.renderOrder = 4;
  meshes.push(frontGlass);

  const rearGlass = new THREE.Mesh(
    applyBoxUV(new THREE.CircleGeometry(glassR, 28), 3),
    palette.lensRear,
  );
  rearGlass.position.set(0, bodyY, len * 0.5 - 0.010);
  rearGlass.renderOrder = 5;
  meshes.push(rearGlass);

  // --- reticle -------------------------------------------------------
  const uniforms = {
    uCamLocal: { value: new THREE.Vector3(0, 0, 1) },
    uColor: { value: new THREE.Color(opts.color ?? 0xff2d18) },
    uBrightness: { value: opts.brightness ?? 7.5 },
    uSize: { value: opts.dotSize ?? 0.0042 },
    uWindow: { value: glassR * 0.98 },
    uRing: { value: opts.ring === false ? 0 : 1 },
  };
  const reticleMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: RETICLE_VERT,
    fragmentShader: RETICLE_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    toneMapped: true,
  });
  reticleMat.name = 'reticle';
  const reticle = new THREE.Mesh(new THREE.PlaneGeometry(glassR * 2, glassR * 2), reticleMat);
  reticle.position.set(0, bodyY, -len * 0.5 + 0.0125);
  reticle.renderOrder = 6;
  reticle.frustumCulled = false;
  meshes.push(reticle);

  const inv = new THREE.Matrix4();
  reticle.onBeforeRender = (renderer, scene, camera) => {
    inv.copy(reticle.matrixWorld).invert();
    uniforms.uCamLocal.value.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inv);
  };

  return {
    bin,
    meshes,
    sightHeight: bodyY,
    type: 'reflex',
    magnification: 1,
    setBrightness: (v) => { uniforms.uBrightness.value = v; },
  };
}

/* ==================================================================== */
/* magnified scope                                                       */
/* ==================================================================== */

/**
 * Variable-power scope with a live render-to-texture image.
 *
 * The returned `render(renderer, scene, camera)` hook is driven once per frame
 * by the weapon system, and only while the scope is actually being looked
 * through — a second full scene pass is not something you pay for at the hip.
 */
export function magnifiedScope(palette, opts = {}) {
  const bin = new PartBin();
  const rTube = opts.radius ?? 0.0170;
  const rObj = opts.objective ?? 0.0270;
  const rOcu = opts.ocular ?? 0.0235;
  const len = opts.length ?? 0.290;
  const mountH = opts.mountHeight ?? 0.0395;
  const mat = opts.material ?? 'alloy';
  const meshes = [];
  const bodyY = mountH;

  // --- rings ---------------------------------------------------------
  for (const dz of [-0.052, 0.052]) {
    const ring = tubeZ(rTube + 0.0062, rTube, 0.0225, 24, 0.0014);
    ring.translate(0, bodyY, dz);
    bin.add(mat, ring);
    const base = chamferBox(0.0290, mountH - 0.0100, 0.0250, 0.0018, { round: 0.003 });
    base.translate(0, (mountH - 0.0100) * 0.5 + 0.0032, dz);
    bin.add(mat, base);
    const foot = chamferBox(0.0330, 0.0072, 0.0290, 0.0014, { round: 0.0022 });
    foot.translate(0, 0.0036, dz);
    bin.add(mat, foot);
    // ring cap screws
    for (const sx of [-1, 1]) {
      for (const dz2 of [-0.0072, 0.0072]) {
        bin.add('steel', place(screwZ(0.0024, 0.0011, 0.004), {
          r: [Math.PI * 0.5, 0, 0],
          p: [sx * (rTube + 0.0042), bodyY + 0.0068, dz + dz2],
        }));
      }
    }
    bin.add('steel', place(screwZ(0.0032, 0.0014, 0.006), { r: [0, Math.PI * 0.5, 0], p: [0.0195, 0.0060, dz] }));
  }

  // --- tube ----------------------------------------------------------
  const tube = tubeZ(rTube, rTube - 0.0026, len * 0.62, 26, 0.0012);
  tube.translate(0, bodyY, 0);
  bin.add(mat, tube);

  // objective bell + sunshade
  const objZ = -len * 0.5 + 0.052;
  bin.add(mat, place(lathe([
    [rTube - 0.0026, 0.060], [rTube, 0.060], [rTube, 0.040],
    [rObj, 0.012], [rObj, -0.048], [rObj - 0.0030, -0.052],
    [rObj - 0.0058, -0.052], [rObj - 0.0058, 0.056], [rTube - 0.0026, 0.060],
  ], 28), { p: [0, bodyY, objZ] }));
  bin.add('rubber', place(tubeZ(rObj - 0.0058, rObj - 0.0072, 0.090, 24, 0.0006), { p: [0, bodyY, objZ - 0.006] }));

  // ocular bell + eyepiece
  const ocuZ = len * 0.5 - 0.046;
  bin.add(mat, place(lathe([
    [rTube - 0.0026, -0.050], [rTube, -0.050], [rTube, -0.030],
    [rOcu, -0.008], [rOcu, 0.038], [rOcu - 0.0030, 0.042],
    [rOcu - 0.0062, 0.042], [rOcu - 0.0062, -0.046], [rTube - 0.0026, -0.050],
  ], 28), { p: [0, bodyY, ocuZ] }));
  // rubber eyecup
  bin.add('rubber', place(lathe([
    [rOcu - 0.0062, 0], [rOcu + 0.0012, 0], [rOcu + 0.0026, 0.010],
    [rOcu + 0.0020, 0.020], [rOcu - 0.0050, 0.020], [rOcu - 0.0062, 0.012],
  ], 26), { p: [0, bodyY, ocuZ + 0.040] }));

  // magnification ring with a throw lever
  bin.add('blued', place(knurlBand(rOcu + 0.0018, 0.0180, 16, 0.0008, 26), { p: [0, bodyY, ocuZ - 0.030] }));
  bin.add('blued', place(chamferBox(0.0075, 0.0250, 0.0110, 0.0014), {
    r: [0, 0, -0.35], p: [-rOcu - 0.0125, bodyY + 0.0170, ocuZ - 0.030],
  }));

  // turrets: capped elevation on top, windage right, parallax left
  const turret = (rot, height, r0, r1) => {
    const stack = mergeParts([
      place(lathe([[r0 + 0.0030, 0], [r0 + 0.0030, 0.0045], [r0, 0.0050], [r0, height]], 22), {}),
      place(knurlBand(r1, height * 0.62, 12, 0.0008, 20), { p: [0, 0, height * 0.66] }),
      place(lathe([[2e-5, height * 0.98], [r1, height * 0.98], [r1 - 0.0012, height]], 20), {}),
    ]);
    stack.rotateX(-Math.PI * 0.5);
    if (rot) stack.rotateZ(rot);
    return stack;
  };
  bin.add(mat, place(turret(0, 0.0230, 0.0105, 0.0092), { p: [0, bodyY + rTube - 0.0015, -0.008] }));
  bin.add(mat, place(turret(-Math.PI * 0.5, 0.0205, 0.0100, 0.0088), { p: [rTube - 0.0015, bodyY, -0.008] }));
  bin.add(mat, place(turret(Math.PI * 0.5, 0.0150, 0.0110, 0.0098), { p: [-rTube + 0.0015, bodyY, 0.010] }));

  // --- glass + image -------------------------------------------------
  const size = opts.renderSize ?? 512;
  const target = new THREE.WebGLRenderTarget(size, size, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    type: THREE.HalfFloatType,
    colorSpace: THREE.NoColorSpace,
    depthBuffer: true,
    generateMipmaps: false,
  });
  target.texture.name = 'scopeRT';

  const scopeCam = new THREE.PerspectiveCamera(opts.fov ?? 7.5, 1, 0.25, 1800);
  scopeCam.rotation.order = 'YXZ';

  const uniforms = {
    tScope: { value: target.texture },
    uCamLocal: { value: new THREE.Vector3(0, 0, 1) },
    uAberration: { value: opts.aberration ?? 0.0075 },
    uShadow: { value: 0 },
    uReticle: { value: 1 },
    uReticleColor: { value: new THREE.Color(opts.reticleColor ?? 0xff2a12) },
    uWindow: { value: 1 },
    uActive: { value: 0 },
  };
  const lensMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: SCOPE_VERT,
    fragmentShader: SCOPE_FRAG,
    transparent: false,
    depthWrite: true,
    depthTest: true,
    toneMapped: true,
  });
  lensMat.name = 'scopeLens';

  const glassR = rOcu - 0.0070;
  const lens = new THREE.Mesh(new THREE.CircleGeometry(glassR, 40), lensMat);
  lens.position.set(0, bodyY, ocuZ + 0.0405);
  lens.renderOrder = 4;
  lens.frustumCulled = false;
  meshes.push(lens);

  // objective glass (front) so the scope is not a black hole from outside
  const objGlass = new THREE.Mesh(new THREE.CircleGeometry(rObj - 0.0064, 30), palette.lens);
  objGlass.position.set(0, bodyY, objZ - 0.0505);
  objGlass.rotation.y = Math.PI;
  objGlass.renderOrder = 4;
  meshes.push(objGlass);

  const inv = new THREE.Matrix4();
  lens.onBeforeRender = (renderer, scene, camera) => {
    inv.copy(lens.matrixWorld).invert();
    uniforms.uCamLocal.value.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inv);
  };

  const fwd = new THREE.Vector3();
  const q = new THREE.Quaternion();

  /**
   * Render the world through the scope. Guarded and self-restoring: it runs
   * before PostFX takes over the frame and must leave the renderer exactly as
   * it found it.
   */
  function render(renderer, scene, viewCamera, magnification) {
    if (!renderer || !scene) return;
    lens.updateWorldMatrix(true, false);
    lens.matrixWorld.decompose(scopeCam.position, q, fwd);
    scopeCam.quaternion.copy(q);
    // The lens faces the shooter; the scope looks the other way.
    scopeCam.rotateY(Math.PI);
    scopeCam.position.setFromMatrixPosition(viewCamera.matrixWorld);
    scopeCam.fov = (opts.fov ?? 7.5) * (opts.baseMag ?? 6) / Math.max(0.25, magnification ?? (opts.baseMag ?? 6));
    scopeCam.updateProjectionMatrix();
    scopeCam.updateMatrixWorld(true);

    const prevTarget = renderer.getRenderTarget();
    const prevActive = renderer.getActiveCubeFace?.();
    const shadowMap = renderer.shadowMap;
    const prevShadowAuto = shadowMap ? shadowMap.autoUpdate : null;
    try {
      // Never let the second view of the world re-bake the cascades.
      if (shadowMap) shadowMap.autoUpdate = false;
      renderer.setRenderTarget(target);
      renderer.clear(true, true, false);
      renderer.render(scene, scopeCam);
    } finally {
      renderer.setRenderTarget(prevTarget, prevActive);
      if (shadowMap) shadowMap.autoUpdate = prevShadowAuto;
    }
  }

  return {
    bin,
    meshes,
    sightHeight: bodyY,
    type: 'scope',
    magnification: opts.baseMag ?? 6,
    lens,
    uniforms,
    render,
    dispose() { target.dispose(); lensMat.dispose(); },
  };
}

/* ==================================================================== */
/* fixed iron sight blocks used by the pistol                            */
/* ==================================================================== */

/** Three-dot pistol sights with tritium inserts. */
export function pistolSights(palette, opts = {}) {
  const bin = new PartBin();
  const meshes = [];
  const y = opts.height ?? 0.0135;
  const frontZ = opts.frontZ ?? -0.088;
  const rearZ = opts.rearZ ?? 0.052;

  const front = extrude(polyShape([
    [-0.0032, 0], [0.0032, 0], [0.0032, 0.0078], [-0.0018, 0.0078], [-0.0032, 0.0050],
  ]), 0.0042, 0.0006, { curveSegments: 2 });
  front.rotateY(-Math.PI * 0.5);
  front.translate(0, y, frontZ);
  bin.add('blued', front);

  const rearShape = roundedRectShape(0.0165, 0.0082, 0.0010);
  rearShape.holes.push(polyShape([
    [-0.0018, -0.0006], [0.0018, -0.0006], [0.0018, 0.0060], [-0.0018, 0.0060],
  ]));
  const rear = extrude(rearShape, 0.0058, 0.0006, { curveSegments: 2 });
  rear.rotateY(Math.PI * 0.5);
  rear.translate(0, y + 0.0016, rearZ);
  bin.add('blued', rear);

  // tritium vials
  const vial = new THREE.SphereGeometry(0.00085, 8, 6);
  for (const [x, z] of [[0, frontZ + 0.0022], [-0.0052, rearZ + 0.0030], [0.0052, rearZ + 0.0030]]) {
    const m = new THREE.Mesh(vial.clone(), palette.tritium);
    m.position.set(x, y + (z === frontZ + 0.0022 ? 0.0050 : 0.0030), z);
    m.frustumCulled = false;
    meshes.push(m);
  }

  return { bin, meshes, sightHeight: y + 0.0050, type: 'iron', magnification: 1 };
}
