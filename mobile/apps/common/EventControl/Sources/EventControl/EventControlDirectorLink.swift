import Foundation

/// How patient a Director link is.
public struct EventControlDirectorTiming: Sendable, Equatable {
  /// A connect not finished by then has failed.
  public var connectTimeout: TimeInterval
  /// A request not answered by then has failed, and the connection is remade.
  public var replyTimeout: TimeInterval
  /// How often a held lease is renewed, and a refused assignment asked again.
  public var renewInterval: TimeInterval
  /// The waits before each reconnect after a lost connection or a failed connect. When they are
  /// used up the peer is `unreachable` and the link ends, until the next sweep or known-peer probe.
  public var reconnectDelays: [TimeInterval]
  /// Failed attempts in a row before the peer is `failed` and the link ends.
  public var maxFailures: Int

  public init(
    connectTimeout: TimeInterval = 2,
    replyTimeout: TimeInterval = 3,
    renewInterval: TimeInterval = EventControlProtocol.renewInterval,
    reconnectDelays: [TimeInterval] = [ 1, 2, 4 ],
    maxFailures: Int = 3
  ) {
    self.connectTimeout = connectTimeout
    self.replyTimeout = replyTimeout
    self.renewInterval = renewInterval
    self.reconnectDelays = reconnectDelays
    self.maxFailures = maxFailures
  }

  public static let standard = EventControlDirectorTiming()
}

