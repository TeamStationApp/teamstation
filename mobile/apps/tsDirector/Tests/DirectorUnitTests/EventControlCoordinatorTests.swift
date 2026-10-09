import DirectorCore
import DirectorPipeline
import DirectorSources
import EventControl
import Foundation
import TeamStationKit
import Testing

@testable import DirectorUI

// Synthetic keys: two accounts on one server, and one account's key after the server secret
// rotated. Only their shapes matter here; the derivation is EventControl's own suite's concern.
private let origin = "https://app.example.test"
private let keyOne = TeamStationEventControlKey(
  issuer: origin,
  userId: "1001",
  accountTag: String(repeating: "1", count: 32),
  keyId: String(repeating: "a", count: 16),
  key: String(repeating: "01", count: 32)
)
private let keyTwo = TeamStationEventControlKey(
  issuer: origin,
  userId: "1002",
  accountTag: String(repeating: "2", count: 32),
  keyId: String(repeating: "a", count: 16),
  key: String(repeating: "02", count: 32)
)
private let keyOneRotated = TeamStationEventControlKey(
  issuer: origin,
  userId: "1001",
  accountTag: String(repeating: "3", count: 32),
  keyId: String(repeating: "b", count: 16),
  key: String(repeating: "03", count: 32)
)

private func credentials(_ key: TeamStationEventControlKey) -> EventControlCredentials {
  try! EventControlCredentials(
    issuer: key.issuer,
    userId: key.userId,
    accountTag: key.accountTag,
    keyId: key.keyId,
    key: key.key
  )
}

private let gameA = TeamStationAccount.ChosenEvent(
  gameId: "gam_demoA",
  title: "Visitors at Pioneers",
  startAt: Date(timeIntervalSince1970: 1_790_013_600),
  streamURL: nil
)
private let gameB = TeamStationAccount.ChosenEvent(
  gameId: "gam_demoB",
  title: "Pioneers at Comets",
  startAt: Date(timeIntervalSince1970: 1_790_040_600),
  streamURL: "rtmp://ingest.example.test/live/key"
)

private func endpoint(_ host: String, _ port: UInt16 = 47614) -> EventControlEndpoint {
  EventControlEndpoint(host: host, port: port)
}

private func instance(_ suffix: String) -> EventControlInstanceID {
  EventControlInstanceID(hex: String(repeating: "0", count: 32 - suffix.count) + suffix)!
}

/// The account, answering key requests from a script; offline once the script runs out.
@MainActor
private final class FakeAccount: EventControlAccount {
  var isEventControlEligible = true
  var scope: TeamStationAccountScope? = TeamStationAccountScope(server: origin, userId: "1001")
  var serverURL = URL(string: origin)!
  var chosen: TeamStationAccount.ChosenEvent?
  var answers: [Result<TeamStationEventControlKey, TeamStationError>] = []
  var fetches = 0
  /// How long each answer takes to arrive.
  var answerDelay: Duration?
  /// Which session the keychain holds; a sign-in makes a new one.
  var token = 1

  func deviceEventControlKey() async throws -> TeamStationEventControlKey {
    fetches += 1
    let answer = answers.isEmpty ? .failure(.offline) : answers.removeFirst()
    if let answerDelay {
      let askedWith = token
      try? await Task.sleep(for: answerDelay)
      // As TeamStationAccount does: an answer for the session signed in before is thrown away.
      if token != askedWith { throw TeamStationError.accountChanged }
    }
    switch answer {
    case let .success(key):
      scope = TeamStationAccountScope(server: origin, userId: key.userId)
      return key
    case let .failure(error):
      if error == .notSignedIn {
        // As TeamStationAccount does: a rejected token signs the device out.
        isEventControlEligible = false
        scope = nil
      }
      throw error
    }
  }
}

/// What a receiver committed, in order.
private final class Applied: @unchecked Sendable {
  private let lock = NSLock()
  private var items: [(gameId: String, revision: UInt64)] = []

  func append(_ gameId: String, _ revision: UInt64) {
    lock.withLock { items.append((gameId, revision)) }
  }

  var all: [(gameId: String, revision: UInt64)] { lock.withLock { items } }
  var count: Int { lock.withLock { items.count } }
  var last: (gameId: String, revision: UInt64)? { lock.withLock { items.last } }
}

/// Lease endings a receiver reported.
private final class Endings: @unchecked Sendable {
  private let lock = NSLock()
  private var reasons: [EventOverrideEndReason] = []

  func append(_ reason: EventOverrideEndReason) {
    lock.withLock { reasons.append(reason) }
  }

  var all: [EventOverrideEndReason] { lock.withLock { reasons } }
}

private func makeReceiver(
  _ suffix: String,
  key: TeamStationEventControlKey = keyOne,
  consent: Bool = true,
  applied: Applied = Applied(),
  endings: Endings = Endings(),
  status: EventControlAckStatus = .applied,
  delay: Duration? = nil,
  leaseDuration: TimeInterval = EventControlProtocol.leaseDuration
) -> EventControlReceiver {
  EventControlReceiver(
    instanceId: instance(suffix),
    credentials: credentials(key),
    consent: consent,
    apply: { assignment, context in
      if let delay { try? await Task.sleep(for: delay) }
      applied.append(assignment.gameId, context.revision)
      return status
    },
    leaseDuration: leaseDuration,
    onEvent: { event in
      if case let .overrideEnded(_, reason) = event { endings.append(reason) }
    }
  )
}

/// The network: which receiver answers at which address, and how many connects are under way.
private final class Peers: @unchecked Sendable {
  private let lock = NSLock()
  private var receivers: [EventControlEndpoint: EventControlReceiver] = [:]
  private var ends: [EventControlEndpoint: [EventControlMemoryConnection]] = [:]
  private var attempts: [EventControlEndpoint] = []
  private var nextID: EventControlConnectionID = 1
  private var inFlight = 0
  private(set) var mostInFlight = 0
  var connectDelay: Duration?

  func put(_ receiver: EventControlReceiver?, at endpoint: EventControlEndpoint) {
    lock.withLock { receivers[endpoint] = receiver }
  }

  /// Drops every connection to an address, as a device that restarted would.
  func cut(_ endpoint: EventControlEndpoint) {
    let open = lock.withLock { ends.removeValue(forKey: endpoint) ?? [] }
    for end in open { end.close() }
  }

  var connects: [EventControlEndpoint] { lock.withLock { attempts } }
  var peak: Int { lock.withLock { mostInFlight } }

  var connector: EventControlMemoryConnector {
    EventControlMemoryConnector { [self] endpoint, far in try await accept(endpoint, far) }
  }

  private func accept(_ endpoint: EventControlEndpoint, _ far: EventControlMemoryConnection) async throws {
    let delay = lock.withLock { () -> Duration? in
      attempts.append(endpoint)
      inFlight += 1
      mostInFlight = max(mostInFlight, inFlight)
      return connectDelay
    }
    if let delay { try? await Task.sleep(for: delay) }
    let (receiver, id) = lock.withLock { () -> (EventControlReceiver?, EventControlConnectionID) in
      inFlight -= 1
      defer { nextID += 1 }
      if receivers[endpoint] != nil { ends[endpoint, default: []].append(far) }
      return (receivers[endpoint], nextID)
    }
    guard let receiver else { throw EventControlTransportError.refused("connection refused") }
    Task { await receiver.serve(far, id: id) }
  }
}

/// A camera discovery that sweeps for its participants on request.
private final class SweepingDiscovery: SourceDiscovery, @unchecked Sendable {
  let kind = SourceKind.rtsp
  let joins: Bool
  private(set) var requests = 0
  private(set) var participants: [SweepParticipant] = []
  var isRunning: Bool { true }
  var currentSources: [DiscoveredSource] { [] }

