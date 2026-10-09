import CameramanCore
@testable import CameramanUI
@testable import EventControl
import Foundation
import Testing

private typealias F = EventOverrideFixture

/// One phone: its desk, its receiver, a fake account server and fake publish sockets.
@MainActor
private final class Phone {
  let store: InMemorySettingsStore
  let server: AccountServerStub
  let sockets = FakeScoreboardSockets()
  let keys: EventControlKeyStore
  let port = F.port()
  let desk: ScoreboardDesk
  let control: EventOverrideController

  init(
    store: InMemorySettingsStore = F.store(gameId: F.gameA),
    server: AccountServerStub = .signedIn(),
    keys: EventControlKeyStore = .inMemory(),
    leaseDuration: TimeInterval = EventControlProtocol.leaseDuration,
    rebindDelay: TimeInterval = 0.5,
    keyRetryInterval: TimeInterval = 60,
    now: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.store = store
    self.server = server
    self.keys = keys
    desk = ScoreboardDesk(store: store, http: server.http, openSocket: sockets.opener)
    control = EventOverrideController(
      desk: desk,
      keys: keys,
      instanceId: EventControlInstanceID(hex: "000000000000000000000000000000e1")!,
      ports: [ port ],
      rebindDelay: rebindDelay,
      leaseDuration: leaseDuration,
      keyRetryInterval: keyRetryInterval,
      now: now
    )
  }

  /// Started, allowed, keyed and listening.
  func ready() async -> Bool {
    control.start()
    control.setConsent(true)
    await control.settle()
    return await eventually { self.control.listenerState == .listening(port: self.port) }
  }

  var keyServer: String { EventControlCredentials.canonicalOrigin(of: URL(string: ScoreboardTarget.accountOrigin())!)! }

  func stop() {
    control.listener.stop()
  }
}

private func desired(_ revision: UInt64, _ assignment: EventAssignment) -> EventControlDesired {
  EventControlDesired(revision: revision, assignment: assignment)
}

private func applied(_ link: EventControlDirectorLink, _ revision: UInt64) async -> Bool {
  await eventually { await link.peer.state == .applied(revision) }
}

@Suite("Director override on this phone", .serialized)
@MainActor
struct EventOverrideControllerTests {
  @Test
  func aPickIsRefusedWhileTheReceiverHoldsTheEventEvenBeforeTheLockShows() async {
    let phone = Phone()
    defer { phone.stop() }
    phone.server.answer("events", 200, [ [ "gameId": F.gameA, "awayTeamName": "Visitors", "homeTeamName": "Pioneers", "startAt": "2026-09-21T17:30:00Z" ] ])
    #expect(await phone.ready())
    phone.desk.openEvents()
    #expect(await eventually { phone.desk.snapshot.upcoming.count == 1 })
    phone.desk.dismissEvents()

    let director = F.director(phone.control.receiver, desired: desired(100, F.assignmentB))
    await director.start()
    #expect(await applied(director, 100))
    #expect(await eventually { phone.desk.snapshot.eventLocked })
    // As in the moment between the commit and `.overrideChanged` reaching the desk.
    phone.desk.setOverride(nil)
    phone.desk.choose(gameId: F.gameA)
    try? await Task.sleep(for: .milliseconds(100))
    #expect(ScoreboardTarget.load(phone.store).gameId == F.gameB)

    await director.stop()
    #expect(await eventually { await !phone.control.receiver.holdsEvent })
    phone.desk.choose(gameId: F.gameA)
    #expect(await eventually { ScoreboardTarget.load(phone.store).gameId == F.gameA })
  }

