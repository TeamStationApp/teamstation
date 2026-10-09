import DirectorPipeline
import DirectorSources
import EventControl
import Foundation
import Network
import Observation
import os
import TeamStationKit

/// What device event control needs of the TeamStation account: whether this Director may take
/// part, as whom, the event it has selected, and its own key.
@MainActor
public protocol EventControlAccount: AnyObject {
  /// A token is kept and the identity proved for it is for the server in use, whether or not the
  /// server can be reached now.
  var isEventControlEligible: Bool { get }
  var scope: TeamStationAccountScope? { get }
  var serverURL: URL { get }
  /// The event this Director covers. Only ever a choice that succeeded.
  var chosen: TeamStationAccount.ChosenEvent? { get }
  /// This device's key, fetched with its own session. Signs the account out when the server
  /// rejects the token.
  func deviceEventControlKey() async throws -> TeamStationEventControlKey
}

extension TeamStationAccount: EventControlAccount {}

/// Which sweep finds nearby devices.
public enum EventControlSweeper: String, Sendable, Equatable {
  /// The camera discovery's own sweep, with the event-control ports added to it.
  case shared
  /// A sweep of its own asking only about the event-control ports, for a camera profile that
  /// does not sweep (simulated or file cameras).
  case own
  /// Not looking.
  case none
}

/// What device event control is doing, for the line under its toggle in Settings.
public struct EventControlStatus: Sendable, Equatable {
  public enum Phase: Sendable, Equatable {
    /// The toggle is off.
    case off
    /// Not signed in, or signed in on another server than the one in use.
    case signedOut
    /// Asking TeamStation for this device's key.
    case gettingKey
    /// TeamStation could not give a key, and none is cached; in its words.
    case keyUnavailable(String)
    /// Nothing selected to send.
    case noEvent
    /// Finding devices and keeping them on the event.
    case running
  }

  public var phase: Phase = .off
  public var applied = 0
  public var busy = 0
  public var disabled = 0
  public var otherAccount = 0
  public var keyMismatch = 0
  public var connecting = 0
  public var localNetworkDenied = false
  public var noInterface = false
  public var sweeper: EventControlSweeper = .none

  public init() {}

  /// Something the operator has to fix before anything can happen.
  public var isProblem: Bool {
    switch phase {
    case .keyUnavailable: true
    case .running: localNetworkDenied || noInterface
    default: false
    }
  }

  /// One line, empty while the toggle is off.
  public var line: String {
    switch phase {
    case .off:
      return ""
    case .signedOut:
      return "Log in to TeamStation to set the event on nearby devices."
    case .gettingKey:
      return "Getting this iPad's device key from TeamStation…"
    case let .keyUnavailable(reason):
      return "No device key from TeamStation: \(reason)"
    case .noEvent:
      return "Pick an event to send it to nearby devices."
    case .running:
      if localNetworkDenied {
        return "Local Network access is off for TS Director. Turn it on in Settings › Privacy & "
          + "Security › Local Network."
      }
      if noInterface { return "No network. Join the Wi-Fi the devices are on." }
      var parts = [ applied == 1 ? "1 device on this event" : "\(applied) devices on this event" ]
      if busy > 0 { parts.append("\(busy) held by another Director") }
      if disabled > 0 { parts.append("\(disabled) not allowing override") }
      if otherAccount > 0 { parts.append("\(otherAccount) on another account") }
      if keyMismatch > 0 { parts.append("\(keyMismatch) need a new key") }
      if connecting > 0 { parts.append("\(connecting) connecting") }
      let via = switch sweeper {
      case .shared: "found by the camera search"
      case .own: "found by its own search"
      case .none: "known devices only"
      }
      return parts.joined(separator: " · ") + " (\(via))"
    }
  }

  /// The phase as `/dump-state` names it.
  public var phaseName: String {
    switch phase {
    case .off: "off"
    case .signedOut: "signedOut"
    case .gettingKey: "gettingKey"
    case .keyUnavailable: "keyUnavailable"
    case .noEvent: "noEvent"
    case .running: "running"
    }
  }
}

/**
 * "Set event on nearby devices": keeps every nearby device signed in to the same TeamStation
 * account, that allows it, publishing to the event this Director has selected.
 *
 * Devices are found by the address sweep camera discovery already runs, which asks each host
 * about TCP 47614 and 47615 as well while this is on (`SweepParticipant`); when the camera profile
 * does not sweep, this runs a sweep of its own on the same policy that asks only those ports.
 * Each device found gets one `EventControlDirectorLink`, which proves the account, assigns the
 * event and renews the lease; peers are told apart by instance ID, never by address, and nothing
 * about what app a peer is is known or asked.
 *
 * Devices already seen are remembered by address (`eventControl.rememberedPeers`) and contacted
 * first, and every 30 seconds afterwards, so a device that restarted on its usual address is
 * reassigned within seconds and devices are still reached while recording or streaming, when the
 * sweep leaves these ports out. At most eight connects are in progress at once; each has two
 * seconds, and a peer that fails three times waits for the next sweep or known-peer contact. An
 * address that has failed three contacts in a row and not answered for ten minutes is forgotten
 * (never while recording or streaming, when no sweep could find it again); a sweep that finds the
 * device there again remembers it again. The status line counts a device only once it has
 * answered in this session, so contacting a remembered address in the background never shows as
 * "connecting".
 *
 * A peer whose key ID is not this Director's makes it fetch its own key again, at most once a
 * minute. A new key means this one was stale, and every link starts over with it. The same key
 * means the peer's came from another server (or is stale itself, which the peer fixes on its own):
 * it is then left alone like a peer on another account, contacted again only when a sweep finds
 * it, so a peer signed in to another server is never a reason to keep asking TeamStation.
 *
 * A successful event pick sends the new event at a new revision; a failed pick sends nothing. The
 * toggle going off, sign-out, an account switch and clearing the event each release every held
 * lease, best effort, and stop renewing; the devices keep their last event. Director's own
 * recording, stream and overlays never read anything here.
 */
