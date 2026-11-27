# The end-to-end suite

A test here holds three things only: the app navigation, as maestro-d commands on the devices it is handed; the scenario's declared needs; and its expected results. Where it runs is not its business. The runner lives in teamstation-devops, which imports a test file, procures what its spec declares (a pool stack, hub devices, this machine's browser, the app build), and calls `runScenario` in `core/harness.ts` with what it got:

```sh
# in teamstation-devops
npm run e2e -- run <this checkout>/e2e/tests/<category>/<feature>/<behaviour>.e2e.ts \
  [--scenario s] [--surface s] [--stack e2e-NN] [--fault <fault>] \
  --app teamstation-ios=<app id> --app teamstation-android=<app id> --secrets-file <file>
```

Its flags, exit codes, secrets and goldens are in devops's `src/e2e/README.md`. This repository's own command line keeps the authoring commands:

```sh
npm run -s e2e -- list [--category c] [--surface s] [--json]
npm run -s e2e -- needs <test file | spec id> --json    # the needs as the runner reads them
npm run -s e2e -- validate [--strict]
npm run -s e2e -- select --changed <file>… | --base <ref>
npm run -s e2e -- manifest                              # rewrites e2e/manifest.json
npm run -s e2e -- freeze                                # rewrites e2e/streamingFreeze.json
npm run -s e2e -- dump <world> --stack <id>
npm run -s e2e -- scorecard [--ledger <path>]
npm run -s e2e -- coverage-merge <dir> --out <file>
```

`run`, `stack`, `prepare` and `detect` still run the streaming specs (`tests/streaming/`) the old way, until streaming adopts `runScenario`. Given any other scenario (for `stack` and `prepare`, `--for <scenario>`), each exits 3 naming the devops command.

## Writing a spec

`tests/<category>/<feature>/<behaviour>.e2e.ts` default-exports `defineHarness({...})` from `core/spec.ts`:

- `id`, `title`, `kind` (`e2e` or `integration`), and `covers`, the globs of the code it proves, which `select` reads.
- `surfaces`: for each of `web-chromium`, `web-safari-ios`, `web-chrome-android`, `ios-app` and `android-app`, the device roles and, on a web surface, the browser.
  - A role is `{ role, needs, simulator }`. `needs` are a device class (`ios-phone`, `ipad`, `android-phone`, `android-tablet`, `apple-tv`) and features (`camera`, `microphone`, `push`, `gpu`, `keyboard-hardware`), never a device's name. The runner leases a physical hub device with them first, and makes a simulator or emulator only for `simulator: 'allowed'` when none is free. `camera`, `push` and `gpu`, and any assertion on a camera, microphone, real keyboard or GPU, mean `simulator: 'never'`.
  - A browser is `{ role, needs }`: `video` (with `codecs`, such as `['hevc']`) when the page plays video, `gpu` when it draws in 3D. Either puts it in Chrome for Testing on the Mac driving the runner; otherwise it runs in headless Chromium on a browser droplet.
  - A spec covering the 3D screens (`src/app/scoring/**`, `src/app/replay/**`, `src/app/field/**`) declares `gpu` on every role and browser.
- `stack`: `isolated`, a pool stack of its own, or `none`. `services` names what the stack must supply beyond the ref's API and web build: `mail-capture`, `push-capture`, `real-model`, `dictation-model`, `reverse-proxy`, `oauth-provider`, `log-collector`. A run on a stack without one is blocked, naming it.
- `fixtures`: the worlds it seeds or restores; `apps`: the app kinds it launches (`teamstation-ios`, `teamstation-android`), whose ids the caller passes; `secrets`: the third-party keys the test itself reads with `ctx.secret`, which the caller passes. Nothing else of the caller's reaches a test.
- `costUsd`, `minutes`, `faults`, `guards`, `manual`, `exclusive`, `quarantine`, `sendsNoMail`, as `core/spec.ts` documents them.

A scenario takes a `HarnessContext`: `ctx.attached(role)` is the maestro-d device the runner leased for the role, `ctx.app(kind)` the caller's app id, `ctx.browser(size, emulation)` a page in this machine's browser, `ctx.stack.origin` the stack's web build and API, `ctx.stack.pagesOrigin` its pages stand-in, and `ctx.stack.control` its control routes (`seed`, `rateLimits`, `restartApi`, `serverLog`, `setFault`, `jev`, `remux`, `mail`, `push`, `pages`). `ctx.runDir` is the only place a scenario writes.

- Name a test for the behaviour it proves, never its project.
- Importing a spec has no side effects: load server code inside the scenario.
- A scenario sets up its own state and depends on no other scenario.
- Drive the UI through maestro-d. `ctx.browser`'s `page` is for reading, never acting; its types come from `core/web.ts`.
- A device's own steps are maestro-d commands: `setStatusBar`, `startRecording`/`stopRecording`, `setNetworkConditions`, `setAirplaneMode`, `openLink`, `clearState`, `launchApp`, `keyboardVisible`, `pressKey`. The runner points the app at the stack before the scenario; after its own `clearState`, a scenario calls `pointAtStack` (`rigs/app/pointAtStack.ts`).
- Which app is in front is a hierarchy assertion: the expected content is on screen, and no node id carries `ctx.app(kind) + ':id/'`.
- A page a device or browser must open (a link destination, a download) is scripted on the stack's pages stand-in, `ctx.stack.control.pages.script({ [path]: { type, body, headers, holdMs, probe } })`, and linked at `ctx.stack.pagesOrigin`. An unscripted path answers a page that prints its own path, query and fragment; `pages.requests(since)` lists what it served.

