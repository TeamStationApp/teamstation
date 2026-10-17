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

  @Test("A hole is black once a second: its first frame, then every second after")
  func blankFramesOnceASecond() {
    #expect(ArchiveRemux.encodesBlankFrame(framesIntoHole: 0, rate: 30))
    #expect(!ArchiveRemux.encodesBlankFrame(framesIntoHole: 1, rate: 30))
    #expect(!ArchiveRemux.encodesBlankFrame(framesIntoHole: 29, rate: 30))
    #expect(ArchiveRemux.encodesBlankFrame(framesIntoHole: 30, rate: 30))
    #expect(ArchiveRemux.encodesBlankFrame(framesIntoHole: 120, rate: 60))
    #expect(!ArchiveRemux.encodesBlankFrame(framesIntoHole: 30, rate: 60))
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
    #expect(try await track.load(.segments).allSatisfy { !$0.isEmpty }, "no edit leaves the hole")
    let times = try await presentationTimes(destination).filter(\.isFinite).sorted()
    #expect(times.count < 80, "\(times.count) pictures, a repeated hole would be hundreds")
    // A black picture at the start of the hole and every second after, then the second part on time.
    let hole = times.filter { $0 > 0.49 && $0 < 30.49 }
    #expect(hole.count == 30, "\(hole)")
    #expect(zip(hole, hole.dropFirst()).allSatisfy { abs($1 - $0 - 1) < 0.002 }, "\(hole)")
    #expect(abs((times.first { $0 > 30.49 } ?? 0) - 30.5) < 0.002)
  }

  /// A phone's programme with a part, a ten-second absence, and a part that stops a second before
  /// the window does, with sound, as the phone exports it.
  @Test("The picture before a hole lasts one frame, the hole is black a picture a second, and the track runs the whole length")
  func holeIsBlackOnceASecond() async throws {
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

    // The last picture before the hole lasts one frame. The hole is ten black pictures a second
    // apart, each lasting a second. The second part starts at its own instant on a keyframe, and no
    // sample in the file lasts more than a second.
    let samples = try await timing(destination)
    let before = try #require(samples.last { $0.start < 0.49 })
    #expect(abs(before.start - 14.0 / 30) < 0.002)
    #expect(abs(before.duration - 1.0 / 30) < 0.002, "the picture before the hole lasts \(before.duration) s")
    let hole = samples.filter { $0.start > 0.49 && $0.start < 10.49 }
    #expect(hole.map(\.start).enumerated().allSatisfy { abs($1 - 0.5 - Double($0)) < 0.002 }, "\(hole)")
    #expect(hole.count == 10 && hole.allSatisfy { abs($0.duration - 1) < 0.002 }, "\(hole)")
    let after = try #require(samples.first { $0.start > 10.49 })
    #expect(abs(after.start - 10.5) < 0.002)
    #expect(after.sync, "the second part opens on a keyframe")
    let longest = samples.map(\.duration).max() ?? 0
    #expect(longest < 1.002, "a sample lasts \(longest) s")

    // The pictures are the right ones on both sides of the hole, the hole is black, and the last
    // picture repeats to the end.
    #expect(try await marked.marker(in: destination, at: 0.47) == 1_014)
    #expect(try await marked.marker(in: destination, at: 5) == nil)
    #expect(try await marked.marker(in: destination, at: 10.5) == 500_000)
    #expect(try await marked.marker(in: destination, at: 11.9) == 500_014)
  }

  /// Every sample's presentation time, duration and keyframe flag as stored, in the file's own media
  /// time.
  private func timing(_ url: URL) async throws -> [(start: Double, duration: Double, sync: Bool)] {
    let asset = AVURLAsset(url: url)
    guard let track = try await asset.loadTracks(withMediaType: .video).first else { return [] }
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    reader.add(output)
    guard reader.startReading() else { return [] }
    var found: [(start: Double, duration: Double, sync: Bool)] = []
    while let sample = output.copyNextSampleBuffer() {
      guard CMSampleBufferGetNumSamples(sample) > 0 else { continue }
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
      let sync = !((attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool) ?? false)
      found.append((
        CMSampleBufferGetPresentationTimeStamp(sample).seconds,
        CMSampleBufferGetDuration(sample).seconds,
        sync
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
