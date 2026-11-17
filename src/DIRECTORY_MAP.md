# Source directory map

Read this map first when answering how TeamStation works. Choose a relevant directory or entry point, then list, read or search that scope. Paths below are relative to the repository root; source tools can access only `src/`. The map describes code, not live account or team data.

## Entry points and common questions

- Server startup and service wiring: `src/server/index.ts`.
- API contracts and client: `src/common/api.ts`; HTTP routes: `src/server/routes/`; OpenAPI: `src/server/openapi.ts`.
- App navigation and rendering: `src/app/App.tsx`, `src/app/navigation/routes.ts`, `src/app/web/index.tsx`, `src/app/native/index.tsx`.
- Tess response/tool rounds and limits: `src/server/tess/agent.ts`; tool dispatch: `src/server/tess/tools.ts`; source boundary and map-first state: `src/server/tess/sourceTools.ts`.
- Tess instructions: `src/server/tess/prompt.ts`; model requests: `src/server/tess/messagesApi.ts`; progress labels: `src/server/tess/stepLabels.ts`; HTTP entry: `src/server/routes/tess.ts`.
- Tess context budgets and summarization: `src/server/tess/compaction.ts`, with budget unit checks in `src/server/tess/compaction.test.ts` and conversation checks in `src/server/tess/compaction.integration.test.ts`.
- Tess source tests: `src/server/tess/sourceTools.test.ts` and `src/server/tess/sourceTools.integration.test.ts`; real-model checks: `src/server/tess/tess.integration.ts`.
- Scoring rules: `src/common/scoring/`; scoring controls: `src/app/scoring/`; persistence: `src/server/scoring/` and `src/server/events/`.
- Schedules: `src/server/schedule/`; automatic placement: `src/common/autoScheduler/` and `src/server/autoScheduler/`.
- Access and identity: `src/server/access.ts`, `src/server/auth/`, `src/server/middleware/`, `src/server/users/`.
- Chat: `src/app/chat/`, `src/server/chat/`, `src/common/chatCrypto/`; offline sync: `src/app/sync/`.
- Video: `src/app/player/`, `src/app/stream/`, `src/server/media/`, `src/server/live/`, `src/server/ingest/`.
- Database schema: `src/server/db/database.ts`; migrations: `src/migrate/cli.ts` and `src/migrate/migrations/`.
- Web build: `src/build.mjs` and `src/buildCsp.mjs`; native guidance: `src/MOBILE.md`.

## Directories

