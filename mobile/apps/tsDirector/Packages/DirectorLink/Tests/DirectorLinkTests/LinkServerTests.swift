import DirectorCore
import DirectorExport
import DirectorLink
import DistributorWire
import Foundation
import Testing

/// Connection counts as the server reports them.
final class CountLog: @unchecked Sendable {
  private let lock = NSLock()
  private var log: [Int] = []
  func append(_ count: Int) { lock.withLock { log.append(count) } }
  var values: [Int] { lock.withLock { log } }
}

/// A stand-in for TS Director behind the service.
actor FakeBackend: DistributorBackend {
  var isRecording = false
  var isStreaming = false
  var liveRecordingID: Int64?
  private(set) var exportLock: UUID?

  func setStreaming(_ value: Bool) { isStreaming = value }

  func beginExport() throws -> UUID {
    if isRecording { throw DistributorRefusal.recording }
    if isStreaming { throw DistributorRefusal.streaming }
    let id = UUID()
    exportLock = id
    return id
  }

  func renewExport(_ id: UUID) -> Bool {
    exportLock == id
  }

  func endExport(_ id: UUID) {
    if exportLock == id { exportLock = nil }
  }
  private(set) var deleted: [Int64] = []
  private(set) var jobs: [JobRequest] = []
  private(set) var cancelled: [UUID] = []

  func setRecording(_ value: Bool) { isRecording = value }
  func setLive(_ id: Int64?) { liveRecordingID = id }

  func identity() -> DirectorIdentity {
    DirectorIdentity(
      deviceName: "Test iPad",
      directorVersion: "1.0 (1)",
      directorID: UUID(uuidString: "0C0FFEE0-0000-4000-8000-000000000001")!,
      isRecording: isRecording
    )
  }

  func recordings() -> [RecordingListing] {
    [
      RecordingListing(
        id: 1,
        startedAt: WallClock(seconds: 1_000),
        endedAt: WallClock(seconds: 1_010),
        isLive: false,
        hasPrimary: true,
        cameras: [ CameraListing(sourceID: SourceID("cam-a"), name: "Home", isNamed: true, bytes: 10) ],
        preparedTracks: []
      )
    ]
  }

  func deleteRecordings(_ ids: [Int64]) -> [Int64] {
    let refused = ids.filter { $0 == liveRecordingID }
    deleted += ids.filter { $0 != liveRecordingID }
    return refused
  }

  func manifest(recordingID: Int64, tracks: [Track]) throws -> ManifestResponse? {
    guard recordingID == 1 else { return nil }
    let json = #"{"recordingID":1,"startedAt":{"seconds":1000},"endedAt":{"seconds":1010},"segments":[],"programAnchors":[]}"#
    let manifest = try JSONDecoder().decode(RecordingManifest.self, from: Data(json.utf8))
    return ManifestResponse(
      manifest: manifest,
      window: ExportWindow(start: WallClock(seconds: 1_000), end: WallClock(seconds: 1_010)),
      files: []
    )
  }

  func startJob(_ request: JobRequest, id: UUID, events: EventHub) throws {
    if isRecording { throw DistributorRefusal.recording }
    jobs.append(request)
  }

  func cancelJob(_ id: UUID) {
    cancelled.append(id)
  }

  static let jpeg = Data([ 0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10 ])

  func still(recordingID: Int64, sourceID: SourceID, at seconds: Double) -> Data? {
    recordingID == 1 && sourceID == SourceID("cam-a") ? Self.jpeg : nil
  }
}

@Suite("Link server", .serialized)
struct LinkServerTests {
  struct Rig {
    var base: URL
    var backend: FakeBackend
    var service: DistributorService
    var server: LinkServer
    var port: UInt16
    var session: URLSession

    func url(_ path: String) -> URL { URL(string: "http://127.0.0.1:\(port)\(path)")! }

    func send(
      _ method: String,
      _ path: String,
      body: Data? = nil,
      headers: [String: String] = [:]
    ) async throws -> (status: Int, data: Data, response: HTTPURLResponse) {
      var request = URLRequest(url: url(path))
      request.httpMethod = method
      request.httpBody = body
      for (name, value) in headers {
        request.setValue(value, forHTTPHeaderField: name)
      }
      let (data, response) = try await session.data(for: request)
      let http = try #require(response as? HTTPURLResponse)
      return (http.statusCode, data, http)
    }

