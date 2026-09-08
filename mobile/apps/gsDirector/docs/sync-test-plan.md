# Wall-clock sync: requirements, fixes and test plan

Two requirements, from the operator:

- **R1 — live.** While directing, no tile and no programme output is ever behind wall clock by
  more than the **configured display latency**. Each camera is judged against the Director's wall
  clock, corrected for that camera's own clock offset — not against the other cameras. A frame
  that has not arrived by its deadline is not waited for: the last frame is held.
- **R2 — files.** Every exported camera file is wall-clock exact. Play all of them at once and
  nothing is discernibly early or late.

Neither holds today. This document says why, what changes, and how it is proved.

**Operator decisions, 2026-09-08.** A gap freezes the last frame rather than going black; black
appears only at the head of a file, before that camera has delivered anything. The programme does
the same. Both latencies — display and save-to-disk — are configuration with a Settings slider
each, not literals. And cameras are not required to agree with *each other*: each is required to
agree with the Director's wall clock, which makes them agree with each other as a consequence.

---

## 1. Why R2 fails today

A camera's archive is discrete self-contained MP4s, and `segments.start_wall` records the wall
clock of each one — 3,617 anchors for a 109-minute take. The data needed for exact placement is
already there. Export throws it away:

- `SegmentAssembler.mediaFiles` returns `files` and `fileDurations` — an ordered list, no
  timestamps.
- `ArchiveRemux.concatenate` inserts file *i* at a running `cursor`, then advances
  `cursor += duration`.

So a camera that dropped out for 150 s produces a file 150 s **short**, and every frame after the
dropout is 150 s early relative to a camera that did not drop out. Measured on recording 253:
iPhone15 lost 7:28 across 23 archive gaps, Pixel10 lost 2.1 s. Exported that way the two angles
are minutes apart by the end, and neither matches the programme.

`targetDuration` does not save this: it pads the **tail** only, so the file ends at the right
length with every interior event at the wrong time.

There is a second, smaller defect in the same path. `exportRecording` trims every camera to the
*overlap* window (`latestStart … earliestEnd`) to stop the angles disagreeing by ~620 ms at the
head. Wall-clock placement removes the disagreement properly, so the trim can go — and should,
because a common window is what makes every exported file the same length.

## 2. Why R1 fails today

`PlayoutController` decides how far behind its own timestamps a camera must be played to look
smooth, and returns `offsetSeconds`. It is computed **per camera, independently**, and adapts to
that camera's jitter. There is therefore no single instant that "now" refers to on screen: each
tile is presented on its own schedule, and a frame is late against a deadline only that camera
has.

The device's stored camera list shows `playoutMilliseconds` of 399, 486.5 and 500 for three
cameras, which is harmless. A camera that degrades to the 2 s ceiling while another sits at
100 ms is not: each is individually plausible, and the two are 1.9 s apart on screen and in the
programme cut.

The ceiling is not configuration either. `AppConfig` has `displayLatencyCapEnabled` /
`displayLatencyCapMilliseconds` (default 500 ms, clamped 10–2 000), wired at
`AppEnvironment.swift:301` into `registry.playout.setCap`. But the cap **defaults to off**, and
it can only tighten the engine's own sizing, never raise it. With the cap off, the effective
ceiling is `PlayoutController.Limits.maximumMilliseconds = 2_000` — a Swift default-parameter
literal that nothing in the app overrides and no operator can see or change.

What R1 asks for is simpler than what is there: one display latency `D`, configured; every tile
and the compositor show the frame whose corrected capture time is `now − D`; a source with
nothing at that instant holds its last frame. The cameras then agree with each other because they
each agree with the clock, not because anything reconciles them.

---

## 3. Changes

### C1 — wall-clock placement on export (R2)

`SegmentAssembler.Assembly` carries `startWalls: [WallClock]` alongside `files`.
`ArchiveRemux.concatenate` gains a placement mode: insert each file at `startWall − windowStart`
instead of at a running cursor. Real gaps stay gaps — the span is preserved rather than closed up
— because a gap is what actually happened.

