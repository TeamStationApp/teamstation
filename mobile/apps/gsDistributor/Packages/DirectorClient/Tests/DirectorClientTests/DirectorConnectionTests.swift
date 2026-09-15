import DirectorClient
import DirectorCore
import DirectorExport
import DirectorLink
import DistributorWire
import Foundation
import PeerTubeKit
import Testing

/// GS Director's side, played by the real server with a fake app behind it.
actor FakeDirector: DistributorBackend {
  var isRecording = false
  private(set) var jobs: [JobRequest] = []
  private(set) var exportLock: UUID?

  func beginExport() throws -> UUID {
    if isRecording { throw DistributorRefusal.recording }
    let id = UUID()
    exportLock = id
    return id
  }

  func endExport(_ id: UUID) {
    if exportLock == id { exportLock = nil }
  }

  func setRecording(_ value: Bool) { isRecording = value }

  func identity() -> DirectorIdentity {
    DirectorIdentity(
      deviceName: "iPad",
      directorVersion: "1.0 (1)",
      directorID: UUID(uuidString: "0C0FFEE0-0000-4000-8000-000000000002")!,
      isRecording: isRecording
    )
  }

  func recordings() -> [RecordingListing] {
    [
      RecordingListing(
        id: 7,
        startedAt: WallClock(seconds: 1_000),
        endedAt: WallClock(seconds: 1_060),
        isLive: false,
        hasPrimary: true,
        cameras: [ CameraListing(sourceID: SourceID("cam-a"), name: "Home", isNamed: true, bytes: 1) ],
        preparedTracks: [ .primary ]
      )
    ]
  }

  func deleteRecordings(_ ids: [Int64]) -> [Int64] { ids.filter { $0 == 9 } }

  func manifest(recordingID: Int64, tracks: [Track]) throws -> ManifestResponse? {
    guard recordingID == 7 else { return nil }
    let json = #"{"recordingID":7,"startedAt":{"seconds":1000},"endedAt":{"seconds":1060},"segments":[],"programAnchors":[]}"#
    return ManifestResponse(
      manifest: try JSONDecoder().decode(RecordingManifest.self, from: Data(json.utf8)),
      window: ExportWindow(start: WallClock(seconds: 1_000), end: WallClock(seconds: 1_060)),
      files: [ RemoteFile(root: .archives, path: "cam_a/rec-7/seg 1.mp4", bytes: 3) ]
    )
  }

  func startJob(_ request: JobRequest, id: UUID, events: EventHub) throws {
    if isRecording { throw DistributorRefusal.recording }
    jobs.append(request)
    events.publish(.jobProgress(jobID: id, fraction: 0.25))
  }

  func cancelJob(_ id: UUID) {}
}

@Suite("Director connection", .serialized)
struct DirectorConnectionTests {
  struct Rig {
    var base: URL
    var director: FakeDirector
    var service: DistributorService
    var server: LinkServer
    var connection: DirectorConnection

    func stop() {
      server.stop()
      try? FileManager.default.removeItem(at: base)
    }
  }

  private func rig() async throws -> Rig {
    let base = FileManager.default.temporaryDirectory
      .appendingPathComponent("director-client-\(UUID().uuidString)", isDirectory: true)
    for folder in [ "Archives", "Program", "Prepared", "Mac" ] {
      try FileManager.default.createDirectory(at: base.appendingPathComponent(folder), withIntermediateDirectories: true)
    }
    let director = FakeDirector()
    let service = DistributorService(
      backend: director,
      roots: FileRoots(
        archives: base.appendingPathComponent("Archives"),
        program: base.appendingPathComponent("Program"),
        prepared: base.appendingPathComponent("Prepared")
      ),
      settings: DistributorSettingsStore(url: base.appendingPathComponent("settings.json")),
      peerTube: PeerTubeAccount(storage: MemoryAccountStorage())
    )
    let server = LinkServer(port: 0) { await service.handle($0) }
    let port = try await server.start()
    let connection = DirectorConnection(baseURL: URL(string: "http://127.0.0.1:\(port)/")!, macID: "MAC-TEST")
    return Rig(base: base, director: director, service: service, server: server, connection: connection)
  }

  @Test("The Mac takes the export lock, hands it back, and is refused it during a take")
  func exportLock() async throws {
    let rig = try await rig()
    defer { rig.stop() }
    let lock = try await rig.connection.beginExport()
    #expect(await rig.director.exportLock == lock)
    try await rig.connection.endExport(lock)
    #expect(await rig.director.exportLock == nil)

    await rig.director.setRecording(true)
    await #expect(throws: DirectorClientError.self) { _ = try await rig.connection.beginExport() }
  }

  @Test("An iPad not signed in to PeerTube has no token to give")
  func peerTubeSignedOut() async throws {
    let rig = try await rig()
    defer { rig.stop() }
    #expect(try await rig.connection.peerTubeToken() == nil)
    try await rig.connection.peerTubeSignOut()
  }

