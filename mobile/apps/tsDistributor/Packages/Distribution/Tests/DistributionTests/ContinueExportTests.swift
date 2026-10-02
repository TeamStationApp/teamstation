import DirectorClient
import DirectorCore
import DirectorExport
import DirectorLink
import Distribution
import DistributorWire
import Foundation
import Testing

/// A TS Director in the middle of a take: it refuses the export lock and counts how often it was
/// asked for it.
actor RecordingDirector: DistributorBackend {
  struct Recording: Error {}

  private(set) var lockRequests = 0

  func identity() -> DirectorIdentity {
    DirectorIdentity(deviceName: "iPad", directorVersion: "test", directorID: UUID(), isRecording: true)
  }

  func recordings() -> [RecordingListing] { [] }
  func deleteRecordings(_ ids: [Int64]) -> [Int64] { [] }
  func manifest(recordingID: Int64, tracks: [Track]) throws -> ManifestResponse? { nil }
  func startJob(_ request: JobRequest, id: UUID, events: EventHub) throws {}
  func cancelJob(_ id: UUID) {}

  func beginExport() throws -> UUID {
    lockRequests += 1
    throw Recording()
  }

  func endExport(_ id: UUID) {}
}

@Suite("Continuing an export", .serialized)
struct ContinueExportTests {
  static let camera = SourceID("cam-a")
  static let recording = RecordingListing(
    id: 1, startedAt: WallClock(seconds: 1_000), endedAt: WallClock(seconds: 1_010), isLive: false,
    hasPrimary: true, cameras: [ CameraListing(sourceID: camera, name: "home", isNamed: true, bytes: 10) ],
    preparedTracks: []
  )

