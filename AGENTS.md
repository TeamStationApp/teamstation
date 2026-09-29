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

- Do **not** hard-code a simulator or hardware UDID in scripts, tests, docs defaults, or agent
  rules.
- Paul names the target for the run. Pass it as `DIRECTOR_DEVICE_UDID` (or
  `DIRECTOR_SIMULATOR_UDID` for a simulator). Fail if it is missing.
- A test must not name a device; it reads the UDID from the environment and passes it to
  maestro-d as `device:`, so the same test can hit different iPads.
- Do not boot or shut down simulators. Target an already-running instance.
- Do not use the 2018 A12X unless Paul named it.

### How much testing

After the code change, run **as much of the testing that already exists** as the change can affect:

1. `DIRECTOR_DEVICE_UDID=<udid> ./scripts/build-sim.sh` (simulator) or `build-device.sh`
   (hardware) so there is an `.app` to test
2. `DIRECTOR_SIMULATOR_UDID=<udid> ./scripts/test-unit.sh` when Swift logic changed
3. The maestro-d TypeScript tests that cover the product/UI/pipeline area you changed (see
   **UI and device tests** below)

Quote the line that names the UDID. Fix failures before handing back.

### Before launching a build on an iPad holding footage

Retention sweeps the camera archive at app launch. Check the build's retention settings before
running anything against an iPad with an unrecovered take on it — a six-hour window once deleted
all 3,617 segments of a 109-minute game. See `mobile/apps/gsDirector/docs/sync-alignment-handoff.md`.

## UI and device tests: maestro-d in TypeScript

Every UI, simulator, emulator and device test is driven by **maestro-d** and written in
**TypeScript** against its JavaScript client (`import { MaestroD } from 'maestro-d'`, or the
client under `MAESTRO_D_CLIENT_ROOT` as `scripts/scoring-feedback-safari.mjs` loads it). This
applies to every app in the repository: GS Director, GS Cameraman, GS Watcher, GS Distributor and
the web app in a mobile browser.

- **No new Maestro YAML flows.** Do not add `.yaml` flows, and do not use `maestro-runner test` or
  `scripts/run-maestro.js` as the test for new work. The YAML flows that already exist stay until
  someone migrates them; they are not the standard, and they are not required for handing back.
- Write a test as a `.ts` file beside the app it drives (for example
  `mobile/apps/gsDirector/e2e/<name>.e2e.ts`), run with `node -r sucrase/register <file>`.
- Each agent uses its own daemon name (`MAESTRO_D=<name>`); daemons are not shared. Run
  `maestro-d ps` before attaching, and always pin the device with `device:`.
- The maestro-d docs are in `~/git/maestro-d/docs/daemon/` (`js.md`, `rest.md`, `cli.md`,
  `commands.md`).
- A result on a real device is confirmed with a frame from the bench webcam as well as a maestro-d
  screenshot.