@MainActor
@Observable
public final class EventControlCoordinator: SweepParticipant {
  public struct Timing: Sendable {
    /// How often known peers whose link has ended are contacted again.
    public var knownPeerInterval: TimeInterval
    /// Connects in progress at once.
    public var maxConcurrentConnects: Int
    /// Each link's own timeouts and retry limits: a 2-second connect, three failures.
    public var link: EventControlDirectorTiming
    /// How long after a key fetch that failed for a passing reason (offline, a timeout, a 5xx
    /// while the server restarts) it is asked again, while on and eligible.
    public var keyRetryInterval: TimeInterval

    public init(
      knownPeerInterval: TimeInterval = 30,
      maxConcurrentConnects: Int = 8,
      link: EventControlDirectorTiming = .standard,
      keyRetryInterval: TimeInterval = 60
    ) {
      self.knownPeerInterval = knownPeerInterval
      self.maxConcurrentConnects = maxConcurrentConnects
      self.link = link
      self.keyRetryInterval = keyRetryInterval
    }

    public static let standard = Timing()
  }

  /// `UserDefaults` key for the addresses peers answered on, newest first.
  public static let rememberedPeersKey = "eventControl.rememberedPeers"
  /// `UserDefaults` key for this installation's random instance ID.
  public static let instanceIdKey = "eventControl.instanceId"
  /// Keychain service the key is cached under.
  public static let keyStoreService = "app.teamstation.director.eventcontrol"
  /// `UserDefaults` key for when each remembered address last answered (seconds since 1970).
  public static let rememberedPeerAnsweredKey = "eventControl.rememberedPeerAnsweredAt"
  /// `UserDefaults` key for how many contacts in a row each remembered address has failed.
  public static let rememberedPeerFailuresKey = "eventControl.rememberedPeerFailures"
  /// How many peer addresses are remembered.
  static let rememberedPeerLimit = 16
  /// How long a key TeamStation has just confirmed counts as current, and the least time between
  /// two fetches a peer's other key asks for: the receivers' forced-refetch limit.
  static let keyRecheckInterval: TimeInterval = 60
  /// Contacts in a row a remembered address must fail before it can be forgotten.
  static let forgetAfterFailures = 3
  /// How long a remembered address must have gone without answering before it can be forgotten.
  static let forgetAfterSilence: TimeInterval = 600
  /// The ports receivers listen on, as the sweep asks for them.
  nonisolated static let eventPorts = EventControlProtocol.ports.map(Int.init)

  public private(set) var isEnabled = false
  public private(set) var status = EventControlStatus()

  @ObservationIgnored private let account: any EventControlAccount
  @ObservationIgnored private let instanceId: EventControlInstanceID
  @ObservationIgnored private let keyStore: EventControlKeyStore
  @ObservationIgnored private let connector: any EventControlConnector
  @ObservationIgnored private let defaults: UserDefaults
  @ObservationIgnored private let timing: Timing
  @ObservationIgnored private let now: @Sendable () -> Date
  @ObservationIgnored private let makeOwnSweeper: @MainActor () -> CameraSweeper

