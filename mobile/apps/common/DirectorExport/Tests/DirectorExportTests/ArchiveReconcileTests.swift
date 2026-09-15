import Foundation
import DirectorCore
import DirectorExport
import Testing

/// Launch reconciles only the takes a kill could have cut off mid-segment. The whole archive is
/// tens of thousands of files on a working iPad, too many to check before the launch watchdog
/// gives up on the first screen, so it runs later and these rules keep the two passes apart.
@Suite("Archive reconcile")
struct ArchiveReconcileTests {
  private let camera = SourceID("cam-1")

  @Test("Scoped to a take, reconcile touches only that take's rows and rec folder")
  func scopedToTake() throws {
    let (index, archives) = try makeArchive()
    let closed = try index.beginRecording(at: WallClock(seconds: 1_000))
    let open = try index.beginRecording(at: WallClock(seconds: 2_000))

    try addSegment(index, recording: closed, sequence: 1, onDisk: false, archives: archives)
    try write(archives, "rec-\(closed)/left-over.mp4")
    try addSegment(index, recording: open, sequence: 1, onDisk: true, archives: archives)
    try addSegment(index, recording: open, sequence: 2, onDisk: false, archives: archives)
    try write(archives, "rec-\(open)/cut-off.mp4")

    let scoped = try index.reconcile(recordings: [open], archivesRoot: archives)
    #expect(scoped.removed == 1)
    #expect(scoped.orphans.map(\.lastPathComponent) == ["cut-off.mp4"])

    // The closed take's missing row and stray file were left for the whole-archive pass.
    let whole = try index.reconcile(archivesRoot: archives)
    #expect(whole.removed == 1)
    #expect(Set(whole.orphans.map(\.lastPathComponent)) == ["left-over.mp4", "cut-off.mp4"])
  }

  @Test("No open takes means nothing to check")
  func emptyScope() throws {
    let (index, archives) = try makeArchive()
    let id = try index.beginRecording(at: WallClock(seconds: 1_000))
    try addSegment(index, recording: id, sequence: 1, onDisk: false, archives: archives)

    let scoped = try index.reconcile(recordings: [], archivesRoot: archives)
    #expect(scoped.removed == 0)
    #expect(scoped.orphans.isEmpty)
    #expect(try index.reconcile(archivesRoot: archives).removed == 1)
  }

  @Test("Open takes are the ones with no end")
  func openTakes() throws {
    let (index, _) = try makeArchive()
    let ended = try index.beginRecording(at: WallClock(seconds: 1_000))
    let rolling = try index.beginRecording(at: WallClock(seconds: 2_000))
    try index.endRecording(ended, at: WallClock(seconds: 1_500))

    #expect(try index.openRecordingIDs() == [rolling])
  }

  // MARK: - Helpers

  private func makeArchive() throws -> (ArchiveIndex, URL) {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("reconcile-\(UUID().uuidString)", isDirectory: true)
    let archives = root.appendingPathComponent("Archives", isDirectory: true)
    try FileManager.default.createDirectory(at: archives, withIntermediateDirectories: true)
    return (try ArchiveIndex(url: root.appendingPathComponent("index.sqlite")), archives)
  }

  private func addSegment(
    _ index: ArchiveIndex,
    recording: Int64,
    sequence: Int,
    onDisk: Bool,
    archives: URL
  ) throws {
    let filename = "rec-\(recording)/seg-\(sequence).mp4"
    _ = try index.insertSegment(
      recordingID: recording,
      sourceID: camera,
      sequence: sequence,
      filename: filename,
      isInitialization: false,
      startWall: WallClock(seconds: Double(sequence) * 3),
      duration: 3,
      byteCount: 1_024,
      firstFrameID: nil
    )
    if onDisk { try write(archives, filename) }
  }

  private func write(_ archives: URL, _ filename: String) throws {
    let url = archives.appendingPathComponent(camera.slug, isDirectory: true)
      .appendingPathComponent(filename)
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try Data([0]).write(to: url)
  }
}