**A gap holds the last frame, not black.** Black appears only at the head of a file, before that
camera has delivered its first frame, where there is nothing to hold. Audio is silent through the
gap either way.

This is a harder mechanism than black, and where the freeze is manufactured is the first thing to
settle. An empty composition range is black for free; a freeze needs either the last sample's
duration stretched over the gap (`scaleTimeRange`, which a passthrough export may not honour) or
a real sample written into the archive at gap time. `SegmentWriter` already does the latter for
gaps *inside* a segment — a corroborated long gap is held at its true length with matching
silence, and the code says so: *"The picture freezes for the duration of the hole."* The gaps C1
is concerned with are the ones *between* segment files, where the camera was gone and no sample
exists. Mind the constraint the 2026-09-04 work established: never inject a synthetic IDR, since
a black IDR mid-GOP made 92.6 % of an archive black. A P-skip frame is the safe form.

Every camera in one export uses the **same** window: `recording.startedAt … endedAt`. Identical
length, identical mapping from file position to wall clock, for every angle.

### C2 — one configured display latency, and freeze on late (R1)

The compositor and every tile present against a single display latency `D`, taken from
configuration rather than adapted per camera: the frame shown for a source is the one whose
corrected capture time is nearest `now − D`. A source with no frame at that instant **holds its
last frame** until one arrives. It is never dropped from the composite, and the composite never
waits for it.

Trade-off, stated plainly: the per-camera adaptive offset exists to absorb jitter, and a fixed
`D` gives that up. A camera whose jitter exceeds `D` freezes visibly instead of being smoothed.
That is the cost of every angle being on the same instant, and it is why `D` is configuration and
why its default matters — measured arrival gaps on the rig are 118–270 ms, so 500 ms is
comfortable and 2 s is generous.

Cross-camera agreement is a *consequence* here, not a requirement: every source is placed against
the Director's wall clock, so they land together. `offspread` (max − min of presented capture time
across sources) is therefore a diagnostic that should read near zero, not a target to hit.

### C3 — the programme keeps wall clock too

The programme is not a special case. R1 and R2 both name it, so it gets the same guarantee the
cameras get. Two separate pieces:

**C3a — stop closing up gaps.** `ProgramEncoder.append` advances by exactly one frame when the
compositor stalls or hands over a foreign timestamp:

```swift
if time <= lastTime { time = CMTimeAdd(lastTime, oneFrame) }
```

Real elapsed time is discarded, so the file silently gets shorter than the take. Measured on
recording 253: the programme runs **~95 s behind wall clock by 1:37 into the take**, and that
drift is non-linear — it accumulates wherever a stall happened. The fix is the mechanism the
encoder already has for writer recovery, `fillHold`: when video resumes after a gap, hold the gap
rather than closing it, so the programme timeline tracks real time. **The programme holds its last
composited frame, not black** — the same answer the cameras get. Audio already advances on its own
clock, which is why the audio track is the longer of the two today.

**C3b — record anchors.** `ProgramEncoder` writes one anchor row per movie fragment: fragment
index, byte offset, programme PTS, wall clock. Today the programme has exactly two wall-clock
facts for a 109-minute file (`recordings.started_at` / `ended_at`), which is why its drift was
invisible until it was measured against a camera frame by frame. Anchors make the programme as
re-timeable as the cameras, turn C3a into something a test can assert directly rather than infer,
and leave a recovery path if a future encode drifts anyway.

C3a is the fix; C3b is what proves it and keeps proving it.

### C4 — duration sanity in the remuxer

`playableDuration` trusts a part's declared duration against `maximumSaneDuration = 20_000 s`,
which is far too loose. Recording 253's `-3` stub is 7.2 MB claiming 6,550 s — 8.8 kbps against
8 Mbps of real content — and the app's export turned it into a 128-second second video track
holding a single frame. Reject a declared duration whose implied bitrate is impossible for the
file's size.

