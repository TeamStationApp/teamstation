import AVFoundation
import Foundation
import DirectorCore
import DirectorExport
import Testing

/// The programme master is copied only when nothing about its timeline is in doubt, and re-encoded
/// like a camera otherwise.
@Suite("Programme export", .serialized)
struct ProgrammeExportTests {
  // MARK: - The decision

  /// Anchors every ten seconds of a part, each implying the part starts at the given wall clock.
  private static func anchors(_ starts: [Double], part: Int = 1) -> [ArchiveIndex.ProgramAnchor] {
    starts.enumerated().map { index, start in
      ArchiveIndex.ProgramAnchor(
        part: part,
        programSeconds: Double(index * 10),
        wall: WallClock(seconds: start + Double(index * 10))
      )
    }
  }

  private static let wholeMinute = ProgrammeExport.PartReading(
    firstPicture: 0, lastPictureEnd: 60, declaredEnd: 60, completed: true
  )

  /// A minute-long take at 1 000 s with a clean one-minute master, changed as each test says.
  private func plan(
    partCount: Int = 1,
    resumeCount: Int = 0,
    anchors: [ArchiveIndex.ProgramAnchor] = anchors([ 1_000, 1_000.01, 999.995, 1_000 ]),
    reading: ProgrammeExport.PartReading? = wholeMinute,
    windowEnd: WallClock? = WallClock(seconds: 1_060)
  ) -> ProgrammeExport.Plan {
    ProgrammeExport.plan(
      partCount: partCount,
      resumeCount: resumeCount,
      anchors: anchors,
      reading: reading,
      windowStart: WallClock(seconds: 1_000),
      windowEnd: windowEnd,
      frameRate: 30
    )
  }

  @Test("An unbroken master is copied, placed where its anchors agree it starts")
  func unbrokenIsCopied() {
    guard case let .copy(start) = plan() else {
      Issue.record("expected a copy, got \(plan())")
      return
    }
    #expect(abs(start.seconds - 1_000) < 0.01)
  }

  @Test("Anchors that wander inside the agreement window, and a window that runs to the part's end, still copy")
  func withinAFrameIsCopied() {
    #expect(plan(anchors: Self.anchors([ 1_000, 1_000.02, 999.99 ])) != nil)
    if case .reencode = plan(anchors: Self.anchors([ 1_000, 1_000.02, 999.99 ])) {
      Issue.record("anchors a frame apart should copy")
    }
    // More than a frame apart, as the capture delay of the camera on air wanders on a good link,
    // but all agreeing: the master's own clock did not move.
    if case let .reencode(reason) = plan(anchors: Self.anchors([ 999.99, 1_000, 1_000.03, 999.97 ])) {
      Issue.record("anchors wandering by 60 ms should copy, got \(reason)")
    }
    if case .reencode = plan(windowEnd: nil) { Issue.record("an open window should copy") }
    // A part that starts before the window and ends after it covers it.
    let longer = ProgrammeExport.PartReading(firstPicture: 0, lastPictureEnd: 61, declaredEnd: 61, completed: true)
    guard case .copy = plan(anchors: Self.anchors([ 999.5, 999.5 ]), reading: longer) else {
      Issue.record("a part that covers the window should copy")
      return
    }
  }

  @Test("A continuation file, a resumed take, or anchors for a later part each force a re-encode")
  func brokenTimelinesReencode() {
    #expect(plan(partCount: 2) == .reencode(.parts(2)))
    #expect(plan(resumeCount: 1) == .reencode(.resumed(1)))
    let later = Self.anchors([ 1_000, 1_000 ]) + Self.anchors([ 1_030 ], part: 2)
    #expect(plan(anchors: later) == .reencode(.continuation(part: 2)))
    #expect(plan(anchors: []) == .reencode(.unanchored))
  }

  @Test("Anchors that do not agree force a re-encode, and a stray among agreeing ones does not")
  func doubtfulAnchorsReencode() {
    guard case let .reencode(.anchorsDisagree(spread)) = plan(anchors: Self.anchors([ 1_000, 1_000.5, 1_001, 1_001.5 ])) else {
      Issue.record("anchors half a second apart from one another should disagree")
      return
    }
    #expect(abs(spread - 1.5) < 0.001)
    // Three of four agree; the fourth caught the camera on air half a second late.
    guard case .copy = plan(anchors: Self.anchors([ 1_000, 1_000, 1_000, 1_000.5 ])) else {
      Issue.record("one stray anchor among agreeing ones should not force a re-encode")
      return
    }
  }

