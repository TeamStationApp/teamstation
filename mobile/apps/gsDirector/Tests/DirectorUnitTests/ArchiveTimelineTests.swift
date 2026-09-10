import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import DirectorCore
import DirectorDVR
import DirectorPipeline
import DirectorSources
import Testing

@Suite("Archive wall-clock timeline")
struct ArchiveTimelineTests {
  // Three tests stood here: a 5 s camera hole held as black, an 8 s audio hole filled, and a
  // 720-then-1080 take locking the first size. All three drove `SegmentWriter.fillAndWait`, which
  // no longer exists — `37f667e` removed the hold-to-wall-clock filler because the black IDRs it
  // injected mid-GOP made every following P-frame reference black, and the archive decoded 92.6%
  // black while instant replay froze.
  //
  // They are removed rather than disabled because they assert the opposite of what the code should
  // now do: the intent was right and the mechanism was wrong. Gap filling returns in Phase 5 of
  // /Users/dev/agent-notes as P-skip frames, which duplicate the
  // previous picture without touching the reference chain. **That phase owes this file three
  // replacements** — a video hole, an audio hole, and duration equal to the recording's wall clock.

  @Test("An assembly reports wall clock and tape separately, and says where each segment belongs")
  func exportDurationMatchesRecording() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("export-d-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let source = SourceID("cam-0")
    let archives = root.appendingPathComponent("archives", isDirectory: true)
    try FileManager.default.createDirectory(
      at: archives.appendingPathComponent(source.slug, isDirectory: true),
      withIntermediateDirectories: true
    )
    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    let recording = try index.beginRecording(at: WallClock(seconds: 1_000))
    try index.endRecording(recording, at: WallClock(seconds: 1_009))
    let recDir = archives.appendingPathComponent("\(source.slug)/rec-\(recording)", isDirectory: true)
    try FileManager.default.createDirectory(at: recDir, withIntermediateDirectories: true)
    for (sequence, start, duration) in [(1, 1_000.0, 2.0), (2, 1_007.0, 2.0)] {
      let name = String(format: "seg-%05d.mp4", sequence)
      try Data("mp4-\(sequence)".utf8).write(to: recDir.appendingPathComponent(name))
      try index.insertSegment(
        recordingID: recording,
        sourceID: source,
        sequence: sequence,
        filename: "rec-\(recording)/\(name)",
        isInitialization: false,
        startWall: WallClock(seconds: start),
        duration: duration,
        byteCount: 4,
        firstFrameID: UInt64(sequence)
      )
    }

    let assembly = try SegmentAssembler(index: index, archives: archives).mediaFiles(
      sourceID: source,
      from: WallClock(seconds: 1_000),
      to: WallClock(seconds: 1_009)
    )
    // Two 2 s segments five seconds apart: nine seconds of wall clock holding four of tape. The
    // two numbers are now reported separately instead of one standing in for the other, because
    // conflating them is what placed every post-gap frame five seconds early.
    #expect(abs(assembly.wallSpan - 9) < 0.001)
    #expect(abs(assembly.duration - 4) < 0.001)
    #expect(abs(assembly.fileDurations.reduce(0, +) - 4) < 0.001)
    // And the export's guarantee, which is no longer a duration at all but a position: the second
    // segment belongs seven seconds in, not immediately after the first.
    #expect(assembly.startWalls.count == 2)
    #expect(abs(assembly.startWalls[1] - assembly.startWalls[0] - 7) < 0.001)
    #expect(abs(assembly.mediaOffset(forWall: WallClock(seconds: 1_008)) - 3) < 0.001)
  }