## The lint

`validate --strict` holds every source file under `tests/` and `rigs/` (`.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.swift`) to the `no-infra` rule: no import of `node:child_process`, `node:net`, `node:http(s)`, `node:os` or `puppeteer` (a type-only one included), no `process.env`, and no hostname, IP address, port literal, device serial or UDID shape, or home path. Mocha unit tests (`*.test.ts`) run on no runner and are outside it. Local work that is not a device step belongs to the assertion layer that owns the comparison: reference images to `visual.reference`, frames and encoding to `video.frames` and `video.encode`.

It also rejects, outside the streaming freeze, the old vocabulary (`hardware`, `stack: 'seat'`, the service names `api`, `web`, `smtp`, `tess-model`), a role without `simulator`, a spec covering the 3D screens without `gpu`, and an `ask` checkpoint. It skips a rig that no spec reaches and an unconverted legacy module does, until that module's category converts, and prints how many it skipped.

## The streaming freeze

Streaming is owned elsewhere, so nothing it reaches changes. `streamingFreeze.json` records the freeze's roots (`tests/streaming/**`, `rigs/streaming/**`, the streaming legacy modules in `legacy.json`, and `core/run.ts`, `core/legacySweep.ts`, `core/runLegacy.ts`) beside the files their imports reach, with those files' own tests; `validate --strict` fails when it differs from what the roots compute, and `npm run -s e2e -- freeze` rewrites it. A file in it is never moved or deleted; a shared one changes only by addition. The lint and the native-tool scan skip exactly the files it names.

## Checkpoints and goldens

`ctx.checkpoint(id, { expect, readBack, golden, compare, prompt })` states what must be true of the screen. It looks at the device attached or opened last, or at `on`. Layers run in order, and `result.json` records each one's verdict:

1. Invariants, with no opt-out: error text, an empty hierarchy, a blank frame, browser console errors, the app leaving the foreground, and API 5xx. A check the surface cannot make records `not-available`, never a pass.
2. `expect`, maestro-d selectors that must be on screen, or not with `absent: true`, and `readBack`, which throws when what was shown was not saved. `readJson` and `eventually` in `core/readback.ts` help.
3. `golden`, compared against the image the runner fetched for the checkpoint's pin, `goldens/<suite>/<goldenKey>.sha256`. `mask` leaves elements out. Above the default 0.1%, `maxDifferingPercent` needs a `reason`, and lint rejects anything above 1%. A checkpoint with no pin is `unbaselined` (exit 4). The images live on the testing Space, which only the devops runner reads and writes (`run --accept-goldens`); review a golden change as the pin diff, with the before and after the runner writes.
4. `compare: 'ai'` with a `prompt`, a plain statement of what a golden cannot pin (a video frame, live data), which maestro-d's `assertWithAI` answers where the screenshot is taken. `pass` passes; `unsure` is `needs-review`; a `fail` fails the run only once the waterfall has reached the bar in `goldens/judge-bar.json`, and is `needs-review` below it.

The first two stop the scenario. A golden mismatch fails the run at the end, so one run shows every screen that moved.

`judge-eval --judge haiku` and `judge-corpus` score and label the frozen Haiku judge the streaming specs still use, from saved run directories; the waterfall's bar is scored by devops's `judge-eval`.

## Proving a test catches failures

`faults/catalogue.ts` lists every fault, each applied from outside the app, and the layers meant to catch it. A spec names the faults it must catch in `faults`. The devops runner's `run <file> --fault <fault>` sets the fault (a proxy fault on the stack's fault server, a style fault on the page, `app-crash` as maestro-d `stopApp`) before the scenario, clears it after, and appends the result's row to its ledger; it exits 0 when the scenario went red under the fault and records which layer turned it red. A test that merely crashed is `test-crash`, which no fault expects. `npm run -s e2e -- scorecard --ledger <path>` counts those rows.

Once a category leaves `pendingCategories` in `legacy.json`, `validate` fails unless its specs name every fault, or `EXCUSED` in the catalogue says why one cannot reach it.

## Worlds, accounts and mail

A scenario never shares data with another. `ctx.fixture(name)` seeds a scripted world on the stack through its seed route, under its own nonce; the manifest it returns, with its passwords, stays in the scenario's memory. Worlds live in `src/server/dev/fixtures/`. A dump world (`fixtures/dumps/<world>.dump` with its `<world>.accounts.json`) is restored by the runner before the scenario, and `ctx.account(role)` is its committed testing account.

```sh
npm run fixtures -- <world> --json --mailbox <mailbox>
```

The script refuses unless `serverConfig.testSettings` is true, which production never sets, and refuses a database holding any address but a `+` address on the mailbox or one on `example.test`.

- `ctx.signIn(role)` uses the surface's real password form, and sends no mail. It fails unless the person ends up signed in.
- `ctx.address(label)` returns a fresh `+` address on the test mailbox. Lint rejects any other address in a test, unless it is on `example.test` in a spec marked `sendsNoMail: true`.
- `ctx.mail(address, from)` waits for what the app really sent, read from the stack's mail capture. Nothing it reads goes to the run directory.

## Coverage

```sh
npm run e2e -- coverage-merge coverage/browser --out coverage/browser.json
```
