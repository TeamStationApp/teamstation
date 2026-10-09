import CameramanCore
import EventControl
import Foundation

/// This phone's side of Director event control: a Director on the local network, signed in to the
/// same TeamStation account, may set the event radar readings are published to, while the operator
/// allows it.
///
/// It owns the event-control receiver and its TCP listener, and this login's control key. The
/// listener runs only while the phone is signed in, its user is known, it holds a key for that user
/// and "Allow Director Override" is on. The key is fetched with the phone's own login, kept in the
/// keychain for the account server, and discarded on sign-out, on another account, and when the
/// server refuses the login or no longer offers the feature. A key kept for the signed-in user lets
/// a phone relaunched without a connection take part before the server answers.
///
/// The decisions an assignment needs — consent, account, hold and order — are made by
/// `ScoreboardDesk.applyAssignedEvent`, which this calls with what the receiver checked.
@MainActor
public final class EventOverrideController {
  public let receiver: EventControlReceiver
  public let listener: EventControlListener
  public private(set) var credentials: EventControlCredentials?
  public private(set) var listenerState: EventControlListener.State = .stopped
  /// Why there is no key, when the server said why.
  public private(set) var keyProblem: KeyProblem?

  public enum KeyProblem: Equatable, Sendable {
    /// The server refused this login.
    case rejected
    /// The server does not offer event control, or answered with something unusable.
    case unavailable
    /// The server could not be asked, and no key was kept for this user. Asked again every
    /// `keyRetryInterval` while signed in and allowed.
    case offline
  }

  private let desk: ScoreboardDesk
  private let keys: EventControlKeyStore
  private let now: @Sendable () -> Date
  private var listenerWanted = false
  private var started = false
  private var refreshing: Task<Void, Never>?
  private var consentChange: Task<Void, Never>?
  private var lastForcedFetch: Date?
  private var consumers: [Task<Void, Never>] = []
  private let keyRetryInterval: TimeInterval
  /// The wait before a key that could not be fetched offline is asked for again.
  private var keyRetry: Task<Void, Never>?

  /// The shortest wait between two key fetches asked for by Directors whose key ID differs, so a
  /// stream of them cannot turn into a stream of requests to the account server.
  static let keyMismatchRefetchInterval: TimeInterval = 60

  public init(
    desk: ScoreboardDesk,
    keys: EventControlKeyStore,
    instanceId: EventControlInstanceID,
    ports: [UInt16] = EventControlProtocol.ports,
    rebindDelay: TimeInterval = 0.5,
    leaseDuration: TimeInterval = EventControlProtocol.leaseDuration,
    keyRetryInterval: TimeInterval = 60,
    now: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.desk = desk
    self.keys = keys
    self.now = now
    self.keyRetryInterval = keyRetryInterval
    let relay = Relay()
    let (events, eventSink) = AsyncStream.makeStream(of: EventControlReceiverEvent.self)
    let (states, stateSink) = AsyncStream.makeStream(of: EventControlListener.State.self)
    receiver = EventControlReceiver(
      instanceId: instanceId,
      credentials: nil,
      consent: desk.allowsDirectorOverride,
      apply: { assignment, context in await relay.commit(assignment, context) },
      leaseDuration: leaseDuration,
      onEvent: { eventSink.yield($0) }
    )
    listener = EventControlListener(
      receiver: receiver,
      ports: ports,
      rebindDelay: rebindDelay,
      onStateChange: { stateSink.yield($0) }
    )
    relay.controller = self
    // The receiver's lease, not the mirror of it that arrives a step later, decides whether the
    // operator may pick.
    desk.directorHoldsEvent = { [receiver] in await receiver.holdsEvent }
    // Both streams keep the order things happened in; a lease that began and ended is never seen
    // the other way round.
    consumers = [
      Task { [weak self] in
        for await event in events { self?.receiverEvent(event) }
      },
      Task { [weak self] in
        for await state in states { self?.listenerChanged(state) }
      }
    ]
    desk.onAccountChange = { [weak self] in self?.refresh() }
  }

  deinit {
    for consumer in consumers { consumer.cancel() }
    keyRetry?.cancel()
  }

  /// Signed in as a user this phone holds a key for.
  public var isEligible: Bool {
    guard desk.isSignedIn, !desk.userId.isEmpty, let credentials else { return false }
    return credentials.scope.userId == desk.userId
  }

