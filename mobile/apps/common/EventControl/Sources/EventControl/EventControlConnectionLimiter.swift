import Foundation

/// The receiver's connection limits (README.md, "Connection limits"), with no sockets: which
/// connection to admit, which to close to make room, and which have been quiet too long.
///
/// The same rules on every receiver: at most 16 open; one not authenticated within 5 s of being
/// accepted is closed; an authenticated one with no activity for the lease duration (15 s) is
/// closed; at the cap a new connection replaces the oldest that is not authenticated, and is
/// itself closed when every open one is. An authenticated connection is never closed to make room,
/// so idle connections from anywhere on the LAN cannot lock a Director out.
public struct EventControlConnectionLimiter: Sendable, Equatable {
  public struct Limits: Sendable, Equatable {
    public var maxConnections: Int
    /// A connection not authenticated this long after it was accepted is closed.
    public var handshakeTimeout: TimeInterval
    /// An authenticated connection with no activity this long is closed.
    public var idleTimeout: TimeInterval

    public init(
      maxConnections: Int = 16,
      handshakeTimeout: TimeInterval = 5,
      idleTimeout: TimeInterval = EventControlProtocol.leaseDuration
    ) {
      self.maxConnections = maxConnections
      self.handshakeTimeout = handshakeTimeout
      self.idleTimeout = idleTimeout
    }

    public static let standard = Limits()
  }

  /// What to do with a connection just accepted.
  public enum Admission: Sendable, Equatable {
    /// Keep it; close `evicting` first when there is one.
    case admitted(evicting: EventControlConnectionID?)
    /// Every open connection is authenticated: close this one.
    case refused
  }

  private struct Entry: Sendable, Equatable {
    let acceptedAt: TimeInterval
    var authenticated = false
    var lastActivity: TimeInterval
  }

  public let limits: Limits
  private var entries: [EventControlConnectionID: Entry] = [:]

  public init(limits: Limits = .standard) {
    self.limits = limits
  }

  public var openCount: Int { entries.count }

  public func isAuthenticated(_ id: EventControlConnectionID) -> Bool {
    entries[id]?.authenticated ?? false
  }

  /// A connection was accepted at `now`.
  public mutating func admit(_ id: EventControlConnectionID, now: TimeInterval) -> Admission {
    var evicting: EventControlConnectionID?
    if entries.count >= limits.maxConnections {
      guard let oldest = entries
        .filter({ !$0.value.authenticated })
        .min(by: { ($0.value.acceptedAt, $0.key) < ($1.value.acceptedAt, $1.key) })?.key
      else { return .refused }
      entries[oldest] = nil
      evicting = oldest
    }
    entries[id] = Entry(acceptedAt: now, lastActivity: now)
    return .admitted(evicting: evicting)
  }

  /// The receiver accepted a frame on the connection's authenticated session.
  public mutating func authenticated(_ id: EventControlConnectionID, now: TimeInterval) {
    guard entries[id] != nil else { return }
    entries[id]?.authenticated = true
    entries[id]?.lastActivity = now
  }

  /// The connection closed, for whatever reason.
  public mutating func closed(_ id: EventControlConnectionID) {
    entries[id] = nil
  }

  /// The connections past their deadline at `now`, oldest first. They are forgotten here; the
  /// caller closes them.
  public mutating func expired(now: TimeInterval) -> [EventControlConnectionID] {
    let due = entries.filter { _, entry in
      entry.authenticated
        ? now - entry.lastActivity >= limits.idleTimeout
        : now - entry.acceptedAt >= limits.handshakeTimeout
    }
    .sorted { ($0.value.acceptedAt, $0.key) < ($1.value.acceptedAt, $1.key) }
    .map(\.key)
    for id in due { entries[id] = nil }
    return due
  }
}