  @Test("Hello, recordings, manifests and deletes")
  func routes() async throws {
    let rig = try await rig()
    defer { rig.stop() }
    let hello = try await rig.connection.hello()
    #expect(hello.sessionID == rig.service.sessionID)
    #expect(try await rig.connection.recordings().first?.cameras.first?.name == "Home")

    let manifest = try await rig.connection.manifest(recordingID: 7, tracks: [ .primary, .camera(SourceID("cam-a")) ])
    #expect(manifest.window.end == WallClock(seconds: 1_060))
    await #expect(throws: DirectorClientError.self) {
      _ = try await rig.connection.manifest(recordingID: 8, tracks: [])
    }

    #expect(try await rig.connection.deleteRecordings([ 8 ]) == [])
    #expect(try await rig.connection.deleteRecordings([ 8, 9 ]) == [ 9 ])
  }

  @Test("A job the iPad refuses while recording comes back as a 409")
  func jobs() async throws {
    let rig = try await rig()
    defer { rig.stop() }
    let job = JobRequest(
      recordingID: 7,
      track: .primary,
      window: ExportWindow(start: WallClock(seconds: 1_000), end: WallClock(seconds: 1_060)),
      reprocess: false
    )
    await rig.director.setRecording(true)
    do {
      _ = try await rig.connection.startJob(job)
      Issue.record("the job should have been refused")
    } catch let DirectorClientError.http(status, _) {
      #expect(status == 409)
    }
    await rig.director.setRecording(false)
    _ = try await rig.connection.startJob(job)
    #expect(await rig.director.jobs == [ job ])
  }

  @Test("Settings round-trip, keyed to this Mac")
  func settings() async throws {
    let rig = try await rig()
    defer { rig.stop() }
    var settings = try await rig.connection.settings()
    settings.destinations["MAC-TEST"] = "/Users/someone/Movies"
    settings.createCombined = true
    let saved = try await rig.connection.saveSettings(settings)
    #expect(saved.destinations["MAC-TEST"] == "/Users/someone/Movies")
    #expect(try await rig.connection.settings().createCombined)
  }

  @Test("Events arrive from the stream")
  func events() async throws {
    let rig = try await rig()
    defer { rig.stop() }
    let hub = rig.service.events
    let publisher = Task {
      for _ in 0..<250 {
        if Task.isCancelled { return }
        if hub.subscriberCount > 0 { hub.publish(.recordingsChanged) }
        try? await Task.sleep(for: .milliseconds(20))
      }
    }
    defer { publisher.cancel() }
    var events = rig.connection.events().makeAsyncIterator()
    #expect(try await events.next() == .recordingsChanged)
  }

  @Test("A download arrives whole, and resumes from a partial file where it left off")
  func downloads() async throws {
    let rig = try await rig()
    defer { rig.stop() }
    let size = 16 << 20
    let content = Data((0..<size).map { UInt8(truncatingIfNeeded: $0 &* 7 &+ $0 >> 9) })
    let folder = rig.base.appendingPathComponent("Archives/cam_a/rec-7")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    try content.write(to: folder.appendingPathComponent("seg 1.mp4"))
    let file = RemoteFile(root: .archives, path: "cam_a/rec-7/seg 1.mp4", bytes: Int64(size))

    let whole = rig.base.appendingPathComponent("Mac/whole.mp4")
    try await rig.connection.download(file, to: whole)
    #expect(try Data(contentsOf: whole) == content)

    // An interrupted download left the first 5 MB behind.
    let resumed = rig.base.appendingPathComponent("Mac/resumed.mp4")
    try content.prefix(5 << 20).write(to: resumed.appendingPathExtension("partial"))
    let seen = Seen()
    try await rig.connection.download(file, to: resumed) { received, _ in seen.note(received) }
    #expect(try Data(contentsOf: resumed) == content)
    #expect(seen.first >= 5 << 20)
    #expect(!FileManager.default.fileExists(atPath: resumed.appendingPathExtension("partial").path))

    // A partial file that is already whole just becomes the file.
    let done = rig.base.appendingPathComponent("Mac/done.mp4")
    try content.write(to: done.appendingPathExtension("partial"))
    try await rig.connection.download(file, to: done)
    #expect(try Data(contentsOf: done) == content)

    await #expect(throws: DirectorClientError.self) {
      try await rig.connection.download(
        RemoteFile(root: .archives, path: "cam_a/rec-7/missing.mp4", bytes: 1),
        to: rig.base.appendingPathComponent("Mac/missing.mp4")
      )
    }
  }
}

/// The first progress report, to check a resumed download started past zero.
final class Seen: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Int64?

  func note(_ received: Int64) {
    lock.withLock { if value == nil { value = received } }
  }

  var first: Int64 { lock.withLock { value ?? -1 } }
}
