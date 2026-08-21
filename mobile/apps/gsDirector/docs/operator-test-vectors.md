# Operator test vectors

What the operator can do, written as English conditions a person or a Maestro flow can check.
Video is invisible to the accessibility tree, so a tile that *looks* live and a tile that is
frozen on the last replay frame are distinguished by telemetry, not by a screenshot:

- Source tiles publish `source=N state=… src=… off=… onair=0|1 out=…`
- `f=` counts **received** frames and keeps ticking during replay, so it cannot prove the preview
  is moving.
- `out=` is displayed-frame rate. After Return to Live, `state=live out=0` means the small preview
  is frozen even if Output is moving.
- The Output tile publishes `output src=… mix=… mixs=… composed=…`

Maestro value asserts are **text-only**. This runner ignores `text` when `id` is also present
(`maestro/flows/matcher-check.yaml`).

Flows using real cameras must launch through Maestro, not `devicectl`.

From 2026-08-13 the device sits on a Peltier cooler. HUD `thermal=` from these runs is not
comparable to earlier cooling-pad or bare-device numbers.

---

## How to run

```bash
cd mobile/apps/gsDirector
node scripts/run-maestro.js --device <udid> --suite operator
```

`--suite operator` is the product-behavior set below. Characterization flows (bandwidth,
memory, degradation ladder) stay out of that list so a regression pass finishes in one sitting.

---

## A. Source list

| ID | Condition | Pass | Flow |
|---|---|---|---|
| A1 | App launches to the source list | Title and “Choose up to five cameras…” are visible | `smoke` |
| A2 | Discovered sources appear as rows | `source-row-1` (and further rows as cameras exist) | most flows |
| A3 | VIDEO toggle enables a camera | Row value `on=1`, footer `1/5 enabled`, Start Production becomes enabled | `operator-program-cut` |
| A4 | VIDEO toggle disables a camera | Row `on=0`, tile slot freed | `operator-source-cap` |
| A5 | AUDIO toggle is independent of VIDEO | Camera can be on the grid with `audio=0`, or enabled with audio on | `operator-audio-mix` |
| A6 | Five cameras is the cap | Enabling a sixth is refused; status “Five sources maximum — turn one off first”; still `5/5 enabled` | `operator-source-cap` |
| A7 | Start Production with nothing enabled is blocked | Button disabled while `0/5 enabled` | `operator-source-cap` |
| A8 | Start Production with ≥1 camera opens the grid | `output` and `source-1` appear | `operator-program-cut` |
| A9 | Rename a source | Pencil → type → check; grid nameplate and `src=` use the new name | `rtsp-camera-naming` |
| A13 | A live row names a camera, not a row | Name menu → Name… → type; row value `name=…`; the name survives a relaunch on the same unique id | `rtsp-camera-naming` |
| A14 | The name menu offers cameras already known | Every cached camera is listed with where it was last seen | `rtsp-camera-rebind` |
| A15 | A live camera is named from its TXT advertisement | Row is not `Unnamed`; origin `autoByIdentity` | `rtsp-camera-naming` |
| A10 | Settings from the source list | Gear opens settings; Cancel returns without applying; Save persists | manual / settings UI |
| A11 | Simulated cameras vs live | Settings “Simulated cameras”, or launch `sourceProfile` | `smoke` vs `live` |
| A16 | Turning “Simulated cameras” off reaches the cameras | `profile=rtsp`, the generated rows are replaced by cameras found on the network | `settings-live-cameras` |
| A12 | Empty discovery | “Looking for sources…”, the Local Network hint and the current scan line when the list is empty | no cameras reachable; not automated |

---

## B. Grid, program cut, empty slots

The layout is a 3×3 with the top-left four cells merged into Output. Source tiles are 1…5
(accessibility `source-1` … `source-5`), left-to-right, top-to-bottom beside and below Output.