  @Test
  func aDirectorSetsTheEventAndTheScreenSaysWhoHoldsIt() async {
    let phone = Phone()
    defer { phone.stop() }
    #expect(await phone.ready())
    #expect(phone.desk.snapshot.eventControlStatus == "Waiting for a Director")
    #expect(phone.control.isEligible)

    let director = F.director(phone.control.receiver, desired: desired(100, F.assignmentB))
    await director.start()
    #expect(await applied(director, 100))
    #expect(await eventually { phone.desk.snapshot.eventLocked })
    #expect(phone.desk.snapshot.overrideLine == "Override from Director 192.0.2.1")
    #expect(phone.desk.snapshot.gameTitle == "Pioneers at Comets")
    #expect(phone.desk.snapshot.canPickEvent == false)
    let saved = ScoreboardTarget.load(phone.store)
    #expect(saved.gameId == F.gameB)
    #expect(saved.gameStartAt == F.assignmentB.startAt)
    #expect(saved.route == .event)
    #expect(saved.token == "tok-one")
    #expect(saved.apiServer == "wss://v1.example.test")
    #expect(saved.v1EventId == "evt7")

    // A reading now goes to B, with this phone's own login.
    phone.desk.publish(pitchMph: 77, exitMph: 0)
    #expect(phone.sockets.opened.last?.url == F.urlB)
    #expect(phone.sockets.opened.last?.authorization == "Bearer tok-one")

    // Director picks A: the next reading, the same speed, reaches A.
    await director.setDesired(desired(200, F.assignmentA))
    #expect(await applied(director, 200))
    phone.desk.publish(pitchMph: 77, exitMph: 0)
    #expect(phone.sockets.sent(to: F.urlA) == [ "{\"pitchSpeed\":77}" ])
    #expect(phone.sockets.sent(to: F.urlB) == [ "{\"pitchSpeed\":77}" ])

    // Director lets go: unlocked, and A stays.
    await director.stop()
    #expect(await eventually { !phone.desk.snapshot.eventLocked })
    #expect(ScoreboardTarget.load(phone.store).gameId == F.gameA)
  }

  @Test
  func theFirstDirectorKeepsTheEventUntilItLetsGo() async {
    let phone = Phone()
    defer { phone.stop() }
    #expect(await phone.ready())
    let first = F.director(phone.control.receiver, instance: "d001", desired: desired(100, F.assignmentB))
    await first.start()
    #expect(await applied(first, 100))
    let second = F.director(phone.control.receiver, instance: "d002", desired: desired(900, F.assignmentA))
    await second.start()
    #expect(await eventually { await second.peer.state == .busy })
    #expect(ScoreboardTarget.load(phone.store).gameId == F.gameB)
    await first.stop()
    #expect(await applied(second, 900))
    #expect(ScoreboardTarget.load(phone.store).gameId == F.gameA)
    await second.stop()
  }

  @Test
  func anotherAccountIsTurnedAwayAndChangesNothing() async {
    let phone = Phone()
    defer { phone.stop() }
    #expect(await phone.ready())
    let stranger = F.director(phone.control.receiver, desired: desired(100, F.assignmentB), key: EventKeys.two)
    await stranger.start()
    #expect(await eventually { await stranger.peer.state == .otherAccount })
    #expect(ScoreboardTarget.load(phone.store).gameId == F.gameA)
    #expect(phone.desk.snapshot.eventLocked == false)
  }

  @Test
  func withoutConsentNothingIsListeningAndNothingChanges() async {
    let phone = Phone()
    defer { phone.stop() }
    phone.control.start()
    await phone.control.settle()
    #expect(phone.control.isEligible)
    #expect(phone.control.listenerState == .stopped)
    #expect(phone.desk.snapshot.eventControlStatus == "")
    let director = F.director(phone.control.receiver, desired: desired(100, F.assignmentB))
    await director.start()
    #expect(await eventually { await director.peer.state == .disabled })
    #expect(ScoreboardTarget.load(phone.store).gameId == F.gameA)
    await director.stop()
  }

  @Test
  func consentOffReleasesAtOnceThenStopsListening() async {
    let phone = Phone()
    defer { phone.stop() }
    #expect(await phone.ready())
    let director = F.director(phone.control.receiver, desired: desired(100, F.assignmentB))
    await director.start()
    #expect(await eventually { phone.desk.snapshot.eventLocked })

    phone.control.setConsent(false)
    // Local editing is back before anything else happens.
    #expect(phone.desk.snapshot.eventLocked == false)
    #expect(phone.desk.snapshot.canPickEvent)
    await phone.control.settle()
    #expect(await phone.control.receiver.overrideState == .none)
    #expect(await eventually { phone.control.listenerState == .stopped })
    // The listener is gone, and with it the Director's session: it holds nothing any more.
    #expect(await eventually { await director.peer.state != .applied(100) })
    #expect(ScoreboardTarget.load(phone.store).gameId == F.gameB)
    #expect(ScoreboardTarget.load(phone.store).allowDirectorOverride == false)
    await director.stop(release: false)
  }