  init(joins: Bool = true) {
    self.joins = joins
  }

  func start(onChange: @escaping DiscoveryChangeHandler) {}
  func stop() {}
  func makeSource(for discovered: DiscoveredSource) throws -> FrameSource {
    throw CompositeDiscoveryError.noDiscovery(for: .rtsp)
  }

  func addSweepParticipant(_ participant: SweepParticipant) -> Bool {
    guard joins else { return false }
    participants.append(participant)
    return true
  }

  func requestSweep() { requests += 1 }
}

private let fastLinks = EventControlDirectorTiming(
  connectTimeout: 1,
  replyTimeout: 0.5,
  renewInterval: 0.1,
  reconnectDelays: [ 0.02, 0.02 ],
  maxFailures: 3
)

/// A clock a test moves by hand.
private final class RigClock: @unchecked Sendable {
  private let lock = NSLock()
  private var seconds: TimeInterval = 1_000

  var now: Date { lock.withLock { Date(timeIntervalSince1970: seconds) } }

  func advance(_ by: TimeInterval) {
    lock.withLock { seconds += by }
  }
}

@MainActor
private final class Rig {
  let account = FakeAccount()
  let peers = Peers()
  let sweep = FakeSweep()
  let store = EventControlKeyStore.inMemory()
  let defaults = UserDefaults(suiteName: "test.eventControl.\(UUID().uuidString)")!
  var sweepers: [CameraSweeper] = []
  var knownPeerInterval: TimeInterval = 60
  var maxConnects = 8
  var keyRetryInterval: TimeInterval = 60
  /// Whether the app has said which camera discovery there is before the test starts, as it has
  /// in every test but the one about the order at launch.
  var discoveryKnown = true
  /// Seconds since 1970 the coordinator reads as now.
  let clock = RigClock()

  lazy var coordinator: EventControlCoordinator = {
    if discoveryKnown { bare.attach(to: nil) }
    return bare
  }()

  lazy var bare = EventControlCoordinator(
    account: account,
    instanceId: instance("d001"),
    keyStore: store,
    connector: peers.connector,
    defaults: defaults,
    timing: EventControlCoordinator.Timing(
      knownPeerInterval: knownPeerInterval,
      maxConcurrentConnects: maxConnects,
      link: fastLinks,
      keyRetryInterval: keyRetryInterval
    ),
    now: { [clock] in clock.now },
    makeOwnSweeper: { [unowned self] in
      let sweeper = CameraSweeper(
        ports: [],
        scan: sweep.scan,
        probeKnown: sweep.probeKnown,
        onResult: { _ in }
      )
      sweepers.append(sweeper)
      return sweeper
    }
  )

  /// Signed in as One with One's key cached, and game A picked.
  func ready(game: TeamStationAccount.ChosenEvent? = gameA, key: TeamStationEventControlKey = keyOne) {
    account.chosen = game
    store.save(credentials(key), for: origin)
  }

  /// A receiver at `endpoint` that the sweep finds there.
  func peer(
    _ receiver: EventControlReceiver,
    at endpoint: EventControlEndpoint,
    swept: Bool = true
  ) {
    peers.put(receiver, at: endpoint)
    guard swept else { return }
    sweptPorts[endpoint.host, default: []].insert(Int(endpoint.port))
    sweep.set(endpoint.host, sweptPorts[endpoint.host])
  }

  private var sweptPorts: [String: Set<Int>] = [:]

  func stopSweepers() {
    for sweeper in sweepers { sweeper.stop() }
  }
}

@MainActor
private func eventually(
  _ seconds: TimeInterval = 5,
  _ condition: @MainActor () async -> Bool
) async -> Bool {
  let deadline = Date().addingTimeInterval(seconds)
  while Date() < deadline {
    if await condition() { return true }
    try? await Task.sleep(for: .milliseconds(20))
  }
  return await condition()
}

private let firstRevision: UInt64 = 1_000_000

@Suite("Event control coordinator", .serialized)
@MainActor
struct EventControlCoordinatorTests {
  // MARK: - Settings state

  @Test("Off by default: no ports in the sweep, no line, nothing contacted")
  func offByDefault() async {
    let rig = Rig()
    rig.ready()
    rig.coordinator.attach(to: nil)
    rig.coordinator.start(enabled: false)
    #expect(rig.coordinator.isEnabled == false)
    #expect(rig.coordinator.status.phase == .off)
    #expect(rig.coordinator.status.line.isEmpty)
    #expect(rig.coordinator.extraSweepPorts.isEmpty)
    #expect(rig.sweepers.isEmpty)
    let telemetry = rig.coordinator.telemetry
    #expect(telemetry.enabled == false)
    #expect(telemetry.phase == "off")
    #expect(telemetry.sweeper == "none")
    // The selected event is ready to go the moment it is switched on.
    #expect(telemetry.gameId == "gam_demoA")
    #expect(telemetry.revision == firstRevision)
  }

  @Test("On, with a cached key: found by its own sweep, assigned, and remembered")
  func findsAndAssignsWithOwnSweep() async {
    let rig = Rig()
    rig.ready()
    let applied = Applied()
    rig.peer(makeReceiver("e001", applied: applied), at: endpoint("192.0.2.20"))
    rig.coordinator.attach(to: nil)
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    #expect(rig.coordinator.extraSweepPorts == [ 47614, 47615 ])
    #expect(await eventually { rig.coordinator.status.applied == 1 })
    #expect(applied.last?.gameId == "gam_demoA")
    #expect(applied.last?.revision == firstRevision)
    #expect(rig.coordinator.status.sweeper == .own)
    #expect(rig.coordinator.status.line == "1 device on this event (found by its own search)")
    #expect(rig.sweepers.count == 1)
    // No network needed: the cached key is enough.
    #expect(rig.account.fetches == 0)
    #expect(rig.defaults.stringArray(forKey: EventControlCoordinator.rememberedPeersKey) == [ "192.0.2.20:47614" ])

    let telemetry = rig.coordinator.telemetry
    #expect(telemetry.phase == "running")
    #expect(telemetry.sweeper == "own")
    #expect(telemetry.sweeps >= 1)
    #expect(telemetry.title == "Visitors at Pioneers")
    #expect(telemetry.peers.count == 1)
    #expect(telemetry.peers.first?.endpoint == "192.0.2.20:47614")
    #expect(telemetry.peers.first?.instanceId == instance("e001").hex)
    #expect(telemetry.peers.first?.state == "applied(\(firstRevision))")
    #expect(telemetry.peers.first?.consent == true)
    #expect(telemetry.peers.first?.ackedRevision == firstRevision)
  }

  @Test("Relaunched offline with a cached key and a token, it stays eligible and works")
  func offlineRelaunchUsesCachedKey() async {
    let rig = Rig()
    rig.ready()
    let applied = Applied()
    rig.peer(makeReceiver("e001", applied: applied), at: endpoint("192.0.2.20"), swept: false)
    rig.defaults.set([ "192.0.2.20:47614" ], forKey: EventControlCoordinator.rememberedPeersKey)
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    #expect(await eventually { applied.count == 1 })
    #expect(rig.account.fetches == 0)
    #expect(rig.coordinator.status.phase == .running)
  }

