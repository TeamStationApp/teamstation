# Wall-clock alignment: implementation handoff

Execution plan for making GS Director's recordings and exports wall-clock aligned. Written to be
picked up cold, on a different machine, by someone who was not part of the investigation.

Rationale, test vectors and tolerances live in **`docs/sync-test-plan.md`** (same directory).
This document is the *how*: what to change, in what order, and what will bite you.

---

## 0. Before you start

### 0.1 Get the branch

Work is on **`paul/directorExportDamagedMedia`**, branched from `origin/master` at `09e8723`.
It contains fixes this plan depends on. If it is not on your machine, fetch it:

```bash
git fetch origin paul/directorExportDamagedMedia
git worktree add ~/git-worktrees/gamestation_directorExportDamagedMedia \
  paul/directorExportDamagedMedia
```

Worktree convention: `~/git-worktrees/<repo>_<topicName>`, branch `paul/<topicName>`, based on
`master`. One underscore joins repo to branch; the branch keeps its camelCase. Older worktrees in
this repo use a hyphen and predate the convention — leave them alone.

If that `worktree add` lands in `~/git-worktrees/gamestation` and fails because the path exists,
see trap 9.

### 0.2 Bootstrap — the Xcode project is generated, not committed

```bash
cd mobile/apps/gsDirector
bash scripts/bootstrap.sh          # xcodegen + package resolve; ~1 min
```

Without this, `build-sim.sh` fails with "run 'socket npm run bootstrap' first".

### 0.3 Testing is simulator-only

**Standing constraint, 2026-09-08: do not touch a real device.** Every work item except W8 runs on
a simulator, so this costs almost nothing — but it does mean **W8 is blocked on device access**,
since S7 and S8 are measurements of real cameras over a real network. Build W8's frame-selection
and hold-on-missing logic under unit test if you get that far, and leave the acceptance run for
when the rig is available. The rest of this section still applies for whenever that happens.

### 0.4 Device rule

Per the repo's `AGENTS.md`: **never hard-code a UDID.** Pass
`DIRECTOR_DEVICE_UDID` or `--device <udid>`. Flows must not name a device.

### 0.5 STOP — check retention before you launch the app on any iPad holding footage

Default retention **was 6 hours** and swept the camera archive on app launch. Launching the app
on an iPad with an unrecovered take silently deleted 3,617 segments of a 109-minute game. This
branch changes the default to 250 GB / 100 GB free (§2.1), but **verify the build on the device
has that change before launching it against real footage.** If in doubt, pull the archive first.

---

## 1. The two requirements

- **R1 — live.** No tile and no programme output is behind wall clock by more than the
  **configured display latency**. Each camera is judged against the Director's wall clock,
  corrected for that camera's own clock offset — not against the other cameras. A frame that has
  not arrived by its deadline is not waited for: the last frame is held.
- **R2 — files.** Every exported camera file is wall-clock exact. Play them together and nothing
  is discernibly early or late. Concretely: a take that starts at 3:00 pm with an event at
  3:31:30 shows that event 31:30 into every file, including a single-camera take.

Both are violated today.

**NDI landed on master 2026-09-09 (`d092773`), and this branch is rebased on top of it.** That
closed part of W9 and all of the live-side freeze, changed what W1 and W7 should be built on, and
created new work that did not exist when this plan was written — W11 to W15. Each item below says
what master now covers. The R2 export path is untouched by NDI: `ArchiveRemux` still inserts at a
running cursor, `ExportService` still trims to the overlap, `ProgramEncoder` still clamps to one
frame, and there are still no programme anchors.

**Operator decisions, 2026-09-08, already folded into the work items below.** Gaps freeze the last
frame rather than going black, and black appears only at the head of a file. The programme does
the same. Both latencies — display and save-to-disk — become configuration with a Settings slider
each. Cameras are not required to agree with each other; they are required to agree with the
clock, which makes them agree with each other for free. W8 changed shape as a result, and W9 and
W10 are new.

---

## 2. What is already done on this branch

Do not redo these. Verify they are present, then build on them.

### 2.1 Retention is size-based, not time-based
`AppConfig`: `retentionHours` replaced by `maximumArchiveBytes` (250 GB) and `freeDiskFloorBytes`
(100 GB). `RetentionPolicy.sweep` drops **whole recordings, oldest first**, exempts the live take
via `protecting:`, and reclaims only the camera archive — never the programme master or prepared
exports. Settings has two GB steppers. Three unit tests in `RecordingExportTests.swift`.

### 2.2 Export no longer dies on an unreadable part
`ArchiveRemux.concatenate` skips a part it cannot open instead of throwing, and fails — naming the
files — only if nothing readable remains. This is what made a 5 MB headerless continuation stub
abort the export of a readable 1h46m programme with AVFoundation's damaged-media error.
Regression test present.

### 2.3 A failed finalise is reported
`ProgramEncoder.finish()` now checks `writer.status` after `finishWriting` and records telemetry.
It previously discarded the result, so a programme master that never finalised looked like a
success at stop and only surfaced as damaged media at export, hours later.

### 2.4 `deviceTarget.js` JSON parse fixed
`xcrun devicectl list devices --json-output /dev/stdout` now appends a human-readable table after
the JSON, so `JSON.parse` threw for every device run. Writes to a temp file instead. **On master
this is still broken and `run-maestro.js` fails immediately for any device target.**

### 2.5 A test that deleted every recording on the device
`maestro/flows/recordings-export.yaml` tapped `recordings-select-all` → delete → confirm. It now
marks only row 1 — the take it just recorded — and asserts the list survives.

---

## 3. Work items

Ordered. Each is independently landable.

### W1 — timecode burn-in

Nothing here is measurable until the simulated cameras carry machine-readable time.

**Do not build this from scratch — most of it exists.** `FrameMarker` (on master, in
`DirectorSources`) already paints a value as a strip of black/white cells with a sentinel at each
end, cells sized so inter-frame compression cannot smear a bit, and it ships a reader as well as a
painter. `SyntheticFrameSource`, `FileFrameSource` and `make-fixtures.js` all use it. It encodes a
20-bit **frame ID**, not a wall clock, so the work is widening it or mapping ID to wall clock
through a per-source epoch — not inventing a scheme.

**And `fakeRtspCameras.js` cannot host this as written**: it is a fixture *replayer*, serving a
pre-recorded take from `~/recordings/gsDirector-rtsp-fixtures/20260820-stopwatch`. Live wall clock
cannot be burned into already-encoded fixtures. `mobile/tools/gsNdiCameras` is a real generator that
draws the same picture as `SyntheticFrameSource` — sweeping bar, gradient, stopwatch, frame counter,
FrameMarker strip — precisely so a test can read the marker back out of a decoded archive. Build on
that, and treat giving the RTSP farm a generator mode as part of this item.

