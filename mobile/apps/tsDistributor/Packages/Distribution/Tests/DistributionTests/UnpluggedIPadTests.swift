import AVFoundation
import DirectorClient
import DirectorCore
import DirectorExport
import DirectorLink
import Distribution
import DistributorWire
import Foundation
import Testing

/// An iPad with a real archive that is unplugged the moment the export lock comes back: from then
/// on nothing answers, as with the cable pulled.
actor UnpluggingBackend: DistributorBackend {
  let archive: ArchiveBackend
  private var unplug: (@Sendable () -> Void)?
  private(set) var handedBack = false

  init(archive: ArchiveBackend) {
    self.archive = archive
  }

  func onHandBack(_ unplug: @escaping @Sendable () -> Void) {
    self.unplug = unplug
  }

  func identity() -> DirectorIdentity {
    DirectorIdentity(deviceName: "iPad", directorVersion: "test", directorID: UUID(), isRecording: false)
  }

  func recordings() -> [RecordingListing] { [] }
  func deleteRecordings(_ ids: [Int64]) -> [Int64] { [] }

  func manifest(recordingID: Int64, tracks: [Track]) async throws -> ManifestResponse? {
    try await archive.manifest(recordingID: recordingID, tracks: tracks)
  }

  func startJob(_ request: JobRequest, id: UUID, events: EventHub) throws {}
  func cancelJob(_ id: UUID) {}
  func beginExport() -> UUID { UUID() }

  func endExport(_ id: UUID) {
    handedBack = true
    unplug?()
  }
}

/// What was sent to TeamStation, in order.
actor SentVideos {
  private(set) var sent: [(title: String, kind: String, bytes: Int64)] = []

  func add(title: String, kind: String, bytes: Int64) {
    sent.append((title, kind, bytes))
  }
}

@Suite("An export with the iPad unplugged once its files are in", .serialized)
struct UnpluggedIPadTests {
  @Test("Every file comes off the iPad first; stitching, the combined video and the uploads finish with it gone")
  @MainActor
  func finishesWithoutTheIPad() async throws {
    let base = FileManager.default.temporaryDirectory
      .appendingPathComponent("unplugged-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: base) }
    let archives = base.appendingPathComponent("iPad/Archives", isDirectory: true)
    let program = base.appendingPathComponent("iPad/Program", isDirectory: true)
    let prepared = base.appendingPathComponent("iPad/Prepared", isDirectory: true)
    for folder in [ archives, program, prepared ] {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    // Two cameras, three seconds each.
    let index = try ArchiveIndex(url: base.appendingPathComponent("iPad/index.sqlite"))
    let recordingID = try index.beginRecording(at: WallClock(seconds: 1_000))
    let a = SourceID("cam-a")
    let b = SourceID("cam-b")
    for source in [ a, b ] {
      let filename = "rec-\(recordingID)/seg-1.mp4"
      let url = archives.appendingPathComponent(source.slug).appendingPathComponent(filename)
      try await MacStitchTests.movie(at: url, frames: 90)
      let bytes = ((try FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.int64Value ?? 0
      try index.insertSegment(
        recordingID: recordingID, sourceID: source, sequence: 1, filename: filename,
        isInitialization: false, startWall: WallClock(seconds: 1_000), duration: 3,
        byteCount: bytes, firstFrameID: 1
      )
    }
    try index.endRecording(recordingID, at: WallClock(seconds: 1_003))
    let exporter = ExportService(index: index, archives: archives, programDirectory: program)
    let roots = FileRoots(archives: archives, program: program, prepared: prepared)
    let backend = UnpluggingBackend(archive: ArchiveBackend(index: index, exporter: exporter, roots: roots))
    let service = DistributorService(
      backend: backend,
      roots: roots,
      settings: DistributorSettingsStore(url: base.appendingPathComponent("settings.json"))
    )
    let server = LinkServer(port: 0) { await service.handle($0) }
    let port = try await server.start()
    defer { server.stop() }
    await backend.onHandBack { server.stop() }
    let connection = DirectorConnection(baseURL: URL(string: "http://127.0.0.1:\(port)/")!, macID: "MAC")

    let summary = try #require(try index.recordings().first)
    let recording = RecordingListing(
      id: recordingID, startedAt: summary.startedAt, endedAt: summary.endedAt, isLive: false, hasPrimary: false,
      cameras: [
        CameraListing(sourceID: a, name: "home", isNamed: true, bytes: 0),
        CameraListing(sourceID: b, name: "away", isNamed: true, bytes: 0)
      ],
      preparedTracks: []
    )
    // An export that never finished left its work folder behind; the next one clears it.
    let stale = [
      DistributionRun.folder(for: recording, in: base.appendingPathComponent("Mac", isDirectory: true))
        .appendingPathComponent(".tsDistributor-work-stale", isDirectory: true)
    ]
    for folder in stale { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }
    let sent = SentVideos()
    let run = DistributionRun(
      recording: recording,
      tracks: [ .camera(a), .camera(b) ],
      connection: connection,
      jobs: JobWatcher(),
      destination: base.appendingPathComponent("Mac", isDirectory: true),
      combined: CombinedPlan(
        inputs: [ (name: "home", track: .camera(a)), (name: "away", track: .camera(b)) ],
        frames: [
          "home": CGRect(x: 0, y: 540, width: 1920, height: 1080),
          "away": CGRect(x: 1920, y: 540, width: 1920, height: 1080)
        ],
        audioCamera: nil
      ),
      teamStation: TeamStationPlan(
        gameId: "gam_test",
        title: "2026-01-01 Home at Away",
        tracks: [ .camera("home"), .camera("away"), .combined ]
      ) { file, title, kind, _ in
        await sent.add(title: title, kind: kind, bytes: DistributionRunTestSupport.size(of: file))
        return "vid_\(kind)"
      }
    )

    // Watched while it runs: no file is stitched while another is still coming off the iPad.
    var stitchedWhileFetching = false
    let watching = Task { @MainActor in
      while !run.isFinished {
        let states = run.tracks.map { run.states[$0] ?? .queued }
        let fetching = states.contains { state in
          switch state {
          case .queued, .fetching: true
          default: false
          }
        }
        let stitching = states.contains { state in
          switch state {
          case .stitching, .done: true
          default: false
          }
        }
        if fetching && stitching { stitchedWhileFetching = true }
        try? await Task.sleep(for: .milliseconds(1))
      }
    }
    await run.run()
    await watching.value

    #expect(await backend.handedBack)
    // The segments waited beside the files, and went with the export.
    let left = try FileManager.default.contentsOfDirectory(atPath: run.folder.path)
    #expect(!left.contains { $0.hasPrefix(".tsDistributor-work-") })
    #expect(!stale.map { FileManager.default.fileExists(atPath: $0.path) }.contains(true))
    #expect(!stitchedWhileFetching)
    for track in run.tracks {
      guard case .done(let url) = run.states[track] else {
        Issue.record("\(track) did not finish: \(String(describing: run.states[track]))")
        continue
      }
      #expect(DistributionRunTestSupport.size(of: url) > 0)
    }
    guard case .done = run.combinedState else {
      Issue.record("the combined video did not finish: \(String(describing: run.combinedState))")
      return
    }
    for track in run.teamStation?.tracks ?? [] {
      #expect(run.uploadStates[track] == .done)
    }
    let videos = await sent.sent
    #expect(videos.map(\.kind) == [ "home", "away", "combined" ])
    #expect(videos.allSatisfy { $0.bytes > 0 })
  }
}

enum DistributionRunTestSupport {
  static func size(of url: URL) -> Int64 {
    ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.int64Value ?? 0
  }
}