  @Test("No key cached and no network: says so, and gets one when the network comes back")
  func noKeyOffline() async {
    let rig = Rig()
    rig.account.chosen = gameA
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    #expect(rig.coordinator.status.phase == .gettingKey)
    #expect(rig.coordinator.status.line.hasPrefix("Getting this iPad's device key"))
    await rig.coordinator.settle()
    #expect(rig.coordinator.status.phase == .keyUnavailable(TeamStationError.offline.localizedDescription))
    #expect(rig.coordinator.status.isProblem)
    #expect(rig.coordinator.status.line.hasPrefix("No device key from TeamStation: "))
    #expect(rig.coordinator.extraSweepPorts.isEmpty)

    rig.account.answers = [ .success(keyOne) ]
    rig.coordinator.networkChanged()
    await rig.coordinator.settle()
    #expect(rig.coordinator.status.phase == .running)
    #expect(rig.store.credentials(for: origin) == credentials(keyOne))
    #expect(rig.coordinator.extraSweepPorts == [ 47614, 47615 ])
  }

  @Test("A key fetch that failed offline or on a restarting server is asked again with no nudge")
  func failedKeyFetchIsRetried() async {
    let rig = Rig()
    rig.keyRetryInterval = 0.3
    rig.account.chosen = gameA
    rig.account.answers = [ .failure(.offline), .failure(.server("TeamStation answered 502")), .success(keyOne) ]
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    await rig.coordinator.settle()
    #expect(rig.coordinator.status.phase == .keyUnavailable(TeamStationError.offline.localizedDescription))
    #expect(rig.coordinator.keyRetryPending)
    // Nothing but the wait: no toggle, no event pick, no network change, no resume.
    #expect(await eventually { rig.coordinator.status.phase == .running })
    #expect(rig.account.fetches == 3)
    #expect(rig.store.credentials(for: origin) == credentials(keyOne))
    #expect(!rig.coordinator.keyRetryPending)
  }

  @Test("A server that does not offer it, or a key it cannot read, is not asked again until the account changes")
  func finalKeyFailureIsNotRetried() async {
    let rig = Rig()
    rig.keyRetryInterval = 0.05
    rig.account.chosen = gameA
    rig.account.answers = [ .failure(.unavailable("Device event control is not set up on this server")) ]
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    await rig.coordinator.settle()
    #expect(rig.coordinator.status.phase == .keyUnavailable("Device event control is not set up on this server"))
    #expect(!rig.coordinator.keyRetryPending)
    try? await Task.sleep(for: .milliseconds(500))
    // Nudges do not ask again either.
    rig.coordinator.networkChanged()
    rig.coordinator.resumed()
    await rig.coordinator.settle()
    #expect(rig.account.fetches == 1)
    #expect(rig.coordinator.status.phase == .keyUnavailable("Device event control is not set up on this server"))

    // Another account is asked; its unreadable key is final for it in turn.
    rig.account.scope = TeamStationAccountScope(server: origin, userId: "1002")
    rig.account.answers = [ .success(TeamStationEventControlKey(
      issuer: origin, userId: "1002", accountTag: "nope", keyId: "nope", key: "nope"
    )) ]
    rig.coordinator.accountChanged()
    await rig.coordinator.settle()
    #expect(rig.account.fetches == 2)
    #expect(rig.coordinator.status.phase == .keyUnavailable("TeamStation sent a key this app cannot read."))
    try? await Task.sleep(for: .milliseconds(500))
    rig.coordinator.networkChanged()
    await rig.coordinator.settle()
    #expect(rig.account.fetches == 2)
    #expect(!rig.coordinator.keyRetryPending)

    // Off and on again asks once more.
    rig.account.answers = [ .success(keyTwo) ]
    rig.coordinator.setEnabled(false)
    rig.coordinator.setEnabled(true)
    await rig.coordinator.settle()
    #expect(rig.account.fetches == 3)
    #expect(await eventually { rig.coordinator.status.phase == .running })
  }

  @Test("A rejected token is not asked again")
  func rejectedKeyFetchIsNotRetried() async {
    let rig = Rig()
    rig.keyRetryInterval = 0.05
    rig.account.chosen = gameA
    rig.account.answers = [ .failure(.notSignedIn) ]
    rig.coordinator.start(enabled: true)
    await rig.coordinator.settle()
    #expect(!rig.coordinator.keyRetryPending)
    try? await Task.sleep(for: .milliseconds(500))
    #expect(rig.account.fetches == 1)
  }

  @Test("Switched off, signed out or signed in as someone else, a failed key fetch waits no more")
  func keyRetryEndsWhenNoLongerWanted() async {
    let rig = Rig()
    rig.keyRetryInterval = 0.5
    rig.account.chosen = gameA
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    await rig.coordinator.settle()
    #expect(rig.account.fetches == 1)
    #expect(rig.coordinator.keyRetryPending)

    // Off: no wait left, and nothing asked.
    rig.coordinator.setEnabled(false)
    #expect(!rig.coordinator.keyRetryPending)
    try? await Task.sleep(for: .milliseconds(1000))
    #expect(rig.account.fetches == 1)

    // On again asks at once.
    rig.coordinator.setEnabled(true)
    await rig.coordinator.settle()
    #expect(rig.account.fetches == 2)
    // Nudged five times: the first asks at once and the rest find it on its way. One wait follows.
    for _ in 0 ..< 5 { rig.coordinator.networkChanged() }
    await rig.coordinator.settle()
    #expect(rig.account.fetches == 3)
    #expect(rig.coordinator.keyRetryPending)
    #expect(await eventually { rig.account.fetches >= 4 })
    try? await Task.sleep(for: .milliseconds(150))
    #expect(rig.account.fetches == 4)

    // Signed out: no wait left, and nothing asked.
    rig.account.isEventControlEligible = false
    rig.account.scope = nil
    rig.coordinator.accountChanged()
    #expect(!rig.coordinator.keyRetryPending)
    try? await Task.sleep(for: .milliseconds(1000))
    #expect(rig.account.fetches == 4)

    // Signed in as someone else: asked at once for that account, not after the old wait.
    rig.account.isEventControlEligible = true
    rig.account.scope = TeamStationAccountScope(server: origin, userId: "1002")
    rig.account.answers = [ .success(keyTwo) ]
    rig.coordinator.accountChanged()
    await rig.coordinator.settle()
    #expect(rig.account.fetches == 5)
    #expect(await eventually { rig.coordinator.status.phase == .running })
    #expect(!rig.coordinator.keyRetryPending)
  }

  @Test("A key it cannot read is said, not used")
  func unreadableKey() async {
    let rig = Rig()
    rig.account.chosen = gameA
    rig.account.answers = [ .success(TeamStationEventControlKey(
      issuer: origin, userId: "1001", accountTag: "nope", keyId: "nope", key: "nope"
    )) ]
    rig.coordinator.start(enabled: true)
    await rig.coordinator.settle()
    #expect(rig.coordinator.status.phase == .keyUnavailable("TeamStation sent a key this app cannot read."))
    #expect(rig.store.credentials(for: origin) == nil)
  }

  @Test("A rejected token signs out: the cached key goes and nothing is contacted")
  func rejectedTokenClears() async {
    let rig = Rig()
    rig.account.chosen = gameA
    rig.account.answers = [ .failure(.notSignedIn) ]
    rig.coordinator.start(enabled: true)
    await rig.coordinator.settle()
    rig.coordinator.accountChanged()
    #expect(rig.coordinator.status.phase == .signedOut)
    #expect(rig.coordinator.status.line == "Log in to TeamStation to set the event on nearby devices.")
    #expect(rig.coordinator.extraSweepPorts.isEmpty)
  }

