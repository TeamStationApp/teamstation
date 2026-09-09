# GS Cameraman

An iPhone that answers RTSP. Point a client at it and it serves what the camera sees, so a phone
can stand in for a fixed camera on the field without any intermediate server.

## What it is made of

```
  AVCaptureSession ──► VideoEncoder ──┐
  (CameramanCapture)  (VideoToolbox)  │
                                      ├──► RTSPServer ──► client
  AVCaptureSession ──► AudioEncoder ──┘   (NWListener)
       microphone       (AAC-LC)
```

Seven packages, split so the parts that can be tested without hardware are not tangled with the
parts that cannot. Two of them live in `mobile/apps/common` because GS Director and GS Preview draw
the same screen for a phone they control over the network:

| Package | Holds | Needs a device? |
|---|---|---|
| `common/CameramanCore` | identity, stream settings, zoom mapping, lenses, format catalogue, thermal level, frame types, the `CameraControlling` seam | no |
| `common/CameramanControlUI` | the operating screen, Settings, zoom rail, thermal and battery pills, generic over `CameraControlling` | no |
| `CameramanCapture` | `AVCaptureSession`, lens selection, format selection | yes |
| `CameramanEncode` | VideoToolbox H.264/HEVC, AAC, NAL and parameter-set handling, the black frame both blanking paths share | partly |
| `CameramanRTSP` | RTSP server, packetizers, SDP, RTCP, interleaved framing | no |
| `CameramanUI` | `AppEnvironment` (which conforms to `CameraControlling`), the preview layer, root and diagnostic views, the external-display scene and clean feed | no |
| `CameramanTestHarness` | launch arguments, control channel, synthetic camera, recorders | no |

The encoder emits plain elementary NAL units rather than `CMSampleBuffer`s, which is what lets every
packetizer be tested on bytes with no media framework involved.

## The stream

TCP only, RTP and RTCP interleaved over the RTSP connection (RFC 2326 §10.12). UDP is not offered:
the one client that matters is GS Producer, it asks for interleaved, and a second transport would be
a second thing to get wrong.

Each connection owns its own SSRCs, its own sequence numbers and its own timeline starting at zero,
so the SDP a client is handed describes the stream it will actually receive rather than a shared one
already in progress.

**Video** is H.264 by default, HEVC on request. `PLAY` asks the encoder for a keyframe and the
connection withholds video until one arrives, so the first frame a client decodes is always an IDR
rather than something referring to pictures it never saw. Parameter sets travel both in the SDP and
in-band on every keyframe.

**Audio** is AAC-LC at 48 kHz mono, RFC 3640 `mpeg4-generic` in AAC-hbr mode. On by default, and
omitted from the SDP entirely rather than announced-and-silent when muted.

**Nobody playing, nobody encoding.** While `stream.clients` is 0 the frames are still captured,
counted and drawn on an external display, but neither encoder runs (`EncoderIdlePolicy`): a phone
that only answers telemetry and control, with its picture leaving over HDMI, spends nothing on
VideoToolbox. Two exceptions: the video encoder runs until it has produced parameter sets, since
`DESCRIBE` puts those in the SDP before anyone can `PLAY`; and `-encodeWhenIdle true` keeps both
running for a diagnostic. The first client's `PLAY` requests a keyframe and the 0→1 client
transition requests another, so the first encoded frame after idle is an IDR. `dump-state` reports
`encoderIdle`.

**Backpressure** is a byte budget per connection. Audio is never dropped, non-keyframes are dropped
once over the water mark, and a keyframe flushes the backlog and starts a fresh one. A client that
stops reading costs a bounded amount of memory and then a gap, rather than growing until something
gives.

## Identity

Every camera has a UUID it keeps forever and a name the operator can change.

The UUID is carried as the RTCP **CNAME** in RFC 7022's long-term persistent form, and repeated in
the SDP as `a=ssrc:<id> cname:<value>` per RFC 5576. The name is the SDP session name and the RTCP
SDES **NAME**. Nothing here is invented — RFC 3550 already defines exactly this pair, and Producer
reads both without a private protocol.

The UUID lives in the Keychain, so it survives deleting and reinstalling the app. That matters
because it is what binds this camera to its tile, its archive and its telemetry on the Producer
side: renaming a camera must not make it a new one.

## Zoom and lenses

The triple camera is one `AVCaptureDevice` that switches between its constituents as the zoom
factor crosses hardware thresholds. Settings lists every detected lens — physical constituents
plus native crops such as the 48 mm 2x — with a toggle. Disabling a lens picks the virtual or
physical device that covers only what remains, and turns off fallback switching so focus cannot
hop onto a camera the operator turned off (the clip-on-telephoto case).

