# Offline cache on a shaped phone

`src/app/sync/offlineDevice.e2e.ts` proves on a real iPhone and a real Android
phone that the screens opened online paint again on a relaunch with the phone's
traffic dropped, that scoring and Confirm Swap never wait on the network, and
that the writes reach the server in the order they were entered.
`fixture.ts`, beside this file, seeds what it drives.

## What it needs

- A development seat running the commit under test, and the phone build of
  that commit aimed at that seat (app id `app.teamstation.develop`).
- The fixture seeded on that seat (below).
- A phone on a network whose traffic, by the phone's address, commands run
  on the machine that runs the scenario can drop, stall and clear (the
  config file names them).
- A locally built maestro-d: `MAESTRO_D_BIN` is its binary and
  `TS_MAESTRO_D_CLIENT` its npm package entry.
- `ffmpeg` and `ffprobe` on the path, to read the swap recordings.
- Android: `adb` on the path. Each Confirm Swap is recorded by the phone's
  own `screenrecord`, streamed to the Mac as H.264, each frame timed on the
  Mac's clock as it arrives.
- iOS: the iPhone on USB, and `swiftc` (Xcode). Each Confirm Swap is recorded
  from the Mac by `iosScreenRecord.swift`, beside this file, through the USB
  screen capture QuickTime uses, each frame timed on the Mac's clock;
  maestro-d records simulators only. Opening that capture moves the phone's
  USB to another configuration, which drops the driver's connection, so the
  scenario opens it once, before the driver connects, and keeps it open to
  the end. The terminal that runs the scenario may be asked once for camera
  access.

## The config file

How to reach the seat and the phone's network stays out of Git.
`TS_OFFLINE_DEVICE_CONFIG` names an untracked JSON file of shell command
lines, each run on the machine that runs the scenario. `{ip}` is replaced by
the phone's address and `{ms}` by a delay in milliseconds, each quoted for
the shell. The scenario stops at once, naming each one, when any is missing.

```json
{
  "fixture": "<the ids.json fixture.ts wrote, copied here>",
  "teamId": "<iOS signing team for the driver>",
  "network": {
    "drop": "<command: drop every packet to and from {ip}>",
    "stall": "<command: delay every packet to and from {ip} by {ms}>",
    "clear": "<command: clear what drop and stall set on {ip}>",
    "check": "<command: exit 0 when {ip} is a phone these can shape>"
  },
  "seat": {
    "origin": "https://<the seat's public address>",
    "record": {
      "on": "<command: switch the seat's request recorder on, empty>",
      "off": "<command: switch it off, its lines deleted, and say so>",
      "read": "<command: print its lines so far>"
    },
    "sql": "<command: run the SQL on stdin against the seat's database>"
  }
}
```

- `drop`, `stall` and `check` fail (exit non-zero) when they are refused;
  `clear` fails when the address is still shaped afterwards, which the
  scenario logs as a warning. Their output is logged.
- `record.on` sets `TS_REQUEST_RECORD` for the seat and returns once it has
  restarted, if it must; the scenario then waits for the seat's health read
  and stops at once when `record.read` does not print it.
- `sql` prints each row on a line, its columns separated by `|`, with no
  header or footer, and fails on an error (`psql -At -v ON_ERROR_STOP=1`).

## Seeding the fixture

From the seat's build directory, with the `node` it runs, as a user that may
read its configuration and write its database and Space:

```sh
node -r sucrase/register <path to>/fixture.ts --database <its database> --out <ids.json>
```

It writes one person who signs in by emailed code, two teams they belong to
(one the scenario opens, one it never opens), an opponent and a fourth team
whose player is the Add Existing candidate, a league and a season on the
person's Home, a picture on both teams, the season and the league, a final
game three days ago with a short video, and an upcoming game. Every name is
invented. It refuses a second run.

Sign-in reads no mailbox: once the phone asks for a code, the scenario sets
that pending code's hash to one it chose, with the server's own
`hashEmailCode`, through `sql`.

## Running it

Claim the phone first, then once per platform, iOS and Android one after the
other (they share the fixture person and its upcoming game):

```sh
TS_OFFLINE_DEVICE_CONFIG=<config.json> MAESTRO_D_BIN=<maestro-d> \
TS_MAESTRO_D_CLIENT=<maestro-d npm entry> \
  node -r sucrase/register src/app/sync/offlineDevice.e2e.ts \
  --mode after --platform ios --device <device id> --ip <phone address> \
  --artifacts <dir> --app-file <the build's .ipa or .apk>
```

`--steps 3-5` reruns part of it on the signed-in phone; `--mode before` runs
the same steps against the base build and records what it sees without
failing. Steps:

1. `network.check` passes for the phone; the build is installed and launched.
2. Sign in, open Upcoming only, and read the request log: no Past, All, Videos
   or team-games request. Open Past and the past game's Videos section (its
   poster), one team, the season, the league, the upcoming event and
   scoring, and search Set Team Rosters' Add Existing for the league player.
   The other team stays unopened, and the log has no games request for it.
3. Drop the phone's traffic (`network.drop`).
4. Stop the app and launch it.
5. Home, Upcoming, Past, All, Videos, the team, the season, the league, the
   past game's Videos section (the stored poster drawn, not a black box),
   the upcoming event and scoring paint; the unopened team has no games; the
   offline banner is below the tab bar, `#6B3E00` with white text.
6. A pitch, Confirm Swap, the next pitch. The screen is recorded from the
   open sheet to three seconds after the tap. Within 1 s of the moment
   the scenario sends the tap, a frame shows the sheet gone, the other
   side's nameplates on the field and the scoreboard exchanged, each as the
   settled scorer 2.5 s after the tap shows them. A frame arrives after it is
   drawn and the tap lands after it is sent, so the time is never short.
   Once settled the scorer is drawn (no "Loading game"). The recording, its
   frame times, the frame where the swap is drawn, the one before it and the
   last one before the tap are saved under `support/`.
7. With the shape cleared and scoring's offline line gone, stall the link
   (`network.stall`, 30000 ms) and enter a pitch: the line is absent before the
   10 s request deadline and shows after it. A pitch and Confirm Swap pass
   the same recorded checks; the measured swap puts the opened team up to
   bat. On iOS a pitch is entered to tag, the tag saves and its editor closes
   at once, and the reopened history shows the tag on its play; on Android
   the tag history does not open from a hold on Undo (also on the base
   build), so that part is logged as skipped. The defensive sheet's Refresh
   (Create Player, cancelled) leaves its controls on; scoring reopens and Set
   Team Rosters' Add Existing and Create Player are on. Drop the traffic
   again: Add Existing finds the player from step 2, Add to Roster puts them
   on the opened team's side of Set Team Rosters.
8. Clear the shape: the request log shows the pitches and the swaps in the
   order they were entered (`request-log-<platform>.log`) and the queued add
   to the opened team's roster, and the seat has the player on that team.

The request recorder (`TS_REQUEST_RECORD`) is switched on for an `after` run
(`record.on`) and off when it ends (`record.off`); the run stops at once if
the seat's own health reads are not recorded. The phone's traffic is
cleared in `finally`, and each network command and its answer is a `$` line
in `<artifacts>/network.log`.

## Running it again

Scoring writes to the upcoming game. Before another run put that game back:
no current play, no plays, no tags, the fixture's sides, status `scheduled`.
Take the Add Existing candidate off the opened team too: step 1 stops when
they already play on it.
