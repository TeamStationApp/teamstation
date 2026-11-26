# TeamStation API rate limits

The proposed defaults give an account 600 requests per minute across its sessions and devices. Within that total, it can make 150 aggregate requests or 20 expensive requests per minute. A guest network gets 240, 150 and 6 respectively. A separate ceiling allows many signed-in families to use the same field or school network. These are starting values informed by fixture measurements. Production traffic percentiles and the number of viewers behind a busy venue IP have yet to be measured.

## Provisional budgets

Each cell gives **sustained requests per minute / immediate burst after idle**. Capacity refills continuously. For example, an idle account can make eight expensive calls immediately and earns another every three seconds. Changing paths, resource IDs, credentials belonging to the same account, or API workers does not replenish the shared allowance.

| Traffic | Per signed-in account | Per IP, signed-in traffic | Per IP, guest traffic |
| --- | ---: | ---: | ---: |
| All API arrivals, before credential lookup | — | 6,000 / 1,500 across **all** arrivals | Shares that same 6,000 / 1,500 |
| All admitted operations, including costlier tiers | 600 / 180 | Covered by the arrival ceiling | 240 / 100 |
| Aggregate operations | 150 / 48 | 1,500 / 360 | 150 / 32 |
| Expensive operations | 20 / 8 | 240 / 64 | 6 / 4 |
| Games submitted to the batch scheduling endpoint, **rows** per minute / burst | 60 / 200 | 300 / 400 | Sign-in required |

An aggregate or expensive operation consumes both its general allowance and its specific tier. Each tier is shared among all operations assigned to it. A denied tier check leaves the caller's other operation budgets available. The earlier IP arrival is still counted. A batch of up to 200 games also consumes one unit per submitted row before the schedule handler begins. A full import can start from idle, and the next full import from that account earns its rows back in 200 seconds.

## What the database measurements showed

The table counts statements observed at the PostgreSQL client during real HTTP requests to the app's route handlers at revision `c82ea44c2`, including credential resolution. The probes used the repository's group fixture and counted calls to the PostgreSQL driver between sending each request and consuming its response. The isolated fixture had two newly created leagues, affiliated and standalone groups, and 32 games, ten final and 22 scheduled. The signed-in reader managed a team and league and had no site-administrator privilege. Read probes ran three times sequentially. Rows in a range show the first and subsequent requests. The roster probe used the route without the shared roster cache, representing a cold read. The fixture contained no production records.

| Operation | Caller | SQL statements per request |
| --- | --- | ---: |
| Clock | Guest / signed in | 0 / 2 |
| Health | Guest | 2 first, then 1 |
| Public team discovery / team detail | Guest | 17 / 24 |
| Public team's paged games / game detail | Guest | 5 / 9 |
| Current session / account roles | Signed in | 6 / 10 |
| Home / my groups / notification summary | Signed in | 33 / 36 / 23 |
| Offline-scoring manifest | Signed in | 6 |
| Paged events / team's paged games | Signed in | 21 / 20 |
| Roster / team statistics / season standings | Signed in | 38 / 14 / 21 |
| Game detail / box score | Signed in | 39 / 21 |
| GraphQL team with nested games | Signed in | 96–99 across the two fixture configurations |
| Successfully create 1 / 10 / 50 / 200 games | Signed in | **65 / 524 / 2,564 / 10,214** |
| Submit 1 / 10 / 50 / 200 games with every row refused | Signed in | **78 / 654 / 3,214 / 12,814** |

The 200-game figures come from the follow-up baseline run at `04758cfd3`. The GraphQL read and each batch size ran once per fixture configuration. With the teams enrolled in the season and the requisite permissions, every submitted game was created. In the other configuration, each row reported an error. Both returned HTTP 200. The row budget therefore counts submissions before checking the individual games. Database row counts, query plans, execution time, object storage and model usage can change cost even when statement counts stay constant. Season statistics aggregate many rows, a player's highlights can scan 500 plays, an umpire schedule computes the filtered schedule before pagination, and GraphQL can issue multiple REST reads. The umpire probe received a permission refusal, so its classification comes from the handler. Schedule preparation and publication, account removal, large media finalization and Tess generation are also classified from code. No paid generation was invoked.

## How the defaults fit the clients

