# Wall-clock sync: requirements, fixes and test plan

Two requirements, from the operator:

- **R1 — live.** While directing, no tile and no programme output is ever behind wall clock by
  more than the accepted playout latency, **2 s**. Cameras may differ from each other only by
  what the network actually cost them.
- **R2 — files.** Every exported camera file is wall-clock exact. Play all of them at once and
  nothing is discernibly early or late.

Neither holds today. This document says why, what changes, and how it is proved.

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
smooth, and returns `offsetSeconds`. It is computed **per camera, independently**, clamped to
`maximumMilliseconds = 2_000`.

Each camera therefore honours the 2 s cap on its own while saying nothing about the others. The
device's stored camera list shows `playoutMilliseconds` of 399, 486.5 and 500 for three cameras;
that spread is harmless. A camera that degrades to the 2 s cap while another sits at 100 ms is
not: both satisfy "within 2 s of wall clock", and they are 1.9 s apart from each other on screen
and in the programme cut.

R1 as written is a statement about the *spread*, not about each camera alone.

---

## 3. Changes

### C1 — wall-clock placement on export (R2)

`SegmentAssembler.Assembly` carries `startWalls: [WallClock]` alongside `files`.
`ArchiveRemux.concatenate` gains a placement mode: insert each file at `startWall − windowStart`
instead of at a running cursor. Real gaps stay gaps — an empty range, which renders black and
silent — because a gap is what actually happened.

Every camera in one export uses the **same** window: `recording.startedAt … endedAt`. Identical
length, identical mapping from file position to wall clock, for every angle.

### C2 — shared playout offset (R1)

The compositor and every tile adopt one programme playout offset:
`min(maximumMilliseconds, max(per-camera offsetSeconds))`.

Trade-off, stated plainly: the worst camera sets the delay for all of them. That is the cost of
angles that cut together. When a camera is so far gone that the shared offset would exceed the
cap, it is the camera that gets dropped from the composite, not the sync that gets abandoned.

New telemetry: per-source `off=`, and `offspread=` (max − min) so a flow can assert on it.

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
encoder already has for writer recovery, `fillHold`: when video resumes after a gap, hold the
gap as black rather than closing it, so the programme timeline tracks real time. Audio already
advances on its own clock, which is why the audio track is the longer of the two today.

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
> 100 ms. The existing code already treats 620 ms as unacceptable. Live (R1): each source within
2,000 ms of wall clock, and `offspread` ≤ 250 ms.

---

## 5. Test vectors

Written as conditions, in the style of `operator-test-vectors.md`.

| ID | Condition | Pass |
|---|---|---|
| S1 | Clean 4-camera record, no faults, export all | every sample ≤ 40 ms; spread ≤ 40 ms |
| S2 | One camera stalls 12 s mid-take | stalled camera's file still wall-clock exact; gap is black/silent, not closed up |
| S3 | One camera disconnects 30 s and returns | file length unchanged; post-gap samples ≤ 40 ms |
| S4 | Two cameras stall at different times | neither shifts the other; all pairs ≤ 40 ms |
| S5 | Camera clock jumps +5 s | re-base recorded; wall clock still correct after |
| S6 | Camera clock jumps −5 s | no negative-time samples; monotonic output |
| S7 | Sustained jitter on one camera | shared offset grows; `offspread` ≤ 250 ms; no source > 2 s |
| S8 | Bitrate collapse on one camera | it is dropped from the composite rather than dragging everyone past 2 s |
| S9 | Programme writer killed mid-take | continuation parts remux to one wall-clock-correct file |
| S10 | Export the same recording twice | byte-identical durations; samples agree |
| S11 | Segments deleted under the export | export refuses or reports the hole; never silently shortens |
| S12 | Whole take with every fault at once | ≥ 20 random samples all within tolerance |
| S13 | Audio/video agreement per file | click positions match burned-in video timecode ≤ 40 ms |
| S14 | Export to both MP4 and MOV | both pass identically |
| S15 | Programme file against wall clock, clean take | every sample ≤ 40 ms; programme length == take length |
| S16 | Programme during a compositor stall | gap held as black; frames after the stall still ≤ 40 ms |
| S17 | Programme against each camera at the same timestamp | programme matches whichever angle is on air ≤ 40 ms |
| S18 | Programme anchors agree with decoded timecode | every anchor within 40 ms of the frame it names |

## 6. Order of work

1. T1 timecode burn-in — nothing is measurable until this exists.
2. T3 verifier against **today's** export, to capture the failure quantitatively as a baseline.
   Run it over cameras *and* programme, so the programme's drift is a number from the start.
3. C3b programme anchors. Cheap, and every later step is easier to verify with them in place.
4. C1 wall-clock placement on export, then re-run: S1–S4 should flip to passing.
5. C3a programme gap-holding, then S15–S18.
6. C4 duration sanity (small, independent).
7. T2 fault injection, then S5, S6, S9, S11.
8. C2 shared offset, then S7, S8 — needs the device, not the simulator.

Steps 1–7 run on a simulator. Step 8 needs the M4, per the device rule in the repo's
`AGENTS.md`.

## 7. Open questions

- **Does a shared offset regress the single-camera case?** A one-camera show gains nothing from
  C2 and pays whatever the shared logic costs. Probably worth special-casing.
- **Gaps: black, or freeze?** Black is honest and is what an empty composition range gives for
  free. A held last frame reads better in an edit. Operator's call.
- **What does the programme show during a gap?** Unlike a camera it always has *some* picture —
  the last composited frame. Holding black is honest and matches the cameras; holding the last
  frame looks less like a fault on air. This is the same question as the camera-gap one and
  should get the same answer.
- **Does C3a change what goes out live?** It must not. Holding a gap is about what is *written*;
  the live composite and the RTMP stream keep going as they do now.
- **Is 40 ms the right file tolerance?** It is ~2 frames at 60 fps. Tighten to one frame if the
  clean case (S1) comes in well under it.
