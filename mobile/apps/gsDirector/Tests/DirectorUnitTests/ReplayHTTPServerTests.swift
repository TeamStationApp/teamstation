import Foundation
import Network
import Testing

@testable import DirectorPipeline

/// Replay is the one feature that cannot be checked without a network round trip: `AVPlayer` talks
/// to this server over loopback, and every way it can fail — no response, a truncated body, a reset
/// before the client has read the bytes — surfaces as the same opaque "the network connection was
/// lost". These tests ask the questions the player asks.
@Suite("Replay HTTP server")
struct ReplayHTTPServerTests {
  private func staging(files: [String: Data]) throws -> URL {
    let root = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("replay-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    for (name, data) in files {
      try data.write(to: root.appendingPathComponent(name))
    }
    return root
  }

  @Test("serves the playlist it was given")
  func servesPlaylist() async throws {
    let playlist = Data("#EXTM3U\n#EXT-X-VERSION:7\n".utf8)
    let root = try staging(files: ["index.m3u8": playlist])
    defer { try? FileManager.default.removeItem(at: root) }

    let server = ReplayHTTPServer(root: root)
    let url = try await server.start()
    defer { server.stop() }

    let (data, response) = try await URLSession.shared.data(from: url)
    #expect((response as? HTTPURLResponse)?.statusCode == 200)
    #expect(data == playlist)
  }

  @Test("serves a segment large enough to span several packets without truncating it")
  func servesLargeSegment() async throws {
    // A real fragment is megabytes. Cancelling the connection when the send call returns loses the
    // tail of a body this size, which is exactly the bug this covers.
    var segment = Data(count: 4 * 1024 * 1024)
    for index in stride(from: 0, to: segment.count, by: 4096) { segment[index] = UInt8(index % 251) }
    let root = try staging(files: ["index.m3u8": Data("#EXTM3U\n".utf8), "seg-1.mp4": segment])
    defer { try? FileManager.default.removeItem(at: root) }

    let server = ReplayHTTPServer(root: root)
    let base = try await server.start()
    defer { server.stop() }

    let url = base.deletingLastPathComponent().appendingPathComponent("seg-1.mp4")
    let (data, response) = try await URLSession.shared.data(from: url)
    #expect((response as? HTTPURLResponse)?.statusCode == 200)
    #expect(data == segment)
  }

  @Test("answers a byte range, because the player asks for one")
  func servesByteRange() async throws {
    let segment = Data((0..<1024).map { UInt8($0 % 256) })
    let root = try staging(files: ["index.m3u8": Data("#EXTM3U\n".utf8), "seg-1.mp4": segment])
    defer { try? FileManager.default.removeItem(at: root) }

    let server = ReplayHTTPServer(root: root)
    let base = try await server.start()
    defer { server.stop() }

    var request = URLRequest(url: base.deletingLastPathComponent().appendingPathComponent("seg-1.mp4"))
    request.setValue("bytes=100-199", forHTTPHeaderField: "Range")
    let (data, response) = try await URLSession.shared.data(for: request)
    let http = response as? HTTPURLResponse
    #expect(http?.statusCode == 206)
    #expect(http?.value(forHTTPHeaderField: "Content-Range") == "bytes 100-199/1024")
    #expect(data == segment.subdata(in: 100..<200))
  }

  @Test("serves two requests, because a playlist is always followed by a segment")
  func servesSequentialRequests() async throws {
    let root = try staging(files: [
      "index.m3u8": Data("#EXTM3U\n".utf8),
      "seg-1.mp4": Data("fragment".utf8)
    ])
    defer { try? FileManager.default.removeItem(at: root) }

    let server = ReplayHTTPServer(root: root)
    let base = try await server.start()
    defer { server.stop() }

    let (playlist, _) = try await URLSession.shared.data(from: base)
    let (segment, _) = try await URLSession.shared.data(
      from: base.deletingLastPathComponent().appendingPathComponent("seg-1.mp4")
    )
    #expect(playlist == Data("#EXTM3U\n".utf8))
    #expect(segment == Data("fragment".utf8))
  }

  @Test("binds the port it was asked for so two tiles cannot share a listener")
  func bindsRequestedPort() async throws {
    #expect(ReplayDecoder.loopbackPort(forSource: 0) == 18_701)
    #expect(ReplayDecoder.loopbackPort(forSource: 1) == 18_702)
    #expect(ReplayDecoder.loopbackPort(forSource: 4) == 18_705)

    let root = try staging(files: ["index.m3u8": Data("#EXTM3U\n".utf8)])
    defer { try? FileManager.default.removeItem(at: root) }

    let server = ReplayHTTPServer(root: root, port: 19_811)
    let url = try await server.start()
    defer { server.stop() }
    #expect(url.port == 19_811)
  }

