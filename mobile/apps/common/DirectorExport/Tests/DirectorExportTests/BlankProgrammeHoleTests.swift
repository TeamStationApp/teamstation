import AVFoundation
import CoreMedia
import Foundation
import Testing
import DirectorCore
import DirectorExport

@Suite("A programme hole", .serialized)
struct BlankProgrammeHoleTests {
  @Test("The frame before the next part is left blank")
  func frameBeforeTheNextPartIsBlank() {
    #expect(ArchiveRemux.leavesGapFrameBlank(hasNewPicture: false, hasShownPicture: true, hasLaterPicture: true))
    #expect(!ArchiveRemux.leavesGapFrameBlank(hasNewPicture: true, hasShownPicture: true, hasLaterPicture: true))
    #expect(!ArchiveRemux.leavesGapFrameBlank(hasNewPicture: false, hasShownPicture: false, hasLaterPicture: true))
    #expect(!ArchiveRemux.leavesGapFrameBlank(hasNewPicture: false, hasShownPicture: true, hasLaterPicture: false))
  }

  @Test("Two parts thirty seconds apart export with a hole and no repeated picture")
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
    let holes = try await track.load(.segments).filter(\.isEmpty).map(\.timeMapping.target)
    #expect(holes.count == 1)
    #expect(abs((holes.first?.start.seconds ?? 0) - 0.5) < 0.002)
    #expect(abs((holes.first?.duration.seconds ?? 0) - 30) < 0.002, "hole \(holes)")
    let times = try await presentationTimes(destination).filter(\.isFinite)
    #expect(times.count < 80, "\(times.count) pictures, a repeated hole would be hundreds")
  }

  /// A phone's programme with a part, a ten-second absence, and a part that stops a second before
  /// the window does, with sound, as the phone exports it.
  @Test("The picture before a hole lasts one frame, the hole is an empty edit, and the track runs the whole length")
  func holeIsAnEmptyEdit() async throws {
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

    // The first part, the hole, then the second part and the tail after it.
    let segments = try await track.load(.segments)
    try #require(segments.map(\.isEmpty) == [false, true, false])
    let targets = segments.map(\.timeMapping.target)
    #expect(abs(targets[0].end.seconds - 0.5) < 0.002)
    #expect(abs(targets[1].duration.seconds - 10) < 0.002)
    #expect(abs(targets[2].end.seconds - 12) < 0.002)

    // The sample before the hole is shown from one frame before the edit ends, and no sample in the
    // file is longer than a few frames: nothing is stretched across the hole.
    let samples = try await timing(destination)
    let before = try #require(samples.filter { $0.start < segments[0].timeMapping.source.end.seconds - 0.001 }
      .map(\.start).max())
    #expect(abs(segments[0].timeMapping.source.end.seconds - before - 1 / 30) < 0.002)
    let longest = samples.map(\.duration).max() ?? 0
    #expect(longest < 0.2, "a sample lasts \(longest) s")

    // The pictures are the right ones on both sides of the hole, and the last repeats to the end.
    #expect(try await marked.marker(in: destination, at: 0.47) == 1_014)
    #expect(try await marked.marker(in: destination, at: 10.5) == 500_000)
    #expect(try await marked.marker(in: destination, at: 11.9) == 500_014)
  }

  /// Every sample's presentation time and duration as stored, in the file's own media time.
  private func timing(_ url: URL) async throws -> [(start: Double, duration: Double)] {
    let asset = AVURLAsset(url: url)
    guard let track = try await asset.loadTracks(withMediaType: .video).first else { return [] }
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    reader.add(output)
    guard reader.startReading() else { return [] }
    var found: [(start: Double, duration: Double)] = []
    while let sample = output.copyNextSampleBuffer() {
      guard CMSampleBufferGetNumSamples(sample) > 0 else { continue }
      found.append((CMSampleBufferGetPresentationTimeStamp(sample).seconds, CMSampleBufferGetDuration(sample).seconds))
    }
    return found
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

  private func presentationTimes(_ url: URL) async throws -> [Double] {
    let asset = AVURLAsset(url: url)
    guard let track = try await asset.loadTracks(withMediaType: .video).first else { return [] }
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    reader.add(output)
    guard reader.startReading() else { return [] }
    var times: [Double] = []
    while let sample = output.copyNextSampleBuffer() {
      times.append(CMSampleBufferGetPresentationTimeStamp(sample).seconds)
    }
    return times
  }
}
