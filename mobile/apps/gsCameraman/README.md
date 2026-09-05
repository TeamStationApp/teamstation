# GS Cameraman

Turns an iPhone into an RTSP camera source that GS Producer can ingest like any other camera on the
field. Launch it and it serves `rtsp://<phone-ip>:554/live/mainstream` — unauthenticated, H.264 1080p30
at 6 Mbps by default, with AAC audio from the device microphone.

iPhone only, landscape only. It runs on an iPad, scaled.

## Quick start

```bash
socket npm run bootstrap        # generate Cameraman.xcodeproj from project.yml
socket npm run test:unit        # pure-logic suites on an iPhone simulator
socket npm run build:device     # build, install and launch on the connected iPhone
socket npm run capabilities     # measure this handset's cameras into docs/capabilities.json
```

`project.yml` is the source of truth for the Xcode project; the `.xcodeproj` is generated and not
committed. Re-run `bootstrap` after adding a file.

## Layout

```
App/                      app target: entry point, Info.plist, and App Icon
../common/
  CameramanCore/          pure value types: zoom mapping, identity, settings, format catalogue,
                          thermal level, the CameraControlling seam (shared with Director/Preview)
  CameramanControlUI/     the operating screen, Settings, zoom rail, thermal pill (shared)
Packages/
  CameramanCapture/       AVFoundation: lens control, format selection, capability measurement
  CameramanEncode/        VideoToolbox H.264/HEVC and AAC, NAL layout conversion
  CameramanRTSP/          SDP, RTP packetization, RTCP, interleaved framing, the server
  CameramanUI/            AppEnvironment wiring, the preview layer, the root and diagnostic views
  CameramanTestHarness/   launch arguments, control server, synthetic camera
Tests/CameramanUnitTests/ everything that can be tested without hardware
docs/                     measured capability set and risk log
maestro/flows/            on-device UI flows
scripts/                  build, test and measurement scripts
```

## Why the packages split this way

`CameramanCore` holds no framework dependencies beyond Foundation, so the zoom arithmetic and the
identity rules are testable on a simulator with no camera. `CameramanEncode` and `CameramanRTSP` are
siblings rather than a chain, which is what lets every packetizer test run on plain bytes with no
VideoToolbox present.

`CameramanCore` and `CameramanControlUI` live in `mobile/apps/common` because GS Director and
GS Preview draw the same operating screen for a phone they control remotely. The screens compile
against the `CameraControlling` protocol rather than against this app's `AppEnvironment`, which
conforms to it; nothing on the phone changed when they moved.

## Interop is proven, not asserted

The unit test target compiles the shared `DirectorRTSP` package in `mobile/apps/common` and
round-trips this app's packetizers and framing through those depacketizers and stream
parser. If the two ever disagree about the wire format, the test fails here rather than showing a
black tile on the iPad. The Director *app* is never built or launched by anything in this directory.

## Measured, not assumed

`docs/capabilities.md` records this handset's real lens set, format list and zoom limits, and how
they were measured. Two of its findings are load-bearing:

- Whether a format keeps multi-lens switching cannot be read off a format object. It has to be made
  active and the device's switchover factors read back.
- `maxAvailableVideoZoomFactor` is **189** on an iPhone 13 Pro. The zoom ceiling comes from
  `systemRecommendedVideoZoomRange` instead.