  @ObservationIgnored private var isBusy = false
  /// A sweep asked for while recording or streaming, held until the take ends: that sweep could
  /// carry no event ports and would only cost the cameras an ARP sweep mid-take.
  @ObservationIgnored private var sweepHeldWhileBusy = false
  @ObservationIgnored private var revisions = EventControlRevisionCounter()
  /// What every peer should be on, at its revision. Nil with no event selected.
  @ObservationIgnored public private(set) var desired: EventControlDesired?
  @ObservationIgnored private var credentials: EventControlCredentials?
  /// The server origin `credentials` were cached under.
  @ObservationIgnored private var credentialsServer: String?
  @ObservationIgnored private var keyFetch: Task<Void, Never>?
  /// Which fetch `keyFetch` is, so the answer to one given up on is ignored.
  @ObservationIgnored private var keyFetchNumber = 0
  /// The account `keyFetch` asks for.
  @ObservationIgnored private var keyFetchScope: TeamStationAccountScope?
  @ObservationIgnored private var keyProblem: String?
  /// The wait before a key fetch that failed for a passing reason is asked again.
  @ObservationIgnored private var keyRetry: Task<Void, Never>?
  /// The account TeamStation answered for with a final failure (the feature not offered, or a key
  /// this app cannot read): not asked again until the account changes or the toggle goes off.
  @ObservationIgnored private var keyFinalFor: TeamStationAccountScope?
  /// When TeamStation last answered with the key in `credentials`.
  @ObservationIgnored private var keyConfirmedAt: Date?
  /// When a peer's other key last had this Director fetch its own again.
  @ObservationIgnored private var lastMismatchFetch: Date?
  @ObservationIgnored private var engaged = false
  @ObservationIgnored private var registry = EventControlPeerRegistry()
  @ObservationIgnored private var links: [EventControlEndpoint: LinkEntry] = [:]
  /// Found, waiting for a connect slot.
  @ObservationIgnored private var waiting: [EventControlEndpoint] = []
  /// Bumped whenever every link is let go, so a late report from one of them is ignored.
  @ObservationIgnored private var generation = 0
  /// Link stops still running, each by its own number; each removes itself when it finishes.
  @ObservationIgnored private var background: [Int: Task<Void, Never>] = [:]
  @ObservationIgnored private var backgroundSerial = 0
  @ObservationIgnored private var pushes: Task<Void, Never>?
  @ObservationIgnored private weak var sharedDiscovery: (any SourceDiscovery)?
  /// Whether the app has said which camera discovery there is. Until it has, no sweep of this
  /// coordinator's own is started: at launch the camera discovery is built after event control
  /// starts, and a sweep begun before it would run beside the camera sweep it is about to join.
  @ObservationIgnored private var discoveryKnown = false
  @ObservationIgnored private var ownSweeper: CameraSweeper?
  @ObservationIgnored private var knownPeerTimer: Task<Void, Never>?
  @ObservationIgnored private var sweepsSeen = 0
  @ObservationIgnored private var localNetworkDenied = false
  @ObservationIgnored private var noInterface = false
  @ObservationIgnored private var pathSignature: String?
  @ObservationIgnored private var pathMonitor: NWPathMonitor?
  /// Remembered addresses forgotten for staying unreachable, for `/dump-state`.
  @ObservationIgnored private(set) var forgottenCount = 0

  /// The ports the sweep reads at the start of each pass; set on the main actor, read from the
  /// sweeper's.
  private nonisolated let sweepPorts = OSAllocatedUnfairLock<[Int]>(initialState: [])

  private struct LinkEntry {
    let link: EventControlDirectorLink
    let generation: Int
    var state: EventControlPeerState = .connecting
    var running = true
    var lastSequence: UInt64 = 0
    var instanceId: EventControlInstanceID?
    /// Stopped because another link reaches the same peer; nothing it says counts any more.
    var isDuplicate = false
    /// Started to try an address whose device had not answered or had stopped answering (a
    /// remembered address, or a known peer gone unreachable). Not shown as "connecting" unless it
    /// answers.
    var isBackgroundProbe = false
  }

  public init(
    account: any EventControlAccount,
    instanceId: EventControlInstanceID,
    keyStore: EventControlKeyStore,
    connector: any EventControlConnector = EventControlNWConnector(),
    defaults: UserDefaults = .standard,
    timing: Timing = .standard,
    now: @escaping @Sendable () -> Date = { Date() },
    makeOwnSweeper: @escaping @MainActor () -> CameraSweeper = {
      CameraSweeper(ports: []) { _ in }
    }
  ) {
    self.account = account
    self.instanceId = instanceId
    self.keyStore = keyStore
    self.connector = connector
    self.defaults = defaults
    self.timing = timing
    self.now = now
    self.makeOwnSweeper = makeOwnSweeper
  }

  // MARK: - What the app tells it

  /// At launch: the persisted toggle and the event the account already has.
  public func start(enabled: Bool) {
    isEnabled = enabled
    desired = makeDesired(account.chosen, keeping: desired)
    reconcile(kick: true)
  }

  /// The toggle. On looks for devices at once; off releases every device and stops.
  public func setEnabled(_ on: Bool) {
    guard on != isEnabled else { return }
    isEnabled = on
    reconcile(kick: on)
  }

  /// The selected event changed: a pick that succeeded, or Clear. A new event goes to every peer
  /// at a new revision; the same event again changes nothing; none releases them.
  public func selectionChanged() {
    let next = makeDesired(account.chosen, keeping: desired)
    guard next != desired else { return }
    desired = next
    pushDesired()
    reconcile(kick: false)
    if engaged { contactKnown() }
  }

  /// Signed in, signed out, signed in as someone else, or the server rejected the token. A key
  /// fetch still on its way for another account is given up, and one is made for this one.
  public func accountChanged() {
    if keyFetch != nil, account.scope != keyFetchScope { cancelKeyFetch() }
    // A wait for the account before is over; `reconcile` asks at once for this one if it must.
    cancelKeyRetry()
    let wasEligible = credentials != nil || engaged
    let next = makeDesired(account.chosen, keeping: desired)
    if next != desired {
      desired = next
      pushDesired()
    }
    reconcile(kick: !wasEligible && account.isEventControlEligible)
  }