  @Test("Signing out releases every device, stops, and forgets the key, toggle on or off")
  func signOutReleasesAndForgets() async {
    let rig = Rig()
    rig.ready()
    let endings = Endings()
    let receiver = makeReceiver("e001", endings: endings)
    rig.peer(receiver, at: endpoint("192.0.2.20"))
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    #expect(await eventually { rig.coordinator.status.applied == 1 })

    rig.account.isEventControlEligible = false
    rig.account.scope = nil
    rig.account.chosen = nil
    rig.coordinator.accountChanged()
    await rig.coordinator.settle()
    #expect(rig.coordinator.status.phase == .signedOut)
    #expect(rig.coordinator.extraSweepPorts.isEmpty)
    #expect(rig.store.credentials(for: origin) == nil)
    #expect(await eventually { endings.all == [ .released ] })
    #expect(await receiver.overrideState == .none)

    // Signed out with the toggle off: the key still goes.
    let off = Rig()
    off.ready()
    off.coordinator.start(enabled: false)
    off.account.isEventControlEligible = false
    off.coordinator.accountChanged()
    #expect(off.store.credentials(for: origin) == nil)
  }

  @Test("Signed in with no event: nothing to send, and nothing looked for")
  func noEvent() async {
    let rig = Rig()
    rig.ready(game: nil)
    rig.coordinator.start(enabled: true)
    #expect(rig.coordinator.status.phase == .noEvent)
    #expect(rig.coordinator.status.line == "Pick an event to send it to nearby devices.")
    #expect(rig.coordinator.extraSweepPorts.isEmpty)
    #expect(rig.coordinator.desired == nil)
  }

  // MARK: - Events

  @Test("A new event goes out at a new revision, the same one changes nothing, Clear releases")
  func selectionChanges() async {
    let rig = Rig()
    rig.ready()
    let applied = Applied()
    let endings = Endings()
    let receiver = makeReceiver("e001", applied: applied, endings: endings)
    rig.peer(receiver, at: endpoint("192.0.2.20"))
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    #expect(await eventually { applied.last?.gameId == "gam_demoA" })

    rig.account.chosen = gameB
    rig.coordinator.selectionChanged()
    #expect(rig.coordinator.desired?.revision == firstRevision + 1)
    #expect(await eventually { applied.last?.gameId == "gam_demoB" })
    #expect(applied.last?.revision == firstRevision + 1)
    #expect(await eventually { rig.coordinator.status.applied == 1 })

    // B again (its stream address changed, say): the same assignment, no new revision.
    rig.coordinator.selectionChanged()
    #expect(rig.coordinator.desired?.revision == firstRevision + 1)

    rig.account.chosen = nil
    rig.coordinator.selectionChanged()
    await rig.coordinator.settle()
    #expect(rig.coordinator.status.phase == .noEvent)
    #expect(await eventually { endings.all == [ .released ] })
    #expect(await receiver.overrideState == .none)
    #expect(applied.last?.gameId == "gam_demoB")
  }

  @Test("An event changed while the first is still being applied ends on the second")
  func desiredChangesDuringAck() async {
    let rig = Rig()
    rig.ready()
    let applied = Applied()
    rig.peer(makeReceiver("e001", applied: applied, delay: .milliseconds(250)), at: endpoint("192.0.2.20"))
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    #expect(await eventually { rig.coordinator.peers.first?.state == .assigning(firstRevision) })
    rig.account.chosen = gameB
    rig.coordinator.selectionChanged()
    #expect(await eventually { rig.coordinator.peers.first?.state == .applied(firstRevision + 1) })
    #expect(applied.last?.gameId == "gam_demoB")
  }

  @Test("A device that turns up later gets the current event")
  func latePeer() async {
    let rig = Rig()
    rig.ready()
    rig.peer(makeReceiver("e001"), at: endpoint("192.0.2.20"))
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    #expect(await eventually { rig.coordinator.status.applied == 1 })

    let late = Applied()
    rig.peer(makeReceiver("e002", applied: late), at: endpoint("192.0.2.21"))
    rig.coordinator.subnetsChanged()
    #expect(await eventually { rig.coordinator.status.applied == 2 })
    #expect(late.last?.gameId == "gam_demoA")
    #expect(late.last?.revision == firstRevision)
  }

  @Test("A device that fails three times is left until it is found again")
  func retryCap() async {
    let rig = Rig()
    rig.ready()
    let applied = Applied()
    rig.peer(makeReceiver("e001", applied: applied, status: .failed), at: endpoint("192.0.2.20"))
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    #expect(await eventually { rig.coordinator.peers.first?.state == .failed })
    #expect(applied.count == 3)
    #expect(rig.coordinator.telemetry.peers.first?.state == "failed")
    #expect(rig.coordinator.status.applied == 0)
  }

  // MARK: - Accounts and keys

  @Test("Another account: the old one's leases are released and its key discarded")
  func accountSwitch() async {
    let rig = Rig()
    rig.ready()
    let endings = Endings()
    rig.peer(makeReceiver("e001", endings: endings), at: endpoint("192.0.2.20"))
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    #expect(await eventually { rig.coordinator.status.applied == 1 })

    rig.account.scope = TeamStationAccountScope(server: origin, userId: "1002")
    rig.account.answers = [ .success(keyTwo) ]
    rig.coordinator.accountChanged()
    #expect(await eventually { endings.all == [ .released ] })
    await rig.coordinator.settle()
    #expect(rig.store.credentials(for: origin) == credentials(keyTwo))
    // The device stays on One: it is now another account's, and left alone.
    #expect(await eventually { rig.coordinator.status.otherAccount == 1 })
    #expect(rig.coordinator.status.line.contains("1 on another account"))
  }

  @Test("A cached key of another account is never used")
  func cachedKeyOfAnotherAccount() async {
    let rig = Rig()
    rig.ready(key: keyTwo)
    rig.coordinator.start(enabled: true)
    #expect(rig.store.credentials(for: origin) == nil)
    #expect(rig.coordinator.status.phase == .gettingKey)
    await rig.coordinator.settle()
  }

  @Test("A device with a newer key makes this one fetch its own again, then carry on")
  func staleKey() async {
    let rig = Rig()
    rig.ready(key: keyOneRotated)
    let applied = Applied()
    rig.peer(makeReceiver("e001", applied: applied), at: endpoint("192.0.2.20"))
    rig.account.answers = [ .success(keyOne) ]
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    #expect(await eventually { applied.count == 1 })
    #expect(rig.account.fetches == 1)
    #expect(rig.store.credentials(for: origin) == credentials(keyOne))
    #expect(await eventually { rig.coordinator.status.applied == 1 })
  }

  @Test("A device with a key from another server is left alone once this key is confirmed current")
  func peerWithAnotherKey() async {
    let rig = Rig()
    rig.knownPeerInterval = 0.1
    rig.ready()
    let there = endpoint("192.0.2.20")
    rig.peer(makeReceiver("e001", key: keyOneRotated), at: there)
    // The server answers with the key this Director already has, every time it is asked.
    rig.account.answers = Array(repeating: .success(keyOne), count: 4)
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    #expect(await eventually { rig.coordinator.status.otherAccount == 1 })
    await rig.coordinator.settle()
    #expect(rig.account.fetches == 1)
    #expect(rig.coordinator.status.keyMismatch == 0)
    #expect(rig.coordinator.peers.first?.state == .otherAccount)
    #expect(rig.store.credentials(for: origin) == credentials(keyOne))
    #expect(rig.coordinator.status.line.contains("1 on another account"))

    // Known-peer contacts, every 0.1 s here, leave it alone: no connect, no fetch.
    let connects = rig.peers.connects.count
    try? await Task.sleep(for: .milliseconds(500))
    #expect(rig.peers.connects.count == connects)
    #expect(rig.account.fetches == 1)

    // A sweep finds it again: asked again, and with the key just confirmed, no fetch.
    let swept = SubnetScanner.Result(
      openHosts: [ there.host ],
      probedCount: 254,
      subnet: "192.0.2.0/24",
      diagnostic: nil,
      portsByHost: [ there.host: [ Int(there.port) ] ]
    )
    rig.coordinator.swept(swept)
    #expect(await eventually { rig.peers.connects.count == connects + 1 })
    await rig.coordinator.settle()
    #expect(await eventually { rig.coordinator.status.otherAccount == 1 })
    #expect(rig.account.fetches == 1)

    // A minute on, the next sweep that finds it asks TeamStation once more, and only once.
    rig.clock.advance(EventControlCoordinator.keyRecheckInterval)
    rig.coordinator.swept(swept)
    #expect(await eventually { rig.account.fetches == 2 })
    await rig.coordinator.settle()
    #expect(rig.coordinator.status.otherAccount == 1)
    rig.coordinator.swept(swept)
    await rig.coordinator.settle()
    #expect(await eventually { rig.peers.connects.count == connects + 3 })
    await rig.coordinator.settle()
    #expect(rig.account.fetches == 2)

    // An answer to a fetch given up on is ignored.
    rig.coordinator.keyFetched(.success(keyTwo), number: -1)
    #expect(rig.store.credentials(for: origin) == credentials(keyOne))
  }