    func stop() {
      server.stop()
      session.invalidateAndCancel()
      try? FileManager.default.removeItem(at: base)
    }
  }

  private func rig() async throws -> Rig {
    let base = FileManager.default.temporaryDirectory
      .appendingPathComponent("link-server-\(UUID().uuidString)", isDirectory: true)
    for folder in [ "Archives", "Program", "Prepared" ] {
      try FileManager.default.createDirectory(
        at: base.appendingPathComponent(folder, isDirectory: true),
        withIntermediateDirectories: true
      )
    }
    let backend = FakeBackend()
    let service = DistributorService(
      backend: backend,
      roots: FileRoots(
        archives: base.appendingPathComponent("Archives", isDirectory: true),
        program: base.appendingPathComponent("Program", isDirectory: true),
        prepared: base.appendingPathComponent("Prepared", isDirectory: true)
      ),
      settings: DistributorSettingsStore(url: base.appendingPathComponent("settings.json"))
    )
    let server = LinkServer(port: 0) { await service.handle($0) }
    let port = try await server.start()
    return Rig(
      base: base,
      backend: backend,
      service: service,
      server: server,
      port: port,
      session: URLSession(configuration: .ephemeral)
    )
  }

  @Test("The server says when a client is connected, and that none is once it stops")
  func connectionCount() async throws {
    let counts = CountLog()
    let server = LinkServer(port: 0, connectionsChanged: { counts.append($0) }) { _ in .ok }
    let port = try await server.start()
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }
    _ = try await session.data(from: URL(string: "http://127.0.0.1:\(port)/v1/hello")!)
    #expect(counts.values.contains { $0 > 0 })
    server.stop()
    for _ in 0..<50 where counts.values.last != 0 {
      try await Task.sleep(for: .milliseconds(20))
    }
    #expect(counts.values.last == 0)
  }

  @Test("The export lock is granted when idle, refused while recording or streaming, and handed back")
  func exportLock() async throws {
    let rig = try await rig()
    defer { rig.stop() }
    let (status, data, _) = try await rig.send("POST", "/v1/export-lock")
    #expect(status == 200)
    let lock = try JSONDecoder().decode(ExportLockGranted.self, from: data).lockID
    #expect(await rig.backend.exportLock == lock)
    #expect(try await rig.send("PUT", "/v1/export-lock/\(lock.uuidString)").status == 200)
    #expect(try await rig.send("PUT", "/v1/export-lock/\(UUID().uuidString)").status == 404)
    #expect(try await rig.send("DELETE", "/v1/export-lock/\(lock.uuidString)").status == 200)
    #expect(await rig.backend.exportLock == nil)

    await rig.backend.setRecording(true)
    let recording = try await rig.send("POST", "/v1/export-lock")
    #expect(recording.status == 409)
    #expect(String(decoding: recording.data, as: UTF8.self).contains("recording"))
    await rig.backend.setRecording(false)
    await rig.backend.setStreaming(true)
    let streaming = try await rig.send("POST", "/v1/export-lock")
    #expect(streaming.status == 409)
    #expect(String(decoding: streaming.data, as: UTF8.self).contains("streaming"))
  }

  @Test("Hello names the Director and this launch")
  func hello() async throws {
    let rig = try await rig()
    defer { rig.stop() }
    let (status, data, _) = try await rig.send("GET", "/v1/hello")
    #expect(status == 200)
    let hello = try JSONDecoder().decode(Hello.self, from: data)
    #expect(hello.deviceName == "Test iPad")
    #expect(hello.sessionID == rig.service.sessionID)
    #expect(hello.protocolVersion == DistributorProtocol.version)
  }

  @Test("Recordings list, and an unknown route is a 404")
  func recordingsAndUnknown() async throws {
    let rig = try await rig()
    defer { rig.stop() }
    let (status, data, _) = try await rig.send("GET", "/v1/recordings")
    #expect(status == 200)
    #expect(try JSONDecoder().decode([RecordingListing].self, from: data).first?.cameras.first?.name == "Home")
    #expect(try await rig.send("GET", "/v1/nothing").status == 404)
    #expect(try await rig.send("GET", "/nothing").status == 404)
  }

  @Test("Deleting the take in progress is refused; the others go")
  func deleteRefusesLiveTake() async throws {
    let rig = try await rig()
    defer { rig.stop() }
    await rig.backend.setLive(5)
    let (status, _, _) = try await rig.send("DELETE", "/v1/recordings?ids=4,5")
    #expect(status == 409)
    #expect(await rig.backend.deleted == [ 4 ])
    #expect(try await rig.send("DELETE", "/v1/recordings").status == 400)
  }

  @Test("The iPad takes no stitching while it records")
  func jobsRefusedWhileRecording() async throws {
    let rig = try await rig()
    defer { rig.stop() }
    let job = JobRequest(
      recordingID: 1,
      track: .camera(SourceID("cam-a")),
      window: ExportWindow(start: WallClock(seconds: 1_000), end: WallClock(seconds: 1_010)),
      reprocess: false
    )
    let body = try JSONEncoder().encode(job)

    await rig.backend.setRecording(true)
    #expect(try await rig.send("POST", "/v1/jobs", body: body).status == 409)

    await rig.backend.setRecording(false)
    let (status, data, _) = try await rig.send("POST", "/v1/jobs", body: body)
    #expect(status == 200)
    let accepted = try JSONDecoder().decode(JobAccepted.self, from: data)
    #expect(await rig.backend.jobs == [ job ])

    #expect(try await rig.send("DELETE", "/v1/jobs/\(accepted.jobID.uuidString)").status == 200)
    #expect(await rig.backend.cancelled == [ accepted.jobID ])
  }

  @Test("A camera's still comes back as a JPEG, and a camera with none is a 404")
  func stills() async throws {
    let rig = try await rig()
    defer { rig.stop() }
    let found = try await rig.send("GET", "/v1/recordings/1/still?camera=cam-a&at=10")
    #expect(found.status == 200)
    #expect(found.response.value(forHTTPHeaderField: "Content-Type") == "image/jpeg")
    #expect(found.data == FakeBackend.jpeg)
    #expect(try await rig.send("GET", "/v1/recordings/1/still?camera=cam-z").status == 404)
    #expect(try await rig.send("GET", "/v1/recordings/1/still").status == 400)
  }

  @Test("Manifests come back for known recordings only")
  func manifests() async throws {
    let rig = try await rig()
    defer { rig.stop() }
    let (status, data, _) = try await rig.send("GET", "/v1/recordings/1/manifest?tracks=primary,camera:cam-a")
    #expect(status == 200)
    #expect(try JSONDecoder().decode(ManifestResponse.self, from: data).manifest.recordingID == 1)
    #expect(try await rig.send("GET", "/v1/recordings/2/manifest").status == 404)
    #expect(try await rig.send("GET", "/v1/recordings/1/manifest?tracks=sideways").status == 400)
  }

  @Test("Files come whole or by range, one chunk in flight at a time, and never from outside a root")
  func files() async throws {
    let rig = try await rig()
    defer { rig.stop() }
    let folder = rig.base.appendingPathComponent("Archives/cam_a/rec-1", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    // 24 MB with a byte pattern, so every range can be checked for exactly the right bytes.
    let size = 24 << 20
    let content = Data((0..<size).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ $0 >> 13) })
    try content.write(to: folder.appendingPathComponent("seg-1.mp4"))
    try Data("secret".utf8).write(to: rig.base.appendingPathComponent("secret.txt"))
    let path = "/v1/files/archives/cam_a/rec-1/seg-1.mp4"

    let whole = try await rig.send("GET", path)
    #expect(whole.status == 200)
    #expect(whole.data == content)
    #expect(whole.response.value(forHTTPHeaderField: "Accept-Ranges") == "bytes")
    #expect(rig.server.maximumBytesInFlight <= LinkServer.fileChunkBytes)

    let part = try await rig.send("GET", path, headers: [ "Range": "bytes=1000-1999" ])
    #expect(part.status == 206)
    #expect(part.data == content[1000...1999])
    #expect(part.response.value(forHTTPHeaderField: "Content-Range") == "bytes 1000-1999/\(size)")

    let tail = try await rig.send("GET", path, headers: [ "Range": "bytes=\(size - 10)-" ])
    #expect(tail.status == 206)
    #expect(tail.data == content.suffix(10))

    let beyond = try await rig.send("GET", path, headers: [ "Range": "bytes=\(size)-" ])
    #expect(beyond.status == 416)
    #expect(beyond.response.value(forHTTPHeaderField: "Content-Range") == "bytes */\(size)")

    #expect(try await rig.send("GET", "/v1/files/archives/..%2F..%2Fsecret.txt").status == 404)
    #expect(try await rig.send("GET", "/v1/files/elsewhere/cam_a/rec-1/seg-1.mp4").status == 404)
  }

  @Test("Settings saved by one Mac keep the other Macs' folders")
  func settings() async throws {
    let rig = try await rig()
    defer { rig.stop() }
    let first = DistributorSettings(destinations: [ "MAC-A": "/a" ])
    _ = try await rig.send("PUT", "/v1/settings", body: try JSONEncoder().encode(first), headers: [ "X-Distributor-Mac": "MAC-A" ])
    let second = DistributorSettings(destinations: [ "MAC-B": "/b", "MAC-A": "/overwritten" ], createCombined: true)
    let (status, _, _) = try await rig.send(
      "PUT", "/v1/settings",
      body: try JSONEncoder().encode(second),
      headers: [ "X-Distributor-Mac": "MAC-B" ]
    )
    #expect(status == 200)

    let (_, data, _) = try await rig.send("GET", "/v1/settings")
    let stored = try JSONDecoder().decode(DistributorSettings.self, from: data)
    #expect(stored.destinations == [ "MAC-A": "/a", "MAC-B": "/b" ])
    #expect(stored.createCombined)
  }

  @Test("Events reach an open stream as lines of JSON")
  func events() async throws {
    let rig = try await rig()
    defer { rig.stop() }
    let hub = rig.service.events
    // Publish until the stream has carried one, whenever the client happens to see the headers.
    let publisher = Task {
      for _ in 0..<250 {
        if Task.isCancelled { return }
        if hub.subscriberCount > 0 { hub.publish(.recordingStateChanged(isRecording: true)) }
        try? await Task.sleep(for: .milliseconds(20))
      }
    }
    defer { publisher.cancel() }

    let (bytes, response) = try await rig.session.bytes(from: rig.url("/v1/events"))
    #expect((response as? HTTPURLResponse)?.statusCode == 200)
    var lines = bytes.lines.makeAsyncIterator()
    let line = try #require(try await lines.next())
    #expect(try JSONDecoder().decode(DistributorEvent.self, from: Data(line.utf8)) == .recordingStateChanged(isRecording: true))
  }

  @Test("Pipelined requests on one connection are answered in order; Connection: close is honoured")
  func keepAliveAndClose() async throws {
    let rig = try await rig()
    defer { rig.stop() }
    let twice = "GET /v1/hello HTTP/1.1\r\nHost: x\r\n\r\nGET /v1/recordings HTTP/1.1\r\nHost: x\r\n\r\n"
    let answer = try RawSocket.exchange(port: rig.port, send: twice, until: { $0.components(separatedBy: "HTTP/1.1 200 OK").count - 1 >= 2 })
    #expect(answer.components(separatedBy: "HTTP/1.1 200 OK").count - 1 == 2)
    #expect(answer.contains("Test iPad"))
    #expect(answer.contains("Home"))

    let closing = try RawSocket.exchange(
      port: rig.port,
      send: "GET /v1/hello HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
      until: { _ in false }
    )
    #expect(closing.contains("Connection: close"))
    #expect(closing.contains("Test iPad"))
  }
}

/// A plain socket, for what URLSession hides: several requests on one connection, and the close.
enum RawSocket {
  /// Writes `send`, then reads until `until` is satisfied, the peer closes, or 5 s pass.
  static func exchange(port: UInt16, send: String, until: (String) -> Bool) throws -> String {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { throw POSIXError(.EIO) }
    defer { close(fd) }
    var address = sockaddr_in()
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = port.bigEndian
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    let connected = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    guard connected == 0 else { throw POSIXError(.ECONNREFUSED) }
    var timeout = timeval(tv_sec: 5, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))

    let bytes = Array(send.utf8)
    var written = 0
    while written < bytes.count {
      let result = bytes.withUnsafeBufferPointer { write(fd, $0.baseAddress! + written, bytes.count - written) }
      guard result > 0 else { throw POSIXError(.EIO) }
      written += result
    }

    var received = Data()
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    while !until(String(decoding: received, as: UTF8.self)) {
      let count = read(fd, &buffer, buffer.count)
      if count <= 0 { break }
      received.append(contentsOf: buffer[0..<count])
    }
    return String(decoding: received, as: UTF8.self)
  }
}