  @Test
  func anExpiredHoldUnlocksAndKeepsTheEvent() async {
    let phone = Phone(leaseDuration: 0.3)
    defer { phone.stop() }
    #expect(await phone.ready())
    let director = F.director(phone.control.receiver, desired: desired(100, F.assignmentB))
    await director.start()
    #expect(await eventually { phone.desk.snapshot.eventLocked })
    // Director vanishes without a word.
    await director.stop(release: false)
    #expect(await eventually { !phone.desk.snapshot.eventLocked })
    #expect(phone.desk.snapshot.gameTitle == "Pioneers at Comets")
    #expect(ScoreboardTarget.load(phone.store).gameId == F.gameB)
  }

  @Test
  func aRestartKeepsConsentAndTheEventButNoHold() async {
    let store = F.store(gameId: F.gameA)
    let keys = EventControlKeyStore.inMemory()
    let first = Phone(store: store, keys: keys)
    #expect(await first.ready())
    let director = F.director(first.control.receiver, desired: desired(100, F.assignmentB))
    await director.start()
    #expect(await eventually { first.desk.snapshot.eventLocked })
    await director.stop(release: false)
    first.stop()

    let again = Phone(store: store, keys: keys)
    defer { again.stop() }
    #expect(again.desk.snapshot.allowDirectorOverride)
    #expect(again.desk.snapshot.eventLocked == false)
    #expect(again.desk.snapshot.gameTitle == "Pioneers at Comets")
    again.control.start()
    await again.control.settle()
    #expect(await again.control.receiver.overrideState == .none)
    #expect(await eventually { again.control.listenerState == .listening(port: again.port) })
  }

  @Test
  func signingOutDropsTheKeyAndTheHold() async {
    let phone = Phone()
    defer { phone.stop() }
    #expect(await phone.ready())
    #expect(phone.keys.credentials(for: phone.keyServer) != nil)
    let director = F.director(phone.control.receiver, desired: desired(100, F.assignmentB))
    await director.start()
    #expect(await eventually { phone.desk.snapshot.eventLocked })

    phone.desk.signOut()
    #expect(phone.desk.snapshot.eventLocked == false)
    await phone.control.settle()
    #expect(phone.keys.credentials(for: phone.keyServer) == nil)
    #expect(phone.control.credentials == nil)
    #expect(await phone.control.receiver.overrideState == .none)
    #expect(await eventually { phone.control.listenerState == .stopped })
    #expect(phone.desk.snapshot.eventControlStatus == "Log in to TeamStation to allow it")
    let saved = ScoreboardTarget.load(phone.store)
    #expect(saved.gameId == F.gameB)
    #expect(saved.allowDirectorOverride)
    await director.stop(release: false)
  }

  @Test
  func anotherAccountSigningInReplacesTheKey() async {
    let phone = Phone()
    defer { phone.stop() }
    #expect(await phone.ready())
    #expect(phone.control.credentials?.scope.userId == "1001")
    phone.server.answer("auth/email-code/verify", 200, [
      "token": "tok-two",
      "expiresAt": "2026-12-01T00:00:00Z",
      "user": [ "id": "1002", "displayName": "Aaron Judge", "email": "two@example.test" ]
    ])
    phone.server.answer("auth/me", 200, [ "id": "1002" ])
    phone.server.answer("device-event-control/key", 200, EventKeys.two)
    phone.desk.verify(email: "two@example.test", code: "123456")
    #expect(await eventually { phone.desk.userId == "1002" })
    #expect(await eventually { phone.control.credentials?.scope.userId == "1002" })
    await phone.control.settle()
    #expect(phone.keys.credentials(for: phone.keyServer)?.scope.userId == "1002")
    #expect(phone.server.requests.last == "device-event-control/key Bearer tok-two")
    #expect(phone.control.isEligible)
  }