- Render into every generated frame a block of black/white cells encoding **milliseconds since a
  single farm epoch**: start marker, 32 data bits, parity. All cameras share one epoch, so the
  sources are synchronised by construction and any divergence in an export is the app's.
- Cell size generous enough to survive HEVC at the test bitrate — start at 16×16 px, top-left,
  with a quiet margin.
- Add a per-camera solid colour patch so a test can prove which angle it is reading.
- Audio: a 20 ms 1 kHz click at each exact wall-clock second, per-camera amplitude.

**Acceptance:** `node scripts/fakeRtspCameras.js --local --self-test` decodes its own burn-in
from a locally captured frame within 1 frame interval.

### W2 — sync verifier (`scripts/verifySync.js`)

Input: a directory of exported files plus the take's `startedAt`.

1. Sample **≥20 seeded-random timestamps** — print the seed so a failure reproduces.
2. Also sample inside and immediately after every injected fault; a random sample will miss a
   12 s stall in a two-hour file.
3. At each timestamp, for each file: `ffmpeg -ss T -frames:v 1` → decode burn-in → `error =
   claimed − (windowStart + T)`.
4. Assert each error within tolerance **and** the spread across files within tolerance.
5. Independently, locate the nearest audio clicks and check the same two things.

**Tolerances:** pass ≤ 40 ms, warn 40–100 ms, fail > 100 ms.

**Run it against today's export first and record the numbers.** That baseline is what proves W3
worked, and it is the only chance to capture the failure quantitatively.

### W3 — wall-clock placement on export (the R2 fix)

The defect: `SegmentAssembler.mediaFiles` (`SegmentAssembler.swift:85`) returns `files` and
`fileDurations` — an ordered list with no timestamps — and `ArchiveRemux.concatenate`
(`ArchiveRemux.swift:47-81`) inserts file *i* at a running `cursor`, advancing by each file's
duration. A camera that dropped out for 150 s exports 150 s **short**, and every frame after the
dropout is 150 s early relative to a camera that did not drop out.

`segments.start_wall` already records the wall clock of every segment — the data is there and is
being discarded.

- Add `startWalls: [WallClock]` to `SegmentAssembler.Assembly` (`SegmentAssembler.swift:21`).
- Give `concatenate` a placement mode: insert each file at `startWall − windowStart` rather than
  at `cursor`, so a real gap keeps its true span instead of being closed up.
- **A gap holds the last frame; it is not black.** Black belongs only at the head of a file,
  before that camera has delivered anything, where there is nothing to hold. Audio is silent
  through the gap either way.
- **Settle the freeze mechanism first — it decides the shape of this work item.** An empty
  composition range is black for free; a freeze is not. Either stretch the last sample's duration
  over the gap (`scaleTimeRange`, which a passthrough export may not honour — check this before
  committing to it) or write a real sample into the archive at gap time. `SegmentWriter` already
  does the latter for gaps *inside* a segment; these are the gaps *between* segment files, where
  the camera was gone and no sample exists. **Never inject a synthetic IDR** — a black IDR mid-GOP
  once made 92.6 % of an archive black. A P-skip frame is the safe form.
- In `ExportService.exportRecording` (`ExportService.swift:90`), give every camera the **same**
  window: `recording.startedAt … endedAt`. Delete the overlap trim at
  `ExportService.swift:118-129` — it exists to paper over a ~620 ms head disagreement that
  wall-clock placement removes properly, and a common window is what makes every exported file
  the same length.

**Acceptance:** S1–S4 in `sync-test-plan.md` pass. A camera with an injected 30 s dropout exports
the same length as one without.

### W4 — programme wall-clock anchors (C3b)

The programme has exactly **two** wall-clock facts for a 109-minute file
(`recordings.started_at` / `ended_at`); the cameras have one per segment. That asymmetry is why
programme drift is invisible.

- New table `program_anchors(recording_id, fragment_index, byte_offset, program_pts, wall)`.
- `ProgramEncoder` writes one row per movie fragment (`movieFragmentInterval` is 3 s,
  `ProgramEncoder.swift:156`).
- Extend `verifySync.js` to check anchors against decoded burn-in.

Do this **before** W5 — it is what makes W5 checkable.

### W5 — programme keeps wall clock (C3a, the fix W4 measures)

`ProgramEncoder.append` (`ProgramEncoder.swift:289`) does:

```swift
if time <= lastTime { time = CMTimeAdd(lastTime, oneFrame) }
```

When the compositor stalls, real elapsed time is discarded — the file silently gets shorter than
the take. Measured on recording 253: the programme ran **~95 s behind wall clock by 1:37** into
the take, non-linearly, accumulating at each stall.

Use the mechanism the encoder already has for writer recovery: `fillHold`
(`ProgramEncoder.swift:712/720`) writes black + silence up to a target. On resume after a gap,
hold the gap instead of closing it — and **hold the last composited frame rather than black**,
which is what `fillHold` writes today. Same answer the cameras get in W3.

**This must not change what goes out live.** It is about what is *written*; the live composite and
the RTMP stream keep going as they do now.

**Acceptance:** S15–S18. Programme file length == take length; samples ≤ 40 ms.

### W6 — duration sanity in the remuxer

**Master fixed the tooling half (`ce1db601`).** `verifyArchives.js` now takes the frame rate from
the video stream's own duration rather than dividing decoded frames by the container's, because a
container reports its longest track — a camera declaring 120 while sending 60 wrote a 3.000 s video
track beside a 5.887 s audio track and was reported as a healthy 59.4 fps. It also calls out a video
track more than half a second from the audio beside it. That check is a better acceptance assertion
than anything this plan had. The app-side fix below is still open.

`playableDuration` (`ArchiveRemux.swift:117`) accepts any declared duration under
`maximumSaneDuration = 20_000 s` (`ArchiveRemux.swift:115`). Recording 253's `-3` stub is 7.2 MB
claiming 6,550 s — 8.8 kbps against 8 Mbps of real content — and the app's export turned it into a
**128-second second video track holding one frame**, which confuses players and NLEs.

Reject a declared duration whose implied bitrate is impossible for the file's size.

**Acceptance:** exporting a recording with a stub part yields exactly one video and one audio
track.

### W7 — fault injection (`--scenario`)

**The NDI farm already has the harder half.** `gsNdiCameras` carries a loopback fault port covering
loss, bursts, stalls, jitter, mid-stream format changes, 4K, unhandled pixel formats, short strides,
zero frame-rate denominators, backwards timestamps, malformed metadata and sender destroy/rename —
plus `ndiFaultRun.js` to sweep them, and a `/clock` endpoint reporting what the generator actually
sent, which is the independent ground truth W2's verifier needs.

`958a37b4` added the one fault this plan most needed and the old RTSP harness could never produce:
`late=<ms>` stamps a frame where it was taken and delivers it behind that. It **ramps** rather than
steps, because subtracting the whole amount at once sends the timestamp backwards and
`NDIReceiveClock` correctly reads a persistent backwards shift as the sender restarting — a 1.5 s
step was absorbed in half a second and the age went back to zero.

