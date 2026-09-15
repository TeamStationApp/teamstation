import Foundation
import DirectorCore
import DirectorExport
import Testing

@Suite("Recording export names")
struct RecordingExportTests {
  @Test("Programme file is the recording start, second precision")
  func programName() {
    let wall = WallClock(date: Date(timeIntervalSince1970: 1_755_348_252))
    // 2025-08-16 16:04:12 UTC — local tz may shift the clock fields, so only the shape is asserted.
    let name = RecordingExport.programFilename(startedAt: wall)
    #expect(name.hasSuffix(".mov"))
    #expect(name.split(separator: "-").count >= 6)
  }

  @Test("Camera names replace spaces and illegal characters with underscores")
  func sanitise() {
    #expect(RecordingExport.sanitise("Third Base") == "Third_Base")
    #expect(RecordingExport.sanitise("Cam 1/2") == "Cam_1_2")
    #expect(RecordingExport.sanitise("  ..wide*shot??  ") == "wide_shot")
    let name = RecordingExport.cameraFilename(
      startedAt: WallClock(seconds: 1_755_348_252),
      cameraName: "Third Base"
    )
    #expect(name.hasSuffix("-Third_Base.mov"))
  }

  @Test("Programme continuations after a failed writer are exported with the original")
  func programSourceFilesIncludeContinuations() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("program-export-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    try Data("one".utf8).write(to: root.appendingPathComponent("program-20260829-083556.mp4"))
    try Data("two".utf8).write(to: root.appendingPathComponent("program-20260829-083556-2.mp4"))
    try Data("other".utf8).write(to: root.appendingPathComponent("program-20260829-090000.mp4"))

    let files = RecordingExport.programSourceFiles(
      named: "program-20260829-083556.mp4",
      in: root
    )
    #expect(files.map(\.lastPathComponent) == [
      "program-20260829-083556.mp4",
      "program-20260829-083556-2.mp4"
    ])

    let joined = RecordingExport.programSourceFiles(
      named: "program-20260829-083556.mp4,program-20260829-083556-2.mp4",
      in: root
    )
    #expect(joined.map(\.lastPathComponent) == [
      "program-20260829-083556.mp4",
      "program-20260829-083556-2.mp4"
    ])
  }

  @Test("Programme parts with no movie header are named rather than thrown from AVFoundation")
  func unreadableProgramPartsAreReported() async throws {
    // A continuation writer that dies seconds after opening leaves a part with no movie header.
    // Loading one throws "Cannot Open" inside AVFoundation, which used to abort the whole export
    // — including the readable master alongside it. Two unreadable parts leave nothing to remux,
    // so this still fails, but it fails naming them.
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("remux-unreadable-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let first = root.appendingPathComponent("program-20260906-080531-2.mp4")
    let second = root.appendingPathComponent("program-20260906-080531-3.mp4")
    // Big enough to pass a size check, and with no `moov` — the continuation stub this guards.
    try Data(repeating: 0, count: 4096).write(to: first)
    try Data(repeating: 0, count: 4096).write(to: second)

    await #expect(throws: ArchiveRemux.Error.self) {
      try await ArchiveRemux.stitch(
        files: [first, second],
        fileDurations: [0, 0],
        settings: TestMovie.encoding,
        destination: root.appendingPathComponent("out.mp4")
      )
    }
  }

  @Test("Prepared movies live in a folder named for the recording")
  func preparedDirectoryUsesRecordingID() {
    let root = URL(fileURLWithPath: "/tmp/prepared")
    let url = RecordingExport.preparedDirectory(recordingID: 89, in: root)
    #expect(url.lastPathComponent == "rec-89")
  }

  @Test("Existing prepared files are reused unless reprocess is requested")
  func reusesPreparedFiles() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("export-reuse-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let archives = root.appendingPathComponent("Archives", isDirectory: true)
    let program = root.appendingPathComponent("Program", isDirectory: true)
    let prepared = root.appendingPathComponent("Prepared", isDirectory: true)
    try FileManager.default.createDirectory(at: archives, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: program, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: prepared, withIntermediateDirectories: true)

    let source = SourceID("cam-0")
    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    let recordingID = try index.beginRecording(at: WallClock(seconds: 1_000))
    try index.endRecording(recordingID, at: WallClock(seconds: 1_010))
    try index.insertSegment(
      recordingID: recordingID,
      sourceID: source,
      sequence: 1,
      filename: "seg-00001.mp4",
      isInitialization: false,
      startWall: WallClock(seconds: 1_000),
      duration: 10,
      byteCount: 4,
      firstFrameID: 1
    )

    let recording = try #require(try index.recordings().first)
    let exporter = ExportService(
      index: index,
      archives: archives,
      programDirectory: program
    )
    let cameras = [(sourceID: source, name: "First Base")]
    #expect(
      !exporter.hasPreparedExport(
        recording,
        cameras: cameras,
        includeProgram: false,
        programDirectory: program,
        preparedRoot: prepared
      )
    )

    let destination = RecordingExport.preparedDirectory(recordingID: recordingID, in: prepared)
      .appendingPathComponent(
        RecordingExport.cameraFilename(startedAt: recording.startedAt, cameraName: "First Base")
      )
    try FileManager.default.createDirectory(
      at: destination.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try Data("already-prepared".utf8).write(to: destination)

    #expect(
      exporter.hasPreparedExport(
        recording,
        cameras: cameras,
        includeProgram: false,
        programDirectory: program,
        preparedRoot: prepared
      )
    )

    let urls = try await exporter.exportRecording(
      recording,
      cameras: cameras,
      includeProgram: false,
      programDirectory: program,
      preparedRoot: prepared,
      reprocess: false
    )
    #expect(urls == [destination])
    #expect(try String(contentsOf: destination, encoding: .utf8) == "already-prepared")
  }
}