Two zoom scales exist and confusing them is the main hazard: **device zoom** is the raw sensor
factor the API takes, and **displayed zoom** is the 0.5x/1x/3x an operator reads. `ZoomMapping`
converts between them from the device's own switchover factors, so the preset row is 0.5x/1x/3x on
the back camera and a single 1x on the front without anything being hardcoded.

The ceiling comes from `systemRecommendedVideoZoomRange`, not `maxAvailableVideoZoomFactor` — see
`docs/risks.md` for why the latter is unusable.

## Remote control

GS Director and GS Preview drive the phone over the RTSP port it already serves, with RFC 2326
`GET_PARAMETER` / `SET_PARAMETER` and `text/parameters` bodies (the vocabulary is in
`rtsp-interop.md`). The client opens a second, control-only connection so zoom writes never queue
behind RTP, polls the whole set once a second, and writes zoom, flip, name and Settings. On the
phone the server hands each request to `AppEnvironment.handleParameters`, which applies it through
the same `CameraControlling` methods the phone's own screen uses — so a remote zoom moves the
phone's rail, a remote codec change shows in its Settings, and remote framing is persisted by the
same `persistFramingIfChanged` path as a local pinch. Only playing sessions count as clients; a
connection that merely polls parameters is not a viewer. The Bonjour TXT record carries
`control=params/1` so a client knows before connecting that this build answers the verbs.

## External display

A USB-C display gets exactly what the encoder is given, and nothing else: no name badge, thermal or
battery pill, zoom rail or buttons. The point is a capture device on the end of the cable (a
Hollyland Cosmo C2 turning HDMI into NDI), which then carries the encoder's framing byte for byte
while the phone's radio stays quiet.

```
  capture frame ──► VideoEncoder.encode(frame, blank:)          ──► RTSP
        └─────────► CleanFeedController.enqueue(frame, blank:)  ──► AVSampleBufferDisplayLayer on the external window
```

The fan-out is the one `onVideoFrame` closure in `AppEnvironment.startEncoding`, so the display and
the stream always see the same picture, including black when video is off. The display gets a new
`CMSampleBuffer` over the same pixels with `DisplayImmediately` set (`CleanFeedFrame`); the buffer
the encoder is reading on its own queue is never touched. Frames go from the capture queue to
`AVSampleBufferVideoRenderer` directly, with no main-actor hop.

The display is a UIKit scene: `Info.plist` declares `UIApplicationSupportsMultipleScenes` and a
configuration for `UIWindowSceneSessionRoleExternalDisplayNonInteractive`, and
`CameramanAppDelegate.application(_:configurationForConnecting:options:)` names
`ExternalDisplaySceneDelegate` for that role. The delegate hands the connected `UIWindowScene` to
`CleanFeedController` (owned by `AppEnvironment`), which picks the screen mode whose size matches
the stream's width × height, else the largest, with overscan compensation off, and puts a
`UIWindow` with a `CleanFeedViewController` on it. `.resizeAspect`, so a stream that does not match
the display is letterboxed rather than cropped. A resolution change in Settings re-runs the mode
selection.

`StreamSettings.cleanHDMIEnabled` (Settings → Output → "Clean HDMI output", on by default) is not a
pipeline setting: it never restarts the encoder. Off means the controller puts no window on the
display and drops the one it had, which is what lets iOS resume mirroring the phone's screen. The
same value is the `cleanHdmi` launch key, the `set-clean-hdmi` control command, the
`videoOutput.hdmi.clean` parameter, and `cleanHDMIEnabled` plus `externalDisplay`
(`connected`, `mode`, `framesEnqueued`) in `dump-state`.

## Discovery

The server advertises `_rtsp._tcp` and `_awx_service._tcp` over Bonjour. Director finds NearStream
on `_awx_service._tcp` (TXT `ip=`), and that browse is what still works when the phone is on 2.4 GHz
and the iPad is on 5 GHz. `_rtsp._tcp` alone is not enough: iOS does not answer a subnet TCP scan
the way a VM33 does, so without that advertisement the phone never appears. TXT carries `uuid`,
`name`, `path`, `ip` and `port`. `NSBonjourServices` must list both types or advertising fails
with `-65555` and takes the listener down with it.

Port 554 by default, falling back to 8554 if something already holds it. Both the bound port and the
fallback are visible on screen, because an operator reading "554" off a phone that is actually on
8554 has no way to discover that from the client end.

## Running it

```bash
socket npm run bootstrap        # xcodegen + resolve packages
socket npm run build:device     # build, install and launch on the connected iPhone
socket npm run test:unit        # 302 tests on the simulator
socket npm run verify:stream    # end-to-end: build, launch, discover, pull, decode
```

See `docs/testing.md` for the rest, and `docs/rtsp-interop.md` for what is on the wire.
