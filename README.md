<p align="center">
  <img src="mobile/icons/tsLogo.png" alt="TeamStation" width="160">
</p>

# TeamStation

TeamStation is an open platform for youth sports, bringing the whole season
together—from leagues and lineups to live scoring, multi-angle video, and
highlights. Built for real teams and real games, it connects coaches, players,
parents, and the family members cheering from anywhere. The code is open so
the people who use TeamStation can help shape its future.

## Before, during, and after game day

- **Your whole season, organized.** Manage leagues, seasons, and teams with
  distinct roles for administrators, coaches, staff, parents, guardians,
  players, and fans. Staff permissions carry from league to season to team.
- **Scheduling and lineups.** Put games on the calendar, build lineups, and
  adjust as the season unfolds.
- **Visual and voice-powered scoring.** Track balls, strikes, launch angle and
  distance on a 3D field—or dictate the play-by-play like an announcer and
  watch it take shape.
  Every scored play feeds the box score, line score, and player season stats.
- **Multi-angle recording and live streaming.** Several people, from either
  team, can capture different angles of the same game. Watch live or bring
  every recording together for simultaneous playback.
- **Event-based highlights.** Turn the key moments of a game into highlight
  clips.
- **Lineup-ready walk-up music.** Match songs to players and keep game-day
  audio connected to the active lineup.

Your team creates the games, video, statistics, and rosters. Your team should
control them. TeamStation will not sell your data or hold it hostage, and
every user has access to the same API the app uses.

## Use it online

**[teamstation.app](https://teamstation.app)** is the hosted version. Open it
in any browser, sign in with your e-mail address, and join your team with the
invite link or code your coach or league sends you. Or use the native iOS
and Android apps for the best experience and to live stream directly from
your phone.

## What is in this repository

| Part | What it is |
| --- | --- |
| The server | Holds teams, games, scoring and video, and takes live streams in. Node and Postgres. |
| The app | One React Native app that runs in a browser and on iPhone and Android. |
| TS Director | An iPad app that runs a multi-camera broadcast from the field, with a scoreboard on the picture. |
| TS Cameraman | Turns a spare iPhone or Android phone into one of TS Director's cameras. |
| TS Distributor | A Mac app that takes TS Director's recordings off the iPad. |

The source is in `src/`; the native camera and directing apps are in
`mobile/apps/`, each with its own README.

## Run it yourself

You need **Node 24** and **Postgres 18**.

```sh
npm install
npm run migrate      # create the database schema
npm start            # the server, on http://127.0.0.1:9100
npm run start.web    # the app, on http://127.0.0.1:8080
```

The server writes its settings to `serverConfig.json` the first time it runs,
and every setting has a default; by default it uses the database
`teamstation_dev` on `localhost:5432`.

To run the app on a phone instead, see [`src/MOBILE.md`](src/MOBILE.md).

Every web build writes a Content-Security-Policy `<meta>` into `index.html`
(`src/buildCsp.mjs`), and a one-shot build adds Subresource Integrity to its
script tag. The policy allows the API and its socket (from an absolute
`TS_API_BASE_URL`) and the media origins in `TS_MEDIA_ORIGINS`,
space-separated; a deployment takes those from
`node src/deploy/mediaOrigins.mjs <serverConfig.json>` (the deployment's own
origin, its Space, and Apple Music's artwork). A local web app needs the
API's and the stand-in Space's origins there, or pictures and attachments
from them are refused:

```sh
TS_API_BASE_URL=http://127.0.0.1:9100/api/v1 \
  TS_MEDIA_ORIGINS="$(node src/deploy/mediaOrigins.mjs serverConfig.json)" \
  npm run start.web
```

**Run `npm run prepare` once**, per clone rather than per worktree. It installs
the husky hook that lints before every commit. `npm install` will not do it for
you: `.npmrc` sets `ignore-scripts`, which is what makes a fresh install safe
and also what stops `prepare` running. Without it there is no gate, and the
lint count drifts — it reached 98 the last time nobody was counting. The hook
sets `core.hooksPath`, which lives in `.git/config` and so is shared by every
worktree of this repository.

The local `npm run fake-space` also holds encrypted chat attachments
(`chat/<conversationId>/<attachmentId>`, deleted with a presigned DELETE).
Its host and port can be set with `TS_FAKE_SPACE_HOST` and `TS_FAKE_SPACE_PORT`.

## Contributing

How the code is laid out, its conventions, testing, and how the live-streaming
path works are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

TeamStation is licensed under the GNU Affero General Public License,
version 3 only (`AGPL-3.0-only`). See [LICENSE](LICENSE) for the full terms.
Third-party components retain their respective licenses.
