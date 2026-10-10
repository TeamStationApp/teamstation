# EventControl

Device event control lets a Director set the publishing event of nearby devices signed in to the
same TeamStation account, without any device handing another a login. A device that receives
assignments is a **receiver**; the device that sends them is the **Director**. Every receiver
speaks exactly the same protocol: nothing on the wire, and nothing a Director keeps, says what
app a receiver is.

This file is the specification of version 1. The Swift package implements both ends; the Node
reference in `tools/eventControl` implements both ends again; other implementations port from
this file and must pass the shared fixtures in `Tests/Fixtures` byte for byte.

- [Constants](#constants)
- [Keys and account scope](#keys-and-account-scope)
- [Transport](#transport)
- [Frames](#frames)
- [Messages](#messages)
- [Assignments](#assignments)
- [Receiver](#receiver)
- [Director](#director)
- [Security properties](#security-properties)
- [Swift API](#swift-api)
- [Fixtures and conformance](#fixtures-and-conformance)

## Constants

| Name | Value |
| --- | --- |
| Protocol version | `1` |
| Ports (TCP) | `47614`, then `47615` |
| Largest payload | 4096 bytes |
| Renew interval (Director) | 5 s |
| Lease duration (receiver) | 15 s after the last `assign` or `renew` that held it |
| Instance ID | 16 bytes |
| Challenge, receiver nonce | 16 bytes |
| Account tag | 16 bytes on the wire (32 lower-case hex characters in JSON) |
| Key ID | 8 bytes on the wire (16 lower-case hex characters in JSON) |
| Key | 32 bytes (64 lower-case hex characters in JSON) |
| MAC | 32 bytes, HMAC-SHA256 |
| Game ID | 1–128 UTF-8 bytes |
| Title | 1–256 UTF-8 bytes |
| Start time | exactly 20 ASCII bytes, `YYYY-MM-DDTHH:MM:SSZ` |

No UDP, broadcast or multicast is used anywhere. A Director finds receivers by TCP-connecting to
47614 and 47615 on the hosts it sweeps, then talks to each one it found by address.

`lp(x)` below always means `u16be(byteLength(x)) || x`: a two-byte big-endian byte count, then
the bytes. Strings are UTF-8. Integers are unsigned big-endian.

## Keys and account scope

Each device fetches its own key with its own TeamStation session:

    GET /api/v1/device-event-control/key
    Authorization: Bearer <the device's own session token>

Only a human sign-in is accepted; a machine API token for the same person gets **401**. A server
with the feature switched off answers **503**
`{ "code": "unavailable", "message": "…", "error": "deviceEventControlUnavailable" }`. A 200
answer (never cached):

```json
{
  "version": 1,
  "issuer": "https://app.example.test",
  "userId": "1001",
  "accountTag": "3ce9e2793f1ced4924b58f9598f81da9",
  "keyId": "5cbbb6482042eb0a",
  "key": "d47b3e64272b9c78fdd34c7439697d44dad28301356c5ba1f0c559dbed3eec04"
}
```

`issuer` is the server's canonical public origin and `userId` the caller's ID in decimal. A
client reads `userId` as a string or, defensively, a JSON number. The server derives, from its
secret `S` (`deviceEventControlSecret`, used as its UTF-8 bytes):

    key        = HMAC-SHA256(S, lp("device-event-control:v1") || lp(issuer) || lp(userId))
    keyId      = hex(SHA-256(lp("device-event-control:v1:keyid") || lp(S)))[0, 16)
    accountTag = hex(HMAC-SHA256(key, lp("device-event-control:v1:account-tag")))[0, 32)

So two devices of the same account on the same server hold the same key and tag; another
account, or the same account on another server, holds different ones; rotating the server
secret changes the key ID (and the key and tag with it). `keys.json` pins these derivations.
The key ID is an unkeyed hash of `S` that every signed-in device receives, so the server
refuses a secret shorter than 32 bytes (it answers 503 `deviceEventControlUnavailable`, as with
none, and says so at startup); 32 random bytes as hex is what it is configured with.

The key authenticates this protocol and nothing else. Keep it in the platform's secure store
(Keychain on iOS, Keystore-backed storage on Android), never in settings, exports, fixtures,
advertisements or logs. Keep the account scope with it, so a device relaunched offline still
knows which account it proved. Discard it on sign-out or an account change. A device whose key
ID differs from a peer's fetches its own key again before trusting either.

A device with no key whose fetch failed for a passing reason (no network, a timeout, any other
5xx such as a 502 while the server restarts) asks again every 60 seconds while the feature is on
and it is signed in, with no other prompt needed. A 401, 404 or 503 is final until the account
changes: the device says why and does not ask again on a timer.

## Transport

A receiver listens on TCP **47614**, or on **47615** when 47614 is taken (so two participating
apps on one handset can both listen). Which port it got says nothing about it. When both are
taken it reports that as an error in its own status. Two receivers at one address on the two
ports are two peers; peers are told apart by instance ID, never by address.

One TCP connection per Director–receiver pair carries the whole exchange: one `discover`, then
assignments and renewals. A dropped connection does not end a lease (only expiry, release, the
receiver's consent and its account do); the Director reconnects to the same address and port,
sends a fresh `discover`, and carries on.

The Director sends one request at a time and waits for its reply; the receiver answers every
request in order on the same connection.

### Connection limits

Every receiver applies the same limits, so no host on the LAN can hold a receiver's connections
and lock its Director out. A connection is **authenticated** once the receiver has answered a
`discover` on it with `announce` (its key ID, account tag and MAC checked); every later frame the
receiver accepts on that connection's binding (an `ack` of any status sent with the binding's
nonce, or a retried reply) counts as **activity**. Nothing else does: bytes, a partial frame, or a
frame the receiver closes the connection over.

| Rule | Value |
| --- | --- |
| Open connections at once | at most **16** |
| A connection not authenticated this long after it was accepted is closed | **5 s** (handshake) |
| An authenticated connection with no activity this long is closed | **15 s** (the lease duration: a Director renews every 5 s) |
| A new connection while 16 are open | closes the **oldest connection that is not authenticated** and is admitted; when all 16 are authenticated the new connection is closed at once |
| Frames a connection may have unanswered | **1**: the next frame is read only once the receiver has answered the last or closed the connection over it, and a connection's close is handled only after the frame in hand |

An authenticated connection is therefore never closed to make room for one that is not, so the
Director holding a lease keeps it however many idle connections arrive; and a Director arriving
while 16 idle connections are open replaces the oldest of them and is answered at once. Closing
a connection for any of these reasons drops its binding only, as any close does: the lease is
untouched.

## Frames

    frame   = u32be(payloadLength) || payload            1 <= payloadLength <= 4096
    payload = version (u8) || type (u8) || field* || mac (32 bytes)
    field   = lp(bytes)
    mac     = HMAC-SHA256(key, lp("device-event-control:v1:frame") || version || type || field*)

A reader takes the four-byte length first. **A length of 0, or over 4096, closes the connection
before anything is allocated for the payload.** The MAC covers everything in the payload before
it (version, type and every field, with their length prefixes), preceded by the domain string in
`lp` form.

### Field order

Every message starts with the same six fields, in this order:

| # | Field | Length | Meaning |
| --- | --- | --- | --- |
| 0 | `sender` | 16 | The sending end's instance ID |
| 1 | `requestId` | 8 | A Director's request number on this connection; a receiver echoes the request it answers |
| 2 | `accountTag` | 16 | The sender's account tag |
| 3 | `keyId` | 8 | The sender's key ID |
| 4 | `challenge` | 16 | The Director's challenge for this connection's session |
| 5 | `receiverNonce` | 0 or 16 | The receiver's nonce for this session; empty in `discover` and in a reply sent before one exists |

Then the body fields of its type:

| Type | Byte | From | Body fields (index: name, length) |
| --- | --- | --- | --- |
| `discover` | 1 | Director | none |
| `announce` | 2 | receiver | 6: `consent` 1 (0 or 1) · 7: `lease` 1 (0 free, 1 heldBySender, 2 heldByOther) · 8: `leaseRevision` 8 |
| `assign` | 3 | Director | 6: `revision` 8 · 7: `gameId` 1–128 · 8: `title` 1–256 · 9: `startAt` 20 |
| `ack` | 4 | receiver | 6: `status` 1 · 7: `revision` 8 |
| `renew` | 5 | Director | 6: `revision` 8 |
| `release` | 6 | Director | 6: `revision` 8 |

### Decoding, in this order

Each failure has a name; `rejections.json` names the one every implementation must report.

1. More than 4096 bytes: `tooLarge`.
2. Fewer than 2 bytes: `tooShort`.
3. Version not 1: `unsupportedVersion` (with the version byte).
4. Type not 1–6: `unknownType` (with the type byte).
5. Fewer than 34 bytes: `tooShort`.
6. For each field of the type, in order, within the bytes before the last 32:
   - fewer than 2 bytes left for its length: `truncated`;
   - the declared length over the field's maximum: `fieldTooLong` (field index) — **checked
     before the length is compared with what is left, and before anything is read**;
   - fewer bytes left than declared: `truncated`;
   - a length the field never has (an exact-length field of another length, a nonce of neither 0
     nor 16, an empty game ID): `badFieldLength` (field index).
7. Bytes left over before the MAC: `trailingBytes`.
8. `consent` not 0 or 1, `lease` not 0–2, `status` not 0–9: `badValue` (field index).
9. `gameId`, `title` or `startAt` not valid UTF-8: `badUTF8` (field index).

Decoding never checks the MAC; authenticity is a separate, constant-time comparison of the MAC
the receiving end computes with its own key against the last 32 bytes.

## Messages

### Ack statuses

| Byte | Status | Meaning |
| --- | --- | --- |
| 0 | `applied` | The assignment is configured, the lease renewed, or the release done. Not a claim that anything is being published yet |
| 1 | `disabled` | The receiver's operator has not allowed Director override |
| 2 | `wrongAccount` | Another account, or the same account on another server |
| 3 | `busy` | Another Director holds the lease |
| 4 | `unsupported` | A protocol version the receiver does not speak |
| 5 | `invalid` | Malformed content, a bad MAC, or a frame not bound to this connection's session |
| 6 | `stale` | A request or revision older than one already seen |
| 7 | `expired` | No lease to renew or release |
| 8 | `failed` | The receiver could not store or apply the assignment |
| 9 | `keyMismatch` | The keys come from different server secrets; both ends fetch theirs again |

### Revisions and request IDs

A Director's **revision** goes up every time its desired assignment changes, and keeps going up
across relaunches: the reference counter is `max(last + 1, wall clock in milliseconds)`. A
receiver never applies a revision lower than the lease's.

A Director's **request IDs** start at 1 on each connection and go up by one per request. A
receiver remembers the last request ID it took on each connection and the reply it gave.

## Assignments

An assignment is the selected game's own ID, plus the description the apps already show for it:
its teams title ("Visitors at Pioneers") and its start time. The game ID is the only destination
and is never shown; the title and start time are what a receiver shows while it is controlled.

**Canonical forms.** Trimming removes ASCII space, tab, line feed, vertical tab, form feed and
carriage return from both ends, and no other character (a no-break space is kept). The start
time is UTC to the second, exactly `YYYY-MM-DDTHH:MM:SSZ`, and must name a real date and time
(month 1–12, a day the month has, hour 0–23, minute and second 0–59).

**Building (Director).** From the selected event: trim the game ID; an empty one is
`emptyGameId`; over 128 bytes is `gameIdTooLong` (never shortened: a shortened ID names another
game or none). Trim the title; empty is `emptyTitle`; over 256 bytes, drop whole characters
(extended grapheme clusters) from the end until it fits, then trim again. Write the start time
in the canonical form, dropping fractions of a second. No selected event means no assignment.

**Receiving.** Accept the three fields only if they are already canonical: non-empty, within
their byte limits, trimmed (`untrimmedGameId`, `untrimmedTitle`), and a valid canonical start
time (`badStartAt`). An unacceptable assignment is answered `invalid`.

`assignments.json` pins both.

## Receiver

State: the receiver's **instance ID** (random, made once per installation and kept), its
**credentials** (or none), its operator's **consent** ("Allow Director Override", off by
default), the **lease** (owner instance ID, owner address as observed on the socket, revision,
assignment, expiry), an **apply in flight** flag, and per connection a **binding** (the
Director's instance ID and challenge, this receiver's nonce, the last request ID and the reply
to it).

For every payload on a connection, in order:

1. No credentials: close, no reply.
2. A first byte other than 1: reply `ack(unsupported, revision 0)` with request ID 0, an all-zero
   challenge and an empty nonce, then close.
3. It does not decode, or its type is `announce` or `ack`: close, no reply.
4. Its key ID is not this receiver's: report the peer's key ID to the app (fetch the key again),
   reply `ack(keyMismatch, 0)` with an empty nonce, close.
5. Its account tag is not this receiver's: reply `ack(wrongAccount, 0)` with an empty nonce,
   close.
6. Its MAC does not verify with this receiver's key: reply `ack(invalid, 0)` with an empty
   nonce, close.
7. End the lease if its time is up.
8. `discover`: make a fresh 16-byte nonce; bind the connection to (sender, challenge, nonce,
   request ID); reply `announce(consent, lease, leaseRevision)` where `lease` is `heldBySender`
   when the sender owns it (with its revision), `heldByOther` when someone else does (revision
   0), else `free`. Remember the reply.
9. Any other type needs a binding on this connection with the same sender, challenge and nonce
   (compared in constant time); otherwise drop the binding, reply `ack(invalid, 0)` with an empty
   nonce, close.
10. Request ID equal to the last one taken, with a reply remembered: send that reply again,
    byte for byte, and do nothing else (an idempotent retry).
11. Request ID not greater than the last: reply `ack(stale, revision)`; nothing else changes.
12. Take the request ID; then:
    - **assign**: unacceptable fields → `invalid`. Consent off → `disabled`. Lease held by
      another Director, or an apply in flight → `busy`. Lease held by the sender: a lower
      revision → `stale`; the same revision with the same assignment → extend the lease,
      `applied`, **without applying again**; the same revision with another assignment →
      `invalid`. Otherwise apply: call the app's commit, which re-checks consent and the
      signed-in account immediately before writing, stores the game ID, title and start time
      together, moves the publishing connection, and only then answers `applied`. If consent
      went off, the credentials changed, or the receiver restarted while it ran, answer
      `disabled`, `wrongAccount` or `expired` respectively and keep no lease; when more than one
      of these happened during the same apply, **the last one wins** (consent off and then
      another account answers `wrongAccount`). If the commit
      answered `applied`, the lease is now (sender, observed address, revision, assignment,
      now + 15 s): report it.
    - **renew**: consent off → `disabled`; no lease → `expired`; another owner → `busy`; another
      revision → `stale`; else extend the lease to now + 15 s, `applied`.
    - **release**: no lease → `expired`; another owner → `busy`; else end the lease (reason
      released), `applied`.
13. Reply `ack(status, the request's revision)` with the binding's nonce, signed with the key the
    request was checked with. Remember it as the reply to this request ID.

Outside frames:

- Consent turned off ends the lease at once (reason consentOff) and invalidates an apply in
  flight. Turning it on changes nothing until the next assignment.
- New credentials for another account (or a key from another secret) end the lease (reason
  accountChanged), drop every binding and invalidate an apply in flight. The same key again
  changes nothing.
- Lease expiry ends the lease (reason expired). A timer does it at the expiry time. The lease is
  measured on a monotonic clock that keeps counting while the device sleeps
  (`CLOCK_MONOTONIC` on iOS, `SystemClock.elapsedRealtime` on Android, `performance.now()` in
  JavaScript), never on the wall clock, so setting the time of day neither shortens nor
  lengthens it. A timer that wakes before the lease is due waits again for what is left; it
  never stops watching a lease that is still held.
- A connection closing drops its binding only.
- A restart, or a rebuilt listener, drops the lease (reason restarted) and every binding.
  Persisted event state survives; a lease, a locked picker or a nonce never does.

When a lease ends for any reason, the last applied event stays selected; the attribution row
disappears and local editing returns. A Director never signs a device out.

Receiver lease, in short:

    free ──assign (consent on, apply → applied)──▶ held(owner, revision)
    held ──renew / same assign from owner──▶ held (expiry = now + 15 s)
    held ──assign from owner, higher revision, apply → applied──▶ held(owner, new revision)
    held ──release from owner │ 15 s without renew │ consent off │ account change │ restart──▶ free
    held ──anything from another Director──▶ held (they get busy)

## Director

Per receiver address and port, over one connection at a time:

1. Connect (2 s timeout). Make a fresh 16-byte challenge. Request IDs start at 1.
2. Send `discover`.
3. Accept a reply only if its request ID is the outstanding request's, it echoes this session's
   challenge, and its type is `announce` or `ack`; ignore anything else (a late reply to an
   older request can never overwrite a newer desired state). Then:
   - key ID not this Director's → the peer is `keyMismatch`: close, fetch the key again, at most
     once a minute. If TeamStation answers with the key already held (or did so in the last
     minute), the peer's key came from another server, or is stale and the peer refetches it:
     treat the peer as `otherAccount`, contacted again only when a sweep finds it;
   - account tag not this Director's → `otherAccount`: close and leave the peer alone;
   - MAC not valid with this Director's key, or (after `announce`) a nonce other than the one
     announced → `invalid`: close.
4. `announce` (only to a `discover`, with a 16-byte nonce): keep the nonce; note consent; if the
   lease is `heldBySender` at the desired revision, the lease is still held and the peer is on
   the event already (`applied` at that revision), so only renew.
   Otherwise, with a desired assignment, send `assign(desired revision, assignment)`.
5. `ack` to an assign or renew: `applied` → the lease is held at that revision; `disabled` or
   `busy` → ask again on the next renew tick; `expired` or `stale` → assign again (counting a
   failure); `invalid` or `failed` → count a failure; `wrongAccount`, `unsupported`,
   `keyMismatch` → close and stop. Three failures in a row → `failed`: stop until the next sweep
   or known-peer probe. `ack` to a release: the peer is `released`.
6. Every 5 s: renew a held lease; otherwise re-send the assignment to a peer that was `disabled`,
   `busy`, or not yet applied.
7. A new desired assignment (a successful event pick) goes out at once if nothing is
   outstanding, otherwise right after the reply. No assignment (the toggle off, no event, sign-out,
   an account switch) sends `release` for a held lease and stops renewing.
8. A reply not received in 3 s counts as a failure and closes the connection. A dropped
   connection is remade after 1, 2 and 4 s; after that the peer is `unreachable` until it is
   found again. Stopping sends a best-effort `release`; a lost one is resolved by the receiver's
   lease expiry.

## Security properties

- Same-account proof is a MAC with a key only that account's devices on that server hold; a bare
  account ID in a packet proves nothing. Matching is by issuer and user ID, never e-mail, name,
  team or event access.
- No token, password, e-mail address, name or code is ever sent; the key itself never is.
- A fresh Director challenge and receiver nonce bind every request after `discover` to one
  connection's session: a frame captured on one connection is `invalid` on any other.
- Request IDs order requests on a connection; revisions order assignments across connections and
  relaunches. A replayed or reordered request cannot move a receiver backwards.
- Frames are at most 4096 bytes and every field length is checked against its maximum before
  any of it is read; MACs are compared in constant time.
- A matching key is proof of account membership, not permission: a receiver's consent toggle
  always decides, and the first valid Director owns the lease until it lets go or it expires.
- The address shown for a controlling Director is the one observed on the socket, never a field.

## Swift API

`import EventControl` (iOS 18, macOS 15). Every type is `Sendable`.

### Shared

```swift
// The device's key, from the server's JSON reply (or from TeamStationKit's TeamStationEventControlKey
// via EventControlCredentials(issuer:userId:accountTag:keyId:key:)).
let credentials = try EventControlCredentials.decode(serverReply: data)

// Cached per account server, in the keychain, under the app's own service.
let store = EventControlKeyStore(service: "app.teamstation.director.eventcontrol")
let server = EventControlCredentials.canonicalOrigin(of: serverURL)!
store.save(credentials, for: server)
store.credentials(for: server)          // EventControlCredentials?
store.remove(for: server)               // sign-out, account change, rejected key

// A random identity made once per installation.
let instance = EventControlInstanceID.persisted(in: .standard, key: "eventControl.instanceId")

// The selected event's assignment: nil with no event, or a game ID that cannot be sent.
let assignment = EventAssignment.from(gameId: chosen?.gameId, title: chosen?.title, startAt: chosen?.startAt)
```

### Receiver side

```swift
let receiver = EventControlReceiver(
  instanceId: instance,
  credentials: credentials,            // nil while signed out: every connection closes unanswered
  consent: settings.allowDirectorOverride,
  apply: { assignment, context in
    // Re-check consent and the signed-in account here, immediately before committing.
    // Store gameId + title + startAt together, move the publishing connection, then:
    return .applied                     // or .disabled / .wrongAccount / .failed / .invalid
  },
  onEvent: { event in
    switch event {
    case let .overrideChanged(state):   // .none or .controlled(EventOverride)
      // state.current?.ownerHost, .assignment.title, .assignment.startDate, .revision
      break
    case let .overrideEnded(held, reason):  // released, expired, consentOff, accountChanged, restarted
      break
    case .keyMismatch:                  // fetch this device's key again, then setCredentials
      break
    }
  }
)
let listener = EventControlListener(receiver: receiver, onStateChange: { state in
  // .stopped, .binding, .listening(port:), .portsUnavailable([47614, 47615])
})
listener.start()
listener.ensureListening()              // from the app's foreground handler
await receiver.setConsent(false)        // ends a lease at once
await receiver.setCredentials(newKey)   // another account ends the lease
await receiver.overrideState            // EventOverrideState
listener.stop()                         // ends any lease, as a restart would
```

`onEvent` is called on the receiver's actor; hop to the main actor before touching UI state.
The listener rebuilds itself (same ports, same instance ID, fresh nonces, no lease) when the
system cancels or fails it while it is current.

### Director side

```swift
var revisions = EventControlRevisionCounter()
let desired = assignment.map { EventControlDesired(revision: revisions.next(), assignment: $0) }

let link = EventControlDirectorLink(
  endpoint: EventControlEndpoint(host: "192.0.2.20", port: 47614),   // from the sweep
  instanceId: instance,
  credentials: credentials,
  desired: desired,
  onUpdate: { peer in registry.update(peer) }   // EventControlPeer: instanceId, state, consent, ackedRevision, lastStatus
)
await link.start()
await link.setDesired(nextDesired)      // a new successful pick (a new revision); nil releases
await link.stop()                       // releases a held lease, then ends; stop(release: false) does not
await link.peer                         // the latest EventControlPeer
await link.isRunning                    // false once it ended on its own: unreachable, failed,
                                        // otherAccount, keyMismatch (refresh the key), unsupported
```

`EventControlPeerRegistry` keeps one entry per instance ID (two apps at one address on two ports
stay two peers; a peer that moved address stays one), with `knownEndpoints` to probe first and
counts by state for a status line. `EventControlDirectorTiming` holds the timeouts and retry
limits; the defaults are the protocol's.

### Tests and previews

`EventControlMemoryConnection.pair()` and `EventControlMemoryConnector` replace the network:
`EventControlReceiver.serve(_:id:)` answers any `EventControlConnection`, and a link takes any
`EventControlConnector`. `EventControlDirectorSession` and `EventControlReceiver.handle(payload:
connection:remoteHost:)` are the two state machines with no transport at all.

## Fixtures and conformance

`Tests/Fixtures` is the contract. The Node reference reads it in place; the Android Cameraman's
JVM tests read a copy in their test resources, and `scripts/checkEventControlContract.cjs` fails
if that or any other copy differs by a byte.

| File | What every implementation must do with it |
| --- | --- |
| `keys.json` | Read each vector as a server reply; the server derivation must produce exactly these keys, key IDs and tags |
| `frames.json` | Encode each message with its named key to exactly `payload` and `frame`; decode each payload back to the same message; verify its MAC |
| `rejections.json` | Refuse each `decode` payload with the named error and field index; decode each `unauthentic` payload but fail its MAC with the named key; read each frame `prefixes` entry as the length or error given |
| `assignments.json` | Build (`build`) and validate (`wire`) each vector to the expected fields or problem |
| `scenarios.json` | Run each scenario against a fresh receiver as its description says, and see every expected reply, close, lease, apply count and end reason |

Run them:

```sh
cd mobile/apps/common/EventControl && swift test         # Swift
socket npm run test.eventControl                         # Node reference, from the repository root
node scripts/swift-changed-line-coverage.cjs --spm mobile/apps/common/EventControl mobile/apps/common/EventControl
```
