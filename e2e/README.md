# The end-to-end suite

Every test here runs alone through one command, and reports a truthful result.

```sh
npm run -s e2e -- list [--category c] [--surface s] [--json]
npm run -s e2e -- validate [--strict]
npm run -s e2e -- select --changed <file>… | --base <ref>
npm run -s e2e -- plan --resources <list-resources output> [--seat <name>]
npm run -s e2e -- run <category/feature/behaviour#scenario> --surface <s> \\
  [--device role=id]… [--seat <name> | --stack <id>] [--budget-usd n]
npm run -s e2e -- run-many <scenario-id>… --stacks <id,id,…> --surface <s> [--device role=id]…
npm run -s e2e -- stack up [--ref <ref>] [--name e2e-NN]
npm run -s e2e -- stack down <id>
npm run -s e2e -- stack prune
npm run -s e2e -- prepare --app <app> --device <id> --package <path>
node -r sucrase/register e2e/rigs/app/setServer.ts --platform ios|android|tvos --device <udid> --app-id <id> --origin https://e2e-NN.teamstation.app
```

A device runs a Mason develop build, installed with `prepare --package`; `setServer` points it at a stack by its develop-only server link, for its next fresh launch, so one build serves every stack. A stack is a throwaway TeamStation server on a droplet of its own: the ref's API and ingest, Postgres, Valkey, its own Space, the fault server and the Places stand-in, behind HTTPS at a pool name, `e2e-01.teamstation.app` … `e2e-16.teamstation.app`. `stack up` asks the provider the local settings name (`stackProvider`, the devops repo's `e2e-stack`) for one, attaches the handle it prints, and seeds `baseline` on it. Several can be up at once, from any number of worktrees, agents or machines. A scenario that needs a stack runs on one named with `--stack <id>`; without it, it is blocked. `run-many` spreads scenarios across several stacks at once, one at a time on each, holding back a scenario while another running one has a device it needs, and prints one summary. `stack down <id>` has the provider copy the droplet's logs to this machine and destroy the rest; `stack prune` has it remove whatever runs left behind, and forgets stacks whose handle went with them. Nothing of a stack but its logs is left on this machine.

`run` exits 0 for passed or passed-degraded, 1 for failed or quarantined, 2 for blocked, 3
when the harness itself failed, and 4 for inconclusive: needs-review or unbaselined. Read
`result.json` in the run directory for the reason.

Local settings a public repository must not hold live in
`~/.config/teamstation-e2e/local.json`, shared by every worktree; `local.example.json` shows
the shape. `legacy.json` lists tests not yet moved here.

- `core/` is the framework; `rigs/` the helpers scenarios build on; `fixtures/` fixture
  servers and data; `tests/<category>/<feature>/<behaviour>.e2e.ts` the tests.
- Name a test for the behaviour it proves, never its project.
- Importing a spec has no side effects: load server code inside the scenario.
- A scenario sets up its own state and depends on no other scenario.
- Drive the UI through maestro-d. `ctx.browser`'s `page` is for reading, never acting.
- `ctx.browser(size, emulation)` also takes `beforeLoad`, a script standing in for hardware such as a microphone, and `h264` for real video, which only Chrome plays. Its `resize` emulates another window size on the same page, for reading: maestro-d captures at the window's own size, so check a screen's look by opening the browser at that size.

## Checkpoints and goldens

`ctx.checkpoint(id, { expect, readBack, golden })` states what must be true of the screen. It looks at the device attached or opened last, or at `on`. Layers run in order, and `result.json` records each one's verdict:

1. Invariants, with no opt-out: error text, an empty hierarchy, a blank frame, browser console errors, the app leaving the foreground, and API 5xx. A check the surface cannot make records `not-available`, never a pass.
2. `expect`, maestro-d selectors that must be on screen, or not with `absent: true`, and `readBack`, which throws when what was shown was not saved. `readJson` and `eventually` in `core/readback.ts` help.
3. `golden`, compared by maestro-d against the image pinned in `goldens/manifest.json`. `mask` leaves elements out. Above the default 0.1%, `maxDifferingPercent` needs a `reason`, and lint rejects anything above 1%.

The first two stop the scenario. A golden mismatch fails the run at the end, so one run shows every screen that moved. A missing golden exits 4, `unbaselined`, and nothing creates one:

```sh
npm run e2e -- golden accept <run-dir> --checkpoint <id>   # from a run on fixture data at this commit
npm run e2e -- golden sync                                 # fetch master and every master.* of the store
npm run e2e -- golden rotate                               # retire history; dated branches keep old goldens
```

`accept` pushes the PNG to the private store named by `goldenStore` and updates `goldens/manifest.json` in the working tree, which is what you commit. Review a golden change as that manifest diff, with the before and after in the pull request.

## The AI judge

`ask` in a checkpoint states, in plain words, what a golden cannot pin, such as a video frame or live data. Haiku judges a downscaled screen, and an unsure or low-confidence answer escalates once to Sonnet. Ask about state, not exact counts or pixel positions, which belong to `expect` and goldens.

A judge can fail a test only once it has reached the bar: at least 95% recall on defects and at most 2% false failures on the corpus, recorded in `goldens/judge-bar.json`. Below the bar, or when it is unsure, has no key or has no budget left, the run reports `needs-review` and exits 4, never a pass. On a golden mismatch it may label the difference, which is advice and cannot change the verdict.

```sh
npm run e2e -- judge-eval --judge haiku [--budget-usd 2]   # scores the corpus, and records the bar
npm run e2e -- judge-corpus add <run-dir> --checkpoint <id> --question <true statement> --false-question <false statement>
npm run e2e -- judge-corpus add-log <file> --question <statement> --expected pass|fail
```

