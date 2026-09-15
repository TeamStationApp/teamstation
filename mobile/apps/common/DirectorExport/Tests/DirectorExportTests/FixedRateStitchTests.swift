import AVFoundation
import Foundation
import DirectorCore
import DirectorExport
import DirectorSources
import Testing

/// A camera's export comes out at one frame rate, one size and one codec, whatever the camera sent.
///
/// Frame n of the file is the latest picture placed at or before `n / frameRate`: a camera sending
/// faster has pictures skipped, a slower one has pictures repeated, and every file of an export has
/// its frames at the same instants. The markers painted into the fixtures say which picture every
/// output frame really is.
@Suite("Fixed-rate stitch", .serialized)
struct FixedRateStitchTests {
  private let movies = WallClockPlacementTests()

  private func temporaryRoot(_ name: String) throws -> URL {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("\(name)-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }

  @Test("A camera faster than the setting has pictures skipped, showing the latest at every frame")
  func fasterCameraIsDecimated() async throws {
    let root = try temporaryRoot("faster")
    defer { try? FileManager.default.removeItem(at: root) }
    // Three seconds at 60 fps into a 30 fps export: every other picture.
    let source = root.appendingPathComponent("a.mp4")
    try await movies.markedMovie(at: source, firstValue: 1_000, frames: 180, spacing: 1.0 / 60)

    let out = root.appendingPathComponent("out.mp4")
    try await ArchiveRemux.stitch(
      files: [ source ],
      fileDurations: [ 3 ],
      startWalls: [ WallClock(seconds: 1_000) ],
      windowStart: WallClock(seconds: 1_000),
      length: 3,
      settings: WallClockPlacementTests.encoding,
      destination: out
    )

    #expect(try await TestMovie.videoPresentationTimes(of: out).count == 90)
    for frame in [ 0, 1, 17, 45, 89 ] {
      let value = try await movies.marker(in: out, at: Double(frame) / 30 + 0.004)
      #expect(value == 1_000 + 2 * frame, "frame \(frame) showed \(value.map(String.init) ?? "nothing")")
    }
  }

  @Test("A camera slower than the setting has each picture repeated until the next one")
  func slowerCameraIsRepeated() async throws {
    let root = try temporaryRoot("slower")
    defer { try? FileManager.default.removeItem(at: root) }
    // Three seconds at 10 fps into a 30 fps export: every picture three times.
    let source = root.appendingPathComponent("a.mp4")
    try await movies.markedMovie(at: source, firstValue: 2_000, frames: 30, spacing: 0.1)

    let out = root.appendingPathComponent("out.mp4")
    try await ArchiveRemux.stitch(
      files: [ source ],
      fileDurations: [ 3 ],
      startWalls: [ WallClock(seconds: 1_000) ],
      windowStart: WallClock(seconds: 1_000),
      length: 3,
      settings: WallClockPlacementTests.encoding,
      destination: out
    )

    let times = try await TestMovie.videoPresentationTimes(of: out).sorted()
    #expect(times.count == 90)
    let steps = zip(times, times.dropFirst()).map { $1 - $0 }
    #expect(steps.allSatisfy { abs($0 - 1.0 / 30) < 0.001 }, "frames are not evenly a thirtieth apart")
    for frame in [ 0, 1, 2, 3, 4, 5, 44, 88, 89 ] {
      let value = try await movies.marker(in: out, at: Double(frame) / 30 + 0.004)
      #expect(value == 2_000 + frame / 3, "frame \(frame) showed \(value.map(String.init) ?? "nothing")")
    }
  }

  @Test("Before a camera's first picture the export is black")
  func blackBeforeTheFirstPicture() async throws {
    let root = try temporaryRoot("head")
    defer { try? FileManager.default.removeItem(at: root) }
    let source = root.appendingPathComponent("a.mp4")
    try await movies.markedMovie(at: source, firstValue: 3_000, frames: 90)

    let out = root.appendingPathComponent("out.mp4")
    // Joined two seconds into a five-second window.
    try await ArchiveRemux.stitch(
      files: [ source ],
      fileDurations: [ 3 ],
      startWalls: [ WallClock(seconds: 1_002) ],
      windowStart: WallClock(seconds: 1_000),
      length: 5,
      settings: WallClockPlacementTests.encoding,
      destination: out
    )

    #expect(try await TestMovie.videoPresentationTimes(of: out).count == 150)
    let head = try await Self.brightness(in: out, at: 1.0, x: 700, y: 60)
    #expect(head < 30, "the head was \(head), not black")
    #expect(try await movies.marker(in: out, at: 2.5) == 3_000 + 15)
  }

  @Test(
    "The file has exactly the setting's codec, size and frame rate, the picture fitted in with bars",
    arguments: [ ProgramCodec.h264, .hevc ]
  )
  func outputMatchesSettings(codec: ProgramCodec) async throws {
    let root = try temporaryRoot("settings")
    defer { try? FileManager.default.removeItem(at: root) }
    let source = root.appendingPathComponent("a.mp4")
    try await movies.markedMovie(at: source, firstValue: 4_000, frames: 90)

    // An 800x120 camera into 1280x720 at 25 fps: scaled to 1280x192, black above and below.
    let settings = EncodeSettings(
      codec: codec,
      resolution: ProgramResolution(width: 1_280, height: 720),
      frameRate: 25,
      bitrate: 3_000_000,
      keyframeSeconds: 1
    )
    let out = root.appendingPathComponent("out.mp4")
    try await ArchiveRemux.stitch(
      files: [ source ],
      fileDurations: [ 3 ],
      startWalls: [ WallClock(seconds: 1_000) ],
      windowStart: WallClock(seconds: 1_000),
      length: 3,
      settings: settings,
      destination: out
    )

    let asset = AVURLAsset(url: out)
    let track = try #require(try await asset.loadTracks(withMediaType: .video).first)
    #expect(try await track.load(.naturalSize) == CGSize(width: 1_280, height: 720))
    let format = try #require(try await track.load(.formatDescriptions).first)
    let expected = codec == .hevc ? kCMVideoCodecType_HEVC : kCMVideoCodecType_H264
    #expect(CMFormatDescriptionGetMediaSubType(format) == expected)
    let times = try await TestMovie.videoPresentationTimes(of: out).sorted()
    #expect(times.count == 75)
    #expect(zip(times, times.dropFirst()).allSatisfy { abs(($1 - $0) - 0.04) < 0.001 })
    #expect(abs(try await track.load(.timeRange).duration.seconds - 3) < 0.001)

    // A keyframe at least every second: frames 0, 25 and 50.
    #expect(try await Self.keyframeCount(of: out) >= 3)

    // The bars are black and the picture between them is the camera's grey.
    let bar = try await Self.brightness(in: out, at: 1.0, x: 640, y: 40)
    let picture = try await Self.brightness(in: out, at: 1.0, x: 1_240, y: 360)
    #expect(bar < 30, "the bar was \(bar)")
    #expect(abs(picture - 128) < 30, "the picture was \(picture)")
  }

  @Test("Cancelling an export stops it within a second and leaves no file")
  func cancellingStopsPromptly() async throws {
    let root = try temporaryRoot("cancel")
    defer { try? FileManager.default.removeItem(at: root) }
    let archives = root.appendingPathComponent("Archives", isDirectory: true)
    let program = root.appendingPathComponent("Program", isDirectory: true)
    let prepared = root.appendingPathComponent("Prepared", isDirectory: true)
    try FileManager.default.createDirectory(at: program, withIntermediateDirectories: true)

    // Two seconds of camera in a half-hour take: 54,000 frames to write, far more than a second's
    // work, so the cancel lands in the middle.
    let camera = SourceID("cam-a")
    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    let recordingID = try index.beginRecording(at: WallClock(seconds: 1_000))
    try index.endRecording(recordingID, at: WallClock(seconds: 2_800))
    let filename = "rec-\(recordingID)/seg-1.mp4"
    try await TestMovie.write(
      to: archives.appendingPathComponent(camera.slug, isDirectory: true).appendingPathComponent(filename),
      frames: 60
    )
    try index.insertSegment(
      recordingID: recordingID, sourceID: camera, sequence: 1, filename: filename,
      isInitialization: false, startWall: WallClock(seconds: 1_000), duration: 2,
      byteCount: 1, firstFrameID: 1
    )
    let recording = try #require(try index.recordings().first)
    let small = TakeEncoding(rawCamera: TestMovie.encoding, programme: TestMovie.encoding)
    let exporter = ExportService(
      index: index, archives: archives, programDirectory: program, fallbackEncoding: { small }
    )

    let heard = RemuxProgressTests.HeardItems()
    let task = Task {
      try await exporter.exportRecording(
        recording,
        cameras: [ (sourceID: camera, name: "A") ],
        includeProgram: false,
        programDirectory: program,
        preparedRoot: prepared,
        reprocess: true,
        progress: { heard.add($0) }
      )
    }
    // Well under way before it is cancelled.
    for _ in 0 ..< 3_000 where (heard.all.last?.fraction ?? 0) < 0.01 {
      try await Task.sleep(for: .milliseconds(10))
    }
    let fraction = heard.all.last?.fraction ?? 0
    #expect(fraction > 0 && fraction < 1, "cancelled at \(fraction)")
    let cancelledAt = Date()
    task.cancel()
    let result = await task.result
    let stopped = Date().timeIntervalSince(cancelledAt)

    #expect(stopped < 1, "took \(stopped) s to stop")
    switch result {
    case .success: Issue.record("the export finished despite being cancelled")
    case let .failure(error): #expect(error is CancellationError, "failed with \(error) instead")
    }
    let directory = RecordingExport.preparedDirectory(recordingID: recordingID, in: prepared)
    let left = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
    #expect(left.isEmpty, "left behind: \(left)")
  }

  @Test("A single camera exported by time range is re-encoded at its take's raw camera settings")
  func exportBySourceUsesTheTakesSettings() async throws {
    let root = try temporaryRoot("by-source")
    defer { try? FileManager.default.removeItem(at: root) }
    let archives = root.appendingPathComponent("Archives", isDirectory: true)
    let camera = SourceID("cam-a")
    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    let recordingID = try index.beginRecording(at: WallClock(seconds: 1_000))
    let settings = EncodeSettings(
      codec: .h264,
      resolution: ProgramResolution(width: 400, height: 240),
      frameRate: 25,
      bitrate: 1_000_000,
      keyframeSeconds: 1
    )
    try index.saveEncoding(TakeEncoding(rawCamera: settings, programme: TestMovie.encoding), for: recordingID)
    let filename = "rec-\(recordingID)/seg-1.mp4"
    try await TestMovie.write(
      to: archives.appendingPathComponent(camera.slug, isDirectory: true).appendingPathComponent(filename),
      frames: 90
    )
    try index.insertSegment(
      recordingID: recordingID, sourceID: camera, sequence: 1, filename: filename,
      isInitialization: false, startWall: WallClock(seconds: 1_000), duration: 3,
      byteCount: 1, firstFrameID: 1
    )

    let result = try await ExportService(index: index, archives: archives, programDirectory: root)
      .export(
        sourceID: camera,
        displayName: "A",
        from: WallClock(seconds: 1_000.5),
        to: WallClock(seconds: 1_002.5),
        destinationDirectory: root.appendingPathComponent("Exports", isDirectory: true)
      )

    let track = try #require(try await AVURLAsset(url: result.url).loadTracks(withMediaType: .video).first)
    #expect(try await track.load(.naturalSize) == CGSize(width: 400, height: 240))
    #expect(try await TestMovie.videoPresentationTimes(of: result.url).count == 50)
    #expect(result.startWall == WallClock(seconds: 1_000.5))
  }

  // MARK: - Helpers

  /// Mean of the colour channels at one pixel of the frame showing at `seconds`, 0 to 255.
  static func brightness(in url: URL, at seconds: Double, x: Int, y: Int) async throws -> Double {
    let asset = AVURLAsset(url: url)
    let track = try #require(try await asset.loadTracks(withMediaType: .video).first)
    let reader = try AVAssetReader(asset: asset)
    reader.timeRange = CMTimeRange(
      start: CMTime(seconds: seconds, preferredTimescale: 600),
      duration: CMTime(seconds: 0.5, preferredTimescale: 600)
    )
    let output = AVAssetReaderTrackOutput(
      track: track,
      outputSettings: [ kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA ]
    )
    reader.add(output)
    #expect(reader.startReading())
    defer { reader.cancelReading() }
    let sample = try #require(output.copyNextSampleBuffer())
    let pixels = try #require(CMSampleBufferGetImageBuffer(sample))
    CVPixelBufferLockBaseAddress(pixels, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
    let base = try #require(CVPixelBufferGetBaseAddress(pixels))
    let pixel = base.advanced(by: y * CVPixelBufferGetBytesPerRow(pixels) + x * 4)
      .assumingMemoryBound(to: UInt8.self)
    return (Double(pixel[0]) + Double(pixel[1]) + Double(pixel[2])) / 3
  }

  /// How many of the file's pictures are keyframes.
  static func keyframeCount(of url: URL) async throws -> Int {
    let asset = AVURLAsset(url: url)
    let track = try #require(try await asset.loadTracks(withMediaType: .video).first)
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    reader.add(output)
    #expect(reader.startReading())
    var count = 0
    while let sample = output.copyNextSampleBuffer() {
      guard CMSampleBufferGetNumSamples(sample) > 0 else { continue }
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
        as? [[CFString: Any]]
      let notSync = attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false
      if !notSync { count += 1 }
    }
    return count
  }
}
