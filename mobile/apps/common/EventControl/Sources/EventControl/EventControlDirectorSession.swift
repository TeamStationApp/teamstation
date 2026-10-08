import Foundation

/// The event a Director wants every eligible peer on, at a revision that only goes up.
public struct EventControlDesired: Sendable, Equatable {
  public let revision: UInt64
  public let assignment: EventAssignment

  public init(revision: UInt64, assignment: EventAssignment) {
    self.revision = revision
    self.assignment = assignment
  }
}

/// Makes revisions that increase for the life of an installation: the wall clock in milliseconds,
/// or one more than the last, whichever is larger. A relaunched Director therefore continues
/// above every revision it sent before, without storing anything.
public struct EventControlRevisionCounter: Sendable {
  public private(set) var last: UInt64

  public init(last: UInt64 = 0) {
    self.last = last
  }

  public mutating func next(now: Date = Date()) -> UInt64 {
    let clock = UInt64(max(0, now.timeIntervalSince1970 * 1000).rounded(.down))
    last = max(last &+ 1, clock)
    return last
  }
}

/// Where a receiver listens.
public struct EventControlEndpoint: Sendable, Hashable, CustomStringConvertible {
  public let host: String
  public let port: UInt16

  public init(host: String, port: UInt16) {
    self.host = host
    self.port = port
  }

  public var description: String {
    host.contains(":") ? "[\(host)]:\(port)" : "\(host):\(port)"
  }
}

/// Where a Director stands with one peer.
public enum EventControlPeerState: Sendable, Equatable {
  /// Opening the TCP connection.
  case connecting
  /// `discover` sent, waiting for `announce`.
  case discovering
  /// Same account, session bound, nothing to assign.
  case connected
  /// `assign` sent at this revision, waiting for its `ack`.
  case assigning(UInt64)
  /// The peer publishes to the assignment at this revision and the lease is held.
  case applied(UInt64)
  /// The peer's operator has not allowed Director override. Asked again every renew interval.
  case disabled
  /// Another Director holds the lease. Asked again every renew interval.
  case busy
  /// Another account, or the same account on another server. Left alone.
  case otherAccount
  /// The keys come from different server secrets. Fetch this Director's key again.
  case keyMismatch
  /// The peer speaks another protocol version.
  case unsupported
  /// The peer sent something malformed or unauthentic.
  case invalid
  /// Three failed attempts in a row; wait for the next sweep or known-peer probe.
  case failed
  /// This Director let go: no event, or toggled off.
  case released
  /// The connection could not be made or remade.
  case unreachable
}

/// What a Director knows of one peer: never its app, model or name.
public struct EventControlPeer: Sendable, Equatable {
  public var endpoint: EventControlEndpoint
  /// Learned from its first reply.
  public var instanceId: EventControlInstanceID?
  public var state: EventControlPeerState
  /// "Allow Director Override", from `announce` and refreshed by acks.
  public var consent: Bool?
  /// The revision the peer last acknowledged as applied.
  public var ackedRevision: UInt64?
  public var lastStatus: EventControlAckStatus?
  /// The peer's key ID when it differs from this Director's.
  public var peerKeyId: String?

  public init(endpoint: EventControlEndpoint, state: EventControlPeerState = .connecting) {
    self.endpoint = endpoint
    self.state = state
  }
}

/// What to do after a step of the Director's state machine.
public struct EventControlDirectorStep: Sendable, Equatable {
  /// Payloads to send, in order.
  public var send: [Data] = []
  /// Close the connection after sending.
  public var close = false

  public init(send: [Data] = [], close: Bool = false) {
    self.send = send
    self.close = close
  }
}

/// The Director's side of one connection, independent of any socket: README.md, "Director".
///
/// One request is outstanding at a time. A reply is accepted only if it answers that request,
/// carries this session's challenge (and, after `announce`, the receiver's nonce) and verifies
/// with this Director's key; anything else is ignored, so a stale reply can never overwrite a newer
/// desired state.
public struct EventControlDirectorSession: Sendable {
  public private(set) var peer: EventControlPeer
  public let instanceId: EventControlInstanceID
  public let challenge: Data
  public let maxFailures: Int
  private let credentials: EventControlCredentials

