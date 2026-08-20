import Foundation
import Network

/// A loopback HTTP front door for the same commands `gsproducer://` carries.
///
/// The URL scheme survives as Maestro's channel, but iOS shows an "Open in …?" confirmation
/// for every cross-app scheme open, so a script that issues twenty commands would have to tap
/// twenty alerts. This listener has no such gate: on the simulator the host Mac and the guest
/// share a network stack, so `curl http://127.0.0.1:8765/dump-state` reaches the app directly;
/// on a device the same request works against the iPad's LAN address. Replay HLS is a separate
/// loopback listener per tile at `127.0.0.1:(18701+tileIndex)`.
///
/// It only runs when the app was launched with `uiTest` (D7), and it only speaks to loopback
/// plus the local network — there is nothing here that a normal user session ever starts.
public final class ControlServer: @unchecked Sendable {
  public static let defaultPort: UInt16 = 8765

  /// Returns a JSON body for the request, or `nil` if the command was not understood.
  public typealias Handler = @Sendable (URL) -> Data?

  public private(set) var port: UInt16
  private let handler: Handler
  private let queue = DispatchQueue(label: "co.gamestation.producer.control-server")
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
    let target = head
      .split(separator: "\n", maxSplits: 1)
      .first?
      .split(separator: " ")
      .dropFirst()
      .first
      .map(String.init) ?? "/"

    // Ballast for measuring how much throughput this device actually has on the network the
    // cameras arrive over. Frames failing to arrive looks the same whether the link is slow or the app
    // is slow, and that question cannot be answered from inside the pipeline.
    if target.hasPrefix("/throughput") {
      let requested = URLComponents(string: "http://x\(target)")?
        .queryItems?
        .first { $0.name == "bytes" }?
        .value
        .flatMap(Int.init)
      sendBallast(bytes: min(max(requested ?? 8_000_000, 1), 128_000_000), on: connection)
      return
    }

    // A scorebug the app can reach without any network at all.
    //
    // Pointing the scoreboard URL at a page on another machine makes the compositor path untestable
    // wherever local network access is unavailable — and on iOS that includes any device where the
    // permission has not been granted, which fails by simply never connecting. Served from
    // loopback, the overlay can be verified on a device in flight mode.
    if target.hasPrefix("/test-scorebug") {
      sendPage(Self.testScorebugPage, on: connection)
      return
    }

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
      // A typo and a command the app refused are very different problems, and reporting both as
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

  private func sendPage(_ html: String, on connection: NWConnection) {
    let body = Data(html.utf8)
    let header = [
      "HTTP/1.1 200 OK",
      "Content-Type: text/html; charset=utf-8",
      "Cache-Control: no-store",
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

  /// Transparent background, one fixed-size graphic at the origin, and a clock that ticks every
  /// second — so the blend, the placement and the mutation-driven refresh are all exercised.
  private static let testScorebugPage = """
  <!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent}
  #bug{display:inline-flex;align-items:center;gap:18px;
    font-family:-apple-system,Helvetica,sans-serif;background:rgba(8,10,14,.86);
    border-left:8px solid #17d18a;border-radius:10px;padding:14px 22px}
  .t{color:#fff;font-size:34px;font-weight:800;letter-spacing:1px}
  .s{color:#17d18a;font-size:44px;font-weight:900;font-variant-numeric:tabular-nums}
  .c{color:#ffd166;font-size:26px;font-weight:700;font-variant-numeric:tabular-nums;
    border-left:2px solid rgba(255,255,255,.18);padding-left:18px}
  </style></head><body><div id="bug">
  <span class="t">HOME</span><span class="s">3</span>
  <span class="t">AWAY</span><span class="s">1</span>
  <span class="c" id="clock">00:00</span></div>
  <script>var s=Date.now();setInterval(function(){var e=Math.floor((Date.now()-s)/1000);
  document.getElementById('clock').textContent=
  String(Math.floor(e/60)).padStart(2,'0')+':'+String(e%60).padStart(2,'0')},1000);</script>
  </body></html>
  """

  private func sendBallast(bytes: Int, on connection: NWConnection) {
    let header = [
      "HTTP/1.1 200 OK",
      "Content-Type: application/octet-stream",
      "Content-Length: \(bytes)",
      "Connection: close",
      "",
      ""
    ].joined(separator: "\r\n")
    connection.send(content: Data(header.utf8), completion: .contentProcessed { _ in })

    let chunk = Data(count: 64 * 1024)
    var remaining = bytes
    func sendChunk() {
      guard remaining > 0 else {
        connection.cancel()
        return
      }
      let size = min(remaining, chunk.count)
      remaining -= size
      // Chained on completion so the send queue reflects what the link actually drains.
      connection.send(content: chunk.prefix(size), completion: .contentProcessed { error in
        guard error == nil else {
          connection.cancel()
          return
        }
        sendChunk()
      })
    }
    sendChunk()
  }

  /// The addresses a script can reach this listener on, for the HUD and the state dump.
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
      if result == 0 {
        addresses.append(String(cString: buffer))
      }
    }
    return addresses
  }
}
