import AVFoundation
import Foundation
import DirectorCore
import DirectorExport
import Testing

/// The Mac stitches from a scratch index loaded with a manifest. These prove the manifest carries
/// what the export reads, and that stitching from the scratch index gives the same file as
/// stitching from the original.
@Suite("Recording manifest", .serialized)
struct RecordingManifestTests {
  private static let cameraA = SourceID("cam-a")
  private static let cameraB = SourceID("cam-b")

  private func temporaryRoot() throws -> URL {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("manifest-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }

  /// A take recorded from 1 000 s to 1 009 s. Camera A has segments at 1 000 s and 1 006 s, with a
  /// gap between them; camera B has one at 1 000 s. The programme has two anchored parts.
  private func take(in root: URL) async throws -> (index: ArchiveIndex, recordingID: Int64) {
    let archives = root.appendingPathComponent("Archives", isDirectory: true)
    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    let recordingID = try index.beginRecording(at: WallClock(seconds: 1_000))
    try index.endRecording(recordingID, at: WallClock(seconds: 1_009))
    try index.setProgramFilename("program-a.mp4,program-a-2.mp4", for: recordingID)

    let segments: [(source: SourceID, sequence: Int, start: Double)] = [
      (Self.cameraA, 1, 1_000),
      (Self.cameraA, 2, 1_006),
      (Self.cameraB, 1, 1_000)
    ]
    for segment in segments {
      let filename = "rec-\(recordingID)/seg-\(segment.sequence).mp4"
      let url = archives
        .appendingPathComponent(segment.source.slug, isDirectory: true)
        .appendingPathComponent(filename)
      try await TestMovie.write(to: url, frames: 90)
      let bytes = (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?
        .int64Value ?? 0
      try index.insertSegment(
        recordingID: recordingID,
        sourceID: segment.source,
        sequence: segment.sequence,
        filename: filename,
        isInitialization: false,
        startWall: WallClock(seconds: segment.start),
        duration: 3,
        byteCount: bytes,
        firstFrameID: UInt64(segment.sequence * 100),
        transport: "rtsp",
        appliedClockOffset: 0.012,
        archiveRate: 30
      )
    }
    try index.insertProgramAnchor(recordingID: recordingID, part: 1, programSeconds: 0, wall: WallClock(seconds: 1_000.02))
    try index.insertProgramAnchor(recordingID: recordingID, part: 1, programSeconds: 3, wall: WallClock(seconds: 1_003.01))
    try index.insertProgramAnchor(recordingID: recordingID, part: 2, programSeconds: 0, wall: WallClock(seconds: 1_006.4))
    return (index, recordingID)
  }

  @Test("Only the named cameras' rows travel, and they arrive unchanged")
  func manifestRoundTrip() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let (index, recordingID) = try await take(in: root)

    let manifest = try #require(try index.manifest(recordingID: recordingID, sourceIDs: [ Self.cameraA ]))
    #expect(manifest.segments.count == 2)
    #expect(manifest.segments.allSatisfy { $0.sourceID == Self.cameraA })
    #expect(manifest.programAnchors.count == 3)

    let wire = try JSONDecoder().decode(RecordingManifest.self, from: JSONEncoder().encode(manifest))
    #expect(wire == manifest)

    let scratch = try ArchiveIndex(url: root.appendingPathComponent("scratch.sqlite"))
    try scratch.importManifest(wire)
    #expect(try scratch.allSegments(forRecording: recordingID) == manifest.segments)
    #expect(try scratch.programAnchors(recordingID: recordingID) == manifest.programAnchors)
    #expect(
      try scratch.programPartStarts(recordingID: recordingID)
        == index.programPartStarts(recordingID: recordingID)
    )
    let copied = try #require(try scratch.recordings().first { $0.id == recordingID })
    let original = try #require(try index.recordings().first { $0.id == recordingID })
    #expect(copied.startedAt == original.startedAt)
    #expect(copied.endedAt == original.endedAt)
    #expect(copied.programFilename == original.programFilename)
    #expect(copied.sourceIDs == [ Self.cameraA ])

    // Loading it again replaces rather than duplicates.
    try scratch.importManifest(wire)
    #expect(try scratch.allSegments(forRecording: recordingID).count == 2)
    #expect(try scratch.programAnchors(recordingID: recordingID).count == 3)
  }

  @Test("A scratch index built from a manifest stitches a camera exactly as the original does")
  func scratchStitchesIdentically() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let (index, recordingID) = try await take(in: root)
    let archives = root.appendingPathComponent("Archives", isDirectory: true)
    let program = root.appendingPathComponent("Program", isDirectory: true)
    try FileManager.default.createDirectory(at: program, withIntermediateDirectories: true)

    let exporter = ExportService(index: index, archives: archives, programDirectory: program)
    let recording = try #require(try index.recordings().first { $0.id == recordingID })
    let window = exporter.exportWindow(recording, sourceIDs: [ Self.cameraA, Self.cameraB ])
    let here = try await exporter.exportRecording(
      recording,
      cameras: [ (sourceID: Self.cameraA, name: "A") ],
      includeProgram: false,
      programDirectory: program,
      preparedRoot: root.appendingPathComponent("PreparedHere", isDirectory: true),
      reprocess: true,
      window: window
    )

    // What the Mac does: load the rows, fetch the files into the same layout, and stitch there.
    let mac = root.appendingPathComponent("Mac", isDirectory: true)
    let macArchives = mac.appendingPathComponent("Archives", isDirectory: true)
    let macProgram = mac.appendingPathComponent("Program", isDirectory: true)
    try FileManager.default.createDirectory(at: macProgram, withIntermediateDirectories: true)
    let manifest = try #require(try index.manifest(recordingID: recordingID, sourceIDs: [ Self.cameraA ]))
    let scratch = try ArchiveIndex(url: mac.appendingPathComponent("index.sqlite"))
    try scratch.importManifest(manifest)
    for segment in manifest.segments {
      let relative = "\(segment.sourceID.slug)/\(segment.filename)"
      let destination = macArchives.appendingPathComponent(relative)
      try FileManager.default.createDirectory(
        at: destination.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      try FileManager.default.copyItem(at: archives.appendingPathComponent(relative), to: destination)
    }
    let macExporter = ExportService(index: scratch, archives: macArchives, programDirectory: macProgram)
    let macRecording = try #require(try scratch.recordings().first { $0.id == recordingID })
    let there = try await macExporter.exportRecording(
      macRecording,
      cameras: [ (sourceID: Self.cameraA, name: "A") ],
      includeProgram: false,
      programDirectory: macProgram,
      preparedRoot: mac.appendingPathComponent("Prepared", isDirectory: true),
      reprocess: true,
      window: window
    )

    let hereURL = try #require(here.first)
    let thereURL = try #require(there.first)
    #expect(hereURL.lastPathComponent == thereURL.lastPathComponent)
    let hereTimes = try await TestMovie.videoPresentationTimes(of: hereURL)
    let thereTimes = try await TestMovie.videoPresentationTimes(of: thereURL)
    #expect(!hereTimes.isEmpty)
    #expect(hereTimes == thereTimes)
    let hereLength = try await AVURLAsset(url: hereURL).load(.duration).seconds
    let thereLength = try await AVURLAsset(url: thereURL).load(.duration).seconds
    #expect(abs(hereLength - 9) < 0.35)
    #expect(abs(hereLength - thereLength) < 0.001)
  }

  @Test("A recording the index does not hold has no manifest")
  func unknownRecording() throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    #expect(try index.manifest(recordingID: 42, sourceIDs: [ Self.cameraA ]) == nil)
  }
}
