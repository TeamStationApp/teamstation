# Agent guidelines for gamestation

## Push your work

**Do not leave code on the local machine, committed or uncommitted.** There is no backup of a
local commit, and Paul drives Claude from a different workstation and cannot easily see local
files. Work that is not pushed is work he cannot review.

- Commit and `git push` as soon as a change is coherent. Do not wait to be asked.
- Feature branches only. Never push directly to `master`.
- **Force pushes need Paul's explicit say-so** for that push. `--force-with-lease` included.
- Anything genuinely destructive — deleting a remote branch, rewriting published history,
  discarding someone else's commits — is his call, not yours.

If a change is not ready to push, it is not finished; say so rather than leaving it on disk.

## GS Director: pass the device UDID

Whenever Paul asks to **fix, change, or finish** GS Director (`mobile/apps/gsDirector`), treat
verification as part of the work — not an optional follow-up.

### Device

- Do **not** hard-code a simulator or hardware UDID in scripts, YAML, docs defaults, or agent
  rules.
- Paul names the target for the run. Pass it as `DIRECTOR_DEVICE_UDID` (or
  `node scripts/run-maestro.js --device <udid>`). Fail if it is missing.
- Maestro YAML must not name a device; the runner supplies `--device` so the same flows can hit
  different iPads.
- Do not boot or shut down simulators. Target an already-running instance. Maestro:
  `--shutdown-after=false`.
- Do not use the 2018 A12X unless Paul named it.

### How much testing

After the code change, run **as much of the suite that already exists** as the change can affect:

1. `DIRECTOR_DEVICE_UDID=<udid> ./scripts/build-sim.sh` (simulator) or `build-device.sh`
   (hardware) so Maestro `clearState` has an `.app`
2. `DIRECTOR_DEVICE_UDID=<udid> ./scripts/test-unit.sh` when Swift logic changed
3. `node scripts/run-maestro.js --device <udid> --suite operator` for product/UI/pipeline work

Quote the runner line that names the UDID. Fix failures before handing back.

### Before launching a build on an iPad holding footage

Retention sweeps the camera archive at app launch. Check the build's retention settings before
running anything against an iPad with an unrecovered take on it — a six-hour window once deleted
all 3,617 segments of a 109-minute game. See `mobile/apps/gsDirector/docs/sync-alignment-handoff.md`.