  @Test
  func anOlderLoginIsBackfilledBeforeItTakesPart() async {
    let phone = Phone(store: F.store(userId: "", gameId: F.gameA))
    defer { phone.stop() }
    #expect(phone.desk.userId == "")
    #expect(await phone.ready())
    #expect(phone.desk.userId == "1001")
    #expect(ScoreboardTarget.load(phone.store).userId == "1001")
    #expect(phone.server.count("auth/me") == 1)
  }

  @Test
  func offlineAKeptKeyStillServesTheValidatedUser() async {
    let keys = EventControlKeyStore.inMemory()
    let server = AccountServerStub()
    let phone = Phone(server: server, keys: keys)
    keys.save(EventKeys.credentials(EventKeys.one), for: phone.keyServer)
    defer { phone.stop() }
    #expect(await phone.ready())
    #expect(phone.control.isEligible)
    #expect(phone.control.keyProblem == nil)
    #expect(phone.desk.userId == "1001")
  }

  @Test
  func offlineWithNothingProvedItWaits() async {
    let phone = Phone(store: F.store(userId: "", allow: true), server: AccountServerStub())
    defer { phone.stop() }
    phone.control.start()
    await phone.control.settle()
    #expect(phone.control.isEligible == false)
    #expect(phone.control.keyProblem == .offline)
    #expect(phone.control.listenerState == .stopped)
    #expect(phone.desk.snapshot.eventControlStatus == "Waiting for the account server")

    // Back in the foreground with the server reachable.
    phone.server.answer("auth/me", 200, [ "id": "1001" ])
    phone.server.answer("device-event-control/key", 200, EventKeys.one)
    phone.control.handleForeground()
    await phone.control.settle()
    #expect(phone.control.isEligible)
    #expect(await eventually { phone.control.listenerState == .listening(port: phone.port) })
  }

  @Test
  func aKeyThatCouldNotBeFetchedIsAskedForAgainWithNoNudge() async {
    let server = AccountServerStub.signedIn()
    server.unreachable("device-event-control/key")
    let phone = Phone(server: server, keyRetryInterval: 0.3)
    defer { phone.stop() }
    phone.control.start()
    phone.control.setConsent(true)
    await phone.control.settle()
    #expect(phone.control.keyProblem == .offline)
    #expect(phone.control.keyRetryPending)
    #expect(phone.server.count("device-event-control/key") == 1)

    // A server restarting behind its proxy answers 502: offline too, and asked again.
    phone.server.answer("device-event-control/key", 502)
    #expect(await eventually { phone.server.count("device-event-control/key") == 2 })
    await phone.control.settle()
    #expect(phone.control.keyProblem == .offline)
    #expect(phone.control.keyRetryPending)

    // Back on the network, with the phone left in the foreground: no nudge of any kind.
    phone.server.answer("device-event-control/key", 200, EventKeys.one)
    #expect(await eventually { phone.control.isEligible })
    #expect(await eventually { phone.control.listenerState == .listening(port: phone.port) })
    #expect(phone.server.count("device-event-control/key") == 3)
    #expect(!phone.control.keyRetryPending)
  }

  @Test
  func aRefusedOrUnofferedKeyIsNotAskedForAgain() async {
    let server = AccountServerStub.signedIn()
    server.answer("device-event-control/key", 503, [ "error": "deviceEventControlUnavailable" ])
    let phone = Phone(server: server, keyRetryInterval: 0.05)
    defer { phone.stop() }
    phone.control.start()
    phone.control.setConsent(true)
    await phone.control.settle()
    #expect(phone.control.keyProblem == .unavailable)
    #expect(!phone.control.keyRetryPending)
    try? await Task.sleep(for: .milliseconds(500))
    await phone.control.settle()
    #expect(phone.server.count("device-event-control/key") == 1)

    phone.server.answer("device-event-control/key", 401, [ "message": "machine token" ])
    phone.control.refresh()
    await phone.control.settle()
    #expect(phone.control.keyProblem == .rejected)
    #expect(!phone.control.keyRetryPending)
    try? await Task.sleep(for: .milliseconds(500))
    await phone.control.settle()
    #expect(phone.server.count("device-event-control/key") == 2)
  }

