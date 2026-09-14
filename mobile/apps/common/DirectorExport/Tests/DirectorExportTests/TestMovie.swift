import AVFoundation
import Foundation

/// Small H.264 movies for export tests: real files AVFoundation can remux, made in a few
/// milliseconds each.
enum TestMovie {
  static let width = 320
  static let height = 180
  static let fps = 30.0

  /// `frames` frames of flat grey at 30 fps, creating the parent directory as needed.
  static func write(to url: URL, frames: Int) async throws {
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try? FileManager.default.removeItem(at: url)
    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    let input = AVAssetWriterInput(
      mediaType: .video,
      outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: width,
        AVVideoHeightKey: height
      ]
    )
    input.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(
      assetWriterInput: input,
      sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: width,
        kCVPixelBufferHeightKey as String: height
      ]
    )
    writer.add(input)
    guard writer.startWriting() else {
      throw writer.error ?? CocoaError(.fileWriteUnknown)
    }
    writer.startSession(atSourceTime: .zero)
    for index in 0..<frames {
      while !input.isReadyForMoreMediaData {
        try await Task.sleep(for: .milliseconds(2))
      }
      var buffer: CVPixelBuffer?
      CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, nil, &buffer)
      guard let buffer else { continue }
      CVPixelBufferLockBaseAddress(buffer, [])
      if let base = CVPixelBufferGetBaseAddress(buffer) {
        memset(base, 0x80, CVPixelBufferGetBytesPerRow(buffer) * height)
      }
      CVPixelBufferUnlockBaseAddress(buffer, [])
      adaptor.append(
        buffer,
        withPresentationTime: CMTime(seconds: Double(index) / fps, preferredTimescale: 600)
      )
    }
    input.markAsFinished()
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
      writer.finishWriting { c.resume() }
    }
  }

  /// Presentation times of every video sample, in decode order, read straight out of the file.
  static func videoPresentationTimes(of url: URL) async throws -> [Double] {
    let asset = AVURLAsset(url: url)
    guard let track = try await asset.loadTracks(withMediaType: .video).first else { return [] }
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    reader.add(output)
    reader.startReading()
    var times: [Double] = []
    while let sample = output.copyNextSampleBuffer() {
      guard CMSampleBufferGetNumSamples(sample) > 0 else { continue }
      times.append(CMSampleBufferGetPresentationTimeStamp(sample).seconds)
    }
    return times
  }
}