### C5 — both latencies become configuration, with a slider each

Two different deadlines exist, and only one of them is exposed:

| | What it decides | Where it lives today | Operator control |
|---|---|---|---|
| **Display latency** | how late a frame may be and still be shown live | `AppConfig.displayLatencyCapEnabled` / `displayLatencyCapMilliseconds`, default 500 ms, **off by default**; ceiling `PlayoutController.Limits.maximumMilliseconds = 2_000` | slider exists, but on the **Perf Harness** screen, not Settings |
| **Save-to-disk latency** | how late a frame may be and still be written to the archive | `SegmentWriter.maximumFrameDuration: Double = 2`, a `private static let` | **none — the slider was never built** |

The two are deliberately different: the recording can afford to wait longer than the monitor,
because nobody is watching the file in real time, and a frame worth discarding for the live cut is
still worth keeping on disk. That is the entire reason there are two numbers, and it is lost while
one of them is a literal with no way to reach it.

- `maximumFrameDuration` moves into `AppConfig` as a persisted, decodable value beside
  `segmentSeconds`, with the clamp-on-decode treatment the display cap already gets.
- Delete the `PlayoutController.Limits.maximumMilliseconds` default literal, so configuration is
  the only source of truth for the display ceiling.
- **Settings gains a Latency section carrying both sliders**, with the display one moved down
  from the Perf Harness screen. Settings today has Instant replay, Content Templates, Remote
  Control, Camera archives, Programme master, Stream, Retention, Storage, Sources and
  Diagnostics — and no latency section at all.

Note what `maximumFrameDuration` actually gates, because it is subtler than a timeout: a gap
longer than it is presumed a *clock glitch* rather than lost frames, unless capture time or
arrival time corroborates it within 0.5 s. Corroborated, the frame is held at its true length and
silence is written to match. Uncorroborated, the sample collapses to one frame's duration — which
is precisely the "file runs short" failure R2 exists to prevent. Raising the value widens the
window in which a real dropout is believed rather than explained away.

### C6 — apply the camera clock offset that is already measured

R1 judges each camera against the Director's wall clock *corrected for that camera's own clock
offset*. That correction is computed and then discarded.

`RTPClockAudit` derives `ntpOffsetSeconds` — the sender's wall clock minus ours — from RTCP sender
reports, along with a filtered version. Both are written into a telemetry snapshot at
`RTSPFrameSource.swift:215-216` and shown on the tile HUD. Tracing every reference to
`cameraClockOffsetSeconds` / `cameraClockOffsetFilteredSeconds` finds only telemetry plumbing:
`FrameSource`, `PipelineTelemetry`, `AppEnvironment`. Nothing consumes them.

The Cameraman phones get away with this because they run their own time sync and stamp sender
reports from capture time, so their offset is small. The NearStream VM33 does not: stock firmware,
no NTP client, and a clock that is whatever it is. Its `captureWallClock` is wrong by an unknown
constant, and C1 would faithfully place its segments at that wrong wall clock — an angle
confidently in the wrong place, which is worse than one that is obviously broken.

Apply the filtered offset to `captureWallClock` at ingest, gate it on a minimum sample count so a
cold start cannot swing the timeline, and record the applied value per segment so an export can be
re-derived if the offset later proves wrong.

---

## 4. Test infrastructure

### T1 — timecode burn-in (the thing that makes this objectively measurable)

Perceptual frame-matching is not a test. The simulated cameras get a machine-readable timecode so
sync is *read*, not *estimated*.

`scripts/fakeRtspCameras.js` renders into every generated frame a block of black/white cells
encoding **milliseconds since the farm epoch**, 32 bits, with a parity cell and a fixed
start marker. One epoch is shared by all four cameras, so the sources are synchronised by
construction and any divergence in an exported file is the app's.

Decoding needs no OCR: crop the block, threshold, read bits. `ffmpeg -ss T -frames:v 1` plus a
small reader gives the wall clock that frame *claims* to be.