  /// Starts at app launch: a kept key first, then the server.
  public func start() {
    guard !started else { return }
    started = true
    refresh()
  }

  /// Asks the server again who this login is and for its key, after anything earlier has finished.
  /// `forceKey` skips the kept key, for a Director whose key ID differs from it.
  public func refresh(forceKey: Bool = false) {
    // Asked now, so a wait to ask again is over; one that fails offline starts another.
    cancelKeyRetry()
    let previous = refreshing
    refreshing = Task { [weak self] in
      await previous?.value
      await self?.runRefresh(forceKey: forceKey)
    }
  }

  /// Waits for the refreshes and consent changes asked for so far.
  public func settle() async {
    await refreshing?.value
    await consentChange?.value
  }

  /// "Allow Director Override". Off gives the event back to this phone at once, then releases the
  /// lease and stops listening. On starts listening when the phone is eligible.
  public func setConsent(_ allowed: Bool) {
    desk.setAllowDirectorOverride(allowed)
    updateKeyRetry()
    let previous = consentChange
    let receiver = receiver
    consentChange = Task { [weak self] in
      await previous?.value
      await receiver.setConsent(allowed)
      self?.reconcile()
    }
    updateStatus()
  }

  /// From the app's foreground handler. iOS takes listeners down in the background, and a key that
  /// could not be fetched offline may be fetchable now. A server that refused, or does not offer
  /// the feature, is not asked again until the login changes or the app restarts.
  public func handleForeground() {
    if listenerWanted { listener.ensureListening() }
    if started, desk.isSignedIn, desk.allowsDirectorOverride, !isEligible,
       keyProblem == nil || keyProblem == .offline
    {
      refresh()
    }
  }

  // MARK: - Refresh

  private var server: String? {
    URL(string: ScoreboardTarget.httpOrigin(desk.accountServer))
      .flatMap(EventControlCredentials.canonicalOrigin(of:))
  }

  private func runRefresh(forceKey: Bool) async {
    guard desk.isSignedIn else {
      keyProblem = nil
      await forget()
      return
    }
    let generation = desk.accountGeneration
    let current = { [desk] in !Task.isCancelled && generation == desk.accountGeneration }
    // Whatever was proved for an earlier login does not stand for this one.
    if let credentials, credentials.scope.userId != desk.userId { await forget() }
    if !forceKey, credentials == nil, !desk.userId.isEmpty, let server,
       let kept = keys.credentials(for: server), kept.scope.userId == desk.userId
    {
      await use(kept)
    }

    switch await desk.refreshIdentity() {
    case .rejected:
      guard current() else { return }
      keyProblem = .rejected
      await forget()
      return
    case .signedOut, .superseded:
      return
    case .offline:
      guard current() else { return }
      if desk.userId.isEmpty {
        keyProblem = .offline
        reconcile()
        return
      }
    case .valid:
      guard current() else { return }
      if let credentials, credentials.scope.userId != desk.userId { await forget() }
    }

    let fetched = await desk.fetchEventControlKey()
    guard current() else { return }
    switch fetched {
    case let .key(data):
      guard let next = try? EventControlCredentials.decode(serverReply: data),
            next.scope.userId == desk.userId
      else {
        keyProblem = .unavailable
        await forget()
        return
      }
      if let server { keys.save(next, for: server) }
      keyProblem = nil
      await use(next)
    case .rejected:
      keyProblem = .rejected
      await forget()
    case .unavailable:
      keyProblem = .unavailable
      await forget()
    case .offline:
      keyProblem = credentials == nil ? .offline : nil
      reconcile()
    case .superseded:
      return
    }
  }

  private func use(_ next: EventControlCredentials) async {
    credentials = next
    await receiver.setCredentials(next)
    reconcile()
  }

  /// Drops the key, here and in the keychain, which ends any lease.
  private func forget() async {
    if let server { keys.remove(for: server) }
    credentials = nil
    await receiver.setCredentials(nil)
    reconcile()
  }

  // MARK: - Listener

  private func reconcile() {
    let wanted = desk.allowsDirectorOverride && isEligible
    if wanted != listenerWanted {
      listenerWanted = wanted
      if wanted { listener.start() } else { listener.stop() }
    }
    updateKeyRetry()
    updateStatus()
  }

