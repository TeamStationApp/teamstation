import AVFoundation
import CoreMedia
import Foundation
import Testing
import DirectorCore
import DirectorExport

@Suite("A programme hole", .serialized)
struct BlankProgrammeHoleTests {
  @Test("Only the stretch from one part's last picture to the next part's first is blank")
  func frameBeforeTheNextPartIsBlank() {
    #expect(ArchiveRemux.leavesGapFrameBlank(hasNewPicture: false, shownPart: 0, nextPart: 1))
    #expect(!ArchiveRemux.leavesGapFrameBlank(hasNewPicture: true, shownPart: 0, nextPart: 1))
    #expect(!ArchiveRemux.leavesGapFrameBlank(hasNewPicture: false, shownPart: nil, nextPart: 1))
    #expect(!ArchiveRemux.leavesGapFrameBlank(hasNewPicture: false, shownPart: 1, nextPart: nil))
    // A frame inside a part with no new picture repeats the one before.
    #expect(!ArchiveRemux.leavesGapFrameBlank(hasNewPicture: false, shownPart: 1, nextPart: 1))
  }

  @Test("Two parts thirty seconds apart export a black frame every frame of the hole, on the grid, and no repeated picture")
  func holeIsWallClock() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("blank-hole-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let first = root.appendingPathComponent("a.mp4")
    let second = root.appendingPathComponent("b.mp4")
    try await movie(first, seconds: 0.5)
    try await movie(second, seconds: 0.5)
    let destination = root.appendingPathComponent("out.mp4")
    let settings = EncodeSettings(
      codec: .h264,
      resolution: ProgramResolution(width: 160, height: 120),
      frameRate: 30,
      bitrate: 400_000,
      keyframeSeconds: 1
    )
    try await ArchiveRemux.stitch(
      files: [first, second],
      fileDurations: [0.5, 0.5],
      startWalls: [WallClock(seconds: 0), WallClock(seconds: 30.5)],
      windowStart: WallClock(seconds: 0),
      length: 31,
      settings: settings,
      destination: destination,
      blankGaps: true
    )
    let asset = AVURLAsset(url: destination)
    let track = try #require(try await asset.loadTracks(withMediaType: .video).first)
    #expect(try await track.load(.segments).allSatisfy { !$0.isEmpty }, "no edit leaves the hole")
    // A picture every frame of the output, each once and on the 30 fps grid: the hole is 900 black
    // frames, then the second part on time.
    let samples = try await timing(destination)
    let times = samples.map(\.start)
    #expect(times.count == 31 * 30, "\(times.count) pictures in 31 s at 30 fps")
    #expect(Self.onTheGrid(times), "a picture off the frame grid: \(times)")
    #expect(zip(times, times.dropFirst()).allSatisfy { abs($1 - $0 - Self.frame) < 0.0005 }, "a frame missing or replayed")
    let hole = samples.filter { $0.start > 0.49 && $0.start < 30.49 }
    #expect(hole.count == 900, "\(hole.count) frames in the hole")
    #expect(hole.allSatisfy { abs($0.duration - Self.frame) < 0.0005 }, "a frame of the hole is held")
    #expect(abs((times.first { $0 > 30.49 } ?? 0) - 30.5) < 0.002)
    // Black repeated every frame costs next to nothing: the hole is far under the take's bitrate.
    let perSecond = Double(hole.map(\.bytes).reduce(0, +)) / 30
    print("hole at 160x120 H.264: \(Int(perSecond)) bytes a second")
    #expect(perSecond < 4_000, "the hole costs \(perSecond) bytes a second")
  }

  /// A phone's own export settings, HEVC 1080p at 30 fps, 6 Mbps and a keyframe every 2 s, across a
  /// ten-second hole: a black picture every frame, each lasting one frame, keyframes at the
  /// encoder's own spacing, and the hole a few kilobytes a second where the take is 750.
  @Test("At the phone's settings a hole is a black frame every frame and costs a few kilobytes a second")
  func holeAtThePhonesSettingsIsSmall() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("blank-phone-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let first = root.appendingPathComponent("a.mp4")
    let second = root.appendingPathComponent("b.mp4")
    try await movie(first, seconds: 0.5)
    try await movie(second, seconds: 0.5)
    let destination = root.appendingPathComponent("out.mp4")
    let settings = EncodeSettings(
      codec: .hevc,
      resolution: .hd1080,
      frameRate: 30,
      bitrate: 6_000_000,
      keyframeSeconds: 2
    )
    try await ArchiveRemux.stitch(
      files: [first, second],
      fileDurations: [0.5, 0.5],
      startWalls: [WallClock(seconds: 0), WallClock(seconds: 10.5)],
      windowStart: WallClock(seconds: 0),
      length: 11,
      settings: settings,
      destination: destination,
      blankGaps: true
    )
    let samples = try await timing(destination)
    #expect(samples.count == 11 * 30, "\(samples.count) pictures in 11 s at 30 fps")
    #expect(Self.onTheGrid(samples.map(\.start)))
    #expect(samples.allSatisfy { abs($0.duration - Self.frame) < 0.0005 }, "a picture is held")
    let hole = samples.filter { $0.start > 0.49 && $0.start < 10.49 }
    #expect(hole.count == 300, "\(hole.count) frames in the hole")
    // Keyframes inside the hole come at the encoder's spacing, never more than 2 s apart.
    let keys = hole.enumerated().filter(\.element.sync).map(\.offset)
    #expect(zip([-1] + keys, keys + [hole.count]).allSatisfy { $1 - $0 <= 60 }, "keyframes in the hole at \(keys)")
    #expect(samples.first { $0.start > 10.49 }?.sync == true, "the return opens on a keyframe")
    let perSecond = Double(hole.map(\.bytes).reduce(0, +)) / 10
    print("hole at the phone's settings (HEVC 1080p30, 6 Mbps, 2 s GOP): \(Int(perSecond)) bytes a second")
    #expect(perSecond < 50_000, "the hole costs \(perSecond) bytes a second")
  }