- **Opening the app and scoring offline.** Home, roles, groups, inbox and roster can arrive together. The offline manifest selects up to three games. Each package can read six game documents and three documents for each of two teams. Even with distinct teams, that is at most 36 package reads before the usual benefits of shared teams or cached data. The account aggregate burst of 48 makes room for these and the initial screen. The existing offline outbox treats a rate-limit response as retryable.
- **Watching and scoring.** A camera wall-timeline poll every four seconds is 15 requests per minute. A scoreboard timeline at ten seconds is six. Wall timeline, playback and media files use the ordinary budget. Game data, play history and scoreboard timeline use the aggregate budget. A signed-out live replay polling game and plays every five seconds can use 24 aggregate requests per minute. Four viewers consume 96 of the 150 guest aggregate requests per minute. Six consume 144. Each five-second poll also spends an arrival and guest general allowance for each request.
- **Browsing and searching.** Team, league and season discovery, directories, the home feed and expensive list/detail projections share the aggregate budget. The search socket charges that budget for each search it actually executes, after coalescing pending keystrokes. The maximum-cost paths share the expensive budget. Other screen reads and writes still have a finite general limit.
- **Identity and privileged tools.** Password, email-code, TV approval, invitations, paid place lookups and guardian requests keep their existing narrower limits. API keys, machine tokens and Tess calls use the verified account ID. A valid session on a second device shares the first device's allowance. Invalid credentials fall under the guest IP allowance after lookup. The pre-authentication ceiling bounds those lookups even when every credential is different.
- **Transports.** The HTTP policy covers the versioned API and OAuth, including unknown versioned paths. The cheap CORS preflight exits before metering. WebSocket handshakes consume an IP arrival and an aggregate operation, including game, scoreboard, search and dictation connections. Search requests on an established connection also consume an aggregate operation. Ongoing audio, scoreboard messages, game subscriptions, pings and server-pushed changes use their respective protocol controls. A connection limit alone does not bound work on an already-open socket. Static assets, direct media delivery outside the API and internal media authorization are outside the HTTP budget.

## Choosing a mode

Set `apiRateLimitMode` consistently across a deployment. The default, `observe`, meters traffic against a shadow allowance and lets the application handle every request. Once a request would be refused, later gates skip that request. A search socket that would be refused or closed keeps serving its observer, and further frames on it spend no shadow allowance. `enforce` uses the same decisions and sends the retry signals described below. `off` skips these gates and their upgrade identity lookup. Each mode preserves the existing dedicated login, email-code, invitation and paid-lookup protections.

Each worker reports its startup mode. Shadow and enforcement counters use separate, versioned keys under the deployment prefix. A new namespace starts with full buckets; returning to one before its counters expire resumes its outstanding debt. During a rolling change, old and new workers can give the same caller different outcomes. Switch the whole deployment together or drain the old worker group before sending callers to the new one. Roll back to `observe` to continue measuring, or `off` to remove the meter's store traffic.

Each worker exports minute summaries through operational logging, or its service log when no collector DSN is configured. `api_rate_decisions` counts decisions, attempted and admitted units (games for the row tier), and cumulative latency bins of 1, 5, 20 and 100 milliseconds. Group by mode, requested tier, transport, backend, scope, limiting tier, outcome and fault class. In observe, a refused decision predicts a refusal. If the meter cannot resolve an upgrade credential, the protocol handler continues with its usual authentication. The worker counts these skipped identity checks in `api_rate_upgrade_identity_missed`. `api_rate_store` gives the milliseconds spent on per-worker counters. `api_rate_demand` summarizes per-bucket demand within each worker's sample, including the p50, p95 and maximum one-second and ten-second bucket peaks and reporting-interval totals. Counts use fixed windows, with partial windows at flush or shutdown. Each interval selects roughly one eighth of bucket keys by a rotating keyed digest, capped at 1,024; digests stay in memory until flush. These worker-local observations cover attempted gates reached by the trace. A deployment-wide peak needs shared replay or a complete workload measurement.

## Enforcement and verification

IP identity comes from the existing trusted-proxy resolution. IPv4 and IPv4-mapped IPv6 share a key. IPv6 privacy addresses share their /64. Unusable addresses share one fallback identity. Within a deployment, Valkey uses its own clock and checks all keys for an admission atomically. Keys expire as the allowance refills. Normal HTTP metering adds no PostgreSQL queries. A handshake for an enabled protocol with a credential does a read-only identity lookup before the socket's normal authentication. An unrecognized upgrade path uses only its arrival allowance.

