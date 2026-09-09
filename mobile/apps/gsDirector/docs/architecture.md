# Architecture

## The constraint everything follows from

A source hands the pipeline decoded pixels, one `PixelFrame` at a time. Archiving a camera
therefore means **encode**, and the iPad's media engine has to carry every camera's encode plus
the program encode at once. Encode sessions, not CPU, are the scarce resource.

Everything below is shaped by that: the shared conversion path, the encode-session budget, the
degradation ladder, and the decision to never upscale.

## The path a frame takes

```
source receive thread (one per camera)
  │  frame delivered as a pooled CVPixelBuffer
  ▼
SourcePipeline.handle(PixelFrame)
  │  PixelConverter: BGRA/4:2:0 → NV12, once per frame, shared by every consumer
  ▼
  ├─→ SegmentWriter   archive, 6s fMP4 segments + SQLite index   (always, if the tier allows)
  ├─→ ProxyStore      1 fps JPEG stills in chunked blobs         (always, every tier)
  ├─→ TileRenderer    AVSampleBufferDisplayLayer                 (only when the tile is live)
  └─→ MetalCompositor picture + scorebug overlay                 (only the program tile)
        ├─→ programRenderer  the merged 2×2 preview tile         (always)
        └─→ ProgramEncoder   master file                         (only while recording)

Audio takes its own path, because it is not tied to the tile on programme:

every source's capture thread
  ├─→ SegmentWriter  that camera's own archive track
  └─→ AudioMixer     if the operator ticked its audio switch
        └─→ ProgramEncoder  one continuous 48 kHz stereo bus
```

The programme is composited whether or not anything is recording. That costs a Metal pass per
frame and buys the preview tile: without it, a mispositioned or stale scorebug is invisible until
the recording is played back after the game.

The archive and proxy branches come **before** the tile's display state is consulted. That is
what makes "scrub backwards while it keeps recording" true rather than aspirational: a tile in
replay is still feeding its archive.

Sources that hand over pixels rather than a bitstream — the simulated cameras, and NDI cameras,
whose bitstream the free NDI SDK decodes before a receiver sees it — cannot use the archive branch
as it stands, because there is nothing to copy. They encode their own coded form on a queue of
their own and publish it into the same sink. That costs one encode session per camera rather than
none, which is why `FrameSource.setArchiving(_:)` exists: nothing encodes until an archive is
actually reading. See [ndi.md](ndi.md).

## Receiving a camera

A camera is an RTSP server. `DirectorRTSP` speaks to it directly rather than through a media
framework, because the parts that matter here — which codec, when a session has gone quiet, how much
was lost — are exactly the parts a framework hides.

```
NWConnection (TCP, RTP interleaved on the same socket)
  │  RTSPSession: OPTIONS → DESCRIBE → SETUP per track → PLAY, then GET_PARAMETER keepalives
  ▼
RTSPStreamParser  splits $-framed RTP packets from RTSP responses
  ├─→ H264Depacketizer / HEVCDepacketizer  RTP payloads → one access unit per picture
  │     └─→ PlayoutQueue  held until due, then VideoToolboxDecoder → PixelFrame
  └─→ AACDepacketizer  → AACAudioDecoder  → 48 kHz LPCM → PlayoutQueue → AudioFrame
```

Both video depacketizers exist because the cameras are not configured alike: two send HEVC at 1080p
and one sends H.264 at 720p, and the two RFCs differ in ways that cannot be papered over — HEVC's
NAL header is two bytes and its fragmentation and aggregation packets are shaped differently.

Interleaving RTP on the RTSP socket rather than taking it over UDP costs a little latency and buys
two things worth more on a venue's Wi-Fi: no second port to get through, and loss that TCP reports
instead of silently dropping.

Audio is resampled on the way in. The cameras send 32 kHz AAC and the programme bus is 48 kHz, so
`AACAudioDecoder` converts as it decodes rather than leaving a rate mismatch for the mixer.

## Holding frames back on purpose

Frames do not arrive evenly. Each camera spends roughly half of every second transmitting one
keyframe, during which nothing else arrives, and then delivers the fifteen frames that queued up
behind it in a burst. Decoding on arrival reproduces that on the screen — the stutter an operator
sees against a millisecond clock — so every access unit is instead held in a `PlayoutQueue` and
released against its own timestamp by a 4 ms tick on the source's queue.

Three decisions inside that are worth knowing before changing any of it:

- **Compressed, not decoded.** Half a second of 1080p is eighteen frames: 450 KB as access units,
  56 MB as pixel buffers, and four cameras of the latter is more memory than iPadOS allows this
  app. Decoding on release costs the few milliseconds it always cost.
- **The whole pipeline waits, not just the preview.** Delaying only the monitor would mean the
  operator watching half a second in the past while their cut landed on the present, firing every
  switch early. Archives are written from RTP timestamps, so they are byte-identical either way.
- **The size is measured, not configured.** `PlayoutController` sizes the buffer from how late
  frames actually are against their own timestamps, and the same mechanism absorbs the tens of
  parts per million by which the camera's clock and the iPad's drift apart — a buffer this size
  would otherwise empty within the hour. It grows quickly, gives delay back slowly, and covers a
  frame that arrives past its due time immediately, because that stall has already been seen.