  /// Recording or streaming. The sweep then leaves the event ports out, no sweep is asked for, and
  /// known peers are still contacted at their addresses. A sweep wanted meanwhile is asked for
  /// when the take ends.
  public func setBusy(_ busy: Bool) {
    guard busy != isBusy else { return }
    isBusy = busy
    ownSweeper?.setDemand(isBusy: busy, anyEnabledCameraMissing: false)
    if !busy, sweepHeldWhileBusy {
      sweepHeldWhileBusy = false
      if engaged { requestSweep() }
    }
  }

  /// Camera discovery was (re)built. Joins its sweep, or runs its own when it does not sweep.
  public func attach(to discovery: (any SourceDiscovery)?) {
    let joined = discovery?.addSweepParticipant(self) ?? false
    discoveryKnown = true
    sharedDiscovery = joined ? discovery : nil
    if joined {
      ownSweeper?.stop()
      ownSweeper = nil
    }
    reconcile(kick: true)
  }

  /// Back in the foreground.
  public func resumed() { kick() }

  /// The additional subnets changed.
  public func subnetsChanged() { kick() }

  /// The network path changed: another Wi-Fi, an interface up or down.
  public func networkChanged() {
    reconcile(kick: true)
  }

  /// Follows the network path, calling `networkChanged` when it actually changes.
  public func monitorNetwork() {
    guard pathMonitor == nil else { return }
    let monitor = NWPathMonitor()
    monitor.pathUpdateHandler = { [weak self] path in
      let signature = "\(path.status) " + path.availableInterfaces.map(\.name).joined(separator: ",")
      Task { @MainActor in self?.pathChanged(signature) }
    }
    monitor.start(queue: DispatchQueue(label: "app.teamstation.director.eventcontrol.path"))
    pathMonitor = monitor
  }

  /// The first path is the one there is; only a different one after it is a change.
  func pathChanged(_ signature: String) {
    defer { pathSignature = signature }
    guard let previous = pathSignature, previous != signature else { return }
    networkChanged()
  }

  // MARK: - SweepParticipant

  public nonisolated var extraSweepPorts: [Int] { sweepPorts.withLock { $0 } }

  public nonisolated func acceptSweep(_ result: SubnetScanner.Result) {
    Task { @MainActor [weak self] in self?.swept(result) }
  }

  func swept(_ result: SubnetScanner.Result) {
    sweepsSeen += 1
    localNetworkDenied = result.localNetworkDenied
    noInterface = result.diagnostic == "no IPv4 interface"
    defer { refreshStatus() }
    guard engaged else { return }
    var found: [EventControlEndpoint] = []
    for host in result.openHosts {
      for port in (result.portsByHost[host] ?? []).sorted() where Self.eventPorts.contains(port) {
        found.append(EventControlEndpoint(host: host, port: UInt16(port)))
      }
    }
    contact(found, fromSweep: true)
  }

  // MARK: - The state it is in

  private var server: String? {
    EventControlCredentials.canonicalOrigin(of: account.serverURL)
  }

  /// Brings everything in line with the toggle, the account, the key and the event. `kick`
  /// contacts known peers and asks for a sweep when it ends up running.
  private func reconcile(kick shouldKick: Bool) {
    defer { refreshStatus() }
    guard isEnabled, account.isEventControlEligible, let server else {
      disengage()
      cancelKeyFetch()
      cancelKeyRetry()
      keyProblem = nil
      keyFinalFor = nil
      if !account.isEventControlEligible { forgetKey() }
      return
    }
    if let held = credentials,
       credentialsServer != server || held.scope.userId != account.scope?.userId {
      // Another account, or another server: its leases go, and its key with them.
      disengage()
      forgetKey()
    }
    if credentials == nil, let cached = keyStore.credentials(for: server) {
      if cached.scope.userId == account.scope?.userId {
        credentials = cached
        credentialsServer = server
      } else {
        keyStore.remove(for: server)
      }
    }
    guard credentials != nil else {
      if let keyFinalFor, keyFinalFor == account.scope {
        // TeamStation's answer for this account stands; its problem stays on show.
      } else {
        keyFinalFor = nil
        fetchKey()
      }
      disengage()
      return
    }
    guard desired != nil else {
      disengage()
      return
    }
    engage(kick: shouldKick)
  }

  private func engage(kick shouldKick: Bool) {
    let starting = !engaged
    engaged = true
    sweepPorts.withLock { $0 = Self.eventPorts }
    if discoveryKnown, sharedDiscovery == nil, ownSweeper == nil {
      let sweeper = makeOwnSweeper()
      sweeper.addParticipant(self)
      sweeper.setDemand(isBusy: isBusy, anyEnabledCameraMissing: false)
      sweeper.start()
      ownSweeper = sweeper
    }
    if knownPeerTimer == nil {
      let interval = timing.knownPeerInterval
      knownPeerTimer = Task { [weak self] in
        while !Task.isCancelled {
          try? await Task.sleep(for: .seconds(interval))
          guard !Task.isCancelled else { return }
          self?.contactKnown()
        }
      }
    }
    if starting || shouldKick {
      contactKnown()
      requestSweep()
    }
  }