Audio gets the same treatment: a 20 ms 1 kHz click at each exact wall-clock second, on every
camera. Click positions in the exported audio give the audio timeline independently of video.

Each camera also gets a distinct static colour patch and a distinct click amplitude, so a test can
prove it is looking at the camera it thinks it is.

### T2 — fault injection

`--scenario` is referenced by `package.json` (`rtsp:farm:self-test`) and
`scripts/testProgramWriterDeath.js`, but the farm's argument parser rejects it — it was never
implemented. Build it, per camera, so cameras fail differently and independently:

| Scenario | What the farm does | What it should exercise |
|---|---|---|
| `drop-frames:N` | discards 1 frame in N | encoder gaps without a reconnect |
| `stall:S@T` | stops sending for S s at T | a real archive gap; `archiveGapSeconds` |
| `disconnect:S@T` | closes TCP at T, accepts again after S | segment discontinuity + camera rebind |
| `late:MS` | adds MS of jitter to send times | playout offset growth, `late=` |
| `clock-jump:S@T` | RTP timestamp jumps ±S at T | `archiveClockRebases`, the re-basing path |
| `bitrate-collapse@T` | drops to ~200 kbps at T | slow camera dragging a shared offset |
| `partial-keyframe@T` | truncates one keyframe | corrupt-frame handling |

Scenarios are declared per camera: `--scenario 1:stall:12@120,2:drop-frames:30,3:clock-jump:5@300`.

### T3 — the sync verifier

`scripts/verifySync.js <dir>` over the exported files:

1. Read the burned-in timecode at **≥20 pseudo-random timestamps** (seeded, so a failure is
   reproducible; reported in the output).
2. For each timestamp *t* and each file: decode the frame's claimed wall clock, compute
   `error = claimed − (windowStart + t)`.
3. Assert every error is within tolerance, and that the **spread across files** at each timestamp
   is within tolerance.
4. Independently, locate the audio clicks nearest *t* in each file and check the same two things.
5. Deliberately sample inside and immediately after each injected fault, not only at random
   points — a random sample can miss a 12 s stall in a 2-hour file.

**Tolerances.** Files (R2): pass ≤ 40 ms (about two frames at 60 fps), warn 40–100 ms, fail
> 100 ms. The existing code already treats 620 ms as unacceptable. Live (R1): no source later than
the configured display latency `D`; `offspread` reported but not asserted as a target, since it is
a consequence of each source matching the clock rather than a thing to tune.

---

## 5. Test vectors

Written as conditions, in the style of `operator-test-vectors.md`.

| ID | Condition | Pass |
|---|---|---|
| S1 | Clean 4-camera record, no faults, export all | every sample ≤ 40 ms; spread ≤ 40 ms |
| S2 | One camera stalls 12 s mid-take | stalled camera's file still wall-clock exact; gap holds the last frame and is silent, not closed up |
| S3 | One camera disconnects 30 s and returns | file length unchanged; post-gap samples ≤ 40 ms |
| S4 | Two cameras stall at different times | neither shifts the other; all pairs ≤ 40 ms |
| S5 | Camera clock jumps +5 s | re-base recorded; wall clock still correct after |
| S6 | Camera clock jumps −5 s | no negative-time samples; monotonic output |
| S7 | Sustained jitter on one camera | it freezes rather than drifting; no other source is disturbed; no source later than `D` |
| S8 | Bitrate collapse on one camera | it freezes and stays in the composite; no other source is delayed |
| S9 | Programme writer killed mid-take | continuation parts remux to one wall-clock-correct file |
| S10 | Export the same recording twice | byte-identical durations; samples agree |
| S11 | Segments deleted under the export | export refuses or reports the hole; never silently shortens |
| S12 | Whole take with every fault at once | ≥ 20 random samples all within tolerance |
| S13 | Audio/video agreement per file | click positions match burned-in video timecode ≤ 40 ms |
| S14 | Export to both MP4 and MOV | both pass identically |
| S15 | Programme file against wall clock, clean take | every sample ≤ 40 ms; programme length == take length |
| S16 | Programme during a compositor stall | gap holds the last composited frame; frames after the stall still ≤ 40 ms |
| S17 | Programme against each camera at the same timestamp | programme matches whichever angle is on air ≤ 40 ms |
| S18 | Programme anchors agree with decoded timecode | every anchor within 40 ms of the frame it names |
| S19 | Gap fill is a freeze, not black | frames decoded through a gap hash-identical to the last frame before it; luma is not ~0 |
| S20 | Camera joins after the window opens | the head of its file is black; its first real frame lands at its true wall clock ≤ 40 ms |
| S21 | Save-to-disk latency set above display latency | a frame later than `D` but inside the disk deadline is absent from the live tile and present in the archive |
| S22 | Both sliders present and effective | Settings shows display and save-to-disk latency; moving each changes the behaviour S21 asserts |
| S23 | Camera with a clock offset (VM33, or an injected constant) | corrected placement ≤ 40 ms; the applied offset is recorded per segment |