  static let frame = 1.0 / 30

  /// Whether every time is a whole number of 30 fps frames.
  static func onTheGrid(_ times: [Double]) -> Bool {
    times.allSatisfy { abs($0 * 30 - ($0 * 30).rounded()) < 0.015 }
  }

  /// A phone's programme with a part, a ten-second absence, and a part that stops a second before
  /// the window does, with sound, as the phone exports it.
  @Test("The picture before a hole lasts one frame, the hole is black every frame, and the track runs the whole length")
  func holeIsBlackEveryFrame() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("blank-edit-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let marked = WallClockPlacementTests()
    let first = root.appendingPathComponent("a.mp4")
    let second = root.appendingPathComponent("b.mp4")
    try await marked.markedMovieWithAudio(at: first, firstValue: 1_000, frames: 15)
    try await marked.markedMovieWithAudio(at: second, firstValue: 500_000, frames: 15)
    let destination = root.appendingPathComponent("out.mp4")
    try await ArchiveRemux.stitch(
      files: [first, second],
      fileDurations: [0.5, 0.5],
      startWalls: [WallClock(seconds: 0), WallClock(seconds: 10.5)],
      windowStart: WallClock(seconds: 0),
      length: 12,
      settings: WallClockPlacementTests.encoding,
      destination: destination,
      blankGaps: true
    )

    let asset = AVURLAsset(url: destination)
    let track = try #require(try await asset.loadTracks(withMediaType: .video).first)
    #expect(abs(try await track.load(.timeRange).duration.seconds - 12) < 0.002)
    let sound = try #require(try await asset.loadTracks(withMediaType: .audio).first)
    #expect(abs(try await sound.load(.timeRange).duration.seconds - 12) < 0.05)

    // One edit, the whole file: no reader has an edit list to apply.
    #expect(try await track.load(.segments).allSatisfy { !$0.isEmpty })

    // The last picture before the hole lasts one frame. The hole is 300 black pictures, one every
    // frame on the 30 fps grid, each lasting one frame, with keyframes at the encoder's own spacing
    // (a second here). The second part starts at its own instant on a keyframe. No sample in the
    // file lasts more than a frame.
    let samples = try await timing(destination)
    #expect(samples.count == 12 * 30, "\(samples.count) pictures in 12 s at 30 fps")
    #expect(Self.onTheGrid(samples.map(\.start)), "a picture off the frame grid")
    let before = try #require(samples.last { $0.start < 0.49 })
    #expect(abs(before.start - 14.0 / 30) < 0.002)
    #expect(abs(before.duration - Self.frame) < 0.0005, "the picture before the hole lasts \(before.duration) s")
    let hole = samples.filter { $0.start > 0.49 && $0.start < 10.49 }
    #expect(hole.count == 300, "\(hole.count) frames in the hole")
    #expect(hole.enumerated().allSatisfy { abs($1.start - 0.5 - Double($0) * Self.frame) < 0.0005 }, "\(hole.map(\.start))")
    #expect(hole.allSatisfy { abs($0.duration - Self.frame) < 0.0005 }, "a frame of the hole is held")
    let keys = hole.enumerated().filter(\.element.sync).map(\.offset)
    #expect(zip([-1] + keys, keys + [hole.count]).allSatisfy { $1 - $0 <= 30 }, "keyframes in the hole at \(keys)")
    let after = try #require(samples.first { $0.start > 10.49 })
    #expect(abs(after.start - 10.5) < 0.002)
    #expect(after.sync, "the second part opens on a keyframe")
    let longest = samples.map(\.duration).max() ?? 0
    #expect(longest < Self.frame + 0.0005, "a sample lasts \(longest) s")

    // The pictures are the right ones on both sides of the hole, the hole is black, and the last
    // picture repeats to the end.
    #expect(try await marked.marker(in: destination, at: 0.47) == 1_014)
    #expect(try await marked.marker(in: destination, at: 5) == nil)
    #expect(try await marked.marker(in: destination, at: 10.5) == 500_000)
    #expect(try await marked.marker(in: destination, at: 11.9) == 500_014)
  }

