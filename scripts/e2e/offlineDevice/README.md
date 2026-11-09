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
- A phone joined to a network whose traffic a shaping service can drop or
  stall per address, with the service's API reachable from the machine that
  runs the scenario.
- A locally built maestro-d: `MAESTRO_D_BIN` is its binary and
  `TS_MAESTRO_D_CLIENT` its npm package entry.

## The config file

Where the seat and the shaper are, and how to reach them, stays out of Git.
`TS_OFFLINE_DEVICE_CONFIG` names an untracked JSON file:

```json
{
  "shaperUrl": "https://<shaper host>:<port>",
  "fixture": "<the ids.json fixture.ts wrote, copied here>",
  "teamId": "<iOS signing team for the driver>",
  "seat": {
    "ssh": "<ssh destination of the seat's machine>",
    "origin": "https://developN.teamstation.app",
    "liveDir": "<the seat's live build directory>",
    "nodeBinDir": "<directory of the node the seat runs>",
    "serviceUser": "<the user the seat's service runs as>",
    "service": "<the seat's API service unit>",
    "psql": "<a command that opens psql on the seat's database>",
    "recordFile": "<where the request recorder writes during the run>"
  }
}
```

The shaper API is the one `POST /v1/shape` with `{ "merge": true, "shapes":
[{ "ip", "lossPct" | "latencyMs" }] }` applies and `GET /v1/devices` lists the
phones it can shape.

## Seeding the fixture

On the seat's machine, as the seat's service user, from the seat's live build
directory, with the seat's own `node`:

```sh
node -r sucrase/register <path to>/fixture.ts --seat <seat name> --out <ids.json>
```

It writes one person who signs in by emailed code, two teams they belong to
(one the scenario opens, one it never opens), an opponent and a fourth team
whose player is the Add Existing candidate, a league and a season on the
person's Home, a picture on both teams, the season and the league, a final
game three days ago with a short video, and an upcoming game. Every name is
invented. It refuses a second run.

Sign-in reads no mailbox: once the phone asks for a code, the scenario sets
that pending code's hash to one it chose, with the seat's own `hashEmailCode`.

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

1. The phone is listed by the shaper; the build is installed and launched.
2. Sign in, open Upcoming only, and read the request log: no Past, All, Videos
   or team-games request. Open Past, one team, the season, the league, the
   upcoming event and scoring, and search Set Team Rosters' Add Existing for
   the league player. The other team stays unopened, and the log has no
   games request for it.
3. Drop the phone's traffic (`lossPct: 100`).
4. Stop the app and launch it.
5. Home, Upcoming, Past, All, Videos, the team, the season, the league, the
   event and scoring paint; the unopened team has no games; the offline
   banner is below the tab bar, `#6B3E00` with white text.
6. A pitch, Confirm Swap (the sheet is gone within one second and the sides
   are exchanged), the next pitch.
7. Stall the link (`latencyMs: 30000`): a pitch and Confirm Swap close at once
   and scoring's own offline line shows once the request deadline passes; a
   tag saves and its editor closes at once; the defensive sheet's Refresh
   (Create Player, cancelled) leaves the pitch controls on; scoring reopens
   and Set Team Rosters' Add Existing and Create Player are on. Drop the
   traffic again: Add Existing finds the player from step 2 and adds them.
8. Clear the shape: the request log shows the pitches and both swaps in the
   order they were entered (`request-log-<platform>.log`).

The request recorder (`TS_REQUEST_RECORD`) is switched on for the seat's
service for an `after` run and switched off, its file deleted, when it ends.
Every shape is cleared in `finally`, and each shape call is a `$` line in
`<artifacts>/shape.log`.

## Running it again

Scoring writes to the upcoming game. Before another run put that game back:
no current play, no plays, no tags, the fixture's sides, status `scheduled`.
