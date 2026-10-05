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
  private(set) var locksGranted = 0

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
  func beginExport() -> UUID {
    locksGranted += 1
    return UUID()
  }

  func endExport(_ id: UUID) {
    handedBack = true
    unplug?()
  }
}

/// What was sent to TeamStation, in order.
actor SentVideos {
  private(set) var sent: [(game: String, title: String, kind: String, bytes: Int64)] = []

  func add(game: String = "", title: String, kind: String, bytes: Int64) {
    sent.append((game, title, kind, bytes))
  }
}

/// An iPad on a loopback link, with an archive of takes of two cameras each, three seconds long,
/// that is unplugged the moment the export lock comes back.
struct FakeIPad {
  static let home = SourceID("cam-a")
  static let away = SourceID("cam-b")

  let backend: UnpluggingBackend
  let server: LinkServer
  let connection: DirectorConnection
  let recordings: [RecordingListing]

  /// One take starting at each of `starts`, in seconds of wall clock.
  static func start(in base: URL, takesAt starts: [Double]) async throws -> FakeIPad {
    let archives = base.appendingPathComponent("iPad/Archives", isDirectory: true)
    let program = base.appendingPathComponent("iPad/Program", isDirectory: true)
    let prepared = base.appendingPathComponent("iPad/Prepared", isDirectory: true)
    for folder in [ archives, program, prepared ] {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }
    let index = try ArchiveIndex(url: base.appendingPathComponent("iPad/index.sqlite"))
    for start in starts {
      let recordingID = try index.beginRecording(at: WallClock(seconds: start))
      for source in [ home, away ] {
        let filename = "rec-\(recordingID)/seg-1.mp4"
        let url = archives.appendingPathComponent(source.slug).appendingPathComponent(filename)
        try await MacStitchTests.movie(at: url, frames: 90)
        try index.insertSegment(
          recordingID: recordingID, sourceID: source, sequence: 1, filename: filename,
          isInitialization: false, startWall: WallClock(seconds: start), duration: 3,
          byteCount: DistributionRunTestSupport.size(of: url), firstFrameID: 1
        )
      }
      try index.endRecording(recordingID, at: WallClock(seconds: start + 3))
    }
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
    await backend.onHandBack { server.stop() }
    let recordings = try index.recordings().sorted { $0.id < $1.id }.map { summary in
      RecordingListing(
        id: summary.id, startedAt: summary.startedAt, endedAt: summary.endedAt, isLive: false, hasPrimary: false,
        cameras: [
          CameraListing(sourceID: home, name: "home", isNamed: true, bytes: 0),
          CameraListing(sourceID: away, name: "away", isNamed: true, bytes: 0)
        ],
        preparedTracks: []
      )
    }
    return FakeIPad(
      backend: backend,
      server: server,
      connection: DirectorConnection(baseURL: URL(string: "http://127.0.0.1:\(port)/")!, macID: "MAC"),
      recordings: recordings
    )
  }

  /// Both cameras side by side.
  static let combined = CombinedPlan(
    inputs: [ (name: "home", track: .camera(home)), (name: "away", track: .camera(away)) ],
    frames: [
      "home": CGRect(x: 0, y: 540, width: 1920, height: 1080),
      "away": CGRect(x: 1920, y: 540, width: 1920, height: 1080)
    ],
    audioCamera: nil
  )
}

/// Watches exports while they run, and remembers whether any file was stitched while another was
/// still to come off the iPad, or before the iPad was let go.
@MainActor
final class StepWatcher {
  private(set) var stitchedWhileFetching = false
  private(set) var stitchedBeforeLettingGo = false