  @Test("A part that does not read to its end, or does not reach either end of the window, forces a re-encode")
  func shortOrDamagedPartsReencode() {
    #expect(plan(reading: nil) == .reencode(.unreadable))
    let failed = ProgrammeExport.PartReading(firstPicture: 0, lastPictureEnd: 60, declaredEnd: 60, completed: false)
    #expect(plan(reading: failed) == .reencode(.unreadable))
    let truncated = ProgrammeExport.PartReading(firstPicture: 0, lastPictureEnd: 50, declaredEnd: 60, completed: true)
    #expect(plan(reading: truncated) == .reencode(.unreadable))

    guard case let .reencode(.startsLate(late)) = plan(anchors: Self.anchors([ 1_000.2, 1_000.2 ])) else {
      Issue.record("a part starting 0.2 s into the window should start late")
      return
    }
    #expect(abs(late - 0.2) < 0.001)
    let short = ProgrammeExport.PartReading(firstPicture: 0, lastPictureEnd: 59, declaredEnd: 59, completed: true)
    guard case let .reencode(.endsEarly(early)) = plan(reading: short) else {
      Issue.record("a part ending a second before the window should end early")
      return
    }
    #expect(abs(early - 1) < 0.02)
  }

  // MARK: - Through the export

  /// Re-encoded programmes come out at this size, which no fixture is, so a copy and a re-encode
  /// are told apart by the file's dimensions.
  private static let programme = EncodeSettings(
    codec: .h264,
    resolution: ProgramResolution(width: 400, height: 60),
    frameRate: 30,
    bitrate: 1_000_000,
    keyframeSeconds: 1
  )

  enum Break: String, CaseIterable, Sendable, CustomStringConvertible {
    case continuation
    case resumed
    case disagreeingAnchors
    case shortOfWindow

    var description: String { rawValue }
  }

  private struct Take {
    var root: URL
    var index: ArchiveIndex
    var recording: RecordingSummary
    var program: URL
    var master: URL
  }

  /// A take from 1 000 s, `length` long, whose master is three seconds of marked picture with sound,
  /// anchored as starting with the take. `continuation` adds a second three-second part from 1 004 s.
  private func take(
    length: Double = 3,
    anchorStarts: [Double] = [ 1_000, 1_000, 1_000 ],
    continuation: Bool = false,
    resumed: Bool = false
  ) async throws -> Take {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("programme-export-\(UUID().uuidString)", isDirectory: true)
    let program = root.appendingPathComponent("Program", isDirectory: true)
    try FileManager.default.createDirectory(at: program, withIntermediateDirectories: true)
    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    let id = try index.beginRecording(at: WallClock(seconds: 1_000))
    try index.endRecording(id, at: WallClock(seconds: 1_000 + length))
    try index.saveEncoding(TakeEncoding(rawCamera: TestMovie.encoding, programme: Self.programme), for: id)

    let movies = WallClockPlacementTests()
    let master = program.appendingPathComponent("program-20260914-100000.mp4")
    try await movies.markedMovieWithAudio(at: master, firstValue: 1_000, frames: 90)
    try index.setProgramFilename(master.lastPathComponent, for: id)
    for (seconds, start) in anchorStarts.enumerated() {
      try index.insertProgramAnchor(
        recordingID: id, part: 1, programSeconds: Double(seconds), wall: WallClock(seconds: start + Double(seconds))
      )
    }
    if continuation {
      let part = program.appendingPathComponent("program-20260914-100000-2.mp4")
      try await movies.markedMovieWithAudio(at: part, firstValue: 5_000, frames: 90)
      for seconds in 0 ..< 3 {
        try index.insertProgramAnchor(
          recordingID: id, part: 2, programSeconds: Double(seconds), wall: WallClock(seconds: 1_004 + Double(seconds))
        )
      }
    }
    if resumed { try index.noteResumed(id, at: WallClock(seconds: 1_001)) }
    let recording = try #require(try index.recordings().first { $0.id == id })
    return Take(root: root, index: index, recording: recording, program: program, master: master)
  }

