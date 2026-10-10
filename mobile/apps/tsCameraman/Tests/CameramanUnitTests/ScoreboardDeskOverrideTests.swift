import CameramanCore
@testable import CameramanUI
import EventControl
import Foundation
import Testing

private typealias F = EventOverrideFixture

@MainActor
private func desk(
  _ store: InMemorySettingsStore,
  server: AccountServerStub = .signedIn(),
  sockets: FakeScoreboardSockets = FakeScoreboardSockets(),
  hold: TimeInterval = 5
) -> ScoreboardDesk {
  ScoreboardDesk(store: store, http: server.http, openSocket: sockets.opener, pitchHoldSeconds: hold)
}

private func from(_ owner: String = "d1", revision: UInt64 = 10, userId: String = "1001") -> ScoreboardAssignmentSource {
  ScoreboardAssignmentSource(owner: owner, host: "192.0.2.10", revision: revision, userId: userId)
}

@Suite("Scoreboard desk under a Director's event", .serialized)
@MainActor
struct ScoreboardDeskOverrideTests {
  @Test
  func anAssignmentWritesTheGameAndNothingElse() {
    let store = F.store(allow: true)
    let board = desk(store)
    let before = ScoreboardTarget.load(store)
    let outcome = board.applyAssignedEvent(
      gameId: F.gameB, title: "Pioneers at Comets", startAt: "2026-09-21T17:30:00Z", from: from()
    )
    #expect(outcome == .applied)
    let after = ScoreboardTarget.load(store)
    #expect(after.gameId == F.gameB)
    #expect(after.gameTitle == "Pioneers at Comets")
    #expect(after.gameStartAt == "2026-09-21T17:30:00Z")
    var unchanged = after
    unchanged.gameId = before.gameId
    unchanged.gameTitle = before.gameTitle
    unchanged.gameStartAt = before.gameStartAt
    #expect(unchanged == before)
    #expect(board.snapshot.gameTitle == "Pioneers at Comets")
  }

  @Test
  func everyCheckIsMadeBeforeAnythingIsWritten() {
    let store = F.store(allow: false)
    let board = desk(store)
    #expect(board.applyAssignedEvent(gameId: F.gameB, title: "B", startAt: "2026-09-21T17:30:00Z", from: from()) == .disabled)
    board.setAllowDirectorOverride(true)
    #expect(board.applyAssignedEvent(gameId: F.gameB, title: "B", startAt: "2026-09-21T17:30:00Z", from: from(userId: "1002")) == .wrongAccount)
    #expect(ScoreboardTarget.load(store).gameId == "gam_local")

    #expect(board.applyAssignedEvent(gameId: F.gameB, title: "B", startAt: "2026-09-21T17:30:00Z", from: from(revision: 10)) == .applied)
    #expect(board.applyAssignedEvent(gameId: F.gameA, title: "A", startAt: "2026-09-21T17:30:00Z", from: from(revision: 9)) == .stale)
    board.setOverride(from(revision: 10))
    // The receiver says who holds the event. Its lease on d1 ended and d2's assignment reached the
    // desk before that ending did: d2 is applied, not refused on the desk's out-of-date mirror.
    #expect(board.applyAssignedEvent(gameId: F.gameA, title: "A", startAt: "2026-09-21T17:30:00Z", from: from("d2", revision: 50)) == .applied)
    #expect(ScoreboardTarget.load(store).gameId == F.gameA)

    board.signOut()
    #expect(board.applyAssignedEvent(gameId: F.gameB, title: "B", startAt: "2026-09-21T17:30:00Z", from: from(revision: 60)) == .wrongAccount)
    #expect(ScoreboardTarget.load(store).gameId == F.gameA)
  }

  @Test
  func aHoldLocksThePickerAndEveryOtherWayToChangeTheEvent() async {
    let store = F.store(allow: true)
    let server = AccountServerStub.signedIn()
    server.answer("events", 200, [ [ "gameId": F.gameA, "awayTeamName": "Visitors", "homeTeamName": "Pioneers", "startAt": "2026-09-21T17:30:00Z" ] ])
    let board = desk(store, server: server)
    board.openEvents()
    #expect(await eventually { board.snapshot.upcoming.count == 1 })
    #expect(board.snapshot.pickerOpen)

    // A Director takes the event while the list is up: the list closes and stays shut.
    _ = board.applyAssignedEvent(gameId: F.gameB, title: "Pioneers at Comets", startAt: "2026-09-21T17:30:00Z", from: from())
    board.setOverride(from())
    #expect(board.snapshot.pickerOpen == false)
    #expect(board.snapshot.eventLocked)
    #expect(board.snapshot.canPickEvent == false)
    #expect(board.snapshot.overrideLine == "Override from Director 192.0.2.10")
    board.openEvents()
    #expect(board.snapshot.pickerOpen == false)
    board.choose(gameId: F.gameA)
    #expect(ScoreboardTarget.load(store).gameId == F.gameB)

    // Over: the event Director set stays, and the operator may change it again.
    board.setOverride(nil)
    #expect(board.snapshot.eventLocked == false)
    #expect(board.snapshot.gameTitle == "Pioneers at Comets")
    board.choose(gameId: F.gameA)
    #expect(ScoreboardTarget.load(store).gameId == F.gameA)
  }