  /// Lets every peer go, releasing held leases, and stops looking.
  private func disengage() {
    sweepPorts.withLock { $0 = [] }
    ownSweeper?.stop()
    ownSweeper = nil
    knownPeerTimer?.cancel()
    knownPeerTimer = nil
    engaged = false
    letGoOfLinks()
  }

  private func kick() {
    guard engaged else {
      reconcile(kick: true)
      return
    }
    contactKnown()
    requestSweep()
  }

  private func requestSweep() {
    guard !isBusy else {
      sweepHeldWhileBusy = true
      return
    }
    if let sharedDiscovery {
      sharedDiscovery.requestSweep()
    } else {
      ownSweeper?.sweepSoon()
    }
  }

  private func makeDesired(
    _ chosen: TeamStationAccount.ChosenEvent?,
    keeping current: EventControlDesired?
  ) -> EventControlDesired? {
    guard let assignment = EventAssignment.from(
      gameId: chosen?.gameId,
      title: chosen?.title,
      startAt: chosen?.startAt
    ) else { return nil }
    if let current, current.assignment == assignment { return current }
    return EventControlDesired(revision: revisions.next(now: now()), assignment: assignment)
  }

  // MARK: - The key

  private func fetchKey() {
    guard keyFetch == nil else { return }
    // Asked now, so a wait to ask again is over.
    cancelKeyRetry()
    keyProblem = nil
    keyFetchNumber += 1
    let number = keyFetchNumber
    let account = self.account
    keyFetchScope = account.scope
    keyFetch = Task { [weak self] in
      let outcome: Result<TeamStationEventControlKey, any Error>
      do {
        outcome = .success(try await account.deviceEventControlKey())
      } catch {
        outcome = .failure(error)
      }
      self?.keyFetched(outcome, number: number)
    }
  }

  private func cancelKeyFetch() {
    keyFetch?.cancel()
    keyFetch = nil
    keyFetchNumber += 1
  }

  /// Asks for the key again in `keyRetryInterval`, unless a wait for that is already running.
  private func scheduleKeyRetry() {
    guard keyRetry == nil else { return }
    let interval = timing.keyRetryInterval
    keyRetry = Task { [weak self] in
      try? await Task.sleep(for: .seconds(interval))
      guard !Task.isCancelled else { return }
      self?.keyRetryDue()
    }
  }

  private func keyRetryDue() {
    keyRetry = nil
    reconcile(kick: false)
  }

  private func cancelKeyRetry() {
    keyRetry?.cancel()
    keyRetry = nil
  }

  /// Whether a failed key fetch is worth asking again on a timer. A rejected token has signed the
  /// account out, and a server that does not offer the feature will answer the same until the
  /// account changes; anything else (offline, a timeout, a 5xx while the server restarts) passes.
  static func isPassing(_ error: any Error) -> Bool {
    switch error as? TeamStationError {
    case .notSignedIn, .unavailable: false
    default: true
    }
  }

  func keyFetched(_ outcome: Result<TeamStationEventControlKey, any Error>, number: Int) {
    guard number == keyFetchNumber else { return }
    keyFetch = nil
    switch outcome {
    case let .success(key):
      guard let made = try? EventControlCredentials(
        issuer: key.issuer,
        userId: key.userId,
        accountTag: key.accountTag,
        keyId: key.keyId,
        key: key.key
      ) else {
        keyProblem = "TeamStation sent a key this app cannot read."
        keyFinalFor = account.scope
        refreshStatus()
        return
      }
      adopt(made)
    case let .failure(error):
      // The account changed while it was asked: nothing to say, ask again for the one now.
      if case TeamStationError.accountChanged = error {
        reconcile(kick: false)
        return
      }
      // A rejected token has signed the account out, which `accountChanged` follows. The feature
      // not offered: said here, and not asked again until the account changes. Offline, a
      // timeout, a 5xx while the server restarts: said here, and asked again in
      // `keyRetryInterval`, or at the next nudge if that comes first.
      keyProblem = error.localizedDescription
      if case TeamStationError.unavailable = error { keyFinalFor = account.scope }
      if Self.isPassing(error) { scheduleKeyRetry() }
      refreshStatus()
    }
  }

  private func adopt(_ made: EventControlCredentials) {
    guard isEnabled, account.isEventControlEligible, let server,
          made.scope.userId == account.scope?.userId
    else {
      refreshStatus()
      return
    }
    keyConfirmedAt = now()
    if let held = credentials, held.isSameAccount(as: made) {
      // This key is current, so a peer that held another is on another server.
      for (endpoint, entry) in links where entry.state == .keyMismatch {
        links[endpoint]?.state = .otherAccount
        if var peer = registry.peer(at: endpoint) {
          peer.state = .otherAccount
          registry.update(peer)
        }
      }
      reconcile(kick: false)
      return
    }
    // A new key, or another one: links made with the old one cannot be trusted with it.
    disengage()
    credentials = made
    credentialsServer = server
    keyStore.save(made, for: server)
    reconcile(kick: true)
  }