  static func temporary(_ name: String) throws -> URL {
    let base = FileManager.default.temporaryDirectory
      .appendingPathComponent("\(name)-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    return base
  }

  /// `bytes` bytes at `name` in the recording's folder under `destination`.
  @discardableResult
  static func place(_ name: String, bytes: Int, in destination: URL) throws -> URL {
    let folder = DistributionRun.folder(for: recording, in: destination)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let file = folder.appendingPathComponent(name)
    try Data(repeating: 1, count: bytes).write(to: file)
    return file
  }

  static func serve(_ director: RecordingDirector, from base: URL) async throws -> (LinkServer, DirectorConnection) {
    let service = DistributorService(
      backend: director,
      roots: FileRoots(
        archives: base.appendingPathComponent("Archives", isDirectory: true),
        program: base.appendingPathComponent("Program", isDirectory: true),
        prepared: base.appendingPathComponent("Prepared", isDirectory: true)
      ),
      settings: DistributorSettingsStore(url: base.appendingPathComponent("settings.json"))
    )
    let server = LinkServer(port: 0) { await service.handle($0) }
    let port = try await server.start()
    return (server, DirectorConnection(baseURL: URL(string: "http://127.0.0.1:\(port)/")!, macID: "MAC"))
  }

  @Test("The inventory reads what is already on this Mac: whole files, cut-off ones, and what is still on the iPad")
  func inventory() throws {
    let destination = try Self.temporary("inventory")
    defer { try? FileManager.default.removeItem(at: destination) }
    try Self.place(DistributionRun.filename(for: .primary, of: Self.recording), bytes: 5, in: destination)
    try Self.place(DistributionRun.filename(for: .camera(Self.camera), of: Self.recording) + ".partial", bytes: 3, in: destination)
    try Self.place(DistributionRun.combinedFilename(of: Self.recording) + ".partial.mov", bytes: 2, in: destination)

    let inventory = ExportInventory(recording: Self.recording, destination: destination)
    #expect(inventory.files[.primary] == .saved(bytes: 5))
    #expect(inventory.files[.camera(Self.camera)] == .interrupted(bytes: 3))
    #expect(inventory.combined == .interrupted(bytes: 2))
    #expect(!inventory.needsIPad([ .primary ]))
    #expect(inventory.needsIPad([ .primary, .camera(Self.camera) ]))
    #expect(inventory.needsIPad([ .primary ], reprocess: true))
    #expect(ExportInventory(recording: Self.recording, destination: destination.appendingPathComponent("elsewhere")).files[.primary] == .missing)
  }

  @Test("With every file already here, an export runs on this Mac alone while TS Director records")
  @MainActor
  func macAlone() async throws {
    let base = try Self.temporary("continue-mac")
    defer { try? FileManager.default.removeItem(at: base) }
    let destination = base.appendingPathComponent("Mac", isDirectory: true)
    let saved = try Self.place(DistributionRun.filename(for: .primary, of: Self.recording), bytes: 5, in: destination)
    let director = RecordingDirector()
    let (server, connection) = try await Self.serve(director, from: base)
    defer { server.stop() }

    let run = DistributionRun(
      recording: Self.recording,
      tracks: [ .primary ],
      connection: connection,
      jobs: JobWatcher(),
      destination: destination
    )
    await run.run()

    #expect(run.isFinished)
    #expect(run.states[.primary] == .done(saved))
    #expect(await director.lockRequests == 0)
  }

  @Test("A combined video already on disk is kept as it is, not made again")
  @MainActor
  func combinedKept() async throws {
    let base = try Self.temporary("continue-combined")
    defer { try? FileManager.default.removeItem(at: base) }
    let destination = base.appendingPathComponent("Mac", isDirectory: true)
    // Not real videos: rendering from them would fail, so a combined video that comes back done,
    // untouched, was not made again.
    try Self.place(DistributionRun.filename(for: .primary, of: Self.recording), bytes: 5, in: destination)
    try Self.place(DistributionRun.filename(for: .camera(Self.camera), of: Self.recording), bytes: 5, in: destination)
    let combined = try Self.place(DistributionRun.combinedFilename(of: Self.recording), bytes: 7, in: destination)
    let before = try FileManager.default.attributesOfItem(atPath: combined.path)
    let director = RecordingDirector()
    let (server, connection) = try await Self.serve(director, from: base)
    defer { server.stop() }

    let run = DistributionRun(
      recording: Self.recording,
      tracks: [ .primary, .camera(Self.camera) ],
      connection: connection,
      jobs: JobWatcher(),
      destination: destination,
      combined: CombinedPlan(
        inputs: [ (name: "Primary output", track: .primary), (name: "home", track: .camera(Self.camera)) ],
        frames: CombinedGeometry.frames(assignment: [ "Primary output": .topLeading, "home": .topTrailing ], solo: nil),
        audioCamera: nil
      )
    )
    await run.run()

    let after = try FileManager.default.attributesOfItem(atPath: combined.path)
    #expect(run.combinedState == .done(combined))
    #expect(after[.size] as? Int == 7)
    #expect(after[.modificationDate] as? Date == before[.modificationDate] as? Date)
    #expect(await director.lockRequests == 0)
  }

  @Test("With no iPad attached, an export whose files are all here runs, combined video and all")
  @MainActor
  func noIPadAllHere() async throws {
    let destination = try Self.temporary("no-ipad-all")
    defer { try? FileManager.default.removeItem(at: destination) }
    let saved = try Self.place(DistributionRun.filename(for: .primary, of: Self.recording), bytes: 5, in: destination)
    try Self.place(DistributionRun.filename(for: .camera(Self.camera), of: Self.recording), bytes: 5, in: destination)
    let combined = try Self.place(DistributionRun.combinedFilename(of: Self.recording), bytes: 7, in: destination)

    let run = DistributionRun(
      recording: Self.recording,
      tracks: [ .primary, .camera(Self.camera) ],
      connection: nil,
      jobs: JobWatcher(),
      destination: destination,
      combined: CombinedPlan.automatic(for: Self.recording, tracks: [ .primary, .camera(Self.camera) ], saved: CombinedLayoutSettings())
    )
    await run.run()

    #expect(run.isFinished)
    #expect(run.states[.primary] == .done(saved))
    #expect(run.combinedState == .done(combined))
  }

  @Test("With no iPad attached, a file not here says so, and what is here stays saved")
  @MainActor
  func noIPadFileMissing() async throws {
    let destination = try Self.temporary("no-ipad-missing")
    defer { try? FileManager.default.removeItem(at: destination) }
    let saved = try Self.place(DistributionRun.filename(for: .primary, of: Self.recording), bytes: 5, in: destination)

    let run = DistributionRun(
      recording: Self.recording,
      tracks: [ .primary, .camera(Self.camera) ],
      connection: nil,
      jobs: JobWatcher(),
      destination: destination
    )
    await run.run()

    #expect(run.isFinished)
    #expect(run.states[.primary] == .done(saved))
    #expect(run.states[.camera(Self.camera)] == .failed(DistributionRun.noIPad))
  }

  @Test("The automatic combined video takes the primary output first, can be narrowed, and needs two videos")
  func automaticCombined() throws {
    let both: [Track] = [ .primary, .camera(Self.camera) ]
    let plan = try #require(CombinedPlan.automatic(for: Self.recording, tracks: both, saved: CombinedLayoutSettings(), audioCamera: "home"))
    #expect(plan.inputs.map(\.name) == [ CombinedLayoutRules.primaryOutputName, "home" ])
    #expect(Set(plan.frames.keys) == [ CombinedLayoutRules.primaryOutputName, "home" ])
    #expect(plan.audioCamera == "home")
    #expect(CombinedPlan.automatic(for: Self.recording, tracks: [ .primary ], saved: CombinedLayoutSettings()) == nil)
    #expect(CombinedPlan.automatic(for: Self.recording, tracks: both, saved: CombinedLayoutSettings(), include: [ "home" ]) == nil)
  }

  @Test("A file still on the iPad waits for it: the lock is refused, and what is already here stays saved")
  @MainActor
  func fileOnIPadWhileRecording() async throws {
    let base = try Self.temporary("continue-ipad")
    defer { try? FileManager.default.removeItem(at: base) }
    let destination = base.appendingPathComponent("Mac", isDirectory: true)
    let saved = try Self.place(DistributionRun.filename(for: .primary, of: Self.recording), bytes: 5, in: destination)
    let director = RecordingDirector()
    let (server, connection) = try await Self.serve(director, from: base)
    defer { server.stop() }

    let run = DistributionRun(
      recording: Self.recording,
      tracks: [ .primary, .camera(Self.camera) ],
      connection: connection,
      jobs: JobWatcher(),
      destination: destination
    )
    await run.run()

    #expect(run.states[.primary] == .done(saved))
    guard case .failed = run.states[.camera(Self.camera)] else {
      Issue.record("the camera did not wait for the iPad: \(String(describing: run.states[.camera(Self.camera)]))")
      return
    }
    #expect(await director.lockRequests == 1)
  }
}
