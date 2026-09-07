# Risks and measured limits

Unless a section names another device, measurements below are from an **iPad Pro 11-inch (2018,
A12X), iPadOS 26.5.2** — considerably weaker than the M2/M4 class the design targets. Treat them as
a floor, not a spec.

**Two devices (from 2026-08-19):** an **iPad Pro 11-inch (M4)** has joined the A12X. Every reading
must name its device, because they are not the same machine in any sense that matters here — the
scripts pick whichever iPad is attached, so a figure without a device is a figure without meaning.
The A12X notes below stand; the M4 series is separate.

**Cooling (from 2026-08-13, A12X only):** that unit sits on a **Peltier cooler**. HUD `thermal=` and
time-to-throttle from that date onward are not comparable to a bare iPad or the earlier cooling
pad. A stay at `fair` on the Peltier does not mean the same load would stay `fair` in a bag or
on a stand in a gym. Note the cooler in any new thermal write-up.

**Transport (from 2026-08-18):** cameras are received over **RTSP**. Measurements taken before that
date came from an NDI-based receive path and are kept because they are evidence about the *hardware* —
encode ceilings, thermals, the muxer, the audio-track capacity limit — which the transport does not
change. Anything about **arrival rate, bandwidth or discovery** from that series describes NDI and
must not be cited about RTSP: the two differ in the way that matters most, since NDI delivered decoded
frames and RTSP delivers a compressed bitstream this app decodes itself. Keep new arrival numbers in
their own series, as below.

## Measured — RTSP series

### The three cameras are not configured alike, and one is HEVC

Probing all three directly (`DESCRIBE`, then a short RTP capture):

| Camera | Video | Audio | Path |
|---|---|---|---|
| 10.10.7.148 | H.265 Main L4.0, 1920x1080@30 | AAC-LC 32 kHz stereo | `/live/mainstream` |
| 10.10.7.225 | H.264 Main L3.1, 1280x720@30 | AAC-LC 32 kHz stereo | `/live/mainstream` |
| 10.10.7.244 | H.265 Main L4.0, 1920x1080@30 | AAC-LC 32 kHz stereo | `/live/mainstream` |

Consequences worth keeping in mind rather than rediscovering:

- **Both depacketizers are required.** An H.264-only receive path would have left one camera working
  and two black, and the two RFCs differ structurally — HEVC's NAL header is two bytes, and its
  fragmentation and aggregation packets are not the H.264 ones with a different number.
- **Audio needs resampling on the way in.** Every camera sends 32 kHz and the programme bus is
  48 kHz. Before this was handled in the decoder, every camera took the mixer's crude
  nearest-neighbour path — not the rare fallback it was written to be.
- **There is no substream.** `/live/substream`, `/live/sub`, `/live/secondstream`,
  `/live/mainstream2` and `/live/stream1` all 404. A lower-resolution ladder rung has to be produced
  on the iPad; the camera will not provide one.
- **No authentication is demanded**, and the session header carries no timeout, so RFC 2326's 60 s
  default applies. `GET_PARAMETER` is in `Public` and is the keepalive.
- **Identity is `_awx_service._tcp`, not `_rtsp._tcp`.** TXT `modelname` (else `wlanmac`) is the
  stable id. The SRV port is closed; media is still RTSP `:554`. A subnet search remains the
  fallback when Bonjour has not resolved yet. No ONVIF.

### Three cameras, recorded and archived, on an M4 iPad

**Device: iPad Pro 11-inch (M4), iPadOS 26.6.1, no cooler, on mains power.** This is a different
device from the 2018 A12X the rest of this file describes, and nothing here transfers to that one.

Three real cameras enabled, programme on camera 1, recording for 5 minutes:

| Reading | Camera 1 (1080p HEVC) | Camera 2 (720p H.264) | Camera 3 (1080p HEVC) |
|---|---|---|---|
| Arrival | 30.0 fps | 30.0–30.1 fps | 30.0 fps |
| Encoded | 30.0 fps | 29.6–30.1 fps | 30.0 fps |
| Proxy stills | 1.00/s | 1.00/s | 1.00/s |
| Dropped, first 65 s | 0 | 25 | 2 |
| Dropped, next 125 s | 0 | 7 | 8 |

Whole-system readings over the same run: `thermal=nominal` throughout, degradation tier 0, four
encode sessions (three archives and the programme), zero encode failures, zero RTP packet loss,
three audio contributors mixing continuously, pixel conversion at 1.3–1.6 ms/frame, 919 MB
footprint with 4.2 GB still available, and 225 MB of archive written per two minutes.

What actually landed on disk, decoded off the device afterwards:

| File | Contents |
|---|---|
| Programme master | HEVC 1920x1080, 9 097 frames in 303.2 s = **30.0 fps**, AAC 48 kHz stereo for the full 303.2 s, scorebug burnt in |
| Camera 1 archive | HEVC 1920x1080, 29.9 fps, audio drift −0.08 s |
| Camera 2 archive | HEVC 1280x720, 29.9 fps, audio drift −0.11 s |
| Camera 3 archive | HEVC 1920x1080, 29.8 fps, audio drift −0.11 s |

The camera-2 drops are the reading to watch: it is the H.264 720p camera, and it is the only one
that loses frames. They are not RTP losses — `loss=0` for the whole run — so they happen after
arrival, and they cluster early, which points at the first seconds of its encode session rather
than at a sustained shortfall. Not diagnosed further, because 25 frames in 65 s is not visible in
the archive's measured rate.

### All three cameras decode and stream together, measured off the device

A simulator run on the Mac, which reaches the same cameras, with all three enabled:

