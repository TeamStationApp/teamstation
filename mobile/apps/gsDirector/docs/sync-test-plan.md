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

**Largely landed with NDI (`661ffa0e`), and one claim here was wrong.** An earlier draft named
`SegmentWriter.maximumFrameDuration = 2` as the save-to-disk deadline. It is not: it is a
gap-plausibility threshold — is this a clock glitch or a real dropout — and master is explicit that
there was no disk cap at all. There are now two real caps:

| | Config | Default | Range |
|---|---|---|---|
| **Display latency** | `displayLatencyCapEnabled` / `displayLatencyCapMilliseconds` | 500 ms | 10–2 000 ms |
| **Save-to-disk latency** | `diskLatencyCapEnabled` / `diskLatencyCapMilliseconds` | 10 s | 100 ms–60 s |

`FrameLatencyGate` asks both questions of every source whatever transport carried it, at the two
points where a frame becomes someone's problem: decoded on its way to the screen, coded on its way
to the file. Frames are judged on capture-to-**arrival** age, so the delay line's own hold does not
read as staleness, and a source that cannot say when it captured is always admitted. A picture too
old to show is **held, not blanked**, and still goes to disk — which is the freeze answer and the
two-deadline split, both already shipped. Launch overrides `-displayLatencyCap` / `-diskLatencyCap`
exist so a flow can exercise a cap without dragging a slider.

What is left:

- **Neither slider is in Settings.** Both live on `PerfHarnessView`; `SettingsView` still has no
  latency section. Settings has Instant replay, Content Templates, Remote Control, Camera archives,
  Programme master, Stream, Retention, Storage, Sources and Diagnostics.
- **Both caps ship `enabled = false`**, so out of the box nothing refuses a stale picture and the
  gate is inert. Whether either should default on is an operator decision, not a code detail.
- **Delete the `PlayoutController.Limits.maximumMilliseconds = 2_000` default literal** so
  configuration is the only source of truth for the display ceiling. Still present.

`maximumFrameDuration` keeps its own separate job and should not be conflated with the disk cap:
a gap longer than it is presumed a clock glitch unless capture or arrival time corroborates it
within 0.5 s. Corroborated, the frame is held at true length with silence to match; uncorroborated,
the sample collapses to one frame's duration — the "file runs short" failure R2 exists to prevent.

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

## 3a. What NDI added, and the alignment work it created

NDI landed on master on 2026-09-09 (`d092773`). It settles some of §3 — see C5 and C6 — and it
introduces failure modes that did not exist when this plan was written. The root of all of them is
one sentence from `NDIArchiveBudget`: *an RTSP camera's archive is a copy of bytes that already
arrived, so ten of them cost nothing; an NDI camera's archive is a re-encode.* Encode sessions, not
CPU, are what the app runs out of, and that now applies per camera rather than once for the master.

### C7 — a camera can be recorded and have no archive at all

Past `NDIArchiveBudget` capacity (default 4, sized as four 1080p archives plus the programme
master), a camera previews and cuts to programme but **does not archive**. Its tile says so at the
time. The index does not: no segment rows are written, so at export that camera is
indistinguishable from one that was never selected, and the operator finds out after the game
rather than before it.

Record the intent per source per recording, so an export can say *this angle was not recorded, by
budget* instead of silently omitting it, and warn at record start rather than at export.

### C8 — decimation makes a flat 40 ms tolerance unreachable

A camera inside the cap whose encoder cannot keep up **halves its archive frame rate** rather than
dropping frames at random, and climbs back when it recovers. A continuous 15 fps angle is usable
where the same camera dropping two frames in three is not — the behaviour is right.

But it breaks the acceptance arithmetic. At 15 fps a sample covers 66 ms, so the frame covering an
arbitrary instant `T` can honestly have been captured 66 ms before it, and no amount of correct
placement makes that read within 40 ms. **The file tolerance has to be
`max(40 ms, one frame interval at that segment's actual rate)`**, which means the actual rate has
to be recorded — see C10. Note this is a *sampling* limit, not drift: the frame is where it belongs,
there is simply a coarser grid.

### C9 — two transports, two clock derivations, one take

`21560129` made both live transports always on, because the rig is a mix. So a single recording now
holds segments whose wall clocks were derived two different ways:

- **NDI** stamps every frame with UTC from the sending SDK, roughly microsecond-accurate, and
  `NDIReceiveClock` **applies** a filtered offset (600 s window, sampled 1/s, maximum-of-window
  since transit only shrinks an observation, 3 600 s skew guard).
- **RTSP** reconstructs capture time from RTCP sender reports arriving every few seconds, and
  applies no offset at all — it only reports one.

C1 places both families by `start_wall`. A systematic bias between the families therefore becomes a
systematic offset between angles that no amount of export correctness can fix. This is what turns
C6 from an improvement into a prerequisite: **measure the bias first** (one NDI and one RTSP camera
on the same burned-in clock), then apply the RTSP offset, then measure again.

### C10 — segments do not record how they were made

`segments` carries `source_id`, `sequence`, `start_wall`, `duration` and `is_initialization`.
Nothing says which transport wrote the row, what clock offset was applied to it, or whether the
archive was running decimated. Without that:

- a misplaced angle cannot be attributed to its transport after the fact,
- an export cannot be re-derived when an offset later proves wrong,
- and C8's tolerance cannot be computed, because nothing knows the rate.

Add `transport`, `applied_clock_offset` and `archive_rate` to `segments`. This subsumes C6's
"record the applied value per segment".

### C11 — the freeze now has two possible mechanisms