  @Test
  func consentOffOrSigningOutEndsTheWaitToAskAgain() async {
    let server = AccountServerStub.signedIn()
    server.unreachable("device-event-control/key")
    let phone = Phone(server: server, keyRetryInterval: 0.5)
    defer { phone.stop() }
    phone.control.start()
    await phone.control.settle()
    // Not allowed: nothing to wait for.
    #expect(phone.control.keyProblem == .offline)
    #expect(!phone.control.keyRetryPending)

    // Allowed: one wait, however often it is allowed.
    phone.control.setConsent(true)
    phone.control.setConsent(true)
    await phone.control.settle()
    #expect(phone.control.keyRetryPending)
    #expect(await eventually { phone.server.count("device-event-control/key") >= 2 })
    await phone.control.settle()
    try? await Task.sleep(for: .milliseconds(150))
    #expect(phone.server.count("device-event-control/key") == 2)

    // Not allowed any more: the wait ends, and nothing is asked.
    phone.control.setConsent(false)
    #expect(!phone.control.keyRetryPending)
    try? await Task.sleep(for: .milliseconds(1000))
    await phone.control.settle()
    #expect(phone.server.count("device-event-control/key") == 2)

    // Signed out while waiting: the wait ends, and nothing is asked.
    phone.control.setConsent(true)
    #expect(phone.control.keyRetryPending)
    phone.desk.signOut()
    await phone.control.settle()
    #expect(!phone.control.keyRetryPending)
    try? await Task.sleep(for: .milliseconds(1000))
    await phone.control.settle()
    #expect(phone.server.count("device-event-control/key") == 2)
  }

  @Test
  func aKeyKeptButNotRefetchableStaysInUse() async {
    let phone = Phone()
    defer { phone.stop() }
    #expect(await phone.ready())
    phone.server.unreachable("device-event-control/key")
    phone.control.refresh()
    await phone.control.settle()
    #expect(phone.control.isEligible)
    #expect(phone.control.keyProblem == nil)
  }

  @Test
  func aRefusedLoginIsForgotten() async {
    let phone = Phone()
    defer { phone.stop() }
    #expect(await phone.ready())
    phone.server.answer("auth/me", 401, [ "message": "expired" ])
    phone.control.refresh()
    await phone.control.settle()
    #expect(phone.control.isEligible == false)
    #expect(phone.control.keyProblem == .rejected)
    #expect(phone.keys.credentials(for: phone.keyServer) == nil)
    #expect(phone.desk.userId == "")
    #expect(await eventually { phone.control.listenerState == .stopped })
    #expect(phone.desk.snapshot.eventControlStatus == "Log in to TeamStation again to allow it")
  }

  @Test
  func whatTheKeyRouteAnswersDecidesWhetherToListen() async {
    let phone = Phone()
    defer { phone.stop() }
    phone.server.answer("device-event-control/key", 503, [ "error": "deviceEventControlUnavailable" ])
    phone.control.start()
    phone.control.setConsent(true)
    await phone.control.settle()
    #expect(phone.control.keyProblem == .unavailable)
    #expect(phone.desk.snapshot.eventControlStatus == "Not offered by this account server")
    #expect(phone.control.listenerState == .stopped)
    // Coming back to the foreground does not ask a server that does not offer it.
    let asked = phone.server.count("device-event-control/key")
    phone.control.handleForeground()
    await phone.control.settle()
    #expect(phone.server.count("device-event-control/key") == asked)

    phone.server.answer("device-event-control/key", 401, [ "message": "machine token" ])
    phone.control.refresh()
    await phone.control.settle()
    #expect(phone.control.keyProblem == .rejected)

    // A key for somebody else is never used.
    phone.server.answer("device-event-control/key", 200, EventKeys.two)
    phone.control.refresh()
    await phone.control.settle()
    #expect(phone.control.keyProblem == .unavailable)
    #expect(phone.keys.credentials(for: phone.keyServer) == nil)

    phone.server.answer("device-event-control/key", 200, EventKeys.one)
    phone.control.refresh()
    await phone.control.settle()
    #expect(phone.control.isEligible)
  }

