# Risk log

What was assumed, what was measured, and what is still open. Dated entries so a later reading knows
which hardware and which OS produced a number.

## Resolved by measurement

### Port 554 binds on a handset — 2026-08-19, iPhone 13 Pro, iOS 26.6.1

iOS applies no privileged-port restriction. 554 binds, and a full RTSP exchange from a Mac on the
same subnet completed against it.

A first measurement reported `Address already in use`, caused by a leftover
`co.gamestation.cameramanprobe` build from the device-readiness work that auto-bound 554 on launch.
Nothing on a stock iOS install competes for the port, but another app that wants it will take it, so
a bind failure has to be a visible state rather than a server that appears to start and serves
nothing.

Since 2026-09-13 Cameraman serves on 8554 on both platforms and no longer asks for 554: Android cannot
bind it, and Director's sweep has to find every Cameraman on one port.

### Bonjour needs an `Info.plist` declaration — 2026-08-19

Advertising `_rtsp._tcp` without listing it under `NSBonjourServices` fails with `-65555`
(`kDNSServiceErr_NoAuth`) and takes the whole `NWListener` down with it. `NSLocalNetworkUsageDescription`
alone is not sufficient.

### No format on the triple camera gives up lens switching — 2026-08-19, iPhone 13 Pro

All 51 formats keep it. The plan had assumed 4K60 would force a single-lens fallback; the triple
camera does not offer 4K60 at all. 120 and 240 fps do cost lens switching, because they exist only on
the single-lens devices. See `docs/capabilities.md`.

### The zoom ceiling is not `maxAvailableVideoZoomFactor` — 2026-08-19, iPhone 13 Pro

That property reports **189** on every device on this handset, a displayed 94.5x of upscaled pixels.
`systemRecommendedVideoZoomRange` reports 1–18 for the triple camera's video formats, i.e. 0.5x–9x
displayed, and is what the app uses. The front camera reports no recommendation at all and falls back
to 5.

### Both codecs and the AAC path produce decodable streams — 2026-08-19, iPhone 13 Pro

`scripts/verifyEncode.sh` records the encoder's real output, pulls it off the device and makes ffmpeg
decode every frame. Measured over ~6 s at 1080p30, 6 Mbps requested:

| | H.264 | HEVC |
|-----------------|-----------------|-----------------|
| Profile / level | High, 4.0 | Main, 4.0 |
| Frames | 180 | 171 |
| Keyframes | 6 | 6 |
| Parameter sets | 96 B (SPS+PPS) | 408 B (+VPS) |
| Measured rate | 5.7 Mbps | 1.8 Mbps |

HEVC coming in far under the requested rate is the encoder being asked for an average, not a floor, on
a near-static scene. It is not a sign the bitrate setting was ignored — `Summary.measuredBitrate`
exists so that a genuinely ignored setting stays visible.

Audio: AAC-LC, 48 kHz mono, 283 access units over the same window. 283 × 1024 samples at 48 kHz is
6.04 s against the video's 5.97 s, so the two clocks agree and no access units were dropped or padded
at buffer boundaries.

### A client that joins mid-stream needs a keyframe forced for it — 2026-08-19, iPhone 13 Pro

Sending whatever frame the encoder produces next after `PLAY` hands the client inter-coded frames that
reference pictures it never received. ffmpeg reports `Could not find ref with POC` until the next
scheduled keyframe, up to a full keyframe interval of garbage. `PLAY` therefore asks the encoder for a
keyframe and the connection drops video until one arrives, so the first frame a client decodes is
always an IDR.

### The capture clock repeats a presentation time — 2026-08-19, iPhone 13 Pro

A receiver ends a picture when the RTP timestamp changes, so two frames sharing one timestamp are
reassembled into a single malformed access unit. `RTSPClientConnection` forces the sent timestamp to
advance rather than trusting the capture clock to be strictly increasing.

Measured over a 6 s ffmpeg pull afterwards: 180 frames, no duplicate and no backward timestamps, gaps
clustered on 3000 ticks with jitter between 2585 and 4919. ffmpeg's `-f null` pass still prints
`non monotonically increasing dts`; that is its rescale into the null muxer's coarser timebase, not
something present in the stream, and the RTSP pull itself is warning-free.

### Both codecs survive a real client over the wire — 2026-08-19, iPhone 13 Pro

`scripts/verifyStream.sh` builds, launches, discovers the phone over Bonjour, pulls with
`scripts/rtspClient.js` and hands the result to ffprobe and ffmpeg. Both codecs stream at ~30 fps with
no sequence-number gaps, the RTCP `CNAME` matches the `a=ssrc` line in the SDP, and ffmpeg decodes
every frame. ffmpeg pulling directly, with no involvement from our client, produces the same result.

