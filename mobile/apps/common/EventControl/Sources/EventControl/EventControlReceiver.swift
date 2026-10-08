import Foundation

/// Names one TCP connection to a receiver, for the session bound to it.
public typealias EventControlConnectionID = UInt64

/// The clock a receiver measures leases on.
public enum EventControlClock {
  /// Seconds since an arbitrary point, on a clock that never steps when the wall clock is set and
  /// keeps counting while the device sleeps (`CLOCK_MONOTONIC` on Darwin), so a lease lasts 15 real
  /// seconds whatever the time of day does meanwhile.
  public static func monotonic() -> TimeInterval {
    TimeInterval(clock_gettime_nsec_np(CLOCK_MONOTONIC)) / 1_000_000_000
  }
}

/// Who is assigning, handed to the receiving app's apply closure.
public struct EventControlApplyContext: Sendable, Equatable {
  public let ownerInstanceId: EventControlInstanceID
  /// The address the assignment came from, as observed on the socket — never a claimed field.
  public let ownerHost: String
  public let revision: UInt64
}

/// The receiving app's commit: re-check consent and the signed-in account, store the event and
/// its title and start time together, move the publishing connection, and only then answer
/// `.applied`. Anything else it answers (`.disabled`, `.wrongAccount`, `.failed`, `.invalid`) is
/// sent back to the Director and leaves no lease.
public typealias EventControlApply =
  @Sendable (EventAssignment, EventControlApplyContext) async -> EventControlAckStatus

/// A Director's hold on this device's event: who, from where, and what it assigned.
public struct EventOverride: Sendable, Equatable {
  public let ownerInstanceId: EventControlInstanceID
  /// The Director's observed address, for "Override from Director 192.0.2.10".
  public let ownerHost: String
  public let revision: UInt64
  public let assignment: EventAssignment
}

/// Whether a Director controls the event now. While `.controlled`, the app shows the assigned
/// title and start time, greyed, with the picker locked and the attribution row visible.
public enum EventOverrideState: Sendable, Equatable {
  case none
  case controlled(EventOverride)

  public var current: EventOverride? {
    if case let .controlled(held) = self { return held }
    return nil
  }
}

/// Why a lease ended. In every case the last applied event stays selected.
public enum EventOverrideEndReason: Sendable, Equatable {
  /// The Director let go: its toggle went off, its event was cleared, it signed out or stopped.
  case released
  /// No renew for 15 seconds.
  case expired
  /// This device's operator turned "Allow Director Override" off.
  case consentOff
  /// This device signed out or into another account, or its key changed.
  case accountChanged
  /// The listener stopped or was rebuilt, which ends a lease as a restart would.
  case restarted
}

/// What a receiver tells its app.
public enum EventControlReceiverEvent: Sendable, Equatable {
  case overrideChanged(EventOverrideState)
  case overrideEnded(EventOverride, EventOverrideEndReason)
  /// A Director's key comes from another server secret: fetch this device's key again before
  /// trusting either.
  case keyMismatch(peerKeyId: String)
}

/// What to send back on a connection, and whether to close it afterwards.
public struct EventControlReceiverReply: Sendable, Equatable {
  public var replies: [Data]
  public var close: Bool
  /// The frame was accepted on this connection's authenticated session: the `announce` to a valid
  /// `discover`, or any answer sent with the session's nonce. What the connection limits count as
  /// authentication and activity (README.md, "Connection limits").
  public var authenticated: Bool

  public init(replies: [Data], close: Bool, authenticated: Bool = false) {
    self.replies = replies
    self.close = close
    self.authenticated = authenticated
  }
}

