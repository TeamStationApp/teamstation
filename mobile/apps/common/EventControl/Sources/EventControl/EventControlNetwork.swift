import Foundation
import Network

/// A framed connection over Network.framework TCP: a four-byte big-endian length, then the
/// payload. A declared length over 4096 bytes closes the connection before any of it is read.
public final class EventControlNWConnection: EventControlConnection, @unchecked Sendable {
  public let remoteHost: String
  let connection: NWConnection

  /// Wraps a connection that is already started, or ready.
  init(connection: NWConnection) {
    self.connection = connection
    remoteHost = Self.host(of: connection.endpoint)
  }

  public func send(_ payload: Data) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
      connection.send(
        content: EventControlCodec.frame(payload),
        completion: .contentProcessed { error in
          if error == nil {
            continuation.resume()
          } else {
            continuation.resume(throwing: EventControlTransportError.closed)
          }
        }
      )
    }
  }

  public func receive() async throws -> Data {
    let prefix = try await read(4)
    let length: Int
    do {
      length = try EventControlFrameReader.payloadLength(prefix)
    } catch {
      close()
      throw EventControlTransportError.frame(error)
    }
    return try await read(length)
  }

  public func close() {
    connection.cancel()
  }

  private func read(_ count: Int) async throws -> Data {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, any Error>) in
      connection.receive(minimumIncompleteLength: count, maximumLength: count) { data, _, _, error in
        if error == nil, let data, data.count == count {
          continuation.resume(returning: data)
        } else {
          continuation.resume(throwing: EventControlTransportError.closed)
        }
      }
    }
  }

  /// An endpoint's host as people write it: `192.0.2.10`, not `::ffff:192.0.2.10`, and without an
  /// interface scope.
  static func host(of endpoint: NWEndpoint) -> String {
    guard case let .hostPort(host, _) = endpoint else { return "\(endpoint)" }
    return describe(host)
  }

  static func describe(_ host: NWEndpoint.Host) -> String {
    switch host {
    case let .ipv4(address):
      return "\(address)".components(separatedBy: "%")[0]
    case let .ipv6(address):
      let text = "\(address)".components(separatedBy: "%")[0]
      if text.lowercased().hasPrefix("::ffff:"), IPv4Address(String(text.dropFirst(7))) != nil {
        return String(text.dropFirst(7))
      }
      return text
    case let .name(name, _):
      return name
    @unknown default:
      return "\(host)"
    }
  }
}

/// Opens TCP connections to receivers with Network.framework.
public struct EventControlNWConnector: EventControlConnector {
  public init() {}

  public func connect(
    to endpoint: EventControlEndpoint,
    timeout: TimeInterval
  ) async throws -> any EventControlConnection {
    let options = NWProtocolTCP.Options()
    options.noDelay = true
    options.connectionTimeout = max(1, Int(timeout.rounded(.up)))
    let connection = NWConnection(
      host: NWEndpoint.Host(endpoint.host),
      port: NWEndpoint.Port(rawValue: endpoint.port)!,
      using: NWParameters(tls: nil, tcp: options)
    )
    let queue = DispatchQueue(label: "app.teamstation.eventcontrol.connection")
    let once = Once()
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
      let finish: @Sendable (EventControlTransportError?) -> Void = { error in
        guard once.claim() else { return }
        if let error {
          connection.stateUpdateHandler = nil
          connection.cancel()
          continuation.resume(throwing: error)
        } else {
          continuation.resume()
        }
      }
      connection.stateUpdateHandler = { state in
        switch state {
        case .ready: finish(nil)
        case let .waiting(error): finish(.waiting("\(error)"))
        case let .failed(error): finish(.refused("\(error)"))
        case .cancelled: finish(.closed)
        default: break
        }
      }
      connection.start(queue: queue)
      queue.asyncAfter(deadline: .now() + timeout) { finish(.timedOut) }
    }
    return EventControlNWConnection(connection: connection)
  }
}

/// A flag that can be claimed once, from any thread.
final class Once: @unchecked Sendable {
  private let lock = NSLock()
  private var claimed = false

  func claim() -> Bool {
    lock.withLock {
      defer { claimed = true }
      return !claimed
    }
  }
}

/// A receiver's TCP listener: the first of 47614 and 47615 it can bind, every connection served by
/// one `EventControlReceiver`.
///
/// iOS takes listeners down when an app leaves the foreground. A listener that fails or is
/// cancelled while it is still the current one is rebuilt after `rebindDelay` with the same port
/// preference; the receiver restarts with it, so any lease is gone, as after a relaunch. The app
/// also calls `ensureListening()` when it returns to the foreground.
///
/// Connections are held to `EventControlConnectionLimiter`'s rules (README.md, "Connection
/// limits"): at most 16, 5 s to authenticate, 15 s of quiet once authenticated, and at the cap the
/// oldest unauthenticated one makes room.
public final class EventControlListener: @unchecked Sendable {
  public enum State: Sendable, Equatable {
    case stopped
    case binding
    case listening(port: UInt16)
    /// Every port is taken by something else. Shown in the receiver's status.
    case portsUnavailable([UInt16])
  }

  public let receiver: EventControlReceiver
  public let ports: [UInt16]
  private let rebindDelay: TimeInterval
  private let reapInterval: TimeInterval
  private let now: @Sendable () -> TimeInterval
  private let onStateChange: @Sendable (State) -> Void
  private let queue = DispatchQueue(label: "app.teamstation.eventcontrol.listener")