  @Test
  func thePickerAsksTheReceiverAndGivesWayToAnAssignmentWrittenMeanwhile() async {
    let store = F.store(allow: true)
    let server = AccountServerStub.signedIn()
    server.answer("events", 200, [ [ "gameId": F.gameA, "awayTeamName": "Visitors", "homeTeamName": "Pioneers", "startAt": "2026-09-21T17:30:00Z" ] ])
    let board = desk(store, server: server)
    board.openEvents()
    #expect(await eventually { board.snapshot.upcoming.count == 1 })
    board.dismissEvents()

    // The receiver holds the event, though `.overrideChanged` has not reached the desk yet.
    board.directorHoldsEvent = { true }
    board.openEvents()
    board.choose(gameId: F.gameA)
    try? await Task.sleep(for: .milliseconds(100))
    #expect(board.snapshot.pickerOpen == false)
    #expect(ScoreboardTarget.load(store).gameId == "gam_local")

    // Free by the receiver, but a Director's assignment is written while it is being asked.
    board.directorHoldsEvent = { false }
    board.choose(gameId: F.gameA)
    board.openEvents()
    _ = board.applyAssignedEvent(gameId: F.gameB, title: "B", startAt: "2026-09-21T17:30:00Z", from: from())
    try? await Task.sleep(for: .milliseconds(100))
    #expect(ScoreboardTarget.load(store).gameId == F.gameB)
    #expect(board.snapshot.pickerOpen == false)

    // Free, and nothing written meanwhile: the pick goes through.
    board.openEvents()
    #expect(await eventually { board.snapshot.pickerOpen })
    board.choose(gameId: F.gameA)
    #expect(await eventually { ScoreboardTarget.load(store).gameId == F.gameA })
  }

  @Test
  func consentOffGivesTheEventBackAtOnce() {
    let store = F.store(allow: true)
    let board = desk(store)
    _ = board.applyAssignedEvent(gameId: F.gameB, title: "B", startAt: "2026-09-21T17:30:00Z", from: from())
    board.setOverride(from())
    board.setEventControlStatus("Waiting for a Director")
    #expect(board.snapshot.eventLocked)
    board.setAllowDirectorOverride(false)
    #expect(board.snapshot.eventLocked == false)
    #expect(board.snapshot.allowDirectorOverride == false)
    #expect(board.snapshot.eventControlStatus == "")
    #expect(ScoreboardTarget.load(store).allowDirectorOverride == false)
    #expect(ScoreboardTarget.load(store).gameId == F.gameB)
    board.setAllowDirectorOverride(false)
    board.setAllowDirectorOverride(true)
    #expect(board.snapshot.eventControlStatus == "Waiting for a Director")
    #expect(ScoreboardDesk(store: store).snapshot.allowDirectorOverride)
  }

  @Test
  func readingsMoveFromAToBWithNothingOfACrossing() async {
    let sockets = FakeScoreboardSockets()
    let board = desk(F.store(allow: true, gameId: F.gameA), sockets: sockets, hold: 0.2)
    board.publish(pitchMph: 80, exitMph: 0)
    let socketA = sockets.opened.first
    #expect(socketA?.url == F.urlA)
    #expect(socketA?.authorization == "Bearer tok-one")
    #expect(socketA?.sent == [ "{\"pitchSpeed\":80}" ])
    // A reading that arrived for A but has not been sent yet.
    let stampedForA = board.currentTargetStamp()

    #expect(board.applyAssignedEvent(gameId: F.gameB, title: "B", startAt: "2026-09-21T17:30:00Z", from: from()) == .applied)
    #expect(socketA?.closed == .goingAway)
    board.publish(pitchMph: 81, exitMph: 0, stamp: stampedForA)
    // A's pitch clear was due now; it goes nowhere.
    try? await Task.sleep(for: .milliseconds(350))
    #expect(sockets.opened.count == 1)
    #expect(socketA?.sent == [ "{\"pitchSpeed\":80}" ])
    // A's socket failing late changes nothing for B.
    socketA?.deliver(4401)
    try? await Task.sleep(for: .milliseconds(50))
    #expect(board.snapshot.status == "")

    // The same speed again is a fresh reading, and it reaches B with the same login.
    board.publish(pitchMph: 80, exitMph: 0, stamp: board.currentTargetStamp())
    #expect(sockets.opened.count == 2)
    let socketB = sockets.opened.last
    #expect(socketB?.url == F.urlB)
    #expect(socketB?.authorization == "Bearer tok-one")
    #expect(socketB?.sent == [ "{\"pitchSpeed\":80}" ])
    #expect(await eventually { socketB?.sent.count == 2 })
    #expect(socketB?.sent.last == ScoreboardTarget.pitchClearPayload)
    #expect(sockets.sent(to: F.urlA) == [ "{\"pitchSpeed\":80}" ])
  }

