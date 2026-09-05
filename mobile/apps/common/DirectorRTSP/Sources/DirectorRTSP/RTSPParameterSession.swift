import Foundation
import Network
import os

/// A control-only RTSP connection: `OPTIONS`, then `GET_PARAMETER` / `SET_PARAMETER` bodies, never
/// `SETUP` or `PLAY`.
///
/// Separate from the media session on purpose. A burst of zoom writes on the media socket would
/// queue behind RTP and the reconnect logic inside `RTSPFrameSource` would have to learn about
/// requests it never made. This knows nothing about camera names; it moves `text/parameters`
/// bodies and matches replies to requests by CSeq.
///
/// Reconnects on the same 1-2-4-8 s ladder the media session uses, and holds at 8 s so a phone
/// that has gone away does not fill the log.
public final class RTSPParameterSession: ParameterTransport, @unchecked Sendable {
  public struct Configuration: Sendable {
    public var host: String
    public var port: Int
    public var path: String
    public var userAgent: String
    /// How long one request may wait for its reply.
    public var requestTimeout: Duration

    public init(
      host: String,
      port: Int = 554,
      path: String = "/live/mainstream",
      userAgent: String = "GS Director/1.0",
      requestTimeout: Duration = .seconds(3)
    ) {
      self.host = host
      self.port = port
      self.path = path
      self.userAgent = userAgent
      self.requestTimeout = requestTimeout
    }

    public var url: String { "rtsp://\(host):\(port)\(path)" }
  }

  private static let backoffSeconds: [TimeInterval] = [ 1, 2, 4, 8 ]
  public static let parametersContentType = "text/parameters"

  public let configuration: Configuration

  private let queue: DispatchQueue
  private let lock = NSLock()
  private var connection: NWConnection?
  private var parser = RTSPStreamParser()
  private var builder: RTSPRequestBuilder
  private var pending: [Int: @Sendable (Result<RTSPResponse, Error>) -> Void] = [:]
  private var stateValue: ParameterTransportState = .idle
  private var isStopped = true
  private var attempt = 0
  private var reconnectItem: DispatchWorkItem?

  public init(configuration: Configuration) {
    self.configuration = configuration
    builder = RTSPRequestBuilder(userAgent: configuration.userAgent)
    queue = DispatchQueue(label: "co.gamestation.director.rtsp.params.\(configuration.host)")
  }

  public convenience init(host: String, port: Int, path: String = "/live/mainstream", userAgent: String = "GS Director/1.0") {
    self.init(configuration: Configuration(host: host, port: port, path: path, userAgent: userAgent))
  }

  public var state: ParameterTransportState {
    lock.lock()
    defer { lock.unlock() }
    return stateValue
  }

  // MARK: - Lifecycle

  public func start() {
    lock.lock()
    guard isStopped else {
      lock.unlock()
      return
    }
    isStopped = false
    attempt = 0
    lock.unlock()
    connect()
  }

  public func stop() {
    lock.lock()
    isStopped = true
    let connection = self.connection
    self.connection = nil
    reconnectItem?.cancel()
    reconnectItem = nil
    let waiting = pending.values
    pending.removeAll()
    stateValue = .idle
    lock.unlock()
    connection?.cancel()
    for handler in waiting { handler(.failure(Failure.stopped)) }
  }