RTSP archives are a passthrough bitstream copy; NDI archives are encoded by the app
(`sourceEncodeCodec`, HEVC by default because the same hardware sustains 118 fps of 1080p H.264
against 296 fps of HEVC). Manufacturing a held frame is easy where the app owns the encoder and
awkward where it does not.

So C1's open question — where the freeze is made — is now a choice between *one* mechanism at
remux, which treats both transports alike, and *two* at record time, which is cheaper per frame and
has to be written twice. Decide once, for both.

### C12 — a gate refusal is a third kind of hole

`FrameLatencyGate`'s disk cap refuses a frame that arrived too late. Under C1 that refusal becomes a
freeze span in the export, which is correct — but the verifier's "no fill outside the ledger" check
would read it as the system inventing gaps. The fault ledger has to include gate refusals, which
means the gate has to report them per source and per span rather than as a running count.

Both caps currently ship disabled, so this is latent until one is turned on.

### C13 — a declared frame rate mis-times the frames inside a segment

`NDIReceiveClock` steps the timeline at the *measured* rate, using the declaration only until the
estimator's window fills. A Hollyland Cosmo C2 declares 120/1 while sending 60, which once wrote a
3.000 s video track beside a 5.887 s audio track.

Wall-clock placement fixes where a segment *starts*; it says nothing about how frames are spaced
inside it. The first segment of a take from a mis-declaring camera is therefore the exposed case,
because it is the one written while the estimator is still converging.

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
| S24 | More NDI cameras recorded than the encode cap allows | the un-archived angle is named at record start and reported at export, never silently absent |
| S25 | A camera decimated to half rate mid-take | placement still correct; samples within one frame interval at that segment's recorded rate |
| S26 | One NDI and one RTSP camera on the same burned-in clock | cross-transport pair agree ≤ 40 ms at every sample |
| S27 | Every segment row | carries transport, applied clock offset and archive rate |
| S28 | Disk latency cap enabled, one camera held late past it | refused span appears in the ledger; export freezes there; no fill flagged outside the ledger |
| S29 | First segment from a camera declaring the wrong frame rate | video track duration matches audio within 0.5 s; samples ≤ tolerance while the estimator converges |
| S30 | Mixed NDI + RTSP take, every fault at once | ≥ 20 random samples within tolerance across both transports |

Network-shaped, on real hardware (`pi-conditioner`). Latencies are **one-way**; RTT rises by about
double. Caps are given as display / disk and must be set explicitly, since both ship disabled.

| ID | Condition | Pass |
|---|---|---|
| S31 | Pixel +300 ms, caps 500 ms / 10 s | nothing refused; capture-to-display age rises by ~300 ms and no more |
| S32 | Pixel latency stepped 100→900 ms | refusals begin as age crosses the display cap, not before; tile holds its last frame |
| S33 | S32's take exported | the throttled camera's file is full length and wall-clock exact throughout, including across the refused span |
| S34 | Pixel +150 ms with ±100 ms jitter | no display refusals — the gate judges age, not variance; delay line absorbs it |
| S35 | Pixel +700 ms, disk cap lowered to 1 s | display refuses, disk does not; archive frame count keeps climbing |
| S36 | Pixel +1500 ms, disk cap 1 s | both refuse; archive stands still while encode counters keep moving |
| S37 | S36's take exported | the refused span is a freeze at its true wall clock; the file is *not* shortened by it |
| S38 | Pixel capped to 1.5 Mbit | frames arrive late with honest timestamps; counters separate late from lost |
| S39 | Pixel capped to 0.5 Mbit | a genuine archive gap appears; gap filling runs; export holds the last frame across it |
| S40 | Pixel at 2/5/10 % loss over TCP RTSP | loss surfaces as retransmit delay, not missing frames; documented as such |
| S41 | Director shaped +300 ms (Lane B) | NDI and RTSP frames refuse at the same *age*, whatever their transport |
| S42 | Director capped to 20 Mbit (Lane B) | the NDI path starves first; SDK-side drops appear as real gaps, not as lateness |
| S43 | Any shaped phase, unshaped again | counters return to baseline and the tile recovers without a relaunch |
| S44 | Every shaped take | webcam frame read at each phase boundary agrees with what telemetry claimed |
| S45 | Shaping left applied after a killed run | the trap cleared it; `GET /v1/shape` is empty |

## 6. Order of work

1. T1 timecode burn-in — nothing is measurable until this exists.
2. T3 verifier against **today's** export, to capture the failure quantitatively as a baseline.
   Run it over cameras *and* programme, so the programme's drift is a number from the start.
3. C3b programme anchors. Cheap, and every later step is easier to verify with them in place.
4. C1 wall-clock placement on export, then re-run: S1–S4 should flip to passing.
5. C3a programme gap-holding, then S15–S18.
6. C4 duration sanity (small, independent).
7. T2 fault injection, then S5, S6, S9, S11.
8. C10 segment provenance — transport, applied offset, archive rate. Small, and C8's tolerance and
   C9's attribution both depend on it.
9. C9 measure the cross-transport bias, then C6 apply the RTSP offset, then measure again — S23,
   S26. C6 is no longer optional: mixed takes are the normal case.
10. C7 and C8, the encode-budget consequences — S24, S25.
11. C5's remainder: the two Settings sliders and the default-off decision — S21, S22.
12. C12 gate refusals into the ledger, C13 the converging-estimator case — S28, S29.
13. C2 one display latency applied to every tile, then S7, S8 — needs the device, not the
    simulator. The freeze-on-late half of this already shipped with `FrameLatencyGate`.

Steps 1–12 run on a simulator. Step 13 needs the M4, per the device rule in the repo's
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
