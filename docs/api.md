# Designing the API

The REST API under `/api/v1` is described route by route in
[`src/server/openapi.ts`](../src/server/openapi.ts), which serves it as
`/api/v1/openapi.json`. This page holds the rules every route follows, so a
new one looks like the ones already there.

The [API rate-limit report](api-rate-limits.md) lists the account and IP allowances, burst sizes, endpoint tiers and measured database costs.

## Paths name things

A path names a resource or a collection of them:

- `/teams` — every team the caller may see;
- `/teams/:teamId` — one team;
- `/teams/:teamId/games` — that team's games.

## Filters and searches are query parameters

Narrowing, searching or widening a collection is a **query parameter on the
collection that already exists**, never a new path:

- `GET /events?externalId=…` finds games by another system's id
  ([`src/server/routes/eventList.ts`](../src/server/routes/eventList.ts));
- `GET /users?externalId=…` finds people the same way
  ([`src/server/routes/users.ts`](../src/server/routes/users.ts));
- `GET /teams?externalId=…` finds teams the same way
  ([`src/server/routes/teams.ts`](../src/server/routes/teams.ts)).

So the teams a season holds are `GET /teams?season=…`, not
`/seasons/:seasonId/opponents`, and a search is `GET /teams?…`, not
`/teams/search`.

The same holds for people: the players a roster manager may add to a team are
`GET /users?forTeam=…` (with `forGame`, `q` and `limit`), not
`/teams/:teamId/candidates`. They are every live player, and every full
account (switched on, with an email) though it plays for no team. That search
reaches people the asker has no tie to, so it answers only what the result
card draws (a short name, a picture,
hands and the teams they play for this season), lists strangers only once
three letters of a name are typed, and answers once: a bare array of at most
100 rows, with no cursor and no further pages (see **Lists with no pages**
below). A search keeps anybody any one typed word finds, so each row found by
typing lists, as `matched`, the folded words that found that person: what the
phone keeps to find them again offline.

- **Repeat a parameter for several values:** `?season=a&season=b`.
- **Leaving a parameter out keeps the collection's existing answer.** Adding
  a parameter never changes what a caller that does not send it gets. A new
  field in each item is allowed; a changed or missing one is not. The umpire
  schedule's default order is the one deliberate exception (see **Umpire
  schedule sort**).
- **Declare every parameter, with its default, in the route's OpenAPI
  entry.** A parameter that needs another, or a value it does not take,
  answers 400 with a message that says which.

## Paging

A long list answers a page at a time when the caller asks with `paged=1`.
Leaving `paged` out keeps the bare array, in the order it always had, so the
Director and scoreboard clients decode what they did (the umpire schedule's
order is the exception **Umpire schedule sort** gives).

`GET /events`, `GET /teams/:teamId/games` and
`GET /leagues/:leagueId/umpire-schedule` take these, and all share one shape,
`Page<T>` in [`src/common/api.ts`](../src/common/api.ts):

```ts
interface Page<T> {
  items: T[]
  nextCursor: string | null // null at the end
  prevCursor: string | null // on any page with rows before it
  anchorId: string | null // the row `around` opened on
  counts: ListCounts | null // first page only
}
```

- **`limit`** is the page size, 50 by default and at most 100, or 500 on the
  umpire schedule, whose every page computes the whole schedule.
- **`cursor`** is a `nextCursor` or `prevCursor`, opaque, sent back with the
  filters of the query that gave it. It carries its list's order, so `order`
  may be left out, and an `order` that disagrees is a 400. A malformed cursor,
  or one without `paged`, is a 400. Requests with a cursor walk rows that tie on
  their start time without losing or repeating one.
- **`around=next`** opens a first page on the list's next game, in `asc` order,
  with `limit / 2` rows before it and `limit` from it, and names that row in
  `anchorId`. It does not take `cursor` or `order=desc`. The rule is
  `nextGameIndex` in [`src/common/nextGame.ts`](../src/common/nextGame.ts), the
  one the app uses, and it runs over the merged list because a team's next item
  can be a practice.
- **`hasVideo=1`** keeps only games with a video that is not hidden.
- **`counts`** are `{ total, upcoming, withVideo, videos, newestSeasonId }`,
  counted for the list's whole filter ignoring `when`, so a hero or a note is
  right with one page loaded. They come on a first page only.
- **`scoreboard=open`** does not take `paged`, since that filter runs per row
  after the query.

A first page costs the server what the whole list costs, because `counts` and
`around` need the merged list. A later page costs only its own rows.

