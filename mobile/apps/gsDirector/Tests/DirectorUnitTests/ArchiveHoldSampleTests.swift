import AVFoundation
import CoreMedia
import DirectorDVR
import Foundation
import Testing

/// The hold across a seam takes exactly the last sample, not one nominal frame back from the end.
///
/// A Pixel's 59.5 fps is written as ten- and eleven-tick samples at a 600 timescale, so a frame's
/// worth measured back from where a segment ends begins a tick inside the sample before. Holding
/// that range carried a sliver of the earlier picture into every seam, and a passthrough export
/// wrote the slivers as one-tick samples behind their own edits: rec-412's Pixel picture came out
/// 101 ms per 1,000 s early.
@Suite("Seam hold sample")
struct ArchiveHoldSampleTests {
  /// Frame times of a 59.5 fps camera on a 600 timescale: steps of ten and eleven ticks.
  private static let ticks: [Int64] = (0..<30).map { Int64((Double($0) * 600 / 59.5).rounded()) }

  /// Presentation times as the file actually holds them. The writer may move a sample by a tick, so
  /// the test reads back rather than trusting what it asked for.
  private func sampleTimes(of track: AVAssetTrack, in asset: AVAsset) throws -> [CMTime] {
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    reader.add(output)
    #expect(reader.startReading())
    var times: [CMTime] = []
    while let sample = output.copyNextSampleBuffer() {
      if CMSampleBufferGetNumSamples(sample) > 0 { times.append(CMSampleBufferGetPresentationTimeStamp(sample)) }
    }
    return times.sorted()
  }

  private func pixelLikeMovie() async throws -> URL {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("hold-\(UUID().uuidString).mp4")
    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    let input = AVAssetWriterInput(
      mediaType: .video,
      outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 160, AVVideoHeightKey: 96]
    )
    input.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
    writer.add(input)
    #expect(writer.startWriting())
    writer.startSession(atSourceTime: .zero)
    for tick in Self.ticks {
      while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(2)) }
      var buffer: CVPixelBuffer?
      CVPixelBufferCreate(nil, 160, 96, kCVPixelFormatType_32BGRA, nil, &buffer)
      adaptor.append(try #require(buffer), withPresentationTime: CMTime(value: tick, timescale: 600))
    }
    input.markAsFinished()
    await writer.finishWriting()
    return url
  }

  @Test("A segment that ends inside its last sample holds that sample from its own start")
  func endInsideLastSample() async throws {
    let url = try await pixelLikeMovie()
    defer { try? FileManager.default.removeItem(at: url) }
    let asset = AVURLAsset(url: url)
    let track = try #require(try await asset.loadTracks(withMediaType: .video).first)
    let times = try sampleTimes(of: track, in: asset)
    let last = try #require(times.last)
    // Nine ticks into a ten- or eleven-tick sample, as the archive's recorded duration usually is.
    let end = CMTimeAdd(last, CMTime(value: 9, timescale: 600))

    let held = try #require(await ArchiveRemux.lastSample(of: track, endingBy: end))
    #expect(held.start == last)
    #expect(held.end == end)
    // What the nominal frame gave instead: ten ticks back from the end is a tick inside the sample
    // before, which is the sliver this replaced.
    let nominal = CMTimeSubtract(end, CMTime(value: 10, timescale: 600))
    #expect(nominal < held.start)
  }

  @Test("An end exactly on a sample boundary holds the sample before it, not the one starting there")
  func endOnBoundary() async throws {
    let url = try await pixelLikeMovie()
    defer { try? FileManager.default.removeItem(at: url) }
    let asset = AVURLAsset(url: url)
    let track = try #require(try await asset.loadTracks(withMediaType: .video).first)
    let times = try sampleTimes(of: track, in: asset)
    try #require(times.count == Self.ticks.count)
    let end = times[20]

    let held = try #require(await ArchiveRemux.lastSample(of: track, endingBy: end))
    #expect(held.start == times[19])
    #expect(held.end == end)
  }
}
