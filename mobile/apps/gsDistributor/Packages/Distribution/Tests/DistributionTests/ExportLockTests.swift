import DirectorClient
import DirectorCore
import DirectorExport
import DirectorLink
import Distribution
import DistributorWire
import Foundation
import PeerTubeKit
import Testing

/// A GS Director that grants the export lock, remembers what it granted and what came back, and
/// takes its time over the manifest so an export can be cancelled while it waits.
actor LockKeepingDirector: DistributorBackend {
  private(set) var granted: UUID?
  private(set) var handedBack: UUID?
  /// False plays a Director that already dropped the lock: every renewal is refused.
  let renews: Bool

  init(renews: Bool = true) {
    self.renews = renews
  }

  func renewExport(_ id: UUID) -> Bool {
    renews && granted == id
  }

  func identity() -> DirectorIdentity {
    DirectorIdentity(deviceName: "iPad", directorVersion: "test", directorID: UUID(), isRecording: false)
  }

  func recordings() -> [RecordingListing] { [] }
  func deleteRecordings(_ ids: [Int64]) -> [Int64] { [] }

  func manifest(recordingID: Int64, tracks: [Track]) async throws -> ManifestResponse? {
    try await Task.sleep(for: .seconds(3))
    return nil
  }

  func startJob(_ request: JobRequest, id: UUID, events: EventHub) throws {}
  func cancelJob(_ id: UUID) {}

  func beginExport() -> UUID {
    let id = UUID()
    granted = id
    return id
  }

  func endExport(_ id: UUID) {
    handedBack = id
  }
}

@Suite("Export lock", .serialized)
struct ExportLockTests {
  @Test("A cancelled export still hands GS Director's export lock back")
  @MainActor
  func cancelledExportReleasesLock() async throws {
    let base = FileManager.default.temporaryDirectory
      .appendingPathComponent("export-lock-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: base) }
    try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)

    let director = LockKeepingDirector()
    let service = DistributorService(
      backend: director,
      roots: FileRoots(
        archives: base.appendingPathComponent("Archives", isDirectory: true),
        program: base.appendingPathComponent("Program", isDirectory: true),
        prepared: base.appendingPathComponent("Prepared", isDirectory: true)
      ),
      settings: DistributorSettingsStore(url: base.appendingPathComponent("settings.json")),
      peerTube: PeerTubeAccount(storage: MemoryAccountStorage())
    )
    let server = LinkServer(port: 0) { await service.handle($0) }
    let port = try await server.start()
    defer { server.stop() }
    let connection = DirectorConnection(baseURL: URL(string: "http://127.0.0.1:\(port)/")!, macID: "MAC")

    let recording = RecordingListing(
      id: 1, startedAt: WallClock(seconds: 1_000), endedAt: WallClock(seconds: 1_010), isLive: false,
      hasPrimary: true, cameras: [], preparedTracks: []
    )
    let run = DistributionRun(
      recording: recording,
      tracks: [ .primary ],
      connection: connection,
      jobs: JobWatcher(),
      destination: base.appendingPathComponent("Mac", isDirectory: true)
    ) { true }
    let exporting = Task { await run.run() }

    // Cancelled while GS Director is still working out the manifest, with the lock taken.
    var lock: UUID?
    for _ in 0..<300 where lock == nil {
      lock = await director.granted
      if lock == nil { try await Task.sleep(for: .milliseconds(10)) }
    }
    let granted = try #require(lock)
    run.cancel()
    await exporting.value

    #expect(run.wasCancelled)
    #expect(await director.handedBack == granted)
  }

  @Test("An export whose lock GS Director dropped stops, and says why")
  @MainActor
  func lostLockStopsExport() async throws {
    let base = FileManager.default.temporaryDirectory
      .appendingPathComponent("export-lock-lost-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: base) }
    try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)

    let director = LockKeepingDirector(renews: false)
    let service = DistributorService(
      backend: director,
      roots: FileRoots(
        archives: base.appendingPathComponent("Archives", isDirectory: true),
        program: base.appendingPathComponent("Program", isDirectory: true),
        prepared: base.appendingPathComponent("Prepared", isDirectory: true)
      ),
      settings: DistributorSettingsStore(url: base.appendingPathComponent("settings.json")),
      peerTube: PeerTubeAccount(storage: MemoryAccountStorage())
    )
    let server = LinkServer(port: 0) { await service.handle($0) }
    let port = try await server.start()
    defer { server.stop() }
    let connection = DirectorConnection(baseURL: URL(string: "http://127.0.0.1:\(port)/")!, macID: "MAC")

    let recording = RecordingListing(
      id: 1, startedAt: WallClock(seconds: 1_000), endedAt: WallClock(seconds: 1_010), isLive: false,
      hasPrimary: true, cameras: [], preparedTracks: []
    )
    // Renewed every tenth of a second, so the refusal arrives while the manifest is still coming.
    let run = DistributionRun(
      recording: recording,
      tracks: [ .primary ],
      connection: connection,
      jobs: JobWatcher(),
      destination: base.appendingPathComponent("Mac", isDirectory: true),
      lockRenewal: .milliseconds(100)
    ) { true }
    await run.run()

    #expect(run.wasCancelled)
    #expect(run.states[.primary] == .failed("Stopped: GS Director no longer held off recording"))
  }
}