  @Test("stop releases the port so the next replay can bind it immediately")
  func stopReleasesPort() async throws {
    let root = try staging(files: ["index.m3u8": Data("#EXTM3U\n".utf8)])
    defer { try? FileManager.default.removeItem(at: root) }

    let first = ReplayHTTPServer(root: root, port: 19_841)
    _ = try await first.start()
    first.stop()

    let second = ReplayHTTPServer(root: root, port: 19_841)
    let url = try await second.start()
    defer { second.stop() }
    #expect(url.port == 19_841)
  }

  @Test("two tiles can serve playlists on adjacent loopback ports at once")
  func twoListenersAtOnce() async throws {
    let firstRoot = try staging(files: ["index.m3u8": Data("#EXTM3U\n# first\n".utf8)])
    let secondRoot = try staging(files: ["index.m3u8": Data("#EXTM3U\n# second\n".utf8)])
    defer {
      try? FileManager.default.removeItem(at: firstRoot)
      try? FileManager.default.removeItem(at: secondRoot)
    }

    let first = ReplayHTTPServer(root: firstRoot, port: 19_821)
    let second = ReplayHTTPServer(root: secondRoot, port: 19_822)
    let firstURL = try await first.start()
    let secondURL = try await second.start()
    defer {
      first.stop()
      second.stop()
    }

    let (firstBody, _) = try await URLSession.shared.data(from: firstURL)
    let (secondBody, _) = try await URLSession.shared.data(from: secondURL)
    #expect(firstURL.port == 19_821)
    #expect(secondURL.port == 19_822)
    #expect(firstBody == Data("#EXTM3U\n# first\n".utf8))
    #expect(secondBody == Data("#EXTM3U\n# second\n".utf8))
  }

  @Test("a missing file is a 404 rather than a dead connection")
  func missingFileIsNotFound() async throws {
    let root = try staging(files: ["index.m3u8": Data("#EXTM3U\n".utf8)])
    defer { try? FileManager.default.removeItem(at: root) }

    let server = ReplayHTTPServer(root: root)
    let base = try await server.start()
    defer { server.stop() }

    let (_, response) = try await URLSession.shared.data(
      from: base.deletingLastPathComponent().appendingPathComponent("missing.mp4")
    )
    #expect((response as? HTTPURLResponse)?.statusCode == 404)
  }

  @Test("the playlist body starts at the first payload byte, not an extra blank line")
  func playlistBodyIsNotPrefixed() throws {
    let body = Data("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n".utf8)
    let message = ReplayHTTPServer.httpMessage(
      status: "200 OK",
      type: "application/vnd.apple.mpegurl",
      body: body
    )
    let text = String(decoding: message, as: UTF8.self)
    #expect(text.contains("Connection: keep-alive"))
    #expect(!text.contains("Connection: close"))
    let split = try #require(ReplayHTTPServer.splitHeaders(from: message))
    #expect(split.leftover == body)
    #expect(!split.leftover.starts(with: Data("\r\n".utf8)))
  }

