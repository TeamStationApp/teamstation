import AVFoundation
import Foundation
import DirectorCore
@testable import DirectorExport
import Testing

/// The sound render run on a camera's real archive segments, off the iPad.
///
/// Skipped unless `DIRECTOR_EXPORT_SEGMENTS` names a folder laid out as a stitch's work folder is:
/// `index.sqlite` beside `Archives/<source id>/rec-<id>/seg-*.mp4`. `DIRECTOR_EXPORT_SOURCE` picks the
/// camera when the take has several, `DIRECTOR_EXPORT_LIMIT` renders only that many segments, and
/// `DIRECTOR_EXPORT_OUT` is where the sound goes (the folder's `sound.m4a` unless given).
@Suite("Recorded segments' sound", .serialized)
struct RecordedSegmentsSoundTests {
  static let environment = ProcessInfo.processInfo.environment
  static let folder = environment["DIRECTOR_EXPORT_SEGMENTS"].map { URL(fileURLWithPath: $0, isDirectory: true) }

  @Test("Renders a recorded camera's sound from its segments", .enabled(if: folder != nil))
  func rendersRecordedSound() async throws {
    let folder = try #require(Self.folder)
    let index = try ArchiveIndex(url: folder.appendingPathComponent("index.sqlite"))
    let recording = try #require(try index.recordings().first)
    let sources = try index.sourceIDs(in: recording.id)
    let source = try #require(
      Self.environment["DIRECTOR_EXPORT_SOURCE"].map { SourceID($0) } ?? sources.first
    )
    let end = try #require(recording.endedAt)
    let assembler = SegmentAssembler(index: index, archives: folder.appendingPathComponent("Archives"))
    var assembly = try assembler.mediaFiles(sourceID: source, from: recording.startedAt, to: end)
    var length = end - recording.startedAt
    if let limit = Self.environment["DIRECTOR_EXPORT_LIMIT"].flatMap(Int.init), limit < assembly.files.count {
      // Up to where the first segment left out starts.
      length = assembly.startWalls[limit] - recording.startedAt
      assembly.files = Array(assembly.files.prefix(limit))
      assembly.fileDurations = Array(assembly.fileDurations.prefix(limit))
      assembly.startWalls = Array(assembly.startWalls.prefix(limit))
    }
    let plan = try await ArchiveRemux.place(
      files: assembly.files,
      fileDurations: assembly.fileDurations,
      startWalls: assembly.startWalls,
      windowStart: recording.startedAt,
      length: length
    )
    let out = Self.environment["DIRECTOR_EXPORT_OUT"].map { URL(fileURLWithPath: $0) }
      ?? folder.appendingPathComponent("sound.m4a")
    let span = CMTime(seconds: length, preferredTimescale: 600)
    let started = Date()
    let rendered = try await ArchiveRemux.renderPlacedSound(plan.placements, length: span, to: out, progress: nil)
    #expect(rendered)
    let track = try #require(try await AVURLAsset(url: out).loadTracks(withMediaType: .audio).first)
    let duration = try await track.load(.timeRange).duration.seconds
    print("rendered \(plan.placements.count) segments, \(length) s, to \(out.path) in \(Date().timeIntervalSince(started)) s; track \(duration) s")
  }
}
