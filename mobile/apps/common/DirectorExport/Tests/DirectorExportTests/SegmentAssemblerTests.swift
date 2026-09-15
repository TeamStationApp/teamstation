import Foundation
import DirectorCore
import DirectorExport
import Testing

@Suite("Segment assembler")
struct SegmentAssemblerTests {
  @Test("Complete MP4 archives stage every file in the range, not only the last")
  func stagesAllCompleteFiles() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("assembler-\(UUID().uuidString)", isDirectory: true)
    let source = SourceID("cam-0")
    let archive = root.appendingPathComponent(source.slug, isDirectory: true)
    try FileManager.default.createDirectory(at: archive, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let index = try ArchiveIndex(
      url: root.appendingPathComponent("index.sqlite")
    )
    let recording = try index.beginRecording(at: WallClock(seconds: 1_000))
    for sequence in 1...3 {
      let name = String(format: "seg-%05d.mp4", sequence)
      try Data("mp4-\(sequence)".utf8).write(to: archive.appendingPathComponent(name))
      try index.insertSegment(
        recordingID: recording,
        sourceID: source,
        sequence: sequence,
        filename: name,
        isInitialization: false,
        startWall: WallClock(seconds: 1_000 + Double(sequence - 1) * 3),
        duration: 3,
        byteCount: 4,
        firstFrameID: UInt64(sequence)
      )
    }

    let assembly = try SegmentAssembler(index: index, archives: root).assemblePlaylist(
      sourceID: source,
      from: WallClock(seconds: 1_000),
      to: WallClock(seconds: 1_009)
    )
    #expect(assembly.segmentCount == 3)
    #expect(assembly.files.count == 3)
    #expect(assembly.fileDurations == [ 3, 3, 3 ])
    #expect(abs(assembly.duration - 9) < 0.001)
    #expect(assembly.url == assembly.files[0])
    for (index, file) in assembly.files.enumerated() {
      let body = try String(contentsOf: file, encoding: .utf8)
      #expect(body == "mp4-\(index + 1)")
    }
  }
}

@Suite("Assembly wall clock")
struct AssemblyWallClockTests {
  /// Three 3 s segments with a 10 s hole between the second and the third: 19 s of real time
  /// holding 9 s of tape.
  private func gapped() -> SegmentAssembler.Assembly {
    SegmentAssembler.Assembly(
      url: URL(fileURLWithPath: "/tmp/a.mp4"),
      startWall: WallClock(seconds: 1_000),
      duration: 9,
      segmentCount: 3,
      files: [],
      fileDurations: [ 3, 3, 3 ],
      startWalls: [
        WallClock(seconds: 1_000),
        WallClock(seconds: 1_003),
        WallClock(seconds: 1_016)
      ],
      endWall: WallClock(seconds: 1_019)
    )
  }

  @Test("A wall span counts the gaps that media time does not")
  func wallSpanIncludesGaps() {
    let assembly = gapped()
    #expect(abs(assembly.duration - 9) < 0.001)
    #expect(abs(assembly.wallSpan - 19) < 0.001)
  }

  @Test("A moment before the gap maps to itself")
  func offsetBeforeGap() {
    #expect(abs(gapped().mediaOffset(forWall: WallClock(seconds: 1_004)) - 4) < 0.001)
  }

  @Test("A moment after the gap skips the tape that was never written")
  func offsetAfterGap() {
    // 1017 is 17 s of wall clock in, but only 7 s of tape: 6 s of the first two segments plus 1 s
    // into the third. Subtracting the start wall instead gives 17 and runs off the end.
    #expect(abs(gapped().mediaOffset(forWall: WallClock(seconds: 1_017)) - 7) < 0.001)
  }

  @Test("A moment inside the gap resolves to the first frame that exists after it")
  func offsetInsideGap() {
    #expect(abs(gapped().mediaOffset(forWall: WallClock(seconds: 1_010)) - 6) < 0.001)
  }

  @Test("A replay across a gap is not refused for running past the end")
  func replayAcrossGapStarts() {
    let assembly = gapped()
    let target = WallClock(seconds: 1_017)
    // The defect: a wall-clock delta compared against media time. 17 >= 9 - 0.25, so a window
    // holding a perfectly good frame at 1017 was refused as "not ready".
    let naive = target - assembly.startWall
    #expect(!ScrubMapping.shouldStartReplay(assemblyDuration: assembly.duration, startOffset: naive))
    let mapped = assembly.mediaOffset(forWall: target)
    #expect(ScrubMapping.shouldStartReplay(assemblyDuration: assembly.duration, startOffset: mapped))
  }

  @Test("Without a gap the walk and the subtraction agree")
  func contiguousUnchanged() {
    let assembly = SegmentAssembler.Assembly(
      url: URL(fileURLWithPath: "/tmp/a.mp4"),
      startWall: WallClock(seconds: 500),
      duration: 9,
      segmentCount: 3,
      files: [],
      fileDurations: [ 3, 3, 3 ],
      startWalls: [
        WallClock(seconds: 500),
        WallClock(seconds: 503),
        WallClock(seconds: 506)
      ],
      endWall: WallClock(seconds: 509)
    )
    let target = WallClock(seconds: 504.5)
    #expect(abs(assembly.mediaOffset(forWall: target) - (target - assembly.startWall)) < 0.001)
  }
}