`fakeRtspCameras.js` still has neither `--scenario` nor `late=`. Port the vocabulary rather than
inventing a second one.

`--scenario` is referenced by `package.json` (`rtsp:farm:self-test`) and
`scripts/testProgramWriterDeath.js`, but the farm's argument parser **rejects it — it was never
implemented**. Build it, per camera:

| Scenario | Farm behaviour | Exercises |
|---|---|---|
| `drop-frames:N` | discards 1 frame in N | encoder gaps without reconnect |
| `stall:S@T` | stops sending S s at T | real archive gap; `archiveGapSeconds` |
| `disconnect:S@T` | closes TCP at T, accepts after S | segment discontinuity, rebind |
| `late:MS` | MS of send jitter | playout offset growth, `late=` |
| `clock-jump:S@T` | RTP timestamp jumps ±S | `archiveClockRebases` |
| `bitrate-collapse@T` | drops to ~200 kbps | slow camera dragging shared offset |
| `partial-keyframe@T` | truncates one keyframe | corrupt-frame handling |

Syntax: `--scenario 1:stall:12@120,2:drop-frames:30,3:clock-jump:5@300`.

**Acceptance:** S5, S6, S9, S11.

### W8 — one configured display latency, and freeze on late (the R1 fix, device only)

**The freeze half shipped with NDI (`661ffa0e`).** `FrameLatencyGate` refuses a picture too old to
show and the last good frame stays up rather than the tile blanking — that is the operator decision,
already live, on both transports. What did *not* ship is the other half: `PlayoutController` still
computes `offsetSeconds` per camera with `maximumMilliseconds: Double = 2_000` as a default literal.
A staleness ceiling is not a common presentation instant. The item below is now only about applying
one configured `D` to every tile and the compositor; do not rebuild the hold.

`PlayoutController` (`PlayoutController.swift:92`) computes `offsetSeconds` **per camera,
independently**, adapting to that camera's own jitter, under `maximumMilliseconds = 2_000`
(`PlayoutController.swift:42`). So there is no single instant that "now" means on screen: each
tile runs on its own schedule, and a frame is late against a deadline only that camera has.

- Present every tile and the compositor against one display latency `D`, read from configuration
  (W9): show the frame whose corrected capture time is nearest `now − D`.
- A source with nothing to show at that instant **holds its last frame**. It is not dropped from
  the composite, and the composite does not wait for it. This is what makes a single-camera take
  wall-clock exact too, so do not treat it as a multi-camera feature.
- Expose per-source `off=` and `offspread=` (max − min) in the HUD so a flow can assert. Note the
  change in status: `offspread` is now a *diagnostic that should read near zero*, not a target —
  the cameras agree because each agrees with the clock, not because anything reconciles them.
- The trade is real and worth stating in the commit: the adaptive per-camera offset exists to
  absorb jitter, and a fixed `D` gives that up. A camera whose jitter exceeds `D` freezes visibly
  instead of being smoothed. Measured arrival gaps on the rig are 118–270 ms.

**Acceptance:** S7, S8. No source later than `D`; a degraded source freezes and stays in the
composite. **Blocked while testing is simulator-only (§0.3)** — the logic can be unit-tested, the
acceptance measurement cannot.

### W9 — the latency sliders, and whether the caps ship on

**Mostly landed with NDI (`661ffa0e`), and one claim in the original draft was wrong.** That draft
named `SegmentWriter.maximumFrameDuration = 2` as the save-to-disk deadline. It is not — it is a
gap-plausibility threshold, and master states plainly that there was no disk cap at all. There are
now two real caps in `AppConfig`: `displayLatencyCapMilliseconds` (500 ms, 10–2 000) and
`diskLatencyCapMilliseconds` (**10 s**, 100 ms–60 s), read by a transport-agnostic
`FrameLatencyGate`, judged on capture-to-arrival age, with `-displayLatencyCap` /
`-diskLatencyCap` launch overrides so a flow can exercise them.

Three things remain, and they are the whole of this item now:

- **Neither slider is in Settings.** Both sit on `PerfHarnessView`; `SettingsView` still has no
  latency section. Master's commit message says Settings gets a second slider — the diff does not
  touch `SettingsView.swift`. Add the section with both, at 10–2 000 ms and 0.1–60 s, which as that
  commit notes have no useful shared scale.
- **Both caps ship `enabled = false`**, so nothing refuses a stale picture out of the box and the
  gate is inert on a default install. Whether either defaults on is an operator decision.
- **Delete `PlayoutController.Limits.maximumMilliseconds`' default literal** so configuration is the
  only source of truth for the display ceiling. Still present.

`maximumFrameDuration` keeps its own job and should not be folded into the disk cap.

There are two deadlines and only one is reachable. The display one is
`AppConfig.displayLatencyCapEnabled` / `displayLatencyCapMilliseconds` (default 500 ms, clamped
10–2 000), wired at `AppEnvironment.swift:301` into `registry.playout.setCap` — but it **defaults
to off**, and it can only tighten the engine's sizing, never raise it, so with the cap off the
real ceiling is the `PlayoutController.Limits.maximumMilliseconds = 2_000` default literal. The
save-to-disk one is `SegmentWriter.maximumFrameDuration: Double = 2`, a `private static let` with
no config entry, no launch key and no UI.

They are deliberately different values: the recording can wait longer than the monitor, because
nobody watches the file in real time. That is the whole point of having two, and it is lost while
one of them is a literal.

- Move `maximumFrameDuration` into `AppConfig` beside `segmentSeconds`, persisted and decodable,
  with the clamp-on-decode treatment the display cap already has.
- Delete the `Limits.maximumMilliseconds` default literal so config is the only source of truth.
- **Add a Latency section to Settings with both sliders.** The display slider exists but lives in
  `PerfHarnessView` (reached via `.perfHarness` in `DirectorRootView`), not Settings; move or
  mirror it down. Settings currently has Instant replay, Content Templates, Remote Control, Camera
  archives, Programme master, Stream, Retention, Storage, Sources and Diagnostics.

Mind what `maximumFrameDuration` gates — it is subtler than a timeout. A gap longer than it is
presumed a *clock glitch* rather than lost frames, unless capture or arrival time corroborates it
within 0.5 s (`SegmentWriter.swift:436`, `:615`). Corroborated, the frame is held at true length
with silence to match. Uncorroborated, the sample collapses to one frame's duration — the "file
runs short" failure itself. Raising the value widens the window in which a real dropout is
believed.

**Acceptance:** S21, S22.

### W10 — apply the camera clock offset that is already measured

