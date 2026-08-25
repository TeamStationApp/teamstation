import Foundation
import DirectorCore
import DirectorDVR
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
