import Foundation
import Network
import os

/// Connects to the app's own RTSP listener from inside the app and runs one `OPTIONS` exchange.
///
/// A listener can report `.ready` on a bound port and still refuse or ignore connections, and from a
/// Mac the two causes — a broken listener and a blocked network path — look identical. Loopback
/// bypasses the network entirely, so this separates them: if it succeeds, the listener is fine and
/// the problem is the path; if it fails, the listener never worked.
public enum LoopbackProbe {
  public struct Result: Sendable, Codable {
    public var connected = false
    public var responded = false
    public var statusLine: String?
    public var error: String?
  }

  public static func run(port: UInt16, path: String, timeout: TimeInterval = 5) async -> Result {
    await withCheckedContinuation { continuation in
      let state = OSAllocatedUnfairLock(initialState: (finished: false, result: Result()))
      let queue = DispatchQueue(label: "co.gamestation.cameraman.loopback")

      guard let endpointPort = NWEndpoint.Port(rawValue: port) else {
        var result = Result()
        result.error = "invalid port \(port)"
        continuation.resume(returning: result)
        return
      }

      let connection = NWConnection(host: "127.0.0.1", port: endpointPort, using: .tcp)

      let finish: @Sendable (Result) -> Void = { result in
        let shouldResume = state.withLock { current -> Bool in
          guard !current.finished else { return false }
          current.finished = true
          current.result = result
          return true
        }
        guard shouldResume else { return }
        connection.cancel()
        continuation.resume(returning: result)
      }

      queue.asyncAfter(deadline: .now() + timeout) {
        var result = state.withLock { $0.result }
        if result.error == nil { result.error = "timed out after \(timeout)s" }
        finish(result)
      }

      connection.stateUpdateHandler = { connectionState in
        switch connectionState {
        case .ready:
          state.withLock { $0.result.connected = true }
          let request = "OPTIONS rtsp://127.0.0.1:\(port)/\(path) RTSP/1.0\r\nCSeq: 1\r\n\r\n"
          connection.send(content: Data(request.utf8), completion: .contentProcessed { _ in })
          connection.receive(minimumIncompleteLength: 1, maximumLength: 2_048) { data, _, _, error in
            var result = state.withLock { $0.result }
            if let data, !data.isEmpty {
              result.responded = true
              result.statusLine = String(decoding: data, as: UTF8.self)
                .components(separatedBy: "\r\n")
                .first
            }
            if let error { result.error = error.localizedDescription }
            finish(result)
          }
        case .failed(let error):
          var result = state.withLock { $0.result }
          result.error = error.localizedDescription
          finish(result)
        default:
          break
        }
      }

      connection.start(queue: queue)
    }
  }
}