@Suite("Retention")
struct RetentionPolicyTests {
  /// Builds `count` recordings a minute apart, each one segment of `bytes`, oldest first.
  private func seed(_ index: ArchiveIndex, count: Int, bytes: Int64) throws -> [Int64] {
    var ids: [Int64] = []
    for step in 0 ..< count {
      let start = WallClock(seconds: 1_000 + Double(step) * 60)
      let id = try index.beginRecording(at: start)
      try index.endRecording(id, at: start + 30)
      try index.insertSegment(
        recordingID: id,
        sourceID: SourceID("cam-0"),
        sequence: 1,
        filename: "rec-\(id)/seg-00001.mp4",
        isInitialization: false,
        startWall: start,
        duration: 30,
        byteCount: bytes,
        firstFrameID: 1
      )
      ids.append(id)
    }
    return ids
  }

  private func roots(_ base: URL) -> RecordingFileRoots {
    RecordingFileRoots(
      archives: base.appendingPathComponent("Archives"),
      program: base.appendingPathComponent("Program"),
      proxies: base.appendingPathComponent("Proxies"),
      prepared: base.appendingPathComponent("Prepared")
    )
  }

  @Test("Over the ceiling, the oldest recordings go whole and the newest survive")
  func sweepsOldestFirst() throws {
    let base = FileManager.default.temporaryDirectory
      .appendingPathComponent("retention-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: base) }

    let index = try ArchiveIndex(url: base.appendingPathComponent("index.sqlite"))
    let ids = try seed(index, count: 4, bytes: 100)
    let policy = RetentionPolicy(index: index, roots: roots(base))

    // Room for two of the four. A free-space floor of zero keeps the volume out of it.
    let sweep = try policy.sweep(maximumArchiveBytes: 250, freeDiskFloorBytes: 0)

    #expect(sweep.removedRecordings == 2)
    #expect(sweep.reclaimedBytes == 200)
    #expect(try index.totalBytes() == 200)
    #expect(try index.allSegments(forRecording: ids[0]).isEmpty)
    #expect(try index.allSegments(forRecording: ids[1]).isEmpty)
    #expect(try index.allSegments(forRecording: ids[2]).count == 1)
    #expect(try index.allSegments(forRecording: ids[3]).count == 1)
    // The recordings themselves stay listed — only the rolling archive is reclaimed.
    #expect(try index.recordings().count == 4)
  }

  @Test("The take being recorded is never swept, however far over budget the archive is")
  func liveRecordingIsExempt() throws {
    let base = FileManager.default.temporaryDirectory
      .appendingPathComponent("retention-live-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: base) }

    let index = try ArchiveIndex(url: base.appendingPathComponent("index.sqlite"))
    let ids = try seed(index, count: 2, bytes: 100)
    let policy = RetentionPolicy(index: index, roots: roots(base))

    // A ceiling of zero would take everything; the oldest is the one being written.
    let sweep = try policy.sweep(
      maximumArchiveBytes: 0,
      freeDiskFloorBytes: 0,
      protecting: ids[0]
    )

    #expect(try index.allSegments(forRecording: ids[0]).count == 1)
    #expect(sweep.exhausted)
  }

  @Test("Under the ceiling nothing is touched")
  func leavesArchiveAloneWhenUnderBudget() throws {
    let base = FileManager.default.temporaryDirectory
      .appendingPathComponent("retention-idle-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: base) }

    let index = try ArchiveIndex(url: base.appendingPathComponent("index.sqlite"))
    _ = try seed(index, count: 3, bytes: 100)
    let policy = RetentionPolicy(index: index, roots: roots(base))

    let sweep = try policy.sweep(maximumArchiveBytes: 10_000, freeDiskFloorBytes: 0)

    #expect(sweep.removedRecordings == 0)
    #expect(sweep.removedSegments == 0)
    #expect(!sweep.exhausted)
    #expect(try index.totalBytes() == 300)
  }
}
