import DistributorWire
import Foundation
import Network

/// A small HTTP/1.1 server bound to loopback.
///
/// GS Distributor reaches it through usbmuxd, which hands the iPad's side of the cable to
/// 127.0.0.1, so nothing on the Wi-Fi can connect. Connections stay open between requests.
/// Files go out one chunk at a time, each sent only once the previous one has been handed to the
/// network, so serving a 2 GB file costs one chunk of memory rather than two gigabytes.
public final class LinkServer: @unchecked Sendable {
  public typealias Handler = @Sendable (HTTPRequest) async -> HTTPResponse

  public static let fileChunkBytes = 4 << 20

  let queue = DispatchQueue(label: "co.gamestation.director.link")
  let handler: Handler
  private let requestedPort: UInt16

  // Touched only on `queue`.
  private var listener: NWListener?
  private var connections: [ObjectIdentifier: LinkConnection] = [:]

  private let statsLock = NSLock()
  private var inFlightPeak = 0

  public init(port: UInt16 = DistributorProtocol.port, handler: @escaping Handler) {
    self.requestedPort = port
    self.handler = handler
  }

  /// The most file bytes any connection has had handed to the network and not yet processed.
  public var maximumBytesInFlight: Int { statsLock.withLock { inFlightPeak } }

  func noteInFlight(_ bytes: Int) {
    statsLock.withLock { inFlightPeak = max(inFlightPeak, bytes) }
  }

  /// Starts listening and returns the port, which is the one asked for unless that was 0.
  @discardableResult
  public func start() async throws -> UInt16 {
    let parameters = NWParameters.tcp
    parameters.allowLocalEndpointReuse = true
    let port = requestedPort == 0 ? NWEndpoint.Port.any : NWEndpoint.Port(rawValue: requestedPort) ?? .any
    parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: port)
    let listener = try NWListener(using: parameters)
    let box = ListenerBox(listener)
    queue.sync { self.listener = listener }

    return try await withCheckedThrowingContinuation { continuation in
      let once = Once()
      listener.stateUpdateHandler = { [weak self] state in
        switch state {
        case .ready:
          once.run { continuation.resume(returning: box.listener.port?.rawValue ?? 0) }
        case .failed(let error):
          once.run { continuation.resume(throwing: error) }
          self?.stop()
        case .cancelled:
          once.run { continuation.resume(throwing: CancellationError()) }
        default:
          break
        }
      }
      listener.newConnectionHandler = { [weak self] connection in
        self?.accept(connection)
      }
      listener.start(queue: queue)
    }
  }

  /// Closes the listener and every connection. GS Director calls this on the way into the
  /// background, where iOS would otherwise leave a listener that accepts and never answers.
  public func stop() {
    queue.async { [self] in
      listener?.cancel()
      listener = nil
      let open = Array(connections.values)
      connections.removeAll()
      for connection in open {
        connection.close()
      }
    }
  }

  private func accept(_ connection: NWConnection) {
    let link = LinkConnection(connection, server: self)
    connections[ObjectIdentifier(link)] = link
    link.start()
  }

  func finished(_ link: LinkConnection) {
    connections.removeValue(forKey: ObjectIdentifier(link))
  }
}

/// One client connection. Everything here runs on the server's queue.
final class LinkConnection: @unchecked Sendable {
  private let connection: NWConnection
  private let server: LinkServer
  private var buffer = Data()
  private var responding = false
  private var peerDone = false
  private var closed = false
  private var inFlight = 0
  private var subscription: (hub: EventHub, id: UUID)?

  init(_ connection: NWConnection, server: LinkServer) {
    self.connection = connection
    self.server = server
  }

  func start() {
    connection.stateUpdateHandler = { [weak self] state in
      switch state {
      case .failed, .cancelled: self?.close()
      default: break
      }
    }
    connection.start(queue: server.queue)
    receive()
  }