| Reading | Value |
|---|---|
| Search | 253 hosts probed on a /24, 3 open, 3 confirmed |
| Streams | 2 × 1080p HEVC, 1 × 720p H.264, all `state=live` |
| Arrival | 30.3 fps each, sustained over 3 minutes (5 456 frames per camera) |
| Dropped | 0 |
| Audio | 3 contributors, mixer emitting continuously |
| Recording | 30 s take: 18 segments, 96 proxy stills, 4 encode sessions, 0 failures |

**This says nothing about the iPad.** It is a Mac decoding three streams over Ethernet, so it
establishes that the transport, the depacketizers, the decoders and the identity layer are correct —
not that the A12X can carry them. Arrival rate, encode headroom and thermals have to be measured on
the device, and per the note above, with the Peltier's presence stated.

### The once-a-second stutter is the cameras' keyframes, and only the monitor shows it

An operator watching a millisecond clock through the app saw the picture hesitate about once a second.
Measured on the wire with `ffprobe`, all three cameras do this:

| Camera | Stream | Keyframe | Inter frame | Keyframe interval | Share of its second | Wire time at its own bitrate |
|---|---|---|---|---|---|---|
| 10.10.7.148 | 1080p HEVC, 6.09 Mbps | 400 KB | 12.4 KB | 1.00 s | 53% | 538 ms |
| 10.10.7.244 | 1080p HEVC, 6.14 Mbps | 398 KB | 12.2 KB | 1.00 s | 53% | 530 ms |
| 10.10.7.225 | 720p H.264, 2.12 Mbps | 131 KB | 4.4 KB | 1.00 s | 51% | 507 ms |

Half of every second's bytes is one frame, so that frame occupies roughly half a second of the
camera's uplink. Nothing arrives while it does. On the device, `scripts/jitter.js` reads the same
event from the other end: arrival gaps with a median of 218–250 ms and a worst case of 537 ms, and in
18–20 of 20 one-second windows the widest gap ended on a keyframe. Our own work is not involved —
decode, convert and display average 2.2–5.2 ms per frame, rising to 20–35 ms on the keyframe itself.
It is not the proxy still either: the measurement above was taken with recording off.

**The recordings are unaffected.** Frames are timestamped from the camera's 90 kHz RTP clock, not
from when they arrived, so archive files come out evenly spaced: 33.0 ms median, 34 ms at p99, 40–49 ms
worst over 600 frames on all three cameras. Only the preview shows the stutter, because it displays
each frame the moment it arrives (`kCMSampleAttachmentKey_DisplayImmediately`) — which also means
most of the catch-up burst is never seen, since each frame replaces the last within one refresh.

Two levers, and they are independent: a longer keyframe interval or a higher bitrate ceiling on the
camera makes the burst rarer or shorter, and presenting the preview against the layer's timebase with
a buffer wide enough to cover the burst removes it from the monitor entirely, at the cost of that much
monitor latency.

### Sizing that buffer: 300 ms covers a normal minute, 600 ms covers the worst of one

The buffer a smooth preview needs is not the size of the gap; it is how far apart the earliest and
latest frame land relative to their own timestamps, because that is how much video a player must
already hold to present every one of them on time. `scripts/jitter.js` reports it as `buffer needed`
and the HUD as `buf=`, measured over ten-second windows — long enough for several keyframe cycles,
short enough that the camera and device clocks drifting apart does not read as jitter.

Sixty seconds, three cameras, no recording, M4 iPad:

| Camera | Median window | Worst window |
|---|---|---|
| 1080p HEVC, 6.09 Mbps | 277 ms | 591 ms |
| 720p H.264, 2.12 Mbps | 232 ms | 457 ms |
| 1080p HEVC, 6.14 Mbps | 275 ms | 579 ms |

So **300 ms** absorbs a routine keyframe burst on every camera, and **600 ms** absorbs the worst
window seen in a minute. Below about 250 ms the buffer runs dry on most keyframes and the preview
stutters exactly as it does today; above 600 ms there is nothing left to buy. The figure is a property
of the cameras' encoder settings, not of the device — raising the bitrate ceiling or lengthening the
keyframe interval lowers it directly.

Note this is monitor latency the operator feels when cutting, and audio has to be delayed to match.
Program output and archives already run off RTP timestamps and do not change.

