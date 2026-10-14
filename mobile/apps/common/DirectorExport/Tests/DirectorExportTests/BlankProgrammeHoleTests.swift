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
    #expect(ArchiveRemux.leavesGapFrameBlank(hasNewPicture: false, hasShownPicture: true))
    #expect(!ArchiveRemux.leavesGapFrameBlank(hasNewPicture: true, hasShownPicture: true))
    #expect(!ArchiveRemux.leavesGapFrameBlank(hasNewPicture: false, hasShownPicture: false))
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
    let times = try await presentationTimes(destination).filter(\.isFinite).sorted()
    let gaps = zip(times, times.dropFirst()).map { $1 - $0 }
    let hole = gaps.max() ?? 0
    #expect(abs(hole - 30) < 0.5, "hole \(hole)")
    #expect(times.count < 80, "\(times.count) pictures, a repeated hole would be hundreds")
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
