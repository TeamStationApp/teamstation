import CameramanCore
import CameramanRTSP
import DirectorRTSP
import Foundation
import Network
import os
import Testing

@Suite("RTSP server status")
struct RTSPServerStatusTests {
  @Test("A fresh status encodes the soak counters as zeros")
  func defaultStatusEncodesSoakFields() throws {
    let data = try JSONEncoder().encode(RTSPServer.Status())
    let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    #expect(json?["acceptedClients"] as? Int == 0)
    #expect(json?["closedClients"] as? Int == 0)
    #expect(json?["sendQueuePendingBytes"] as? Int == 0)
    #expect(json?["sendQueueFlushes"] as? Int == 0)
    #expect(json?["clientCount"] as? Int == 0)
    #expect(json?["isListening"] as? Bool == false)
  }

  @Test("A disconnect reason survives a round trip")
  func disconnectReasonRoundTrips() throws {
    var status = RTSPServer.Status()
    status.lastDisconnectReason = "TEARDOWN"
    status.listenerState = "ready"
    status.acceptedClients = 4
    status.closedClients = 3
    status.clientCount = 1
    let data = try JSONEncoder().encode(status)
    let decoded = try JSONDecoder().decode(RTSPServer.Status.self, from: data)
    #expect(decoded.lastDisconnectReason == "TEARDOWN")
    #expect(decoded.listenerState == "ready")
    #expect(decoded.acceptedClients == 4)
    #expect(decoded.closedClients == 3)
    #expect(decoded.clientCount == 1)
  }

  // MARK: - Loopback

  private static let identity = DeviceIdentity(uuid: "c94df9ca-d7c2-468f-8529-97d01fba14e7", name: "Loopback")

  /// A server on an ephemeral port that answers one parameter, with no encoder behind it.
  private static func startServer() async throws -> RTSPServer {
    let server = RTSPServer(
      describe: { _, _ in "v=0\r\n" },
      hasAudio: { false },
      identity: { identity },
      requestKeyframe: {},
      parameters: { request in
        switch request.method {
        case .get: .init(body: "ptz.zoom: 1\r\n")
        case .set: .init(body: request.body)
        }
      }
    )
    server.start(port: 0, fallbackPort: 0, path: "/live/mainstream", advertise: false)
    for _ in 0 ..< 40 where server.status.port == nil {
      try await Task.sleep(for: .milliseconds(50))
    }
    _ = try #require(server.status.port, "the listener never became ready")
    return server
  }

  private static func waitUntil(
    _ condition: @escaping () -> Bool,
    seconds: Double = 2
  ) async -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
      if condition() { return true }
      try? await Task.sleep(for: .milliseconds(25))
    }
    return condition()
  }

  @Test("A control-only connection is accepted but is not a viewer")
  func controlOnlyConnectionIsNotCounted() async throws {
    let server = try await Self.startServer()
    defer { server.stop() }
    let port = try #require(server.status.port)

    let client = try await LoopbackRTSPClient(port: port)
    defer { client.close() }
    let options = try await client.exchange("OPTIONS rtsp://127.0.0.1/live/mainstream RTSP/1.0\r\nCSeq: 1\r\n\r\n")
    #expect(options.statusCode == 200)
    #expect(options.header("public")?.contains("SET_PARAMETER") == true)

    let answer = try await client.exchange(
      "GET_PARAMETER rtsp://127.0.0.1/live/mainstream RTSP/1.0\r\nCSeq: 2\r\nContent-Type: text/parameters\r\nContent-Length: 10\r\n\r\nptz.zoom\r\n"
    )
    #expect(answer.statusCode == 200)
    #expect(answer.bodyText == "ptz.zoom: 1\r\n")

    #expect(await Self.waitUntil { server.status.acceptedClients == 1 })
    #expect(server.status.clientCount == 0, "polling parameters is not watching the stream")
  }

  @Test("A media send delay does not hold a parameter reply")
  func parameterReplyIsNotDelayedByTheSendDelayLine() async throws {
    let server = try await Self.startServer()
    defer {
      server.sendDelay.configure(delayMilliseconds: 0, jitterMilliseconds: 0, burstMilliseconds: 0)
      server.stop()
    }
    server.sendDelay.configure(delayMilliseconds: 500, jitterMilliseconds: 0, burstMilliseconds: 0)
    let port = try #require(server.status.port)

    let client = try await LoopbackRTSPClient(port: port)
    defer { client.close() }
    let started = Date()
    let answer = try await client.exchange(
      "GET_PARAMETER rtsp://127.0.0.1/live/mainstream RTSP/1.0\r\nCSeq: 1\r\nContent-Length: 3\r\n\r\n*\r\n"
    )
    let elapsed = Date().timeIntervalSince(started)
    #expect(answer.statusCode == 200)
    #expect(elapsed < 0.3, "the reply took \(elapsed) s; the delay line must wrap media sends only")
  }
}

/// The least client that can hold a socket open and read one response per request.
private final class LoopbackRTSPClient: @unchecked Sendable {
  private let connection: NWConnection
  private let queue = DispatchQueue(label: "loopback-rtsp-client")
  private var buffer = Data()

  init(port: UInt16) async throws {
    connection = NWConnection(
      host: "127.0.0.1",
      port: NWEndpoint.Port(rawValue: port)!,
      using: .tcp
    )
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      // The handler can fire more than once; a checked continuation traps on a second resume.
      let resumed = OSAllocatedUnfairLock(initialState: false)
      connection.stateUpdateHandler = { state in
        let first = resumed.withLock { done -> Bool in
          if done { return false }
          done = true
          return true
        }
        guard first else { return }
        switch state {
        case .ready: continuation.resume()
        case .failed(let error): continuation.resume(throwing: error)
        default: resumed.withLock { $0 = false }
        }
      }
      connection.start(queue: queue)
    }
  }

  func close() { connection.cancel() }

  func exchange(_ text: String) async throws -> RTSPResponse {
    connection.send(content: Data(text.utf8), completion: .contentProcessed { _ in })
    let deadline = Date().addingTimeInterval(3)
    while Date() < deadline {
      if let parsed = RTSPResponse.parse(buffer) {
        buffer.removeFirst(parsed.consumed)
        return parsed.response
      }
      let chunk: Data = try await withCheckedThrowingContinuation { continuation in
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, _, error in
          if let error { continuation.resume(throwing: error) } else { continuation.resume(returning: data ?? Data()) }
        }
      }
      buffer.append(chunk)
    }
    throw CancellationError()
  }
}
