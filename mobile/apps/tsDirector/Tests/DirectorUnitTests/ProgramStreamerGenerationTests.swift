import DirectorCore
@testable import DirectorMedia
import DirectorPipeline
@testable import DirectorRTMP
import Foundation
import Network
import Testing

/// Each start of the stream is its own: work that finishes after a stop or a newer start cannot
/// install anything on, or stop, a session that is not its own.
@Suite("Program streamer starts and stops", .serialized)
struct ProgramStreamerGenerationTests {
  @Test("""
    A stop while a start opens its encoder cancels that start, and a start made after the stop \
    keeps its session when the first one gives up
    """)
  func stopThenStartWhileOpening() async throws {
    let ingest = try await SilentIngest()
    defer { ingest.stop() }
    let streamer = ProgramStreamer(telemetry: PipelineTelemetry(), converter: PixelConverter())
    let settings = StreamSettings(config: .default)
    let url = "rtmp://127.0.0.1:\(ingest.port)/live/00000000-0000-4000-8000-000000000001"
    let once = Latch()
    let newer = TaskBox()
    streamer.willOpenEncoderForTesting = {
      guard once.claim() else { return }
      // Stop lands before the encoder is open, and the stream is started again at once: the new
      // start opens its encoder and dials the ingest, which never answers.
      streamer.stop()
      newer.set(Task { try await streamer.start(urlString: url, settings: settings, onFailure: nil) })
      let deadline = Date().addingTimeInterval(10)
      while !streamer.running, Date() < deadline {
        try? await Task.sleep(for: .milliseconds(10))
      }
    }
    let began = Date()
    await #expect(throws: RTMPClientError.cancelled) {
      try await streamer.start(urlString: url, settings: settings, onFailure: nil)
    }
    // Cancelled at once, rather than dialling over the newer session until the ingest timed out.
    #expect(Date().timeIntervalSince(began) < 5)
    #expect(streamer.running)
    streamer.stop()
    let result = await newer.task?.result
    #expect(throws: RTMPClientError.cancelled) { try result?.get() }
    #expect(!streamer.running)
  }

  @Test("A stop while a start opens its encoder cancels it, and nothing comes up after the stop")
  func stopWhileOpening() async throws {
    let ingest = try await SilentIngest()
    defer { ingest.stop() }
    let streamer = ProgramStreamer(telemetry: PipelineTelemetry(), converter: PixelConverter())
    streamer.willOpenEncoderForTesting = { streamer.stop() }
    await #expect(throws: RTMPClientError.cancelled) {
      try await streamer.start(
        urlString: "rtmp://127.0.0.1:\(ingest.port)/live/00000000-0000-4000-8000-000000000001",
        settings: StreamSettings(config: .default),
        onFailure: nil
      )
    }
    #expect(!streamer.running)
  }
}

/// True the first time it is claimed, from any thread.
private final class Latch: @unchecked Sendable {
  private let lock = NSLock()
  private var claimed = false

  func claim() -> Bool {
    lock.withLock {
      defer { claimed = true }
      return !claimed
    }
  }
}

private final class TaskBox: @unchecked Sendable {
  private let lock = NSLock()
  private var held: Task<Void, Error>?

  var task: Task<Void, Error>? { lock.withLock { held } }
  func set(_ task: Task<Void, Error>) { lock.withLock { held = task } }
}

/// An RTMP ingest on loopback that takes the connection and never answers the handshake.
private final class SilentIngest: @unchecked Sendable {
  private let listener: NWListener
  private let queue = DispatchQueue(label: "test.silent-ingest")
  private let lock = NSLock()
  private var connections: [NWConnection] = []
  private(set) var port: UInt16 = 0

  init() async throws {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    listener = try NWListener(using: parameters)
    listener.newConnectionHandler = { [weak self] connection in
      guard let self else { return }
      lock.withLock { connections.append(connection) }
      connection.start(queue: queue)
    }
    port = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<UInt16, any Error>) in
      let once = Latch()
      listener.stateUpdateHandler = { [listener] state in
        switch state {
        case .ready:
          if once.claim() { continuation.resume(returning: listener.port?.rawValue ?? 0) }
        case let .failed(error):
          if once.claim() { continuation.resume(throwing: error) }
        default:
          break
        }
      }
      listener.start(queue: queue)
    }
  }

  func stop() {
    listener.cancel()
    for connection in lock.withLock({ connections }) { connection.cancel() }
  }
}