| ID | Condition | Pass | Flow |
|---|---|---|---|
| B1 | First enabled camera is Output | `output src=CAM1`, `source=1 … onair=1`, others `onair=0` | `operator-program-cut` |
| B2 | Tap any live source tile → it becomes Output | Tap `source-2` → `output src=CAM2`, `source=2 onair=1`, previous `onair=0` | `operator-program-cut` |
| B3 | Tap every occupied tile in turn | Each tap moves Output to that camera; exactly one `onair=1` | `operator-program-cut` |
| B4 | Tap the current Output tile again | Still that camera; no empty Output | `operator-program-cut` |
| B5 | Unused slots stay empty | With two cameras, `source=3`…`source=5` are `state=empty src=none` | `operator-empty-tiles` |
| B6 | Tap an empty slot | Output source unchanged | `operator-empty-tiles` |
| B7 | Output shows the composited picture | `composed=` grows; scorebug, if configured, is in this tile not the source tiles | `program-five-sources` |
| B8 | Cutting picture does not change the audio mix | `mix=N` stays at the number of AUDIO toggles, not which tile is Output | `operator-audio-mix` |
| B9 | Disable the on-air camera while the grid is live | Exactly one `onair=1`; disabled slot `state=empty onair=0`; Output still has a source | `operator-program-disable` |
| B10 | Settings Remote Control templates | Default row, editor lists Source 1–5 live + six Instant Replays, Done returns | `remote-control` |
| B11 | Injected pad chord cuts Source 2 live | `/bind-remote?action=live-2&controls=a` then `/remote-chord?controls=a` → `source=2 onair=1` | `remote-control` |

---

## C. Record / stop

| ID | Condition | Pass | Flow |
|---|---|---|---|
| C1 | Record starts | HUD `rec=1`, record button reads RECORDING | `record-and-stop`, `operator-scrub-cut-return` |
| C2 | Archives accumulate | `dur=` and/or `seg=` increase while recording | `record-and-stop` |
| C3 | Stop completes | `rec=0`, `flush=` is a real duration, program file `progbytes=` non-zero | `record-and-stop` |
| C4 | Live preview continues after stop | Tiles stay `state=live` with `out=` > 0 | `operator-scrub-cut-return` |
| C5 | Backgrounding while recording keeps the session alive | HUD/control `rec=1`, `aout=1`, `bgkeep=1`, `pip=1`; mix/segments still advance; hovering programme PiP is visible over another app | `operator-background-record` |

---

## D. Scrub and replay

Drag left on a source tile. Mapping: one small-tile width = 60 seconds at a constant rate,
applied as a *delta from the playhead at finger-down* (live is offset 0). Extra travel keeps
that rate; clamp only to available history. Finger-down shows 1 fps proxy JPEGs. Finger-up
starts replay from that offset, then catches up to the live edge as it stood at release
(or Return to Live jumps immediately). A second swipe continues from where the tile is
already playing — it does not seek as if the tape were at the live edge.

Tiles may replay independently. Starting a second tile's replay does **not** return the first
to live. Instant-replay hotkeys rewind from the live edge, play that duration of tape, then
return **that tile only** to live.

