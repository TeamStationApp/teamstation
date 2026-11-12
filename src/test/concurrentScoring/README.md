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

`--scenario conflicts --surface chromium` holds both a Ball and a Called Strike
from the same starting version, then releases either request first. The first
server-accepted pitch must remain on both screens, irrespective of action time.
Set `TS_CONCURRENT_OLDER_AUTHOR` and `TS_CONCURRENT_FIRST_AUTHOR` to 0 or 1;
run all four combinations. The rejected scorer then authors a new accepted pitch.

`--scenario stale-tail --surface chromium` isolates one scorer while the other
completes two innings. A later stale pitch cannot remove those innings. After
recovery, deliberate current-version Undo can remove several at-bats and rescore.
A second isolation verifies that stale scoring cannot reopen the finalized game.

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

## Remote scoring descriptions

`--scenario updates --surface chromium` exercises the remote scoring panel
with two authenticated scorers, accepted Undo, decorated pitch replacement,
collapse/dismiss/reopen, a scrollable log and scoring after switching devices.
Set `TS_CONCURRENT_VIEWPORT_HEIGHT=620` for the short mobile-web viewport; omit it
for the normal phone height. It writes `authorship-answer.json`: the stored-game
read's top-level keys and its `scoringAuthorship`.

`--scenario pending-stretch --surface chromium` holds scorer B's save while B
records a ball (the screen takes no further pitch until it is answered) and A
records a called strike, then releases it: B's post is
superseded and rebased. B's panel must show only A's strike, named; A's panel
must show only what B then scores, credited to B.

The server words nothing. With every write of a game's plays it keeps
`games.scoring_authorship`: the user whose accepted request added each stored
action (nobody for a write no scorer made), and the latest 100 removals of
stored actions by a scorer, as structured actions. Reads and save answers carry
it as `scoringAuthorship`, with merged accounts as their survivors and each
author's short name. Each client builds the log itself, in its own language,
from the plays it syncs: a row is one scorer's consecutive actions within a
batter's run, credited to that scorer, or a removal. It shows only other
scorers' actions and removals new since the panel opened, and only from the
history the server has confirmed, never this device's unsaved scoring. Each
attempt still requires a fresh fixture.