  @Test("Program writer recovery holds the dead interval so concat lasts the take")
  func programRecoveryHoldsWallClock() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("program-hold-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let encoder = ProgramEncoder(
      telemetry: PipelineTelemetry(),
      converter: PixelConverter(),
      config: AppConfig(
        programCodec: .h264,
        programResolution: ProgramResolution(width: 160, height: 120),
        programBitrate: 1_000_000
      ),
      directory: root
    )
    try encoder.start(at: WallClock(seconds: 1_000))
    let factory = try #require(
      PixelBufferFactory(width: 160, height: 120, pixelFormat: kCVPixelFormatType_32BGRA)
    )
    let buffer = try #require(factory.makeBuffer())
    for index in 0..<60 {
      encoder.append(buffer, presentationTime: CMTime(value: CMTimeValue(index), timescale: 30))
      try await Task.sleep(nanoseconds: 20_000_000)
    }
    encoder.recoverAfterFailure()
    for index in 210..<270 {
      encoder.append(buffer, presentationTime: CMTime(value: CMTimeValue(index), timescale: 30))
      try await Task.sleep(nanoseconds: 20_000_000)
    }
    _ = await encoder.finish()
    #expect(encoder.outputURLs.count == 2)

    let destination = root.appendingPathComponent("out.mp4")
    try await ArchiveRemux.concatenate(
      files: encoder.outputURLs,
      fileDurations: encoder.outputURLs.map { _ in 0 },
      destination: destination
    )
    let duration = try await AVURLAsset(url: destination).load(.duration)
    #expect(abs(duration.seconds - 9) < 0.6)
  }

  @Test("Recovering with no compositor gap keeps continuation PTS on the file timeline")
  func programRecoverTinyGapStaysOnFileTimeline() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("program-tiny-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let encoder = ProgramEncoder(
      telemetry: PipelineTelemetry(),
      converter: PixelConverter(),
      config: AppConfig(
        programCodec: .h264,
        programResolution: ProgramResolution(width: 160, height: 120),
        programBitrate: 1_000_000
      ),
      directory: root
    )
    try encoder.start(at: WallClock(seconds: 5_000))
    let factory = try #require(
      PixelBufferFactory(width: 160, height: 120, pixelFormat: kCVPixelFormatType_32BGRA)
    )
    let buffer = try #require(factory.makeBuffer())
    for index in 0..<30 {
      encoder.append(buffer, presentationTime: CMTime(value: CMTimeValue(index), timescale: 30))
      try await Task.sleep(nanoseconds: 20_000_000)
    }
    encoder.recoverAfterFailure()
    for index in 30..<60 {
      encoder.append(buffer, presentationTime: CMTime(value: CMTimeValue(index), timescale: 30))
      try await Task.sleep(nanoseconds: 20_000_000)
    }
    _ = await encoder.finish()
    #expect(encoder.outputURLs.count == 2)
    let part2 = try await AVURLAsset(url: encoder.outputURLs[1]).load(.duration)
    #expect(part2.seconds > 0.4)
    #expect(part2.seconds < 20)
  }
  func programFinishWithoutFramesHoldsWallClock() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("program-empty-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let encoder = ProgramEncoder(
      telemetry: PipelineTelemetry(),
      converter: PixelConverter(),
      config: AppConfig(
        programCodec: .h264,
        programResolution: ProgramResolution(width: 160, height: 120),
        programBitrate: 1_000_000
      ),
      directory: root
    )
    try encoder.start(at: WallClock(seconds: 2_000))
    let url = try #require(await encoder.finish(until: WallClock(seconds: 2_009)))
    let duration = try await AVURLAsset(url: url).load(.duration)
    #expect(abs(duration.seconds - 9) < 0.6)
    let bytes = try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int
    #expect((bytes ?? 0) > 0)
  }

  @Test("A poisoned program writer recovers without the test calling recoverAfterFailure")
  func programWriterFailureRecoversWithoutSkippingWall() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("program-poison-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let telemetry = PipelineTelemetry()
    let encoder = ProgramEncoder(
      telemetry: telemetry,
      converter: PixelConverter(),
      config: AppConfig(
        programCodec: .h264,
        programResolution: ProgramResolution(width: 160, height: 120),
        programBitrate: 1_000_000
      ),
      directory: root
    )
    let origin = WallClock(seconds: 3_000)
    try encoder.start(at: origin)
    let factory = try #require(
      PixelBufferFactory(width: 160, height: 120, pixelFormat: kCVPixelFormatType_32BGRA)
    )
    let buffer = try #require(factory.makeBuffer())
    let format = try #require(
      AudioSampleBuilder.makeFormatDescription(
        AudioSampleBuilder.interleavedInt16Description(
          sampleRate: AudioMixer.sampleRate,
          channels: UInt32(AudioMixer.channelCount)
        )
      )
    )
    let silence = [Int16](repeating: 0, count: 1_024 * AudioMixer.channelCount)
    for index in 0..<60 {
      let time = CMTime(value: CMTimeValue(index), timescale: 30)
      encoder.append(buffer, presentationTime: time)
      if let sample = AudioSampleBuilder.makeSampleBuffer(
        samples: silence,
        formatDescription: format,
        presentationTime: time
      ) {
        encoder.append(
          audio: AudioFrame(sourceID: SourceID("program"), sampleBuffer: sample, wallClock: origin)
        )
      }
      try await Task.sleep(nanoseconds: 20_000_000)
    }
    encoder.poisonWriter()
    for index in 210..<270 {
      encoder.append(buffer, presentationTime: CMTime(value: CMTimeValue(index), timescale: 30))
      try await Task.sleep(nanoseconds: 20_000_000)
    }
    _ = await encoder.finish(until: WallClock(seconds: 3_009))
    #expect(encoder.outputURLs.count == 2)
    let snapshot = telemetry.snapshot
    #expect(snapshot.sessions.encodeFailures > 0)
    #expect(snapshot.dvr.lastError?.contains("program writer") == true)

    let destination = root.appendingPathComponent("out.mp4")
    try await ArchiveRemux.concatenate(
      files: encoder.outputURLs,
      fileDurations: encoder.outputURLs.map { _ in 0 },
      targetDuration: 9,
      destination: destination
    )
    let duration = try await AVURLAsset(url: destination).load(.duration)
    #expect(abs(duration.seconds - 9) < 0.6)
  }
}

