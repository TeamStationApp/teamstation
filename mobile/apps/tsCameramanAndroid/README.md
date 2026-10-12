# TS Cameraman for Android

Turns an Android handset into an RTSP camera source that TS Director can ingest like any other camera
on the field, **and keeps streaming while it is backgrounded or the screen is off**. Launch it and it
serves `rtsp://<phone-ip>:8554/live/mainstream` — unauthenticated, HEVC 1080p30 at 4 Mbps by default,
with AAC audio from the device microphone.

Landscape only, like the iOS build.

## Quick start

```bash
npm run device:install       # build, install, grant the runtime permissions
npm run device:launch        # launch it
npm run test:unit            # 231 JVM tests, no device needed
npm run verify:stream        # build, launch, pull with an independent client, decode every frame
npm run verify:background    # the same pull foregrounded, backgrounded, and with the screen off
```

## What is different from the iOS build, and why

This is a port of `mobile/apps/tsCameraman`, deliberately close enough that the two can be read side
by side. Everything below is a place where being identical was not possible or not correct. Nothing
else was changed.

### It keeps running in the background

The reason this build exists. On iOS the pipeline lives in the app process and iOS suspends it the
moment the app is backgrounded — the listener stops accepting, and from a client that is
indistinguishable from a server that never bound.

Here the camera, the encoders and the listener live in `CameramanService`, a foreground service, and
the activity is only a window onto it. That needs four things to line up, and all four are load-bearing:

- `foregroundServiceType="camera|microphone"` in the manifest **and** the matching types passed to
  `startForeground`. The manifest says what the service may hold, the call says what it is holding,
  and a mismatch throws rather than degrading.
- `FOREGROUND_SERVICE_CAMERA` and `FOREGROUND_SERVICE_MICROPHONE`. Install-time permissions, but
  enforced at the `startForeground` call — without them it throws `SecurityException` on first start.
- Started from a **resumed activity**. A service started from the background gets
  `ForegroundServiceStartNotAllowedException`, and one that starts anyway without the camera type has
  its `CameraDevice` closed by the system the moment the activity stops.
- A `PARTIAL_WAKE_LOCK`. iOS only has to stop the screen locking; Android will suspend the CPU
  outright, and an encoder that is not scheduled is a stream that stops with nothing reporting an
  error.

Measured on a Pixel 10, 2026-09-05: 30.16 fps with zero sequence gaps foregrounded, backgrounded, and
with the screen off and the device in `Dozing`. `npm run verify:background` re-runs exactly that.

### One port, 8554, on both builds

Android is Linux: an unprivileged process cannot bind below 1024, and 554 fails with `EACCES` on every
handset, every time. So both builds serve on 8554, and TS Director's sweep finds an iPhone and an
Android phone on the same port. A phone updated from a build that saved 554 loads 8554.

### The identity does not survive an uninstall

Both builds keep the camera's UUID in the app's own storage — iOS in a small file, Android in
`PreferencesIdentityStore` — and uninstalling clears it on both. A reinstalled Cameraman is a new
camera to TS Director and has to be re-bound to its tile. Updates and reboots are fine; only uninstall is not. See `PreferencesIdentityStore`.

Within one install the UUID cannot drift, even if saving it fails. The first one is derived from the
install — the app-scoped `ANDROID_ID` and the first-install time — so a launch whose save never
reached disk is followed by one that mints the same UUID and saves it then.

### Rotation is done on the GPU, and it had to be measured

iOS sets `videoRotationAngle` on the capture connection and AVFoundation does the work. Camera2 has
no such control, so frames go camera → `SurfaceTexture` → GL → encoder surface, and the rotation is a
matrix in that shader. The same GL pass also draws the preview, letterboxed so the whole encoded
frame is on screen, which is what keeps the promise the iOS build makes: *the operator frames what
the client receives*, including after a flip.

The angle is not the textbook one. On this handset the `SurfaceTexture` transform matrix is
`[0,-1,0,0, -1,0,0,0, ...]` — a reflection about the anti-diagonal, not the plain vertical flip the
documentation leads you to expect — so the camera had already applied a quarter turn that
`(sensor - displayRotation)` assumes it has not. See `docs/capabilities.md` for the measurement and
`CameraSession.captureRotation` for the rule.

### Zoom switchovers are derived rather than published

`AVCaptureDevice.virtualDeviceSwitchOverVideoZoomFactors` has no Camera2 equivalent — there is no API
that says at which zoom a logical camera hands over to the next lens. `CameraSession.mapping`
computes it from the constituent physical cameras' focal lengths and sensor sizes. On a Pixel 10 that
produces 0.6x / 1x / 4.1x / 16.5x. `docs/capabilities.md` records what that is derived from and where
it disagrees with the handset's own camera app.

### The look is Material 3, not a translation of SwiftUI

The behaviour is the iOS build's; the chrome is Android's. `ui/theme/Theme.kt` defines the colour
scheme, the type scale and the tokens, and every screen reads roles from it rather than naming
colours — so the settings screen is a `Scaffold` with a top app bar, cards, a segmented button for
the codec, an exposed dropdown for the resolution and real list rows, instead of a SwiftUI `Form`
transliterated into `Box`es.

Two decisions worth knowing:

- **No dynamic colour.** It is Material 3's default advice and the wrong call for this app: a rack of
  phones on a field would each take their owner's wallpaper and no two cameras would look alike. The
  palette is seeded from the cream in the shared app mark instead, so Cameraman, Director and Watcher
  read as one family.
