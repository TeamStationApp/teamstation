# GS Cameraman for Android

A phone that answers RTSP and does not stop when you put it down. Point a client at it and it serves
what the camera sees, so a handset can stand in for a fixed camera on the field without any
intermediate server.

## What it is made of

```
  Camera2 ──► SurfaceTexture ──► GL ──► MediaCodec ──┐
  (capture)                     (gl)   (encode, H.264/HEVC)
                                 │                    ├──► RTSPServer ──► client
                                 └──► preview         │    (ServerSocket)
                                                      │
  AudioRecord ──────────────────────► MediaCodec ─────┘
  (capture)                           (encode, AAC-LC)

  all of it owned by CameramanService, a foreground service
```

Eight packages, split so the parts that can be tested without hardware are not tangled with the parts
that cannot:

| Package | Holds | Needs a device? |
|---|---|---|
| `core` | identity, stream settings, zoom mapping, frame types | no |
| `capture` | Camera2 session, lens selection, format catalogue, microphone | yes |
| `gl` | EGL context, texture program, the camera-to-encoder renderer | yes |
| `encode` | MediaCodec H.264/HEVC, AAC, NAL and parameter-set handling | partly |
| `rtsp` | RTSP server, packetizers, SDP, RTCP, interleaved framing, NSD | no |
| `ui` | Compose screens | no |
| `harness` | launch arguments, control channel, synthetic camera, recorders | no |
| `service` | the foreground service and its notification | yes |

The encoder emits plain elementary NAL units rather than codec buffers, which is what lets every
packetizer be tested on bytes with no media framework involved.

## Where it lives is the design

`AppEnvironment` — the wiring — is owned by `CameramanService`, not by `MainActivity`. The activity
binds to the service and is a window onto it. Close it, lock the screen, switch apps: the camera
keeps capturing and the listener keeps serving, because nothing that matters lives in the activity.

That inversion is the whole reason this port exists. The iOS build cannot do it — iOS suspends a
backgrounded app and there is nothing to be done about it — so on iOS the same object is owned by the
SwiftUI `App` and dies with it.

## The stream

Byte-for-byte what the iOS build sends. TCP only, RTP and RTCP interleaved over the RTSP connection
(RFC 2326 §10.12). UDP is not offered: the one client that matters is GS Producer, it asks for
interleaved, and a second transport would be a second thing to get wrong.

Each connection owns its own SSRCs, its own sequence numbers and its own timeline starting at zero,
so the SDP a client is handed describes the stream it will actually receive rather than a shared one
already in progress.

**Video** is H.264 by default, HEVC on request. `PLAY` asks the encoder for a keyframe and the
connection withholds video until one arrives, so the first frame a client decodes is always an IDR
rather than something referring to pictures it never saw. Parameter sets travel both in the SDP and
in-band on every keyframe.

**Audio** is AAC-LC at 48 kHz mono, RFC 3640 `mpeg4-generic` in AAC-hbr mode. On by default, and
omitted from the SDP entirely rather than announced-and-silent when muted.

**Backpressure** is a byte budget per connection. Audio is never dropped, non-keyframes are dropped
once over the water mark, and a keyframe flushes the backlog and starts a fresh one. A client that
stops reading costs a bounded amount of memory and then a gap, rather than growing until something
gives.

### One place the transport is better than the iOS build's

`NWConnection` cannot retract bytes it has already been handed, so on iOS a flush can only stop the
stale backlog being *charged* to the new keyframe. Here the writer thread has its own queue, so a
flush also drops the not-yet-written batches — the client stops receiving stale pictures rather than
only stopping being billed for them. The generation guard is kept anyway, for the batch already in
flight.

## Identity

Every camera has a UUID it keeps and a name the operator can change.

The UUID is carried as the RTCP **CNAME** in RFC 7022's long-term persistent form, and repeated in
the SDP as `a=ssrc:<id> cname:<value>` per RFC 5576. The name is the SDP session name and the RTCP
SDES **NAME**. Nothing here is invented — RFC 3550 already defines exactly this pair, and Producer
reads both without a private protocol.

The UUID lives in app storage with `allowBackup="false"`, so it is device-only and readable after
first unlock — two of the three properties the iOS Keychain gives it. It does **not** survive an
uninstall; Android offers no store that does. See `PreferencesIdentityStore`.

## Zoom and lenses

The logical multi-camera is one `CameraDevice` that switches between its physical constituents by
itself as `CONTROL_ZOOM_RATIO` crosses hardware thresholds. The app does not choose lenses; it sets a
zoom ratio.

Unlike iOS, the two zoom scales coincide: `CONTROL_ZOOM_RATIO` is already the 0.5x/1x/5x an operator
reads, so `ZoomMapping.displayMultiplier` is 1. The conversion is kept anyway, so every call site
stays explicit about which scale it is in and the arithmetic — and its tests — are shared with the
iOS build rather than being a second implementation that agrees by luck.

The switchover ratios are derived from the constituent lenses' focal lengths, because nothing
publishes them. See `docs/capabilities.md`.

## Rotation

Camera2 output is always in sensor orientation and there is no `videoRotationAngle` to set, so frames
go camera → `SurfaceTexture` → GL → encoder surface and the rotation is a matrix in that shader. The
same GL pass draws the preview, which is what keeps the iOS build's promise that the operator frames
what the client receives — including after a flip to the front camera, which is also un-mirrored
there.

The angle is not the textbook one, and why is measured rather than argued: `docs/capabilities.md`.

## Discovery

The server advertises `_rtsp._tcp` over `NsdManager`, so a client finds the phone without being told
an address that changes with the lease. That is Android's mDNS responder rather than Bonjour, but it
is the same protocol on the wire and Director's browser cannot tell the difference.

`NsdManager` has no update call, so a rename unregisters and registers again; Director sees the old
instance go and the new one arrive, which is what Bonjour does on iOS for the same change.

A failed registration leaves the socket alone, unlike iOS where a missing `NSBonjourServices` takes
the whole listener down with it. So `isAdvertising` is reported separately from `isListening` rather
than being assumed from it.

Port 554 by default, falling back to 8554 — which on Android is always what happens, because 554 is
privileged. Both the bound port and the request are visible on screen.

## Running it

```bash
npm run device:install       # build, install, grant permissions
npm run test:unit            # 157 JVM tests
npm run verify:stream        # end-to-end: build, launch, pull, decode
npm run verify:background    # the same, foregrounded / backgrounded / screen off
```

See `docs/testing.md` for the rest, and `docs/rtsp-interop.md` for what is on the wire.