final class FixedClock: DirectorClock, @unchecked Sendable {
  private let lock = NSLock()
  private var wall: WallClock

  init(_ seconds: Double) {
    wall = WallClock(seconds: seconds)
  }

  var now: WallClock {
    lock.lock()
    defer { lock.unlock() }
    return wall
  }

  func set(_ seconds: Double) {
    lock.lock()
    wall = WallClock(seconds: seconds)
    lock.unlock()
  }
}

private final class TimelineHarness {
  let root: URL
  let archives: URL
  let source = SourceID("cam-0")
  let index: ArchiveIndex
  let clock = FixedClock(1_000)
  let telemetry = PipelineTelemetry()
  let recordingID: Int64
  private var fillers: [String: ArchiveFiller] = [:]

  init() throws {
    root = FileManager.default.temporaryDirectory
      .appendingPathComponent("timeline-\(UUID().uuidString)", isDirectory: true)
    archives = root.appendingPathComponent("archives", isDirectory: true)
    try FileManager.default.createDirectory(at: archives, withIntermediateDirectories: true)
    index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    recordingID = try index.beginRecording(at: WallClock(seconds: 1_000))
  }

  func tearDown() {
    try? FileManager.default.removeItem(at: root)
  }

  func makeWriter(startedAt: Double, width: Int, height: Int) -> SegmentWriter {
    let directory = archives
      .appendingPathComponent(source.slug, isDirectory: true)
      .appendingPathComponent("rec-\(recordingID)", isDirectory: true)
    return SegmentWriter(
      sourceID: source,
      sourceIndex: 0,
      recordingID: recordingID,
      index: index,
      telemetry: telemetry,
      settings: SegmentWriterSettings(segmentSeconds: 3, includesAudio: true),
      clock: clock,
      directory: directory
    )
  }

  func appendSolid(
    _ writer: SegmentWriter,
    from start: Double,
    seconds: Double,
    luma: UInt8,
    width: Int = 160,
    height: Int = 120,
    fps: Int = 30
  ) throws {
    try appendFrames(
      writer,
      from: start,
      seconds: seconds,
      luma: luma,
      width: width,
      height: height,
      fps: fps,
      includeAudio: true
    )
  }

  func appendVideo(
    _ writer: SegmentWriter,
    from start: Double,
    seconds: Double,
    luma: UInt8,
    width: Int = 160,
    height: Int = 120,
    fps: Int = 30
  ) throws {
    try appendFrames(
      writer,
      from: start,
      seconds: seconds,
      luma: luma,
      width: width,
      height: height,
      fps: fps,
      includeAudio: false
    )
  }