  @Test("With TeamStation offline, a device's other key asks for this key at most once a minute")
  func peerWithAnotherKeyWhileOffline() async {
    let rig = Rig()
    rig.knownPeerInterval = 0.1
    rig.ready()
    rig.peer(makeReceiver("e001", key: keyOneRotated), at: endpoint("192.0.2.20"))
    // No answers: every fetch fails as offline, so nothing confirms the key.
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    #expect(await eventually { rig.coordinator.status.keyMismatch == 1 })
    // Contacted again every 0.1 s, still the other key, and still only the one fetch.
    let connects = rig.peers.connects.count
    #expect(await eventually { rig.peers.connects.count >= connects + 3 })
    await rig.coordinator.settle()
    #expect(rig.account.fetches == 1)
    rig.clock.advance(EventControlCoordinator.keyRecheckInterval)
    #expect(await eventually { rig.account.fetches == 2 })
  }

  @Test("Signing in as someone else while the first account's key is on its way fetches the new one's")
  func accountSwitchDuringKeyFetch() async {
    let rig = Rig()
    rig.account.chosen = gameA
    rig.account.answerDelay = .milliseconds(300)
    rig.account.answers = [ .success(keyOne), .success(keyTwo) ]
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    #expect(rig.coordinator.status.phase == .gettingKey)
    #expect(await eventually { rig.account.fetches == 1 })
    // Signed in as Two without signing out.
    rig.account.token += 1
    rig.account.scope = TeamStationAccountScope(server: origin, userId: "1002")
    rig.coordinator.accountChanged()
    await rig.coordinator.settle()
    #expect(rig.account.fetches == 2)
    #expect(await eventually { rig.coordinator.status.phase == .running })
    #expect(rig.store.credentials(for: origin) == credentials(keyTwo))
  }

  @Test("Signing in again as the same person while the key is on its way asks again, quietly")
  func sameAccountSignInDuringKeyFetch() async {
    let rig = Rig()
    rig.account.chosen = gameA
    rig.account.answerDelay = .milliseconds(300)
    rig.account.answers = [ .success(keyOne), .success(keyOne) ]
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    #expect(await eventually { rig.account.fetches == 1 })
    // A new session for the same user: the fetch on its way is for the old one.
    rig.account.token += 1
    rig.coordinator.accountChanged()
    await rig.coordinator.settle()
    #expect(rig.account.fetches == 2)
    #expect(await eventually { rig.coordinator.status.phase == .running })
    #expect(rig.store.credentials(for: origin) == credentials(keyOne))
  }

  // MARK: - Turning it off

  @Test("Off with an assignment in flight: nothing more is sent, and the lease runs out")
  func offWithRequestInFlight() async {
    let rig = Rig()
    rig.ready()
    let applied = Applied()
    let endings = Endings()
    let receiver = makeReceiver(
      "e001",
      applied: applied,
      endings: endings,
      delay: .milliseconds(300),
      leaseDuration: 0.6
    )
    rig.peer(receiver, at: endpoint("192.0.2.20"))
    rig.coordinator.start(enabled: true)
    #expect(await eventually { rig.coordinator.peers.first?.state == .assigning(firstRevision) })
    rig.coordinator.setEnabled(false)
    rig.coordinator.setEnabled(false)
    #expect(rig.coordinator.extraSweepPorts.isEmpty)
    #expect(rig.coordinator.peers.isEmpty)
    #expect(rig.coordinator.status.phase == .off)
    await rig.coordinator.settle()
    #expect(await eventually(3) { await receiver.overrideState == .none && applied.count == 1 })
    #expect(endings.all.allSatisfy { $0 == .expired || $0 == .released })
    #expect(applied.count == 1)
  }

  @Test("Switching off and on all day keeps no finished background work")
  func finishedBackgroundWorkIsLetGo() async {
    let rig = Rig()
    rig.ready()
    rig.peer(makeReceiver("e001"), at: endpoint("192.0.2.20"))
    rig.coordinator.start(enabled: true)
    for _ in 0 ..< 10 {
      #expect(await eventually { rig.coordinator.status.applied == 1 })
      rig.coordinator.setEnabled(false)
      rig.coordinator.setEnabled(true)
    }
    #expect(await eventually { rig.coordinator.backgroundCount == 0 })
    rig.coordinator.setEnabled(false)
    await rig.coordinator.settle()
    #expect(rig.coordinator.backgroundCount == 0)
  }

  // MARK: - Peers

  @Test("Two apps at one address on the two ports are two peers")
  func twoPortsOneAddress() async {
    let rig = Rig()
    rig.ready()
    rig.peers.put(makeReceiver("e001"), at: endpoint("192.0.2.20", 47614))
    rig.peers.put(makeReceiver("e002"), at: endpoint("192.0.2.20", 47615))
    rig.sweep.set("192.0.2.20", [ 47614, 47615 ])
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    #expect(await eventually { rig.coordinator.status.applied == 2 })
    #expect(rig.coordinator.peers.count == 2)
    #expect(rig.coordinator.status.line.hasPrefix("2 devices on this event"))
  }

  @Test("One device answering at two addresses is one peer with one link")
  func oneDeviceTwoAddresses() async {
    let rig = Rig()
    rig.ready()
    let receiver = makeReceiver("e001")
    rig.peers.put(receiver, at: endpoint("192.0.2.20"))
    rig.peers.put(receiver, at: endpoint("192.0.2.21"))
    rig.sweep.set("192.0.2.20", [ 47614 ])
    rig.sweep.set("192.0.2.21", [ 47614 ])
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    #expect(await eventually { rig.coordinator.status.applied == 1 })
    try? await Task.sleep(for: .milliseconds(300))
    #expect(rig.coordinator.peers.count == 1)
    #expect(rig.coordinator.peers.first?.instanceId == instance("e001"))
    #expect(rig.coordinator.status.applied == 1)
    // Found again at both addresses, it still gets one link.
    let connects = rig.peers.connects.count
    rig.coordinator.subnetsChanged()
    try? await Task.sleep(for: .milliseconds(1_500))
    #expect(rig.peers.connects.count == connects)
  }

  @Test("No more than eight connects at once")
  func connectCap() async {
    let rig = Rig()
    rig.ready()
    rig.peers.connectDelay = .milliseconds(150)
    for host in 10 ..< 22 { rig.sweep.set("192.0.2.\(host)", [ 47614 ]) }
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    #expect(await eventually { Set(rig.peers.connects).count == 12 })
    #expect(rig.peers.peak <= 8)
    #expect(rig.peers.peak >= 2)
    #expect(await eventually { rig.coordinator.peers.allSatisfy { $0.state == .unreachable } })
  }

