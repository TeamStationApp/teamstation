import Foundation
import Network

/// A loopback HTTP front door for the commands in `ControlChannel`.
///
/// 8766 rather than Producer's 8765, so both apps can be driven from one script during the
/// end-to-end run without either having to move.
///
/// Only started when the app was launched for UI testing. Nothing here runs in a normal session.
public final class ControlServer: @unchecked Sendable {
  public static let defaultPort: UInt16 = 8766

  /// Returns a JSON body for the request, or nil if the command was refused.
  public typealias Handler = @Sendable (URL) -> Data?

  public private(set) var port: UInt16
  private let handler: Handler
  private let queue = DispatchQueue(label: "co.gamestation.cameraman.control-server")
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
    // Starting before anything else is done with it: cancelling an unstarted connection leaves the
    // client's handshake unanswered, which looks exactly like the app having crashed.
    connection.start(queue: queue)
    receive(on: connection, accumulated: Data())
  }

  private func receive(on connection: NWConnection, accumulated: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, isComplete, error in
      guard let self else { return }
      var buffer = accumulated
      if let data { buffer.append(data) }

      // Only the request line matters; a blank line marks the end of the headers.
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
    } else if let url = URL(string: "\(ControlChannel.scheme)://test\(target)"),
              let result = handler(url) {
      body = result
      status = "200 OK"
    } else {
      // A typo and a command the app refused are different problems, and reporting both as
      // "unknown command" sends you looking for a parsing bug that is not there.
      let parsed = URL(string: "\(ControlChannel.scheme)://test\(target)")
        .flatMap { ControlChannel.command(from: $0) } != nil
      let reason = parsed
        ? "command rejected — the app was not in a state to run it"
        : "unknown command"
      body = Data(#"{"ok":false,"error":"\#(reason)"}"#.utf8)
      status = "400 Bad Request"
    }

    let header = [
      "HTTP/1.1 \(status)",
      "Content-Type: application/json",
      "Content-Length: \(body.count)",
      "Connection: close",
      "",
      ""
    ].joined(separator: "\r\n")
    var response = Data(header.utf8)
    response.append(body)

    connection.send(content: response, completion: .contentProcessed { _ in
      connection.cancel()
    })
  }

  /// `GET /set-zoom?displayed=2 HTTP/1.1` reduced to `/set-zoom?displayed=2`.
  static func requestTarget(_ head: String) -> String {
    head
      .split(separator: "\n", maxSplits: 1)
      .first?
      .split(separator: " ")
      .dropFirst()
      .first
      .map(String.init) ?? "/"
  }

  /// The addresses a script can reach this listener on, for the state dump.
  public static func localAddresses() -> [String] {
    var addresses: [String] = []
    var head: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&head) == 0, let first = head else { return addresses }
    defer { freeifaddrs(head) }

    for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
      let interface = pointer.pointee
      guard interface.ifa_addr.pointee.sa_family == UInt8(AF_INET) else { continue }
      let name = String(cString: interface.ifa_name)
      guard name == "en0" || name == "lo0" || name.hasPrefix("bridge") else { continue }
      var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      let result = getnameinfo(
        interface.ifa_addr,
        socklen_t(interface.ifa_addr.pointee.sa_len),
        &buffer,
        socklen_t(buffer.count),
        nil,
        0,
        NI_NUMERICHOST
      )
      if result == 0 { addresses.append(String(cString: buffer)) }
    }
    return addresses
  }
}
