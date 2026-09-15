import DistributorWire
import Foundation

/// Fans events out to every open `/v1/events` stream.
public final class EventHub: @unchecked Sendable {
  private let lock = NSLock()
  private var subscribers: [UUID: @Sendable (DistributorEvent) -> Void] = [:]

  public init() {}

  public func publish(_ event: DistributorEvent) {
    let targets = lock.withLock { Array(subscribers.values) }
    for target in targets {
      target(event)
    }
  }

  public var subscriberCount: Int { lock.withLock { subscribers.count } }

  func subscribe(_ handler: @escaping @Sendable (DistributorEvent) -> Void) -> UUID {
    let id = UUID()
    lock.withLock { subscribers[id] = handler }
    return id
  }

  func unsubscribe(_ id: UUID) {
    _ = lock.withLock { subscribers.removeValue(forKey: id) }
  }
}
