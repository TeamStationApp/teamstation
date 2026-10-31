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
