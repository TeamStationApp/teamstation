# Designing the API

The REST API under `/api/v1` is described route by route in
[`src/server/openapi.ts`](../src/server/openapi.ts), which serves it as
`/api/v1/openapi.json`. This page holds the rules every route follows, so a
new one looks like the ones already there.

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
`GET /users?forTeam=…` (with `forGame`, `q`, `limit` and `after`), not
`/teams/:teamId/candidates`. They are every live player, and every full
account (switched on, with an email) though it plays for no team. That search
reaches people the asker has no tie to, so it answers only what the result
card draws (a short name, a picture,
hands and the teams they play for this season), lists strangers only once
three letters of a name are typed, and pages with an opaque cursor that holds
no name.

- **Repeat a parameter for several values:** `?season=a&season=b`.
- **Leaving a parameter out keeps the collection's existing answer.** Adding
  a parameter never changes what a caller that does not send it gets. A new
  field in each item is allowed; a changed or missing one is not.
- **Declare every parameter, with its default, in the route's OpenAPI
  entry.** A parameter that needs another, or a value it does not take,
  answers 400 with a message that says which.

## Paging

A long list answers a page at a time when the caller asks with `paged=1`.
Leaving `paged` out keeps the bare array, in the order it always had, so the
Director and scoreboard clients decode what they did.

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

- **`limit`** is the page size, 50 by default and at most 100.
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

**Lists with their own cursor.** `GET /players/:userId/highlights` pages with
`before`, passing back a `nextBefore` of `<iso>|<id>`. It reads on until a page
is full or it has scanned 500 plays, so a short page with `nextBefore` set can
happen, and only a null `nextBefore` ends the list. A bare date-time `before`
still reads, and anything else is a 400. `GET /me/notifications` keeps the
cursor it had. `GET /videos/:videoId/highlights` answers whole, because one
game bounds it and marking dropped plays needs every play of the game.

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

## RSVP eligibility

Event info's `replyUserIds` and attendee `canReply` are authoritative for the
Info card, schedule and RSVP modal. Self replies require an explicit membership
or team admin/coach (including assistant coach) role on a participating team.
Inherited season/league access, site administration and guardianship alone do
not qualify. Guardian-linked children must be current players on either game
team, or the one team for a practice/other event. Canonical merged identities
are deduplicated and disabled people are excluded. Saves recheck the same
policy; an old reply cannot keep a removed player eligible.

## Umpire schedule timezones

`GET /leagues/:leagueId/umpire-schedule` accepts an optional `timezone` query parameter. Clients send their local IANA timezone for row and conflict dates and weekday/time filtering. Invalid zones return400. When omitted, each game's stored timezone is used. Stored ISO instants and conflict intervals are unchanged.

## Pending video publication

A member's playback response can include `pending: true` with `url: null`
while a live recording is waiting for its first publication to Spaces, even
when the stream has ended and the video is `ready`. Both the single player
and multi-angle view retry with their existing bounded backoff. An omitted
flag is false for older servers. With Spaces configured, playback never
exposes the ingest machine's temporary live files; no-Space playback keeps
its local path.
