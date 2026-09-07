# NDI

GS Director receives NDI® cameras alongside RTSP ones. This is what is different about them, and
why.

> NDI® is a registered trademark of Vizrt NDI AB. NDI tools and the SDK are at
> [ndi.video](https://ndi.video/).

## The one fact everything follows from

**The free NDI SDK decodes before a receiver ever sees a frame.** Compressed passthrough is an
NDI Advanced SDK feature. So `NDIlib_recv_capture_v3` hands us pixels — UYVY, on this platform —
and never the camera's bitstream.

That inverts the rule the RTSP path is built on. `SegmentWriter` is a muxer with no encoder in it:
an RTSP camera's own access units reach the file unaltered, so its archive is a byte copy, costs
no encode session, and its codec, resolution and frame rate are the camera's to choose. An NDI
camera has nothing to write with unless the app makes it.

Three consequences:

| | RTSP | NDI |
|---|---|---|
| Archive | copy of the wire | re-encode |
| Archive codec | the camera's | **ours** — `sourceEncodeCodec`, HEVC by default |
| Encode sessions per camera | 0 | 1, while recording |
| Capture time | reconstructed from RTCP sender reports | per frame, from the SDK's own `timestamp` |

The programme master is encoded either way, because it is a composite that exists nowhere on the
wire.

## Choosing the codec

`Settings → sourceEncodeCodec`, or `-sourceEncodeCodec h264|hevc` for a session. HEVC is the
default and the choice is not cosmetic: the same hardware sustains 118 fps of 1080p H.264 against
296 fps of HEVC, which at 60 fps per camera is the difference between recording two cameras and
four. H.264 exists for a player that cannot open HEVC.

The camera's *own* wire codec — SpeedHQ for full-bandwidth NDI, H.264 or H.265 for NDI|HX — is
reported (`sourceCodec` reads `NDI UYVY`, the layout the SDK handed us) but not obeyed, because by
the time we see a frame it has already been decoded.

## The path a frame takes

```
NDIlib_recv_create_v3(color_format: fastest, bandwidth: highest, allow_video_fields: false)
  │
  ├─ video thread   NDIlib_recv_capture_v3(video, nil, nil, 100 ms)
  │    ├─ NDIFrameValidator     reject → count the reason, free, carry on
  │    ├─ NDIVideoFrameConverter   bulk copy into a pooled CVPixelBuffer of the same format
  │    ├─ sinks.pixel           → PixelConverter → playout → tile / compositor  (unchanged)
  │    └─ encodeQueue.async     → WireVideoEncoder → sinks.compressed → SegmentWriter
  │
  └─ audio thread   NDIlib_recv_capture_v3(nil, audio, metadata, 100 ms)
       ├─ FLTP planar float → mono 48 kHz Int16
       ├─ sinks.audio        → AudioMixer
       └─ WireAudioEncoder   → sinks.compressedAudio → SegmentWriter
```

Two threads because the SDK documentation recommends it and because the video side runs an
encoder: an encoder stalling must not stop audio being collected.

Segments are the same 3-second fMP4 chunks every other source produces, cut on the encoder's own
keyframes, so scrub, replay, export and playback are unchanged. The encoder is configured for a
keyframe every second for that reason — the writer cuts on sync samples, so a longer GOP silently
produces longer chunks.

### Three things that must not happen on the receive thread

Each of these was measured, not reasoned about, and each cost the whole fleet its frame rate.

**Converting pixel format.** The first converter turned UYVY into NV12 with a per-pixel loop and
ran four cameras at **2.3 fps of a requested 30**. `PixelConverter` already normalises every
source into bi-planar 4:2:0 once per frame, shared by preview, proxy and archive, through
`VTPixelTransferSession` — which is hardware. So the NDI converter now copies into a
`CVPixelBuffer` of the *same* format the SDK handed over and lets the pipeline do the conversion it
already owns. Everything in that file is a `memcpy` per row or per plane.

**Encoding when nothing is reading.** `TileRouter` wires all four sinks for every source and
leaves them wired, which is right for a camera whose coded frames arrive whether we want them or
not. Treating that as a request to encode meant four idle preview tiles held four 1080p encode
sessions, and the fleet ran at **2.5 fps with 460 frames dropped by the SDK**. `FrameSource
.setArchiving(_:)` is the seam: the router calls it from `setArchive`, and only a source that has
to make its own coded form cares. With it, four cameras hold 30.0 fps with 94% of the receive
thread idle.

**Encoding at all.** `VTCompressionSessionEncodeFrame` blocks once the encoder's queue is full, so
encoding inline makes a slow encoder throttle *reception* — the operator loses the live picture as
well as the archive. The encode runs on its own serial queue with a backlog capped at four frames;
past that the frame is dropped and counted in `archiveDropped`. A climbing `archiveDropped` is the
archive degrading on purpose so the picture does not.

## What is refused, and why

NDI's reliable UDP repairs the wire, so what reaches a receiver is not torn packets but
*structurally wrong frames*. `NDIFrameValidator` is a pure function over the frame header — no
state, no I/O, testable without a network — and every rejection names which rule fired, because a
frame refused for the wrong reason hides the one that mattered.

| Rejected | Why |
|---|---|
| `xres`/`yres` ≤ 0 | no picture |
| odd width | 4:2:2 cannot carry it, and every chroma calculation is then off by a column |
| above 1920×1080 | 4K is out of scope; refusing it in the source list beats discovering it as a thermal problem mid-game |
| `p_data == NULL` | an Advanced-SDK sender's compressed frame, which this SDK cannot decode |
| unhandled FourCC | counted as `formatMisses` |
| stride shorter than the row | reading it walks off the end of every line |
| `frame_rate_D == 0`, or a rate outside 1–120 | divide by zero, or a corrupt header |
| fielded frames | the receiver asked the SDK to de-interlace; a sender ignoring that is a format we do not archive |
| `timestamp` going backwards | counted as `outOfOrderFrames`; a negative-duration sample is refused by the muxer anyway |
| audio: bad rate, channels, samples, FourCC or channel stride | same reasoning |

Malformed metadata is **not** a rejection. The SDK documentation is explicit that senders do send
badly formed XML and receivers must tolerate it, so it is counted and ignored.

Accepted pixel layouts: UYVY, UYVA (alpha plane ignored), NV12, I420, YV12, BGRA, BGRX, RGBA,
RGBX. UYVA matters more than it looks — `fastest` returns it instead of UYVY whenever the *sender*
declares an alpha channel, which a graphics feed routinely does, and refusing it would show a black
tile for a stream that reads perfectly well.

## Timing

The SDK fills `timestamp` on every frame: UTC, 100 ns units, from a high-precision clock,
documented as roughly microsecond-accurate. That is exactly `CompressedFrame.captureWallClock` —
the absolute capture time the RTSP path has to reconstruct from RTCP sender reports arriving every
few seconds, and the reason two RTSP cameras rewound to the same moment can land in different
places.

`timecode` is deliberately unused. The documentation says it is passed through for applications to
interpret as they wish, so a sender may make it a wall clock, a zero-based counter, or nothing.

A sender whose clock is more than an hour from ours is treated as having no clock, and arrival time
is used instead: anchoring the DVR to a camera that thinks it is 1970 puts every one of its
segments outside the recording's own span.

## Building

The library is about 380 MB across its slices and is **not committed**. `scripts/bootstrapNdi.sh`
builds `DirectorNDI/Vendor/libndi.xcframework` from the installer, and `bootstrap.sh` runs it.

The interesting part is the simulator. `lib/iOS/libndi_ios.a` ships **arm64 for the device and
x86_64 for the simulator**, and Xcode will not run an x86_64 simulator on Apple Silicon — so a
stock SDK cannot be built for any iPad simulator on this machine, which would remove simulator
testing from this feature entirely.

`scripts/patchMachoPlatform.py` retargets a copy of the device slice by rewriting
`LC_BUILD_VERSION.platform`, one 4-byte word in a load command whose size does not change. Two
things that do not work, both established the expensive way and both recorded in the script:
`vtool -replace` rejects every one of these objects with "not enough space to hold load commands",
and extracting them with `ar x` silently loses six duplicate member names, after which the link
fails on `Processing::NDI::Config::configuration::*`. So the archive is patched in place.

`Info.plist` declares `_ndi._tcp` under `NSBonjourServices`. Browsing a service iOS has not been
told about fails with -65555 and takes the browser down with it, so without that entry discovery is
simply empty and reports nothing.

## Testing

The generator is `mobile/tools/gsNdiCameras`, built by `scripts/bootstrapNdiTools.sh`.

NDI Test Patterns from ndi.video/tools does publish NDI streams and is worth keeping as a
third-party interop control. It cannot burn in a stopwatch, drop a frame on command, change
resolution mid-stream, or send a frame whose stride is shorter than its own row, which is most of
what this path has to be proved against.

```bash
node scripts/fakeNdiCameras.js --self-test          # markers, render cost, pacing
node scripts/fakeNdiCameras.js --count 4 --fps 30 & # publish four cameras

DIRECTOR_SIMULATOR_UDID=<udid> bash scripts/build-sim.sh
xcrun simctl launch <udid> co.gamestation.director -uiTest true -sourceProfile ndi
node scripts/control.js enable 1 2 3 4
node scripts/measure.js --seconds 20
```

The picture is deliberately the same as `SyntheticFrameSource` draws — sweeping bar over a drifting
gradient, stopwatch, frame counter, `FrameMarker` strip. When an NDI archive comes back wrong, the
same picture arriving correctly from a simulated camera says the fault is in the NDI path rather
than in the content, the encoder or the writer.

### Faults

All on `http://127.0.0.1:8770`, shaped like `fakeRtspCameras.js`'s fault port.

| Endpoint | What it proves |
|---|---|
| `/fault?cam=1&drop=0.05` | thinning: arrivals fall ~5%, archive stays playable |
| `/fault?cam=1&burst=30` | a real dropout: the last frame's duration stretches to cover it |
| `/fault?cam=1&stall=8` | the stall watchdog, and the archive filler covering the gap |
| `/fault?cam=1&jitter=120` | the playout buffer growing and settling |
| `/fault?cam=1&fps=30` | a frame-rate change mid-recording |
| `/fault?cam=1&size=1280x720` | a resolution change mid-recording: a fresh writer, `arch=720` after |
| `/fault?cam=1&size=3840x2160` | 4K **refused**: counter moves, no encode session taken, app alive |
| `/fault?cam=1&fourcc=PA16` | `formatMisses` moves, nothing reaches the writer |
| `/fault?cam=1&badstride=1` | refused on the header, before any read past the row |
| `/fault?cam=1&badrate=1` | refused; no divide by zero |
| `/fault?cam=1&timecode=back` | `outOfOrderFrames` climbs, presentation times stay monotonic |
| `/fault?cam=1&metadata=malformed` | logged and ignored; capture continues |
| `/fault?cam=1&audio=off` | video-only archive |
| `/fault?cam=1&channels=6` / `&samplerate=44100` | downmix and resample to the 48 kHz mono bus |
| `/fault?cam=1&kill=1` then `&revive=1` | discovery loss, reconnect, filled gap, **clean stop after** |
| `/fault?cam=1&rename=NEW` | a new identity, offered as a rebind |
| `/clock` | what the generator itself sent — what makes any claim about receipt falsifiable |

Network-level impairment is separate, because it works *below* NDI's own retransmission and is the
only way to make the SDK's congestion control actually run:

```bash
sudo bash scripts/ndiImpair.sh --loss 2 --delay 40 --jitter 20 --bandwidth 20Mbit
sudo bash scripts/ndiImpair.sh --off
```

### Two things about the generator worth knowing

Both were measured here and both would otherwise have been read as the app failing.

**Timer coalescing.** The kernel scales its coalescing window with the delay requested, so a single
33 ms `mach_wait_until` from an idle thread came back after 180 ms — every time — pacing a declared
30 fps stream at 12. `FramePacer` slices the wait and spins the last two milliseconds.

**Synchronous sending.** `NDIlib_send_send_video_v2` put the colour conversion and SpeedHQ encode
on the pacing thread and capped four cameras at 54 of a requested 60 fps. Async submission against
alternating buffers moved it off, and the send now costs 1.8 ms instead of 8.

`--self-test` checks the markers, the render cost and the pacing, and fails on any of them, because
a farm that cannot hold a schedule makes every measurement taken against it wrong in the same
direction.

## Capacity, and what a simulator does not tell you

The simulator has **no hardware video encoder**. Four 1080p HEVC archives there are software
encodes: the fleet drops to about 1.5 fps and the app sits at 877% CPU. That number says nothing
about the iPad, which has a hardware encoder, and it must not be quoted as a capacity result.

What the simulator *does* prove is the transport, discovery, the filter, the timing, the format
handling and the archive's shape. Capacity, thermals and sustained encode are device questions —
see `risks.md` for the measured figures and the device they were taken on.