  @Test
  func theSameEventAgainLeavesTheSocketAlone() {
    let sockets = FakeScoreboardSockets()
    let board = desk(F.store(allow: true, gameId: F.gameA), sockets: sockets)
    board.publish(pitchMph: 70, exitMph: 0)
    let stamp = board.currentTargetStamp()
    #expect(board.applyAssignedEvent(gameId: F.gameA, title: "A", startAt: "2026-09-21T17:30:00Z", from: from()) == .applied)
    #expect(sockets.opened.first?.closed == nil)
    #expect(board.currentTargetStamp() == stamp)
    board.publish(pitchMph: 71, exitMph: 90)
    #expect(sockets.opened.count == 1)
  }

  @Test
  func onTheV1RouteTheEventIsStoredForLater() {
    let sockets = FakeScoreboardSockets()
    let store = F.store(route: .v1, allow: true, gameId: F.gameA)
    let board = desk(store, sockets: sockets)
    board.publish(pitchMph: 60, exitMph: 0)
    #expect(sockets.opened.first?.url == "wss://v1.example.test/sockets/api/v1/autoState/evt7")
    #expect(board.applyAssignedEvent(gameId: F.gameB, title: "B", startAt: "2026-09-21T17:30:00Z", from: from()) == .applied)
    #expect(sockets.opened.first?.closed == nil)
    #expect(ScoreboardTarget.load(store).route == .v1)
    #expect(ScoreboardTarget.load(store).gameId == F.gameB)
    board.selectRoute(.event)
    board.publish(pitchMph: 61, exitMph: 0)
    #expect(sockets.opened.last?.url == F.urlB)
  }

  @Test
  func aRefusalOnTheCurrentSocketStillStopsIt() async {
    let sockets = FakeScoreboardSockets()
    let board = desk(F.store(gameId: F.gameA), sockets: sockets)
    board.publish(pitchMph: 60, exitMph: 0)
    let socket = sockets.opened.first
    #expect(await eventually { socket?.waiting == 1 })
    socket?.deliver(nil)
    // A message arrived; the desk listens again on the same socket.
    #expect(await eventually { socket?.waiting == 1 })
    socket?.deliver(4403)
    #expect(await eventually { board.snapshot.status == "The scoreboard refused this camera" })
    board.publish(pitchMph: 61, exitMph: 0)
    #expect(sockets.opened.count == 1)
  }

  @Test
  func theRealSocketOpensSendsAndCloses() async {
    // Nothing listens on the discard port; the socket fails, and the desk lets it go.
    let store = InMemorySettingsStore()
    ScoreboardTarget.save(
      ScoreboardSaved(
        route: .v1, apiServer: "ws://127.0.0.1:9", v1EventId: "evt", accountServer: ScoreboardTarget.accountOrigin(),
        token: "", displayName: "", email: "", gameId: "", gameTitle: "", gameStartAt: ""
      ),
      to: store
    )
    let board = ScoreboardDesk(store: store, http: AccountServerStub().http)
    board.publish(pitchMph: 60, exitMph: 0)
    try? await Task.sleep(for: .milliseconds(300))
    board.selectRoute(.v1)
    #expect(board.snapshot.route == .v1)
  }

  @Test
  func signInKeepsTheUserIdAndTellsTheReceiver() async {
    let store = InMemorySettingsStore()
    let server = AccountServerStub()
    server.answer("auth/email-code/verify", 200, [
      "token": "tok-new",
      "expiresAt": "2026-12-01T00:00:00Z",
      "user": [ "id": "1002", "displayName": "Aaron Judge", "email": "two@example.test" ]
    ])
    let board = desk(store, server: server)
    var changes = 0
    board.onAccountChange = { changes += 1 }
    let generation = board.accountGeneration
    board.verify(email: "two@example.test", code: "123456")
    #expect(await eventually { changes == 1 })
    #expect(board.userId == "1002")
    #expect(board.isSignedIn)
    #expect(board.accountGeneration == generation + 1)
    #expect(ScoreboardTarget.load(store).userId == "1002")

    board.signOut()
    #expect(changes == 2)
    #expect(board.userId == "")
    #expect(ScoreboardTarget.load(store).userId == "")
  }

