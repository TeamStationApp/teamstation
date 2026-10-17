import DirectorCore
import DirectorExport
import DirectorLink
import DirectorPipeline
import DistributorWire
import Foundation
import Testing

@testable import DirectorUI

/// What TS Director lists to TS Distributor about each take, read from a real index.
///
/// The server clock offset is the part that matters here: TS Distributor sends it with every
/// upload of the take, so the server places the videos on its own clock, where the game's scoring
/// is. A take the iPad never measured lists none, and its uploads say nothing.
@Suite("A take's listing for TS Distributor")
struct DistributorListingTests {
  private func scratch() throws -> (URL, ArchiveIndex, FileRoots) {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("listing-\(UUID().uuidString)", isDirectory: true)
    let roots = FileRoots(
      archives: root.appendingPathComponent("archives", isDirectory: true),
      program: root.appendingPathComponent("program", isDirectory: true),
      prepared: root.appendingPathComponent("prepared", isDirectory: true)
    )
    for folder in [ roots.archives, roots.program, roots.prepared ] {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }
    return (root, try ArchiveIndex(url: root.appendingPathComponent("index.sqlite")), roots)
  }

  private func listings(_ index: ArchiveIndex, roots: FileRoots, liveID: Int64? = nil) throws -> [Int64: RecordingListing] {
    var out: [Int64: RecordingListing] = [:]
    for summary in try index.recordings() {
      out[summary.id] = DistributorLinkBackend.listing(
        for: summary,
        recordedNames: try index.recordedCameraNames(recordingID: summary.id),
        liveNames: [:],
        bytes: [:],
        isLive: summary.id == liveID,
        roots: roots
      )
    }
    return out
  }

  @Test("Each take lists the median of the server clock samples inside it, and a take with none lists nil")
  func listsTheTakesOffset() throws {
    let (root, index, roots) = try scratch()
    defer { try? FileManager.default.removeItem(at: root) }

    let measured = try index.beginRecording(at: WallClock(seconds: 1_000))
    try index.endRecording(measured, at: WallClock(seconds: 1_200))
    for (wall, offset) in [ (1_000.0, 310), (1_060, 290), (1_120, 900), (1_180, 300) ] {
      try index.insertServerClockSample(ServerClockRecord(wall: WallClock(seconds: wall), offsetMs: offset, rttMs: 40))
    }
    let other = try index.beginRecording(at: WallClock(seconds: 5_000))
    try index.endRecording(other, at: WallClock(seconds: 5_100))
    try index.insertServerClockSample(ServerClockRecord(wall: WallClock(seconds: 5_050), offsetMs: -75, rttMs: 30))

    let listed = try listings(index, roots: roots)

    // 290 300 310 900: (300 + 310) / 2.
    #expect(listed[measured]?.serverClockOffsetMs == 305)
    #expect(listed[other]?.serverClockOffsetMs == -75)
  }

  @Test("An iPad that never measured lists no offset")
  func neverMeasured() throws {
    let (root, index, roots) = try scratch()
    defer { try? FileManager.default.removeItem(at: root) }
    let take = try index.beginRecording(at: WallClock(seconds: 1_000))
    try index.endRecording(take, at: WallClock(seconds: 1_200))

    #expect(try listings(index, roots: roots)[take]?.serverClockOffsetMs == nil)
  }

  @Test("The rest of the listing is the take's, as before")
  func restOfTheListing() throws {
    let (root, index, roots) = try scratch()
    defer { try? FileManager.default.removeItem(at: root) }
    let take = try index.beginRecording(at: WallClock(seconds: 1_000))
    try index.setGame(take, gameId: "gam_1", title: "2026-09-20 Home at Away")
    try index.setProgramFilename("rec-programme.mov", for: take)
    let home = SourceID("cam-home")
    let away = SourceID("cam-away")
    for (sequence, source) in [ home, away ].enumerated() {
      try index.insertSegment(
        recordingID: take, sourceID: source, sequence: sequence, filename: "seg-\(sequence).m4s",
        isInitialization: false, startWall: WallClock(seconds: 1_000), duration: 2, byteCount: 10,
        firstFrameID: nil
      )
    }
    try index.noteSource(recordingID: take, sourceID: home, transport: "rtsp", archiving: true, cameraName: "Home")
    try Data("{}\n".utf8).write(to: roots.program.appendingPathComponent(TakeTelemetryLog.filename(for: take)))

    let listing = try #require(try listings(index, roots: roots, liveID: take)[take])

    #expect(listing.isLive)
    #expect(listing.hasPrimary)
    #expect(listing.gameId == "gam_1")
    #expect(listing.gameTitle == "2026-09-20 Home at Away")
    #expect(listing.soundShortfall == nil)
    #expect(listing.telemetry?.path == TakeTelemetryLog.filename(for: take))
    #expect(listing.preparedTracks.isEmpty)
    // The name it recorded under; a camera with none lists its id.
    #expect(listing.cameras.map(\.name) == [ "cam-away", "Home" ])
    #expect(listing.cameras.map(\.isNamed) == [ false, true ])
  }
}