  @Test("Remembered devices are contacted first, without waiting for a sweep")
  func rememberedFirst() async {
    let rig = Rig()
    rig.ready()
    let applied = Applied()
    rig.peer(makeReceiver("e001", applied: applied), at: endpoint("192.0.2.40"), swept: false)
    rig.defaults.set(
      [ "192.0.2.40:47614", "printer", "192.0.2.41:http", "not-an-address:47614" ],
      forKey: EventControlCoordinator.rememberedPeersKey
    )
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    #expect(await eventually { applied.count == 1 })
    #expect(Set(rig.peers.connects) == [ endpoint("192.0.2.40") ])
  }

  @Test("While recording, a device that restarted is found again at its address, not by a sweep")
  func knownPeerWhileBusy() async {
    let rig = Rig()
    rig.knownPeerInterval = 0.2
    rig.ready()
    rig.peer(makeReceiver("e001"), at: endpoint("192.0.2.20"))
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    #expect(await eventually { rig.coordinator.status.applied == 1 })

    rig.coordinator.setBusy(true)
    rig.coordinator.setBusy(true)
    let sweepsBefore = rig.sweep.askedPorts.count
    // The device restarts on the same address: its connection drops, and for a moment nothing
    // answers there.
    rig.peers.put(nil, at: endpoint("192.0.2.20"))
    rig.peers.cut(endpoint("192.0.2.20"))
    #expect(await eventually { rig.coordinator.peers.first?.state == .unreachable })
    let applied = Applied()
    rig.peers.put(makeReceiver("e001", applied: applied), at: endpoint("192.0.2.20"))
    #expect(await eventually { applied.count == 1 })
    #expect(rig.sweep.askedPorts.count == sweepsBefore)
    rig.coordinator.setBusy(false)
  }

  @Test("Another account's device is asked again only when a sweep finds it again")
  func otherAccountWaitsForSweep() async {
    let rig = Rig()
    rig.knownPeerInterval = 0.1
    rig.ready()
    rig.peer(makeReceiver("e002", key: keyTwo), at: endpoint("192.0.2.20"))
    rig.coordinator.start(enabled: true)
    #expect(await eventually { rig.coordinator.status.otherAccount == 1 })
    rig.stopSweepers()
    let connects = rig.peers.connects.count
    try? await Task.sleep(for: .milliseconds(400))
    #expect(rig.peers.connects.count == connects)
    rig.coordinator.swept(SubnetScanner.Result(
      openHosts: [ "192.0.2.20" ],
      probedCount: 254,
      subnet: "192.0.2.0/24",
      diagnostic: nil,
      portsByHost: [ "192.0.2.20": [ 47614 ] ]
    ))
    #expect(await eventually { rig.peers.connects.count == connects + 1 })
  }

  // MARK: - Sweeps

  @Test("It rides camera discovery's sweep when there is one, and asks it for one when it starts")
  func sharedSweep() async {
    let rig = Rig()
    rig.ready()
    let discovery = SweepingDiscovery()
    rig.peers.put(makeReceiver("e001"), at: endpoint("192.0.2.20"))
    rig.coordinator.attach(to: discovery)
    rig.coordinator.start(enabled: true)
    #expect(rig.sweepers.isEmpty)
    #expect(discovery.participants.count == 1)
    #expect(discovery.requests >= 1)
    #expect(rig.coordinator.status.sweeper == .shared)
    #expect(rig.coordinator.status.line.hasSuffix("(found by the camera search)"))

    rig.coordinator.acceptSweep(SubnetScanner.Result(
      openHosts: [ "192.0.2.20", "192.0.2.30" ],
      probedCount: 254,
      subnet: "192.0.2.0/24",
      diagnostic: nil,
      // A camera port in a participant's answer is ignored.
      portsByHost: [ "192.0.2.20": [ 47614 ], "192.0.2.30": [ 554 ] ]
    ))
    #expect(await eventually { rig.coordinator.status.applied == 1 })
    #expect(Set(rig.peers.connects) == [ endpoint("192.0.2.20") ])

    let requests = discovery.requests
    rig.coordinator.resumed()
    rig.coordinator.subnetsChanged()
    #expect(discovery.requests == requests + 2)

    // A discovery rebuilt without a sweep: event control runs its own.
    rig.coordinator.attach(to: SweepingDiscovery(joins: false))
    #expect(rig.sweepers.count == 1)
    #expect(rig.coordinator.status.sweeper == .own)
    rig.coordinator.attach(to: discovery)
    #expect(rig.coordinator.status.sweeper == .shared)
    rig.stopSweepers()
  }

  @Test("Started before camera discovery is built, it sweeps nothing of its own and then joins that one's")
  func startedBeforeDiscoveryWaitsForIt() async {
    let rig = Rig()
    rig.discoveryKnown = false
    rig.ready()
    rig.peers.put(makeReceiver("e001"), at: endpoint("192.0.2.20"))
    rig.coordinator.start(enabled: true)
    #expect(rig.sweepers.isEmpty)
    #expect(rig.coordinator.status.sweeper == .none)
    let discovery = SweepingDiscovery()
    rig.coordinator.attach(to: discovery)
    // One sweep at launch, the camera discovery's: none of its own was ever started.
    #expect(rig.sweepers.isEmpty)
    #expect(discovery.participants.count == 1)
    #expect(discovery.requests >= 1)
    #expect(rig.coordinator.status.sweeper == .shared)

    // A profile that does not sweep: only now does it run its own.
    let other = Rig()
    other.discoveryKnown = false
    other.ready()
    other.coordinator.start(enabled: true)
    #expect(other.sweepers.isEmpty)
    other.coordinator.attach(to: nil)
    #expect(other.sweepers.count == 1)
    #expect(other.coordinator.status.sweeper == .own)
    other.stopSweepers()
  }

  @Test("While recording, nothing asks for a sweep; one wanted meanwhile is asked for when the take ends")
  func noSweepRequestedWhileBusy() async {
    let rig = Rig()
    rig.ready()
    let discovery = SweepingDiscovery()
    rig.coordinator.attach(to: discovery)
    rig.coordinator.start(enabled: true)
    let requests = discovery.requests
    rig.coordinator.setBusy(true)
    rig.coordinator.resumed()
    rig.coordinator.subnetsChanged()
    rig.coordinator.pathChanged("satisfied en0")
    rig.coordinator.pathChanged("satisfied en0,en1")
    rig.coordinator.accountChanged()
    #expect(discovery.requests == requests)
    rig.coordinator.setBusy(false)
    #expect(discovery.requests == requests + 1)
    rig.coordinator.setBusy(true)
    rig.coordinator.setBusy(false)
    #expect(discovery.requests == requests + 1)

    // Turned on mid-take: it engages, contacts known peers, and leaves the sweep for afterwards.
    rig.coordinator.setEnabled(false)
    rig.coordinator.setBusy(true)
    rig.coordinator.setEnabled(true)
    #expect(discovery.requests == requests + 1)
    #expect(rig.coordinator.status.phase == .running)
    rig.coordinator.setBusy(false)
    #expect(discovery.requests == requests + 2)

    // Turned off before the take ends: nothing is asked for.
    rig.coordinator.setBusy(true)
    rig.coordinator.resumed()
    rig.coordinator.setEnabled(false)
    rig.coordinator.setBusy(false)
    #expect(discovery.requests == requests + 2)
  }

