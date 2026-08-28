import Foundation
import Network

/// Loopback HTTP front door for Maestro. Port 8767 so Director (8765) and
/// Cameraman (8766) can stay up on the same LAN.
public final class ControlServer: @unchecked Sendable {
  public static let defaultPort: UInt16 = 8767

  public typealias Handler = @Sendable (URL) -> Data?

  public private(set) var port: UInt16
  private let handler: Handler
  private let queue = DispatchQueue(label: "co.gamestation.preview.control-server")
  private var listener: NWListener?

  public init(port: UInt16 = ControlServer.defaultPort, handler: @escaping Handler) {
    self.port = port
    self.handler = handler
  }

  public func start() throws {
    guard listener == nil else { return }
    let parameters = NWParameters.tcp
    parameters.allowLocalEndpointReuse = true
    let listener = try NWListener(using: parameters, on: NWEndpoint.Port(rawValue: port)!)
    listener.newConnectionHandler = { [weak self] connection in
      self?.accept(connection)
    }
    listener.start(queue: queue)
    self.listener = listener
  }

  public func stop() {
    listener?.cancel()
    listener = nil
  }

  private func accept(_ connection: NWConnection) {
    connection.start(queue: queue)
    receive(on: connection, accumulated: Data())
  }

  private func receive(on connection: NWConnection, accumulated: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) {
      [weak self] data, _, isComplete, error in
      guard let self else { return }
      var buffer = accumulated
      if let data { buffer.append(data) }
      if let range = buffer.range(of: Data("\r\n\r\n".utf8)) ?? buffer.range(of: Data("\n\n".utf8)) {
        let head = String(decoding: buffer[..<range.lowerBound], as: UTF8.self)
        respond(to: head, on: connection)
        return
      }
      if isComplete || error != nil {
        connection.cancel()
        return
      }
      receive(on: connection, accumulated: buffer)
    }
  }

  private func respond(to head: String, on connection: NWConnection) {
    let target = Self.requestTarget(head)
    let body: Data
    let status: String
    if target == "/" || target == "/health" {
      body = Data(#"{"ok":true}"#.utf8)
      status = "200 OK"
    } else if let url = URL(string: "gspreview://test\(target)"),
              let result = handler(url) {
      body = result
      status = "200 OK"
    } else {
      body = Data(#"{"error":"unknown"}"#.utf8)
      status = "404 Not Found"
    }

    var response = Data()
    response.append(contentsOf: "HTTP/1.1 \(status)\r\n".utf8)
    response.append(contentsOf: "Content-Type: application/json\r\n".utf8)
    response.append(contentsOf: "Content-Length: \(body.count)\r\n".utf8)
    response.append(contentsOf: "Connection: close\r\n\r\n".utf8)
    response.append(body)
    connection.send(content: response, completion: .contentProcessed { _ in
      connection.cancel()
    })
  }

  private static func requestTarget(_ head: String) -> String {
    let line = head.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
    let parts = line.split(separator: " ")
    guard parts.count >= 2 else { return "/" }
    let raw = String(parts[1])
    return raw.split(separator: "?").first.map(String.init) ?? raw
  }
}
