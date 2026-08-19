# Testing

Four layers, each answering something the others cannot.

## Unit tests — no device, no network

```bash
socket npm run test:unit
```

188 tests on the simulator. The interesting ones are not the ones that check our own code against
itself:

| Suite | What it settles |
|---|---|
| `PacketizerRoundTripTests` | our RTP output fed through **Producer's** depacketizers and back to the original access unit |
| `SDPBuilderTests` | our SDP parsed by **Producer's** `SDPDescription` |
| `InterleavedFramerTests` | our framing parsed by **Producer's** `RTSPStreamParser` |
| `RTCPInteropTests` | our RTCP read by **Producer's** `RTCPReport` |
| `CameraIdentityAdoptionTests` | **Producer's** naming and binding rules, compiled here |
| `RTSPResponderTests` | the method state machine, including what it refuses |
| `StreamSendQueueTests` | backpressure drops to the next keyframe rather than growing |
| `ZoomMappingTests` | device/displayed conversion at each switchover, from real fixtures |

Producer's packages are path dependencies of the test target only. Nothing here builds or launches
the Producer app.

## Encode verification — device, no network

```bash
socket npm run verify:encode -- hevc
```

Records the encoder's real output to a file, pulls it off the device and makes ffmpeg decode every
frame. A `VTCompressionSession` will accept every property you set and then emit an undecodable
stream without reporting anything, so the only way to know is to decode the bytes.

## Stream verification — device and network

```bash
socket npm run verify:stream          # h264
socket npm run verify:stream -- hevc
```

Builds, launches, finds the phone over Bonjour, pulls with `scripts/rtspClient.js`, and hands the
result to `ffprobe` and `ffmpeg`. Reports frame rate, sequence gaps and whether the RTCP `CNAME`
matches the SDP.

For a third-party check with nothing of ours in the path:

```bash
ffmpeg -rtsp_transport tcp -i rtsp://<phone>:554/live/mainstream -t 6 -c copy out.mp4
```

## Maestro flows

```bash
node scripts/run-maestro.js              # every flow, on the iPhone
node scripts/run-maestro.js --sim smoke  # on the simulator, synthetic source
node scripts/run-maestro.js --list
```

| Flow | Covers | Device only |
|---|---|---|
| `smoke` | app opens, camera runs, server listening on the port it says | |
| `camera-zoom` | preset pills switch lenses, flip changes the preset row | yes |
| `settings-codec-bitrate` | codec and bitrate survive leaving the sheet | |
| `rename-camera` | rename takes effect, identity does not move, empty falls back | |
| `client-connect` | the on-screen client count rises and falls with a real client | yes |

`client-connect` is run through a script, not on its own — Maestro's `runScript` has no process
access and cannot start the client:

```bash
bash scripts/verifyClientCount.sh
```

### Two things that will waste an afternoon

**System permission alerts are invisible to Maestro on a device.** They sit outside the app's
accessibility hierarchy, so `tapOn: "Allow"` finds nothing while the dialog is plainly on screen.
Tap them by coordinate; the measured percentages are in `maestro/flows/shared/allow-permissions.yaml`.

**`assertNotVisible` with an `id` still matches text anywhere on screen.** Assert the identifier
holds the value you expect instead. Asserting the absence of a string also fires on a sheet that has
not finished animating away, which is a timing race and never the thing under test.

## The control channel

Port 8766, only when launched with `-uiTest true`. Producer uses 8765, so both can be driven from
one script during an end-to-end run.

```bash
node scripts/control.js --host 192.168.7.118 dump-state
node scripts/control.js --host 192.168.7.118 set-zoom displayed=3.0
node scripts/control.js --host 192.168.7.118 set-codec codec=hevc
```

`dump-state`, `clients`, `flip-camera`, `force-keyframe`, `reset`, `set-zoom`, `set-format`,
`set-bitrate`, `set-codec`, `set-name`, `set-audio`.

It exists so a state assertion does not depend on gesture precision: a flow that pinches and then
asserts a zoom conflates "the app got the zoom wrong" with "the tap landed eight points off". A
mistyped command is refused rather than defaulted, so it fails where it was typed.

Note `--`: `xcrun devicectl` parses `-uiTest` as its own bundled short flags without it.

```bash
xcrun devicectl device process launch --device "$UDID" --console \
  --terminate-existing co.gamestation.cameraman -- -uiTest true
```

## The synthetic camera

A simulator has no capture device, so anything past `AVCaptureSession` would otherwise be testable
only on the handset. `SyntheticCamera` generates a moving pattern behind the same interface, and the
app falls back to it automatically on a simulator — decided by the build target, not by finding no
devices, because on a handset an empty device list means something is wrong and serving a test
pattern instead of saying so would be the worst possible answer.

It is drawn with `memset` per row. A per-pixel loop over 1080p is three million bounds-checked
writes a frame, which in an unoptimised build delivers about two frames a second — slow enough to
look exactly like the encoder failing.

Measured on an iPhone 16 Pro simulator, 2026-08-19: 30.1 fps over RTSP, 223 frames in 8 s, ffmpeg
decodes all of them. There is no synthetic microphone; audio has nothing device-specific in its path
that the AAC unit tests do not already cover.