An HTTP refusal returns **429**, the standard `rateLimited` body and the wait in both `Retry-After` and `details.retryAfterSec`. An over-budget search on an open socket closes with 1013 and the wait in its reason. While Valkey is unavailable, each worker enforces bounded local counters and logs that it has switched. During that interval a caller reaching several workers can receive up to one allowance per worker. Recovery resumes the shared counters. A search client receiving close code 1013 waits for both a new handshake and its next search. When admission refuses a Tess write before execution, its retry interval allows for both the next confirmation and its write. The pending entry shows its remaining wait. If the proposal expires before that retry, Tess asks for a fresh proposal. Completed entries in the batch keep their results. These budgets are request-rate controls. They do not cap simultaneous long-running jobs or traffic distributed across many independent accounts and networks.

Each worker verifies its configured writer at startup and after reconnect with the production script and unique, one-second probe keys in its own deployment, policy and mode namespace. A script-cache miss loads the script normally. An uncertain answer is never replayed against the primary. A failed check switches the worker to local allowances and the worker retries a disposable probe every five seconds while connected. A successful probe resumes the remaining shared debt. A worker restart resets only its local allowance. Data loss at the primary, including during a managed failover, can reset shared debt.

The health response's `apiRateLimits` field reports this worker’s mode, shared readiness and milliseconds degraded. `ready` means a representative shared write succeeded. `degraded` identifies a temporary connection failure or timeout. `failed` identifies a permission, read-only writer, unsupported cluster or other store configuration error. The worker keeps serving during either fault. An admitted health check reports database availability in its status and HTTP response. A public probe can receive HTTP 429 with `Retry-After` from the arrival or guest-IP gate before the health handler runs. That response measures traffic pressure. To read readiness, probe each worker from a separately addressed monitor at a pace below its IP budgets, or inspect the worker’s startup mode and rate-store diagnostics. With N degraded workers, one caller routed across all of them may receive N independent allowances.

Before enabling enforcement or after changing a managed writer, compare every worker’s mode, deployment prefix and policy version. Check the writer role and primary identity through the provider, then run an isolated multi-worker burst against the same fixture account and verify it gets one allowance across workers. Repeat after a managed failover and confirm each worker reports ready. A sharded Redis Cluster requires all keys of one script to belong to one hash slot. These independent account and IP keys target a single writable primary. Cross-slot and redirection replies are reported as a cluster configuration fault. A read-only reply points to the wrong writer. A permission failure requires access to the entire limiter namespace and the commands the script uses.

Integration tests cover simultaneous requests through two API workers, two valid sessions on one account, an invalid credential, independent guest networks, continued lightweight reads after an expensive refusal, HTTP and socket retry signals, and the fallback when a shared store is unavailable. Before tuning the defaults, compare first refusals by tier, transport and limiting scope with peak venue traffic, scorekeeper reconnects, API latency and database load. To identify which workflow needs headroom, replay its known operations against an isolated fixture and compare their refusal and latency distributions with those tier summaries. A steady pattern of guest replay refusals alongside healthy database load is a reason to raise the guest aggregate allowance. Saturation from imports points to the row budget.

## Game-day verification

Run the workload on a disposable API test machine with the integration suite's PostgreSQL and Valkey URLs. Each invocation creates a synthetic database and starts two workers. For example, `node -r sucrase/register scripts/apiRateWorkload.cjs enforce scoring` opens the client cache, disconnects, queues two scoring edits and checks the persisted plays after reconnect. Replace `scoring` with `venue` or `schedule`, and repeat with `off` and `observe` to compare decisions against the unmetered workload.

The driver records statement counts, cumulative query round-trip time, time obtaining a pool connection, and HTTP handler latency through response completion. Concurrent query times can overlap. All latency values come from the isolated test machine. They include application and fixture overhead.

### Shared venue

With the original 100/minute guest aggregate allowance and a burst of 32, four viewers got their normal responses for all 144 requests over 18 five-second polls. Six viewers made 216 requests and received 43 HTTP 429s. The observed retry was one second. Each readable game-detail response used nine SQL statements. The playback box-score endpoint required sign-in and returned 401 before any SQL. Both requests consumed the aggregate budget. The two signed-in spectators on the same IP made 36 successful reads per cohort.

The candidate raises the guest aggregate allowance to 150/minute, keeping the immediate burst at 32. This covers the measured six-viewer polling rate with six aggregate requests per minute left for other activity on the same address. The policy namespace moves to v2 so outstanding timestamps earned at the old refill rate do not carry into the new policy.

At 150/minute in enforce, four viewers completed 144 requests and six completed 216, all with their normal status. At eight viewers (192 requests/minute), 44 of 288 requests received HTTP 429. Observe predicted 44 first refusals at eight viewers while allowing all 288 requests to complete. Each enforced refusal used zero SQL statements, and a subsequent read succeeded after its one-second retry delay. Both member spectators kept receiving HTTP 200s throughout, and both search socket handshakes completed. These sustained runs include the initial full burst.

