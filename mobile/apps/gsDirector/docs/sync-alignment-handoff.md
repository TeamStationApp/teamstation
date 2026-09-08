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
git worktree add /Users/paul/git-worktrees/gamestation-directorExportDamagedMedia \
  paul/directorExportDamagedMedia
```

Worktree convention in this repo: `/Users/paul/git-worktrees/gamestation-<topicName>`, branch
`paul/<topicName>`, based on `master`.

### 0.2 Bootstrap — the Xcode project is generated, not committed

```bash
cd mobile/apps/gsDirector
bash scripts/bootstrap.sh          # xcodegen + package resolve; ~1 min
```

Without this, `build-sim.sh` fails with "run 'socket npm run bootstrap' first".

### 0.3 Device rule

Per `.cursor/rules/gs-director-m4-testing.mdc`: **never hard-code a UDID.** Pass
`DIRECTOR_DEVICE_UDID` or `--device <udid>`. Flows must not name a device.

### 0.4 STOP — check retention before you launch the app on any iPad holding footage

Default retention **was 6 hours** and swept the camera archive on app launch. Launching the app
on an iPad with an unrecovered take silently deleted 3,617 segments of a 109-minute game. This
branch changes the default to 250 GB / 100 GB free (§2.1), but **verify the build on the device
has that change before launching it against real footage.** If in doubt, pull the archive first.

---

## 1. The two requirements

- **R1 — live.** No tile and no programme output is behind wall clock by more than the accepted
  playout latency, 2 s. Cameras differ from each other only by what the network cost them.
- **R2 — files.** Every exported camera file is wall-clock exact. Play them together and nothing
  is discernibly early or late.

Both are violated today.

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

### W1 — timecode burn-in (`scripts/fakeRtspCameras.js`)

Nothing here is measurable until the simulated cameras carry machine-readable time.

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
  at `cursor`. Real gaps become empty ranges — black and silent, which is what happened.
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
hold the gap instead of closing it.

**This must not change what goes out live.** It is about what is *written*; the live composite and
the RTMP stream keep going as they do now.

**Acceptance:** S15–S18. Programme file length == take length; samples ≤ 40 ms.

### W6 — duration sanity in the remuxer

`playableDuration` (`ArchiveRemux.swift:117`) accepts any declared duration under
`maximumSaneDuration = 20_000 s` (`ArchiveRemux.swift:115`). Recording 253's `-3` stub is 7.2 MB
claiming 6,550 s — 8.8 kbps against 8 Mbps of real content — and the app's export turned it into a
**128-second second video track holding one frame**, which confuses players and NLEs.

Reject a declared duration whose implied bitrate is impossible for the file's size.

**Acceptance:** exporting a recording with a stub part yields exactly one video and one audio
track.

### W7 — fault injection (`--scenario`)

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

### W8 — shared playout offset (the R1 fix, device only)

`PlayoutController` (`PlayoutController.swift:92`) computes `offsetSeconds` **per camera,
independently**, clamped to `maximumMilliseconds = 2_000` (`PlayoutController.swift:42`). Each
camera honours the 2 s cap alone while saying nothing about the others: one camera at the cap and
another at 100 ms are both "within 2 s of wall clock" and 1.9 s apart from each other.

- Adopt one programme offset: `min(maximumMilliseconds, max(per-camera offsetSeconds))`, applied
  to every tile and the compositor.
- A camera that would push the shared offset past the cap is dropped from the composite rather
  than abandoning sync. **Confirm this with Paul before building it** — it is a product decision.
- Expose per-source `off=` and a new `offspread=` (max − min) in the HUD so a flow can assert.
- Consider special-casing a single-camera show, which gains nothing and pays the shared logic.

**Acceptance:** S7, S8. `offspread` ≤ 250 ms; no source > 2 s.

---

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

---

## 6. Done means

- `verifySync.js` passes S1–S18 at ≤ 40 ms on a take with every fault injected at once.
- A camera with a 30 s dropout exports the same length as one without.
- Programme file length equals take length.
- Exported MP4 and MOV both pass identically.
- Unit test count went up and the only failures are the two known ones.
- `--suite operator` still passes.
