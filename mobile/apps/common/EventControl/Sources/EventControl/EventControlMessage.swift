import Foundation

/// The six messages of version 1, by their byte on the wire.
public enum EventControlMessageType: UInt8, Sendable, CaseIterable {
  /// Director → receiver: who are you, with a fresh challenge.
  case discover = 1
  /// Receiver → Director: instance ID, account tag, a fresh receiver nonce, permission and lease.
  case announce = 2
  /// Director → receiver: publish to this event, at this revision.
  case assign = 3
  /// Receiver → Director: what became of a request.
  case ack = 4
  /// Director → receiver: keep my lease.
  case renew = 5
  /// Director → receiver: I let go; keep the event, unlock the picker.
  case release = 6

  /// Whether a Director sends it (otherwise a receiver does).
  public var isFromDirector: Bool {
    switch self {
    case .discover, .assign, .renew, .release: return true
    case .announce, .ack: return false
    }
  }
}

/// What a receiver says became of a request.
public enum EventControlAckStatus: UInt8, Sendable, CaseIterable {
  /// The assignment is configured (or the lease renewed, or released). Not a claim that anything
  /// is being published yet.
  case applied = 0
  /// The receiver's operator has not allowed Director override.
  case disabled = 1
  /// Signed in to another account, or the same account on another server.
  case wrongAccount = 2
  /// Another Director holds the lease.
  case busy = 3
  /// A protocol version this receiver does not speak.
  case unsupported = 4
  /// Malformed content, a bad MAC, or a frame not bound to this connection's session.
  case invalid = 5
  /// A request or revision older than one already seen.
  case stale = 6
  /// No lease to renew or release: it expired, was released, or the receiver restarted.
  case expired = 7
  /// The receiver could not store or apply the assignment.
  case failed = 8
  /// The two keys come from different server secrets; both sides fetch theirs again.
  case keyMismatch = 9
}

/// Who holds a receiver's lease, from the point of view of the Director asking.
public enum EventControlLeaseState: UInt8, Sendable, CaseIterable {
  case free = 0
  case heldBySender = 1
  case heldByOther = 2
}

/// The fields every frame carries, in their wire order.
public struct EventControlHeader: Sendable, Equatable {
  /// The sending end's instance ID.
  public var sender: EventControlInstanceID
  /// A Director's request number on this connection; a receiver echoes the one it answers.
  public var requestId: UInt64
  /// 16 bytes: the sender's account tag.
  public var accountTag: Data
  /// 8 bytes: the sender's key ID.
  public var keyId: Data
  /// 16 bytes: the Director's challenge for this connection's session.
  public var challenge: Data
  /// The receiver's nonce for this session: empty in `discover` and in a reply sent before one
  /// exists, otherwise 16 bytes.
  public var receiverNonce: Data

  public init(
    sender: EventControlInstanceID,
    requestId: UInt64,
    accountTag: Data,
    keyId: Data,
    challenge: Data,
    receiverNonce: Data
  ) {
    self.sender = sender
    self.requestId = requestId
    self.accountTag = accountTag
    self.keyId = keyId
    self.challenge = challenge
    self.receiverNonce = receiverNonce
  }
}

/// The fields particular to each message.
public enum EventControlBody: Sendable, Equatable {
  case discover
  case announce(consent: Bool, lease: EventControlLeaseState, leaseRevision: UInt64)
  /// The assignment's fields exactly as they travel; `EventAssignment(wireGameId:…)` decides
  /// whether they are acceptable.
  case assign(revision: UInt64, gameId: String, title: String, startAt: String)
  case ack(status: EventControlAckStatus, revision: UInt64)
  case renew(revision: UInt64)
  case release(revision: UInt64)

  public var type: EventControlMessageType {
    switch self {
    case .discover: return .discover
    case .announce: return .announce
    case .assign: return .assign
    case .ack: return .ack
    case .renew: return .renew
    case .release: return .release
    }
  }

  /// An assign body for an assignment at a revision.
  public static func assign(_ assignment: EventAssignment, revision: UInt64) -> EventControlBody {
    .assign(
      revision: revision,
      gameId: assignment.gameId,
      title: assignment.title,
      startAt: assignment.startAt
    )
  }
}

/// One message: version 1, its header and its body.
public struct EventControlMessage: Sendable, Equatable {
  public var header: EventControlHeader
  public var body: EventControlBody

  public init(header: EventControlHeader, body: EventControlBody) {
    self.header = header
    self.body = body
  }

  public var type: EventControlMessageType { body.type }
}