  // MARK: - Asking again

  /// Whether a key that could not be fetched offline should be asked for again: signed in, allowed,
  /// and without a key. A refused login or a server that does not offer the feature is not asked
  /// again until the login changes.
  private var keyRetryWanted: Bool {
    started && desk.isSignedIn && desk.allowsDirectorOverride && !isEligible && keyProblem == .offline
  }

  /// Starts the wait to ask again while it is wanted, once, and ends it when it is not.
  private func updateKeyRetry() {
    guard keyRetryWanted else {
      cancelKeyRetry()
      return
    }
    guard keyRetry == nil else { return }
    let interval = keyRetryInterval
    keyRetry = Task { [weak self] in
      try? await Task.sleep(for: .seconds(interval))
      guard !Task.isCancelled, let self else { return }
      keyRetry = nil
      if keyRetryWanted { refresh() }
    }
  }

  private func cancelKeyRetry() {
    keyRetry?.cancel()
    keyRetry = nil
  }

  /// Whether a key that could not be fetched is waiting to be asked for again. For tests.
  var keyRetryPending: Bool { keyRetry != nil }

  private func listenerChanged(_ state: EventControlListener.State) {
    listenerState = state
    updateStatus()
  }

  private func updateStatus() {
    desk.setEventControlStatus(
      Self.statusLine(
        signedIn: desk.isSignedIn,
        eligible: isEligible,
        problem: keyProblem,
        listening: listenerWanted ? listenerState : .stopped
      )
    )
  }

  /// The line under "Allow Director Override" while it is on.
  static func statusLine(
    signedIn: Bool,
    eligible: Bool,
    problem: KeyProblem?,
    listening: EventControlListener.State
  ) -> String {
    if !signedIn { return "Log in to TeamStation to allow it" }
    if !eligible {
      switch problem {
      case .rejected: return "Log in to TeamStation again to allow it"
      case .unavailable: return "Not offered by this account server"
      case .offline, nil: return "Waiting for the account server"
      }
    }
    switch listening {
    case .listening: return "Waiting for a Director"
    case let .portsUnavailable(ports):
      return "Ports \(ports.map(String.init).joined(separator: " and ")) are in use"
    case .binding, .stopped: return "Starting"
    }
  }

  // MARK: - The receiver

  private func receiverEvent(_ event: EventControlReceiverEvent) {
    switch event {
    case let .overrideChanged(state):
      // A hold reported after consent went off, or after the login changed, is already over.
      if let held = state.current, desk.allowsDirectorOverride, isEligible, let credentials {
        desk.setOverride(source(held.ownerInstanceId, held.ownerHost, held.revision, credentials))
      } else {
        desk.setOverride(nil)
      }
    case .overrideEnded:
      break
    case .keyMismatch:
      let at = now()
      if let lastForcedFetch, at.timeIntervalSince(lastForcedFetch) < Self.keyMismatchRefetchInterval {
        return
      }
      lastForcedFetch = at
      refresh(forceKey: true)
    }
  }

  func commit(
    _ assignment: EventAssignment,
    _ context: EventControlApplyContext
  ) -> EventControlAckStatus {
    guard isEligible, let credentials else { return .wrongAccount }
    let outcome = desk.applyAssignedEvent(
      gameId: assignment.gameId,
      title: assignment.title,
      startAt: assignment.startAt,
      from: source(context.ownerInstanceId, context.ownerHost, context.revision, credentials)
    )
    switch outcome {
    case .applied: return .applied
    case .disabled: return .disabled
    case .wrongAccount: return .wrongAccount
    case .stale: return .stale
    }
  }

  private func source(
    _ owner: EventControlInstanceID,
    _ host: String,
    _ revision: UInt64,
    _ credentials: EventControlCredentials
  ) -> ScoreboardAssignmentSource {
    ScoreboardAssignmentSource(
      owner: owner.hex,
      host: host,
      revision: revision,
      userId: credentials.scope.userId
    )
  }
}

/// Lets the receiver, made before the controller is, reach it on the main actor.
@MainActor
private final class Relay {
  weak var controller: EventOverrideController?

  func commit(_ assignment: EventAssignment, _ context: EventControlApplyContext) -> EventControlAckStatus {
    controller?.commit(assignment, context) ?? .failed
  }
}