**What OBS does.** Its media source paces frames to their own timestamps (`mp_media_sleep` waits until
each frame's PTS-derived deadline), so it is doing exactly the buffered presentation described above —
but its depth is configured in bytes, not milliseconds: "Network Buffering", 2 MB by default. At these
cameras' 6 Mbps that is roughly 2.7 seconds of read-ahead, several times what the jitter demands, which
is why operators pulling IP cameras into OBS report half-second-plus monitor delay and why the
low-latency recipe in those threads is to set the buffer to 0 MB — which turns off buffering entirely
(`AVFMT_FLAG_NOBUFFER`) and brings back the stutter. A millisecond-sized buffer in the 300–600 ms band
is a better trade than either OBS default for a switcher, and is only available to us because we
measure the jitter directly.

### What the delay line actually bought, and what is left

Measured on the M4 with three cameras live, 40 windows each, before and after frames were held and
released against their own timestamps:

| | Arrival gap (median / worst) | Released gap (median / worst) | Held | Late frames |
|---|---|---|---|---|
| Before | 203–228 ms / 315–458 ms | same as arrival | — | — |
| After | 118–141 ms / 214–334 ms | 44–63 ms / 55–70 ms | 569 ms | 0 |

The once-a-second freeze is gone: the worst spacing the screen sees in any second went from a third
of a second to about two frame intervals, no frame has arrived past its due time in these runs, and
all three tiles report a clean 30.0 fps where they previously read 21–32 depending on where the
sampling landed in a burst. Recording through the delay line is unchanged — 30.0 fps program master
with its audio track full length, and per-camera archives at 29.9 fps with the same −0.08 s audio
drift as before.

Two things are worth keeping in view:

**The delay settles higher than the measurement suggested.** It converged on 569 ms, not the 300 ms
the median window asked for, because every camera is held to the worst of the three and the
controller only gives delay back after twenty quiet seconds. That is the intended trade — tiles at
different delays show different moments of the same game — but it means the operator is cutting on
half-second-old pictures, and if that proves too slow to work with, the lever is the shared floor
rather than the buffer itself.

**The remaining 44–63 ms is ours, not the cameras'.** Decoding was moved 60 ms ahead of the due time,
which took the 30 ms an IDR frame costs off the release tick and dropped the worst-case delivery from
33 ms to 12 ms. What is left is the rest of the per-frame work — convert, archive, composite, display
— still running on that tick, so a frame whose work takes 30 ms pushes the next release out by as
much. Removing it means splitting `SourcePipeline` into a prepare stage and a present stage, which
touches the archive and compositor threading the muxer stalls came from; it was not worth that risk
for one frame interval a second, but that is where the next improvement is if the picture still is
not clean enough.

### Searching for cameras competes with receiving them

A live run showed the discovered-source count dropping to zero while three cameras were streaming
happily. The periodic search was re-probing endpoints that already had a session open: a `DESCRIBE`
to a camera mid-session is work it can refuse, and the app was reading that refusal as "this is not a
camera any more".

Two changes followed, both worth keeping in mind as constraints rather than optimisations: an endpoint
with a live source is taken as confirmed without being probed, and the periodic search stops entirely
while production is up, with `searchNow()` as the on-demand path. A subnet search on a venue's Wi-Fi
is not free, and nothing can be added to a tile from the production screen anyway.

## Measured — NDI series (historical transport)

### The archive's audio track was the capacity limit, not the hardware

Everything previously written here about this device being unable to keep up with real cameras was
wrong. The limit was a bug, and it presented as a hardware ceiling because it produced dropped
frames with no error anywhere.

The controlled comparison, three real cameras recording simultaneously on the same device:

| Camera | Sends audio | Received | Encoded | Dropped |
|---|---|---|---|---|
| HX Camera | no | 3,378 | 2,759 | **0** |
| VM33_00D9D | yes | 894 | 26 | 801 |
| VM33_0107B | yes | 1,641 | 725 | 661 |

Disabling the archive audio track (`-archiveAudio false`) took both VM33 cameras to **zero drops**
over two minutes, on the same device at the same moment. The audio track was the entire difference.

Three separate faults were in play, each of which alone stalls a segmented writer:

1. **A camera that sends no audio.** The writer was still given an audio input, which never received
   a sample, so the writer stalled at the first segment rotation — video froze at 11.4 s while
   frames kept arriving. `SegmentWriter` now only gets an audio input if the pipeline has actually
   delivered audio, which `SourcePipeline.hasDeliveredAudio` reports.
2. **Audio arriving before the first video frame.** The anchor was `originalTime - lastVideoTime`
   with `lastVideoTime` starting at negative infinity, giving an infinite base that every later
   sample failed its guard against. The track then stayed empty for the whole recording.
3. **Chasing the source's audio clock.** One camera's audio ran roughly four times faster than its
   video (48 s of audio against 11 s of video in a 25-second recording). Re-anchoring to correct
   that produced timestamps that could land *before* the previously written sample, and a
   non-monotonic append stalls the muxer, which then stops accepting video too.

Audio timestamps are now counted from each buffer's own sample count rather than taken from the
source. That is monotonic by construction and advances at exactly real time. Sources still drift —
the telemetry reports `audioResyncs` and `lastAudioDrift` per tile — but drift can no longer produce
a backwards timestamp.

**What is still open.** With audio enabled, the two audio-bearing cameras still back up: their audio
arrives too sparsely to keep the writer's video input ready, so video is throttled. Per-camera
archives are currently best run with `archiveAudio` off, and whether per-camera archive audio is
wanted at all is a product decision — the program output carries audio regardless.

### Four cameras at 1080p30 run on a 2018 A12X with room to spare

Four synthetic 1080p30 sources with full-frame noise, four archives plus the program encoder — five
concurrent encode sessions — sustained for three minutes:

| Archive codec | Result |
|---|---|
| HEVC | 30 fps on all four, **zero drops**, 12–13% CPU, thermal `fair`, tier T0, 117 segments |
| H.264 | 30 fps on all four, **zero drops**, 12–16% CPU, thermal `fair`, tier T0 |

CPU never exceeded 17% of eight cores, because encoding runs on the fixed-function media engine.
The design target is met outright by the oldest device in the fleet, so encode capacity is not a
reason to buy newer hardware.

### Raw encode ceiling, and why the earlier figure was too high

Sustained 1080p throughput at the operative configuration of five sessions, three runs each:

| Codec | Sustained | Equivalent |
|---|---|---|
| H.264 | 117.5–117.9 fps | 3.9 streams at 30 fps |
| HEVC | 294–297 fps | 9.8 streams at 30 fps |

The previously recorded 205 fps for H.264 was measured with a flat chroma plane, leaving a quarter
of each frame free. With both planes carrying per-pixel noise the figure is 118 fps.

Note that this worst case is *harder than the app's own noise content*: the end-to-end test above
needs 150 fps and passes on H.264 despite the probe's 118 fps ceiling, because per-pixel noise on
both planes is more expensive than 8x8 block noise. Treat 118 fps as a floor and 205 fps as a
ceiling, with real footage in between — and prefer HEVC, which has roughly 2.5x the headroom for the
same picture.

### Generated test content has to be hard, and generating it has to be cheap

Two mistakes worth not repeating, both of which produce confidently wrong capacity numbers.

A flat fill with one moving bar is nearly free to encode: inter-frame prediction finds the whole
frame unchanged and emits skip blocks. Capacity measured on that content means nothing. Generated
frames now default to `-syntheticEntropy high`, which is 8x8 block noise reseeded every frame.

But the first implementation of that noise wrote each pixel individually and ran at **1.4 fps with a
core pinned**, making the generator the bottleneck and the measurement meaningless. These buffers
are IOSurface-backed, and individual word stores to that memory are enormously slower than bulk
operations. Building one row per block with `memset_pattern4` and replicating it down with `memcpy`
runs the same content at 30 fps on four sources for 4.8% CPU — around twenty times faster. Never
fill a pixel buffer with a store-per-pixel loop.


### Three cameras, recording, with room to spare

The design target, measured over a 30-second window with all three Wi-Fi cameras live and recording
to disk:

| | Result |
|---|---|
| Arrival rate | 30.0 fps per camera |
| Encoded to archive | 30.0 fps per camera |
| Dropped frames | 0 |
| Proxy stills | 1.06/s per camera |
| Pixel conversion | 120/s at 1.16 ms |
| Encode sessions | 4 (three archives plus program), 0 failures |
| Program master | 70 MB for 30 s of composited 1080p |
| Thermal state | `fair`, degradation tier 0 |
| Archive flush on stop | 0.1–0.3 s |

At the sender's proxy resolution (640x360). See the network ceiling below for why that is the
operating point rather than a compromise.

### Full-resolution NDI was a Wi-Fi band problem, and moving to 5 GHz fixed it

Three cameras advertising 1920x1080@30, arrival rate each, with nothing downstream:

| Subscription | Cameras | On 2.4 GHz | On 5 GHz |
|--------------|---------|------------|----------|
| `highest` | 1 | 4.4 fps | **28.0 fps** |
| `highest` | 3 | 0.1–0.7 fps | **24–27 fps** |
| `lowest` (sender proxy, 640x360) | 3 | 30.0 fps | 30.0 fps |

The single-camera figure was the diagnostic one: 4.4 fps while not recording, with the converter
idle at 3.65 ms/frame. Nothing was being asked of the pipeline, so the frames were simply not
arriving.

`GET /throughput?bytes=N` on the control server measures what the link will actually carry, and
comparing paths to the same device at the same moment isolates the radio from everything else:

| Path to the iPad | Throughput |
|---|---|
| USB | 315 Mbps |
| Wi-Fi, 2.4 GHz | 15 Mbps |
| Wi-Fi, 5 GHz | 35 Mbps up (135 Mbps down by Speedtest) |

Fifteen Mbps is about one 1080p stream at 4 fps or three 640x360 proxies at 30 fps — matching the
observed rates exactly, which is what made it the explanation rather than a correlation.

**Two traps worth remembering.** First, a desktop NDI receiver is not a control unless you check
its route: the Mac running OBS had Wi-Fi switched off entirely and was on USB gigabit Ethernet, so
"but the Mac handles three streams" was never evidence about Wi-Fi. Check `route -n get default`.
Second, the ballast endpoint measures the iPad's *upload*; NDI needs download, so treat it as a
lower bound on link quality rather than the figure that matters.

**Correction — the bandwidth story above does not survive the sender settings.** The cameras are
configured to send 6 Mbps each, not the 100+ Mbps a full-bandwidth 1080p NDI sender would use. Three
of them is ~18 Mbps and four is ~24 Mbps, which reconciles with none of the observed rates:

- One camera on 2.4 GHz delivered 4.4 of 30 fps, so ~0.9 Mbps arrived over a link the ballast
  endpoint had just measured at 15 Mbps. A 6 Mbps stream should have run at full rate.
- Three cameras on 5 GHz deliver 24–27 fps, an ~18 Mbps ask against a link measuring 135 Mbps down.

So switching bands did improve matters, but "the link was too narrow to carry the streams" was the
wrong mechanism — the streams were always far inside the measured capacity. Something else is
limiting arrival, and the candidates are link *quality* rather than capacity (loss, retries,
latency), or the receive path itself. Do not cite the 5 GHz table as evidence that bandwidth is
solved. `scripts/ablation.js` is the experiment that separates these.

### Superseded: the encoder is not the constraint — four 1080p archives run fine

*The NDI collapse described below was the archive audio bug, not a decode or capacity limit. Kept
for the reasoning about how to measure an encoder; see the audio section above for the resolution.*

Three 1080p **NDI** cameras recording collapse: tile 1 sustains 25.5 fps encoded while tiles 2 and
3 manage 7.1 and 5.0, dropping 1,245 frames. It is tempting to read that as the encode ceiling. It
is not:

| Test on the same A12X | Result |
|---|---|
| Raw `VTCompressionSession`, sustained | **205 fps of 1080p H.264 — 6.8 streams at 30 fps** |
| Four **synthetic** 1080p sources, 4 archives + program, 4 minutes | **4 × 30 fps, zero drops, thermal `fair`** |
| Three **NDI** 1080p cameras, 3 archives + program | 25.5 / 7.1 / 5.0 fps, 1,245 dropped |

Five concurrent encode sessions at 1080p30 sustained for four minutes with no drops and no thermal
escalation. The 2018 hardware meets the four-camera design target outright; what it cannot do is
meet it *while also decoding full-resolution NDI*.

The raw encoder ceiling was worth measuring properly, and doing it naively is misleading in two
ways. Encoding one unchanging buffer makes every P-frame nearly empty and overstated capacity;
frames must have detail that moves. And with only a few frames in flight the probe measures
callback latency rather than throughput — it reported *more* capacity for expensive content than
cheap content, which cannot be true. With a deep queue and moving content the curve is flat at
~205 fps whether split across 1, 2, 4 or 8 sessions, which is what a fixed-throughput media engine
should look like.

So the NDI collapse is not the chip's encode capacity. Attributing it to "the SpeedHQ decode path"
was a guess and is probably wrong: at 6 Mbps per sender these streams are compressed NDI|HX, whose
payload is H.264 and decodes on the hardware decode engine, not SpeedHQ on the CPU. The more likely
mechanism is that `sinks.pixel?()` is called synchronously on the NDI receive thread, so downstream
back-pressure stalls the receive loop and NDI sheds frames upstream. That is the first place to look
before concluding the device is too slow.

**Two caveats on the numbers above.** The synthetic four-source result used flat-fill frames, which
are close to free to encode — one sweeping bar over a solid colour, so inter-frame prediction finds
almost nothing to code. It says the pipeline is sound but proves little about capacity, and any
headroom claim needs `-syntheticEntropy high` (now the default), which reseeds 4x4 block noise every
frame. The 205 fps raw figure did use per-pixel luma noise so it is sound, though its chroma plane
was flat until this was fixed; expect the corrected figure to be somewhat lower.

Note what this failure looks like either way: **no errors, no encode failures, thermal `fair`.** An
`AVAssetWriterInput` that cannot keep up does not fail, it simply stops being ready.

This is the case D14 exists for, and the ladder now drives it: drops for five consecutive seconds
step the tier down, T1 drops archives to 720p, and the tier is re-applied to writers that are
already running. In a 70-second run it went to T1 at 35 s, the starved camera recovered
(264 → 508 encoded frames while drops nearly stopped), held there for 30 seconds, then stepped to
T2. Stepping and *holding* is the behaviour that matters; see the two bugs below that prevented it.

### Thermals bite quickly on the A12X

Sustained three-camera capture with archive encoding drove the device to
`ProcessInfo.thermalState == .serious` within roughly ten minutes, after which VideoToolbox
refused to create new encode sessions at all (`Cannot Encode`). The degradation controller
correctly moved to tier 1 on its own.

Much of that heat was self-inflicted: the archive was upscaling 640x360 to 1080p. Capping the
archive at the source resolution cut 25 seconds of three-camera recording from ~90 MB to 7.7 MB
and removed most of the encode load.

With that fixed, and with a cooling pad on the device, the runs above stayed at `fair` throughout.
Thermal headroom on this 2018 hardware is still the tightest constraint after the network, and a
bare device left charging will climb back to `serious` on its own.

From 13 August 2026 the same iPad runs on a **Peltier cooler**, which is a stronger assist than
that pad. New `thermal=` samples must say so; do not fold them into the pad-cooled or uncooled
series, and do not take a cool Peltier run as evidence the A12X has thermal headroom in the field.

### Encode session ceiling: at least ten, which is far more than the design needs

On a cool device (`thermalState == .fair`), `EncodeSessionProbe` created **ten concurrent H.264
1080p sessions and got all 300 frames back out** — every session encoded every frame. The design
needs four (three archives plus program), so session count is not a constraint on this hardware
and the earlier `Cannot Encode` failures were never about hitting a limit.

Measure emitted frames, never accepted ones — see the wedge section below.

### The media stack can wedge, and it looks exactly like a bug in our code

After roughly an hour of repeated record/stop cycles on a thermally-stressed device, every encode
began failing with `Cannot Encode [AVFoundationErrorDomain -11883]`, underlying
`kVTVideoEncoderMalfunctionErr (-12912)`, after exactly one frame. It was not our configuration and
not thermal throttling:

- `AssetWriterProbe` ran seven writer configurations — segmented and plain-file, minimal and full
  compression settings, our own buffer pool and the adaptor's, 640x360 and 1920x1080, H.264 and
  HEVC. All seven failed identically on the second frame.
- `EncodeSessionProbe` with `frames=30` showed a raw `VTCompressionSession` **accepting** every
  frame and **emitting zero** compressed buffers, at 240p, 360p, 720p and 1080p alike. A 240p
  encode is not something a throttled A12X refuses.

Accepting frames while emitting nothing is a wedged hardware encoder, and only a reboot clears it.
The lesson for future debugging: `VTCompressionSessionEncodeFrame` returning `noErr` proves
nothing, because it only queues the frame. Always count frames the output handler actually emits —
that distinction is why the first version of the probe reported a healthy encoder while every
recording failed.

**We were most likely wedging it ourselves.** See the audio timebase bug below: until it was
fixed, every archive writer hung in `finishWriting` forever, and each hung writer holds an encode
session that is never released. Three cameras per recording across an afternoon of record/stop
cycles leaks dozens of sessions, which is a plausible route to a wedged `mediaserverd` and matches
the observed timeline — it appeared after prolonged testing, survived cooling, and cleared only on
reboot. Since the fix, flushes complete in ~0.3 s and the wedge has not recurred across a full
suite run plus a ten-session probe.

### The degradation ladder was wired to nothing

Two independent gaps, both invisible until three 1080p cameras made the device work hard enough to
need the ladder:

- **`reportDrops` was never called.** The controller had the logic; nothing counted drops and
  handed them to it. The app therefore sat at tier 0 through 2,600 dropped frames.
- **A tier change did not reach running writers.** The change handler only set a status message, so
  the ladder could escalate T0 → T3 in fifteen seconds while every camera kept writing at the
  settings it started with — degrading nothing, then reporting that everything had been degraded.

The second is the more instructive failure. The ladder appeared to work in the Maestro flow because
that flow pins a tier and asserts the tier is reported, which is true whether or not the tier does
anything. **A test that asserts a control was set does not test that the control is connected.**
The flow now records through a tier change so the writers have to respond.

### Mismatched audio and video timebases hang the muxer indefinitely

The bug that caused the flush stalls, and the most expensive one in the project. NDI stamps audio
buffers with the **wall clock** while video arrives on a media clock. Both writers subtracted the
*video* base from audio timestamps, so audio landed roughly 1.79 billion seconds — 56 years — after
video:

```
tile1 video=20.84s audio=1786472727.67s
```

`AVAssetWriter` accepted every sample without complaint. Only `finishWriting` failed, and it failed
by never returning, because the muxer was asked to interleave a file spanning half a century.

Three lessons worth keeping:

- **A source's audio and video timestamps need not share a timebase.** Both writers now anchor
  audio with its own base, taken from where video is when the first audio sample arrives.
- **A hang in `finishWriting` is usually bad timestamps, not a slow disk or a hot device.** Nothing
  in the failure pointed at audio; it presented as an encoder problem on a thermally-stressed
  device, and was misattributed to thermals for hours.
- **Both clocks must be observable.** `archiveVideoSeconds` and `archiveAudioSeconds` in tile
  telemetry make this class of bug a five-second diagnosis instead of a day.

### Four real cameras, end to end, on the A12X

The full configuration — four 1080p NDI cameras decoded, four HEVC archives, one HEVC program,
segments and DVR index on disk — runs on a 2018 iPad Pro at **11% of eight cores** with **zero
dropped frames**, and the degradation ladder never leaves tier 0. Archives pulled off the device and
decoded confirm the counters: 1920x1080 HEVC at 26.6–30.1 fps per camera. The program file is
1080p HEVC at 24.4 fps, set by the compositor tick rather than by any source.

The fourth camera was not missing hardware. The control channel indexes selections from one, the
sweep scripts indexed from zero, so index 0 was rejected and selection 4 was never enabled — a
camera that had been present the whole time looked like a phantom. Telemetry now carries a
`sources` array naming every selection against the index that enables it, so this cannot recur
silently.

### Full rate on every camera, and how the ingest shortfall turned out to be self-inflicted

A clean run — fresh launch, four cameras enabled once, three minutes recording — captures **29.3 to
29.9 fps on every camera with encode exactly equal to capture, zero drops and zero pool misses**, at
12–17% CPU on tier 0. The archives decode at 30.0 fps on all four. Preview-only on the same session
sits at a flat 30.0 fps per camera. The iPad ingests four 1080p30 NDI streams at full rate.

Every earlier reading that said otherwise was measurement damage, from two causes:

- **Each NDI receiver makes the sender transmit another unicast copy.** The cameras are on 2.4 GHz;
  the iPad and Mac are on 5 GHz off the same AP. With OBS, a diagnostic receiver and the app all
  subscribed, each camera pushed three copies of 6 Mbps through the 2.4 GHz uplink and two of the
  four fell to 16–19 fps — *on both receivers*. Drop to two subscribers and all four return to 30.0.
  A tool that measures NDI arrival by subscribing to it changes the quantity it is measuring.
- **The ablation sweep toggled sources within a single app session**, tearing down and rebuilding
  receivers repeatedly. Its 17–27 fps figures never reproduced on a fresh launch and should not be
  trusted.

The link itself was never close to constrained: the iPad's own throughput endpoint measures
**307 Mbps** to the Mac, against the 24 Mbps four cameras need.

### Distinguishing arrival from loss requires counting before the app touches the frame

`capturedFrames` counts video frames the SDK returned, before any processing, and it consistently
equals `receivedFrames` with `poolMisses` and `formatMisses` at zero — the app has never lost a
frame it was given. Alongside it, `receiveWaitFraction` shows the receive thread spends 64–81% of
its time blocked inside the SDK's capture call and `deliveryMilliseconds` shows 5–6 ms of our work
per frame, about a sixth of the 33 ms budget. Both say the loop is starved rather than overloaded,
which is what pointed at the network instead of at the pipeline.

This mattered because a frame that never reaches the router is invisible to every other counter: it
is not received and it is not dropped, so an arrival shortfall and a self-inflicted loss look
identical from downstream.

### Smooth playback is not evidence of frame rate

OBS looked perfectly smooth on all four cameras at a moment when a bare counting receiver on the
same Mac measured 25.5–29.9 fps. OBS renders its canvas at a fixed rate and repeats the last frame
for any source that falls behind, so 25 fps and 30 fps are visually identical. `tools/ndiRate.c`
exists for this reason: it connects, counts what the SDK returns, and does nothing else.

## Open

### A test file can be added and still not run

Unit tests do run now — 131 cases in the simulator, in about fifteen seconds. Two ways they lied
first, both now closed in `scripts/test-unit.sh`: a new test file is invisible until `xcodegen`
regenerates the project, and the script's own output filter only matched XCTest's format, so a green
Swift Testing run printed nothing and a run of *zero* tests still exited 0. It now regenerates first
and fails when no test case ran.

### `devicectl`-launched runs may still get no camera discovery

An app launched with `xcrun devicectl device process launch` used to find zero cameras while the same
build launched by Maestro found all three, because the local-network permission does not appear to
apply in that launch context. RTSP no longer needs mDNS, but a subnet search needs the same
permission, so the workaround stands until measured otherwise: launch through Maestro, then drive the
running app over the control server. Unverified on the device for the RTSP path.

### Per-camera archive audio works, and the cause was a sample count

Enabling archive audio used to cost the cameras that sent it most of their video: 775, 586 and 55
dropped frames in 75 seconds, against zero for the one camera with audio switched off. That is
fixed and measured. Four cameras, audio on, 75 seconds: **zero dropped frames on every camera**,
11.8% CPU, and the written files show audio and video tracks both 24.0 seconds long with a drift
between −0.06s and −0.26s.

The cause was one argument. `AudioSampleBuilder` passes an interleaved `[Int16]` to
`CMAudioSampleBufferCreateReadyWithPacketDescriptions`, and was giving that array's *element* count
as the sample count. A sample buffer counts frames, and interleaved stereo holds two elements per
frame, so every buffer claimed twice the duration it contained. The audio track then advanced at
roughly twice real time — telemetry measured 210 seconds of audio against 75 seconds of video —
which pushed it far enough from the video timeline that the writer stalled and the video input went
unready. Three earlier notes in this file blamed the cameras' audio clocks for this. They were
wrong; the clocks are fine, and are now accepted rather than rejected on all three cameras.

Two supporting defects, both real:

- An audio buffer arriving while `isReadyForMoreMediaData` was false was **discarded**. The audio
  track then covers less of the timeline than the video track, a segmented writer will not rotate a
  segment until every track reaches the boundary, and the video input goes unready in response — so
  dropping one audio buffer costs all the video after it. Audio is now queued and drained whenever
  the writer will take it, including after every video append.
- Timing counted samples, which assumes no buffer is ever lost; when one is, every later sample
  slides earlier and the track drifts out of sync permanently. Timing now maps the source's own
  clock onto the video timeline by a single offset, with counting kept as a fallback for a source
  whose clock lands more than two seconds from where video actually is.

### Draining the audio queue on a frame-delivery thread stalls video

Queueing audio instead of discarding it fixed the capacity problem and introduced a new one, visible
as quarter-second stutters in the live preview. The drain was called after every video append, and
it was both unbounded and unserialised.

That is worst in `ProgramEncoder`, which takes video from the compositor and audio from every
source's own capture thread, so several threads reach the drain at once — and `append` is called
synchronously from each tile's frame-delivery thread. One thread sitting there working through a
long queue stalls that tile's video, and `AVAssetWriterInput.append` from two threads at once is not
safe to begin with. The result was 123 dropped frames in a minute and the degradation ladder
climbing to T2, switching two cameras' archives off entirely.

The drain now lets only one thread in at a time and takes a budget: two buffers when called from the
video path, eight from the audio callback, unbounded only when finishing. Telemetry updates once per
drain rather than once per buffer, since every update takes another lock on a hot path.

Same load after the fix: no degradation, all four cameras archiving, 25 dropped frames in a minute
against 123, and archives at 28–29 fps with A/V drift between −0.04s and −0.11s.

The general point is worth keeping: work added to a sink's `append` runs on the caller's frame
thread, so it is never free, and a queue drain is exactly the kind of work whose cost is invisible
until the queue is long.

### Superseded: per-camera archive audio was disabled

Archives were recording video only because a camera whose audio arrives in bursts throttled the
writer's video input and cost most of its frames. Reading the audio path again found why, and it was
not the cameras.

An audio buffer arriving while `isReadyForMoreMediaData` was false was **discarded**. That is not
survivable. The audio track then covers less of the timeline than the video track, a segmented
writer will not rotate a segment until every track reaches the boundary, and the video input goes
unready in response — so dropping one audio buffer costs all the video after it. Audio is now queued
and drained whenever the writer will take it, including after every video append and once more
before finishing, so the tail of the track is not thrown away either.

The second problem was the fix applied last time. Counting samples is monotonic, but it assumes no
buffer is ever lost: when one is, every later sample slides earlier and the track drifts out of sync
for the rest of the recording, correcting only in half-second jumps. Timing now comes from the
source's own clock, mapped onto the video timeline by a single offset taken from the first buffer,
which preserves real pacing and puts upstream gaps where they belong. Counting samples remains the
fallback, entered permanently for a source whose clock lands more than two seconds from where video
actually is — both failure modes have been seen on real cameras, and `audioClockRejected` in the
telemetry now says which cameras those are.

`ndi-four-cameras-audio.yaml` runs this against `ndi-four-cameras.yaml` as the control.

### Backgrounding while recording keeps the pipeline running

`handleBackground` used to always finalise the recording, because a suspended app cannot feed the
hardware encoder and this app did not actually play audio — so the `audio` background mode in
`Info.plist` bought nothing. The programme mix now plays through `ProgramAudioPlayer` on the
system's current audio route. While recording (or streaming), that playback continues after the
scene backgrounds, which is what lets iOS keep the process running. Programme output is shown as
a system Picture-in-Picture overlay over other apps.

A preview-only session still lets iOS suspend. If keep-alive is off and a recording were somehow
still open, `prepareForSuspension` still finalises inside a background task assertion so writers
are not frozen mid-flush.

`operator-background-record.yaml` records two synthetic cameras, opens Settings in front of
Director, and checks the control server while backgrounded: `rec`, `aout` and `bgkeep` stay on,
and mix seconds or segments keep advancing. The hovering programme window is the screenshot
artifact `pip-over-settings`.

### Scrub-to-replay latency is now measured rather than assumed

R6 had no number because nothing timed it. The HUD now reports `replayms`, measured from the scrub
gesture ending to the first decoded frame reaching the tile, and `scrub-and-return.yaml` asserts it
is non-zero and under ten seconds.

Measuring it also showed why it would have been slow: assembling up to 64 segment files happened
inline on the main actor, so the UI froze for the duration of the disk work at the exact moment the
operator expected a response. Assembly now runs off the main actor and only starting the decoder
comes back to it.

Measured on the A12X with four cameras live and recording:

| scrub depth | first replayed frame |
|-------------|----------------------|
| 5 seconds   | 259 ms               |
| 15 seconds  | 183 ms               |
| 30 seconds  | 138 ms               |

Deeper scrubs are *faster*, which is worth knowing before optimising the wrong end: a shallow scrub
lands in the segment still being written, while a deep one lands in segments that were closed long
ago.

### Scrubbing only works while recording, and used to hide that

Scrubbing a tile before pressing record looked broken in three separate ways, all from one missing
precondition: the archive and the proxy stills are written by the recording, so before it starts
there is no past to show.

What the operator saw, and where each part came from:

- **The tile paused but never rewound.** `beginScrub` pauses the tile unconditionally, so the drag
  froze it on its last live frame.
- **A still appeared that never changed as the finger moved.** `ProxyReader.still` returned the
  nearest still in the index with no bound on distance, so it found one left behind by an earlier
  recording — and that same one stayed nearest at every offset. It is 640×360, which is why it read
  as a smaller, softer picture than the live 1080p it replaced.
- **Releasing snapped back to live.** The assembler correctly found no segments covering the target
  time, and the failure path returns to live.

Now `beginScrub` refuses when the tile has no history and says so, the drag never starts, and the
still lookup takes a two-second tolerance so a stale frame from a previous session is never shown as
though it were the requested moment. History from a finished recording does not count as scrubbable:
the drag maps backwards from the live edge, so every offset would land in the gap that opens between
the last segment and now.

`scrub-without-history.yaml` covers the refusal; `scrub-and-return.yaml` still covers the working
path.

### The 2.4 GHz camera uplink has room for about two subscribers

Four cameras at 6 Mbps sustain two simultaneous receivers at full rate and degrade at three. That is
enough for production — the iPad plus one monitor — but it is not much margin, and it is a property
of the camera band rather than of any receiver. Moving the cameras to 5 GHz, or accepting a single
subscriber, removes the constraint.

Under RTSP the app is one subscriber, and it must be careful to stay one: a search that probes an
endpoint already streaming, or a reconnect that opens a second session before the first is torn down,
spends a share of that narrow margin. This is the practical reason the discovery changes above matter.

### Camera addresses are not stable, and cannot be made stable at the venue

The cameras take DHCP leases from a Starlink router, which offers no reservations at all, so an
address is a hint about a camera and never an identity. Pinning them would mean putting the Starlink
in bypass mode behind a router that does support reservations — a change to someone else's network,
not something the app can assume. The app therefore treats identity as operator-assigned and durable
while the address is transient; `docs/camera-identity.md` describes the model, and vector H9 is the
case that proves it.

RTSP itself offers nothing better. There is no field in `DESCRIBE`, `OPTIONS`, the SDP, or the RTP
headers that a VM33 populates with a serial number or MAC: `o=` is a session identifier that changes
per session, `s=` is a fixed literal shared by all three cameras, and the RTCP source description
carries only a per-session CNAME. This was searched for specifically before the identity model was
designed, so it does not need searching again.

## The lever that is now available: archive without re-encoding

Per-camera archiving currently decodes each stream and encodes it again, which is most of what the
iPad is asked to do. RTSP hands the app the camera's own H.264 or HEVC bitstream, so a camera's
archive could be written by muxing those access units straight into a file — no decode, no encode, and
a bit-exact copy of what the camera sent. The programme feed still has to be composited and encoded,
because it does not exist on any camera.

This is worth stating as a measured-limits entry because it changes what the thermal ceiling means: if
archiving stops costing encode sessions, the A12X numbers in the NDI series above are pessimistic by
roughly the per-camera encode load. It is not implemented. The work is real but bounded — timestamp
mapping from RTP to the movie timeline, and starting each file on a keyframe — and the scrub path
already reads segments through `SegmentAssembler`, which does not care how they were produced.

Under NDI this required an Advanced SDK licence and a commercial agreement, which is why it was
previously filed under licensing. It now needs nothing but the code.

## NDI: the archive is a re-encode, and the simulator cannot do it

Measured 2026-09-06 on an M4 iPad Air simulator (iOS 26.5) against four 1080p cameras from
`gsNdiCameras` on the same Mac. **Device figures are still outstanding.**

| Condition | Result |
|---|---|
| 4 x 1080p30, preview only | 29.7–30.5 fps per tile, nothing dropped by the SDK, 94% of each receive thread idle, 51% CPU |
| 4 x 1080p30, recording, HEVC | preview falls to 5–7 fps, archives decimate to stride 4, 862% CPU |
| 2 x 1080p30, recording, HEVC (`-sourceEncodeLimit 2`) | the two archiving cameras hold their archives; the two past the cap stay live and archive nothing |
| Archive on disk | HEVC 1920x1080 plus AAC 48 kHz mono, segments 3.37 s |

The recording figures are a **software** encoder: a simulator has no video encode hardware, and
four 1080p HEVC streams saturate the Mac. They say nothing about the iPad and must not be quoted as
capacity. What the simulator does establish is that the transport, the filter, the timing, the
format handling and the archive's shape are right.

The device question this leaves open is the only one that matters for a game: **how many NDI
cameras can an M4 iPad archive at once, at 30 and at 60 fps, in HEVC and in H.264?**
`NDIArchiveBudget.defaultCapacity` is 4 on the strength of the programme master's own measured
figures (118 fps of 1080p H.264 against 296 fps of HEVC), not on a measurement of four
simultaneous source encodes. Until that run happens the number is an estimate.

Three things were found on the way and are worth not rediscovering:

- Converting pixel format on the receive thread ran the fleet at 2.3 fps. `PixelConverter` already
  does that conversion once per frame in hardware; the NDI copy is now format-preserving.
- `TileRouter` wires the compressed sink for every source and leaves it wired, so treating it as a
  request to encode meant four idle preview tiles held four encode sessions. `FrameSource
  .setArchiving(_:)` is the seam that fixed it.
- The generator, not the app, was the bottleneck twice: the kernel's timer coalescing paced a
  declared 30 fps stream at 12, and synchronous sending capped four cameras at 54 of 60.
  `gsNdiCameras --self-test` now fails on either.

