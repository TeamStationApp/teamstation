# Field lab

Standalone React Native screen at `/field`, reachable through the baseball icon
in the shared navigation (bottom on phones, header on wider screens). It is public
and does not restore a session or call the API. Normal app routes still require
sign-in. All positions are local state and reset when the screen unmounts.

## Web preview, no database

```sh
npm ci
npm run preview.field
# http://localhost:8080/field
```

`npm run build.field` creates a static production preview in `dist/`. Serve it
with an SPA fallback to `index.html`. The compile-time `GS_FIELD_PREVIEW=1` flag
starts the root URL on `/field` and prevents API/session requests across preview
navigation, including deep links. Omit the flag (`npm run build.web`) for the
normal app. No server or database configuration changes are needed.

Drag any player with a mouse or touch. Players turn toward and run to the moving
destination, finishing their run after release. Alternatively choose a roster
button and tap the turf. Nine blue fielders and three orange runners move
independently. Camera presets, zoom, next-base/run-a-play and reset are local.

## Integration boundaries

- `BaseballScreen.tsx`: shared React Native controls and screen state. Mount it
  from another navigator without API, account or theme-specific dependencies
  beyond the existing GameStation providers.
- `FieldScene.tsx`, `Ballpark.tsx`, `Player.tsx`: React Three Fiber geometry,
  lighting, pointer controls and articulated procedural animation. No fetched
  models, textures, stadium assets, database IDs or external services.
- `fieldModel.ts`: world coordinates, bounds and frame-independent movement.
  Units are metres, home is `(0, 0)`, center field is negative z. Basepaths are
  27.432m. Player scale is deliberately exaggerated for interaction.
- `FieldCanvas.tsx`: browser renderer, WebGL2 capability check and recovery.
- `FieldCanvas.native.tsx`: explicit unavailable state for this web milestone.
  **It does not render native 3D yet.** The repository is bare React Native and
  has no Expo GL host. The native integrator must install/configure compatible
  Expo modules (`expo-gl` and R3F's native asset peers), use `Canvas` from
  `@react-three/fiber/native`, and mount `FieldScene` in this adapter. Adjust
  pointer event types/capture for the native event bridge and verify on devices.
  No WebView is introduced, and native builds retain their existing host setup.

React and React DOM are pinned to 19.2.4 because Fiber 9.7.0 declares React
`>=19 <19.3`; React Native 0.87.1 accepts 19.2.4. Keep renderer versions aligned
when updating. Native GPU/device testing is a separate integration gate.

## Verification

```sh
npx tsc -p tsconfig.app.json
npm run typecheck.native
npx mocha -r sucrase/register src2/app/field/fieldModel.test.ts src2/app/field/fieldScene.test.ts src2/app/navigation/routes.test.ts src2/app/navigation/tabPress.test.ts
npm run build.web
npm run build.field
```

The cloud browser used during development disables WebGL, so browser checks
cover the public route, navigation and GPU-unavailable recovery. Check rendering,
touch drag/cancel and frame rate in Safari/Chrome on real phones before merging.

## Detail pass / older-phone budget

The rendering target is 2021-era iOS and Android phones, including midrange
Android hardware. Aim for 30 fps while moving; this is a design target, not a
measured device guarantee. iPhone 13 (2021, A15) is an iOS reference:
https://support.apple.com/en-us/111872. Android Chrome/WebGL2 and iOS Safari/WebGL2
still need physical-device frame-time and thermal checks.

- Players move 40% faster; stride length increases to keep the run cycle natural.
- Grass, dirt, cloth and weathered wall maps are deterministic 256px DataTextures.
  UVs use field coordinates; the infield has a rounded dirt arc and base wear.
- Rounded limbs and tapered jerseys replace the block bodies. Repeated stands
  and approximately 1,200 seats use two instanced draws.
- The enlarged scoreboard uses one 1024×512 texture with a hand-drawn 5×7 bulb
  font. Warm halos are baked into that texture: no bloom pass, per-bulb geometry,
  point lights, external fonts or image requests. The oversized board sits behind the back row of stands; **Home** frames it
  together with home plate. **Board** provides an optional close-up.
- `scoreboardModel.ts` holds fictional exhibition data. “Number of pitchers” is
  interpreted as **pitch count** and labeled PITCHES. Name formatting is first
  name + last initial. The board has exactly 3 ball sockets, 2 strike sockets and
  2 out sockets; unused sockets are dim. `Scoreboard` accepts a typed state prop
  for the integrating agent. Display values are not tied to the free-play moves.
- At rest the canvas stops drawing. Movement, camera changes and RN commands
  explicitly wake it. Pixel ratio is capped at 1.25 on narrow phones (1.5 desktop).
- Moving player contact shadows share one instanced draw; the stadium shadow map
  renders once. No ongoing shadow pass for animated players.

Scene-graph budget measured during development: 255 mesh draws before frustum
culling, about 43k triangles including instanced seats, 24 static shadow casters,
and about 4 MiB of texture data including mipmaps. These are structural counts,
not an on-device GPU benchmark. The cloud browser has no WebGL context; bitmap
scoreboard appearance, scene interaction, camera framing and builds are checked
locally, with final visual/performance QA left to an actual phone.

## Camera controls

The scene is approximately 25% taller; scroll the page to reach the roster.
Hold **Tilt ↕** and drag down to look upward, or up to look downward.
Hold **Height ↕** and drag up to translate upward on world Y, or down to lower
the camera. Height preserves the viewing angle. Presets and Reset clear both
adjustments. Dragging either control temporarily disables page scrolling.