  @Test
  func identityIsBackfilledKeptOfflineAndClearedByARefusal() async {
    let store = F.store(userId: "")
    let server = AccountServerStub()
    server.answer("auth/me", 200, [ "id": 1001, "displayName": "Mookie Betts" ])
    let board = desk(store, server: server)
    #expect(await board.refreshIdentity() == .valid)
    #expect(board.userId == "1001")
    #expect(ScoreboardTarget.load(store).userId == "1001")
    #expect(server.requests.last == "auth/me Bearer tok-one")

    server.unreachable("auth/me")
    #expect(await board.refreshIdentity() == .offline)
    #expect(board.userId == "1001")
    server.answer("auth/me", 500, [ "message": "down" ])
    #expect(await board.refreshIdentity() == .offline)
    server.answer("auth/me", 200, [ "id": "not a number" ])
    #expect(await board.refreshIdentity() == .offline)
    #expect(board.userId == "1001")

    server.answer("auth/me", 401, [ "message": "Sign in again" ])
    #expect(await board.refreshIdentity() == .rejected)
    #expect(board.userId == "")
    #expect(ScoreboardTarget.load(store).userId == "")
    #expect(await board.refreshIdentity() == .rejected)
    #expect(board.isSignedIn, "a refusal is not a sign-out")

    board.signOut()
    #expect(await board.refreshIdentity() == .signedOut)
    #expect(await board.fetchEventControlKey() == .superseded)
  }

  @Test
  func anAnswerForAnEarlierLoginIsNotApplied() async {
    let store = F.store(userId: "")
    let server = AccountServerStub()
    let gate = AsyncGate()
    let slow: ScoreboardHTTP = { request in
      await gate.wait()
      return try await server.http(request)
    }
    server.answer("auth/me", 200, [ "id": "1001" ])
    server.answer("device-event-control/key", 401, [ "message": "no" ])
    let board = ScoreboardDesk(store: store, http: slow, openSocket: FakeScoreboardSockets().opener)
    async let identity = board.refreshIdentity()
    async let key = board.fetchEventControlKey()
    try? await Task.sleep(for: .milliseconds(50))
    board.signOut()
    await gate.open()
    #expect(await identity == .superseded)
    #expect(await key == .superseded)
    #expect(board.userId == "")

    // A request that fails after the login changed is not taken as the new login's refusal.
    let later = AsyncGate()
    let failing = ScoreboardDesk(
      store: F.store(),
      http: { _ in
        await later.wait()
        let url = URL(string: "https://app.example.test/api/v1/auth/me")!
        return (Data("{}".utf8), HTTPURLResponse(url: url, statusCode: 401, httpVersion: nil, headerFields: nil)!)
      },
      openSocket: FakeScoreboardSockets().opener
    )
    async let failedIdentity = failing.refreshIdentity()
    async let failedKey = failing.fetchEventControlKey()
    try? await Task.sleep(for: .milliseconds(50))
    failing.signOut()
    await later.open()
    #expect(await failedIdentity == .superseded)
    #expect(await failedKey == .superseded)
  }

  @Test
  func theKeyAnswerIsSortedIntoWhatToDoNext() async {
    let server = AccountServerStub()
    let board = desk(F.store(), server: server)
    server.answer("device-event-control/key", 200, EventKeys.one)
    guard case let .key(data) = await board.fetchEventControlKey() else {
      Issue.record("no key")
      return
    }
    let decoded = try? EventControlCredentials.decode(serverReply: data)
    #expect(decoded.map { EventKeys.credentials(EventKeys.one).isSameAccount(as: $0) } == true)
    #expect(server.requests.last == "device-event-control/key Bearer tok-one")
    server.answer("device-event-control/key", 401, [ "message": "machine token" ])
    #expect(await board.fetchEventControlKey() == .rejected)
    server.answer("device-event-control/key", 503, [ "code": "unavailable", "error": "deviceEventControlUnavailable" ])
    #expect(await board.fetchEventControlKey() == .unavailable)
    server.answer("device-event-control/key", 404, [ "message": "Not found" ])
    #expect(await board.fetchEventControlKey() == .unavailable)
    server.answer("device-event-control/key", 200, [String: Any]())
    #expect(await board.fetchEventControlKey() == .unavailable)
    server.answer("device-event-control/key", 502, [ "message": "gateway" ])
    #expect(await board.fetchEventControlKey() == .offline)
    server.unreachable("device-event-control/key")
    #expect(await board.fetchEventControlKey() == .offline)
  }
}

/// Holds callers until it is opened.
actor AsyncGate {
  private var isOpen = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func wait() async {
    if isOpen { return }
    await withCheckedContinuation { waiters.append($0) }
  }

  func open() {
    isOpen = true
    for waiter in waiters { waiter.resume() }
    waiters = []
  }
}
