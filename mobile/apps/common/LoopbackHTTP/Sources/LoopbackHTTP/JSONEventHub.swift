import Foundation

/// Something an `HTTPResponse.events` stream follows: it hands each subscriber one line of
/// newline-delimited JSON per event, without the newline.
public protocol EventSource: AnyObject, Sendable {
  func subscribe(_ send: @escaping @Sendable (Data) -> Void) -> UUID
  func unsubscribe(_ id: UUID)
}

/// Fans events out to every open event stream, each encoded as one line of JSON.
public final class JSONEventHub<Event: Encodable & Sendable>: EventSource, @unchecked Sendable {
  private let lock = NSLock()
  private var subscribers: [UUID: @Sendable (Data) -> Void] = [:]

  public init() {}

  public func publish(_ event: Event) {
    guard let line = try? JSONEncoder().encode(event) else { return }
    let targets = lock.withLock { Array(subscribers.values) }
    for target in targets {
      target(line)
    }
  }

  public var subscriberCount: Int { lock.withLock { subscribers.count } }

  public func subscribe(_ send: @escaping @Sendable (Data) -> Void) -> UUID {
    let id = UUID()
    lock.withLock { subscribers[id] = send }
    return id
  }

  public func unsubscribe(_ id: UUID) {
    _ = lock.withLock { subscribers.removeValue(forKey: id) }
  }
}