Every camera is held to the delay of whichever needs the most, through the `PlayoutCoordinator` on
`CameraRegistry`. Two tiles at different delays show two different moments of the same game, which
is worse when cutting between them than either being late. What each camera settles on is
remembered against its `CameraRecord`, so a camera used before is smooth from its first second.

Sessions do not heal themselves, so `RTSPFrameSource` supervises: a socket error or five seconds
without a completed picture triggers a reconnect at 1, 2, 4 then 8 seconds. Three failures at an
address that used to work means the camera has probably been given a new one, which is a question for
the identity layer rather than the transport — see
[camera-identity.md](camera-identity.md).

## Finding the cameras

NDI cameras are the exception to everything in this section: they announce themselves over mDNS and
the SDK's own finder maintains the list, so there is nothing to scan for and no port to probe.

These RTSP cameras advertise nothing. No mDNS, no ONVIF, no discovery protocol of any kind, so there is
nothing to browse for and the only way to find one is to look for an open port 554 on the local
subnet and ask each answer to describe itself.

The search is bounded at a /22 and refuses anything wider: a misconfigured mask would otherwise start
a 65 000-host scan in the middle of a game. It also stops entirely once production starts. Nothing
new can be put on a tile from that screen, and a subnet search competes with the streams it already
found for the same radio; a camera that drops is looked for on demand instead.

## Linking a picture to a phone

A Cameraman can be on the grid twice over without being received twice. Its clean HDMI output goes
into a capture box that turns it into NDI — the Hollyland Cosmo C2 on the bench — and that NDI
source is the tile's picture. The phone itself is then **linked** to that row: the row's telemetry
polling and its control screen resolve to the phone's socket (`AppEnvironment.controlEndpoint(for:)`)
while identity, naming and the media path keep resolving the row's own. Only `RTSPParameterSession`s
are ever opened to a linked phone — `OPTIONS`, `GET_PARAMETER`, `SET_PARAMETER`, never `SETUP` or
`PLAY` — so its radio carries a few hundred bytes every five seconds instead of a stream, and its
encoder idles.

The link is one field on the row with the picture, `SourceSelection.linkedControlID`, so the two
sides cannot disagree; `SourceSelectionRules` derives everything else. A linked phone is taken off
the grid (no tile, no slot, no place in the mix) and stays off it until unlinked; the list shows it
directly under the row it controls without reordering what is stored, so slots, merges and the
control channel's row numbers are unaffected. Either half of a link survives dropping off the
network, and loaded state is normalised so an old blob cannot put a linked phone back on a tile.

## Mixing programme audio

Cameras stamp audio with their own clocks and deliver it on their own threads, so the mixer cannot
concatenate buffers in arrival order. `AudioMixer` writes each buffer into a ring indexed by wall
clock and emits 20 ms chunks from a cursor a quarter-second behind the live edge, by which point
late arrivals have landed. Two properties follow, and both matter more than the arithmetic:

- The output is continuous. A stretch with no contributors is emitted as silence rather than left
  as a gap, because an audio track that falls behind the video track stalls the muxer — a failure
  this pipeline has already been bitten by twice.
- Mixing is summation with a clamp. There is no limiter and no automatic gain: with several
  cameras in one room the sum is dominated by whichever is nearest the action, and quiet programme
  audio is easier to fix afterwards than pumping is. Five hot sources will clip.

## Threading

Frame handling never hops to an actor. Each camera has its own receive thread, and shared state
is protected by locks rather than actor isolation, so a frame arriving at 30 fps is not queued
behind the main actor.

Two things learned the hard way, both now enforced in the code:

- `VTPixelTransferSession` is not thread-safe. `PixelConverter` keeps a pool and checks a
  session out per conversion.
- `await writer.finishWriting()` resolves to the **synchronous** overload, which blocks the
  calling thread. Both writers use the completion-handler form instead.

## Recording lifecycle

Starting is not all-or-nothing. Each camera and the program encoder can fail independently, and
the app enters the recording state if anything at all is writing. The alternative — bailing out
partway — leaves live writers attached that `stopRecording` then refuses to touch, and the
recording can never be stopped.

Stopping flushes every writer with a deadline. Flushing a segmented `AVAssetWriter` takes real
time on older hardware, and a writer that never received a frame can never be finished at all
(its session was never started), so it is cancelled rather than awaited.

## Degradation

`DegradationController` watches thermal state, encode-session failures and dropped frames, and
moves through four tiers: full quality, reduced resolution or frame rate, fewer archived
cameras, then program-only. Proxy stills are captured at every tier including the last, so the
scrub timeline is never blank no matter how far the app has degraded.

Archiving never upscales. A 640x360 source encoded at 1080p costs encoder time, thermal budget
and disk for detail that does not exist — on the test iPad it was the difference between 8 MB
and 90 MB for the same 25 seconds.

## Testability

`PipelineTelemetry` is the single director of state for the debug HUD, the accessibility values
Maestro asserts on, and the JSON state dump. There is no test-only shadow copy, so an assertion
observes the same numbers the app is running on.