**CORRECTED 2026-09-09: RTSP already applies its offset too, so most of this item was based on a
misreading.** `RTPClockAudit.captureTimeOnLocalClock` returns `cameraWall - filteredOffsetSeconds`;
the telemetry copy in `RTSPFrameSource` going nowhere is what made it look otherwise. Both
transports correct, over a 600 s window, taking the window's maximum. **What was actually missing is
the skew guard, and that is now done**: an offset beyond 3,600 s is declined and the writer falls
back to arrival, which is what keeps a NearStream — no NTP client, powers up believing it is 1970 —
from anchoring its segments decades away. Four tests cover it.

What remains of this item is recording the applied offset per segment, which lives in W11.

**NDI's implementation is still the reference for anything further.** `NDIReceiveClock` measures the sender's
offset over a 600 s rolling window, sampled once a second rather than once a frame (a full window at
1080p60 would be 36 000 samples scanned on the receive thread), keeps the window's **maximum**
because transit only ever makes an observation smaller, guards an unset sender clock with a 3 600 s
skew limit, falls back to arrival time, and then applies it:
`capture = WallClock(seconds: senderSeconds - offset)`. Its own comment notes this is the same
filtering and sign convention the RTSP path uses for its sender-report offset — RTSP computes the
identical quantity and discards it into telemetry.

**This stopped being optional when both transports became always-on.** See W13: a mixed take now has
two families of segments whose wall clocks are derived differently, and only one family is
corrected.

R1 corrects each camera for its own clock offset. That correction is computed and thrown away.
`RTPClockAudit` derives `ntpOffsetSeconds` and a filtered version from RTCP sender reports; both
are written to a telemetry snapshot at `RTSPFrameSource.swift:215-216` and shown on the tile HUD.
Every reference to `cameraClockOffsetSeconds` / `cameraClockOffsetFilteredSeconds` is telemetry
plumbing — `FrameSource`, `PipelineTelemetry`, `AppEnvironment`. Nothing consumes them.

The Cameraman phones survive this because they run their own time sync and stamp sender reports
from capture time. The NearStream VM33 does not — stock firmware, no NTP client — so its
`captureWallClock` is wrong by an unknown constant, and W3 would faithfully place its segments at
that wrong wall clock. An angle confidently in the wrong place is worse than one obviously broken.

- Apply the filtered offset to `captureWallClock` at ingest.
- Gate it on a minimum sample count so a cold start cannot swing the timeline.
- Record the applied offset per segment, so an export can be re-derived if it later proves wrong.

**Acceptance:** S23.

### W11 — record how a segment was made (C7, C10)

`segments` carries `source_id`, `sequence`, `start_wall`, `duration`, `is_initialization` and
nothing else. Three facts are missing and each one blocks something:

- **`transport`** — without it a misplaced angle cannot be attributed to NDI or RTSP after the fact,
  which is the whole of W13's diagnosis.
- **`applied_clock_offset`** — so an export can be re-derived if an offset later proves wrong. W10
  was already going to need this; C10 just widens it to both transports.
- **`archive_rate`** — the rate this segment was actually written at, which W12's tolerance needs.

Separately, record **archive intent per source per recording**. Past `NDIArchiveBudget` capacity
(default 4) a camera previews and cuts to programme but does not archive, and writes no segment rows
at all — so at export it is indistinguishable from a camera that was never selected. Name it at
record start, and report it at export as *not recorded, by budget*.

**Acceptance:** S24, S27.

### W12 — express the file tolerance in frame intervals (C8)

A camera whose encoder falls behind halves its archive frame rate and climbs back. At 15 fps a
sample covers 66 ms, so the frame covering an arbitrary instant can honestly be 66 ms old and a flat
40 ms tolerance can never be met — not because placement drifted but because the grid is coarser.

`verifySync.js` compares against `max(40 ms, one frame interval at that segment's recorded rate)`,
reading the rate from W11. Keep reporting the raw error too, so a real drift is not hidden behind a
generous tolerance.

**Acceptance:** S25.

### W13 — cross-transport clock agreement (C9, and why W10 is now mandatory)

Both live transports are always on, so a normal take mixes them. NDI stamps every frame with UTC
from the sending SDK and applies a filtered offset; RTSP reconstructs capture time from sender
reports every few seconds and applies nothing. W3 places both families by `start_wall`, so a
systematic bias between them becomes a systematic offset between angles that correct export code
cannot fix.

Order matters: **measure the bias first**, with one NDI and one RTSP camera on the same time
reference, and record the number. Then land W10. Then measure again. Without the before number
there is no way to show W10 did anything.

**Acceptance:** S26.

### W14 — decide where the freeze is manufactured, once, for both transports (C11)

RTSP archives are a passthrough bitstream copy; NDI archives are encoded by the app. A held frame is
easy where the app owns the encoder and awkward where it does not. Either manufacture the freeze at
remux — one mechanism, both transports, and the place W3 already touches — or at record time, which
is cheaper per frame and has to be written twice. This blocks W3's gap handling, so decide before
starting it.

**Acceptance:** S19, and S2 for both transports.

### W15 — gate refusals become ledger entries (C12, C13)

`FrameLatencyGate` refusing a late frame leaves a hole that is not a network gap. Under W3 that hole
becomes a freeze span, which is right — but the verifier's "no fill outside the ledger" check reads
it as the system inventing gaps. The gate must report refusals per source and per span, not as a
running count, and the harness must fold them into the fault ledger.

While in there: the first segment of a take from a camera declaring the wrong frame rate is written
while `FrameRateEstimator` is still converging, so its frames can be spaced by a declaration rather
than a measurement. Wall-clock placement fixes where that segment starts, not how its frames sit
inside it.

**Acceptance:** S28, S29.

### W16 — put instant replay on wall-clock placement too (C14)

**Reported from the rig: replay occasionally ends before its requested period.** The cause is C1's
defect on a second path, and W3 as written does not reach it — W3 changes
`ArchiveRemux.concatenate` and `ExportService`, while replay goes through
`SegmentAssembler.assemblePlaylist` and the private `assembly(url:media:)` in the same file.

`assembly()` reports `duration` as **summed media time**, and `AppEnvironment.startReplay` computes
`startOffset = target - assembly.startWall`, a **wall-clock** delta. The two agree only while the
window is contiguous. Put a gap in it and the replay starts too deep into the tape, ends short by
about the gap, and — when the gap is big enough that
`startOffset >= assemblyDuration - 0.25` — is refused outright as not ready.

- Give `Assembly` a wall-clock span alongside its media duration, and stop letting callers mix them.
- Stage segments at `startWall − windowStart`, as W3 does for export, so a gap is held rather than
  closed up.
- `ScrubMapping.shouldStartReplay` compares like with like.
- `maximumSegments: 64` bounds the replay window at roughly 192 s of 3 s segments; confirm it cannot
  itself truncate a long slow-motion rewind on a source with irregular IDR cadence.

