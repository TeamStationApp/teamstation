# Concurrent scoring acceptance

The journeys of `e2e/tests/scoring/concurrent/two-browsers.e2e.ts` (two
scorers and a coach, each in a browser of the runner's own) and
`two-phones.e2e.ts` (two scorers in Safari on two physical iPhones, the coach
in the runner's browser). This directory is their library. The journey uses two
independent scorers and a coach, allowing three seconds for synchronization
before inspecting each device. Inspection time is recorded separately; no
mismatched read is retried into a pass. It stops on the first failure; it never
reloads a scorer or retries a scoring action. Screenshots, state snapshots and
a JSON-line log go to the run directory.

Every journey seeds a fresh `concurrent-scoring` world on its pool stack
(`src/server/dev/fixtures/concurrentScoring.ts`): fake accounts and rostered
players, and no mail. The devops runner runs them:

```sh
# in teamstation-devops
npm run e2e -- run <teamstation checkout>/e2e/tests/scoring/concurrent/two-browsers.e2e.ts \
  --scenario four-innings --secrets-file <file>
```

`follow` is the short unfinished-single completion and scorer handoff check.
`two-phones` leases both phones through the hub and releases them after.

The four-inning journey covers a single, fielder's choice, fielding error,
trajectory Undo, dropped third strikes safe and out, walk, home run and full
at-bat Undo/re-entry, foul Undo, hit by pitch, intentional walk, cross-device
third-out Undo, bunt ground out, and two coach lineup changes. Its independent
saved-data oracle requires 31 completed plays, three outs in each half-inning,
no duplicate play identities, the expected run/hit/error credits, and correct
individual and team final statistics. This is a standalone scoring test; it does
not install a runner, schedule tests or change the tester seat.

`conflicts-older-<a|b>-first-<a|b>` (two-browsers) holds both a Ball and a
Called Strike from the same starting version, each browser off the network
(maestro-d's `setNetworkConditions`), then lets either save through first. The
first server-accepted pitch must remain on both screens, irrespective of action
time. The four scenarios are the four combinations. The rejected scorer then
authors a new accepted pitch.

`stale-tail` (two-browsers) takes one scorer's browser off the network and one scorer while the other
completes two innings. A later stale pitch cannot remove those innings. After
recovery, deliberate current-version Undo can remove several at-bats and rescore.
A second isolation verifies that stale scoring cannot reopen the finalized game.

`network-recovery-older-<a|b>` (two-phones) measures both phones under
500 ms one-way delay, 100 ms jitter, 2% loss and a 1 Mbit cap, then blocks one
scorer's traffic while the other authors a newer pitch. Each phone is shaped by
its own hub (maestro-d's `setTrafficShape`, cleared with `resetTrafficShape` in
`finally`). It records the shapes, saved counts, screen reads and recovery
bounds in `network-recovery.json`. Recovery reads
are repeated to measure convergence; normal-network checks still inspect once
after the three-second allowance. Device inspection time is included in the
reported recovery upper bound, so it is not an exact render timestamp.

## Remote scoring descriptions

`updates` (two-browsers) exercises the remote scoring panel
with two authenticated scorers, accepted Undo, decorated pitch replacement,
collapse/dismiss/reopen, a scrollable log and scoring after switching devices.
`updates-short-window` runs it in the short mobile-web window, 620 tall. It writes `authorship-answer.json`: the stored-game
read's top-level keys and its `scoringAuthorship`.

`pending-stretch` (two-browsers) holds scorer B's save, B's browser off the network, while B
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