  /// A part that dropped a frame, then a hole, then a part: the dropped frame repeats the picture
  /// before it, inside the part, and only the stretch between the parts is black.
  @Test("A frame missing inside a part repeats the picture before it, and only the gap between parts is black")
  func missingFrameInsideAPartIsNotAHole() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("blank-missing-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let marked = WallClockPlacementTests()
    let first = root.appendingPathComponent("a.mp4")
    let second = root.appendingPathComponent("b.mp4")
    try await marked.markedMovieWithAudio(at: first, firstValue: 1_000, frames: 15, skipping: [7])
    try await marked.markedMovieWithAudio(at: second, firstValue: 500_000, frames: 15)
    let destination = root.appendingPathComponent("out.mp4")
    try await ArchiveRemux.stitch(
      files: [first, second],
      fileDurations: [0.5, 0.5],
      startWalls: [WallClock(seconds: 0), WallClock(seconds: 3.5)],
      windowStart: WallClock(seconds: 0),
      length: 4,
      settings: WallClockPlacementTests.encoding,
      destination: destination,
      blankGaps: true
    )

    // Every frame of the first part is in the file, the missing one included, each one frame long.
    let samples = try await timing(destination)
    let part = samples.filter { $0.start < 0.49 }
    #expect(part.count == 15, "\(part.map(\.start))")
    #expect(part.allSatisfy { abs($0.duration - 1.0 / 30) < 0.002 }, "\(part.map(\.duration))")
    #expect(part.dropFirst().allSatisfy { !$0.sync }, "no keyframe is forced inside the part")
    // The missing frame shows the picture before it.
    #expect(try await marked.marker(in: destination, at: 7.0 / 30) == 1_006)
    #expect(try await marked.marker(in: destination, at: 8.0 / 30) == 1_008)
    // The gap between the parts is black every frame, each lasting one frame.
    let hole = samples.filter { $0.start > 0.49 && $0.start < 3.49 }
    #expect(hole.enumerated().allSatisfy { abs($1.start - 0.5 - Double($0) * Self.frame) < 0.0005 }, "\(hole.map(\.start))")
    #expect(hole.count == 90, "\(hole.count) frames in the hole")
    #expect(hole.allSatisfy { abs($0.duration - Self.frame) < 0.0005 })
    #expect(try await marked.marker(in: destination, at: 2) == nil)
    #expect(try await marked.marker(in: destination, at: 3.5) == 500_000)
  }

  /// Every sample's presentation time, duration, keyframe flag and size as stored, in the file's own
  /// media time.
  private func timing(_ url: URL) async throws -> [(start: Double, duration: Double, sync: Bool, bytes: Int)] {
    let asset = AVURLAsset(url: url)
    guard let track = try await asset.loadTracks(withMediaType: .video).first else { return [] }
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    reader.add(output)
    guard reader.startReading() else { return [] }
    var found: [(start: Double, duration: Double, sync: Bool, bytes: Int)] = []
    while let sample = output.copyNextSampleBuffer() {
      guard CMSampleBufferGetNumSamples(sample) > 0 else { continue }
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
      let sync = !((attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool) ?? false)
      found.append((
        CMSampleBufferGetPresentationTimeStamp(sample).seconds,
        CMSampleBufferGetDuration(sample).seconds,
        sync,
        CMSampleBufferGetTotalSampleSize(sample)
      ))
    }
    return found.sorted { $0.start < $1.start }
  }

  private func movie(_ url: URL, seconds: Double) async throws {
    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: 160,
      AVVideoHeightKey: 120
    ])
    input.expectsMediaDataInRealTime = false
    writer.add(input)
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(
      assetWriterInput: input,
      sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: 160,
        kCVPixelBufferHeightKey as String: 120
      ]
    )
    writer.startWriting()
    writer.startSession(atSourceTime: .zero)
    let frames = Int(seconds * 30)
    for frame in 0 ..< frames {
      while !input.isReadyForMoreMediaData {
        try await Task.sleep(for: .milliseconds(2))
      }
      var buffer: CVPixelBuffer?
      CVPixelBufferCreate(kCFAllocatorDefault, 160, 120, kCVPixelFormatType_32BGRA, nil, &buffer)
      guard let buffer else { throw CancellationError() }
      adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: 30))
    }
    input.markAsFinished()
    await writer.finishWriting()
    if writer.status != .completed {
      throw writer.error ?? CancellationError()
    }
  }
}
