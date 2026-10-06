import DirectorClient
import DirectorCore
import DirectorLink
import Distribution
import DistributorWire
import Foundation
import Testing

/// TS Distributor saves a take's telemetry log beside its files (U-D6).
@Suite("Take telemetry fetch", .serialized)
struct TakeTelemetryFetchTests {
  static let camera = SourceID("cam-a")

  @Test("A take's telemetry is saved beside its files, without the export lock")
  @MainActor
  func savedBesideTheTake() async throws {
    let base = try ContinueExportTests.temporary("telemetry-fetch")
    defer { try? FileManager.default.removeItem(at: base) }
    let program = base.appendingPathComponent("Program", isDirectory: true)
    try FileManager.default.createDirectory(at: program, withIntermediateDirectories: true)
    let lines = "{\"t\":1000}\n{\"t\":1001}\n"
    try Data(lines.utf8).write(to: program.appendingPathComponent("rec-1-telemetry.jsonl"))
    var recording = ContinueExportTests.recording
    recording.telemetry = RemoteFile(root: .program, path: "rec-1-telemetry.jsonl", bytes: Int64(lines.utf8.count))
    let destination = base.appendingPathComponent("Mac", isDirectory: true)
    let folder = DistributionRun.folder(for: recording, in: destination)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    try Data(repeating: 1, count: 5).write(to: folder.appendingPathComponent(DistributionRun.filename(for: .primary, of: recording)))

    let director = RecordingDirector()
    let (server, connection) = try await ContinueExportTests.serve(director, from: base)
    defer { server.stop() }
    let run = DistributionRun(recording: recording, tracks: [ .primary ], connection: connection, jobs: JobWatcher(), destination: destination)
    await run.run()

    let saved = try #require(run.telemetryFile)
    #expect(saved.lastPathComponent == "1970-01-01-00-16-40-telemetry.jsonl" || saved.lastPathComponent.hasSuffix("-telemetry.jsonl"))
    #expect(saved.deletingLastPathComponent().standardizedFileURL == folder.standardizedFileURL)
    #expect(try String(contentsOf: saved, encoding: .utf8) == lines)
    #expect(await director.lockRequests == 0)
  }

  @Test("A take with no telemetry, or a Director from before it, saves none")
  @MainActor
  func noneWithout() async throws {
    let old = #"{"id":1,"startedAt":{"seconds":1000},"isLive":false,"hasPrimary":true,"cameras":[],"preparedTracks":[]}"#
    let decoded = try JSONDecoder().decode(RecordingListing.self, from: Data(old.utf8))
    #expect(decoded.telemetry == nil)

    let destination = try ContinueExportTests.temporary("telemetry-none")
    defer { try? FileManager.default.removeItem(at: destination) }
    let run = DistributionRun(recording: ContinueExportTests.recording, tracks: [], connection: nil, jobs: JobWatcher(), destination: destination)
    await run.run()
    #expect(run.telemetryFile == nil)
    #expect(DistributionRun.telemetryFilename(of: ContinueExportTests.recording).hasSuffix("-telemetry.jsonl"))
  }
}