**Public lists.** `GET /teams/:teamId/games?public=1&paged=1` and
`GET /seasons/:seasonId/games?public=1&paged=1` answer `Page<PublicGame>` to
anybody, signed in or not, with `when`, `order`, `hasVideo`, `cursor` and
`limit`. Only `public=1` admits a guest, and it does not take `around`.

**The umpire schedule** adds `positions` to its pages: the position columns of
the whole filtered list, each with its `optionalHeader` text, so a table's
columns do not depend on which rows are loaded.

**Node activity.** `GET /node/logins` and `GET /node/sessions`, for node
administrators, always answer a `Page<ActivityRow>`, newest first, with
`limit` (1 to 100, 50 by default) and `cursor`. They take no `paged` and
nothing else. A cursor holds the last row's time to the microsecond and its
id, so a page never repeats or skips a row that ties within a millisecond,
and rows that arrive meanwhile sort above every cursor. `prevCursor`,
`anchorId` and `counts` are always null. The sessions' first page adds
`recordedSince`.

**Lists with their own cursor.** `GET /players/:userId/highlights` pages with
`before`, passing back a `nextBefore` of `<iso>|<id>`. It reads on until a page
is full or it has scanned 500 plays, so a short page with `nextBefore` set can
happen, and only a null `nextBefore` ends the list. A bare date-time `before`
still reads, and anything else is a 400. `GET /me/notifications` keeps the
cursor it had. `GET /videos/:videoId/highlights` answers whole, because one
game bounds it and marking dropped plays needs every play of the game.

**Lists with no pages.** `GET /users?forTeam=` answers one bare array per
search, of at most 100 rows, and takes neither `paged` nor `cursor`. `limit`
(1 to 100) is read only beside `capped=1`, which the current client sends
because it says when an answer is full. Without the marker the answer is the
whole 100 whatever `limit` says: installed builds send `limit=30`, draw no
such notice, and page on with `after`, so a shorter answer would cut their
list without a word. `capped` other than `1` is a 400. It reads matches until 100 rows the asker is
shown are kept, the matches run out, or it has read a fixed bound of them, so
a search whose matches are nearly all hidden answers what it kept by then;
typing more narrows it. A row's `cursor` is always empty, kept because
installed builds need the field, and a request with `after` (such a build
scrolling on) answers `[]`, so it stops there.

**Phones.** A first page is stored for offline. A request with a `cursor` is
never stored, so it reaches only the network.

## When a new path is right

Only for a new resource, or for an action that is not a read or a write of an
existing one. `POST /teams/:teamId/games` takes a whole schedule and answers
each row, which no write to one game does.

## Personal umpire presence

Schedule rows and public group games include `isUmpire` for the authenticated
viewer's own current assignment, including merged account identities. Guests,
other people's assignments, cancelled/withdrawn games and disabled league
umpire management return false. This metadata never expands game visibility.
Older responses may omit the flag; clients treat omission as false. Game detail
umpire positions include an optional nullable `person.avatarUrl` alongside the
canonical `userId` and abbreviated `name`.
The umpire block also carries `leagueId`, sent only to a reader accepted into
that league, and each `person` carries `openable`: whether the reader may open
that umpire's league profile (absent means they may not).

## Game LIVE state

Game detail, schedule rows and public group games return `isGameLive`, computed
on the server by `gameIsLive`. It requires a surviving pitch or ball-in-play
event, a game that is neither final nor cancelled, and server time within the
inclusive window from one hour before start through one hour after end. A
missing end uses the existing three-hour duration. Non-game events and new
pending proposals return false.

Game status uses the same activity check: roster changes, substitutions,
initialized at-bats, runner placement and game-flow overrides cannot start a
game. A pitch or ball-in-play action (or a corresponding Gumbo play event)
must remain in a stored play or the current play. Undoing the last one returns
an unfinished game to `scheduled`. Final and cancelled games retain their
existing finalization rules.

Clients display this flag directly and refresh it through their normal visible
screen refresh. They must not derive it from `status`, scoring fields or the
device clock. Missing flags from older servers are treated as false. The existing
`isLive` field describes a video stream, not game scoring.

## Public video previews and membership requests

Game metadata and `/videos/:videoId/highlights` expose posters and signed stills
to guests and nonmembers. Hidden videos remain unavailable and playback keeps
its membership check. These previews never grant a media playback token.

