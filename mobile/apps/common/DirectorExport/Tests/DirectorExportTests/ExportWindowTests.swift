import AVFoundation
import Foundation
import DirectorCore
import DirectorExport
import Testing

/// When two machines stitch the cameras of one export, every file has to be cut from the same
/// window, or a camera stitched on the Mac comes out a different length from one stitched on the
/// iPad. `exportWindow` computes that window once; `exportRecording(window:)` cuts to it.
@Suite("Export window", .serialized)
struct ExportWindowTests {
  private static let cameraA = SourceID("cam-a")
  private static let cameraB = SourceID("cam-b")

  private struct Take {
    var root: URL
    var exporter: ExportService
    var program: URL
    var prepared: URL
    var recording: RecordingSummary
  }

  /// A take that never recorded its end, starting at 1 000 s. Camera A has three seconds at the
  /// start; camera B has the same three seconds and three more from 1 006 s, so it ends at 1 009 s.
  private func interruptedTake() async throws -> Take {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("export-window-\(UUID().uuidString)", isDirectory: true)
    let archives = root.appendingPathComponent("Archives", isDirectory: true)
    let program = root.appendingPathComponent("Program", isDirectory: true)
    let prepared = root.appendingPathComponent("Prepared", isDirectory: true)
    try FileManager.default.createDirectory(at: program, withIntermediateDirectories: true)

    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    let recordingID = try index.beginRecording(at: WallClock(seconds: 1_000))
    let segments: [(source: SourceID, sequence: Int, start: Double)] = [
      (Self.cameraA, 1, 1_000),
      (Self.cameraB, 1, 1_000),
      (Self.cameraB, 2, 1_006)
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
        firstFrameID: UInt64(segment.sequence)
      )
    }

    let recording = try #require(try index.recordings().first { $0.id == recordingID })
    #expect(recording.endedAt == nil)
    return Take(
      root: root,
      exporter: ExportService(index: index, archives: archives, programDirectory: program),
      program: program,
      prepared: prepared,
      recording: recording
    )
  }

  @Test("An interrupted take's window runs to the last segment of every camera it is given")
  func windowReachesLastCamera() async throws {
    let take = try await interruptedTake()
    defer { try? FileManager.default.removeItem(at: take.root) }

    let alone = take.exporter.exportWindow(take.recording, sourceIDs: [ Self.cameraA ])
    let both = take.exporter.exportWindow(take.recording, sourceIDs: [ Self.cameraA, Self.cameraB ])
    #expect(alone.start == WallClock(seconds: 1_000))
    #expect(alone.end == WallClock(seconds: 1_003))
    #expect(both.start == WallClock(seconds: 1_000))
    #expect(both.end == WallClock(seconds: 1_009))
  }

  @Test("A camera stitched on its own with the shared window is as long as the whole export")
  func sharedWindowSetsLength() async throws {
    let take = try await interruptedTake()
    defer { try? FileManager.default.removeItem(at: take.root) }

    let window = take.exporter.exportWindow(take.recording, sourceIDs: [ Self.cameraA, Self.cameraB ])
    let shared = try await take.exporter.exportRecording(
      take.recording,
      cameras: [ (sourceID: Self.cameraA, name: "A") ],
      includeProgram: false,
      programDirectory: take.program,
      preparedRoot: take.prepared,
      reprocess: true,
      window: window
    )
    let sharedLength = try await AVURLAsset(url: try #require(shared.first)).load(.duration).seconds
    #expect(abs(sharedLength - 9) < 0.35)

    // Left to work its window out alone, the same camera stops where its own tape stops, and no
    // longer lines up with camera B stitched elsewhere.
    let own = try await take.exporter.exportRecording(
      take.recording,
      cameras: [ (sourceID: Self.cameraA, name: "A") ],
      includeProgram: false,
      programDirectory: take.program,
      preparedRoot: take.root.appendingPathComponent("PreparedAlone", isDirectory: true),
      reprocess: true
    )
    let ownLength = try await AVURLAsset(url: try #require(own.first)).load(.duration).seconds
    #expect(abs(ownLength - 3) < 0.35)
  }

  @Test("The window comes back from JSON unchanged, so it can cross to the other machine")
  func windowIsCodable() throws {
    let window = ExportWindow(start: WallClock(seconds: 1_000.25), end: WallClock(seconds: 1_009.5))
    let decoded = try JSONDecoder().decode(ExportWindow.self, from: JSONEncoder().encode(window))
    #expect(decoded == window)
    let open = ExportWindow(start: WallClock(seconds: 1_000), end: nil)
    #expect(try JSONDecoder().decode(ExportWindow.self, from: JSONEncoder().encode(open)) == open)
  }
}
