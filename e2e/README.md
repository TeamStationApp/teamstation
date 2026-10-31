# The end-to-end suite

Every test here runs alone through one command, and reports a truthful result.

```sh
npm run -s e2e -- list [--category c] [--surface s] [--json]
npm run -s e2e -- validate [--strict]
npm run -s e2e -- select --changed <file>… | --base <ref>
npm run -s e2e -- plan --resources <list-resources output> [--seat <name>]
npm run -s e2e -- run <category/feature/behaviour#scenario> --surface <s> \\
  [--device role=id]… [--seat <name> | --stack <id>] [--budget-usd n]
npm run -s e2e -- stack up [--lan] [--native]
npm run -s e2e -- stack down <id>
npm run -s e2e -- prepare --app <app> --device <id> (--stack <id> | --seat <name> | --package <path>)
```

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

`accept` pushes the PNG to the private store named by `goldenStore` and updates `goldens/manifest.json` in the working tree, which is what you commit. Review a golden change as that manifest diff, with the before and after in the handoff.

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
npm run e2e -- detect <scenario-id> --fault <fault> --surface <surface> [--device role=id]
npm run e2e -- scorecard
```

`detect` passes only when the scenario goes red under the fault, and records in the ledger which layer turned it red. A test that merely crashed is recorded as `test-crash`, which no fault expects, because it proves no layer saw anything. A quarantined scenario proves nothing, and a fault that cannot run on the surface reports `blocked` and records nothing. Fault runs use an isolated stack and can never make a golden.

API faults come from a proxy between the front server and the API. `ctx.stack.adopt(origin)` puts the same proxy in front of a server a scenario started, and returns the origin to use, so its 5xx are seen too. Sign-in stays up by default, so a fault reaches the screens a scenario checks. A scenario whose fixture must carry a fault reads `ctx.fault`.

Once a category leaves `pendingCategories` in `legacy.json`, `validate` fails unless its specs name every fault, or `EXCUSED` in the catalogue says why one cannot reach it. A fault that survives is a blind spot: add a checkpoint, or record the reason.
