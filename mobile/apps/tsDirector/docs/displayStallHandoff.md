# Handoff: M4 four-hour stress, RTMP stall fix, frozen tiles

Written 2026-08-25 for the next agent on a different Mac with the **same iPad Pro M4** plugged in.
Work only in this worktree / branch. Do **not** edit `/Users/paul/git/teamstation`. Do **not** use
the A12X. M4 thermals here are a separate series from the A12X Peltier notes in `docs/risks.md`.

Branch: `paul/rtmpEncodeStall` (rebased on `origin/master` / `e107cbe`).
Encode-stall commit: `848fc2d` *Keep RTMP IDRs flowing when VideoToolbox callbacks fail or stall.*
This handoff file is the WIP commit on top of that.

## Devices Paul named

| Role | Hardware UDID | Reach |
|---|---|---|
| Director iPad Pro 11" (M4) “Pauls iPad Pro (2)” | `00008132-0000193801B9001C` | `Pauls-iPad-Pro-2.local:8765` |
| Cameraman iPhone | `00008110-0006098A02FA801E` | `iPhone.local:8766` |

Pass `DIRECTOR_DEVICE_UDID`. Maestro YAML must not name a device. `--shutdown-after=false`. Do not
boot or shut down simulators. Do not Maestro or reinstall **mid-stress** (PID change aborts the
harness). Bundle IDs: `app.teamstation.director`, `app.teamstation.cameraman`. Cameras:
`first,third,mound,handheld`.

The control server on `:8765` starts **only** when launched with `-uiTest true` (Maestro
`rtsp-four-cameras`). Bare `devicectl launch` will not open it.

`resolveHost` probes `/health` and that often times out on this iPad while `/dump-state` works. Set:

```text
DIRECTOR_DEVICE_ADDRESS=Pauls-iPad-Pro-2.local
CAMERAMAN_DEVICE_ADDRESS=iPhone.local
```

`xcrun devicectl list devices` / `device info processes` can hang for minutes. Prefer the addresses
above. `dump-state` itself runs `DispatchQueue.main.sync` from the NWListener queue; if the main
thread is busy the 10s `DIRECTOR_CONTROL_TIMEOUT_MS` fires and `stressFourHour.js` **aborts on the
first failure** (no retry).

## What already shipped (encode stall)

The previous 4h run aborted with `kfage` climbing to 66s+ while `kfn` froze at 8047. `kfage` is
recorded at the top of `ProgramStreamer.append`, so frames were arriving and every one was dropped
at `pendingEncodes >= 3`. VideoToolbox’s output callback returned before `didEncode` on error / nil
sample, leaking the counter.

`848fc2d` always decrements pending on the callback, adds `StreamStallPolicy` + GOP watchdog (idle
IDR, wedged-session reset without `clock.reset()`), and HUD fields `pend=`, `cbage=`, `pfage=`,
`idlekf=`, `encreset=`. `gopSeconds` stays 2. Do not change PeerTube, Caddy, or ffmpeg.

Replay handoff in `TileRouter.attachReplay` was **conditional** on `programFrameAgeSeconds` proving
program frames stop. During the encode stall, `decodeSessions` was 4 and `pfage` stayed ~0. **Do
not implement that change unless a later run shows `pfage` climbing.**

## Four-hour rerun (this branch, M4)

Maestro: `node scripts/run-maestro.js --device 00008132-0000193801B9001C rtsp-four-cameras` (PASS).

Short live 180s: 6/6 ticks, kfage ≤ 1.7s, kfn advancing, pend 0–1, pfage/idlekf/encreset 0.

Four-hour command:

```text
cd mobile/apps/tsDirector
DIRECTOR_DEVICE_UDID=00008132-0000193801B9001C \
DIRECTOR_DEVICE_ADDRESS=Pauls-iPad-Pro-2.local \
CAMERAMAN_DEVICE_ADDRESS=iPhone.local \
node scripts/stressFourHour.js \
  --device 00008132-0000193801B9001C \
  --cameraman-device 00008110-0006098A02FA801E \
  --cameras first,third,mound,handheld \
  --seconds 14400 \
  --no-verify
```

`--no-verify` because CoreDevice file listing flakes.

**Result:** aborted at `elapsedSec: 8566` (~2h 23m), `ticksOk: 244`. Reason:

```text
director dump-state failed: The operation was aborted due to timeout
```

That is the 10s control-channel timeout, **not** the kfage/encode stall. Last good health still had
kfage ~1s, kfn advancing (~5017), `idlekf` 18, `encreset` 0, `pfage` 0, thermal `nominal`. A
dump-state a few seconds after abort succeeded (`kfage` 0.3, `kfn` 5049, still streaming; harness
had turned record off).

