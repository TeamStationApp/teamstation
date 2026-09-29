# Testing

Four layers, each answering something the others cannot.

## Unit tests — no device, no network, no emulator

```bash
npm run test:unit
```

231 tests on the JVM, in about three seconds. They run there rather than on a device because `core`
and `rtsp` have no Android dependencies, which is a deliberate property of the layout and not a
coincidence.

| Suite | What it settles |
|---|---|
| `ZoomMappingTest` | device/displayed conversion at each switchover, on both an iPhone's fixtures and a Pixel's |
| `StreamSendQueueTest` | backpressure drops to the next keyframe rather than growing |
| `H264PacketizerTest` / `HEVCPacketizerTest` | FU fragments reassemble into the original NAL, bit for bit |
| `AACPacketizerTest` | the AU-headers-length is in **bits**, which is the field every hand-rolled RFC 3640 sender writes in bytes |
| `InterleavedFramerTest` | a batch of frames parses back into the original payloads |
| `RTCPWriterTest` | the length field is words-minus-one, and the SDES chunk is padded and parseable |
| `SDPBuilderTest` | `profile-level-id` agrees with the SPS, HEVC sprop order, unwrapped base64 |
| `RTSPResponderTest` | the method state machine, including everything it refuses |
| `RTSPServerMessageTest` | pipelining, folded headers, bare LF, partial requests |
| `DeviceIdentityTest` | renaming does not move the identity; a malformed UUID is replaced |
| `CaptureRotationTest` | the measured rotation rule, so a regression fails here rather than on a field |
| `NALUnitConversionTest` | Annex-B **and** AVCC, because Producer's decoder consumes the latter |
| `RTPTimestampSequencerTest` | the 32-bit rollover is a forward step, not a repeat — a bug that only appears 13.3 hours in |
| `LensSelectionTest` | a disabled lens clamps the zoom range, and the last one cannot be turned off |
| `StreamSettingsPersistenceTest` | a stored set missing a field keeps defaults instead of resetting everything |
| `BatteryStatusTest` / `ThermalBadgeLevelTest` | the overlay pills, ported from the iOS suites so both platforms turn colour at the same threshold |
| `PreferredAddressTest` | the address Director is handed is one it can actually reach |
| `CameraParametersTest` | the `GET_PARAMETER` / `SET_PARAMETER` vocabulary: encode, decode, clamping, kbps↔bps, all-or-nothing — the iOS suite's fixture and expected values |
| `RTSPResponderParameterTest` | a body is answered, a missing handler is `451` / `501`, errors keep their status, a write creates no session |
| `RTSPParameterInteropTest` | a request shaped exactly as **Director's** `RTSPRequestBuilder` writes it, parsed here, answered, and read back |
| `RTSPServerLoopbackTest` | over a real socket: a control-only connection is not a viewer; PLAY and TEARDOWN move the count |

Two things these deliberately do *not* mock: there is no fake camera and no fake socket. Anything
that would need one is covered by the layers below, on real hardware, because a test against a mock
of MediaCodec would only prove we agree with our own idea of MediaCodec.

## Stream verification — device and network

```bash
npm run verify:stream          # h264
npm run verify:stream -- hevc
```

Builds, installs, launches, reads the bound port out of the app, pulls with the **iOS build's**
`scripts/rtspClient.js`, and hands the result to `ffprobe` and `ffmpeg`. Reports frame rate, sequence
gaps and whether the RTCP `CNAME` matches the SDP.

That client is the judge because it shares no code with either app: it fails on anything that is not
correct on the wire, whichever platform produced it. ffmpeg is then a third opinion on the bytes it
collected.

For a check with nothing of ours in the path at all:

```bash
ffmpeg -rtsp_transport tcp -i rtsp://<phone>:8554/live/mainstream -t 6 -c copy out.mp4
```

## Background verification — the thing iOS cannot do

```bash
npm run verify:background
```

Pulls the same stream three times — foregrounded, backgrounded with `KEYCODE_HOME`, and with the
screen off — and fails if the frame rate collapses, a sequence gap appears, or the frames stop
decoding in any phase. This is its own script rather than a note in the stream check because it is
the one behaviour that distinguishes this build, and a regression in it is silent: the app keeps
running, the socket keeps accepting, and the frames simply stop.

