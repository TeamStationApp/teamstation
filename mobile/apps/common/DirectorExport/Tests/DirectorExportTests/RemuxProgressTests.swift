import Foundation
import DirectorCore
import DirectorExport
import Testing

/// A stitch reports how far along it is, not only that it finished, so a progress bar can fill.
@Suite("Remux progress", .serialized)
struct RemuxProgressTests {
  final class Heard: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Double] = []

    func add(_ value: Double) { lock.withLock { values.append(value) } }
    var all: [Double] { lock.withLock { values } }
  }

  final class HeardItems: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [ExportService.ItemProgress] = []

    func add(_ item: ExportService.ItemProgress) { lock.withLock { items.append(item) } }
    var all: [ExportService.ItemProgress] { lock.withLock { items } }
  }

  private func temporaryRoot() throws -> URL {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("remux-progress-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }

  @Test("Progress only moves forward, stays between 0 and 1, and finishes at 1")
  func progressMovesForward() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let first = root.appendingPathComponent("a.mp4")
    let second = root.appendingPathComponent("b.mp4")
    try await TestMovie.write(to: first, frames: 90)
    try await TestMovie.write(to: second, frames: 90)

    let heard = Heard()
    try await ArchiveRemux.concatenate(
      files: [ first, second ],
      fileDurations: [ 3, 3 ],
      targetDuration: 10,
      startWalls: [ WallClock(seconds: 1_000), WallClock(seconds: 1_006) ],
      windowStart: WallClock(seconds: 1_000),
      destination: root.appendingPathComponent("out.mp4"),
      progress: { heard.add($0) }
    )

    let values = heard.all
    #expect(!values.isEmpty)
    #expect(values.last == 1)
    #expect(values.allSatisfy { $0 >= 0 && $0 <= 1 })
    #expect(zip(values, values.dropFirst()).allSatisfy { $0 <= $1 })
  }

  @Test("A single file copied as it is still reports that it finished")
  func copyReportsFinished() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let only = root.appendingPathComponent("only.mp4")
    try await TestMovie.write(to: only, frames: 30)

    let heard = Heard()
    try await ArchiveRemux.concatenate(
      files: [ only ],
      fileDurations: [ 1 ],
      destination: root.appendingPathComponent("copy.mp4"),
      progress: { heard.add($0) }
    )
    #expect(heard.all == [ 1 ])
  }

  @Test("Each file of a recording export reports its own progress, from 0 to 1")
  func exportReportsPerFile() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let archives = root.appendingPathComponent("Archives", isDirectory: true)
    let program = root.appendingPathComponent("Program", isDirectory: true)
    try FileManager.default.createDirectory(at: program, withIntermediateDirectories: true)

    // Three seconds of tape in a six-second take, so the file is placed rather than copied.
    let camera = SourceID("cam-a")
    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    let recordingID = try index.beginRecording(at: WallClock(seconds: 1_000))
    try index.endRecording(recordingID, at: WallClock(seconds: 1_006))
    let filename = "rec-\(recordingID)/seg-1.mp4"
    try await TestMovie.write(
      to: archives
        .appendingPathComponent(camera.slug, isDirectory: true)
        .appendingPathComponent(filename),
      frames: 90
    )
    try index.insertSegment(
      recordingID: recordingID,
      sourceID: camera,
      sequence: 1,
      filename: filename,
      isInitialization: false,
      startWall: WallClock(seconds: 1_000),
      duration: 3,
      byteCount: 1,
      firstFrameID: 1
    )
    let recording = try #require(try index.recordings().first)

    let heard = HeardItems()
    _ = try await ExportService(index: index, archives: archives, programDirectory: program)
      .exportRecording(
        recording,
        cameras: [ (sourceID: camera, name: "A") ],
        includeProgram: false,
        programDirectory: program,
        preparedRoot: root.appendingPathComponent("Prepared", isDirectory: true),
        reprocess: true,
        progress: { heard.add($0) }
      )

    let items = heard.all
    #expect(items.allSatisfy { $0.id == camera.rawValue })
    let fractions = items.map(\.fraction)
    #expect(fractions.first == 0)
    #expect(fractions.last == 1)
    #expect(zip(fractions, fractions.dropFirst()).allSatisfy { $0 <= $1 })
  }
}