Do not re-fix how *played* duration is counted — `01cef5b7` did that, correctly, and it is why the
unit test passes while the rig symptom remains.

**Acceptance:** S46–S52, judged on the webcam.

---

## 3a. Execution status

Updated as work lands on `paul/directorExportDamagedMedia`. Every entry below is on origin, built
for the simulator, and run against the full unit suite — which sits at **587 cases with one
pre-existing failure** (`ReplayHTTPServerTests` "stop releases the port", POSIX 48, present on
master and unrelated to any of this).

| Item | State |
|---|---|
| **W3** wall-clock placement on export | **done** — `ArchiveRemux` places at `startWall − windowStart`; `ExportService` gives every camera the recording's own window and the overlap trim is gone |
| **W16** replay on the same footing | **done** — `Assembly` reports wall span and media duration separately and maps between them by walking segments |
| **W5** programme keeps wall clock | **done** — the timeline advances by real elapsed time instead of one frame, so a stall is held rather than closed up |
| **W6** duration sanity | **done** — a declared duration implying an impossible bitrate for the file's size is refused |
| **W9** latency sliders | **done** — Settings has a Latency section with both caps; saving applies them live |
| **W10** clock offset | **done, and smaller than written** — RTSP already applied its offset; what was missing was NDI's skew guard, now added |
| **W11** segment provenance | **done** — `transport`, `applied_clock_offset`, `archive_rate` on every segment, plus a `recording_sources` table so a camera that never archived is nameable |
| **W1** timecode burn-in | **partly moot** — `FrameMarker` already exists and is drawn by `SyntheticFrameSource`; used directly by the placement proof below |
| W2 verifier, W4 anchors, W7 fault injection, W8 shared display latency, W12 tolerance, W13 cross-transport, W14 freeze mechanism, W15 gate ledger | not started |

### What is proven, and how

`WallClockPlacementTests` is the acceptance evidence for W3, and it is not bookkeeping: two real
MP4s are encoded with a `FrameMarker` painted into every frame, indexed thirteen seconds apart with
three seconds of tape in each, remuxed, and decoded back. Reading the marker out of the exported
picture says which frame is actually at a given moment of the file — the one check a correct-looking
index cannot fake.

It also covers the pair case directly: one camera that lost the middle and one that joined late
export to the same length and, at the same instant, each shows the frame it captured then.

### Deliberately not done

`PlayoutController.Limits.maximumMilliseconds` still holds its 2 000 ms default. The plan called for
deleting it so configuration is the only source of truth, but that literal bounds how much delay the
delay line *adds* to smooth jitter, which is a different quantity from how old a picture may be —
the distinction master drew when it added `FrameLatencyGate`. Removing it would change the delay
line's behaviour to fix a naming confusion. Left alone, and documented here instead.

## 4. Running things

```bash
cd mobile/apps/gsDirector

# build
DIRECTOR_SIMULATOR_UDID=<sim-udid> ./scripts/build-sim.sh
DIRECTOR_DEVICE_UDID=<ipad-udid>  ./scripts/build-device.sh   # also installs + launches

# unit tests
DIRECTOR_SIMULATOR_UDID=<sim-udid> ./scripts/test-unit.sh

# maestro
DIRECTOR_DEVICE_UDID=<udid> node scripts/run-maestro.js --device <udid> <flow>
DIRECTOR_DEVICE_UDID=<udid> node scripts/run-maestro.js --device <udid> --suite operator
```

**Two unit tests fail on this branch and did so before any of this work**: "Instant replay plays
the requested content duration across file boundaries" (timing threshold) and "stop releases the
port so the next replay can bind it immediately" (POSIX 48, address in use). Neither touches the
code here. Do not chase them; do not let them mask a new failure — compare counts, not just
pass/fail.

---

## 5. Traps

Hard-won. Each of these cost real time.

1. **`run-maestro.js` auto-passes `--app-file`** when a device build exists, so every run tries to
   reinstall. A failed install leaves a **stuck install coordinator** (`IXErrorDomain Code=48`,
   "Coordinator … was process-scoped"), after which the app will not launch
   ("outstanding termination assertions", `FBSOpenApplicationErrorDomain Code=6`).
   *Workaround:* invoke the runner directly without `--app-file` when the app is already
   installed:
   ```bash
   ~/.maestro-runner/bin/maestro-runner --platform ios --device <udid> --team-id G5LQ7MERPK \
     --driver-start-timeout 180 --shutdown-after=false --artifacts always \
     --output <dir> test maestro/flows/<flow>.yaml
   ```
   To clear a stuck app: retry `xcrun devicectl device process launch --device <udid>
   --terminate-existing co.gamestation.director` a few times, ~20 s apart. **Never uninstall** —
   that deletes the container and every recording in it.

2. **The RTSP farm cannot reach the iPad without root.** `--local` binds `127.0.0.1` on ports
   18554-18557; anything else binds `:554`, which needs `sudo`. For device runs either run the
   farm under sudo or **add a bind-host option for the high-port mode** — the latter is probably
   worth doing as part of W7.

3. **`sourceProfile: synthetic4` needs no farm and no `clearState`**, and is the cheapest way to
   exercise record→stop→export. Use it for anything not specifically about RTSP.

4. **`clearState: true` wipes the camera list, layout and programme-source prefs** (not
   recordings). Avoid it on Paul's configured iPad. `archive-timeline.yaml` is the model for a
   no-clearState flow.

5. **Some archive segments cannot be read over AFC** — `FILE_OPEN` fails with status 1 while
   `stat` returns a correct size, consistently, across reconnects. Looks like a data-protection
   class. ~2.5% of segments on the take examined. Pull with the app's own export, not AFC, when
   completeness matters.

6. **`devicectl device info files` hangs** on this pairing. Use `pymobiledevice3` house-arrest AFC
   instead (~25 MB/s):
   ```python
   ha = await HouseArrestService.create(lockdown=ld, bundle_id="co.gamestation.director")
   await ha.get_file_contents("Documents/Program/…")
   ```

7. **`ffprobe` reports nonsense container durations for programme masters** — 24,837 s for a
   6.7-minute file. Trust a decode, not the header.

8. **Programme masters are fragmented MP4 with ~1.2 MB `moof` boxes and `mdat`s up to 2.1 GB.**
   A scan that filters for small `moof` sizes will wrongly conclude the file stops being indexed
   early. A correctly finalised programme file is `ftyp/mdat/moov` with a full sample table at the
   end — *no* fragments. A trailing `wide` + `mdat` with size field 0 means `finishWriting` never
   completed.

9. **`~/bin/git` rewrites every `git worktree add` destination**, and it drops the branch suffix:
   `git-layout-rewrite.js` computes `path.join(WORKTREE_ROOT, repoName)`, so every worktree is
   aimed at `~/git-worktrees/gamestation` regardless of what you asked for. That path is already
   an unrelated worktree, so the add fails with *"already exists"*. The shim honours a
   `GIT_LAYOUT_BYPASS` environment variable; setting it produces the path the layout convention
   actually asks for. Fixing the shim to build `<repo>_<branch>` is the better answer and is not
   this branch's job.