The corpus lives in the private golden store. `add` turns one clean capture into six labelled items: clean, blank, clipped, shifted, wrong text and an error dialog. `run --budget-usd` caps a run's spend, defaulting to `judgeBudgetUsd` in the local settings, and with neither set nothing is spent. Video has free measurements in `core/video.ts` first: frozen, black and silent spans, and a contact sheet for a judge's state questions.

## Proving a test catches failures

`e2e/faults/catalogue.ts` lists every fault, each applied from outside the app, and the layers meant to catch it. A spec names the faults it must catch in `faults`.

```sh
npm run e2e -- detect <scenario-id> --fault <fault> --surface <surface> [--stack <id>] [--device role=id]
npm run e2e -- scorecard
```

`detect` passes only when the scenario goes red under the fault, and records in the ledger which layer turned it red. A test that merely crashed is recorded as `test-crash`, which no fault expects, because it proves no layer saw anything. A quarantined scenario proves nothing, and a fault that cannot run on the surface reports `blocked` and records nothing. Fault runs can never make a golden.

API faults come from the stack's fault server, between its HTTPS front and its API on the droplet: `detect --stack <id>` sets the fault there before the scenario and clears it after, and the stack's 5xx are read from the same server. Sign-in stays up by default, so a fault reaches the screens a scenario checks. A scenario whose fixture must carry a fault reads `ctx.fault`.

Once a category leaves `pendingCategories` in `legacy.json`, `validate` fails unless its specs name every fault, or `EXCUSED` in the catalogue says why one cannot reach it. A fault that survives is a blind spot: add a checkpoint, or record the reason.

## Fixtures, accounts and mail

A scenario never shares data with another. `ctx.fixture(name)` seeds a world under its own nonce, and the manifest it returns, with its passwords, stays in the scenario's memory. `baseline`'s accounts, `admin` and `member`, exist on a stack (seeded at `stack up`) and on the tester seat. A branch seat has none, so a scenario needing them reports `blocked` there. Worlds live in `src/server/dev/fixtures/`.

```sh
npm run fixtures -- <world> --json --mailbox <mailbox>
```

The script refuses unless `serverConfig.testSettings` is true, which production never sets. `baseline` also refuses a database holding any address but a `+` address on the mailbox, which an empty database satisfies and a copy of production cannot.

- `ctx.signIn(role)` uses the surface's real password form, and sends no mail. It fails unless the person ends up signed in.
- `ctx.address(label)` returns a fresh `+` address on the test mailbox. Lint rejects any other address in a test, unless it is on `example.test` in a spec marked `sendsNoMail: true`.
- `ctx.mail(address, from)` waits up to three minutes for what the app really sent, with one targeted, time-bounded search at a time. Nothing it reads goes to the run directory.

Rate limits are production's on every stack: an address may ask for five sign-in codes in fifteen minutes. A scenario that signs the same account in more often than that clears the limit on its own stack's database (the streaming rigs' `resetLimits` does).

## Coverage

A category's coverage script reads what its scenarios executed:

```sh
NODE_V8_COVERAGE=coverage/server npm run e2e -- run <id> --surface web-chromium --browser-coverage coverage/browser
npm run e2e -- coverage-merge coverage/browser --out coverage/browser.json
```

### Phone tab bar

`npm run coverage.tabBar` measures JavaScript unit tests and the hosted tab-bar XCTest suite. Set `TS_TAB_IOS` to your task simulator, or pass `-- --js-only` for the JavaScript gate. Each changed production file and the total must reach 90% in unit tests and 95% after combining measured counters. A unit run reaching both thresholds needs no additional fixture.

To include integration or end-to-end measurements, run a collector on the same revision. For browser coverage, run `browser-build` and deploy its printed web directory to the isolated test stack. Set `TS_TAB_COVERAGE_WEB_DIR` to that directory when collecting. The collector checks the build revision and verifies the browser’s executed bytes and source map against that build. Each successful invocation prints a fresh `measured.json` file. Supply each file through `--supplement` when running the gate. The examples use an already attached test stack, its matching release settings, and an owned simulator.

```sh
node scripts/tab-bar-collect-coverage.mjs node node_modules/.bin/mocha -r sucrase/register --timeout 60000 src/server/tess/sitemap.integration.test.ts
# Deploy the printed directory to the test stack, then set TS_TAB_COVERAGE_WEB_DIR to its local path.
node scripts/tab-bar-collect-coverage.mjs browser-build
node scripts/tab-bar-collect-coverage.mjs browser 'app-shell/lists/list-screens#result-pill-phone' --stack "$STACK_ID"
node scripts/tab-bar-collect-coverage.mjs xctest TeamStationTests/GlassViewTests
node scripts/tab-bar-collect-coverage.mjs ios node -r sucrase/register e2e/core/cli.ts run 'app-shell/tab-bar/compact#scroll-and-switch' --surface ios-app --stack "$STACK_ID" --device "device=$TS_TAB_IOS"
npm run coverage.tabBar -- --supplement "$JS_RECEIPT" --supplement "$NATIVE_RECEIPT"
```

The browser collector builds the current web release and checks the executing script and its local source map against that build. The simulator collector builds an instrumented app with a temporary bundle ID, runs the provided journey with `TS_TAB_APP_ID` set to that app, and reads its LLVM profiles after backgrounding it. The collector removes its app afterward. Both iOS modes accept `TS_TAB_DERIVED_DATA` for your run's build cache.