/// A Director's conversation with one receiver at `ip:port`: discover, assign, renew every five
/// seconds, release — over one TCP connection, remade without waiting for a sweep when it drops.
///
/// Give it the Director's key, its instance ID and the desired assignment; change the assignment
/// with `setDesired` (nil releases); end it with `stop`. Each change in what is known about the
/// peer is reported through `onUpdate` and kept in `peer`. The link ends on its own when the peer
/// turns out to be another account, the keys disagree (fetch the key again, then make a new link),
/// the peer speaks another version, three attempts fail, or the peer cannot be reached.
public actor EventControlDirectorLink {
  public nonisolated let endpoint: EventControlEndpoint
  public nonisolated let instanceId: EventControlInstanceID
  private let credentials: EventControlCredentials
  private let connector: any EventControlConnector
  private let timing: EventControlDirectorTiming
  private let onUpdate: @Sendable (EventControlPeer) -> Void

  public private(set) var peer: EventControlPeer
  private var desired: EventControlDesired?
  private var task: Task<Void, Never>?
  private var inbox: AsyncStream<Input>.Continuation?
  private var stopping = false

  enum Input: Sendable {
    case frame(Data)
    case dropped
    case tick
    case desired
    case replyTimeout(UInt64)
    case stop(release: Bool)
  }

  private enum Outcome {
    /// The link is done.
    case finished
    /// The connection went; make it again.
    case dropped(wasBound: Bool)
  }

  public init(
    endpoint: EventControlEndpoint,
    instanceId: EventControlInstanceID,
    credentials: EventControlCredentials,
    desired: EventControlDesired?,
    connector: any EventControlConnector = EventControlNWConnector(),
    timing: EventControlDirectorTiming = .standard,
    onUpdate: @escaping @Sendable (EventControlPeer) -> Void = { _ in }
  ) {
    self.endpoint = endpoint
    self.instanceId = instanceId
    self.credentials = credentials
    self.desired = desired
    self.connector = connector
    self.timing = timing
    self.onUpdate = onUpdate
    peer = EventControlPeer(endpoint: endpoint)
  }

  /// Whether the link is still working (connecting, connected, or waiting to reconnect).
  public var isRunning: Bool { task != nil }

  /// Starts the conversation. Does nothing if it is already running.
  public func start() {
    guard task == nil, !stopping else { return }
    task = Task { await self.run() }
  }

  /// Points the peer at a new assignment, or releases it with nil.
  public func setDesired(_ next: EventControlDesired?) {
    desired = next
    inbox?.yield(.desired)
  }

  /// Ends the link, releasing a held lease first when `release` is true (best effort: a lost
  /// release is resolved by the receiver's lease expiry). Returns when the link has ended.
  public func stop(release: Bool = true) async {
    stopping = true
    if let inbox {
      inbox.yield(.stop(release: release))
    } else {
      task?.cancel()
    }
    await task?.value
  }

  // MARK: - The loop

  private func run() async {
    var attempt = 0
    while !stopping, !Task.isCancelled {
      report { $0.state = .connecting }
      let connection: any EventControlConnection
      do {
        connection = try await connector.connect(to: endpoint, timeout: timing.connectTimeout)
      } catch {
        guard await waitToReconnect(&attempt) else { break }
        continue
      }
      let outcome = await converse(over: connection)
      connection.close()
      guard case let .dropped(wasBound) = outcome, !stopping else { break }
      if wasBound { attempt = 0 }
      guard await waitToReconnect(&attempt) else { break }
    }
    if !stopping, peer.state == .connecting || peer.state == .discovering {
      report { $0.state = .unreachable }
    }
    task = nil
  }

  /// Waits before the next attempt; false when the attempts are used up or the link is stopping.
  private func waitToReconnect(_ attempt: inout Int) async -> Bool {
    guard attempt < timing.reconnectDelays.count, !stopping else {
      if !stopping { report { $0.state = .unreachable } }
      return false
    }
    let delay = timing.reconnectDelays[attempt]
    attempt += 1
    do {
      try await Task.sleep(for: .seconds(delay))
    } catch {
      return false
    }
    return !stopping
  }

  private func converse(over connection: any EventControlConnection) async -> Outcome {
    var session = EventControlDirectorSession(
      endpoint: endpoint,
      instanceId: instanceId,
      credentials: credentials,
      desired: desired,
      maxFailures: timing.maxFailures
    )
    session.restore(from: peer)
    let (stream, continuation) = AsyncStream.makeStream(of: Input.self)
    inbox = continuation
    let reader = Task {
      while true {
        do {
          continuation.yield(.frame(try await connection.receive()))
        } catch {
          continuation.yield(.dropped)
          return
        }
      }
    }
    let renew = timing.renewInterval
    let ticker = Task {
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(renew))
        continuation.yield(.tick)
      }
    }
    defer {
      reader.cancel()
      ticker.cancel()
      continuation.finish()
      inbox = nil
    }

    var finishing = false
    guard await perform(session.begin(), &session, connection, continuation) else {
      return .dropped(wasBound: false)
    }
    for await input in stream {
      let step: EventControlDirectorStep
      switch input {
      case let .frame(payload):
        step = session.receive(payload)
        if finishing { return .finished }
      case .dropped:
        return finishing ? .finished : .dropped(wasBound: session.isBound)
      case .tick:
        step = session.tick()
      case .desired:
        step = session.setDesired(desired)
      case let .replyTimeout(requestId):
        guard session.awaitingRequestId == requestId else { continue }
        if finishing { return .finished }
        step = session.replyTimedOut()
      case let .stop(release):
        step = session.finish(release: release)
        finishing = true
      }
      report { $0 = session.peer }
      guard await perform(step, &session, connection, continuation) else {
        return finishing ? .finished : .dropped(wasBound: session.isBound)
      }
      if finishing, step.send.isEmpty { return .finished }
      if step.close, !finishing { return endOrReconnect(session) }
    }
    return .finished
  }

  /// Sends a step's payloads and arms the reply timeout; false if the connection failed.
  private func perform(
    _ step: EventControlDirectorStep,
    _ session: inout EventControlDirectorSession,
    _ connection: any EventControlConnection,
    _ continuation: AsyncStream<Input>.Continuation
  ) async -> Bool {
    report { $0 = session.peer }
    for payload in step.send {
      do {
        try await connection.send(payload)
      } catch {
        return false
      }
    }
    if !step.send.isEmpty, let requestId = session.awaitingRequestId {
      let wait = timing.replyTimeout
      Task {
        try? await Task.sleep(for: .seconds(wait))
        continuation.yield(.replyTimeout(requestId))
      }
    }
    return true
  }

  /// After the session closed the connection: a reply that never came is worth another
  /// connection; anything the peer said about itself is not.
  private func endOrReconnect(_ session: EventControlDirectorSession) -> Outcome {
    switch session.peer.state {
    case .otherAccount, .keyMismatch, .unsupported, .invalid, .failed, .released:
      return .finished
    default:
      return .dropped(wasBound: false)
    }
  }

  private func report(_ change: (inout EventControlPeer) -> Void) {
    var next = peer
    change(&next)
    guard next != peer else { return }
    peer = next
    onUpdate(next)
  }
}