  @Test
  func aDirectorWithARotatedKeyMakesThePhoneFetchItsOwnAgainOnce() async {
    let clock = TestClockBox()
    let phone = Phone(now: { clock.now })
    defer { phone.stop() }
    #expect(await phone.ready())
    let before = phone.server.count("device-event-control/key")
    phone.server.answer("device-event-control/key", 200, EventKeys.oneRotated)
    let rotated = F.director(phone.control.receiver, desired: desired(100, F.assignmentB), key: EventKeys.oneRotated)
    await rotated.start()
    #expect(await eventually { await rotated.peer.state == .keyMismatch })
    await phone.control.settle()
    #expect(await eventually { phone.control.credentials?.keyId == "db120a71e5f6d52a" })
    #expect(phone.server.count("device-event-control/key") == before + 1)

    // Another mismatch within the minute does not ask again.
    let stale = F.director(phone.control.receiver, desired: desired(100, F.assignmentB), key: EventKeys.one)
    await stale.start()
    #expect(await eventually { await stale.peer.state == .keyMismatch })
    await phone.control.settle()
    #expect(phone.server.count("device-event-control/key") == before + 1)
  }

  @Test
  func aCancelledListenerIsBoundAgainOnTheSamePortInTheForeground() async {
    let phone = Phone(rebindDelay: 60)
    defer { phone.stop() }
    #expect(await phone.ready())
    phone.control.listener.cancelAsTheSystemWould()
    #expect(await eventually { phone.control.listenerState == .binding })
    phone.control.handleForeground()
    #expect(await eventually { phone.control.listenerState == .listening(port: phone.port) })
  }

  @Test
  func anAssignmentForAPhoneThatSignedOutMeanwhileIsRefused() async {
    let phone = Phone()
    defer { phone.stop() }
    #expect(await phone.ready())
    let context = EventControlApplyContext(
      ownerInstanceId: EventControlInstanceID(hex: "000000000000000000000000000000d1")!,
      ownerHost: "192.0.2.1",
      revision: 5
    )
    #expect(phone.control.commit(F.assignmentB, context) == .applied)
    let older = EventControlApplyContext(ownerInstanceId: context.ownerInstanceId, ownerHost: "192.0.2.1", revision: 4)
    #expect(phone.control.commit(F.assignmentA, older) == .stale)
    // The desk still showing another Director's hold that the receiver has already ended does not
    // refuse the Director the receiver let through.
    phone.desk.setOverride(ScoreboardAssignmentSource(owner: "00000000000000000000000000000000", host: "192.0.2.9", revision: 1, userId: "1001"))
    #expect(phone.control.commit(F.assignmentA, context) == .applied)
    // Once a hold has ended, the order starts again, as it does in the receiver.
    phone.desk.setOverride(nil)
    #expect(phone.control.commit(F.assignmentB, older) == .applied)
    phone.desk.setAllowDirectorOverride(false)
    #expect(phone.control.commit(F.assignmentA, context) == .disabled)
    phone.desk.signOut()
    #expect(phone.control.commit(F.assignmentA, context) == .wrongAccount)
    #expect(ScoreboardTarget.load(phone.store).gameId == F.gameB)
  }

  @Test
  func theStatusLineSaysWhatIsMissing() {
    let line = EventOverrideController.statusLine
    #expect(line(false, false, nil, .stopped) == "Log in to TeamStation to allow it")
    #expect(line(true, false, .rejected, .stopped) == "Log in to TeamStation again to allow it")
    #expect(line(true, false, .unavailable, .stopped) == "Not offered by this account server")
    #expect(line(true, false, .offline, .stopped) == "Waiting for the account server")
    #expect(line(true, false, nil, .stopped) == "Waiting for the account server")
    #expect(line(true, true, nil, .binding) == "Starting")
    #expect(line(true, true, nil, .listening(port: 47614)) == "Waiting for a Director")
    #expect(line(true, true, nil, .portsUnavailable([ 47614, 47615 ])) == "Ports 47614 and 47615 are in use")
  }
}

/// A clock a test moves by hand.
final class TestClockBox: @unchecked Sendable {
  private let lock = NSLock()
  private var current = Date(timeIntervalSince1970: 1_790_013_600)

  var now: Date { lock.withLock { current } }

  func advance(_ seconds: TimeInterval) {
    lock.withLock { current = current.addingTimeInterval(seconds) }
  }
}