  private func connect() {
    guard let port = NWEndpoint.Port(rawValue: UInt16(clamping: configuration.port)) else {
      setState(.failed("invalid port \(configuration.port)"))
      return
    }
    let parameters = NWParameters.tcp
    parameters.includePeerToPeer = true
    if let options = parameters.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options {
      options.noDelay = true
      options.connectionTimeout = 8
    }
    let connection = NWConnection(host: NWEndpoint.Host(configuration.host), port: port, using: parameters)

    lock.lock()
    self.connection = connection
    parser = RTSPStreamParser()
    stateValue = .connecting
    lock.unlock()

    connection.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready:
        receiveNext(on: connection)
        probeOptions()
      case let .failed(error):
        dropConnection(reason: "connection failed: \(error.localizedDescription)")
      default:
        break
      }
    }
    connection.start(queue: queue)
  }

  /// `OPTIONS` tells us whether this build answers `SET_PARAMETER` at all.
  private func probeOptions() {
    send(.options, body: nil) { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(let response) where response.isSuccess:
        let methods = response.header("public") ?? ""
        lock.lock()
        attempt = 0
        lock.unlock()
        setState(methods.contains("SET_PARAMETER") ? .ready : .unsupported)
      case .success(let response):
        dropConnection(reason: "OPTIONS failed: \(response.statusCode) \(response.reasonPhrase)")
      case .failure(let error):
        dropConnection(reason: "OPTIONS failed: \(error)")
      }
    }
  }

  private func dropConnection(reason: String) {
    lock.lock()
    let connection = self.connection
    self.connection = nil
    let waiting = pending.values
    pending.removeAll()
    let stopped = isStopped
    if !stopped {
      stateValue = .failed(reason)
      attempt += 1
    }
    let delay = Self.backoffSeconds[min(max(attempt - 1, 0), Self.backoffSeconds.count - 1)]
    lock.unlock()
    connection?.cancel()
    for handler in waiting { handler(.failure(Failure.disconnected(reason))) }
    guard !stopped else { return }

    let item = DispatchWorkItem { [weak self] in
      guard let self else { return }
      lock.lock()
      reconnectItem = nil
      let stopped = isStopped
      lock.unlock()
      if !stopped { connect() }
    }
    lock.lock()
    reconnectItem?.cancel()
    reconnectItem = item
    lock.unlock()
    queue.asyncAfter(deadline: .now() + delay, execute: item)
  }

  private func setState(_ state: ParameterTransportState) {
    lock.lock()
    stateValue = state
    lock.unlock()
  }

  // MARK: - Requests

  public func get(_ body: String) async throws -> ParameterReply {
    try await request(.getParameter, body: body)
  }

  public func set(_ body: String) async throws -> ParameterReply {
    try await request(.setParameter, body: body)
  }

  private func request(_ method: RTSPMethod, body: String) async throws -> ParameterReply {
    let timeout = configuration.requestTimeout
    let response: RTSPResponse = try await withThrowingTaskGroup(of: RTSPResponse.self) { group in
      group.addTask { [self] in
        try await withCheckedThrowingContinuation { continuation in
          send(method, body: body) { result in continuation.resume(with: result) }
        }
      }
      group.addTask {
        try await Task.sleep(for: timeout)
        throw Failure.timedOut
      }
      guard let first = try await group.next() else { throw Failure.stopped }
      group.cancelAll()
      return first
    }
    return ParameterReply(statusCode: response.statusCode, reasonPhrase: response.reasonPhrase, body: response.bodyText)
  }

  private func send(
    _ method: RTSPMethod,
    body: String?,
    completion: @escaping @Sendable (Result<RTSPResponse, Error>) -> Void
  ) {
    lock.lock()
    guard !isStopped, let connection else {
      let reason = stateValue
      lock.unlock()
      completion(.failure(Failure.notConnected(reason)))
      return
    }
    var headers: [(name: String, value: String)] = []
    if body != nil {
      headers.append((name: "Content-Type", value: Self.parametersContentType))
    }
    let request = builder.make(method, uri: configuration.url, headers: headers, body: body.map { Data($0.utf8) })
    pending[request.cseq] = completion
    lock.unlock()

    connection.send(content: request.wireFormat, completion: .contentProcessed { [weak self] error in
      guard let error, let self else { return }
      dropConnection(reason: "send failed: \(error.localizedDescription)")
    })
  }

  private func receiveNext(on connection: NWConnection) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, isComplete, error in
      guard let self else { return }
      if let data, !data.isEmpty { handle(received: data) }
      if let error {
        dropConnection(reason: "receive failed: \(error.localizedDescription)")
        return
      }
      if isComplete {
        dropConnection(reason: "camera closed the connection")
        return
      }
      lock.lock()
      let current = self.connection
      lock.unlock()
      guard current === connection else { return }
      receiveNext(on: connection)
    }
  }

  private func handle(received data: Data) {
    lock.lock()
    parser.append(data)
    var responses: [RTSPResponse] = []
    while let item = parser.next() {
      if case let .response(response) = item { responses.append(response) }
    }
    let handlers = responses.map { response in
      (response, response.cseq.flatMap { pending.removeValue(forKey: $0) })
    }
    lock.unlock()
    for (response, handler) in handlers { handler?(.success(response)) }
  }

  public enum Failure: Error, Sendable, Equatable {
    case notConnected(ParameterTransportState)
    case disconnected(String)
    case timedOut
    case stopped
  }
}
