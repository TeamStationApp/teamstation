# GameStation

The video server and app behind gamestation.co. It took over from PeerTube on
2026-09-18; PeerTube still runs beside it on tube2.gamestation.co, and this
server reads its database and media in place. Plan:
`~/.cursor/plans/202609150848-gameStationApp.md`.

**The source is `src2/`, and it is the only thing built here.** One
`package.json` at this level, one lockfile, one set of tsconfigs.

## Layout

| Directory | What lives there |
| --- | --- |
| `src2/common/` | Types and cleaners shared by server and app. No I/O, no Node-only imports. |
| `src2/server/` | Express 5 API, clustered across every CPU. Postgres through Kysely. |
| `src2/migrate/` | The database migrations, their runner and its command line. |
| `src2/app/` | The client. `react-native-web` renders it in a browser; `ios/` and `android/` render the same files on a phone — see `src2/MOBILE.md`. |
| `ios/`, `android/` | The native projects, beside the package because that is where React Native takes its project root from. A deploy does not archive them. |
| `src2/maestro/` | Flows that walk every screen on a phone, run at every gate. |

## Where the site's address lives

`src2/common/primaryUrl.ts`, and nowhere else:

```ts
export const PRIMARY_HOST = 'gamestation.co'
```

**A host, not a URL — no scheme is written down anywhere.** `https` is
implied, except for an IP address or `localhost`, which imply `http`; those
are the two things nobody holds a certificate for and the two things a server
you are running yourself is reached by. RTMP is always `rtmp://`, there being
no encrypted RTMP here to choose between.

Everything builds its URLs from it: playback links, invites, sign-in e-mails,
the RTMP address an operator pastes into a camera, and the address GS Director
talks to. Swift cannot import a TypeScript module, so `AppServer.defaultHost`
in `GameStationKit` carries the same string — and a test on each side reads
the other language's source and fails if the two disagree.

A deployment that is **not** production says its own name once, in its own
`serverConfig.json`:

```json
{ "primaryUrlOverride": "develop2.gamestation.co" }
```

Optionally with a port — `127.0.0.1:9100` for a server you are running
yourself. Production leaves it empty, because production is the address in the
source.

It was three places once — a literal in the iOS app, a copy saved into every
iPad's settings, and a line in each deployment's `serverConfig.json`. When the
site moved from `tube2.gamestation.co` to `gamestation.co` the saved copies
did not, and a Director went on asking PeerTube for its games, getting a 400
with an empty body, which reads as nothing being wrong at all. A committed
`config.json` fixed that and introduced its own: a branch wanting a
development server had to edit a tracked file, and then remember not to land
it.

## Conventions

- **TypeScript only, Node 24.** No Python, no Java.
- **`cleaners` on every API request and response**, in both directions. Declare
  `export const asFoo = asObject({...})`, then
  `export type Foo = ReturnType<typeof asFoo>`.
- **One error shape** for every failure the API returns — see
  `src2/common/errors.ts`.
- **camelCase filenames**; `PascalCase` only for React components.
- **Prettier as configured in `.prettierrc.json`**: no semicolons, single
  quotes, 80 columns, `arrowParens: avoid`, no trailing commas. Imports are
  sorted by `eslint-config-standard-kit`.
- Tests are `<subject>.test.ts` beside their subject, run by mocha through
  sucrase — `npm test` from this directory sweeps `src2/**`.

## Running it

Everything is driven from **this directory** — the package, the lockfile and
the tsconfigs are here, and `src2/` is the source they build. That is also
exactly how a deploy lays a version out, so what runs on the server is the
same shape as the tree you have here.

```sh
npm install
npm run migrate      # create or update the schema
npm start            # API on 127.0.0.1:9100
npm test
npm run lint
```

`npm run build` compiles `src2/` to `lib/` and `npm run build.web` bundles the
app to `dist/`, both at the root, which is where the service and Caddy look.

**Run `npm run prepare` once**, per clone rather than per worktree. It installs
the husky hook that lints before every commit. `npm install` will not do it for
you: `.npmrc` sets `ignore-scripts`, which is what makes a fresh install safe
and also what stops `prepare` running. Without it there is no gate, and the
lint count drifts — it reached 98 the last time nobody was counting. The hook
sets `core.hooksPath`, which lives in `.git/config` and so is shared by every
worktree of this repository.

Configuration is written by `cleaner-config` to `serverConfig.json` **at the
root** on first run; it is gitignored, and every field has a default.

## Live streaming

A game can be given a stream URL with its key in it — `rtmp://host:1936/live/…`
— which is pasted into streaming software or picked from a list by GS Director.
One stream arrives and is recorded as this machine's own HLS, `-c copy`. The
split can also send it onward to further RTMP destinations, also `-c copy`.

| Piece | Where |
| --- | --- |
| The RTMP ingest and the split | `src2/server/live/splitter.ts` — node-media-server, one ffmpeg child per leg |
| What keeps it in step with the database | `src2/server/live/controller.ts` |
| Keys, their window, and sealing | `src2/server/live/streamKeys.ts`, `src2/server/live/secrets.ts` |
| Turning a finished stream into a recording | `src2/server/live/finishVideo.ts` |
| The Space, and proving the copy arrived | `src2/server/media/spacesVideo.ts` |

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