  /// Sign-out, a rejected token or another account: the cached key goes, for the server it was
  /// kept under and for the one in use.
  private func forgetKey() {
    if let credentialsServer { keyStore.remove(for: credentialsServer) }
    if let server { keyStore.remove(for: server) }
    credentials = nil
    credentialsServer = nil
    keyConfirmedAt = nil
  }

  /// Whether TeamStation answered with the key held within the last `keyRecheckInterval`.
  private var keyRecentlyConfirmed: Bool {
    guard let keyConfirmedAt else { return false }
    return now().timeIntervalSince(keyConfirmedAt) < Self.keyRecheckInterval
  }

  /// A peer answered with another key ID: fetch this Director's key again, unless one was fetched
  /// for that reason within `keyRecheckInterval`.
  private func peerHasAnotherKey() {
    if let lastMismatchFetch, now().timeIntervalSince(lastMismatchFetch) < Self.keyRecheckInterval {
      return
    }
    lastMismatchFetch = now()
    fetchKey()
  }

  // MARK: - Peers

  /// Known peers whose link has ended: remembered addresses and every peer seen this session.
  private func contactKnown() {
    guard engaged else { return }
    var endpoints = rememberedPeers()
    for endpoint in registry.knownEndpoints where !endpoints.contains(endpoint) {
      endpoints.append(endpoint)
    }
    contact(endpoints, fromSweep: false)
  }

  /// Starts a link to each endpoint without one running. A peer on another account, or speaking
  /// another version, is asked again only when a sweep finds it again.
  private func contact(_ endpoints: [EventControlEndpoint], fromSweep: Bool) {
    guard engaged else { return }
    for endpoint in endpoints {
      if let entry = links[endpoint] {
        if entry.running { continue }
        if !fromSweep, entry.state == .otherAccount || entry.state == .unsupported { continue }
        // The same peer is already being talked to at another address.
        if entry.isDuplicate, let instance = entry.instanceId,
           links.values.contains(where: { $0.running && $0.instanceId == instance }) { continue }
      }
      if !waiting.contains(endpoint) { waiting.append(endpoint) }
    }
    startWaiting()
  }

  private var connectingCount: Int {
    links.values.filter { $0.running && ($0.state == .connecting || $0.state == .discovering) }.count
  }

  private func startWaiting() {
    while engaged, !waiting.isEmpty, connectingCount < timing.maxConcurrentConnects {
      let endpoint = waiting.removeFirst()
      if links[endpoint]?.running == true { continue }
      guard let credentials else { return }
      let generation = self.generation
      let counter = ReportCounter()
      let link = EventControlDirectorLink(
        endpoint: endpoint,
        instanceId: instanceId,
        credentials: credentials,
        desired: desired,
        connector: connector,
        timing: timing.link,
        onUpdate: { [weak self] peer in
          let sequence = counter.next()
          Task { @MainActor in self?.linkReported(endpoint, generation, sequence, peer) }
        }
      )
      let settled = registry.peer(at: endpoint)
      let quiet = settled?.instanceId == nil
        || settled.map { $0.state == .unreachable || $0.state == .failed } ?? true
      links[endpoint] = LinkEntry(link: link, generation: generation, isBackgroundProbe: quiet)
      registry.update(EventControlPeer(endpoint: endpoint))
      Task { await link.start() }
    }
    refreshStatus()
  }

  func linkReported(
    _ endpoint: EventControlEndpoint,
    _ generation: Int,
    _ sequence: UInt64,
    _ peer: EventControlPeer
  ) {
    guard generation == self.generation, var entry = links[endpoint], entry.generation == generation,
          !entry.isDuplicate, sequence > entry.lastSequence
    else { return }
    var peer = peer
    // Another key ID while this Director's key was just confirmed: the peer is on another server.
    if peer.state == .keyMismatch, keyRecentlyConfirmed { peer.state = .otherAccount }
    entry.lastSequence = sequence
    entry.state = peer.state
    if Self.answered(peer.state) { entry.isBackgroundProbe = false }
    entry.instanceId = peer.instanceId ?? entry.instanceId
    entry.running = Self.isLive(peer.state)
    links[endpoint] = entry

    // One device answering at two addresses is one peer with one link. The link still talking to
    // it is kept; one only trying to reconnect (the device moved) gives way to this one.
    if let instance = peer.instanceId, entry.running,
       let other = links.first(where: {
         $0.key != endpoint && $0.value.running && $0.value.instanceId == instance
       }) {
      let otherIsTalking = !(other.value.state == .connecting || other.value.state == .discovering)
      let (dropped, droppedLink) = otherIsTalking
        ? (endpoint, entry.link)
        : (other.key, other.value.link)
      links[dropped]?.running = false
      links[dropped]?.isDuplicate = true
      links[dropped]?.instanceId = instance
      runInBackground { await droppedLink.stop(release: false) }
      if otherIsTalking {
        registry.remove(endpoint: endpoint)
        startWaiting()
        return
      }
    }

    registry.update(peer)
    if Self.isSameAccount(peer.state) { remember(endpoint) }
    if Self.answered(peer.state) {
      noteAnswered(endpoint)
    } else if peer.state == .unreachable || peer.state == .failed {
      noteFailed(endpoint)
    }
    if peer.state == .keyMismatch { peerHasAnotherKey() }
    startWaiting()
  }

