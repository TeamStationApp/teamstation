import Foundation

/// Why a connection or a connect failed.
public enum EventControlTransportError: Error, Equatable, Sendable {
  /// The other end closed, or this end did.
  case closed
  /// No connection within the connect timeout.
  case timedOut
  /// The connect failed outright, with the system's words for why.
  case refused(String)
  /// The system is waiting for a path — on iOS, among other things, a denied Local Network
  /// permission. With the system's words for why.
  case waiting(String)
  /// A frame the codec refused before reading it (a declared length over 4096 bytes).
  case frame(EventControlCodecError)
}

/// One framed TCP connection, as both ends see it: whole payloads in and out.
public protocol EventControlConnection: AnyObject, Sendable {
  /// The other end's address as observed on the socket.
  var remoteHost: String { get }
  /// Sends one payload with its length prefix.
  func send(_ payload: Data) async throws
  /// The next whole payload. Throws `EventControlTransportError` when the connection ends or the
  /// other end declares an oversized frame (which closes the connection).
  func receive() async throws -> Data
  /// Closes the connection. Further calls do nothing.
  func close()
}

/// Opens connections to receivers. `EventControlNWConnector` is the real one; tests and previews
/// hand a Director link anything else that conforms.
public protocol EventControlConnector: Sendable {
  func connect(
    to endpoint: EventControlEndpoint,
    timeout: TimeInterval
  ) async throws -> any EventControlConnection
}

/// A connection with no socket under it, one end of a pair, for tests and previews of either side.
public final class EventControlMemoryConnection: EventControlConnection, @unchecked Sendable {
  public let remoteHost: String
  private let lock = NSLock()
  private var inbox: [Data] = []
  private var waiters: [CheckedContinuation<Data, any Error>] = []
  private var isClosed = false
  private weak var other: EventControlMemoryConnection?
  /// Every payload this end sent, oldest first.
  public private(set) var sent: [Data] {
    get { lock.withLock { sentLog } }
    set { lock.withLock { sentLog = newValue } }
  }
  private var sentLog: [Data] = []

  private init(remoteHost: String) {
    self.remoteHost = remoteHost
  }

  /// Two connected ends; each reports the other's host as `remoteHost`.
  public static func pair(
    hostA: String = "192.0.2.1",
    hostB: String = "192.0.2.2"
  ) -> (EventControlMemoryConnection, EventControlMemoryConnection) {
    let a = EventControlMemoryConnection(remoteHost: hostB)
    let b = EventControlMemoryConnection(remoteHost: hostA)
    a.other = b
    b.other = a
    return (a, b)
  }

  public func send(_ payload: Data) async throws {
    let target: EventControlMemoryConnection? = lock.withLock {
      isClosed ? nil : other
    }
    guard let target else { throw EventControlTransportError.closed }
    lock.withLock { sentLog.append(payload) }
    target.deliver(payload)
  }

  public func receive() async throws -> Data {
    try await withCheckedThrowingContinuation { continuation in
      lock.lock()
      if !inbox.isEmpty {
        let payload = inbox.removeFirst()
        lock.unlock()
        continuation.resume(returning: payload)
      } else if isClosed {
        lock.unlock()
        continuation.resume(throwing: EventControlTransportError.closed)
      } else {
        waiters.append(continuation)
        lock.unlock()
      }
    }
  }

  public func close() {
    let peer = shut()
    peer?.shut()
  }

  @discardableResult
  private func shut() -> EventControlMemoryConnection? {
    lock.lock()
    guard !isClosed else {
      lock.unlock()
      return nil
    }
    isClosed = true
    let pending = waiters
    waiters = []
    let peer = other
    lock.unlock()
    for waiter in pending { waiter.resume(throwing: EventControlTransportError.closed) }
    return peer
  }

  private func deliver(_ payload: Data) {
    lock.lock()
    if let waiter = waiters.first {
      waiters.removeFirst()
      lock.unlock()
      waiter.resume(returning: payload)
    } else {
      inbox.append(payload)
      lock.unlock()
    }
  }
}

/// A connector over in-memory pairs: each connect hands the far end to `accept`, which serves it
/// as a receiver would. For tests and previews of a Director link without a network.
public struct EventControlMemoryConnector: EventControlConnector {
  private let accept: @Sendable (EventControlEndpoint, EventControlMemoryConnection) async throws -> Void

  /// `accept` may throw to refuse the connect (`EventControlTransportError.refused`, say).
  public init(
    accept: @escaping @Sendable (EventControlEndpoint, EventControlMemoryConnection) async throws -> Void
  ) {
    self.accept = accept
  }

  public func connect(
    to endpoint: EventControlEndpoint,
    timeout: TimeInterval
  ) async throws -> any EventControlConnection {
    let (near, far) = EventControlMemoryConnection.pair(hostA: "192.0.2.1", hostB: endpoint.host)
    try await accept(endpoint, far)
    return near
  }
}