  private var desired: EventControlDesired?
  private var nextRequestId: UInt64 = 1
  private var nonce: Data?
  private var pending: Pending?
  private var held: UInt64?
  private var failures = 0

  private struct Pending {
    let requestId: UInt64
    let type: EventControlMessageType
    let revision: UInt64
  }

  public init(
    endpoint: EventControlEndpoint,
    instanceId: EventControlInstanceID,
    credentials: EventControlCredentials,
    desired: EventControlDesired?,
    challenge: Data = EventControlBytes.random(EventControlProtocol.nonceBytes),
    maxFailures: Int = 3
  ) {
    peer = EventControlPeer(endpoint: endpoint, state: .discovering)
    self.instanceId = instanceId
    self.credentials = credentials
    self.desired = desired
    self.challenge = challenge
    self.maxFailures = maxFailures
  }

  /// The request a reply is awaited for, if any.
  public var awaitingRequestId: UInt64? { pending?.requestId }

  /// Whether this Director's lease on the peer is believed held.
  public var holdsLease: Bool { held != nil }

  /// Whether the session is bound (the peer announced itself to this Director).
  public var isBound: Bool { nonce != nil }

  /// Carries what an earlier connection learned about the same peer into this session: who it
  /// is, its consent, and the revision it acknowledged. The session itself starts over.
  mutating func restore(from earlier: EventControlPeer) {
    peer.instanceId = earlier.instanceId
    peer.consent = earlier.consent
    peer.ackedRevision = earlier.ackedRevision
    peer.lastStatus = earlier.lastStatus
  }

  /// The opening `discover`.
  public mutating func begin() -> EventControlDirectorStep {
    peer.state = .discovering
    return EventControlDirectorStep(send: [ request(.discover, revision: 0) ])
  }

  /// A new desired event, or none. Sent at once when the connection is free; otherwise after the
  /// reply in flight. None releases a held lease.
  public mutating func setDesired(_ next: EventControlDesired?) -> EventControlDirectorStep {
    desired = next
    guard isBound, pending == nil else { return EventControlDirectorStep() }
    return nextRequest()
  }

  /// Every renew interval: renew a held lease, or ask again where the answer may have changed.
  public mutating func tick() -> EventControlDirectorStep {
    guard isBound, pending == nil else { return EventControlDirectorStep() }
    switch peer.state {
    case .applied, .assigning, .disabled, .busy, .connected, .released:
      return nextRequest(retry: true)
    default:
      return EventControlDirectorStep()
    }
  }

  /// The awaited reply did not come.
  public mutating func replyTimedOut() -> EventControlDirectorStep {
    guard pending != nil else { return EventControlDirectorStep() }
    pending = nil
    return fail()
  }

  /// Letting go: release a held lease, then close.
  public mutating func finish(release: Bool) -> EventControlDirectorStep {
    desired = nil
    var step = EventControlDirectorStep(close: true)
    if release, isBound, let held {
      step.send = [ request(.release, revision: held) ]
      self.held = nil
    }
    peer.state = .released
    return step
  }

  /// A payload from the peer.
  public mutating func receive(_ payload: Data) -> EventControlDirectorStep {
    guard let decoded = try? EventControlCodec.decode(payload) else {
      return stop(.invalid)
    }
    let header = decoded.message.header
    guard let awaited = pending, header.requestId == awaited.requestId,
          EventControlBytes.constantTimeEqual(header.challenge, challenge),
          !decoded.message.type.isFromDirector
    else {
      // Not an answer to what is outstanding: a late reply to an older request.
      return EventControlDirectorStep()
    }
    peer.instanceId = header.sender
    guard header.keyId == credentials.keyIdBytes else {
      peer.peerKeyId = EventControlBytes.hex(header.keyId)
      peer.lastStatus = .keyMismatch
      return stop(.keyMismatch)
    }
    guard header.accountTag == credentials.accountTagBytes else {
      peer.lastStatus = .wrongAccount
      return stop(.otherAccount)
    }
    guard decoded.isAuthentic(with: credentials) else { return stop(.invalid) }
    if let nonce, !EventControlBytes.constantTimeEqual(nonce, header.receiverNonce) {
      return stop(.invalid)
    }
    pending = nil

    switch decoded.message.body {
    case let .announce(consent, lease, leaseRevision):
      guard awaited.type == .discover, header.receiverNonce.count == EventControlProtocol.nonceBytes
      else { return stop(.invalid) }
      nonce = header.receiverNonce
      peer.consent = consent
      peer.state = consent ? .connected : .disabled
      if lease == .heldBySender, let desired, desired.revision == leaseRevision {
        // Still this Director's, at the revision it wants: the peer is on the event already.
        held = leaseRevision
        peer.ackedRevision = leaseRevision
        if consent { peer.state = .applied(leaseRevision) }
      }
      return nextRequest()
    case let .ack(status, _):
      return acknowledged(status, for: awaited)
    case .discover, .assign, .renew, .release:
      return stop(.invalid)
    }
  }