| Directory | Responsibility |
| --- | --- |
| `src/app/` | Shared React web and React Native application. Start at App.tsx; screens use common API types. |
| `src/app/assets/` | Bundled images, fonts and asset entry points, including platform-specific exports. |
| `src/app/chat/` | Encrypted messaging UI, conversation state, attachments, history recovery and safety controls. |
| `src/app/components/` | Reusable UI controls, lists, sheets, navigation chrome and domain widgets. |
| `src/app/dev/` | Development-only chat bench and probes. |
| `src/app/feedback/` | Native haptic feedback interface. |
| `src/app/field/` | Three-dimensional ballpark, player rigs, field rendering and camera controls. |
| `src/app/hooks/` | Shared React hooks for requests, pagination, screen scope and lifecycle. |
| `src/app/layout/` | Shared layout measurements and watch layouts. |
| `src/app/locales/` | User-facing strings and locale lookup. |
| `src/app/native/` | Native application entry and configuration; expoStandIn/ provides the minimal Expo adapter. |
| `src/app/navigation/` | Routes, deep links, navigation stacks, history and screen identity. |
| `src/app/oauth/` | OAuth approval client. |
| `src/app/observability/` | Client analytics, logging and player instrumentation. |
| `src/app/platform/` | Web/native adapters for storage, clipboard, location and other platform services. |
| `src/app/player/` | Video player surfaces, multicamera viewing, angle selection and playback helpers. |
| `src/app/replay/` | Game replay screens, narration playback and replay timelines. |
| `src/app/scoreboard/` | Scoreboard screens, dashboard, overrides and route/client helpers. |
| `src/app/scoring/` | Scoring UI, defense, roster and dictation controls. Domain scoring rules live in common/scoring/. |
| `src/app/screens/` | Application screens for accounts, teams, seasons, events, players and administration. |
| `src/app/stream/` | Live stream/camera setup, uploads, previews and stream controls. |
| `src/app/sync/` | Client caches, offline outbox, optimistic writes, reachability and synchronization. |
| `src/app/tess/` | Tess chat UI, composer, attachments, rich replies, progress and hold-to-confirm controls. |
| `src/app/theme/` | Theme context, colors, fonts, elevations and sizing tokens. |
| `src/app/tv/` | TV application, browsing, remote interaction and playback. |
| `src/app/umpires/` | Umpire administration, scheduling, requirements and leaderboard UI. |
| `src/app/walkup/` | Walk-up music, DJ controls and native audio/dictation interfaces. |
| `src/app/web/` | Web entry, page templates and static web assets. |
| `src/common/` | Shared API client/contracts and domain logic used by both the app and server. Start at api.ts. |
| `src/common/autoScheduler/` | Shared scheduling algorithm, capacity, placement, scoring and constraints. |
| `src/common/chatCrypto/` | Encryption protocol and native/web/node adapters; node/ and wasm/ include generated build products. |
| `src/common/gumbo/` | Gumbo game/event data model and transformations. |
| `src/common/observability/` | Shared analytics and event contracts. |
| `src/common/replay/` | Shared replay and narration domain helpers. |
| `src/common/scoring/` | Scoring rules, event folding, scoreboards, runners, lineups and statistics inputs. |
| `src/common/sentry/` | Shared error-reporting privacy and configuration helpers. |
| `src/deploy/` | Public deployment notes and media-origin helper; private deployment settings are not source. |
| `src/logServer/` | Log collection service, storage adapters and spool handling. Start at main.ts and app.ts. |
| `src/maestro/` | Legacy UI test flows. Current UI tests use TypeScript with maestro-d. |
| `src/migrate/` | Database migration runner and ordered schema/data migrations. Start at cli.ts and migrations/. |
| `src/migrate/migrations/` | Ordered migrations and migration-specific integration tests. |
| `src/server/` | HTTP server, authentication, domain services and background workers. Start at index.ts and routes/. |
| `src/server/account/` | Account lifecycle and deletion. |
| `src/server/admin/` | Server administration services. |
| `src/server/appLinks/` | Sign-in deep-link configuration and app-link validation. |
| `src/server/auth/` | Sessions, tokens, authentication and sign-in logic. |
| `src/server/autoScheduler/` | Scheduling previews, constraints, proposals and publication. |
| `src/server/cache/` | Valkey-backed cache adapter. |
| `src/server/changeFeed/` | Database change feed, subscriptions and cross-worker relays. |
| `src/server/chat/` | Encrypted chat APIs, audiences, blocks, attachments, keys and history recovery. |
| `src/server/db/` | Database schema types, connection setup, transactions and query helpers. |
| `src/server/dev/` | Development fixtures, seeders, audit and repair command-line tools; source reads never execute them. |
| `src/server/dictation/` | Scoring dictation, interpretation prompts, speech recognition and game-state context. |
| `src/server/director/` | Director uploads and game recording orchestration. |
| `src/server/email/` | Account mail and SMTP transport. |
| `src/server/events/` | Game event reads/writes, credits, tags and play times. |
| `src/server/games/` | Game plans, guests, rosters, live state, resets and scoring activity. |
| `src/server/graphql/` | Read-only GraphQL schema and REST-backed/statistical readers. |
| `src/server/groups/` | Group creation, ownership, follows, privacy and related-team services. |
| `src/server/home/` | Home-screen list queries. |
| `src/server/ingest/` | Live-ingest process entry and runtime. |
| `src/server/invites/` | Invitations, grants, joining and person requests. |
| `src/server/live/` | Live media decoding, publishing, playlists, hole filling and timing. |
| `src/server/location/` | Place search, geocoding, coordinate timezones and bundled place catalog. |
| `src/server/media/` | Media storage, signed URLs, images, HLS, FFmpeg, ingestion and wall-clock alignment. |
| `src/server/middleware/` | Authentication, authorization limits, auditing, CORS and error handling. |
| `src/server/notifications/` | Inbox, recording reminders and completion/request notices. |
| `src/server/oauth/` | OAuth provider, adapters, routes and maintenance. |
| `src/server/observability/` | Server logging, analytics, queries and outcomes. |
| `src/server/people/` | Guardian relationships. |
| `src/server/replay/` | Replay availability, narration and speech services. |
| `src/server/routes/` | HTTP route registration and request/response boundaries. Domain services live in sibling directories. |
| `src/server/schedule/` | Game scheduling, approvals, consent, cursors and pending projections. |
| `src/server/scheduler/` | Scheduling setup and its API definitions. |
| `src/server/scoreboard/` | Scoreboard service, storage, event logs, timelines and subscriptions. |
| `src/server/scoring/` | Scoring persistence, projections, conflicts and historical/game statistics. |
| `src/server/sentry/` | Server error-reporting instrumentation and options. |
| `src/server/socket/` | WebSocket upgrades, game/chat fanout, screen scope and sync revisions. |
| `src/server/stats/` | Box scores, plate appearances, expanded stats, records and splits. |
| `src/server/statsBuilder/` | Background statistics builder, requests, supervision and CLI. |
| `src/server/teams/` | Team creation, roster operations, people profiles, opponents and head coaches. |
| `src/server/tess/` | Tess agent, model API, prompts, tools, conversation history, attachments and usage. |
| `src/server/umpires/` | Umpire types, affiliations, assignments, presence, schedules and notes. |
| `src/server/users/` | User identity, names, privacy-aware readers, affiliations and candidates. |
| `src/server/venues/` | Venue ownership, occupancy, field warnings and notices. |
| `src/test/` | Shared fixtures, HTTP/database harnesses, browser/native test utilities and end-to-end scenarios. |
| `src/test/concurrentScoring/` | Concurrent scoring fixtures, network recovery and conflicting-write scenarios. |
| `src/test/fixtures/` | Small test media assets. |
| `src/test/stubs/` | Platform stand-ins used by tests. |
| `src/tools/` | Asset generation and screenshot utilities. |

## File conventions

- `.native.ts` / `.native.tsx` specialize native behavior; web files usually use the unsuffixed name. Inspect both when a question spans platforms.
- Tests are beside the code: `.test.ts` / `.test.tsx` for unit behavior, `.integration.test.ts` for integration, and `.e2e.ts` / external-model `.integration.ts` for explicit end-to-end runs. Shared fixtures live under `src/test/`.
- Nested asset, fixture and generated-code folders belong to their nearest directory above. Read the entry point before searching them. Binary assets and oversized generated files are not suitable for source excerpts.
- This map is a navigation index, not a list of every file. When source files or directories are added, moved, renamed, deleted or structurally changed, check this map and include any required update in the same commit.