Sign-in requests carry a local `next` path, including the selected game, tab
and video. Email-link verification and approved-request claims return it in
the session so opening an email link can restore the same screen after an app
restart. External destinations are discarded. Signing in alone does not grant
video access: a nonmember's next playback attempt offers a membership request.

`POST /relationship-requests` accepts `{kind: "membership", teamId,
idempotencyKey}` from a signed-in user. The server binds the request to that
user, deduplicates pending requests to the same team, and asks the team's
administrators through the approval inbox. Acceptance grants only membership,
never staff roles. Requests for missing, merged or placeholder teams fail.

`{kind: "videographer", teamId, idempotencyKey}` asks in the same way for the
Videographer role on a team. The sender must be a member of the team who cannot
film its games, and its administrators, coaches and assistants approve it.
`GET /games/:gameId/stream-access` answers `{canFilm, canRequest, requested,
teamId}`, where `teamId` is the team to ask, and `404` for a caller who cannot
see the game.

## RSVP eligibility

Event info's `replyUserIds` and attendee `canReply` are authoritative for the
Info card, schedule and RSVP modal. Self replies require an explicit membership
or team admin/coach (including assistant coach) role on a participating team.
Inherited season/league access, site administration and guardianship alone do
not qualify. Guardian-linked children must be current players on either game
team, or the one team for a practice/other event. Canonical merged identities
are deduplicated and disabled people are excluded. Saves recheck the same
policy; an old reply cannot keep a removed player eligible.

## Messaging a person

`GET /chat/dm-reach?userId=<id>` answers `{ reach }`: `direct` when the viewer
may start a DM with that person, `proxies` when that person is a player who
cannot use chat (no account, or under 13) and the viewer may message somebody
for them instead, and null otherwise. `GET /chat/dm-proxies?userId=<id>` names
those people, `{ player, kind, people, why }`: their guardians and adult family
(`guardians`), or, with none the viewer can reach, their teams' staff
(`coaches`), and `why` (`noAccount` or `tooYoung`); 404 when there is nobody.
Both apply the same DM rules as `GET /chat/dm-candidates`, and, like every chat
read, are refused to somebody with no age on file or under 13.

## Chat age confirmation