---

## 5a. Network-shaped device testing

Added 2026-09-09, when the `pi-conditioner` became available. **This supersedes §0.3's
simulator-only constraint for the iPad and the Pixel 10 only.** Everything else in §0.3 stands, and
two devices stay untouched — see the roles table.

This lane is what finally makes the R1/R2 corner cases reachable on real hardware. The old RTSP
harness could hold frames on the sender, which keeps RTP timestamps continuous and so exercises
lateness but *never* a gap. A bandwidth cap on the real link does produce genuine loss, which means
**gap filling becomes testable for the first time.**

### Device roles — read before shaping anything

```
        wall clock  ← the single time reference, in shot for everything
           ↑   ↑
   iPhone 15 Pro  Pixel 10
      │ HDMI        │ RTSP over Wi-Fi (shapeable)
      ▼             │
   Cosmo C2 ────────┴──→  Director (iPad)
      wired to the AP          │
                               ▼
                    webcam sees all four at once:
                 wall clock, iPhone, Pixel, Director screen
```

| Device | Role | Shape it? |
|---|---|---|
| **Pixel 10** | GS Cameraman, RTSP, pointed at the wall clock | **Yes — the primary subject.** `10.10.7.226`, verified. |
| **iPad (Director)** | the app under test | **Lane B.** Its Wi-Fi is the *only* thing that can delay the Cosmo, so this is not a workaround — it is the real production failure mode. Confirm its IP first. |
| **Cosmo C2** | NDI camera, capturing the iPhone over HDMI | **No, and no need.** Wired to the access point, so its traffic never crosses the Pi. In the production deployment this link is not the risk. |
| **iPhone 15 Pro** | draws the picture the Cosmo captures, pointed at the wall clock | **No. Never.** Its network path is irrelevant — it only sends HDMI. Shaping it would corrupt the reference, not test anything. |

**Both camera chains see the same wall clock.** The iPhone films it and feeds the Cosmo over HDMI;
the Pixel films it directly. So the two transports carry a common image, and any difference between
them in an export is the app's — which is what makes the C9 cross-transport measurement possible at
all, with no burned-in timecode needed on the device lane.

The realistic NDI risk is therefore **the Director's own Wi-Fi**, a 5 GHz link at under thirty feet.
Lane B is how that gets exercised.

### Two lanes — and MEASURED 2026-09-09, they are not mutually exclusive here

The skill warns that traffic between two devices both on `spjr-outside` may be bridged inside the
Wi-Fi firmware and not reliably shapeable, and advises keeping Director on the UniFi AP. **On this
rig that caveat does not bite, and it was verified rather than assumed.** Both the Pixel and the
iPad are on `spjr-outside`, and with the Pixel capped at 1.5 Mbit an RTSP pull fell from
**4.21 Mbit/s to 2.04 Mbit/s**. The shaper sees the traffic and the cap takes effect.

So both lanes are available without moving any device between SSIDs:

- **Lane A — per-camera (default).** Shape the Pixel. Isolates one RTSP camera while the rest stay
  clean, which is what makes "this angle degraded and the others did not" falsifiable.
- **Lane B — whole-Director.** Shape the iPad. The **only** way to reach the NDI path, since the
  Cosmo is wired to the AP — and the production-realistic failure, because the Director's own Wi-Fi
  is the one link that can delay it. Blunt by nature: it hits every camera and the control channel
  together, so keep latencies modest and expect telemetry polls to slow with everything else.

Re-verify the cap before trusting any run. Both devices randomise MAC per SSID and the Pixel is
documented to roam back to the main SPJR SSID, so a lane that worked yesterday can be silently inert
today.

### Known IPs, and one device that cannot be shaped at all

MEASURED 2026-09-09 from `GET /v1/devices` plus reverse DNS:

| Station | IP | Identified by | Shapeable |
|---|---|---|---|
| `d6:97:e1:ca:aa:25` | `10.10.7.226` | reverse DNS `Pixel-10.vtex.net`; RTSP open on 8554 | **yes, verified** |
| `92:e1:43:95:7a:46` | `10.10.7.128` | no reverse DNS, no open port — **unconfirmed** | yes, once identified |
| `36:17:82:3b:fd:8e` | **none** | — | **no — it holds no IP lease** |

**Confirm which station is the iPad before shaping anything in Lane B.** The iPhone 15 Pro must
never be shaped, and an unidentified station is not a safe thing to guess at. Note also that a
station with no lease cannot be shaped at all; if that turns out to be the iPad, Lane B is blocked
until it gets one.

### The webcam is the primary instrument, not a check box

One frame from the bench webcam contains the wall clock, the iPhone's screen, the Pixel's screen and
the Director's display. That single frame answers, without any telemetry at all:

- what time it really is,
- what each camera was showing at that instant,
- and what the Director was displaying — so **per-transport end-to-end latency is a subtraction
  between two numbers in the same photograph.**

Read it, do not merely capture it. On 2026-09-05 an entire acceptance run was reported from
`dump-state` alone while the Director screen had been black for three and a half minutes. Standing
rule, and here it is also the cheapest measurement available: capture and *read* a frame at every
phase boundary, and at replay entry and exit.

For replay specifically the webcam is the only honest judge of speed and duration: the programme
tile shows the replay overlay with the clock reading behind the live tiles by the rewind depth, and
a 50 % replay closes that gap at half rate. Reading the clock in the frame is the measurement.

### Preflight, every run

1. `GET /v1/health` — `treeIntact` must be true. If the API does not answer at all, see the
   `brcmfmac` oops in the skill: the box needs a hardware power cycle and the watchdog may not fire.
2. `GET /v1/devices` — the device under test must appear **with an IP**. One of the three associated
   on 2026-09-09 had `ip: null` and cannot be shaped at all.
3. **Forget the main SPJR SSID on the Pixel** for the duration, or disable auto-join. A Pixel 10
   logged 34 associations and 57 disassociations in half an hour on 2026-09-09 by roaming back.
4. Confirm the branch build's retention is size-based before launching on an iPad holding footage
   (§0.5).
5. Apply the shape, then **verify it took** with `GET /v1/stats` — near-zero bytes on that device's
   class while traffic is clearly flowing means it is on the wrong SSID or both ends are on
   `spjr-outside`.
   **Read the right class.** The shape response returns `"slot": N`, and slot *N* is class
   **`1:N`** — slot 1 is `1:1`. Class `1:11` also exists, is unrelated, and sits at 0 bytes
   forever; reading it instead produced a confident and completely wrong conclusion that shaping was
   inert on 2026-09-09. Cross-check against
   `ssh root@pi1.vtex.net 'iw dev wlan0 station dump'`, whose per-station byte counters are
   independent of the tc tree, and prefer a throughput measurement over any counter.