  @Test("A changed network path looks again; the first path and an unchanged one do not")
  func networkPath() async {
    let rig = Rig()
    rig.ready()
    let discovery = SweepingDiscovery()
    rig.coordinator.attach(to: discovery)
    rig.coordinator.start(enabled: true)
    let requests = discovery.requests
    rig.coordinator.pathChanged("satisfied en0")
    rig.coordinator.pathChanged("satisfied en0")
    #expect(discovery.requests == requests)
    rig.coordinator.pathChanged("satisfied en0,en1")
    #expect(discovery.requests == requests + 1)
    rig.coordinator.monitorNetwork()
    rig.coordinator.monitorNetwork()
  }

  @Test("Nudges while off do nothing but bring it up to date")
  func nudgesWhileOff() async {
    let rig = Rig()
    rig.ready()
    let discovery = SweepingDiscovery()
    rig.coordinator.attach(to: discovery)
    rig.coordinator.start(enabled: false)
    rig.coordinator.resumed()
    rig.coordinator.subnetsChanged()
    #expect(discovery.requests == 0)
    rig.coordinator.setEnabled(true)
    #expect(discovery.requests == 1)
    #expect(rig.coordinator.status.phase == .running)
  }

  @Test("Denied Local Network access and no interface are said, not shown as no devices")
  func sweepProblems() async {
    let rig = Rig()
    rig.ready()
    let discovery = SweepingDiscovery()
    rig.coordinator.attach(to: discovery)
    rig.coordinator.start(enabled: true)
    rig.coordinator.swept(SubnetScanner.Result(
      openHosts: [], probedCount: 254, subnet: "192.0.2.0/24", diagnostic: nil,
      localNetworkDenied: true
    ))
    #expect(rig.coordinator.status.localNetworkDenied)
    #expect(rig.coordinator.status.isProblem)
    #expect(rig.coordinator.status.line.hasPrefix("Local Network access is off for TS Director."))
    #expect(rig.coordinator.telemetry.localNetworkDenied)

    rig.coordinator.swept(SubnetScanner.Result(
      openHosts: [], probedCount: 0, subnet: "", diagnostic: "no IPv4 interface"
    ))
    #expect(rig.coordinator.status.noInterface)
    #expect(rig.coordinator.status.line == "No network. Join the Wi-Fi the devices are on.")
    #expect(rig.coordinator.telemetry.noInterface)

    rig.coordinator.swept(SubnetScanner.Result(
      openHosts: [], probedCount: 254, subnet: "192.0.2.0/24", diagnostic: nil
    ))
    #expect(!rig.coordinator.status.isProblem)
    #expect(rig.coordinator.status.line == "0 devices on this event (found by the camera search)")

    // Off, a sweep answer changes only what it says about the network.
    rig.coordinator.setEnabled(false)
    rig.coordinator.swept(SubnetScanner.Result(
      openHosts: [ "192.0.2.20" ], probedCount: 254, subnet: "192.0.2.0/24", diagnostic: nil,
      portsByHost: [ "192.0.2.20": [ 47614 ] ]
    ))
    #expect(rig.peers.connects.isEmpty)
  }

  // MARK: - Words

  // MARK: - Stale remembered addresses

