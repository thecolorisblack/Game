# OPERATION BLACKOUT — module contract

Hard rules for every contributor (human or agent):

1. **Own only your files.** Never edit a file listed under another module's ownership.
   If you need something from another module, go through `game.<name>` or the event bus.
2. **No network at runtime.** There is no CDN, no asset server, no `fetch()` of textures or
   models. Every texture, mesh, animation and sound is generated procedurally in code.
   `three` and `three/addons/*` are the only runtime imports besides local files.
3. **Everything must survive a headless Chromium screenshot.** No `alert`, no
   user-gesture-gated code paths on the critical path (audio may be gesture-gated but
   must not block boot).
4. **Never leave the build broken.** Run `npm run build` before you finish.
5. **60fps at 1920x1080 is the target.** Budget: ≤3.5 ms CPU per frame for all gameplay
   systems combined, ≤900 draw calls, ≤2.5 M triangles.

## Boot sequence (`src/main.js`, owned by the integrator — do not edit)

Systems are constructed and `init()`ed in this order, each awaited:

| order | key | class | file |
|---|---|---|---|
| 1 | `materials` | `Materials` | `src/render/Materials.js` |
| 2 | `physics` | `Physics` | `src/physics/Physics.js` |
| 3 | `world` | `World` | `src/world/World.js` |
| 4 | `postfx` | `PostFX` | `src/render/PostFX.js` |
| 5 | `player` | `Player` | `src/player/Player.js` |
| 6 | `weapons` | `WeaponSystem` | `src/weapons/WeaponSystem.js` |
| 7 | `vfx` | `VFX` | `src/vfx/VFX.js` |
| 8 | `ai` | `AISystem` | `src/ai/AISystem.js` |
| 9 | `audio` | `AudioEngine` | `src/audio/AudioEngine.js` |
| 10 | `hud` | `HUD` | `src/ui/HUD.js` |
| 11 | `menu` | `Menu` | `src/ui/Menu.js` |

Every system class:

```js
export class Thing {
  constructor(game) { this.game = game; }
  async init() {}                  // may be sync; awaited either way
  fixedUpdate(dt) {}               // optional, dt === 1/120, only while state==='playing'
  update(dt, time) {}              // optional, variable dt
  lateUpdate(dt) {}                // optional, after all update()s
}
```

`game` exposes: `engine`, `renderer`, `scene` (world), `camera`, `time`, `input`,
`settings`, `bus`, `state`, `setState(s)`, plus every registered system by key.

`game.engine` also exposes `viewScene` and `viewCamera` — **layer 1**, the first-person
viewmodel pass, rendered separately with a 0.005 near plane.

## Render contract

- `Engine` renders nothing itself. `PostFX.render(dt)` is the only thing that calls
  `renderer.render(...)`, once per frame, from `Game.tick`.
- The world pass must write into an HDR (`HalfFloatType`) target. Tone mapping,
  exposure and sRGB conversion happen at the **end** of the post chain, never on the
  renderer.
- Materials are authored **scene-referred/linear**. Colour textures use
  `SRGBColorSpace`; normal/roughness/metalness/AO use `NoColorSpace`.
- Any system adding a mesh to `game.scene` must set `castShadow`/`receiveShadow`
  deliberately and set `mesh.frustumCulled = true` unless it has a good reason.

## Event bus vocabulary

Emitters must use exactly these names/payloads; listeners may add more.

| event | payload | emitted by |
|---|---|---|
| `state` | `{prev, next}` | Game |
| `boot:complete` | – | main |
| `frame:end` | `Time` | Game |
| `weapon:fire` | `{weapon, origin:Vector3, dir:Vector3, spread, isADS}` | WeaponSystem |
| `weapon:dryfire` | `{weapon}` | WeaponSystem |
| `weapon:reload` | `{weapon, tactical:boolean}` | WeaponSystem |
| `weapon:switch` | `{from, to}` | WeaponSystem |
| `weapon:ammo` | `{mag, reserve, max}` | WeaponSystem |
| `bullet:impact` | `{point:Vector3, normal:Vector3, surface:string, object, dir:Vector3}` | WeaponSystem |
| `bullet:whizby` | `{distance}` | WeaponSystem |
| `damage:dealt` | `{target, amount, headshot:boolean, point:Vector3}` | WeaponSystem/AI |
| `damage:taken` | `{amount, from:Vector3, health}` | Player |
| `enemy:killed` | `{enemy, headshot, weapon, point:Vector3}` | AISystem |
| `enemy:spawn` | `{enemy}` | AISystem |
| `player:died` | `{from}` | Player |
| `player:land` | `{impact:number}` | Player |
| `player:footstep` | `{surface, running, position}` | Player |
| `player:stance` | `{stance:'stand'\|'crouch'\|'slide'\|'air'}` | Player |
| `camera:shake` | `{amplitude, frequency, duration, direction?}` | anyone |
| `hitmarker` | `{headshot, kill}` | WeaponSystem |
| `explosion` | `{position:Vector3, radius, power}` | anyone |
| `objective` | `{text, progress?}` | AISystem/World |

## Surface material ids

Used by `bullet:impact.surface`, footstep audio and decal/particle selection:
`concrete`, `metal`, `wood`, `sand`, `glass`, `water`, `dirt`, `fabric`, `flesh`, `foliage`.

## Physics contract (`src/physics/Physics.js`)

```js
physics.addStatic(mesh, { surface:'concrete' })   // registers into the BVH world
physics.build()                                    // called by World after level gen
physics.raycast(origin, dir, maxDist, opts)        // -> {point, normal, distance, object, surface} | null
physics.sphereCast(origin, dir, radius, maxDist)   // -> same shape | null
physics.capsuleMove(pos, delta, radius, height)    // -> {position, grounded, normal, hitWall}
physics.overlapSphere(center, radius)              // -> [objects]
```

Everything that needs to know "did the bullet hit a wall" or "can the player walk here"
goes through `physics`. No system may keep its own duplicate collider list.

## Ownership map

| module | files | owner |
|---|---|---|
| core | `src/core/**`, `src/main.js`, `index.html` | integrator |
| materials | `src/render/Materials.js`, `src/render/textures/**` | materials agent |
| post | `src/render/PostFX.js`, `src/render/passes/**`, `src/render/shaders/**` | render agent |
| world | `src/world/**` | world agent |
| physics | `src/physics/**` | physics agent |
| player | `src/player/**` | player agent |
| weapons | `src/weapons/**` | weapons agent |
| vfx | `src/vfx/**` | vfx agent |
| ai | `src/ai/**` | ai agent |
| audio | `src/audio/**` | audio agent |
| ui | `src/ui/**` | ui agent |

## Capture harness

`npm run shoot` builds, serves, launches headless Chromium, drives the game through a
scripted camera/action sequence and writes PNGs to `shots/`. Any change that cannot be
verified in a screenshot is not finished.