  func watch(_ runs: [DistributionRun], batch: DistributionBatch? = nil) -> Task<Void, Never> {
    Task { @MainActor in
      while !runs.allSatisfy(\.isFinished) {
        let states = runs.flatMap { run in run.tracks.map { run.states[$0] ?? .queued } }
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
        if fetching && stitching { self.stitchedWhileFetching = true }
        if stitching, let batch, !batch.isDoneWithIPad { self.stitchedBeforeLettingGo = true }
        try? await Task.sleep(for: .milliseconds(1))
      }
    }
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
    let iPad = try await FakeIPad.start(in: base, takesAt: [ 1_000 ])
    defer { iPad.server.stop() }
    let recording = try #require(iPad.recordings.first)
    let (a, b) = (FakeIPad.home, FakeIPad.away)

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
      connection: iPad.connection,
      jobs: JobWatcher(),
      destination: base.appendingPathComponent("Mac", isDirectory: true),
      combined: FakeIPad.combined,
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
    let watcher = StepWatcher()
    let watching = watcher.watch([ run ])
    await run.run()
    await watching.value

    #expect(await iPad.backend.handedBack)
    // The segments waited beside the files, and went with the export.
    let left = try FileManager.default.contentsOfDirectory(atPath: run.folder.path)
    #expect(!left.contains { $0.hasPrefix(".tsDistributor-work-") })
    #expect(!stale.map { FileManager.default.fileExists(atPath: $0.path) }.contains(true))
    #expect(!watcher.stitchedWhileFetching)
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

  @Test("Several takes: every file of every take comes off the iPad before any is stitched, and the rest finishes with it gone")
  @MainActor
  func severalTakesFinishWithoutTheIPad() async throws {
    let base = FileManager.default.temporaryDirectory
      .appendingPathComponent("unplugged-takes-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: base) }
    // Two takes on one day, which share a folder, and one the next day.
    let iPad = try await FakeIPad.start(in: base, takesAt: [ 1_000, 2_000, 90_000 ])
    defer { iPad.server.stop() }
    let destination = base.appendingPathComponent("Mac", isDirectory: true)
    let sent = SentVideos()
    let tracks: [Track] = [ .camera(FakeIPad.home), .camera(FakeIPad.away) ]
    // Each take to a game of its own; only the second makes a combined video.
    let runs = iPad.recordings.enumerated().map { number, recording in
      let game = "gam_\(number + 1)"
      return DistributionRun(
        recording: recording,
        tracks: tracks,
        connection: iPad.connection,
        jobs: JobWatcher(),
        destination: destination,
        combined: number == 1 ? FakeIPad.combined : nil,
        teamStation: TeamStationPlan(
          gameId: game,
          title: "Game \(number + 1)",
          tracks: [ .camera("home") ] + (number == 1 ? [ .combined ] : [])
        ) { file, title, kind, _ in
          await sent.add(game: game, title: title, kind: kind, bytes: DistributionRunTestSupport.size(of: file))
          return "vid_\(kind)"
        }
      )
    }
    #expect(runs.count == 3)
    let batch = DistributionBatch(runs: runs, connection: iPad.connection)

    let watcher = StepWatcher()
    let watching = watcher.watch(runs, batch: batch)
    await batch.run()
    await watching.value

    // One export lock for every take, handed back before anything was stitched.
    #expect(await iPad.backend.locksGranted == 1)
    #expect(await iPad.backend.handedBack)
    #expect(!watcher.stitchedWhileFetching)
    #expect(!watcher.stitchedBeforeLettingGo)
    #expect(batch.isFinished && !batch.wasCancelled && batch.step == .finished)
    for run in runs {
      #expect(run.isFinished)
      for track in run.tracks {
        guard case .done(let url) = run.states[track] else {
          Issue.record("\(run.recording.id) \(track) did not finish: \(String(describing: run.states[track]))")
          continue
        }
        #expect(DistributionRunTestSupport.size(of: url) > 0)
      }
      let left = (try? FileManager.default.contentsOfDirectory(atPath: run.folder.path)) ?? []
      #expect(!left.contains { $0.hasPrefix(".tsDistributor-work-") })
    }
    #expect(runs[0].combinedState == nil && runs[2].combinedState == nil)
    guard case .done = runs[1].combinedState else {
      Issue.record("the combined video did not finish: \(String(describing: runs[1].combinedState))")
      return
    }
    // The uploads go last, each take to its own game, in the takes' order.
    let videos = await sent.sent
    #expect(videos.map { "\($0.game) \($0.kind)" } == [ "gam_1 home", "gam_2 home", "gam_2 combined", "gam_3 home" ])
    #expect(videos.allSatisfy { $0.bytes > 0 })
  }

  @Test("Cancelling a batch stops every take, and keeps what is already saved")
  @MainActor
  func cancellingKeepsSavedFiles() async throws {
    let base = FileManager.default.temporaryDirectory
      .appendingPathComponent("cancel-takes-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: base) }
    let iPad = try await FakeIPad.start(in: base, takesAt: [ 1_000, 2_000 ])
    defer { iPad.server.stop() }
    let destination = base.appendingPathComponent("Mac", isDirectory: true)
    // The first take's home camera is already on this Mac.
    let first = iPad.recordings[0]
    let saved = DistributionRun.folder(for: first, in: destination)
      .appendingPathComponent(DistributionRun.filename(for: .camera(FakeIPad.home), of: first))
    try FileManager.default.createDirectory(at: saved.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data(repeating: 1, count: 10).write(to: saved)

    let runs = iPad.recordings.map { recording in
      DistributionRun(
        recording: recording,
        tracks: [ .camera(FakeIPad.home), .camera(FakeIPad.away) ],
        connection: iPad.connection,
        jobs: JobWatcher(),
        destination: destination
      )
    }
    let batch = DistributionBatch(runs: runs, connection: iPad.connection)
    let exporting = Task { await batch.run() }
    // Cancelled through one of its takes, as the window and the API do, once a file is off the
    // iPad and long before stitching one could finish.
    func offTheIPad() -> Bool {
      runs.contains { run in run.tracks.contains { run.states[$0] == .fetched } }
    }
    while !offTheIPad(), !batch.isFinished {
      try await Task.sleep(for: .milliseconds(1))
    }
    runs[0].cancel()
    await exporting.value

    #expect(batch.wasCancelled && runs.allSatisfy(\.wasCancelled))
    #expect(runs[0].states[.camera(FakeIPad.home)] == .done(saved))
    #expect(DistributionRunTestSupport.size(of: saved) == 10)
    for run in runs {
      for track in run.tracks where run.states[track] != .done(saved) {
        #expect(run.states[track] == .failed("Cancelled"))
      }
    }
    #expect(await iPad.backend.handedBack)
  }
}

enum DistributionRunTestSupport {
  static func size(of url: URL) -> Int64 {
    ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.int64Value ?? 0
  }
}
