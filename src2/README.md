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