- **A compact type scale.** The stock scale is drawn for a phone in portrait. This app is
  landscape-only, so its window is 411dp *tall*, and the defaults overflowed the settings screen
  badly enough that the microphone toggle and the camera's identifier were off the bottom.
- **One margin for all the chrome.** `CameramanTokens.chromeMargin` is the gap at every edge of the
  overlay and between the badges and the zoom rail, and every chrome pill shares one height so the
  camera name on the left and the badges on the right sit on the same line. The chrome is four
  islands floating on live video with nothing to align to but the screen, and an operator reads
  inconsistent gaps as a layout that is broken rather than as one that is deliberate.

### Lens selection is a zoom clamp, not a different device

The settings screen lists one toggle per physical lens, with millimetre labels derived from each
lens's own focal length and sensor size. Turning one off has to be honoured differently here.

On iOS a selection picks a different `AVCaptureDevice` — drop the ultra-wide and the app opens Dual
Wide instead of Triple. Android has no such family of virtual devices, and on a Pixel the physical
cameras are not in `cameraIdList` at all, so they cannot be opened on their own. What *is* available
is the logical camera's zoom range, and which lens it uses is a function of exactly that. So a
disabled lens becomes a clamp: turn off the ultra-wide and the range starts at 1x, turn off the
telephoto and it stops just below its switchover. The operator gets what they asked for — that lens
is never selected — by the only mechanism the platform offers.

### Kotlin, Compose and Camera2 — not React Native

Nothing in this app is shared with JavaScript, and a JS bridge between a camera and a socket would be
a frame-rate problem with no upside.

## Layout

```
app/src/main/kotlin/app/teamstation/cameraman/
  core/       identity, camera parameters, broadcast policy, frame delivery, port probe
  rtsp/       RTSP server, packetizers, SDP, RTCP, interleaved framing, NSD advertising
  radar/      scoreboard target, foreground service types
  ui/         Compose screens
  harness/    launch arguments, control channel, synthetic camera, recorders
  service/    the foreground service that owns all of it
  engine/     AppEnvironment — the wiring
app/src/test/kotlin/   JVM tests of the above
docs/                  measured capability set, testing, interop
scripts/               build, install, launch, verify
maestro/flows/         on-device UI flows

../common/android/streamcore/   the `:streamcore` library, shared with the TeamStation app
  src/main/kotlin/app/teamstation/streamcore/
    core/       stream settings, zoom mapping, lenses, capture formats, frame types, process load
    capture/    Camera2 session, lens discovery, format catalogue, microphone
    gl/         EGL context, texture program, the camera-to-encoders renderer
    encode/     MediaCodec H.264/HEVC and AAC, NAL and parameter-set handling
    bitrate/    adaptive bitrate controller and loop, congestion samples
    radar/      radar link, protocol, handshake, GATT radio, pairing store
  src/test/kotlin/      JVM tests of the above
```

`scripts/test-unit.sh` runs both modules' suites.

## Why the packages split this way

Exactly as on iOS: `core` and `rtsp` hold no Android dependencies beyond the standard library, so the
zoom arithmetic, the identity rules and every packetizer are testable on the JVM with no device. That
is what lets 201 tests run in three seconds with no emulator.

`encode` and `rtsp` are siblings rather than a chain. The encoder emits plain elementary NAL units
rather than codec buffers, which is what lets every packetizer be tested on bytes with no MediaCodec
involved.

## What the operator can change, and what sticks

Settings are written on every change and read back at launch, because a camera on a tripod is aimed
once: coming back on the wrong lens or the wrong zoom after a restart silently changes the shot and
nobody is standing there to notice. That covers the codec, the format, the bitrate, the microphone,
the lens selection, and which camera was framed with at what zoom.

Two things deliberately do not stick:

- **A launch argument always wins.** A flow that pins `codec h264` gets H.264 whatever the operator
  last chose, or a UI test would depend on the state of the handset.
- **Blanking never survives a launch.** It is a fault-injection control, not a preference, and a
  camera left blank must come back showing a picture.

`persistSettings` is off under `uiTest` so a flow neither inherits nor leaves behind a preference —
but it is settable, because an operator runs with `uiTest` on to get the control channel and still
expects the camera to come back the way they left it.

## Off air without going away

Two controls exist so a camera can be taken off air without Director reading it as a camera that
died:

- **Blanking** (`set-video?on=false`) keeps the encoder running at the same rate and sends black.
  Measured: 30 fps held, bitrate falls from 4 Mbps to 21 kbps, audio keeps flowing. The preview stays
  live, so the operator can still see the shot is framed. The transition forces a keyframe, because
  black P-frames still reference the last live picture and a decoder would otherwise go on showing
  it.
- **Muting** removes the audio section from the SDP entirely rather than announcing a track and
  sending nothing, which is what leaves a client waiting for packets that never come.

## Measured, not assumed

`docs/capabilities.md` records this handset's real lens set, the transform matrix its camera hands
back, and the rotation that follows from it — with the frames that settled each one. Two of its
findings are load-bearing and neither could be read off an API:

- The `SurfaceTexture` transform contains a quarter turn, so the textbook rotation is 90 degrees short.
- The lens switchover zooms have to be derived from focal lengths, because nothing publishes them.