| ID | Condition | Pass | Flow |
|---|---|---|---|
| D1 | Scrub with no recording refuses | Banner “Nothing to scrub — start recording first”; tile stays `state=live off=0.0` | `scrub-without-history` |
| D2 | Scrub after Record but before the first segment closes | Proxies exist; tile enters `scrubbing` or `replaying`; recording continues | `scrub-before-first-segment` |
| D3 | Scrub a **non-Output** tile, release | That tile `state=scrubbing` or `replaying` with `off=-…`; Output still live; `rec=1` | `operator-scrub-cut-return` |
| D4 | After release, the scrubbed tile stays in the past | `off=-` until Return to Live or catch-up; if the archive has closed segments, `replaying` and `replayms>0`; if not, stays `scrubbing` with “Holding still” — never an immediate `live off=0.0` | `operator-scrub-cut-return` |
| D5 | Scrub the **Output** source tile | Output shows the rewind (compositor follows program sink); other tiles stay live | `hevc-scrub` (tile 1 is Output) |
| D6 | H.264 archive replay | Same as D4 on the default codec | `scrub-and-return` |
| D7 | HEVC archive replay | Same as D4 with `archiveCodec: hevc` | `hevc-scrub` |
| D8 | Live-camera HEVC replay | Real camera, HEVC, drag produces `replaying off=-` then live | `rtsp-three-cam-scrub` |
| D9 | Recording continues under a scrub | `rec=1` the whole time | `scrub-and-return` |
| D10 | Shallow drag (< 0.5 s) returns to live | No stuck scrubbing state | implicit in D3 if swipe is deep enough to replay |
| D11 | Second tile scrubbed while first is replaying | Both rewind; the first does **not** return to live | concurrent rewind on M4; `operator-scrub-cut-return` no longer snaps the first |
| D12 | Live tile: release after a real rewind stays in the past | `state=scrubbing` or `replaying` with `off=-`, not an immediate `live off=0.0`. Replay when the archive can; otherwise “Holding still” on the proxy JPEG | `hevc-scrub`, `scrub-and-return` |
| D13 | Already rewound: another left-swipe continues from the playhead | Stays `replaying`/`scrubbing` with `off=-`; does not jump to live or to the start of the tape | `scrub-incremental` |
| D14 | Already rewound: a short right-swipe eases toward live | Still `off=-` after a quarter-tile right drag; must not snap to `live off=0.0` | `scrub-incremental` |

---

## E. Cut a rewound tile to PROGRAM, then Return to Live

This is the operator path that was janky: output moving, small previews frozen.

| ID | Condition | Pass | Flow |
|---|---|---|---|
| E1 | Tap a replaying non-Output tile | It becomes Output (`onair=1`, `output src=` that camera) **while still replaying** | `operator-scrub-cut-return` |
| E2 | Output shows the rewind, not live | Large tile follows the replay; `composed=` still growing | `operator-scrub-cut-return` |
| E3 | Return to Live on that tile | Button `return-to-live-N` only while `scrubbing`/`replaying`; after tap, `state=live off=0.0` | `operator-scrub-cut-return` |
| E4 | **The small tile actually plays** after Return to Live | Within ~3 s, `source=N state=live … out=[1-9]` — not `out=0` | `operator-scrub-cut-return` |
| E5 | Other source tiles still play | Each occupied live tile has `out=` > 0 | `operator-scrub-cut-return` |
| E6 | Output still plays | `composed=` increases after return; `output src=` remains that camera until another cut | `operator-scrub-cut-return` |
| E7 | Return to Live on a non-Output replaying tile | That preview unfreezes; Output stays on the live Output source | `operator-scrub-cut-return` |
| E8 | Catch-up without tapping Return to Live | A replay of N seconds returns to `live off=0.0` by itself; then `out=` > 0 | `hevc-scrub` |
| E9 | Return to Live on Output | `return-to-live-output` returns the current Output source to live | visual / `output` |

---

## F. Audio mix

| ID | Condition | Pass | Flow |
|---|---|---|---|
| F1 | Default: enabled cameras contribute audio | After start, `mix=` equals enabled count (synthetic tones) | `program-five-sources` (`mix=5`) |
| F2 | Untick AUDIO on one enabled camera | `mix=` is enabled-minus-one; picture still on the grid | `operator-audio-mix` |
| F3 | Mix produces samples | `mixs=` (and program `mixs=`) increase | `program-five-sources` |
| F4 | Changing program does not drop mix contributors | After tapping another tile, `mix=` unchanged | `operator-audio-mix` |

---

## G. Scorebug, export, settings, degradation, navigation

