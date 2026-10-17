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

- **Repeat a parameter for several values:** `?season=a&season=b`.
- **Leaving a parameter out keeps the collection's existing answer.** Adding
  a parameter never changes what a caller that does not send it gets. A new
  field in each item is allowed; a changed or missing one is not.
- **Declare every parameter, with its default, in the route's OpenAPI
  entry.** A parameter that needs another, or a value it does not take,
  answers 400 with a message that says which.

## When a new path is right

Only for a new resource, or for an action that is not a read or a write of an
existing one. `POST /teams/:teamId/games` takes a whole schedule and answers
each row, which no write to one game does.

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
