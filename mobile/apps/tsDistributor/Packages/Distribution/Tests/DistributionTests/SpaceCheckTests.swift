import DirectorClient
import DirectorCore
import DirectorExport
import DirectorLink
import Distribution
import DistributorWire
import Foundation
import Testing

/// A TS Director with one ten-gigabyte camera to export.
actor BigTakeDirector: DistributorBackend {
  static let cameraBytes: Int64 = 10 << 30

  func identity() -> DirectorIdentity {
    DirectorIdentity(deviceName: "iPad", directorVersion: "test", directorID: UUID(), isRecording: false)
  }

  func recordings() -> [RecordingListing] { [] }
  func deleteRecordings(_ ids: [Int64]) -> [Int64] { [] }

  func manifest(recordingID: Int64, tracks: [Track]) throws -> ManifestResponse? {
    let json = #"{"recordingID":1,"startedAt":{"seconds":1000},"endedAt":{"seconds":1600},"segments":[],"programAnchors":[]}"#
    return ManifestResponse(
      manifest: try JSONDecoder().decode(RecordingManifest.self, from: Data(json.utf8)),
      window: ExportWindow(start: WallClock(seconds: 1_000), end: WallClock(seconds: 1_600)),
      files: tracks.isEmpty ? [] : [ RemoteFile(root: .archives, path: "cam_a/rec-1/seg-1.mp4", bytes: Self.cameraBytes) ]
    )
  }

  func startJob(_ request: JobRequest, id: UUID, events: EventHub) throws {}
  func cancelJob(_ id: UUID) {}
  func beginExport() -> UUID { UUID() }
  func endExport(_ id: UUID) {}
}

@Suite("Free space")
struct SpaceCheckTests {
  static let gigabyte: Int64 = 1 << 30

  static func check(free: Int64, sameDisk: Bool = true) -> SpaceCheck {
    SpaceCheck(freeBytes: { _ in free }, volume: { url in sameDisk ? "disk" : url.path })
  }

  @Test("A manifest's files add up per track: each camera's segments, and the programme's parts together")
  func perTrack() {
    let files = [
      RemoteFile(root: .archives, path: "cam_a/rec-1/seg-1.mp4", bytes: 3),
      RemoteFile(root: .archives, path: "cam_a/rec-1/seg-2.mp4", bytes: 4),
      RemoteFile(root: .archives, path: "cam_b/rec-1/seg-1.mp4", bytes: 10),
      RemoteFile(root: .program, path: "program-1.mp4", bytes: 20),
      RemoteFile(root: .program, path: "program-1-2.mp4", bytes: 5)
    ]
    #expect(ExportSpace.bytesPerTrack(files).sorted() == [ 7, 10, 25 ])
    #expect(ExportSpace.combinedBytes(seconds: 100, cameras: 4) == 200_000_000)
  }

  @Test("An export fits with room to spare, and one that does not says how much it needs")
  func shortfall() {
    let folder = URL(fileURLWithPath: "/tmp/export")
    let tracks = [ 5 * Self.gigabyte, 3 * Self.gigabyte ]
    // Saved 8 GB, plus the largest working copy 5 GB, plus the 2 GB margin: 15 GB on one disk.
    #expect(Self.check(free: 16 * Self.gigabyte).shortfall(trackBytes: tracks, combinedBytes: 0, destination: folder, scratch: folder) == nil)
    let message = Self.check(free: 14 * Self.gigabyte).shortfall(trackBytes: tracks, combinedBytes: 0, destination: folder, scratch: folder)
    #expect(message?.hasPrefix("Not enough room on") == true)
    #expect(message?.contains("needs about") == true)
    #expect(message?.contains("is free") == true)
    // On separate disks the download folder needs only what is saved.
    #expect(Self.check(free: 11 * Self.gigabyte, sameDisk: false).shortfall(
      trackBytes: tracks, combinedBytes: 0, destination: folder, scratch: URL(fileURLWithPath: "/tmp/scratch")
    ) == nil)
  }

  @Test("An export that does not fit stops before it writes anything, and says why")
  @MainActor
  func runStops() async throws {
    let base = FileManager.default.temporaryDirectory
      .appendingPathComponent("space-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: base) }
    try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    let service = DistributorService(
      backend: BigTakeDirector(),
      roots: FileRoots(
        archives: base.appendingPathComponent("Archives", isDirectory: true),
        program: base.appendingPathComponent("Program", isDirectory: true),
        prepared: base.appendingPathComponent("Prepared", isDirectory: true)
      ),
      settings: DistributorSettingsStore(url: base.appendingPathComponent("settings.json"))
    )
    let server = LinkServer(port: 0) { await service.handle($0) }
    let port = try await server.start()
    defer { server.stop() }
    let camera = SourceID("cam-a")
    let recording = RecordingListing(
      id: 1, startedAt: WallClock(seconds: 1_000), endedAt: WallClock(seconds: 1_600), isLive: false, hasPrimary: false,
      cameras: [ CameraListing(sourceID: camera, name: "home", isNamed: true, bytes: BigTakeDirector.cameraBytes) ],
      preparedTracks: []
    )
    let run = DistributionRun(
      recording: recording,
      tracks: [ .camera(camera) ],
      connection: DirectorConnection(baseURL: URL(string: "http://127.0.0.1:\(port)/")!, macID: "MAC"),
      jobs: JobWatcher(),
      destination: base.appendingPathComponent("Mac", isDirectory: true),
      spaceCheck: Self.check(free: Self.gigabyte)
    )
    await run.run()

    guard case .failed(let reason) = run.states[.camera(camera)] else {
      Issue.record("the export went ahead: \(String(describing: run.states[.camera(camera)]))")
      return
    }
    #expect(reason.hasPrefix("Not enough room on"))
  }
}