Chat is for people 13 and older. `GET /me/account/chat-age` answers whether
the signed-in account has unlocked chat: `{ confirmed, source, confirmedAt }`,
with `source` `apple` (the iPhone shared a Declared Age Range of 13 or more)
or `self` (the person agreed to the app's age sheet), and both null until
then. `PUT /me/account/chat-age` with `{ source }` confirms it; the first
confirmation stands, and a later call answers the source and time already
recorded. Like the rest of `/me/account`, both are for signed-in sessions:
API keys and machine actors are refused.

The app enforces it: it opens a chat surface only for a confirmed account,
and asks first otherwise. The chat routes do not read it.

## Umpire leaderboard pages

`GET /leagues/:leagueId/umpire-leaderboard` accepts `order` (`asc` or `desc`, default `desc`), `limit` (1 to 50, default 50) and `offset` (default 0). With none of them it answers the top ten with at least one game, to any league umpire. With any of them it needs a league administrator, and ranks every current league umpire who is not disabled, including those with no games, along with anyone else with a game still counted, such as a removed umpire. It adds `page: { order, limit, offset, total }`. It names people as the league's roster does, and anyone no longer on the roster by first name and last initial, as the default answer does. Equal counts sort by name in both directions, so the order of a tie can follow the people's name format. The defaults apply only once one of the three is named, so OpenAPI declares none. Only the real top ten have a symbol, and an invalid value returns 400. Pages rank live data, so a signup between two reads can repeat or skip someone at a page boundary.

## Umpire schedule timezones

`GET /leagues/:leagueId/umpire-schedule` accepts an optional `timezone` query
parameter. Clients send their local IANA timezone; row dates and conflict lines
are always written in it. An optional `filterTimezone` names the zone the
`days`, `from` and `to` filter is matched in, such as a saved filter's own, so
"weeknights after 5 in Chicago" stays that on a phone in another zone while the
rows stay in the phone's zone. Without `filterTimezone` the filter is matched in
`timezone`, and without either, each game's stored timezone is used for both.
Invalid zones return 400. Stored ISO instants and conflict intervals are
unchanged.

## Umpire schedule sort

`GET /leagues/:leagueId/umpire-schedule` takes `sort`: up to two keys of
different fields joined by a comma, first first. The keys are `date` (the
calendar day in the zone the schedule is shown in), `season` (the season's
name), `seasonPriority` (the league's season order, with seasons that have none
after those that have one, by name, both ways) and `certification` (the season's
required umpire level), each with an optional leading `-` for the other
direction. `season` and `seasonPriority` are one field. Names compare naturally
and without case ("U8" before "U10"). The date, start time and game id break
every tie, newest first under `-date` and oldest first otherwise. `sort=none` is
the empty sort, those tie-breakers alone. Anything else is a 400.

Without `sort` the league's default applies, which an administrator saves as
`sort` on `PUT /leagues/:leagueId/umpire-settings` (a JSON array: `[]` for the
empty sort, `null` to go back to none saved); with none saved, `date,season`.
A save that leaves `sort` out keeps the stored default as it is.

Every answer names the sort its rows are in as `sort`, and the league default as
`settings.sort` (null when none is saved). The unpaged answer and `view=league`
are sorted too.

This changes what a caller that sends no `sort` gets, paged or not: the rows
used to run by start time across the league, and with no default saved they
now run by calendar day, then season name, then start time. It is the one
place the rule that leaving a parameter out keeps a collection's answer yields,
on purpose: the schedule is a table read a day at a time, and its default
(issue #348) groups each day's games by division unless the league saves
another, for every reader, the app included. A caller that needs the old
order sends `sort=none`, which is start-time order when the games share a zone.

A page's cursor carries the sort it was read in and the boundary row's keys, so
a walk stays in its sort when the league default changes meanwhile, and still
places the next page if the boundary row is gone. An explicit `sort` that
disagrees with the cursor's is a 400, as `order` is on the other lists.
Cursors given before the schedule was sorted (the start-time cursor the other
schedules still use) are refused with 400 `cursor is not a cursor this list
gave`, so a client reading across that deploy starts again from the first page.
`around=next` still opens on the first game under way or still to start in time
order, and cuts the page around that game's place in the sort. The umpire
schedule's `around` also takes a game id (`around=gam_…`): the page opens on
that game's place in the sort, and names it in `anchorId`, when the game is
listed, and as `around=next` does when it is not (filtered out, or gone). That
is how an umpire notice opens the schedule on its game. Anything else is a 400
`around must be next or a game id`; it still needs `paged` and does not take
`cursor`. The other lists' `around` stays `next` alone. Season priorities
are read live, so a priority saved between two reads can repeat or skip a row at
a page boundary, as on the leaderboard.

The season order itself is `PUT /leagues/:leagueId/umpire-season-priority` with
`{ seasonIds }`, the league's current and upcoming seasons first to last
(a season of the league that has ended since the list was read is left out,
since its position is cleared anyway; another league's season is a 400), and it
answers the seasons as `GET …/umpire-requirements` does, each with its
`priority`. It is a path of its own rather than a parameter, because it is not a
filter or a search of an existing collection: it writes a league setting whole,
one position per season, and clears the position of the league's other seasons.
A season created later has none, so it sorts last.

## Umpire Management Notifications

`GET` and `PUT /leagues/:leagueId/umpire-notifications` read and change the
caller's own settings for a league they administer (`canAdminister`: a league
or site administrator), never anyone else's:

```ts
interface UmpireNotificationSettings {
  missingSlots: boolean // the daily digest, off by default
  daysBefore: number // its window, 1 to 30 calendar days, 7 by default
  signUps: boolean // umpire sign-ups, off by default
  withdrawals: boolean // umpire withdrawals, off by default
}
```

They are a path of their own, not fields of `umpire-settings`, because they are
each admin's for themselves, where `umpire-settings` is the league's one
setting every admin shares. Settings never changed read as the defaults. `PUT`
takes any of the four and keeps the rest; `daysBefore` that is not a whole
number from 1 to 30, or a toggle that is not a boolean, is a 400. Someone who is
no longer an admin is refused with 403, and their settings are kept for when
they are one again. Settings are read and saved whatever the league's umpire
management; notices are recorded only while it is on. Both are in the `umpire`
API-key family.

- **The digest** (`umpireMissingSlots`) is recorded once a day for each admin
  with `missingSlots` on, at 10:00 in the league's zone: its locality's
  `timezone` (the city chosen for the league), or `America/Los_Angeles` when it
  has none or the zone is not one `Intl` knows. It lists every game of the
  league within `daysBefore` calendar days (counted in the game's own zone,
  `games.timezone`, as the umpire schedule dates it, today included) that has
  not started, is not withdrawn, final or cancelled, and still has an empty
  required position; optional positions never count. Each game is dated in
  that zone too. A day with none sends nothing. It is one notice for each
  admin, league and day, however many nodes sweep (every 10 minutes, so a node
  that was down at 10:00 records the day's on its next sweep), and it repeats
  daily until the games are filled or start. It is in the notifications'
  default list (`hasPending`) until dismissed; the next day's dismisses it, and
  so does the first sweep that finds none of its games still missing an
  umpire, that day's included. Turning `missingSlots` off dismisses it; turned
  back on the same day, it takes effect from the next day's digest.
- **Sign-ups** (`umpireSignUp`) and **withdrawals** (`umpireWithdraw`) are
  recorded when an umpire, or their guardian, signs up for a slot or removes
  their own assignment, for the admins with `signUps` or `withdrawals` on, less
  whoever acted. An admin removing someone else's assignment notifies nobody.
  They date the game in its own zone, as the digest does. They are History
  from the start.

Nothing is recorded while the league does not manage umpires, nor for anyone
who is no longer its admin. Each notice carries `leagueId` and `gameId` (the
digest's first game), and opens the league's umpire schedule on that game.

Each notice is also pushed to the admin's devices whose third switch,
`leagueManagement` on `POST /me/push-registrations` and
`PATCH /me/push-registrations/:id`, is on. It is on unless a device turns it
off: a registration that leaves it out (an app from before it) has it on, and
every registration that existed before it has it on. The push is the event
payload an RSVP reminder sends (`t: 'event'`), tagged `event:league:<id>`,
whose `url` is `teamstation://umpires/<leagueId>?view=league&game=<gameId>`.

## Umpire commitments

`GET /leagues/:leagueId/umpires/:userId/commitments?from=…&to=…` is a new path,
not a filter, because no collection holds what it answers: one person's
umpiring assignments and the games they play in (as a rostered player or a
guest, not where they are unrostered), across every league the caller
administers, merged into one list of commitments within a window. Neither
`/events` nor the umpire schedule is that list; both answer games, not one
umpire's holds on their time, and the schedule is a single league's.

## Pending video publication

A member's playback response can include `pending: true` with `url: null`
while a live recording is waiting for its first publication to Spaces, even
when the stream has ended and the video is `ready`. Both the single player
and multi-angle view retry with their existing bounded backoff. An omitted
flag is false for older servers. With Spaces configured, playback never
exposes the ingest machine's temporary live files; no-Space playback keeps
its local path.

## Recovering encrypted chat history

Epoch publication accepts optional `mode: "fresh"`. It is disabled by default
and requires a linked current member who can post but whose current identity
has no box for the latest epoch. The existing null-backlink signature starts a
new independent segment. Existing epoch signatures and encrypted data stay
unchanged. Future key access does not approve older history.

Epoch responses advertise `historyRecoveryVersion: 1` separately from
`freshEpochsEnabled`. An upgraded client must check support before requesting
`GET /chat/grants?scope=history`. This returns a page of fixed historical segment
goals with a `coveredThroughEpoch` watermark. `cursor` defaults to `"0"` and
`limit` to 100 (1–100); both require historical scope. The default grants route
retains its legacy array response.

`POST /chat/grants?scope=history` accepts 1–100 boxes, each carrying `requestId`,
`conversationId`, `targetEpoch`, actual supplied `epoch`, `userId`, `identityId`,
`pukGeneration`, `box` and optional `approveHistory` (default false). HPKE uses
the actual epoch in the existing grant domain and AAD. An earlier key recovers
only its prefix; only reaching the fixed target completes the request. Reset
history requires explicit approval by a different eligible approver holding a
key in that requested range. Approval is durable for that identity/conversation;
later holders can finish other ranges. Repeated grants are idempotent.

`GET /chat/conversations/:id/epochs?after=N&boxesAfter=0&boxLimit=100` keeps
epoch metadata and key-box delivery cursors independent. `nextBoxesCursor` is
the last returned box's position; `hasMoreBoxes` signals another page. Cursors
are decimal strings, exclusive, scoped to conversation/account/identity/server.
Persist validated keys before advancing the cursor; replay is safe. Omitting
`boxesAfter` retains legacy box filtering. `boxLimit` requires that cursor.

Disabling fresh publication leaves recovery reads and grants operational.
After fresh segments exist, retain the upgraded server when rolling back a
feature flag. Older clients retaining keys continue verifying and reading
messages; cross-segment recovery requires upgraded granting and receiving
clients. Recoverability depends on an authorized device retaining old keys.