  @Test("A remembered address silent for an hour is forgotten after three failed contacts")
  func staleRememberedAddressIsForgotten() async throws {
    let rig = Rig()
    rig.knownPeerInterval = 0.1
    rig.ready()
    rig.defaults.set([ "192.0.2.50:47614" ], forKey: EventControlCoordinator.rememberedPeersKey)
    rig.defaults.set([ "192.0.2.50:47614": 1_000.0 - 3_600 ], forKey: EventControlCoordinator.rememberedPeerAnsweredKey)
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    #expect(await eventually {
      (rig.defaults.stringArray(forKey: EventControlCoordinator.rememberedPeersKey) ?? []).isEmpty
    })
    #expect(rig.coordinator.telemetry.forgotten == 1)
    #expect(rig.coordinator.peers.isEmpty)
    #expect(rig.defaults.dictionary(forKey: EventControlCoordinator.rememberedPeerAnsweredKey)?.isEmpty == true)
    #expect(rig.defaults.dictionary(forKey: EventControlCoordinator.rememberedPeerFailuresKey)?.isEmpty == true)
    // Three contacts, each a connect and its two retries; then it is left alone.
    let attempts = rig.peers.connects.filter { $0 == endpoint("192.0.2.50") }.count
    #expect(attempts == 9)
    try await Task.sleep(for: .milliseconds(400))
    #expect(rig.peers.connects.filter { $0 == endpoint("192.0.2.50") }.count == attempts)
  }

  @Test("An address that answered in the last ten minutes is kept however often it fails, then forgotten")
  func recentlyAnsweredAddressIsKept() async {
    let rig = Rig()
    rig.knownPeerInterval = 0.1
    rig.ready()
    rig.defaults.set([ "192.0.2.51:47614" ], forKey: EventControlCoordinator.rememberedPeersKey)
    rig.defaults.set([ "192.0.2.51:47614": 1_000.0 - 60 ], forKey: EventControlCoordinator.rememberedPeerAnsweredKey)
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    #expect(await eventually {
      (rig.defaults.dictionary(forKey: EventControlCoordinator.rememberedPeerFailuresKey)?["192.0.2.51:47614"] as? Int ?? 0) >= 4
    })
    #expect(rig.defaults.stringArray(forKey: EventControlCoordinator.rememberedPeersKey) == [ "192.0.2.51:47614" ])
    rig.clock.advance(EventControlCoordinator.forgetAfterSilence)
    #expect(await eventually {
      (rig.defaults.stringArray(forKey: EventControlCoordinator.rememberedPeersKey) ?? []).isEmpty
    })
  }

  @Test("Nothing is forgotten while recording or streaming, when no sweep could find it again")
  func notForgottenWhileBusy() async {
    let rig = Rig()
    rig.knownPeerInterval = 0.1
    rig.ready()
    rig.defaults.set([ "192.0.2.52:47614" ], forKey: EventControlCoordinator.rememberedPeersKey)
    rig.coordinator.setBusy(true)
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    #expect(await eventually {
      (rig.defaults.dictionary(forKey: EventControlCoordinator.rememberedPeerFailuresKey)?["192.0.2.52:47614"] as? Int ?? 0) >= 4
    })
    #expect(rig.defaults.stringArray(forKey: EventControlCoordinator.rememberedPeersKey) == [ "192.0.2.52:47614" ])
    rig.coordinator.setBusy(false)
    #expect(await eventually {
      (rig.defaults.stringArray(forKey: EventControlCoordinator.rememberedPeersKey) ?? []).isEmpty
    })
  }

  @Test("An answer clears the run of failures; a forgotten device found by a sweep is remembered again")
  func answerResetsAndSweepRemembersAgain() async {
    let rig = Rig()
    rig.knownPeerInterval = 0.1
    rig.ready()
    rig.peer(makeReceiver("e001"), at: endpoint("192.0.2.53"), swept: false)
    rig.defaults.set([ "192.0.2.53:47614" ], forKey: EventControlCoordinator.rememberedPeersKey)
    rig.defaults.set([ "192.0.2.53:47614": 2 ], forKey: EventControlCoordinator.rememberedPeerFailuresKey)
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    #expect(await eventually { rig.coordinator.status.applied == 1 })
    #expect(rig.defaults.dictionary(forKey: EventControlCoordinator.rememberedPeerFailuresKey)?["192.0.2.53:47614"] == nil)
    #expect(rig.defaults.dictionary(forKey: EventControlCoordinator.rememberedPeerAnsweredKey)?["192.0.2.53:47614"] as? Double == 1_000)

    // The device goes away for good; eleven minutes on, three failed contacts forget it.
    rig.clock.advance(660)
    rig.peers.put(nil, at: endpoint("192.0.2.53"))
    rig.peers.cut(endpoint("192.0.2.53"))
    #expect(await eventually { rig.coordinator.telemetry.forgotten == 1 })
    #expect(rig.coordinator.peers.isEmpty)

    // It comes back and a sweep finds it there: remembered again.
    rig.peer(makeReceiver("e001"), at: endpoint("192.0.2.53"))
    rig.coordinator.subnetsChanged()
    #expect(await eventually { rig.coordinator.status.applied == 1 })
    #expect(rig.defaults.stringArray(forKey: EventControlCoordinator.rememberedPeersKey) == [ "192.0.2.53:47614" ])
  }

  @Test("The line counts only devices that answered this session: re-contacting a dead address is not \"connecting\"")
  func statusCountsOnlyAnsweredPeers() async throws {
    let rig = Rig()
    rig.knownPeerInterval = 0.05
    rig.peers.connectDelay = .milliseconds(80)
    rig.ready()
    rig.peer(makeReceiver("e001"), at: endpoint("192.0.2.20"))
    rig.defaults.set(
      [ "192.0.2.60:47614", "192.0.2.61:47614", "192.0.2.62:47614" ],
      forKey: EventControlCoordinator.rememberedPeersKey
    )
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    var lines: Set<String> = []
    let deadline = Date().addingTimeInterval(1)
    while Date() < deadline {
      lines.insert(rig.coordinator.status.line)
      #expect(rig.coordinator.status.connecting == 0)
      try await Task.sleep(for: .milliseconds(10))
    }
    #expect(rig.coordinator.status.applied == 1)
    #expect(!lines.contains { $0.contains("connecting") })
    // The dead addresses are still being tried; only the line leaves them out.
    #expect(rig.peers.connects.contains(endpoint("192.0.2.60")))
  }

  @Test("A device that answered this session and is being reconnected does show as connecting")
  func answeredPeerReconnectingIsCounted() async {
    let rig = Rig()
    rig.ready()
    rig.peer(makeReceiver("e001"), at: endpoint("192.0.2.20"))
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    #expect(await eventually { rig.coordinator.status.applied == 1 })
    rig.peers.connectDelay = .milliseconds(300)
    rig.peers.put(nil, at: endpoint("192.0.2.20"))
    rig.peers.cut(endpoint("192.0.2.20"))
    #expect(await eventually { rig.coordinator.status.connecting == 1 })
  }

  @Test("A device that answered and then went away is tried again quietly: never \"connecting\"")
  func goneDeviceReprobedQuietly() async throws {
    let rig = Rig()
    rig.knownPeerInterval = 0.1
    rig.ready()
    rig.peer(makeReceiver("e001"), at: endpoint("192.0.2.20"))
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    #expect(await eventually { rig.coordinator.status.applied == 1 })
    rig.peers.put(nil, at: endpoint("192.0.2.20"))
    rig.peers.cut(endpoint("192.0.2.20"))
    #expect(await eventually { rig.coordinator.peers.first?.state == .unreachable })
    // From here every contact is a background re-probe of a device that is gone.
    rig.peers.connectDelay = .milliseconds(150)
    let before = rig.peers.connects.count
    let deadline = Date().addingTimeInterval(0.8)
    while Date() < deadline {
      #expect(rig.coordinator.status.connecting == 0)
      try await Task.sleep(for: .milliseconds(10))
    }
    #expect(rig.peers.connects.count > before)
  }

  @Test("The status line for every state")
  func statusLines() {
    var status = EventControlStatus()
    #expect(status.line.isEmpty)
    #expect(status.phaseName == "off")
    status.phase = .signedOut
    #expect(status.phaseName == "signedOut")
    status.phase = .gettingKey
    #expect(status.phaseName == "gettingKey")
    status.phase = .keyUnavailable("Down for maintenance")
    #expect(status.line == "No device key from TeamStation: Down for maintenance")
    #expect(status.phaseName == "keyUnavailable")
    status.phase = .noEvent
    #expect(status.phaseName == "noEvent")
    #expect(!status.isProblem)
    status.phase = .running
    status.sweeper = .none
    status.applied = 2
    status.busy = 1
    status.disabled = 1
    status.otherAccount = 1
    status.keyMismatch = 1
    status.connecting = 3
    #expect(status.line == "2 devices on this event · 1 held by another Director · "
      + "1 not allowing override · 1 on another account · 1 need a new key · 3 connecting "
      + "(known devices only)")
    #expect(status.phaseName == "running")
  }

  @Test("Every peer state has a name for /dump-state")
  func stateNames() {
    let names = [
      EventControlCoordinator.describe(.connecting),
      EventControlCoordinator.describe(.discovering),
      EventControlCoordinator.describe(.connected),
      EventControlCoordinator.describe(.assigning(7)),
      EventControlCoordinator.describe(.applied(7)),
      EventControlCoordinator.describe(.disabled),
      EventControlCoordinator.describe(.busy),
      EventControlCoordinator.describe(.otherAccount),
      EventControlCoordinator.describe(.keyMismatch),
      EventControlCoordinator.describe(.unsupported),
      EventControlCoordinator.describe(.invalid),
      EventControlCoordinator.describe(.failed),
      EventControlCoordinator.describe(.released),
      EventControlCoordinator.describe(.unreachable)
    ]
    #expect(names == [
      "connecting", "discovering", "connected", "assigning(7)", "applied(7)", "disabled", "busy",
      "otherAccount", "keyMismatch", "unsupported", "invalid", "failed", "released", "unreachable"
    ])
    #expect(EventControlCoordinator.isLive(.busy))
    #expect(!EventControlCoordinator.isLive(.released))
    #expect(EventControlCoordinator.isSameAccount(.disabled))
    #expect(!EventControlCoordinator.isSameAccount(.otherAccount))
  }

  @Test("Remembered addresses read back only as address and port")
  func endpointParsing() {
    #expect(EventControlCoordinator.endpoint(from: "192.0.2.20:47615") == endpoint("192.0.2.20", 47615))
    #expect(EventControlCoordinator.endpoint(from: "192.0.2.20") == nil)
    #expect(EventControlCoordinator.endpoint(from: "192.0.2.20:99999") == nil)
    #expect(EventControlCoordinator.endpoint(from: "host.example.test:47614") == nil)
  }

  @Test("The busy and disabled states reach the status line")
  func busyAndDisabledPeers() async {
    let rig = Rig()
    rig.ready()
    rig.peers.put(makeReceiver("e001", consent: false), at: endpoint("192.0.2.20"))
    rig.sweep.set("192.0.2.20", [ 47614 ])
    // Another Director already holds this one.
    let held = makeReceiver("e002")
    rig.peers.put(held, at: endpoint("192.0.2.21"))
    let other = EventControlDirectorLink(
      endpoint: endpoint("192.0.2.21"),
      instanceId: instance("d002"),
      credentials: credentials(keyOne),
      desired: EventControlDesired(
        revision: 5,
        assignment: try! EventAssignment(gameId: "gam_other", title: "Comets at Visitors", startAt: Date())
      ),
      connector: rig.peers.connector,
      timing: fastLinks
    )
    await other.start()
    #expect(await eventually { await held.overrideState != .none })
    rig.sweep.set("192.0.2.21", [ 47614 ])
    rig.coordinator.start(enabled: true)
    defer { rig.stopSweepers() }
    #expect(await eventually {
      rig.coordinator.status.disabled == 1 && rig.coordinator.status.busy == 1
    })
    #expect(rig.coordinator.status.line.contains("1 held by another Director"))
    #expect(rig.coordinator.status.line.contains("1 not allowing override"))
    await other.stop()
  }
}