6. **Arm cleanup before the first shape.** Shapes have no TTL and survive a dead test run:
   `trap 'curl -sk -X DELETE https://pi1.vtex.net/v1/shape' EXIT INT TERM`.

`latencyMs` is **one-way**; RTT rises by about twice it, and the response echoes
`expectedRttDeltaMs`. Every figure below is the one-way value to send.

### Lower the cap rather than raising the latency

The disk cap defaults to 10 s. Reaching that with real latency would need `latencyMs > 10000`, which
collapses RTSP over TCP into retransmit timeouts and measures the transport rather than the gate.
Master's own device measurement took the other route — *"with the disk cap at 1 s instead, both
refused and the archive stood still"* — and that is the pattern to follow: set
`-diskLatencyCap 1000` and apply ~1.5 s. Both caps also ship **disabled**, so every phase here must
launch with `-displayLatencyCap` / `-diskLatencyCap` set explicitly or nothing will refuse anything.

### Phases

Each phase: apply the shape, hold 90 s while recording, **capture and read a webcam frame at every
phase boundary** (non-negotiable — see `webcam-capture` and the 2026-09-05 run where every device
claim came from `dump-state` and the screen was black), sample `dump-state` every 10 s, then stop,
export, and run the verifier. Record `refused`/`late` counters per source per phase.

| # | Lane | Shape | Caps | What it proves |
|---|---|---|---|---|
| **P0** | A | none | 500 ms / 10 s | Baseline: capture-to-display age, export spread, and that `/v1/stats` sees the traffic at all. |
| **P1** | A | Pixel `latencyMs: 300` | 500 ms / 10 s | Nothing refuses. Establishes headroom below the display cap. |
| **P2** | A | Pixel latency stepped 100→900 ms, 60 s each | 500 ms / 10 s | **Paul's first case.** Refusals begin as age crosses the display cap; the Pixel tile freezes on its last good frame while its archive stays unbroken and full length. |
| **P3** | A | Pixel `latencyMs: 150, jitterMs: 100` | 500 ms / 10 s | Jitter alone does not trip a gate that judges *age*; the delay line absorbs it. Distinguishes jitter from staleness. |
| **P4** | A | Pixel `latencyMs: 700` | 500 ms / **1 s** | Below the lowered disk cap: display refuses, disk still keeps everything. |
| **P5** | A | Pixel `latencyMs: 1500` | 500 ms / **1 s** | **Paul's second case.** Both refuse; the archive stands still while encodes continue — which is what tells this apart from an archive that stopped for its own reasons. |
| **P6** | A | Pixel `mbit: 1.5` | 500 ms / 10 s | Starvation below encode bitrate: the camera's own queue backs up, frames arrive late with honest timestamps. Separate "late" from "lost" in the counters. |
| **P7** | A | Pixel `mbit: 0.5` | 500 ms / 10 s | Severe starvation → **genuine delivery loss → a real archive gap.** The first test that can exercise gap filling and the freeze at all. |
| **P8** | A | Pixel `lossPct: 2, 5, 10` | 500 ms / 10 s | RTSP is hard-coded to TCP, so loss should surface as retransmit delay rather than missing frames. Confirm that, and record it — it is why `lossPct` is a weak instrument here. |
| **P9** | B | iPad `latencyMs: 300` | 500 ms / 10 s | Both transports degrade together. Do NDI and RTSP frames refuse at the same *age*? They should — `FrameLatencyGate` is transport-agnostic. |
| **P10** | B | iPad `mbit: 20` | 500 ms / 10 s | 1080p NDI is bandwidth-hungry; expect the NDI path to starve first and the SDK to drop frames the receiver never sees. Real gaps on the NDI archive. |
| **P11** | A | none | 500 ms / 10 s | **The W13 measurement.** Both chains already film the same wall clock, so this is a webcam frame plus an export comparison. The cross-transport bias number, and it must be taken before W10 lands. |
| **P12** | A | none | 500 ms / 10 s | Replay baseline: 10 s at full speed, then 10 s at 50 %, webcam at entry and exit. Establishes correct speed and duration with no gap in the window. |
| **P13** | A | Pixel `mbit: 0.5` for 20 s, then clear | 500 ms / 10 s | **The replay truncation case.** Rewind across the gap the starvation left. Today this is expected to end early or be refused; after W16 it must play the full period, holding through the gap. Capture the before number. |
| **P14** | B | iPad `latencyMs: 300` | 500 ms / 10 s | Replay on the NDI source while the Director's own link is degraded — the production-realistic NDI failure, since the Cosmo's wired hop is not the risk. |

**Every phase ends with an export and a verifier run.** That is Paul's third requirement and the
only one that cannot be judged from telemetry: whatever the network did, each exported file must
still put each event at its true wall clock, and P5's and P7's refused spans must appear as freezes
at the right instants rather than as a shortened file.

### What this lane cannot do

- **Shape the Cosmo C2 directly.** Only Lane B, and only alongside everything else.
- **Produce a clean NDI-only degradation.** Lane B always hits RTSP too.
- **Reach the 10 s disk cap with real latency.** Lower the cap instead.
- **Isolate two cameras differently in one run** if both must be shaped — they would both need to be
  on `spjr-outside`, where the bridging caveat applies. Shape one, keep the rest clean.

### Order of execution

P0, P11 and P12 first, unshaped: they are the baselines, and P11's cross-transport number is a one-time
opportunity that disappears once W10 lands. Then P1–P3 (display band), P4–P5 (disk band), P6–P8
(bandwidth and loss), P13 for the replay truncation, and Lane B's P9–P10 and P14 last, since re-joining the iPad to a different SSID is the
most disruptive step and the easiest to leave in a bad state.

## 6. Done means

- `verifySync.js` passes S1–S30 at the W12 tolerance on a take with every fault injected at once.
- The network-shaped phases S31–S45 pass on real hardware, and every shaped take exports on the
  correct timeline — including the spans the latency gates refused.
- Instant replay S46–S52: a rewind across a gap plays its full requested period at the requested
  speed, read off the webcam, rather than ending early or being refused.
- A camera with a 30 s dropout exports the same length as one without.
- A gap decodes as a held frame, not black; black appears only before a camera's first frame.
- Programme file length equals take length.
- Settings carries a display latency slider and a save-to-disk latency slider, and moving each
  changes what the archive and the monitor keep.
- Exported MP4 and MOV both pass identically.
- Unit test count went up and the only failures are the two known ones.
- `--suite operator` still passes.

## NDI stutter on a healthy link: the Cosmo stamps frames in pairs (2026-09-10)