  private let lock = NSLock()
  private var currentState: State = .stopped
  // Confined to `queue`.
  private var listener: NWListener?
  private var wanted = false
  private var connections: [EventControlConnectionID: EventControlNWConnection] = [:]
  private var nextConnection: EventControlConnectionID = 1
  private var limiter: EventControlConnectionLimiter
  private var reapScheduled = false

  /// `limits`, `reapInterval` (how often deadlines are checked) and `now` (monotonic seconds) are
  /// for tests; the defaults are the protocol's.
  public init(
    receiver: EventControlReceiver,
    ports: [UInt16] = EventControlProtocol.ports,
    rebindDelay: TimeInterval = 0.5,
    limits: EventControlConnectionLimiter.Limits = .standard,
    reapInterval: TimeInterval = 0.5,
    now: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
    onStateChange: @escaping @Sendable (State) -> Void = { _ in }
  ) {
    self.receiver = receiver
    self.ports = ports
    self.rebindDelay = rebindDelay
    self.reapInterval = reapInterval
    self.now = now
    limiter = EventControlConnectionLimiter(limits: limits)
    self.onStateChange = onStateChange
  }

  public var state: State { lock.withLock { currentState } }

  /// How many connections are open now.
  public var connectionCount: Int { queue.sync { connections.count } }

  /// Starts listening. Calling it again while listening does nothing.
  public func start() {
    queue.async {
      self.wanted = true
      if self.listener == nil { self.bind(0) }
    }
  }

  /// Listens again if the system took the listener away (iOS does when the app leaves the
  /// foreground); otherwise does nothing.
  public func ensureListening() {
    start()
  }

  /// Stops listening, closes every connection and ends any lease.
  public func stop() {
    queue.sync {
      wanted = false
      let old = listener
      listener = nil
      old?.cancel()
      for connection in connections.values { connection.close() }
      connections = [:]
      limiter = EventControlConnectionLimiter(limits: limiter.limits)
      setState(.stopped)
    }
    let receiver = receiver
    Task { await receiver.restart() }
  }

  /// Cancels the listener as the system would, leaving it current. For tests of the rebind.
  func cancelAsTheSystemWould() {
    queue.sync { listener?.cancel() }
  }

  private func setState(_ next: State) {
    let changed = lock.withLock {
      defer { currentState = next }
      return currentState != next
    }
    if changed { onStateChange(next) }
  }

  private func bind(_ index: Int) {
    guard wanted else { return }
    guard index < ports.count else {
      setState(.portsUnavailable(ports))
      return
    }
    setState(.binding)
    let made: NWListener
    do {
      made = try NWListener(using: .tcp, on: NWEndpoint.Port(rawValue: ports[index])!)
    } catch {
      bind(index + 1)
      return
    }
    listener = made
    made.stateUpdateHandler = { [weak self, weak made] state in
      guard let self, let made, made === self.listener else { return }
      self.listenerChanged(made, state, index)
    }
    made.newConnectionHandler = { [weak self] connection in
      self?.accept(connection)
    }
    made.start(queue: queue)
  }

  private func listenerChanged(_ made: NWListener, _ state: NWListener.State, _ index: Int) {
    switch state {
    case .ready:
      setState(.listening(port: made.port?.rawValue ?? ports[index]))
    case .failed:
      let wasListening = self.state == .listening(port: made.port?.rawValue ?? ports[index])
      listener = nil
      made.cancel()
      if wasListening {
        rebindLater()
      } else {
        // That port is somebody else's; try the next.
        bind(index + 1)
      }
    case .cancelled:
      listener = nil
      rebindLater()
    default:
      break
    }
  }

  private func rebindLater() {
    setState(.binding)
    let receiver = receiver
    Task { await receiver.restart() }
    queue.asyncAfter(deadline: .now() + rebindDelay) { [weak self] in
      guard let self, self.listener == nil else { return }
      self.bind(0)
    }
  }

  private func accept(_ connection: NWConnection) {
    let id = nextConnection
    nextConnection += 1
    switch limiter.admit(id, now: now()) {
    case .refused:
      // Sixteen authenticated Directors already: this one is not let in.
      connection.cancel()
      return
    case let .admitted(evicting):
      if let evicting {
        connections[evicting]?.close()
        connections[evicting] = nil
      }
    }
    let wrapped = EventControlNWConnection(connection: connection)
    connections[id] = wrapped
    connection.start(queue: queue)
    scheduleReap()
    let receiver = receiver
    Task { [weak self] in
      await receiver.serve(wrapped, id: id) { [weak self] in
        guard let self else { return }
        let at = self.now()
        self.queue.async { self.limiter.authenticated(id, now: at) }
      }
      guard let self else { return }
      self.queue.async {
        self.connections[id] = nil
        self.limiter.closed(id)
      }
    }
  }

  /// Checks deadlines every `reapInterval` while any connection is open.
  private func scheduleReap() {
    guard !reapScheduled else { return }
    reapScheduled = true
    queue.asyncAfter(deadline: .now() + reapInterval) { [weak self] in
      guard let self else { return }
      self.reapScheduled = false
      self.reap()
      if !self.connections.isEmpty { self.scheduleReap() }
    }
  }

  /// Closes every connection past its handshake or idle deadline.
  private func reap() {
    for id in limiter.expired(now: now()) {
      connections[id]?.close()
      connections[id] = nil
    }
  }
}
