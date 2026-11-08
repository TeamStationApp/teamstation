# Concurrent scoring acceptance

Run against the exact branch build in a development seat. The journey uses two
independent scorers and a coach, with a three-second convergence limit. It stops
on the first failure; it never reloads a scorer or retries a scoring action.
Screenshots, state snapshots and a JSON-line log go to the artifact directory.

Create a **new fixture for every attempt** on the seat, using that seat's service
account and current checkout. This generates fake accounts and rostered players;
it sends no mail. The output contains credentials and must remain private.

```sh
TS_CONCURRENT_DATABASE_NAME=TeamStation_yourBranch \
TS_CONCURRENT_FIXTURE=/private/path/fresh-game.json \
node -r sucrase/register src/test/concurrentScoring/seed.ts
```

The database name must explicitly match the configured development database.
The seed refuses to overwrite a fixture file. Preserve failed games as evidence;
remove the disposable development database through the normal seat cleanup when
the investigation is complete. Never run this seed on production or delete
unrelated games/accounts.

For the nightly runner, provision a fresh fixture and set:

- `TS_CONCURRENT_ORIGIN`: development seat URL.
- `TS_CONCURRENT_FIXTURE`: private JSON file created above.
- `TS_CONCURRENT_ARTIFACTS`: unique output directory per run.
- `TS_MAESTRO_D_CLIENT`: locally built Maestro D client entry point.
- `MAESTRO_D_BIN`: locally built Maestro D binary.

```sh
node -r sucrase/register src/app/scoring/concurrentScoring.e2e.ts \
  --scenario four-innings --surface chromium
```

Use `--scenario follow` for the short unfinished-single completion and scorer
handoff check. `--surface safari` runs two physical phones with an owned Chromium
coach window. Claim both phones first and additionally set
`TS_CONCURRENT_DEVICE_A`, `TS_CONCURRENT_DEVICE_B`, `TS_IOS_TEAM_ID`, and
`TS_CONCURRENT_LEASE_UNTIL` (UTC lease expiry). The driver checks expiry before
each device command. Allow 40 minutes for the four-inning physical run. Each run
owns and closes its named browser/device daemons; release the phone leases after
it exits. A transport failure fails the attempt and invalidates its timing.

The four-inning journey covers a single, fielder's choice, fielding error,
trajectory Undo, dropped third strikes safe and out, walk, home run and full
at-bat Undo/re-entry, foul Undo, hit by pitch, intentional walk, cross-device
third-out Undo, bunt ground out, and two coach lineup changes. Its independent
saved-data oracle requires 31 completed plays, three outs in each half-inning,
no duplicate play identities, the expected run/hit/error credits, and correct
individual and team final statistics. Run this entry point from the existing
nightly sweep; it does not create a separate scheduler or change the tester seat.