  private func appendFrames(
    _ writer: SegmentWriter,
    from start: Double,
    seconds: Double,
    luma: UInt8,
    width: Int,
    height: Int,
    fps: Int,
    includeAudio: Bool
  ) throws {
    let key = "\(width)x\(height)"
    let filler = fillers[key] ?? ArchiveFiller(width: width, height: height, codec: .h264, frameRate: fps)
    fillers[key] = filler
    guard let buffer = Self.solidBuffer(width: width, height: height, luma: luma) else {
      throw CocoaError(.fileWriteUnknown)
    }
    let frames = Int((seconds * Double(fps)).rounded(.down))
    for index in 0..<max(frames, 1) {
      let wall = start + Double(index) / Double(fps)
      let time = CMTime(seconds: wall, preferredTimescale: 90_000)
      guard
        let coded = filler.encode(
          pixelBuffer: buffer,
          sourceID: source,
          presentationTime: time,
          wallClock: WallClock(seconds: wall),
          frameID: UInt64(index + 1),
          forceKeyframe: index == 0 || index % fps == 0
        )
      else { continue }
      writer.append(coded)
      if includeAudio,
        let silence = filler.encodeSilence(
          sourceID: source,
          presentationTime: time,
          wallClock: WallClock(seconds: wall)
        )
      {
        writer.append(audio: silence)
      }
    }
  }

  func remuxedMovie() async throws -> URL {
    let assembly = try SegmentAssembler(index: index, archives: archives).mediaFiles(
      sourceID: source,
      from: WallClock(seconds: 0),
      to: WallClock(seconds: 10_000)
    )
    let destination = root.appendingPathComponent("out.mp4")
    try await ArchiveRemux.concatenate(
      files: assembly.files,
      fileDurations: assembly.fileDurations,
      destination: destination
    )
    return destination
  }

  func meanLuma(url: URL, at seconds: TimeInterval) async throws -> Double {
    let asset = AVURLAsset(url: url)
    let tracks = try await asset.loadTracks(withMediaType: .video)
    guard let track = tracks.first else { return -1 }
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(
      track: track,
      outputSettings: [ kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA ]
    )
    reader.add(output)
    let start = CMTime(seconds: max(0, seconds), preferredTimescale: 600)
    reader.timeRange = CMTimeRange(start: start, duration: CMTime(seconds: 0.2, preferredTimescale: 600))
    guard reader.startReading() else { return -1 }
    guard let sample = output.copyNextSampleBuffer(),
      let image = CMSampleBufferGetImageBuffer(sample)
    else { return -1 }
    return Self.luma(image)
  }

  private static func solidBuffer(width: Int, height: Int, luma: UInt8) -> CVPixelBuffer? {
    var buffer: CVPixelBuffer?
    let status = CVPixelBufferCreate(
      kCFAllocatorDefault,
      width,
      height,
      kCVPixelFormatType_32BGRA,
      [ kCVPixelBufferIOSurfacePropertiesKey: [:] as [String: Any] ] as CFDictionary,
      &buffer
    )
    guard status == kCVReturnSuccess, let buffer else { return nil }
    CVPixelBufferLockBaseAddress(buffer, [])
    let bytes = CVPixelBufferGetBytesPerRow(buffer)
    if let base = CVPixelBufferGetBaseAddress(buffer) {
      let pointer = base.bindMemory(to: UInt8.self, capacity: bytes * height)
      for row in 0..<height {
        for column in 0..<width {
          let offset = row * bytes + column * 4
          pointer[offset] = luma
          pointer[offset + 1] = luma
          pointer[offset + 2] = luma
          pointer[offset + 3] = 255
        }
      }
    }
    CVPixelBufferUnlockBaseAddress(buffer, [])
    return buffer
  }

  private static func luma(_ buffer: CVPixelBuffer) -> Double {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    let width = CVPixelBufferGetWidth(buffer)
    let height = CVPixelBufferGetHeight(buffer)
    let bytes = CVPixelBufferGetBytesPerRow(buffer)
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { return -1 }
    let pointer = base.bindMemory(to: UInt8.self, capacity: bytes * height)
    var total = 0
    var count = 0
    for row in stride(from: 0, to: height, by: 4) {
      for column in stride(from: 0, to: width, by: 4) {
        let offset = row * bytes + column * 4
        total += Int(pointer[offset]) + Int(pointer[offset + 1]) + Int(pointer[offset + 2])
        count += 3
      }
    }
    return count == 0 ? -1 : Double(total) / Double(count)
  }
}

@Suite("Declared duration plausibility")
struct DeclaredDurationTests {
  @Test("A stub declaring hours while holding one frame is not believed")
  func rejectsImpossibleFrameRate() {
    // A continuation stub: hours of declared duration over a single frame.
    let rate = Float(1.0 / 6_550)
    #expect(!ArchiveRemux.isPlausibleDuration(seconds: 6_550, nominalFrameRate: rate))
  }

