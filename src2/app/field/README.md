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