With the iPad rebooted and the link above 100 Mbps, the NDI tile still stuttered while the Pixel
beside it was smooth. Telemetry ruled out the network and the buffer: both tiles held ~29 frames
(496 ms) with zero late frames, yet NDI released in 104 ms clumps against the Pixel's 37 ms.

Measured on the Mac with `gsNdiCameras --receive` (now prints quartiles; `GS_NDI_GAPS_OUT=<file>`
dumps every gap): the Cosmo C2 paces an exact 60.00 fps by its own span, drops nothing, but stamps
consecutive frames **5 ms then 30 ms apart** (p25 5.5 ms, p75 30.2 ms, mean 16.67 ms). Released at
stamp + fixed delay, each pair lands inside one 60 Hz refresh: one frame is never shown and the
other is held twice — 30 fps judder. The same skew put the *median* interval in the short cluster,
so `FrameRateEstimator` read 70–80 fps, which also stepped the NDI archive timeline ~15% fast.

Fixes:

- `CaptureTimelineSmoother` (DirectorSources): predict one period after the last frame, move 5%
  toward the stamp; reseat on a jump > 250 ms. NDI schedules on its output instead of raw stamps.
- `FrameRateEstimator`: when the interquartile spread exceeds 25% of the median, take the window's
  mean interval (span ÷ count) instead of the median. Clean RTP clocks with drops keep the median.
- Tile readout: "60 FPS" and "7 MB" (megabytes/s) to the left of the loss count. RTSP counts its
  own socket; NDI's socket belongs to the SDK, so a lone NDI tile shows Wi-Fi total less the RTSP
  tiles' counts, and a dash when two NDI tiles would have to split it.

### Cosmo C2 lockup, and NDI outside capture alignment (2026-09-10, afternoon)

- At 13:11:08 the Cosmo C2 stopped answering on everything: NDI 5960/5961 and its web page on
  port 80, from the Mac as well as the Director, with no shaping active. Its mDNS record lingered.
  A power cycle recovered it (firmware V1.0.4.8, the newest published), and the Director
  reconnected with no help, smooth beside the Pixel. No public report of this failure was found;
  Hollyland's notes say only "Optimize the system". This is the third C2 outage on this bench.
- Reading the bench wall clock against both tiles over three frames after recovery: NDI chain
  627–657 ms, Pixel chain 573–590 ms, both on the 500 ms delay. Before the lockup the two tiles
  were within 10 ms; the recovered Cosmo is ~50 ms slower glass-to-glass.
- The Director cannot see that: `captureSpreadMilliseconds` covers RTSP cameras only, and an NDI
  tile publishes no clock offset or corrected capture time. NDI's stamp is when the Cosmo encoded
  the picture, not when the iPhone captured it, so aligning NDI against RTSP needs either
  calibration against a clock in shot or a per-camera latency setting.
- `FrameRateEstimator`'s scattered-stamp mean now runs over 3,600 intervals (~60 s). Over 120 it
  flipped between 59.94 and 60, which steps the NDI archive timeline 3.6 s an hour apart.

### Export accuracy on the device, rec-320 (2026-09-10, 14:14)

A 114.7 s take with the Pixel on RTSP and the Cosmo on NDI, a 15 s Pixel outage (conditioner, 100%
loss), a 5 s slow-mo and a 10 s full-speed rewind, then an export. Driver
`/tmp/gs-shots/exportsync.sh`; clocks read with AVFoundation (`frameat` + tesseract).

- **Lengths:** every file, container, video and audio track within 40 ms of the take.
- **Gap:** the Pixel outage fell inside one 16.9 s segment; the export freezes the frame before it
  (14:14:52.532) until the camera returns, as decided. ffmpeg shows the take's *first* frame there
  instead: it mishandles the composition's edit lists. **Judge exports with AVFoundation, never
  ffmpeg frame seeks** — ffmpeg also read every clock ~50 ms off.
- **Bench clock:** the UniFi watermark ticks over when the bench clock reads N−0.65 s, so the bench
  runs ~0.65 s slow of true time. Subtract that before judging absolute placement.
- **Pixel file:** clock − position steady at −810…−829 ms (≈ −170 ms against true time).
- **NDI file:** wanders −800…−987 ms within seconds, inside segments as well as between them; the
  Cosmo's HDMI/wireless chain delivers content with irregular latency. Segment starts also jittered
  ±90 ms from raw stamps — now taken from the smoothed capture timeline.
- **Programme:** ~0.55 s behind the camera it shows — anchored on composition time, which includes
  the 500 ms display hold. Now anchored on the on-air frame's capture time.
- **Programme lip sync:** its audio is 306 ms later than the Pixel file's audio, its picture ~630 ms
  later than the Pixel file's picture: sound leads picture by ~0.3 s inside the programme. Open.
- **NDI audio** is silent: the iPhone's camera screen sends no microphone audio over HDMI.
- **Rewinds:** Pixel 5 s @ 50% played 10.41 s (correct). NDI 10 s full played ~9.5 s — the 0.5 s
  "finished" tolerance. NDI 5 s @ 50% measured 7.71 s, but the poller stops at the continuation's
  state change, so that figure is unproven either way.

### Clapperboard sync on the exported files, rec-323 (2026-09-10, 15:17–15:31)

The Big Time clock app on the Pixel 2 now plays a clap and flashes grey every 5–10 s, logging the
sound's output time and the flash's display time (`claps.csv` in its external files dir; flash and
sound within 1–11 ms of each other). The Pixel 2's own clock runs **688 ms behind** the Mac (which
is within 4 ms of time.apple.com) — that is the "bench clock 0.65 s slow" seen all day. Analysis
tools: `/tmp/gs-shots/avsync/avsync` (AVFoundation per-frame luma and audio peaks) and `pair.py`.

Measured on the final exported files, which were stitched across real breaks (two Pixel dropouts
inside segments at 246 s and 262 s; NDI gaps of 0.82, 0.35 and 9.04 s):

- **Pixel file, sound vs picture:** median +56 ms (sound late), drifting linearly at **129 ms per
  1,000 s** from −39 ms at the start of the take (residual sd 10 ms). Cause: each 3 s segment
  re-anchored its audio to the video position when its first audio buffer was written — i.e. to
  arrival — and the Pixel's audio arrives steadily later relative to its picture. Fixed by one
  audio-to-wall anchor per recording (`ArchiveAudioTimeline.WallAnchor`).
- **Programme audio does not drift** (−20 ms per 1,000 s, within noise): the live mix schedules
  audio by its own timestamps. It lands ~100 ms after true time.
- **Placement against true time:** Pixel picture −60 ms, Pixel sound −11 ms, NDI picture +113 ms.
- **NDI across its 9 s gap:** flash placement 806 ms before, 801.5 ms after — the stitch is clean.
- The Pixel sends RTCP sender reports for **video only** (`senderReportStreams: 1`), so audio
  cannot be mapped through its own reports without a Cameraman change.