  /// States only a peer that replied reaches.
  static func answered(_ state: EventControlPeerState) -> Bool {
    switch state {
    case .connected, .assigning, .applied, .disabled, .busy, .otherAccount, .keyMismatch,
         .unsupported, .invalid, .released: true
    case .connecting, .discovering, .failed, .unreachable: false
    }
  }

  /// States in which a link is still working.
  static func isLive(_ state: EventControlPeerState) -> Bool {
    switch state {
    case .connecting, .discovering, .connected, .assigning, .applied, .disabled, .busy: true
    case .otherAccount, .keyMismatch, .unsupported, .invalid, .failed, .released, .unreachable: false
    }
  }

  /// States only a peer of the same account reaches.
  static func isSameAccount(_ state: EventControlPeerState) -> Bool {
    switch state {
    case .connected, .assigning, .applied, .disabled, .busy: true
    default: false
    }
  }

  /// Every link stops, releasing a held lease first; a late report from any of them is ignored.
  private func letGoOfLinks() {
    generation += 1
    let leaving = links.values.map(\.link)
    links = [:]
    waiting = []
    registry = EventControlPeerRegistry()
    guard !leaving.isEmpty else { return }
    runInBackground {
      await withTaskGroup(of: Void.self) { group in
        for link in leaving {
          group.addTask { await link.stop(release: true) }
        }
      }
    }
  }

  /// Runs `work` without waiting for it, kept in `background` only until it finishes, so a
  /// Director toggled all day holds no more tasks than are still running.
  private func runInBackground(_ work: @escaping @Sendable () async -> Void) {
    backgroundSerial += 1
    let id = backgroundSerial
    background[id] = Task { [weak self] in
      await work()
      self?.background[id] = nil
    }
  }

  /// Background work not yet finished. For tests.
  var backgroundCount: Int { background.count }

  /// Whether a failed key fetch is waiting to be asked again. For tests.
  var keyRetryPending: Bool { keyRetry != nil }

  /// Hands the current desired event to every link, in order, so a quick A then B can never
  /// reach a link as B then A.
  private func pushDesired() {
    let previous = pushes
    pushes = Task { [weak self] in
      await previous?.value
      guard let self else { return }
      let next = desired
      let live = links.values.filter(\.running).map(\.link)
      for link in live { await link.setDesired(next) }
    }
  }

  // MARK: - Remembered addresses

  private func rememberedPeers() -> [EventControlEndpoint] {
    (defaults.stringArray(forKey: Self.rememberedPeersKey) ?? []).compactMap(Self.endpoint(from:))
  }

  private func remember(_ endpoint: EventControlEndpoint) {
    var kept = defaults.stringArray(forKey: Self.rememberedPeersKey) ?? []
    let text = endpoint.description
    guard kept.first != text else { return }
    kept.removeAll { $0 == text }
    kept.insert(text, at: 0)
    let limited = Array(kept.prefix(Self.rememberedPeerLimit))
    defaults.set(limited, forKey: Self.rememberedPeersKey)
    // What is said about addresses no longer remembered goes with them.
    let still = Set(limited)
    updateHealth { answered, failures in
      answered = answered.filter { still.contains($0.key) }
      failures = failures.filter { still.contains($0.key) }
    }
  }

  /// A remembered address answered: its run of failures is over.
  private func noteAnswered(_ endpoint: EventControlEndpoint) {
    let key = endpoint.description
    guard isRemembered(endpoint) else { return }
    let at = now().timeIntervalSince1970
    updateHealth { answered, failures in
      answered[key] = at
      failures[key] = nil
    }
  }

  /// A contact with a remembered address, or one seen this session, ended without an answer.
  /// Forgotten once it has failed `forgetAfterFailures` contacts in a row and not answered for
  /// `forgetAfterSilence` — but not while recording or streaming: the sweep then leaves the event
  /// ports out, so a device forgotten mid-take could not be found again until the take ended.
  private func noteFailed(_ endpoint: EventControlEndpoint) {
    let key = endpoint.description
    let identified = registry.peer(at: endpoint)?.instanceId != nil
    guard isRemembered(endpoint) || identified else { return }
    var failed = 0
    var lastAnswered: Double?
    updateHealth { answered, failures in
      failures[key, default: 0] += 1
      failed = failures[key] ?? 0
      lastAnswered = answered[key]
    }
    guard !isBusy, failed >= Self.forgetAfterFailures else { return }
    if let lastAnswered, now().timeIntervalSince1970 - lastAnswered < Self.forgetAfterSilence { return }
    forget(endpoint)
  }

  /// Drops an address from memory and from this session: it is contacted again only if a sweep
  /// finds a device there.
  private func forget(_ endpoint: EventControlEndpoint) {
    let key = endpoint.description
    var kept = defaults.stringArray(forKey: Self.rememberedPeersKey) ?? []
    kept.removeAll { $0 == key }
    defaults.set(kept, forKey: Self.rememberedPeersKey)
    updateHealth { answered, failures in
      answered[key] = nil
      failures[key] = nil
    }
    if let instance = registry.peer(at: endpoint)?.instanceId {
      registry.remove(instance)
    }
    registry.remove(endpoint: endpoint)
    if links[endpoint]?.running == false { links[endpoint] = nil }
    waiting.removeAll { $0 == endpoint }
    forgottenCount += 1
  }

