import Foundation
import Network

/// Loopback HTTP for one staged HLS playlist. iOS `AVPlayer` will not play `file://` HLS
/// (the item stays `.unknown` forever) and `AVAssetResourceLoader` is unreliable for
/// `#EXT-X-MAP` fMP4; HTTP on 127.0.0.1 is the path that actually starts.
final class ReplayHTTPServer: @unchecked Sendable {
  private let root: URL
  private let port: UInt16?
  private let queue = DispatchQueue(label: "co.gamestation.producer.replay.http")
  private var listener: NWListener?
  private var startContinuation: CheckedContinuation<UInt16, Error>?
  private var open: [NWConnection] = []

  init(root: URL, port: UInt16? = nil) {
    self.root = root
    self.port = port
  }

  func start() async throws -> URL {
    let parameters = NWParameters.tcp
    parameters.allowLocalEndpointReuse = true
    // Bind to loopback rather than setting `acceptLocalOnly`: that flag means the *local link*, and
    // it drops connections from 127.0.0.1 — the listener accepts the handshake and then hands
    // nothing to `newConnectionHandler`, which `AVPlayer` reports as "the network connection was
    // lost". Requiring the loopback endpoint keeps the server unreachable from the network and
    // reachable from the player.
    parameters.requiredLocalEndpoint = NWEndpoint.hostPort(
      host: "127.0.0.1",
      port: port.flatMap { NWEndpoint.Port(rawValue: $0) } ?? .any
    )
    let listener = try NWListener(using: parameters)
    self.listener = listener

    let port = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<UInt16, Error>) in
      queue.async {
        self.startContinuation = cont
        listener.stateUpdateHandler = { [weak self] state in
          switch state {
          case .ready:
            if let port = listener.port {
              self?.finishStart(.success(port.rawValue))
            }
          case let .failed(error):
            self?.finishStart(.failure(error))
          default:
            break
          }
        }
        listener.newConnectionHandler = { [weak self] connection in
          self?.accept(connection)
        }
        listener.start(queue: self.queue)
      }
    }

    guard let url = URL(string: "http://127.0.0.1:\(port)/index.m3u8") else {
      throw ReplayDecoder.ReplayError.startFailed("could not build loopback playlist URL")
    }
    return url
  }

  func stop() {
    queue.async { [weak self] in
      guard let self else { return }
      listener?.cancel()
      listener = nil
      for connection in open { connection.cancel() }
      open.removeAll()
    }
  }

  private func finishStart(_ result: Result<UInt16, Error>) {
    guard let continuation = startContinuation else { return }
    startContinuation = nil
    continuation.resume(with: result)
  }

  private func accept(_ connection: NWConnection) {
    queue.async { [weak self] in self?.open.append(connection) }
    connection.start(queue: queue)
    receive(on: connection, accumulated: Data())
  }

  private func close(_ connection: NWConnection) {
    queue.async { [weak self] in
      self?.open.removeAll { $0 === connection }
      connection.cancel()
    }
  }

  private func receive(on connection: NWConnection, accumulated: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, isComplete, error in
      guard let self else { return }
      var buffer = accumulated
      if let data { buffer.append(data) }
      self.consume(buffer, on: connection, isComplete: isComplete, error: error)
    }
  }

  private func consume(
    _ buffer: Data,
    on connection: NWConnection,
    isComplete: Bool,
    error: NWError?
  ) {
    guard let split = Self.splitHeaders(from: buffer) else {
      if isComplete || error != nil {
        close(connection)
        return
      }
      receive(on: connection, accumulated: buffer)
      return
    }

    respond(to: split.head, leftover: split.leftover, on: connection)
  }

  private func respond(to head: String, leftover: Data, on connection: NWConnection) {
    let requestLine = head.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? ""
    let target = requestLine
      .split(separator: " ")
      .dropFirst()
      .first
      .map(String.init) ?? "/"
    let path = String(target.split(separator: "?", maxSplits: 1).first ?? Substring(target))
    let name = URL(fileURLWithPath: path).lastPathComponent

    guard !name.isEmpty, !name.contains("..") else {
      send(status: "404 Not Found", type: "text/plain", body: Data(), leftover: leftover, on: connection)
      return
    }

    let file = root.appendingPathComponent(name)
    guard let data = try? Data(contentsOf: file) else {
      send(status: "404 Not Found", type: "text/plain", body: Data(), leftover: leftover, on: connection)
      return
    }

    let type = name.lowercased().hasSuffix(".m3u8")
      ? "application/vnd.apple.mpegurl"
      : "video/mp4"
    let (status, slice, rangeHeader) = Self.byteRange(from: head, data: data)
    send(
      status: status,
      type: type,
      body: slice,
      rangeHeader: rangeHeader,
      leftover: leftover,
      on: connection
    )
  }

  private func send(
    status: String,
    type: String,
    body: Data,
    rangeHeader: String? = nil,
    leftover: Data,
    on connection: NWConnection
  ) {
    let response = Self.httpMessage(status: status, type: type, body: body, rangeHeader: rangeHeader)
    // Keep the connection open: `AVPlayer` fetches the playlist and the `#EXT-X-MAP` init on the
    // same TCP session. Closing after the first body made the init fetch fail as "Cannot Open".
    connection.send(
      content: response,
      contentContext: .defaultMessage,
      isComplete: false,
      completion: .contentProcessed { [weak self] _ in
        self?.readNext(after: leftover, on: connection)
      }
    )
  }

  private func readNext(after leftover: Data, on connection: NWConnection) {
    if Self.splitHeaders(from: leftover) != nil {
      consume(leftover, on: connection, isComplete: false, error: nil)
      return
    }
    receive(on: connection, accumulated: leftover)
  }

  /// Headers, a single blank line, then the body. A second blank line would become the first
  /// two bytes of the payload, which `AVPlayer` reports as "Cannot Open".
  static func httpMessage(
    status: String,
    type: String,
    body: Data,
    rangeHeader: String? = nil
  ) -> Data {
    var lines = [
      "HTTP/1.1 \(status)",
      "Content-Type: \(type)",
      "Accept-Ranges: bytes",
      "Content-Length: \(body.count)",
      "Connection: keep-alive"
    ]
    if let rangeHeader {
      lines.append(rangeHeader)
    }
    var message = Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8)
    message.append(body)
    return message
  }

  static func splitHeaders(from buffer: Data) -> (head: String, leftover: Data)? {
    let crlf = Data("\r\n\r\n".utf8)
    let lf = Data("\n\n".utf8)
    guard let range = buffer.range(of: crlf) ?? buffer.range(of: lf) else { return nil }
    let head = String(decoding: buffer[..<range.lowerBound], as: UTF8.self)
    return (head, Data(buffer[range.upperBound...]))
  }

  private static func byteRange(from head: String, data: Data) -> (String, Data, String?) {
    let size = data.count
    for raw in head.split(whereSeparator: \.isNewline) {
      let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      guard line.lowercased().hasPrefix("range:") else { continue }
      let spec = line.drop { $0 != ":" }.dropFirst().trimmingCharacters(in: .whitespaces)
      guard spec.lowercased().hasPrefix("bytes=") else { continue }
      let body = spec.dropFirst(6)
      let parts = body.split(separator: "-", maxSplits: 1)
      let start = Int(parts.first ?? "0") ?? 0
      let end: Int
      if parts.count == 2, !parts[1].isEmpty, let parsed = Int(parts[1]) {
        end = min(parsed, size - 1)
      } else {
        end = size - 1
      }
      guard start >= 0, start <= end, start < size else { continue }
      let slice = data.subdata(in: start..<(end + 1))
      return (
        "206 Partial Content",
        slice,
        "Content-Range: bytes \(start)-\(end)/\(size)"
      )
    }
    return ("200 OK", data, nil)
  }
}