| ID | Condition | Pass | Flow |
|---|---|---|---|
| G1 | Scorebug URL burns into Output | Loopback test page; `output src=` live and composed frames increment | `program-five-sources` |
| G2 | Recordings lists a take and offers export | After a real recording, Recordings shows the date row and Export | `recordings-export` |
| G3 | Cameras sheet opens over the live grid | Grid → `cameras-button` → picker; enables preserved | `operator-menu-back` |
| G4 | Opening cameras does not stop a recording | After the picker opens, `rec=1` still holds | `operator-menu-back` (records briefly first) |
| G5 | — | Degradation ladder removed; archives follow the live wire | — |
| G6 | Encode-session budget / thermal | HUD `enc=`, `thermal=`; Peltier-on numbers are a separate series | `docs/risks.md` |
| G7 | Five-source grid fills | `5/5 enabled`, five live tiles plus Output | `program-five-sources` |

---

## H. Live cameras

| ID | Condition | Pass | Flow |
|---|---|---|---|
| H1 | Three cameras live | Search confirms at least three (`awx=3`), each tile `state=live`, `dec=3`, `loss=0` | `rtsp-three-cameras` |
| H2 | Mixed codecs decode together | Two HEVC 1080p and one H.264 720p live at once | `rtsp-three-cameras` |
| H3 | Live cameras contribute audio | `mix=` equals the AUDIO toggles, `mixs=` increases | `rtsp-three-cameras` + `operator-audio-mix` |
| H4 | Ordinary live session | HEVC, persisted selection | `live` |
| H5 | Full-quality characterization | Not a pass/fail product vector | manual, on the device |
| H6 | A camera answers with the same TXT unique id | Its operator name is offered without typing, badge `AUTO` | `rtsp-camera-naming` |
| H7 | The app names the wrong camera | One tap picks the right one from the cache, badge `MANUAL`; the camera it was taken from gives it up | `rtsp-camera-rebind` |
| H8 | A camera is forgotten | The row stays; TXT advertisement re-adopts the NearStream name | `rtsp-camera-rebind` |
| H9 | A camera moves mid-game | Its tile comes back at the new address under the same name, and its archive continues | manual: change its lease while recording |
| H10 | A camera is switched off mid-game | Its tile stops; the others are unaffected; `src=` says why | manual: unplug one camera |
| H11 | The keyframe burst does not reach the screen | Arrivals still bunched (`gap` over 100 ms) while released frames stay within two frame intervals (`rel` under 100 ms) and `late=0` | `playout-smoothing` |

These are slower and need the cameras awake, as does `settings-live-cameras` (A16), which starts on
generated patterns and switches to the network mid-flow. Run them after the operator suite when
checking a device-specific regression. H1–H8 also run in the simulator with `--sim` when the Mac is
on the camera network; H5, H11 and the thermal readings need the iPad.

H1 asserts the three VM33s via `awx=3`. `confirmed=` may be higher when another RTSP device is on
the network — which is a true report about the venue, not a flake. Identified cameras stay first
in the list, so enabling rows 1–3 still puts the VM33s on the grid.

---

## Operator suite (automated)

Flows in `scripts/run-maestro.js --device <udid> --suite operator`, in order:

1. `smoke`
2. `operator-source-cap` — A6, A7, A4
3. `operator-audio-mix` — A5, F2, F4, B8
4. `operator-program-cut` — A3, A8, B1–B4
5. `operator-program-disable` — B9
6. `operator-empty-tiles` — B5, B6
7. `operator-menu-back` — G3, G4
8. `stream-controls` — stream URL field and clear X; empty-URL toast; Stream left of Record; RECORDING not STOP; no REC pill
9. `scrub-without-history` — D1
10. `scrub-before-first-segment` — D2
11. `operator-scrub-cut-return` — D3, D4, E1–E7, C1, C4
12. `scrub-and-return` — D6, D9, E3
13. `hevc-scrub` — D5, D7, E8, D12
14. `scrub-incremental` — D13, D14
15. `program-five-sources` — B7, F1, F3, G1, G7
16. `recordings-export` — G2

After any code fix, re-run this suite from the top.