### Native playlist reloads

A development fixture replayed 17 native viewers sharing one address. Each viewer requested a valid signed playlist every four seconds for 32 polls. Four unrelated guests each made one ordinary request on the same cadence. In the original guest policy, one camera produced 19 playlist refusals in 544 requests and 57 ordinary refusals in 128 requests. With two independent live cameras, 506 of 1,088 playlist requests and 114 of 128 ordinary requests received HTTP 429. A successful playlist request used one SQL statement; across both cohorts its p95 response time was 82 ms. Refusals used zero statements and specified a one-second retry. The synthetic player sent its media capability and no account session, matching a native playlist reload.

### App launch and offline scoring

The five concurrent launch requests, three cached game packages and two queued edits completed in every mode. The client verified both stored plays after reconnect. The three modes executed the same number of SQL statements. P95 is the slowest sample in the four-request reconnect phase and the five-request launch phase.

| Journey | HTTP requests | Total SQL | HTTP p95 ms, off / observe / enforce | Enforce pool wait p95 ms |
| --- | ---: | ---: | ---: | ---: |
| Launch | 5 | 111 | 417 / 224 / 310 | 236.9 |
| Load three packages | 23 | 977 | 953 / 767 / 780 | 24.9 |
| Replay and verify two edits | 4 | 256 | 271 / 324 / 204 | 2.1 |

### Scheduling

Each batch used a fresh account on the same address. In mixed batches, alternating rows named a missing opponent. Invalid rows reached business validation and spent the same row units as successful rows.

| Rows | Created / row errors | SQL | Enforce HTTP ms | Cumulative query ms | Cumulative pool wait ms |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 / 0 | 64 | 274 | 137 | 3.5 |
| 10 | 5 / 5 | 388 | 648 | 455 | 3.3 |
| 50 | 25 / 25 | 1,586 | 7,463 | 6,969 | 14.9 |
| 200 | 100 / 100 | 6,311 | 5,529 | 4,616 | 23.2 |

A repeat of the 200-row batch returned HTTP 429 after two credential statements. The response gave 195 seconds in both retry fields. After waiting, the client received HTTP 200 with 100 unchanged games and 100 row errors. That retry used 4,511 statements. In observe, the immediate retry ran the same 4,511 statements and recorded one predicted refusal. In off, it completed without metering.

### Whole-deployment mode switch

During a single two-worker deployment's off → observe → enforce → observe sequence, eight identical expensive guest calls reached their normal authentication response in off and observe. In enforce, four reached authentication and four received HTTP 429 with a ten-second retry delay. After switching back to observe all eight reached authentication again. Ordinary reads completed in every phase. Both workers reported ready on the shared store in each metered phase.

### Production observation

All thresholds remain provisional. The rollout owner reviews observation data before promotion. During a busy game period, measure the distribution of viewers behind one address, per-tier and per-scope predicted refusals, scorekeeper reconnects, scheduling retries, store-check p95/p99, HTTP latency, query time and pool waits. Agree on acceptable interruption rates and latency headroom before enforcement. Roll back a deployment to `observe` if ordinary viewing or scoring is interrupted or shared readiness fails persistently. Select `off` when limiter store traffic itself is contributing to an incident.

## Operation inventory

The following table groups the published API contract by path and method. A cell lists the tier for each method. HTTP HEAD inherits GET. WebSocket upgrades use the handshake rule above. Resource parameters in braces represent every ID. All methods share their caller's general allowance.