PeerTube Live Test 2 (private): UUID `8b9b0207-b53c-48f1-8e5d-455bbb5ed847`, watch
`https://tube2.gamestation.co/w/ieSgPChc5oJSqyTEwPLsBz` (anonymous `/w/` is 404). HLS
`TARGETDURATION` stayed 6, no `EXTINF >= 8`, PDT tracked wall within a few seconds for the whole
healthy stretch.

Logs:

- Health/actions: `~/.cursor/logs/20260825T083301Z-stressFourHour-*.log`
- Timing: `~/.cursor/logs/20260825-003648-directorRtmpEncodeStall.log`
- Plan: `~/.cursor/plans/directorRtmpEncodeStall.plan.md`

In the last ~2 minutes before abort, handheld **dropped frames** climbed ~900 per 30s tick
(2236 → 7638) while fps still read ~30. That was the canary.

## Frozen tiles (what the operator saw)

Hours later the iPad still showed **frozen video** while HUD/telemetry looked alive. Two dump-states
3.6s apart (~08:10 local, 2026-08-25):

| Signal | Value |
|---|---|
| Tile `fps` | ~30 (arrivals) |
| Tile `displayedFramesPerSecond` (`out=`) | **0**, `displayedFrames` unchanged |
| `composedFrames` | stuck at 403807 |
| `physFootprintMB` | **3.2 GB and climbing** (~13 MB / 3.6s) |
| CPU / thermal | ~4%, `nominal` |
| `:8765` | answers in <1s (main thread not deadlocked) |
| `isStreaming` | false (stale streamer counters) |
| `decodeSessions` | 3 with 4 live tiles |

`PipelineTelemetry` already documents this: `fps` counts arrivals even while the tile sits on a
still. `out=` is frames that actually reached `AVSampleBufferDisplayLayer`.

`TileRenderer.enqueue` records a displayed frame only if it returns true. A **failed** display
layer still returns true after `sampleBufferRenderer.enqueue`. `out=0` on all four tiles means the
**early return**: paused, no attached layer, or `CMSampleBufferCreateReadyWithImageBuffer` /
format-description failure. `prepareForLive` already comments that a cached format description
from a different NV12 pool after replay leaves the preview frozen on the last frame.

At abort, unified syslog showed `AVSampleBufferVideoRenderer` flipping `readyForDisplay` YES/NO
in a tight loop on every tile. That storm on the main thread is the plausible cause of the
dump-state 10s timeout (`main.sync` from the control server).

## What the next agent should do

Do not treat more Core Media syslog as the first instrument — it drowned the unified log. Add
**counters in dump-state**, then rerun.

1. **Per-tile enqueue fail reason + count** in `TileRenderer` / telemetry: `paused`, `noLayer`,
   `formatDesc`, `sampleBuffer` (OSStatus), maybe `sampleBufferRenderer.status` after flush+enqueue
   (`failed` / needs flush). One counter each, not a log line per frame.
2. **Stress harness:** log `out` / `displayedFramesPerSecond` and `composedFrames` next to `fps`.
   Abort when `fps > 20` and `out == 0` for two consecutive ticks (same shape as the kfage abort).
   Last run looked “healthy” because the harness only watches arrivals.
3. **Dump-state resilience:** retry or raise `DIRECTOR_CONTROL_TIMEOUT_MS` so a main-thread hitch
   does not kill a four-hour run. Still abort on a real PID change.
4. On the next freeze, **before force-quit**, two dump-states a few seconds apart and check
   existing fields this run did not plot: `formatMisses`, `poolMisses`, `displayedFrames`,
   `physFootprintMB`. Climbing `formatMisses` with `out=0` supports the pool/format-cache theory.
5. A short stacked-replay soak on one camera may reproduce `out=0` without another four hours.
6. Force-quit / relaunch is the recovery for the frozen iPad. Maestro `rtsp-four-cameras` again
   before the next stress so `:8765` is up.

Conditional replay-handoff stays **out** unless `pfage` climbs while decode is live.

## Commands the next Mac should quote

```text
node scripts/run-maestro.js --device 00008132-0000193801B9001C rtsp-four-cameras
```

```text
DIRECTOR_DEVICE_UDID=00008132-0000193801B9001C ./scripts/test-unit.sh
DIRECTOR_DEVICE_UDID=00008132-0000193801B9001C ./scripts/build-device.sh
```

Unit tests for stall/pending/clock were 17/17 on this M4. Full `test-unit.sh` still has
pre-existing SDP fixture misses.

npm via `socket npm` if needed. This repo is not PeerTube; do not `pnpm install` here.
