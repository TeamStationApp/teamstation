# GameStation 2.0 (`src2/`)

The video server and app that replace PeerTube at tube.gamestation.co, and that
will later absorb the scoreboard, dashboard and splitter. Plan:
`~/.cursor/plans/202609150848-gameStationApp.md`.

This is a **peer of `src/`, not a part of it**. It has its own `package.json`,
lockfile and TypeScript config, and it never imports from `src/`. The two trees
are built and deployed separately, and `src/` keeps working untouched until
cutover.

## Layout

| Directory | What lives there |
| --- | --- |
| `common/` | Types and cleaners shared by server and app. No I/O, no Node-only imports. |
| `server/` | Express 5 API, clustered across every CPU. Postgres through Kysely. |
| `migrate/` | The PeerTube importer, and the database migrations. |
| `app/` | Expo + React Native Web client. Web only for now. |

## Conventions

These follow the repository, not a new taste:

- **TypeScript only, Node 24.** No Python, no Java.
- **`cleaners` on every API request and response**, in both directions. Declare
  `export const asFoo = asObject({...})`, then
  `export type Foo = ReturnType<typeof asFoo>`.
- **One error shape** for every failure the API returns — see
  `common/errors.ts`.
- **camelCase filenames**; `PascalCase` only for React components.
- **Prettier as configured at the repo root**: no semicolons, single quotes,
  80 columns, `arrowParens: avoid`, no trailing commas. Imports are sorted by
  `eslint-config-standard-kit`.
- Tests are `<subject>.test.ts` beside their subject, run by the built-in
  `node --test` runner. (`src/` uses mocha; this tree uses `node:test` so it
  adds no test dependency.)

## Running it

```sh
cd src2
npm install
npm run migrate      # create or update the schema
npm start            # API on 127.0.0.1:9100
npm test
```

Configuration is written by `cleaner-config` to `src2/serverConfig.json` on
first run; it is gitignored, and every field has a default.

## Live streaming

A game can be given a stream URL with its key in it — `rtmp://host:1936/live/…`
— which is pasted into streaming software or picked from a list by GS Director.
One stream arrives and goes two ways at once: this machine's own HLS, and,
when the game says so, onward to another RTMP destination. Both legs are
`-c copy`.

| Piece | Where |
| --- | --- |
| The RTMP ingest and the split | `server/live/splitter.ts` — node-media-server, one ffmpeg child per leg |
| What keeps it in step with the database | `server/live/controller.ts` |
| Keys, their window, and sealing | `server/live/streamKeys.ts`, `server/live/secrets.ts` |
| Turning a finished stream into a recording | `server/live/finishVideo.ts` |
| The Space, and proving the copy arrived | `server/media/spacesVideo.ts` |

Three things are worth knowing before changing any of it:

- **The ingest runs in exactly one process** — the cluster primary, or the
  single process when `clusterWorkers` is 1. It binds a port and holds the
  ffmpeg children, and a second copy would fight the first for both. The API
  never calls it: an endpoint writes the `live_streams` row and the controller
  acts on it within the second.
- **A video's `kind` is `live` for ever**, including long after the stream has
  finished and become an ordinary recording. `status` is what moves: `live`,
  then `processing`, then `ready`.
- **Keys are sealed, not hashed.** Unlike a session token, a stream key exists
  to be read back and pasted, so `live_streams` keeps both a hash (to check an
  incoming publish against) and a sealed copy (to show again). Changing
  `sessionSecret` makes the sealed copies unreadable, which means rotating
  every key rather than recovering them.

Locally, `npm run fake-space` stands in for the DigitalOcean Space with
signatures enforced, so the whole path — live, ended, packed up, uploaded,
verified, swept — runs on one machine with no network and no bill.
