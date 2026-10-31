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