**A held frame rate is not sufficient evidence.** A frozen stream holds its rate too. The stopwatch on
the bench is what settles it: the reading in the decoded frames has to have advanced by the elapsed
wall time. `docs/capabilities.md` records the pair that did.

## The parameter channel

The RTSP port itself. The iOS build's `scripts/rtspParams.js` is the Mac-side reader and writer,
with nothing of Director in the path, the way `rtspClient.js` is for media; `npm run params` points
it at this build's port:

```bash
npm run params -- --host 10.10.7.130                       # GET_PARAMETER *
npm run params -- --host 10.10.7.130 ptz.zoom system.thermal
npm run params -- --host 10.10.7.130 'ptz.zoom: 3'         # the rail moves to 3x
```

Unlike the control channel below it needs no launch argument: it is the production interface
GS Director and GS Preview drive. The table of names is in `docs/rtsp-interop.md`.

## The control channel

Port 8766, only when launched with `uiTest true`. Producer uses 8765, so both can be driven from one
script during an end-to-end run.

```bash
bash scripts/control.sh dump-state
bash scripts/control.sh "set-zoom?displayed=4"
bash scripts/control.sh "set-codec?codec=hevc"
```

Forwarded over `adb` rather than Wi-Fi, so it works on a bench with no route to the handset — which
is a real difference from the iOS build, where the same channel needs an IP address.

`dump-state`, `clients`, `flip-camera`, `force-keyframe`, `reset`, `set-zoom`, `set-format`,
`set-bitrate`, `set-adaptive-bitrate`, `set-codec`, `set-name`, `set-audio`, `set-video`, `set-lenses`, `set-rotation`,
`set-send-delay`, `radar-show`, `radar-feed`, `radar-unpair`.

`set-send-delay` holds outgoing frames back to imitate a congested link, in three shapes because they
fail differently: a constant `ms` is the weak case that any correct receiver absorbs, `jitter` spreads
arrivals either side of it, and `burst` clumps them the way Wi-Fi does under contention. The capture
times the frames carry are untouched, so a receiver sees late delivery with an honest timestamp —
which only works because the RTCP sender report is stamped from capture time too. A report stamped at
send would slide with the delay and hide the very fault being injected.

It exists so a state assertion does not depend on gesture precision: a flow that pinches and then
asserts a zoom conflates "the app got the zoom wrong" with "the tap landed eight points off". A
mistyped command is refused rather than defaulted, so it fails where it was typed.

`set-rotation` is a measurement tool rather than an operator control — it is how the rotation rule in
`docs/capabilities.md` was established, and it stays so the next handset that disagrees can be
measured instead of argued about.

The same commands also arrive as intents, which needs no port forwarding at all:

```bash
adb shell am start -a android.intent.action.VIEW -d "gscameraman://test/flip-camera"
```

## Maestro flows

```bash
maestro test maestro/flows/smoke.yaml
```

| Flow | Covers |
|---|---|
| `smoke` | app opens, camera runs, server listening on the port it says |
| `camera-zoom` | preset pills switch lenses, flip changes the preset row |
| `settings-codec-bitrate` | codec and bitrate survive leaving the settings screen |
| `rename-camera` | rename takes effect, identity does not move, empty falls back |
| `background-stream` | the app backgrounds and comes back |
| `settings-lenses` | a lens toggled off loses its pill on the zoom rail |
| `thermal-visuals` | the thermal pill shows each level on demand |
| `settings-persist` | a codec chosen before a relaunch is still chosen after it |

### Two things that will waste an afternoon

**System permission dialogs are invisible to Maestro.** They belong to the system UI, not the app, so
`tapOn: "Allow"` finds nothing while the dialog is plainly on screen. `scripts/install.sh` grants the
permissions with `pm grant` instead, which is both faster and deterministic.

**`assertNotVisible` with an id still matches text anywhere on screen.** Assert the identifier holds
the value you expect instead.

## The synthetic camera

`SyntheticCamera` generates a moving pattern behind the same interface, for a handset where the
camera permission was refused or a bring-up where the question is whether the encoder and the RTSP
server work at all before the camera is brought into it.

It earns less of its keep here than on iOS, where the simulator has no capture device and this is the
only way to test anything past `AVCaptureSession`. An Android emulator ships a fake camera.

It is drawn with filled rectangles rather than per-pixel: a loop over 1080p is two million
bounds-checked writes a frame, which delivers about two frames a second and looks exactly like the
encoder failing.