  @Test("A recovery hold at ten frames a second is believed")
  func acceptsHold() {
    // Black and silent, and it compresses to almost nothing -- which is why size is the wrong
    // thing to judge this on.
    #expect(ArchiveRemux.isPlausibleDuration(seconds: 45, nominalFrameRate: 10))
  }

  @Test("A normal recording is believed")
  func acceptsRealFile() {
    #expect(ArchiveRemux.isPlausibleDuration(seconds: 600, nominalFrameRate: 30))
  }

  @Test("A rate the container does not report is not treated as evidence")
  func unknownRatePasses() {
    // Fragmented parts often report nothing here, and unknown is not the same as empty.
    #expect(ArchiveRemux.isPlausibleDuration(seconds: 600, nominalFrameRate: 0))
  }

  @Test("The multi-day and zero cases are still refused")
  func keepsExistingBounds() {
    #expect(!ArchiveRemux.isPlausibleDuration(seconds: 90_000, nominalFrameRate: 30))
    #expect(!ArchiveRemux.isPlausibleDuration(seconds: 0, nominalFrameRate: 30))
  }
}

@Suite("Programme anchor emission")
struct ProgramAnchorEmissionTests {
  /// The anchor sink runs on whichever queue delivered the frame — an NDI receive queue, an RTSP
  /// delivery queue — and never the main actor. An earlier version reached back for the active
  /// recording through `MainActor.assumeIsolated`, which is a hard trap off the main actor: it
  /// killed the app on the first composited frame after the record button, every time. The
  /// recording is carried through the call instead, so the sink touches nothing isolated.
  @Test("Anchors carry their recording, and none are emitted without one")
  func anchorsOnlyWhileRecording() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("anchor-emit-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let box = AnchorBox()
    let encoder = ProgramEncoder(
      telemetry: PipelineTelemetry(),
      converter: PixelConverter(),
      config: AppConfig(
        programCodec: .h264,
        programResolution: ProgramResolution(width: 160, height: 120),
        programBitrate: 1_000_000
      ),
      directory: root
    )
    encoder.setAnchorSink { recording, part, seconds, _ in
      box.append(recording: recording, part: part, seconds: seconds)
    }
    try encoder.start(at: WallClock(seconds: 1_000))
    let factory = try #require(
      PixelBufferFactory(width: 160, height: 120, pixelFormat: kCVPixelFormatType_32BGRA)
    )
    let buffer = try #require(factory.makeBuffer())

    // Composited for the preview with nothing recording: nothing to anchor to.
    for index in 0..<40 {
      encoder.append(buffer, presentationTime: CMTime(value: CMTimeValue(index), timescale: 30))
      try await Task.sleep(nanoseconds: 5_000_000)
    }
    #expect(box.all().isEmpty, "anchors were written with no recording to attach them to")

    // Record pressed.
    encoder.setAnchorRecording(77)
    for index in 40..<220 {
      encoder.append(buffer, presentationTime: CMTime(value: CMTimeValue(index), timescale: 30))
      try await Task.sleep(nanoseconds: 5_000_000)
    }
    let during = box.all()
    #expect(!during.isEmpty, "no anchors while recording")
    #expect(during.allSatisfy { $0.recording == 77 })
    #expect(during.allSatisfy { $0.part >= 1 })

    // Stopped: the sink stays wired, but there is nothing to attach to again.
    encoder.setAnchorRecording(nil)
    let countAtStop = box.all().count
    for index in 220..<300 {
      encoder.append(buffer, presentationTime: CMTime(value: CMTimeValue(index), timescale: 30))
      try await Task.sleep(nanoseconds: 5_000_000)
    }
    #expect(box.all().count == countAtStop, "anchors kept coming after the recording stopped")
    _ = await encoder.finish()
  }
}

/// Collects what the sink was handed, from whatever thread it ran on.
private final class AnchorBox: @unchecked Sendable {
  private let lock = NSLock()
  private var items: [(recording: Int64, part: Int, seconds: Double)] = []

  func append(recording: Int64, part: Int, seconds: Double) {
    lock.lock()
    items.append((recording, part, seconds))
    lock.unlock()
  }

  func all() -> [(recording: Int64, part: Int, seconds: Double)] {
    lock.lock()
    defer { lock.unlock() }
    return items
  }
}
