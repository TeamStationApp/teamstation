import Foundation
import Network

/// Loopback HTTP for driving the fake cameras from a Maestro flow or a shell script.
///
/// Shaped like `fakeRtspCameras.js`'s fault port so the two farms are driven the same way:
/// `/fault?cam=1&drop=0.05` to break a camera, `/clock` to read what the generator thinks it has
/// sent. That second one matters more than it looks — every assertion about frames the app
/// received is really an assertion about the difference between two counters, and without the
/// generator's own count the app's is unfalsifiable.
final class ControlServer: @unchecked Sendable {
  private let port: NWEndpoint.Port
  private let cameras: [FakeCamera]
  private var listener: NWListener?
  private let queue = DispatchQueue(label: "gsNdiCameras.control")

  init?(port: UInt16, cameras: [FakeCamera]) {
    guard let value = NWEndpoint.Port(rawValue: port) else { return nil }
    self.port = value
    self.cameras = cameras
  }

  func start() throws {
    let parameters = NWParameters.tcp
    parameters.allowLocalEndpointReuse = true
    // Loopback only. The farm answers fault commands with no authentication of any kind, and a
    // generator on the venue network that anyone could break cameras on is not a test tool.
    parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: port)
    let listener = try NWListener(using: parameters)
    listener.newConnectionHandler = { [weak self] connection in
      self?.handle(connection)
    }
    listener.start(queue: queue)
    self.listener = listener
  }

  func stop() {
    listener?.cancel()
    listener = nil
  }

  private func handle(_ connection: NWConnection) {
    connection.start(queue: queue)
    connection.receive(minimumIncompleteLength: 1, maximumLength: 8_192) { [weak self] data, _, _, _ in
      guard let self, let data, let request = String(data: data, encoding: .utf8) else {
        connection.cancel()
        return
      }
      let body = self.respond(to: request)
      let response = """
        HTTP/1.1 200 OK\r
        Content-Type: application/json\r
        Content-Length: \(body.utf8.count)\r
        Connection: close\r
        \r
        \(body)
        """
      connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in
        connection.cancel()
      })
    }
  }

  private func respond(to request: String) -> String {
    guard
      let line = request.split(separator: "\r\n").first,
      let path = line.split(separator: " ").dropFirst().first
    else { return json(["error": "malformed request"]) }

    let parts = path.split(separator: "?", maxSplits: 1)
    let route = String(parts[0])
    let query = parts.count > 1 ? Self.parseQuery(String(parts[1])) : [:]

    switch route {
    case "/fault":
      // No `cam` means all of them, which is how a run applies one condition to the whole fleet
      // without four requests that land at four different moments.
      let targets = query["cam"].flatMap(Int.init).map { index in
        cameras.filter { $0.index == index - 1 }
      } ?? cameras
      guard !targets.isEmpty else { return json(["error": "no such camera"]) }
      let applied = targets.flatMap { $0.applyFaults(query) }
      return json([
        "applied": Array(Set(applied)).sorted(),
        "cameras": targets.map { $0.status }
      ])

    case "/clock", "/status":
      return json([
        "wallClock": Date().timeIntervalSince1970,
        "cameras": cameras.map { $0.status }
      ])

    case "/reset":
      let applied = cameras.flatMap { $0.applyFaults(["reset": "1"]) }
      return json([ "applied": applied, "cameras": cameras.map { $0.status } ])

    default:
      return json([
        "error": "unknown route",
        "routes": [ "/fault", "/clock", "/status", "/reset" ]
      ])
    }
  }

  private func json(_ value: [String: Any]) -> String {
    guard
      let data = try? JSONSerialization.data(withJSONObject: value, options: [ .sortedKeys ]),
      let string = String(data: data, encoding: .utf8)
    else { return "{}" }
    return string
  }

  static func parseQuery(_ string: String) -> [String: String] {
    var result: [String: String] = [:]
    for pair in string.split(separator: "&") {
      let halves = pair.split(separator: "=", maxSplits: 1)
      guard let key = halves.first else { continue }
      let value = halves.count > 1 ? String(halves[1]) : ""
      result[String(key)] = value.removingPercentEncoding ?? value
    }
    return result
  }
}
