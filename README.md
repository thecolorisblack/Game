# OPERATION BLACKOUT

A browser first-person shooter built on [three.js](https://threejs.org), aimed squarely at
modern-military-shooter production values — HDR rendering with a full post chain, procedural
PBR materials, a hand-built weapon viewmodel with real animation state machines, skinned and
ragdolled enemies, and a synthesised soundscape.

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm run build
npm run shoot      # headless capture -> shots/
```

## The one unusual constraint

**Nothing is downloaded and nothing is a file.** There is not a single `.png`, `.gltf`, `.wav`
or `.hdr` in this repository. Every texture is baked from noise at boot, every mesh is
constructed from primitives in code, every animation is a curve authored in JavaScript, and
every sound is synthesised through `OfflineAudioContext`. The whole game is the bundle.

That is a deliberate constraint rather than a limitation to apologise for — it keeps the build
hermetic and the repo tiny — but it is the main thing shaping how the art looks, and it is worth
knowing before comparing any frame here to a shipped title whose texture budget is measured in
tens of gigabytes.

## Layout

| path | what |
|---|---|
| `src/core/` | game loop, input, renderer ownership, settings, capture hook |
| `src/render/` | procedural material library, HDR post-processing chain |
| `src/world/` | level generation, sky/atmosphere, cascaded shadow lighting |
| `src/physics/` | BVH collision, capsule character sweep, debris + ragdoll solver |
| `src/player/` | movement model, stances, camera rig, recoil/shake |
| `src/weapons/` | procedural weapon meshes, viewmodel animation, ballistics |
| `src/vfx/` | particles, decals, tracers, impacts, explosions |
| `src/ai/` | skinned enemy characters, animation blending, navmesh, behaviour |
| `src/audio/` | synthesised weapons/footsteps/ambience, convolution reverb |
| `src/ui/` | HUD canvas, menus, settings |

[`ARCHITECTURE.md`](./ARCHITECTURE.md) is the binding contract between these modules — boot
order, lifecycle hooks, the event vocabulary and who owns which files.

## Controls

| | |
|---|---|
| move / sprint / crouch | `WASD` · `Shift` · `Ctrl` |
| jump · slide | `Space` · `Ctrl` while sprinting |
| fire · aim | mouse 1 · mouse 2 |
| reload · swap · melee · grenade | `R` · `1`/`2` · `V` · `G` |
| pause | `Esc` |

## Capture harness

`npm run shoot` builds the game, serves it, drives it through the shot list in
`scripts/shots.mjs` inside headless Chromium, and writes PNGs to `shots/`. Each shot targets one
quality claim (sky and atmosphere, viewmodel readability, muzzle flash, material close-up,
night lighting …) so a frame can be judged against a single question.

CI renders under SwiftShader, so the frame rate reported there is not a performance signal —
only the pixels are.
