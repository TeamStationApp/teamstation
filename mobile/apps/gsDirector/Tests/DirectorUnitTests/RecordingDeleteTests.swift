import Foundation
import DirectorCore
import DirectorDVR
import Testing

@Suite("Recording delete")
struct RecordingDeleteTests {
  @Test("Deleting one recording leaves the other index rows and files")
  func deleteOneKeepsTheOther() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("rec-del-\(UUID().uuidString)", isDirectory: true)
    let archives = root.appendingPathComponent("Archives", isDirectory: true)
    let program = root.appendingPathComponent("Program", isDirectory: true)
    let proxies = root.appendingPathComponent("Proxies", isDirectory: true)
    let prepared = root.appendingPathComponent("Prepared", isDirectory: true)
    try FileManager.default.createDirectory(at: archives, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: program, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: proxies, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: prepared, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    let source = SourceID("cam-0")
    let camDir = archives.appendingPathComponent(source.slug, isDirectory: true)
    let proxyDir = proxies.appendingPathComponent(source.slug, isDirectory: true)
    try FileManager.default.createDirectory(at: camDir, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: proxyDir, withIntermediateDirectories: true)
    let roots = RecordingFileRoots(
      archives: archives,
      program: program,
      proxies: proxies,
      prepared: prepared
    )

    let keep = try seed(
      index: index,
      source: source,
      camDir: camDir,
      programDir: program,
      proxyDir: proxyDir,
      start: 1_000,
      name: "keep",
      chunk: "keep.bin"
    )
    let drop = try seed(
      index: index,
      source: source,
      camDir: camDir,
      programDir: program,
      proxyDir: proxyDir,
      start: 2_000,
      name: "drop",
      chunk: "drop.bin"
    )

    let dropPrepared = prepared.appendingPathComponent("rec-\(drop)", isDirectory: true)
    let keepPrepared = prepared.appendingPathComponent("rec-\(keep)", isDirectory: true)
    try FileManager.default.createDirectory(at: dropPrepared, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: keepPrepared, withIntermediateDirectories: true)
    try Data("prepared-drop".utf8).write(to: dropPrepared.appendingPathComponent("drop.mov"))
    try Data("prepared-keep".utf8).write(to: keepPrepared.appendingPathComponent("keep.mov"))

    try index.deleteRecordings(ids: [drop], roots: roots)

    let remaining = try index.recordings()
    #expect(remaining.map(\.id) == [keep])
    #expect(try index.segments(forRecording: keep).count == 1)
    #expect(try index.segments(forRecording: drop).isEmpty)
    #expect(try index.proxyStillCount(for: source) == 1)

    #expect(FileManager.default.fileExists(atPath: camDir.appendingPathComponent("keep.mp4").path))
    #expect(FileManager.default.fileExists(atPath: program.appendingPathComponent("keep.mov").path))
    #expect(FileManager.default.fileExists(atPath: proxyDir.appendingPathComponent("keep.bin").path))
    #expect(FileManager.default.fileExists(atPath: keepPrepared.appendingPathComponent("keep.mov").path))
    #expect(!FileManager.default.fileExists(atPath: camDir.appendingPathComponent("drop.mp4").path))
    #expect(!FileManager.default.fileExists(atPath: program.appendingPathComponent("drop.mov").path))
    #expect(!FileManager.default.fileExists(atPath: proxyDir.appendingPathComponent("drop.bin").path))
    #expect(!FileManager.default.fileExists(atPath: dropPrepared.path))
  }

  @Test("The live recording id is not deleted")
  func skipsLiveRecording() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("rec-live-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    let live = try index.beginRecording(at: WallClock(seconds: 1_000))
    let other = try index.beginRecording(at: WallClock(seconds: 2_000))
    try index.endRecording(other, at: WallClock(seconds: 2_010))

    try index.deleteRecordings(ids: [live, other], skipping: live)

    #expect(try index.recordings().map(\.id) == [live])
  }

  private func seed(
    index: ArchiveIndex,
    source: SourceID,
    camDir: URL,
    programDir: URL,
    proxyDir: URL,
    start: Double,
    name: String,
    chunk: String
  ) throws -> Int64 {
    let id = try index.beginRecording(at: WallClock(seconds: start))
    try index.endRecording(id, at: WallClock(seconds: start + 10))
    try index.setProgramFilename("\(name).mov", for: id)
    try Data("seg-\(name)".utf8).write(to: camDir.appendingPathComponent("\(name).mp4"))
    try Data("prog-\(name)".utf8).write(to: programDir.appendingPathComponent("\(name).mov"))
    try Data("chunk-\(name)".utf8).write(to: proxyDir.appendingPathComponent(chunk))
    try index.insertSegment(
      recordingID: id,
      sourceID: source,
      sequence: 1,
      filename: "\(name).mp4",
      isInitialization: false,
      startWall: WallClock(seconds: start),
      duration: 10,
      byteCount: 4,
      firstFrameID: 1
    )
    try index.insertProxyStill(
      sourceID: source,
      wall: WallClock(seconds: start + 1),
      chunk: chunk,
      offset: 0,
      length: 8
    )
    return id
  }
}
