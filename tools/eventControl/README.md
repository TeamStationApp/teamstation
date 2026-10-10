# Device event-control tools

A Node implementation of device event control — both ends, and the tools to drive and observe
real devices with. The protocol is specified in
[`mobile/apps/common/EventControl/README.md`](../../mobile/apps/common/EventControl/README.md);
this code is its reference implementation and runs the same fixtures as the Swift package.

Run every tool from the repository root with `node -r sucrase/register`. Each prints one JSON
line per event on stdout. No tool ever prints a token or a key.

| File | What it is |
| --- | --- |
| `codec.ts` | Frames, messages, MACs, assignments and the server's key reply |
| `peer.ts` | A generic receiver: the receiver state machine and a TCP listener |
| `director.ts` | The Director state machine and an emitter that drives one receiver |
| `recorder.ts` | Records what reaches a game's scoreboard |
| `signIn.ts` | Signs an account in with an e-mail code and keeps its token in a file |
| `cli.ts`, `fixtures.ts` | Shared argument parsing, key fetching, logging; the fixture reader |

## Signing in

```sh
node -r sucrase/register tools/eventControl/signIn.ts \
  --server http://127.0.0.1:9100 --email one@example.test --out <token file>
```

Asks the server for a sign-in code, reads the code from stdin, and writes the session token to
`<token file>` with mode 600. Keep token files outside every repository. A local server with no
mail relay configured writes the code to its own log instead of sending it.

## A receiver

```sh
node -r sucrase/register tools/eventControl/peer.ts \
  --server http://127.0.0.1:9100 --token-file <token file> [--port 47614] \
  [--host 0.0.0.0] [--disabled] [--apply failed] [--instance <32 hex>]
```

Fetches its own key with the token, listens on `--port` (or the first free of 47614 and 47615),
and logs every frame in and out, every lease change and every assignment. `--disabled` leaves
"Allow Director override" off; `--apply <status>` answers every assignment with that status
instead of applying it.

## A Director

```sh
node -r sucrase/register tools/eventControl/director.ts \
  --server http://127.0.0.1:9100 --token-file <token file> --peer 192.0.2.20:47614 \
  --game <game id> [--title "Visitors at Pioneers"] [--start 2026-09-21T18:00:00Z] \
  [--hold <seconds>] [--tamper | --replay | --wrong-key | --stale-revision]
```

Fetches its own key, then discovers, assigns, renews every 5 seconds for `--hold` seconds, and
releases. The bad-frame modes send one bad frame and log what the receiver answers:

| Mode | Sends | A conforming receiver answers |
| --- | --- | --- |
| `--tamper` | the assign with one MAC bit flipped | `invalid`, and closes |
| `--replay` | a valid session's assign again, on a new connection | `invalid`, and closes |
| `--wrong-key` | a discover signed with a random key under its own tag and key ID | `invalid`, and closes |
| `--stale-revision` | after a valid assign, an assign one revision lower | `stale`; the newer one stays |

It prints `{"event":"exit","status":…}` with the last status the receiver gave.

## A scoreboard recorder

```sh
node -r sucrase/register tools/eventControl/recorder.ts \
  --server http://127.0.0.1:9100 --token-file <token file> --game <game id> [--seconds 60]
```

Subscribes to `/api/v1/scoreboard/<game>/socket` and logs every board the server sends, so a
test can see that a reading published after an assignment lands on the assigned game.

## Tests

```sh
socket npm run test.eventControl
```

Type-checks the tools, runs every `*.test.ts` here under c8 with a 90% line gate on
`tools/eventControl/**`, and then `scripts/checkEventControlContract.cjs`, which prints each
fixture's SHA-256 and fails if any copy of the fixtures differs from the Swift package's.
`scripts/checkEventControlBoundary.cjs` keeps the event-control code free of any one app's name.
