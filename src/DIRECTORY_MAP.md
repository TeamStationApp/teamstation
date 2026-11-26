# TeamStation source map

Paths are relative to src/. Use the narrowest outline, definition lookup, search or read. The index contains shipped text; tests and fixtures are searchable with includeTests.

Entry points: `server/index.ts` (HTTP), `server/ingest/run.ts` (ingest), `logServer/main.ts` (logs), `app/App.tsx` (app), `app/web/index.tsx` (web app), `app/web/iosAppBanner.ts` (Safari banner), `app/native/index.tsx` (native).
API contract/client: `common/api.ts`; OpenAPI: `server/openapi.ts`; HTTP boundaries: `server/routes/` (domain logic in sibling server folders).
Navigation/deep links: `app/navigation/`; screens: `app/screens/`; shared UI: `app/components/`, `app/hooks/`, `app/theme/`; platform adapters: `app/platform/`.
Database types/connections: `server/db/`; schema changes: `migrate/cli.ts`, `migrate/migrations/`.
Tess: `app/tess/`, `server/tess/`. Tool rounds: `server/tess/agent.ts`; budgets/compaction: `server/tess/compaction.ts`; instructions: `server/tess/prompt.ts`; dispatch: `server/tess/tools.ts`; indexed reads/search/outline: `server/tess/sourceTools.ts`; index builder/parser/schema: `server/tess/sourceIndex/`.
Scoring: `app/scoring/`, `common/scoring/`, `server/scoring/`; game state/persistence: `server/games/`, `server/events/`; shared event model: `common/gumbo/`.
Scheduling: `server/schedule/`; automatic placement: `common/autoScheduler/`, `server/autoScheduler/`; scheduling setup: `server/scheduler/`.
Identity/access: `server/auth/`, `server/access.ts`, `server/middleware/`, `server/users/`; accounts: `server/account/`; teams/rosters: `server/teams/`; groups/leagues: `server/groups/`; guardians: `server/people/`; joining: `server/invites/`.
Chat: `app/chat/`, `server/chat/`, `common/chatCrypto/`, `common/chatLinkPreview.ts` (private preview payloads); offline/cache/outbox: `app/sync/`; shared Valkey connections: `server/valkey/`; sockets/change feed: `server/socket/`, `server/changeFeed/`.
Umpires: `app/umpires/`, `server/umpires/`; scoreboards: `app/scoreboard/`, `common/scoreboard.ts`, `server/scoreboard/`.
Statistics: `server/stats/`, `server/statsBuilder/`; read-only queries: `server/graphql/`.
Video: `app/player/`, `app/stream/`, `server/media/`, `server/live/`, `server/ingest/`; recording orchestration: `server/director/`.
Replay/narration: `app/replay/`, `common/replay/`, `server/replay/`; TV: `app/tv/`; ballpark rendering: `app/field/`.
Dictation: `server/dictation/`; music/audio: `app/walkup/`; haptics: `app/feedback/`.
Places/venues: `server/location/`, `server/venues/`; notifications: `server/notifications/`; mail: `server/email/`; OAuth: `app/oauth/`, `server/oauth/`; app sign-in links: `server/appLinks/`.
Observability: `app/observability/`, `common/observability/`, `server/observability/`; error privacy: `common/sentry/`, `server/sentry/`.
Build: `build.mjs`, `buildCsp.mjs`; native guidance: `MOBILE.md`; shared test harnesses/fixtures: `test/`; development utilities: `server/dev/`.

Conventions: .native.ts/.native.tsx specialize native behavior; unsuffixed files usually serve web. Colocated .test/.spec files are unit tests, .integration.test files use real boundaries, .e2e and external-model .integration files are explicit runs. Read tests for intended behavior and edge cases. Keep this map within 4,000 characters and update it in the same commit as structural source changes; name only indexed paths.