  private func isRemembered(_ endpoint: EventControlEndpoint) -> Bool {
    (defaults.stringArray(forKey: Self.rememberedPeersKey) ?? []).contains(endpoint.description)
  }

  private func updateHealth(_ change: (inout [String: Double], inout [String: Int]) -> Void) {
    var answered = defaults.dictionary(forKey: Self.rememberedPeerAnsweredKey) as? [String: Double] ?? [:]
    var failures = defaults.dictionary(forKey: Self.rememberedPeerFailuresKey) as? [String: Int] ?? [:]
    change(&answered, &failures)
    defaults.set(answered, forKey: Self.rememberedPeerAnsweredKey)
    defaults.set(failures, forKey: Self.rememberedPeerFailuresKey)
  }

  /// `192.0.2.20:47614`, as `EventControlEndpoint.description` writes it.
  static func endpoint(from text: String) -> EventControlEndpoint? {
    guard let colon = text.lastIndex(of: ":"),
          let port = UInt16(text[text.index(after: colon)...]),
          IPv4Subnet.numeric(String(text[..<colon])) != nil
    else { return nil }
    return EventControlEndpoint(host: String(text[..<colon]), port: port)
  }

  // MARK: - Status

  private func refreshStatus() {
    var next = EventControlStatus()
    next.sweeper = !engaged ? .none : sharedDiscovery != nil ? .shared : ownSweeper != nil ? .own : .none
    next.localNetworkDenied = localNetworkDenied
    next.noInterface = noInterface
    if !isEnabled {
      next.phase = .off
    } else if !account.isEventControlEligible {
      next.phase = .signedOut
    } else if credentials == nil {
      next.phase = keyProblem.map { .keyUnavailable($0) } ?? .gettingKey
    } else if desired == nil {
      next.phase = .noEvent
    } else {
      next.phase = .running
    }
    // Only devices that have answered in this session, and of those only a link reconnecting to
    // a device it was talking to: a remembered address not yet answered, and a known device gone
    // unreachable being tried again in the background, never show as "connecting".
    for peer in registry.peers where peer.instanceId != nil {
      let probing = links[peer.endpoint].map { $0.running && $0.isBackgroundProbe } ?? false
      switch peer.state {
      case .applied: next.applied += 1
      case .busy: next.busy += 1
      case .disabled: next.disabled += 1
      case .otherAccount: next.otherAccount += 1
      case .keyMismatch: next.keyMismatch += 1
      case .connecting, .discovering: if !probing { next.connecting += 1 }
      default: break
      }
    }
    if next != status { status = next }
  }

  /// For `/dump-state`.
  public var telemetry: EventControlTelemetry {
    var out = EventControlTelemetry()
    out.enabled = isEnabled
    out.phase = status.phaseName
    out.status = status.line
    out.revision = desired?.revision ?? 0
    out.gameId = desired?.assignment.gameId ?? ""
    out.title = desired?.assignment.title ?? ""
    out.sweeper = status.sweeper.rawValue
    out.sweeps = sweepsSeen
    out.localNetworkDenied = localNetworkDenied
    out.noInterface = noInterface
    out.forgotten = forgottenCount
    out.peers = registry.peers.map { peer in
      EventControlPeerTelemetry(
        endpoint: peer.endpoint.description,
        instanceId: peer.instanceId?.hex ?? "",
        state: Self.describe(peer.state),
        consent: peer.consent,
        ackedRevision: peer.ackedRevision
      )
    }
    return out
  }

  /// Every peer, one per instance ID.
  public var peers: [EventControlPeer] { registry.peers }

  static func describe(_ state: EventControlPeerState) -> String {
    switch state {
    case .connecting: "connecting"
    case .discovering: "discovering"
    case .connected: "connected"
    case let .assigning(revision): "assigning(\(revision))"
    case let .applied(revision): "applied(\(revision))"
    case .disabled: "disabled"
    case .busy: "busy"
    case .otherAccount: "otherAccount"
    case .keyMismatch: "keyMismatch"
    case .unsupported: "unsupported"
    case .invalid: "invalid"
    case .failed: "failed"
    case .released: "released"
    case .unreachable: "unreachable"
    }
  }

  /// Waits for the work this has started in the background — key fetches, releases, event
  /// pushes — to finish. For tests.
  func settle() async {
    for _ in 0 ..< 20 {
      let pending = Array(background.values) + [ keyFetch, pushes ].compactMap { $0 }
      for task in pending { await task.value }
      await Task.yield()
      if background.isEmpty, keyFetch == nil { return }
    }
  }
}

/// Numbers a link's reports in the order it made them, so reports that reach the main actor out
/// of order are put back in it.
private final class ReportCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var last: UInt64 = 0

  func next() -> UInt64 {
    lock.withLock {
      last += 1
      return last
    }
  }
}
