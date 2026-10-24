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
with an SPA fallback to `index.html`. The compile-time `TS_FIELD_PREVIEW=1` flag
starts the root URL on `/field` and prevents API/session requests across preview
navigation, including deep links. Omit the flag (`npm run build.web`) for the
normal app. No server or database configuration changes are needed.

Drag any player body or name with a mouse or touch to preview a yellow route.
Players remain still until release, then run to the committed destination. Alternatively choose a roster
button and tap the turf. Nine blue fielders and three orange runners move
independently. Camera presets, zoom, next-base/run-a-play and reset are local.

## Integration boundaries

- `BaseballScreen.tsx`: shared React Native controls and screen state. Mount it
  from another navigator without API, account or theme-specific dependencies
  beyond the existing TeamStation providers.
- `FieldScene.tsx`, `Ballpark.tsx`, `Player.tsx`: React Three Fiber geometry,
  lighting, pointer controls and articulated procedural animation. No fetched
  models, textures, stadium assets, database IDs or external services.
- `fieldModel.ts`: world coordinates, bounds and frame-independent movement.
  Units are metres, home is `(0, 0)`, center field is negative z. Basepaths are
  27.432m. Player scale is deliberately exaggerated for interaction.
- `FieldCanvas.tsx`: browser renderer, WebGL2 capability check and recovery.
- `FieldCanvas.native.tsx`: the phone renderer — Fiber's native `Canvas`
  (expo-gl) around the same `FieldScene`, with touches from
  `fieldTouches.ts`. No WebView. `src/MOBILE.md` covers the Expo setup and
  what the phone does differently (no shadow maps, no logos; nameplates are
  views over the canvas, `NativeNameplates.tsx`).

React and React DOM are pinned to 19.2.4 because Fiber 9.7.0 declares React
`>=19 <19.3`; React Native 0.87.1 accepts 19.2.4. Keep renderer versions aligned
when updating. Native GPU/device testing is a separate integration gate.

## Verification

```sh
npx tsc -p tsconfig.app.json
npm run typecheck.native
npx mocha -r sucrase/register 'src/app/field/*.test.ts' src/app/navigation/routes.test.ts src/app/navigation/tabPress.test.ts
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

Previous detail-pass scene-graph budget: 255 mesh draws before frustum
culling, about 43k triangles including instanced seats, 24 static shadow casters,
and about 4 MiB of texture data including mipmaps. These are structural counts,
not an on-device GPU benchmark. The cloud browser has no WebGL context; bitmap
scoreboard appearance, scene interaction, camera framing and builds are checked
locally, with final visual/performance QA left to an actual phone.

## Camera controls

The scene uses a 4:5 width-to-height ratio capped at 682 CSS pixels; scroll to reach the roster.
Hold **Tilt ↕** and drag down to look upward, or up to look downward.
Hold **Height ↕** and drag up to translate upward on world Y, or down to lower
the camera. Height preserves the viewing angle. Presets and Reset clear both
adjustments. Dragging either control temporarily disables page scrolling.


## Geometry, players and hit drawing

Terrain layers now have 8cm vertical steps and ordered polygon offsets. The camera
near plane is 2m rather than 0.1m, improving far-field depth precision by 20x;
height controls stop above the ground. Geometry regression tests raycast the actual
field across 81 orientation/tilt/height/zoom combinations and check at least four
24-bit depth steps between covered surfaces before polygon offset. These checks
cannot replace a visual GPU sweep on Safari/Chrome.

Light banks are halfway toward the scoreboard's nearest outer edge from their
original position. Housings and lamp faces share one local rotation, with a gap
between faces and housing. Lamp faces use unlit cream materials, without bloom.

Player body scale is doubled (1.6 to 3.2), with larger rings and contact shadows.
Fictional `displayName` and `number` fields are separate from position/role names.
Front/back jersey numbers and rounded, camera-facing nameplates use portable
DataTextures; nameplate size stays approximately constant on screen.

Press **Ball arc** below the viewport. Tap to place a 30-degree yellow flight path,
or hold and drag its landing point; release enters angle adjustment. Drag within
48px horizontally / 58px vertically of the yellow apex arrows. Up raises the
launch angle; below 5 degrees the trajectory becomes a chopper. Lowering further
moves the first ground contact toward home, with two diminishing bounces.
**Move landing**, **Done**, **Adjust arc**, and **Clear arc** support subsequent edits.
Player movement is disabled while drawing; Done restores it and keeps the arc.
The path is a coaching diagram, not a physics prediction. No data is persisted.


## Readability pass

Scene fog is removed. Fitting the same board into a narrow but tall desktop
viewport pulls the camera far back; the old fixed 260–650m fog range hid the
stadium. The far clipping plane now follows that distance as well.

Players are another 15% larger (body scale 3.68). Nameplates are 56×14 CSS pixels,
half their previous dimensions, calculated from camera-space depth and FOV.
They omit jersey numbers. Pitcher and runner nameplates are hidden by default.
The catcher label sits below his feet; 3B is screen-left, 1B screen-right; SS, 2B
and outfield labels sit above the enlarged head with a one-foot game-space gap.
Sprite anchors keep the boxes away from heads even when the viewport resizes.

Scoreboard text bulbs receive a 1.25 brightness multiplier, with color channels
clamped to preserve the warm glow. BATTER/PITCHER headings are removed. Both
scoreboard names default to hidden (`showPlayerNames: false`); an integrator can
opt them in, with the hits–at-bats line beneath the batter. The default board shows
`1-3` and `PITCHES 64`. `batterHits` and `batterAtBats` default to a `0-0` line when
not provided. B/S/O lamp colors and jersey numbers are unchanged.


## Compact scoreboard and release-to-run controls

The scoreboard uses a 1024×256 bulb texture and an 18-unit-high housing (previously
34), with no title. After the team scores, a single line shows the batter name,
hits–at-bats, pitcher name and `P:64`. When `ScoreboardState.batterJersey` or `pitcherJersey`
is set, that line starts with the number, as `#12 ALEX R.`; the bulb font has a `#`
glyph for it, and a line too long for the board loses the name's tail while the
number stays. Balls/strikes/outs labels and lamps share the
last row. Names are always present again. Its center is `(0, 28.2, -135)`; the bottom
trim is about 0.5m above the rear railing, with the face overhanging the central back
row slightly. The light banks sit at radius 136m, x ±68m, tangent to the stands.

