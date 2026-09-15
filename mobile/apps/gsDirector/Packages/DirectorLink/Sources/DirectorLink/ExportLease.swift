import Foundation

/// GS Distributor's hold on GS Director while it exports: while it is held, the Director records
/// and streams nothing. It is granted only when neither is on, renewed by the Mac as it works, and
/// gone when the Mac hands it back or stops renewing it -- so a Mac that crashed, hung or lost its
/// cable never leaves the Director unable to record a game.
public struct ExportLease: Sendable, Equatable {
  /// How long a lease lasts without a renewal. The Mac renews every ten seconds.
  public static let timeout: TimeInterval = 30

  public private(set) var id: UUID?
  private var renewedAt: Date?

  public init() {}

  public var isHeld: Bool { id != nil }

  /// A new lease, replacing any other: one Mac exports at a time.
  public mutating func grant(now: Date = Date()) -> UUID {
    let id = UUID()
    self.id = id
    renewedAt = now
    return id
  }

  /// False when `id` is not the lease held, because it expired or was replaced.
  @discardableResult
  public mutating func renew(_ id: UUID, now: Date = Date()) -> Bool {
    guard self.id == id else { return false }
    renewedAt = now
    return true
  }

  public mutating func release(_ id: UUID) {
    if self.id == id { releaseAll() }
  }

  public mutating func releaseAll() {
    id = nil
    renewedAt = nil
  }

  /// Drops a lease the Mac stopped renewing. True when it did.
  @discardableResult
  public mutating func expire(now: Date = Date()) -> Bool {
    guard id != nil, let renewedAt, now.timeIntervalSince(renewedAt) > Self.timeout else { return false }
    releaseAll()
    return true
  }
}