/// The receiving end's state machine, independent of any socket: README.md, "Receiver".
///
/// It owns the lease (first valid Director wins, 15 s without a renew ends it), each connection's
/// session binding (the Director's challenge and this receiver's nonce), request ordering, and
/// revision ordering. The app supplies its key, its operator's consent and the closure that
/// commits an assignment; it observes `overrideState` through `onEvent`.
public actor EventControlReceiver {
  public nonisolated let instanceId: EventControlInstanceID
  private var credentials: EventControlCredentials?
  private var consent: Bool
  private let apply: EventControlApply
  private let now: @Sendable () -> TimeInterval
  private let random: @Sendable (Int) -> Data
  private let onEvent: @Sendable (EventControlReceiverEvent) -> Void
  private let autoExpire: Bool
  private let leaseDuration: TimeInterval

  private var lease: EventOverride?
  private var leaseExpiry: TimeInterval?
  private var applying: EventControlInstanceID?
  /// Bumped by anything that must invalidate an apply in flight.
  private var generation: UInt64 = 0
  private var interruption: EventControlAckStatus = .expired
  private var bindings: [EventControlConnectionID: Binding] = [:]
  private var expiryTask: Task<Void, Never>?

  private struct Binding {
    let director: EventControlInstanceID
    let challenge: Data
    let nonce: Data
    var lastRequestId: UInt64
    var lastReply: Data?
  }

  /// - Parameters:
  ///   - credentials: this device's own key, or nil while it has none (every connection is then
  ///     closed unanswered).
  ///   - consent: "Allow Director Override".
  ///   - now: seconds on the clock leases are measured on; `EventControlClock.monotonic`, which a
  ///     change to the wall clock does not move. Tests drive it by hand.
  ///   - autoExpire: end a lease on its own when it runs out. Tests that drive `now` turn it off and
  ///     call `expireIfDue()`.
  ///   - leaseDuration: 15 s, the protocol's; only tests shorten it.
  public init(
    instanceId: EventControlInstanceID,
    credentials: EventControlCredentials?,
    consent: Bool,
    apply: @escaping EventControlApply,
    now: @escaping @Sendable () -> TimeInterval = EventControlClock.monotonic,
    random: @escaping @Sendable (Int) -> Data = { EventControlBytes.random($0) },
    autoExpire: Bool = true,
    leaseDuration: TimeInterval = EventControlProtocol.leaseDuration,
    onEvent: @escaping @Sendable (EventControlReceiverEvent) -> Void = { _ in }
  ) {
    self.leaseDuration = leaseDuration
    self.instanceId = instanceId
    self.credentials = credentials
    self.consent = consent
    self.apply = apply
    self.now = now
    self.random = random
    self.autoExpire = autoExpire
    self.onEvent = onEvent
  }

  // MARK: - What the app sets and reads

  public var overrideState: EventOverrideState {
    lease.map { .controlled($0) } ?? .none
  }

  /// When the current lease ends unless renewed, on the `now` clock.
  public var leaseExpiresAt: TimeInterval? { leaseExpiry }

  public var isConsenting: Bool { consent }

  /// Whether a Director holds this device's event or is writing it now: a lease, or an apply in
  /// flight. The app's own picker stays locked while it is true, including the moment between a
  /// commit answering `.applied` and `.overrideChanged` reaching the app.
  public var holdsEvent: Bool { lease != nil || applying != nil }

  /// Off releases at once and restores local editing; on lets the next assignment in.
  public func setConsent(_ allowed: Bool) {
    guard allowed != consent else { return }
    consent = allowed
    guard !allowed else { return }
    interrupt(with: .disabled)
    endLease(.consentOff)
  }

  /// A new key, or none. Another account (or a key from another secret) ends the lease and every
  /// session; the same key again changes nothing.
  public func setCredentials(_ next: EventControlCredentials?) {
    if let current = credentials, let next, current.isSameAccount(as: next) { return }
    credentials = next
    interrupt(with: .wrongAccount)
    bindings = [:]
    endLease(.accountChanged)
  }

  /// As after a process restart: no lease, no sessions. Consent and the key are kept.
  public func restart() {
    interrupt(with: .expired)
    bindings = [:]
    endLease(.restarted)
  }

  /// Ends the lease if its time is up.
  public func expireIfDue() {
    guard let leaseExpiry, now() >= leaseExpiry else { return }
    endLease(.expired)
  }

  /// The connection went; its session goes with it. The lease does not: only expiry, release,
  /// consent and the account end that.
  public func connectionClosed(_ connection: EventControlConnectionID) {
    bindings[connection] = nil
  }

  // MARK: - Frames

  /// Everything a receiver does with one payload from `connection`.
  public func handle(
    payload: Data,
    connection: EventControlConnectionID,
    remoteHost: String
  ) async -> EventControlReceiverReply {
    guard let credentials else { return EventControlReceiverReply(replies: [], close: true) }
    if let version = payload.first, version != EventControlProtocol.version {
      let header = EventControlHeader(
        sender: instanceId,
        requestId: 0,
        accountTag: credentials.accountTagBytes,
        keyId: credentials.keyIdBytes,
        challenge: Data(count: EventControlProtocol.nonceBytes),
        receiverNonce: Data()
      )
      let message = EventControlMessage(header: header, body: .ack(status: .unsupported, revision: 0))
      return close(with: EventControlCodec.encode(message, with: credentials))
    }
    guard let decoded = try? EventControlCodec.decode(payload), decoded.message.type.isFromDirector
    else { return EventControlReceiverReply(replies: [], close: true) }
    let header = decoded.message.header
    let unbound = { (status: EventControlAckStatus) in
      self.close(with: self.ack(status, revision: 0, to: header, nonce: Data(), credentials))
    }
    guard header.keyId == credentials.keyIdBytes else {
      onEvent(.keyMismatch(peerKeyId: EventControlBytes.hex(header.keyId)))
      return unbound(.keyMismatch)
    }
    guard header.accountTag == credentials.accountTagBytes else { return unbound(.wrongAccount) }
    guard decoded.isAuthentic(with: credentials) else { return unbound(.invalid) }
    expireIfDue()

    if case .discover = decoded.message.body {
      return discover(header, connection: connection, credentials)
    }
    guard var binding = bindings[connection], binding.director == header.sender,
          EventControlBytes.constantTimeEqual(binding.challenge, header.challenge),
          EventControlBytes.constantTimeEqual(binding.nonce, header.receiverNonce)
    else {
      bindings[connection] = nil
      return unbound(.invalid)
    }
    let revision = Self.revision(of: decoded.message.body)
    if header.requestId == binding.lastRequestId, let last = binding.lastReply {
      // A retry of the request just answered: the same answer, and nothing done twice.
      return EventControlReceiverReply(replies: [ last ], close: false, authenticated: true)
    }
    guard header.requestId > binding.lastRequestId else {
      let reply = ack(.stale, revision: revision, to: header, nonce: binding.nonce, credentials)
      return EventControlReceiverReply(replies: [ reply ], close: false, authenticated: true)
    }
    binding.lastRequestId = header.requestId
    binding.lastReply = nil
    bindings[connection] = binding

    let status: EventControlAckStatus
    switch decoded.message.body {
    case let .assign(_, gameId, title, startAt):
      status = await assign(gameId, title, startAt, revision, from: header.sender, at: remoteHost)
    case .renew:
      status = renew(revision, from: header.sender)
    case .release:
      status = release(from: header.sender)
    case .discover, .announce, .ack:
      status = .invalid
    }
    // The key may have changed while an apply was out; answer with the one that signed the request.
    let reply = ack(status, revision: revision, to: header, nonce: binding.nonce, credentials)
    if bindings[connection]?.lastRequestId == header.requestId {
      bindings[connection]?.lastReply = reply
    }
    return EventControlReceiverReply(replies: [ reply ], close: false, authenticated: true)
  }

  private func discover(
    _ header: EventControlHeader,
    connection: EventControlConnectionID,
    _ credentials: EventControlCredentials
  ) -> EventControlReceiverReply {
    let nonce = random(EventControlProtocol.nonceBytes)
    let leaseState: EventControlLeaseState
    switch lease?.ownerInstanceId {
    case nil: leaseState = .free
    case header.sender: leaseState = .heldBySender
    default: leaseState = .heldByOther
    }
    let message = EventControlMessage(
      header: reply(to: header, nonce: nonce, credentials),
      body: .announce(
        consent: consent,
        lease: leaseState,
        leaseRevision: leaseState == .heldBySender ? lease?.revision ?? 0 : 0
      )
    )
    let payload = EventControlCodec.encode(message, with: credentials)
    bindings[connection] = Binding(
      director: header.sender,
      challenge: header.challenge,
      nonce: nonce,
      lastRequestId: header.requestId,
      lastReply: payload
    )
    return EventControlReceiverReply(replies: [ payload ], close: false, authenticated: true)
  }

  private func assign(
    _ gameId: String,
    _ title: String,
    _ startAt: String,
    _ revision: UInt64,
    from director: EventControlInstanceID,
    at host: String
  ) async -> EventControlAckStatus {
    guard let assignment = try? EventAssignment(wireGameId: gameId, title: title, startAt: startAt)
    else { return .invalid }
    guard consent else { return .disabled }
    if let lease, lease.ownerInstanceId != director { return .busy }
    guard applying == nil else { return .busy }
    if let lease {
      guard revision >= lease.revision else { return .stale }
      if revision == lease.revision {
        // The same assignment again — a retry, perhaps on a new connection: renew, do not re-apply.
        guard lease.assignment == assignment else { return .invalid }
        leaseExpiry = now() + leaseDuration
        scheduleExpiry()
        return .applied
      }
    }
    let started = generation
    applying = director
    let status = await apply(
      assignment,
      EventControlApplyContext(ownerInstanceId: director, ownerHost: host, revision: revision)
    )
    applying = nil
    guard generation == started else { return interruption }
    guard status == .applied else { return status }
    let held = EventOverride(
      ownerInstanceId: director,
      ownerHost: host,
      revision: revision,
      assignment: assignment
    )
    lease = held
    leaseExpiry = now() + leaseDuration
    scheduleExpiry()
    onEvent(.overrideChanged(.controlled(held)))
    return .applied
  }

  private func renew(_ revision: UInt64, from director: EventControlInstanceID) -> EventControlAckStatus {
    guard consent else { return .disabled }
    guard let lease else { return .expired }
    guard lease.ownerInstanceId == director else { return .busy }
    guard revision == lease.revision else { return .stale }
    leaseExpiry = now() + leaseDuration
    scheduleExpiry()
    return .applied
  }

  private func release(from director: EventControlInstanceID) -> EventControlAckStatus {
    guard let lease else { return .expired }
    guard lease.ownerInstanceId == director else { return .busy }
    endLease(.released)
    return .applied
  }

  // MARK: - Helpers

  private func interrupt(with status: EventControlAckStatus) {
    generation &+= 1
    interruption = status
  }

  private func endLease(_ reason: EventOverrideEndReason) {
    expiryTask?.cancel()
    expiryTask = nil
    leaseExpiry = nil
    guard let ended = lease else { return }
    lease = nil
    onEvent(.overrideEnded(ended, reason))
    onEvent(.overrideChanged(.none))
  }

  private func scheduleExpiry() {
    guard autoExpire, let leaseExpiry else { return }
    expiryTask?.cancel()
    let delay = max(0, leaseExpiry - now())
    expiryTask = Task { [weak self] in
      try? await Task.sleep(for: .seconds(delay))
      guard !Task.isCancelled else { return }
      await self?.expiryTimerFired()
    }
  }

  /// The timer ran out: end the lease if it is due, or wait again for what is left of it. A timer
  /// can wake before the clock it is checked against says the lease is over (it sleeps on another
  /// clock, or a test moved `now` back); it then must not stop watching.
  private func expiryTimerFired() {
    guard !Task.isCancelled else { return }
    expireIfDue()
    if leaseExpiry != nil { scheduleExpiry() }
  }

  private static func revision(of body: EventControlBody) -> UInt64 {
    switch body {
    case let .assign(revision, _, _, _), let .renew(revision), let .release(revision):
      return revision
    case .discover, .announce, .ack:
      return 0
    }
  }

  private func reply(
    to header: EventControlHeader,
    nonce: Data,
    _ credentials: EventControlCredentials
  ) -> EventControlHeader {
    EventControlHeader(
      sender: instanceId,
      requestId: header.requestId,
      accountTag: credentials.accountTagBytes,
      keyId: credentials.keyIdBytes,
      challenge: header.challenge,
      receiverNonce: nonce
    )
  }

  private func ack(
    _ status: EventControlAckStatus,
    revision: UInt64,
    to header: EventControlHeader,
    nonce: Data,
    _ credentials: EventControlCredentials
  ) -> Data {
    EventControlCodec.encode(
      EventControlMessage(
        header: reply(to: header, nonce: nonce, credentials),
        body: .ack(status: status, revision: revision)
      ),
      with: credentials
    )
  }

  private func close(with payload: Data) -> EventControlReceiverReply {
    EventControlReceiverReply(replies: [ payload ], close: true)
  }
}

extension EventControlReceiver {
  /// Answers one connection until either end closes it, or a reply says to. Any transport — the
  /// listener's TCP connections, or an in-memory pair in a test — is served the same way.
  ///
  /// `onAuthenticated` is called for every frame accepted on the connection's authenticated
  /// session, before its answer is sent: what the listener's connection limits count.
  public nonisolated func serve(
    _ connection: any EventControlConnection,
    id: EventControlConnectionID,
    onAuthenticated: @Sendable () -> Void = {}
  ) async {
    while true {
      guard let payload = try? await connection.receive() else { break }
      let reply = await handle(payload: payload, connection: id, remoteHost: connection.remoteHost)
      if reply.authenticated { onAuthenticated() }
      var sent = true
      for answer in reply.replies where sent {
        sent = (try? await connection.send(answer)) != nil
      }
      if !sent || reply.close { break }
    }
    connection.close()
    await connectionClosed(id)
  }
}