  private func receive() {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] data, _, isComplete, error in
      guard let self, !closed else { return }
      if let data, !data.isEmpty { buffer.append(data) }
      if error != nil {
        close()
        return
      }
      nextRequest()
      if isComplete {
        peerDone = true
        if !responding { close() }
        return
      }
      receive()
    }
  }

  private func nextRequest() {
    guard !responding, !closed else { return }
    let parsed: (request: HTTPRequest, consumed: Int)?
    do {
      parsed = try HTTPParser.parse(buffer)
    } catch {
      responding = true
      let status = error == .bodyTooLarge ? 413 : 400
      respond(.error(status, "bad request"), to: HTTPRequest(method: "GET", path: "/"), keepAlive: false)
      return
    }
    guard let parsed else { return }
    buffer = Data(buffer.dropFirst(parsed.consumed))
    responding = true
    let request = parsed.request
    let handler = server.handler
    Task { [weak self] in
      let response = await handler(request)
      guard let self else { return }
      server.queue.async {
        self.respond(response, to: request, keepAlive: !request.wantsClose)
      }
    }
  }

  private func respond(_ response: HTTPResponse, to request: HTTPRequest, keepAlive: Bool) {
    guard !closed else { return }
    switch response {
    case let .data(status, contentType, body):
      var head = HTTPHead(status: status)
      head.set("Content-Type", contentType)
      head.set("Content-Length", "\(body.count)")
      head.set("Connection", keepAlive ? "keep-alive" : "close")
      send(head.data + body) { [weak self] in self?.completed(keepAlive: keepAlive) }

    case let .file(url, contentType):
      sendFile(url, contentType: contentType, range: request.header("range"), keepAlive: keepAlive)

    case let .events(hub):
      var head = HTTPHead(status: 200)
      head.set("Content-Type", "application/x-ndjson")
      head.set("Cache-Control", "no-store")
      // Without this URLSession holds the response back while it sniffs the first 512 bytes, and a
      // quiet stream never reaches the client at all.
      head.set("X-Content-Type-Options", "nosniff")
      head.set("Connection", "close")
      send(head.data) {}
      let id = hub.subscribe { [weak self] event in
        guard let self, let line = try? JSONEncoder().encode(event) else { return }
        server.queue.async { self.send(line + Data("\n".utf8)) {} }
      }
      subscription = (hub, id)
    }
  }

  private func sendFile(_ url: URL, contentType: String, range: String?, keepAlive: Bool) {
    guard let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value,
          let handle = try? FileHandle(forReadingFrom: url)
    else {
      respond(.error(404, "not found"), to: HTTPRequest(method: "GET", path: "/"), keepAlive: keepAlive)
      return
    }

    var head: HTTPHead
    let offset: Int64
    let length: Int64
    switch ByteRange.parse(range, size: size) {
    case .unsatisfiable:
      try? handle.close()
      head = HTTPHead(status: 416)
      head.set("Content-Range", "bytes */\(size)")
      head.set("Content-Length", "0")
      head.set("Connection", keepAlive ? "keep-alive" : "close")
      send(head.data) { [weak self] in self?.completed(keepAlive: keepAlive) }
      return
    case .whole:
      head = HTTPHead(status: 200)
      offset = 0
      length = size
    case .partial(let bytes):
      head = HTTPHead(status: 206)
      head.set("Content-Range", "bytes \(bytes.lowerBound)-\(bytes.upperBound)/\(size)")
      offset = bytes.lowerBound
      length = bytes.upperBound - bytes.lowerBound + 1
    }
    head.set("Content-Type", contentType)
    head.set("Content-Length", "\(length)")
    head.set("Accept-Ranges", "bytes")
    head.set("Connection", keepAlive ? "keep-alive" : "close")
    send(head.data) {}
    stream(handle, offset: offset, remaining: length, keepAlive: keepAlive)
  }

  /// Reads and sends one chunk, and only once the network has taken it reads the next.
  private func stream(_ handle: FileHandle, offset: Int64, remaining: Int64, keepAlive: Bool) {
    guard !closed else {
      try? handle.close()
      return
    }
    guard remaining > 0 else {
      try? handle.close()
      completed(keepAlive: keepAlive)
      return
    }
    let chunk: Data
    do {
      try handle.seek(toOffset: UInt64(offset))
      chunk = try handle.read(upToCount: Int(min(Int64(LinkServer.fileChunkBytes), remaining))) ?? Data()
    } catch {
      try? handle.close()
      close()
      return
    }
    guard !chunk.isEmpty else {
      // The file got shorter than its Content-Length; the client sees a short body and retries.
      try? handle.close()
      close()
      return
    }
    inFlight += chunk.count
    server.noteInFlight(inFlight)
    connection.send(content: chunk, completion: .contentProcessed { [weak self] error in
      guard let self else { return }
      inFlight -= chunk.count
      if error != nil {
        try? handle.close()
        close()
        return
      }
      stream(
        handle,
        offset: offset + Int64(chunk.count),
        remaining: remaining - Int64(chunk.count),
        keepAlive: keepAlive
      )
    })
  }

  private func send(_ data: Data, then: @escaping @Sendable () -> Void) {
    connection.send(content: data, completion: .contentProcessed { [weak self] error in
      if error != nil {
        self?.close()
        return
      }
      then()
    })
  }

  private func completed(keepAlive: Bool) {
    responding = false
    if !keepAlive || peerDone {
      close()
      return
    }
    nextRequest()
  }

  func close() {
    guard !closed else { return }
    closed = true
    if let subscription { subscription.hub.unsubscribe(subscription.id) }
    subscription = nil
    connection.cancel()
    server.finished(self)
  }
}

/// Resumes a continuation once, whichever listener state gets there first.
private final class Once: @unchecked Sendable {
  private let lock = NSLock()
  private var done = false

  func run(_ body: () -> Void) {
    let first = lock.withLock { () -> Bool in
      guard !done else { return false }
      done = true
      return true
    }
    if first { body() }
  }
}

/// Lets the ready handler read the listener's bound port.
private final class ListenerBox: @unchecked Sendable {
  let listener: NWListener

  init(_ listener: NWListener) {
    self.listener = listener
  }
}