Home/Above/Infield presets are on the left. Zoom/Tilt/Height drag controls are
on the right; up zooms in and down zooms out. Zoom plus/minus buttons are removed.
Viewport height depends only on width (1.25×), capped at 682 CSS pixels. The cap
uses a design reference of 80% of an 852-point phone height (iPhone 15-class,
2556 physical pixels at 3×; [Apple display specifications](https://support.apple.com/en-us/111831)).

Player selection raycasts the actual bodies and nameplates. Selected rings are
shoulder-width. During a drag, a separate yellow route previews the destination,
and the player is paused; release commits it, while cancel/lost capture discards
the draft. Runners can only advance from their recorded base to the next base.
Their preview is constrained to that basepath and snaps beyond 50%; releasing
before that threshold leaves them in place. Base ownership updates on arrival.

Arc targets may extend to 160m and raycast the actual spectator tiers for landing
height. Launch adjustment reaches 85 degrees at every landing distance. Negative
angles now switch to a straight descending segment from bat contact to the ground
handle, followed by one separate chopping arc toward the destination. Further
downward adjustment brings that ground handle closer to home. The renderer uses
two curve segments so the first ground impact is a sharp join, not a smoothed bend.


## Touch placement and arc arrows

Arc editing displays three fixed chevrons in each direction. A solid yellow
crest travels outward every 1.8 seconds over progressively darker trailing
chevrons. These render after transparent nameplates with depth testing disabled.
Only the editing handle keeps the demand renderer animating; Done stops it.
The handle accepts a grab within 96 CSS pixels left/right and 80 pixels up/down.

Touch placement lifts player destinations and arc landing points 32 screen pixels
above the finger before intersecting the ground or stands. Player selection still
uses the actual finger position, and runner basepath constraints still apply.
Mouse and pen placement remain exact. Native hosts pass `touchPlacement`; web
also recognizes touch pointer events and coarse-pointer touch devices. The native
3D adapter remains a separate integration step described above.

## Destination visibility and scoreboard columns

Both player and ball landing markers now have five concentric rings, with outer
radii five times their previous size (4.75m and 11m). The outer rim is bright
yellow; successive inner rings fade toward the center. They render above scene
geometry and nameplates, below the angle arrows. Arrow brightness follows distance
from the traveling crest, so the oldest inner trail becomes darkest.

Team names are flush left without HOME/AWAY prefixes, scores occupy the middle,
and smaller BALLS/STRIKES/OUTS labels and lamps stack vertically on the right.
The batter, hits–at-bats, pitcher and pitch count remain on one bottom line.


## Immersive field controls

The field route fills the available viewport without scrolling, with no app header
or navigation. Its hamburger menu offers Resume and Exit; camera drag controls are
centered in the header. The web route temporarily opts into viewport-fit=cover and
100dvh, restores the previous viewport/scroll policy on exit, and places all controls
inside CSS safe-area insets. Native uses the existing safe-area provider and its
edge-to-edge host. Browser chrome remains controlled by the browser. Web hamburger
uses backdrop blur; native has a translucent fallback until a native blur host is
chosen alongside the native 3D integration.

The bottom row records Ball, Called Strike, Swing and Miss, Foul Ball, and Ball in
Play. More is above Ball; Undo is above Ball in Play. Ball in Play starts arc aiming.
Counts and pitch totals update locally, with foul balls capped at two strikes.
Walks/strikeouts reset the count; this is not a full scoring engine and does not
automatically move runners or infer hits from a drawn trajectory. Undo restores the
previous pitch/arc snapshot. More offers arc adjustment, clearing, and camera/player
resets. The old fixed-ratio viewport, roster, presets and instructional panels are
superseded by this full-screen layout.


The initial and Reset camera pose is zoom 1.25×, tilt −11°, height offset 33m.
Undo fills the utility row beside More and describes the newest history event
(e.g. Called Strike, Ball in Play, Adjust ball arc, Clear ball arc).

## Batter opening state and jersey clearance

The screen now starts with nine defenders, empty bases, and Alex R. (#14) in the
right-handed batter's box. A widened stance, bent arms, two-handed grip, head turn,
and wooden bat form the batting pose. Ball in Play releases the bat through a
0.65-second drop and sends the batter to first using the existing run cycle.
Undo/Cancel restores the independent player snapshot, including pose and bat.
Reset players restores this opening arrangement; the older three-runner fixture
remains available to exercise basepath logic in tests.

Scoreboard text brightness is multiplied by another 1.5 (1.875 total), with
stronger text halos so already-saturated bulbs remain visibly brighter; count
lamps keep their existing colors. Jersey number planes sit outside the torso's
maximum depth, with negative polygon offset and normal depth testing retained.
Renderer tests cover bat release, arrival at first, undo restoration and number
clearance. Physical-device rendering still requires visual verification.