## 6. Order of work

1. T1 timecode burn-in — nothing is measurable until this exists.
2. T3 verifier against **today's** export, to capture the failure quantitatively as a baseline.
   Run it over cameras *and* programme, so the programme's drift is a number from the start.
3. C3b programme anchors. Cheap, and every later step is easier to verify with them in place.
4. C1 wall-clock placement on export, then re-run: S1–S4 should flip to passing.
5. C3a programme gap-holding, then S15–S18.
6. C4 duration sanity (small, independent).
7. T2 fault injection, then S5, S6, S9, S11.
8. C5 the two latency values and their sliders — cheap, and S21/S22 depend on it.
9. C6 apply the measured clock offset, then S23.
10. C2 one display latency and freeze-on-late, then S7, S8 — needs the device, not the simulator.

Steps 1–9 run on a simulator. Step 10 needs the M4, per the device rule in the repo's
`AGENTS.md`.

**Standing constraint, 2026-09-08: testing is simulator-only.** No real device is to be touched.
That makes steps 1–9 the whole of the currently executable plan, and step 10 (C2) blocked on
device access being granted later. The simulator can still carry C2's *unit-level* proof — the
frame-selection rule and the hold-on-missing behaviour are ordinary logic — but the acceptance
measurement for S7 and S8 needs the rig.

## 7. Open questions

Answered by the operator on 2026-09-08. The reasoning is kept because it constrains the work:

- ~~**Gaps: black, or freeze?**~~ **Freeze the last frame.** Black only at the very beginning of a
  file, where there is no frame to hold.
- ~~**What does the programme show during a gap?**~~ **The same — a frozen frame.**
- ~~**Does a shared offset regress the single-camera case?**~~ **Moot.** The question assumed C2
  couples the cameras to each other; it does not, since each is placed against the Director's wall
  clock. A single camera still needs freeze-on-late, because wall-clock correctness *within one
  file* is the whole requirement: a take that starts at 3:00 pm with an event at 3:31:30 must show
  that event 31:30 into the file.
- ~~**Is 2 s the right ceiling?**~~ **It is configurable, and there are two of them** — see C5.
  Neither belongs in the code as a literal.

Still open:

- **Where is the freeze manufactured?** Stretching the last sample at remux time, or writing a
  P-skip frame into the archive at gap time. See C1 — this is the first thing to settle, because
  everything about how a gap looks in an export follows from it.
- **What is the shipped default display latency?** The cap's default is 500 ms but the cap is off,
  so today's effective figure is whatever the engine sizes under a 2 s ceiling. Choosing the
  default needs an hour of measured capture-to-display delay, per the original guide's advice.
- **Does C3a change what goes out live?** It must not. Holding a gap is about what is *written*;
  the live composite and the RTMP stream keep going as they do now.
- **Is 40 ms the right file tolerance?** It is ~2 frames at 60 fps. Tighten to one frame if the
  clean case (S1) comes in well under it.