  @Test("answers a second GET on the same TCP connection, because AVPlayer fetches the init that way")
  func secondGetOnSameConnection() async throws {
    let playlist = Data("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n".utf8)
    let initSegment = Data([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])
    let root = try staging(files: [
      "index.m3u8": playlist,
      "init.mp4": initSegment
    ])
    defer { try? FileManager.default.removeItem(at: root) }

    let server = ReplayHTTPServer(root: root)
    let url = try await server.start()
    defer { server.stop() }
    let port = UInt16(try #require(url.port))
    let bodies = try await LoopbackHTTP.sequentialGets(port: port, paths: ["/index.m3u8", "/init.mp4"])
    #expect(bodies == [playlist, initSegment])
  }

  @Test("answers two GETs pipelined in one write, leftover from the first request")
  func pipelinedGetsOnOneConnection() async throws {
    let playlist = Data("#EXTM3U\n".utf8)
    let initSegment = Data("ftyp".utf8)
    let root = try staging(files: [
      "index.m3u8": playlist,
      "init.mp4": initSegment
    ])
    defer { try? FileManager.default.removeItem(at: root) }

    let server = ReplayHTTPServer(root: root)
    let url = try await server.start()
    defer { server.stop() }
    let port = UInt16(try #require(url.port))
    let bodies = try await LoopbackHTTP.pipelinedGets(port: port, paths: ["/index.m3u8", "/init.mp4"])
    #expect(bodies == [playlist, initSegment])
  }
}

@Suite("Replay errors")
struct ReplayErrorTests {
  @Test("startFailed interpolates as the reason, so the operator toast is not a generic NSError")
  func startFailedInterpolatesReason() {
    let error: Error = ReplayDecoder.ReplayError.startFailed(
      "Cannot Open; The operation couldn’t be completed."
    )
    #expect("\(error)".contains("replay reader failed to start"))
    #expect("\(error)".contains("Cannot Open"))
  }
}

/// `URLSession` opens a new connection per task, so it cannot catch a server that hangs up after
/// the playlist. `AVPlayer` keeps the socket and GETs the `#EXT-X-MAP` init next; that is the
/// path that used to surface as "Cannot Open".
private enum LoopbackHTTP {
  struct ConnectionClosed: Error, CustomStringConvertible {
    var description: String {
      "the loopback connection closed before the next response — AVPlayer would report Cannot Open"
    }
  }

  static func sequentialGets(port: UInt16, paths: [String]) async throws -> [Data] {
    let client = try await Client.connect(port: port)
    defer { client.cancel() }
    var bodies: [Data] = []
    for path in paths {
      try await client.send(get(path))
      bodies.append(try await client.readBody())
    }
    return bodies
  }

  static func pipelinedGets(port: UInt16, paths: [String]) async throws -> [Data] {
    let client = try await Client.connect(port: port)
    defer { client.cancel() }
    try await client.send(Data(paths.map(get).joined()))
    var bodies: [Data] = []
    for _ in paths {
      bodies.append(try await client.readBody())
    }
    return bodies
  }

  private static func get(_ path: String) -> Data {
    Data("GET \(path) HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".utf8)
  }

  private final class Client: @unchecked Sendable {
    private let connection: NWConnection
    private let lock = NSLock()
    private var buffer = Data()

    private init(connection: NWConnection) {
      self.connection = connection
    }

    static func connect(port: UInt16) async throws -> Client {
      let connection = NWConnection(
        host: "127.0.0.1",
        port: NWEndpoint.Port(rawValue: port)!,
        using: .tcp
      )
      let client = Client(connection: connection)
      try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
        connection.stateUpdateHandler = { state in
          switch state {
          case .ready:
            connection.stateUpdateHandler = nil
            cont.resume()
          case let .failed(error):
            connection.stateUpdateHandler = nil
            cont.resume(throwing: error)
          case .cancelled:
            connection.stateUpdateHandler = nil
            cont.resume(throwing: CancellationError())
          default:
            break
          }
        }
        connection.start(queue: DispatchQueue(label: "co.gamestation.director.test.replay.http"))
      }
      return client
    }

    func cancel() {
      connection.cancel()
    }

    func send(_ data: Data) async throws {
      try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
        connection.send(
          content: data,
          completion: .contentProcessed { error in
            if let error { cont.resume(throwing: error) } else { cont.resume() }
          }
        )
      }
    }

    func readBody() async throws -> Data {
      while true {
        if let body = try parseBody() { return body }
        try await receiveMore()
      }
    }

    private func parseBody() throws -> Data? {
      lock.lock()
      defer { lock.unlock() }
      guard let split = ReplayHTTPServer.splitHeaders(from: buffer) else { return nil }
      guard let length = contentLength(from: split.head) else {
        throw ConnectionClosed()
      }
      guard split.leftover.count >= length else { return nil }
      let body = Data(split.leftover.prefix(length))
      buffer = Data(split.leftover.dropFirst(length))
      return body
    }

    private func receiveMore() async throws {
      try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, isComplete, error in
          if let error {
            cont.resume(throwing: error)
            return
          }
          if let data, !data.isEmpty {
            self.lock.lock()
            self.buffer.append(data)
            self.lock.unlock()
            cont.resume()
            return
          }
          if isComplete {
            cont.resume(throwing: ConnectionClosed())
            return
          }
          cont.resume()
        }
      }
    }

    private func contentLength(from head: String) -> Int? {
      for raw in head.split(whereSeparator: \.isNewline) {
        let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard line.lowercased().hasPrefix("content-length:") else { continue }
        let value = line.drop { $0 != ":" }.dropFirst().trimmingCharacters(in: .whitespaces)
        return Int(value)
      }
      return nil
    }
  }
}
