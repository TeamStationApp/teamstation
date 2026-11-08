# Concurrent scoring acceptance

Run against the exact branch build in a development seat. The journey uses two
independent scorers and a coach, allowing three seconds for synchronization before inspecting each device.
Inspection time is recorded separately; no mismatched read is retried into a pass. It stops
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

Provision a fresh fixture for the scoring test and set:

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
individual and team final statistics. This is a standalone scoring test; it does
not install a runner, schedule tests or change the tester seat.

`--scenario conflicts --surface chromium` holds an older Ball request until a
newer Called Strike saves, then delivers the older request. The saved count and
both screens must retain only the newer pitch. Set `TS_CONCURRENT_OLDER_AUTHOR`
to `0` or `1` and use a fresh fixture for each direction. Original action time
determines the winner; retries and automatic completion retain that time.

`--scenario network-recovery --surface safari` measures both phones under
500 ms one-way delay, 100 ms jitter, 2% loss and a 1 Mbit cap, then blocks one
scorer's traffic while the other authors a newer pitch. Supply the authorized
shaping API base URL (ending in `/v1`) as `TS_NETWORK_SHAPING_URL`, and the leased
phones' test-network addresses as `TS_CONCURRENT_IP_A` and `TS_CONCURRENT_IP_B`.
The driver refuses devices absent from that API's test-device inventory or
already shaped, changes only its two addresses, and clears them in `finally`.
After a forced process termination, clear those addresses manually through the
same API. It records ping measurements, shaping counters, saved counts, screen
reads and recovery bounds in `network-recovery.json`. Confirm the added delay
and counter increases before interpreting the recovery result. Recovery reads
are repeated to measure convergence; normal-network checks still inspect once
after the three-second allowance. Device inspection time is included in the
reported recovery upper bound, so it is not an exact render timestamp.
