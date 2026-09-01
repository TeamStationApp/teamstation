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
  @Test("A 5s camera hole is held as black, so the file lasts the recording")
  func gapSkipHoldsWallClock() async throws {
    let env = try TimelineHarness()
    defer { env.tearDown() }

    let origin = 1_000.0
    env.clock.set(origin)
    let writer = env.makeWriter(startedAt: origin, width: 160, height: 120)
    try writer.prepare()

    try env.appendSolid(writer, from: origin, seconds: 2, luma: 180)
    try env.appendSolid(writer, from: origin + 7, seconds: 2, luma: 180)
    env.clock.set(origin + 9)
    await writer.fillAndWait(to: WallClock(seconds: origin + 9))
    await writer.finish()

    let movie = try await env.remuxedMovie()
    let duration = try await AVURLAsset(url: movie).load(.duration)
    #expect(abs(duration.seconds - 9) < 0.35)

    let hole = try await env.meanLuma(url: movie, at: 4.5)
    let live = try await env.meanLuma(url: movie, at: 1.0)
    #expect(hole < 20)
    #expect(live > 80)
  }

  @Test("A 720 then 1080 take locks the first size for the whole file")
  func formatChangeLocksFirstSize() async throws {
    let env = try TimelineHarness()
    defer { env.tearDown() }

    let origin = 2_000.0
    env.clock.set(origin)
    let writer = env.makeWriter(startedAt: origin, width: 160, height: 120)
    try writer.prepare()

    try env.appendSolid(writer, from: origin, seconds: 1, luma: 160, width: 160, height: 120)
    try env.appendSolid(writer, from: origin + 2, seconds: 1, luma: 160, width: 320, height: 240)
    env.clock.set(origin + 3)
    await writer.fillAndWait(to: WallClock(seconds: origin + 3))
    await writer.finish()

    let movie = try await env.remuxedMovie()
    let asset = AVURLAsset(url: movie)
    let tracks = try await asset.loadTracks(withMediaType: .video)
    let size = try await tracks[0].load(.naturalSize)
    #expect(Int(size.width.rounded()) == 160)
    #expect(Int(size.height.rounded()) == 120)
    let duration = try await asset.load(.duration)
    #expect(duration.seconds > 2.5)
  }

  @Test("Export duration follows recording wall clock, not the sum of segments")
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
    #expect(abs(assembly.duration - 9) < 0.001)
    #expect(abs(assembly.fileDurations.reduce(0, +) - 4) < 0.001)
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

  @Test("A program file with no compositor frames still lasts the recording")
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
      directory: directory,
      recordingStartedAt: WallClock(seconds: startedAt)
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
      if let silence = filler.encodeSilence(
        sourceID: source,
        presentationTime: time,
        wallClock: WallClock(seconds: wall)
      ) {
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