  private func export(_ take: Take) async throws -> URL {
    let urls = try await ExportService(index: take.index, archives: take.root, programDirectory: take.program)
      .exportRecording(
        take.recording,
        cameras: [],
        includeProgram: true,
        programDirectory: take.program,
        preparedRoot: take.root.appendingPathComponent("Prepared", isDirectory: true),
        reprocess: true
      )
    return try #require(urls.first)
  }

  @Test("An unbroken master is copied with every picture sample exactly as it was written")
  func unbrokenMasterIsCopiedUntouched() async throws {
    let take = try await take()
    defer { try? FileManager.default.removeItem(at: take.root) }
    // The decision itself first, so a failure says which rule refused the copy.
    let reading = try await ProgrammeExport.read(take.master)
    let plan = ProgrammeExport.plan(
      partCount: 1,
      resumeCount: 0,
      anchors: try take.index.programAnchors(recordingID: take.recording.id),
      reading: reading,
      windowStart: WallClock(seconds: 1_000),
      windowEnd: WallClock(seconds: 1_003),
      frameRate: Self.programme.frameRate
    )
    #expect(plan == .copy(partStart: WallClock(seconds: 1_000)), "\(plan) from \(String(describing: reading))")
    let out = try await export(take)

    let track = try #require(try await AVURLAsset(url: out).loadTracks(withMediaType: .video).first)
    #expect(try await track.load(.naturalSize) == CGSize(width: 800, height: 120))
    let original = try await Self.pictureSamples(of: take.master)
    let copied = try await Self.pictureSamples(of: out)
    #expect(!original.isEmpty)
    #expect(copied.count == original.count)
    #expect(copied == original, "the copy's picture samples differ from the master's")
    #expect(!(try await AVURLAsset(url: out).loadTracks(withMediaType: .audio)).isEmpty)
  }

  @Test("A master whose timeline is in doubt is re-encoded, repeating frames across any hole", arguments: Break.allCases)
  func brokenMasterIsReencoded(_ kind: Break) async throws {
    let take: Take
    let length: Double
    switch kind {
    case .continuation:
      length = 7
      take = try await self.take(length: length, continuation: true)
    case .resumed:
      length = 3
      take = try await self.take(resumed: true)
    case .disagreeingAnchors:
      length = 3
      take = try await self.take(anchorStarts: [ 1_000, 1_000.5, 1_001 ])
    case .shortOfWindow:
      length = 5
      take = try await self.take(length: length)
    }
    defer { try? FileManager.default.removeItem(at: take.root) }
    let out = try await export(take)

    let track = try #require(try await AVURLAsset(url: out).loadTracks(withMediaType: .video).first)
    #expect(try await track.load(.naturalSize) == CGSize(width: 400, height: 60))
    let times = try await TestMovie.videoPresentationTimes(of: out).sorted()
    #expect(abs(times.count - Int(length * 30)) <= 1, "\(times.count) frames for \(length) s")
    let longest = zip(times, times.dropFirst()).map { $1 - $0 }.max() ?? 0
    #expect(longest <= 1.0 / 30 + 0.001, "a sample lasts \(longest) s")
  }

  /// Every picture sample's bytes, in decode order, as the file holds them.
  static func pictureSamples(of url: URL) async throws -> [Data] {
    let asset = AVURLAsset(url: url)
    let track = try #require(try await asset.loadTracks(withMediaType: .video).first)
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    reader.add(output)
    #expect(reader.startReading())
    var samples: [Data] = []
    while let sample = output.copyNextSampleBuffer() {
      guard CMSampleBufferGetNumSamples(sample) > 0, let block = CMSampleBufferGetDataBuffer(sample) else { continue }
      let length = CMBlockBufferGetDataLength(block)
      var data = Data(count: length)
      data.withUnsafeMutableBytes { raw in
        if let base = raw.baseAddress {
          _ = CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: base)
        }
      }
      samples.append(data)
    }
    return samples
  }
}
