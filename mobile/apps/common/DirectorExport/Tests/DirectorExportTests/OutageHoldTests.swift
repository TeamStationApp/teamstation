import AVFoundation
import CoreGraphics
import Foundation
import DirectorCore
import DirectorExport
import Testing

/// A hold long enough to be a real outage.
///
/// An app that was shut down and picked up again half an hour later leaves half an hour with no
/// pictures in every camera, and the export repeats the last picture before the hole as a real frame
/// at the output's rate all the way across it. That is 54,000 frames here, and "it works for nine
/// seconds" says nothing about whether half an hour of them comes out right, or in reasonable time.
/// This is the case the resume feature makes ordinary.
@Suite("Outage hold", .serialized)
struct OutageHoldTests {
  private static let width = 320
  private static let height = 240
  private static let fps = 30.0
  /// Small, so the test measures the cost of a frame rather than of a big one.
  private static let encoding = EncodeSettings(
    codec: .h264,
    resolution: ProgramResolution(width: width, height: height),
    frameRate: 30,
    bitrate: 1_000_000,
    keyframeSeconds: 2
  )

  @Test("A half-hour hole is repeated frame by frame, the file is as long as the take, and it stays quick")
  func halfAnHourOfHold() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("outage-hold-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    // Two seconds before the app went away, two seconds after it came back, and thirty minutes
    // of nothing in between — which is what a crash on the touchline and a walk back to the bench
    // actually looks like.
    let before = root.appendingPathComponent("before.mp4")
    let after = root.appendingPathComponent("after.mp4")
    try await movie(at: before, luma: 0.75, frames: 60)
    try await movie(at: after, luma: 0.25, frames: 60)

    let takeStart = WallClock(seconds: 1_759_000_000)
    let outage: TimeInterval = 30 * 60
    let takeSeconds = 2 + outage + 2
    let destination = root.appendingPathComponent("export.mp4")

    let started = Date()
    try await ArchiveRemux.stitch(
      files: [before, after],
      fileDurations: [2, 2],
      startWalls: [takeStart, takeStart + (2 + outage)],
      windowStart: takeStart,
      length: takeSeconds,
      settings: Self.encoding,
      destination: destination
    )
    let elapsed = Date().timeIntervalSince(started)

    let duration = try await AVURLAsset(url: destination).load(.duration).seconds
    #expect(abs(duration - takeSeconds) < 0.05, "exported \(duration)s, expected \(takeSeconds)s")

    // Real frames all the way across: one sample per frame of the take, none longer than a frame.
    // A held sample would show up here as one sample half an hour long.
    let times = try await TestMovie.videoPresentationTimes(of: destination).sorted()
    #expect(abs(times.count - Int(takeSeconds * Self.fps)) <= 1, "\(times.count) frames")
    let longest = zip(times, times.dropFirst()).map { $1 - $0 }.max() ?? 0
    #expect(longest <= 1 / Self.fps + 0.001, "a sample lasts \(longest) s")

    // A repeated picture costs an append and almost no bits. Measured on an M-series Mac, the
    // 54,000 frames of this take encode in about 10 s (5,000+ fps at this size) and the file is
    // under 10 MB. A minute leaves room for a slow simulator or a loaded machine, while a stitch
    // that did per-frame pixel work for a repeat, or re-read the source for each one, runs to
    // several minutes and fails here long before it shows on a recording.
    #expect(elapsed < 60, "stitching a half-hour hold took \(elapsed)s")

    // The hole holds the picture from before it, at both ends and in the middle, and the file
    // comes back to the second camera's picture afterwards.
    let head = try await luma(in: destination, at: 1.0)
    for probe in [10.0, outage / 2, outage - 10] {
      let held = try await luma(in: destination, at: 2 + probe)
      #expect(held != nil, "nothing decoded \(probe)s into the hole")
      if let held, let head {
        #expect(abs(held - head) < 12, "at \(probe)s into the hole the picture was \(held), not \(head)")
      }
    }
    let resumed = try await luma(in: destination, at: takeSeconds - 1)
    #expect(resumed != nil)
    if let resumed, let head {
      #expect(abs(resumed - head) > 20, "the picture after the hole should not be the held one")
    }
  }

  // MARK: - Helpers

  private func movie(at url: URL, luma: CGFloat, frames: Int) async throws {
    try? FileManager.default.removeItem(at: url)
    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    let input = AVAssetWriterInput(
      mediaType: .video,
      outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: Self.width,
        AVVideoHeightKey: Self.height
      ]
    )
    input.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(
      assetWriterInput: input,
      sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: Self.width,
        kCVPixelBufferHeightKey as String: Self.height
      ]
    )
    writer.add(input)
    #expect(writer.startWriting())
    writer.startSession(atSourceTime: .zero)
    for index in 0 ..< frames {
      while !input.isReadyForMoreMediaData {
        try await Task.sleep(for: .milliseconds(2))
      }
      guard let buffer = Self.paint(luma: luma) else { continue }
      adaptor.append(
        buffer,
        withPresentationTime: CMTime(seconds: Double(index) / Self.fps, preferredTimescale: 600)
      )
    }
    input.markAsFinished()
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      writer.finishWriting { continuation.resume() }
    }
  }

  private static func paint(luma: CGFloat) -> CVPixelBuffer? {
    var buffer: CVPixelBuffer?
    CVPixelBufferCreate(
      nil, width, height, kCVPixelFormatType_32BGRA,
      [kCVPixelBufferCGImageCompatibilityKey: true] as CFDictionary,
      &buffer
    )
    guard let buffer else { return nil }
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let context = CGContext(
      data: CVPixelBufferGetBaseAddress(buffer),
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    ) else { return nil }
    context.setFillColor(gray: luma, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    return buffer
  }

  /// Mean brightness of the frame at `seconds`, or nil where the file holds nothing there.
  private func luma(in url: URL, at seconds: Double) async throws -> Double? {
    let asset = AVURLAsset(url: url)
    guard let track = try await asset.loadTracks(withMediaType: .video).first else { return nil }
    let reader = try AVAssetReader(asset: asset)
    reader.timeRange = CMTimeRange(
      start: CMTime(seconds: seconds, preferredTimescale: 600),
      duration: CMTime(seconds: 1, preferredTimescale: 600)
    )
    let output = AVAssetReaderTrackOutput(
      track: track,
      outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
    )
    guard reader.canAdd(output) else { return nil }
    reader.add(output)
    guard reader.startReading() else { return nil }
    defer { reader.cancelReading() }
    guard let sample = output.copyNextSampleBuffer(),
      let pixels = CMSampleBufferGetImageBuffer(sample)
    else { return nil }
    CVPixelBufferLockBaseAddress(pixels, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(pixels) else { return nil }
    let stride = CVPixelBufferGetBytesPerRow(pixels)
    let rows = CVPixelBufferGetHeight(pixels)
    let columns = CVPixelBufferGetWidth(pixels)
    var total = 0.0
    var counted = 0
    for row in Swift.stride(from: 0, to: rows, by: 8) {
      let line = base.advanced(by: row * stride).assumingMemoryBound(to: UInt8.self)
      for column in Swift.stride(from: 0, to: columns, by: 8) {
        let pixel = line.advanced(by: column * 4)
        total += (Double(pixel[0]) + Double(pixel[1]) + Double(pixel[2])) / 3
        counted += 1
      }
    }
    return counted > 0 ? total / Double(counted) : nil
  }
}