| Path | Ordinary | Aggregate | Expensive |
| --- | --- | --- | --- |
| `/admin/analytics/query` | — | — | POST |
| `/admin/chat/reports` | GET | — | — |
| `/admin/chat/reports/{reportId}/resolve` | PUT | — | — |
| `/admin/test-error` | POST | — | — |
| `/analytics/events` | POST | — | — |
| `/auth/email-code` | POST | — | — |
| `/auth/email-code/verify` | POST | — | — |
| `/auth/link/verify` | POST | — | — |
| `/auth/logout` | POST | — | — |
| `/auth/me` | GET | — | — |
| `/auth/password` | POST | — | — |
| `/auth/password/parameters` | POST | — | — |
| `/auth/request/claim` | POST | — | — |
| `/auth/tv/approve` | POST | — | — |
| `/auth/tv/claim` | POST | — | — |
| `/auth/tv/inspect` | POST | — | — |
| `/auth/tv/start` | POST | — | — |
| `/chat/attachments` | POST | — | — |
| `/chat/attachments/{attachmentId}` | GET | — | — |
| `/chat/attachments/{attachmentId}/complete` | POST | — | — |
| `/chat/attachments/{attachmentId}/parts/{index}` | PUT | — | — |
| `/chat/blocks` | GET | — | — |
| `/chat/blocks/{userId}` | PUT, DELETE | — | — |
| `/chat/conversations` | — | GET | — |
| `/chat/conversations/{conversationId}/epochs` | GET, POST | — | — |
| `/chat/conversations/{conversationId}/log` | GET | — | — |
| `/chat/conversations/{conversationId}/members` | GET | — | — |
| `/chat/conversations/{conversationId}/messages` | GET, POST | — | — |
| `/chat/conversations/{conversationId}/pins` | GET | — | — |
| `/chat/conversations/{conversationId}/pins/{messageId}` | PUT, DELETE | — | — |
| `/chat/conversations/{conversationId}/preferences` | PATCH | — | — |
| `/chat/conversations/{conversationId}/read` | PUT | — | — |
| `/chat/conversations/{conversationId}/reads` | GET | — | — |
| `/chat/devices` | GET, POST | — | — |
| `/chat/devices/{deviceId}` | DELETE | — | — |
| `/chat/devices/{deviceId}/resume` | POST | — | — |
| `/chat/devices/{deviceId}/resume-challenge` | POST | — | — |
| `/chat/dm-candidates` | — | GET | — |
| `/chat/dm-proxies` | — | GET | — |
| `/chat/dm-reach` | — | GET | — |
| `/chat/dms` | POST | — | — |
| `/chat/dms/{conversationId}/members` | POST | — | — |
| `/chat/dms/{conversationId}/members/me` | DELETE | — | — |
| `/chat/grants` | GET, POST | — | — |
| `/chat/identities/{identityId}` | GET | — | — |
| `/chat/identity` | PUT | — | — |
| `/chat/identity/reset` | POST | — | — |
| `/chat/included-adults` | — | GET | — |
| `/chat/links` | GET, POST | — | — |
| `/chat/links/{linkId}` | GET | — | — |
| `/chat/links/{linkId}/approve` | POST | — | — |
| `/chat/links/{linkId}/decline` | POST | — | — |
| `/chat/me/keys` | GET | — | — |
| `/chat/puk` | POST | — | — |
| `/chat/reports` | POST | — | — |
| `/chat/users/{userId}/keys` | GET | — | — |
| `/device-event-control/key` | GET | — | — |
| `/director/events/{gameId}/claim` | POST | — | — |
| `/director/events/{gameId}/stream` | GET | — | — |
| `/director/uploads` | POST | — | — |
| `/director/uploads/{uploadId}` | GET, DELETE | — | — |
| `/director/uploads/{uploadId}/finish` | — | — | POST |
| `/director/uploads/{uploadId}/parts/{index}` | PUT | — | — |
| `/events` | — | GET, POST | — |
| `/events/{id}/info` | — | GET, PUT | — |
| `/events/{id}/location` | GET | — | — |
| `/events/{id}/rsvps/{userId}` | PUT | — | — |
| `/game-requests` | — | GET, POST | — |
| `/game-requests/{id}/accept` | — | POST | — |
| `/game-requests/{id}/decline` | — | POST | — |
| `/game-requests/{id}/resend` | — | POST | — |
| `/game-requests/{id}/schedule-entry` | — | DELETE | — |
| `/game-requests/{id}/withdraw` | — | POST | — |
| `/games/{gameId}` | — | GET | — |
| `/games/{gameId}/box-score` | — | GET | — |
| `/games/{gameId}/dj` | GET | — | — |
| `/games/{gameId}/events` | — | GET, POST, PATCH | — |
| `/games/{gameId}/field` | PUT | — | — |
| `/games/{gameId}/guest-players` | POST | — | — |
| `/games/{gameId}/guest-players/{userId}` | PUT | — | — |
| `/games/{gameId}/guests/external` | POST | — | — |
| `/games/{gameId}/halves` | — | GET | — |
| `/games/{gameId}/line-score` | — | GET | — |
| `/games/{gameId}/lineups` | — | GET, POST | — |
| `/games/{gameId}/live-streams` | GET, POST | — | — |
| `/games/{gameId}/live-streams/{streamId}` | PATCH, DELETE | — | — |
| `/games/{gameId}/live-streams/{streamId}/discard` | POST | — | — |
| `/games/{gameId}/live-streams/{streamId}/end` | POST | — | — |
| `/games/{gameId}/live-streams/{streamId}/reveal` | POST | — | — |
| `/games/{gameId}/live-streams/{streamId}/revoke` | POST | — | — |
| `/games/{gameId}/live-streams/{streamId}/rotate` | POST | — | — |
| `/games/{gameId}/narrations/{stepKey}` | — | GET | — |
| `/games/{gameId}/plans` | — | GET | — |
| `/games/{gameId}/plans/{teamId}` | — | PUT | — |
| `/games/{gameId}/plans/{teamId}/innings/{inning}` | — | GET | — |
| `/games/{gameId}/scheduling` | GET | — | — |
| `/games/{gameId}/scoreboard-overlay` | GET | — | — |
| `/games/{gameId}/scoreboard-timeline` | — | GET | — |
| `/games/{gameId}/sponsors` | GET | — | — |
| `/games/{gameId}/stream-access` | GET | — | — |
| `/games/{gameId}/swap-sides` | POST | — | — |
| `/games/{gameId}/tags/{targetId}` | PUT, DELETE | — | — |
| `/games/{gameId}/umpire-notes/{typeId}` | PUT | — | — |
| `/games/{gameId}/umpire-slots` | POST, DELETE | — | — |
| `/games/{gameId}/unroster` | PUT | — | — |
| `/games/{gameId}/withdrawals` | POST | — | — |
| `/graphql` | — | — | POST |
| `/groups/{kind}/{id}` | — | PUT | — |
| `/health` | GET | — | — |
| `/invites` | GET, POST | — | — |
| `/invites/{id}` | DELETE | — | — |
| `/join/{code}` | GET | — | — |
| `/join/{code}/email-code` | POST | — | — |
| `/join/{code}/redeem` | POST | — | — |
| `/leagues` | — | GET, POST | — |
| `/leagues/{id}` | — | GET | — |
| `/leagues/{id}/people` | — | GET | — |
| `/leagues/{id}/people/{userId}` | — | GET | — |
| `/leagues/{leagueId}/games-to-reschedule` | — | GET | — |
| `/leagues/{leagueId}/me/umpire-availability` | GET, PUT | — | — |
| `/leagues/{leagueId}/schedule-previews` | — | — | POST |
| `/leagues/{leagueId}/schedule-previews/latest` | — | — | GET |
| `/leagues/{leagueId}/schedule-previews/preparations` | — | — | POST |
| `/leagues/{leagueId}/schedule-setup` | — | GET, PUT | — |
| `/leagues/{leagueId}/sponsors` | GET | — | — |
| `/leagues/{leagueId}/sponsors/logos` | POST | — | — |
| `/leagues/{leagueId}/sponsors/media` | — | — | POST |
| `/leagues/{leagueId}/sponsors/reels` | POST | — | — |
| `/leagues/{leagueId}/sponsors/rows` | POST | — | — |
| `/leagues/{leagueId}/sponsors/sample` | GET | — | — |
| `/leagues/{leagueId}/umpire-candidates` | — | GET | — |
| `/leagues/{leagueId}/umpire-leaderboard` | — | GET | — |
| `/leagues/{leagueId}/umpire-levels` | GET, POST | — | — |
| `/leagues/{leagueId}/umpire-levels/{levelId}` | DELETE | — | — |
| `/leagues/{leagueId}/umpire-note-types` | GET, POST | — | — |
| `/leagues/{leagueId}/umpire-note-types/{typeId}` | DELETE | — | — |
| `/leagues/{leagueId}/umpire-notifications` | GET, PUT | — | — |
| `/leagues/{leagueId}/umpire-requirements` | GET | — | PUT |
| `/leagues/{leagueId}/umpire-schedule` | — | GET | — |
| `/leagues/{leagueId}/umpire-season-priority` | — | — | PUT |
| `/leagues/{leagueId}/umpire-settings` | GET | — | PUT |
| `/leagues/{leagueId}/umpire-types` | GET, POST | — | — |
| `/leagues/{leagueId}/umpire-types/{typeId}` | DELETE | — | — |
| `/leagues/{leagueId}/umpires` | — | GET | POST, PUT |
| `/leagues/{leagueId}/umpires/{userId}` | — | DELETE | — |
| `/leagues/{leagueId}/umpires/{userId}/certifications` | — | PUT | — |
| `/leagues/{leagueId}/umpires/{userId}/commitments` | — | GET | — |
| `/live` | — | GET | — |
| `/location-suggestions` | — | POST | — |
| `/locations` | — | GET | — |
| `/locations/{id}` | GET | — | — |
| `/manage/league/{leagueId}/safesport` | — | PUT | — |
| `/manage/{scopeType}/{scopeId}` | — | GET | — |
| `/manage/{scopeType}/{scopeId}/field` | — | PUT | — |
| `/manage/{scopeType}/{scopeId}/people` | — | POST | — |
| `/manage/{scopeType}/{scopeId}/people/{userId}` | — | DELETE | — |
| `/manage/{scopeType}/{scopeId}/people/{userId}/role` | — | PUT | — |
| `/manage/{scopeType}/{scopeId}/people/{userId}/roles` | — | PUT | — |
| `/manage/{scopeType}/{scopeId}/people/{userId}/roles/{role}` | — | PUT, DELETE | — |
| `/me/account` | GET | — | DELETE |
| `/me/account/age` | GET, PUT | — | — |
| `/me/account/catalog-picture` | PUT | — | — |
| `/me/account/emails/confirm` | POST | — | — |
| `/me/account/emails/primary` | PUT | — | — |
| `/me/account/emails/request` | POST | — | — |
| `/me/account/name` | PUT | — | — |
| `/me/account/password` | PUT | — | — |
| `/me/account/password/reset` | POST | — | — |
| `/me/account/photo` | PUT, DELETE | — | — |
| `/me/affiliations` | — | GET | — |
| `/me/api-keys` | GET, POST | — | — |
| `/me/api-keys/{id}` | DELETE | — | — |
| `/me/builds` | GET | — | — |
| `/me/follows` | GET | — | — |
| `/me/follows/{kind}/{id}` | PUT, DELETE | — | — |
| `/me/groups` | — | GET | — |
| `/me/groups/{kind}/{id}` | DELETE | — | — |
| `/me/groups/{kind}/{id}/roles/{role}` | DELETE | — | — |
| `/me/home` | — | GET | — |
| `/me/notifications` | — | GET | — |
| `/me/notifications/summary` | — | GET | — |
| `/me/notifications/{id}` | GET | — | — |
| `/me/notifications/{id}/dismissed` | PUT | — | — |
| `/me/notifications/{id}/viewed` | PUT | — | — |
| `/me/offline-scoring` | — | GET | — |
| `/me/onboarding` | GET | — | — |
| `/me/onboarding/name` | PUT | — | — |
| `/me/onboarding/photo` | PUT | — | — |
| `/me/push-registrations` | POST | — | — |
| `/me/push-registrations/{id}` | PATCH, DELETE | — | — |
| `/me/roles` | — | GET | — |
| `/me/team-follows` | GET | — | — |
| `/me/tess` | GET | — | — |
| `/me/tess/attachments` | POST | — | — |
| `/me/tess/changes/confirm` | — | — | POST |
| `/me/tess/changes/{changeId}/confirm` | — | — | POST |
| `/me/tess/messages` | — | — | POST |
| `/me/tess/stop` | POST | — | — |
| `/me/tess/usage` | GET | — | — |
| `/me/umpire-leagues` | GET | — | — |
| `/node/ios-app-banner` | GET | — | — |
| `/node/jev-key` | PUT, DELETE | — | — |
| `/node/logins` | GET | — | — |
| `/node/mail` | GET, PUT | — | — |
| `/node/ownership-preflight` | GET | — | POST |
| `/node/sessions` | GET | — | — |
| `/node/settings` | GET, PUT | — | — |
| `/node/sponsor-sample` | — | — | PUT |
| `/oauth/approvals/{handle}` | GET, POST | — | — |
| `/parent-links` | — | PUT | — |
| `/parent-previews` | — | POST | — |
| `/people/{userId}/age` | PUT | — | — |
| `/pictures` | GET | — | — |
| `/players/{userId}` | — | GET | — |
| `/players/{userId}/highlights` | — | — | GET |
| `/players/{userId}/plays` | — | GET | — |
| `/players/{userId}/settings` | PUT | — | — |
| `/players/{userId}/stats` | — | GET | — |
| `/push/web-key` | GET | — | — |
| `/relationship-requests` | — | POST | — |
| `/relationship-requests/{id}/accept` | — | POST | — |
| `/relationship-requests/{id}/decline` | — | POST | — |
| `/relationship-requests/{id}/resend` | — | POST | — |
| `/relationship-requests/{id}/withdraw` | — | POST | — |
| `/schedule-previews/{previewId}` | — | — | GET, PUT |
| `/schedule-previews/{previewId}/preparation` | — | — | DELETE |
| `/schedule-previews/{previewId}/publications` | — | — | POST |
| `/schedule-previews/{previewId}/result` | — | — | PUT |
| `/scoreboard/{gameId}` | GET | — | — |
| `/scoreboard/{gameId}/dashboard` | GET | — | — |
| `/scoreboard/{gameId}/publish` | — | GET | — |
| `/scoreboard/{gameId}/socket` | — | GET | — |
| `/search` | — | GET | — |
| `/seasons` | — | GET, POST | — |
| `/seasons/{id}` | — | GET | — |
| `/seasons/{id}/people` | — | GET | — |
| `/seasons/{id}/people/{userId}` | — | GET | — |
| `/seasons/{seasonId}/games` | — | GET | — |
| `/seasons/{seasonId}/memberships/{teamId}` | PUT, DELETE | — | — |
| `/seasons/{seasonId}/schedule-settings` | GET, PUT | — | — |
| `/seasons/{seasonId}/standings` | — | GET | — |
| `/seasons/{seasonId}/stats` | — | GET | — |
| `/seasons/{seasonId}/teams` | — | GET | — |
| `/sponsor-rows` | GET | — | — |
| `/sponsors/logos/{logoId}` | PATCH | — | — |
| `/sponsors/logos/{logoId}/deactivate` | POST | — | — |
| `/sponsors/reels/{reelId}` | PATCH | — | — |
| `/sponsors/reels/{reelId}/deactivate` | POST | — | — |
| `/sponsors/rows/{rowId}` | PATCH, DELETE | — | — |
| `/tags` | GET | — | — |
| `/teams` | — | GET, POST | — |
| `/teams/search` | — | GET | — |
| `/teams/{id}` | — | GET | — |
| `/teams/{id}/people/{userId}` | — | GET | — |
| `/teams/{teamId}/adults` | POST | — | — |
| `/teams/{teamId}/default-lineup` | — | GET | — |
| `/teams/{teamId}/follow` | PUT, DELETE | — | — |
| `/teams/{teamId}/games` | — | GET | POST |
| `/teams/{teamId}/logo` | PUT | — | — |
| `/teams/{teamId}/players` | POST | — | — |
| `/teams/{teamId}/players/{userId}/avatar` | PUT | — | — |
| `/teams/{teamId}/players/{userId}/guardians` | GET, POST | — | — |
| `/teams/{teamId}/players/{userId}/guardians/{guardianId}` | DELETE | — | — |
| `/teams/{teamId}/players/{userId}/settings` | PUT | — | — |
| `/teams/{teamId}/players/{userId}/walk-up-song` | PUT, DELETE | — | — |
| `/teams/{teamId}/roster` | — | GET | — |
| `/teams/{teamId}/roster-players` | — | POST | — |
| `/teams/{teamId}/schedule` | — | GET | — |
| `/teams/{teamId}/staff` | GET | — | — |
| `/teams/{teamId}/stats` | — | GET | — |
| `/time` | GET | — | — |
| `/users` | — | GET | — |
| `/users/{userId}/account` | GET | — | — |
| `/users/{userId}/account/catalog-picture` | PUT | — | — |
| `/users/{userId}/account/name` | PUT | — | — |
| `/users/{userId}/account/photo` | PUT, DELETE | — | — |
| `/users/{userId}/administration` | GET, PATCH | — | — |
| `/venues` | — | GET, POST | — |
| `/venues/{venueId}` | GET, PUT | — | — |
| `/venues/{venueId}/claims` | POST | — | — |
| `/venues/{venueId}/claims/{claimId}` | DELETE | — | — |
| `/venues/{venueId}/claims/{claimId}/decisions` | POST | — | — |
| `/venues/{venueId}/fields` | POST | — | — |
| `/venues/{venueId}/fields/{fieldId}` | PUT, DELETE | — | — |
| `/videos/{videoId}` | — | — | DELETE |
| `/videos/{videoId}/highlights` | — | GET | — |
| `/videos/{videoId}/wall-timeline` | GET | — | — |

The published document contains 344 method/path operations on 287 paths. The messaging reach and proxy reads resolve affiliations and share the aggregate tier. Saving umpire season priority can process 500 seasons and rebuild the requirements response, so it uses the expensive tier. The two raw sponsor uploads, a league's sponsor media and the node's sample video of up to 120 MB, store and probe their files, so they use the expensive tier too. These classifications come from the handlers. The source scan also found ordinary GETs for player names, playback, stills and HLS files, and an aggregate GET for the API document itself. OAuth interaction and provider requests use the ordinary budget in addition to their dedicated limits. The scoreboard dashboard supports both an ordinary HTTP read and an aggregate WebSocket upgrade.