  // MARK: - Internals

  private mutating func acknowledged(
    _ status: EventControlAckStatus,
    for awaited: Pending
  ) -> EventControlDirectorStep {
    peer.lastStatus = status
    switch status {
    case .applied:
      failures = 0
      if awaited.type == .release {
        held = nil
        peer.state = .released
        return nextRequest()
      }
      held = awaited.revision
      peer.consent = true
      peer.ackedRevision = awaited.revision
      peer.state = .applied(awaited.revision)
      return nextRequest()
    case .disabled:
      held = nil
      peer.consent = false
      peer.state = .disabled
      return EventControlDirectorStep()
    case .busy:
      held = nil
      peer.state = .busy
      return EventControlDirectorStep()
    case .expired, .stale:
      // The receiver no longer has (or has another view of) this Director's lease: assign again.
      held = nil
      if awaited.type == .release {
        peer.state = .released
        return nextRequest()
      }
      return failed() ?? nextRequest(retry: true)
    case .invalid, .failed:
      held = nil
      return failed() ?? EventControlDirectorStep()
    case .wrongAccount:
      return stop(.otherAccount)
    case .unsupported:
      return stop(.unsupported)
    case .keyMismatch:
      return stop(.keyMismatch)
    }
  }

  /// The request the current state calls for, if any.
  private mutating func nextRequest(retry: Bool = false) -> EventControlDirectorStep {
    guard let desired else {
      guard let held else {
        if peer.state != .disabled, peer.state != .released { peer.state = .connected }
        return EventControlDirectorStep()
      }
      return EventControlDirectorStep(send: [ request(.release, revision: held) ])
    }
    if held == desired.revision {
      guard retry else { return EventControlDirectorStep() }
      return EventControlDirectorStep(send: [ request(.renew, revision: desired.revision) ])
    }
    peer.state = .assigning(desired.revision)
    return EventControlDirectorStep(send: [ request(.assign, revision: desired.revision) ])
  }

  private mutating func request(_ type: EventControlMessageType, revision: UInt64) -> Data {
    let requestId = nextRequestId
    nextRequestId += 1
    pending = Pending(requestId: requestId, type: type, revision: revision)
    let body: EventControlBody
    switch type {
    case .assign: body = .assign(desired!.assignment, revision: revision)
    case .renew: body = .renew(revision: revision)
    case .release: body = .release(revision: revision)
    default: body = .discover
    }
    let header = EventControlHeader(
      sender: instanceId,
      requestId: requestId,
      accountTag: credentials.accountTagBytes,
      keyId: credentials.keyIdBytes,
      challenge: challenge,
      receiverNonce: nonce ?? Data()
    )
    return EventControlCodec.encode(EventControlMessage(header: header, body: body), with: credentials)
  }

  /// Counts a failure; at the limit, gives up on this peer until it is found again.
  private mutating func failed() -> EventControlDirectorStep? {
    failures += 1
    guard failures >= maxFailures else { return nil }
    return stop(.failed)
  }

  private mutating func fail() -> EventControlDirectorStep {
    failed() ?? EventControlDirectorStep(close: true)
  }

  private mutating func stop(_ state: EventControlPeerState) -> EventControlDirectorStep {
    pending = nil
    held = nil
    peer.state = state
    return EventControlDirectorStep(close: true)
  }
}