### Maestro cannot see system permission alerts on device — 2026-08-19

They sit outside the app's accessibility hierarchy, so `tapOn: "Allow"` finds nothing while the dialog
is plainly on screen. They must be tapped by coordinate; the measured percentages are in
`maestro/flows/shared/allow-permissions.yaml`.

### maestro-runner terminates the app before every flow — 2026-08-19

Even a flow with no `launchApp`. A `devicectl ... --console` session started first is killed with
signal 9, so permission-granting has to happen **before** the console launch, not after. This is why
`scripts/capabilities.sh` runs the Maestro flow first.

### The simulator binds 554 and runs the whole path — 2026-08-19, iPhone 16 Pro simulator, iOS 18.3

This was open from Phase 1. It binds, VideoToolbox encodes, and the server serves: 30.1 fps over
RTSP with the synthetic source, 223 frames in 8 s, all decoded by ffmpeg.

### A per-pixel test pattern is slower than the encoder — 2026-08-19

`SyntheticCamera` first drew 1080p pixel by pixel and delivered about two frames a second in a debug
build, which reads as an encoder that has stopped rather than a slow source. Written with `memset`
per row it reaches 30 fps on the same machine. Worth remembering for any future test source: three
million bounds-checked writes a frame is not free in an unoptimised build.

### `devicectl` eats launch arguments containing its own short flags — 2026-08-19

`--terminate-existing <bundle> -uiTest true` fails with `The value 'true' is invalid for '-t'`:
`-uiTest` is parsed as bundled short flags. A `--` before the app's arguments fixes it. `-codec` and
`-recordSeconds` happen to contain no colliding letters, which is why this only surfaced in Phase 6.

## Open

### A different handset will read differently

Every capability number is from one iPhone 13 Pro. An iPhone 17 Pro has a different lens set and
format list. `scripts/common.sh` resolves whichever iPhone is connected, so a reading can silently
come from the wrong phone; the model identifier is recorded in `docs/capabilities.json` for that
reason.

### Thermals under sustained encode are unmeasured

No sustained-stream run has been done yet, so nothing is known about how long the phone holds 1080p30
before throttling, or what 4K30 costs. One data point from the 2026-09-09 link bring-up: a handset
capturing 1080p60 for HDMI with **no** client playing — so no compression at all — still sat at
`system.thermal: serious` on a warm bench, charging through the adapter. Capture and the display
path alone are not free. Unlike the iPad in `../tsDirector/docs/risks.md`, this handset
is not sitting on a Peltier cooler.

### Mirroring when clean HDMI is off — verified on a cable, 2026-09-09

Settled, so the fallback (rendering the phone's own root view into the external window) is not
needed. iPhone 15 Pro → USB-C → Hollyland Cosmo C2 → NDI → GS Director, toggled both ways over
`videoOutput.hdmi.clean`:

| `cleanHDMIEnabled` | What the capture device received | `externalDisplay.framesEnqueued` |
| --- | --- | --- |
| true | the encoder's picture, no chrome | tracks `capturedFrames` exactly |
| false | the phone's screen, chrome and all | frozen while `capturedFrames` climbs |

Off really does hand the display back: the window is removed, nothing is drawn, and iOS mirrors.
On again resumes, `framesEnqueued` behind `capturedFrames` by exactly what was missed. The
external-display scene stays connected throughout at `1920x1080`, so neither switch waits for a
replug.

### The external scene goes away when the app is backgrounded

An external-display scene is torn down when the app leaves the foreground, and the RTSP listener
already dies then (see the backgrounded-Cameraman note in the operating memory). Nothing new,
but a phone whose only output is HDMI now shows the display going dark as well as the stream
stopping. When the listener-lifecycle work lands, `handleForeground()` should also flush the
display layer so the first frame back is not a stale one.

### HDMI adds heat

DisplayPort alt mode on top of capture, and encode when a client is playing, on a phone that may be
in the sun. The idle encoder removes the encode share when nothing is playing, which is the linked
Cosmo C2 case, but the A3 soak (20 min at 1080p30 with HDMI and RTSP together, `system.thermal`
recorded over time) is what says whether the phone holds it. The thermal badge and Director's
thermal pill surface it either way.

### The simulator has no camera

Anything touching `AVCaptureSession` is verifiable only on the handset. The synthetic camera source
in `CameramanTestHarness` exists so the encode and wire layers can still be exercised without one.
