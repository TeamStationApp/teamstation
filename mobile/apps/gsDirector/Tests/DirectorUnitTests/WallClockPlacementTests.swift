import AVFoundation
import CoreGraphics
import Foundation
import DirectorCore
import DirectorDVR
import DirectorSources
import Testing

/// End-to-end proof that a segment lands where it happened.
///
/// Two real MP4s are encoded with a `FrameMarker` painted into every frame, indexed thirteen
/// seconds apart with only three seconds of tape in each, remuxed, and then decoded back. Reading
/// the marker out of the exported picture is the only check that cannot be satisfied by bookkeeping:
/// it says which frame is actually at a given moment of the file.
@Suite("Wall-clock placement", .serialized)
struct WallClockPlacementTests {
  private static let width = 800
  private static let height = 120
  private static let fps = 30.0

  private func markedMovie(at url: URL, firstValue: Int, frames: Int) async throws {
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
    for index in 0..<frames {
      while !input.isReadyForMoreMediaData {
        try await Task.sleep(for: .milliseconds(2))
      }
      guard let buffer = Self.paint(value: firstValue + index) else { continue }
      adaptor.append(
        buffer,
        withPresentationTime: CMTime(seconds: Double(index) / Self.fps, preferredTimescale: 600)
      )
    }
    input.markAsFinished()
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
      writer.finishWriting { c.resume() }
    }
  }

  private static func paint(value: Int) -> CVPixelBuffer? {
    var buffer: CVPixelBuffer?
    CVPixelBufferCreate(
      nil, width, height, kCVPixelFormatType_32BGRA,
      [ kCVPixelBufferCGImageCompatibilityKey: true ] as CFDictionary,
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
    // CoreGraphics is bottom-left; the buffer is top-down, which is what FrameMarker.read walks.
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: 1, y: -1)
    context.setFillColor(gray: 0.5, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    FrameMarker.draw(value: value, in: context)
    return buffer
  }

  /// Reads the marker out of the exported file at `seconds`, or nil where nothing was written.
  ///
  /// Decoded straight into BGRA at the file's own size with `AVAssetReader`, rather than going
  /// through `AVAssetImageGenerator`. The generator hands back a `CGImage`, and redrawing that into
  /// a buffer loses the marker — the cells are read at fixed pixel coordinates, so any resampling
  /// on the way through is fatal to them. This is also closer to what a verifier has to do.
  private func marker(in url: URL, at seconds: Double) async throws -> Int? {
    let asset = AVURLAsset(url: url)
    guard let track = try await asset.loadTracks(withMediaType: .video).first else { return nil }
    let reader = try AVAssetReader(asset: asset)
    reader.timeRange = CMTimeRange(
      start: CMTime(seconds: seconds, preferredTimescale: 600),
      duration: CMTime(seconds: 0.5, preferredTimescale: 600)
    )
    let output = AVAssetReaderTrackOutput(
      track: track,
      outputSettings: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
      ]
    )
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else { return nil }
    reader.add(output)
    guard reader.startReading() else { return nil }
    defer { reader.cancelReading() }
    while let sample = output.copyNextSampleBuffer() {
      guard let buffer = CMSampleBufferGetImageBuffer(sample) else { continue }
      if let value = FrameMarker.read(from: buffer) { return value }
    }
    return nil
  }

  @Test("The painter and the reader agree before any encoding is involved")
  func markerRoundTripsInMemory() throws {
    let buffer = try #require(Self.paint(value: 1_030))
    #expect(FrameMarker.read(from: buffer) == 1_030)
  }

  @Test("A segment after a dropout is exported where it happened, not where the tape ran to")
  func placesAfterGap() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("place-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let first = root.appendingPathComponent("a.mp4")
    let second = root.appendingPathComponent("b.mp4")
    // Three seconds each, thirteen seconds apart: a ten-second dropout in the middle.
    try await markedMovie(at: first, firstValue: 1_000, frames: 90)
    try await markedMovie(at: second, firstValue: 500_000, frames: 90)

    let out = root.appendingPathComponent("out.mp4")
    try await ArchiveRemux.concatenate(
      files: [ first, second ],
      fileDurations: [ 3, 3 ],
      targetDuration: 16,
      startWalls: [ WallClock(seconds: 1_000), WallClock(seconds: 1_013) ],
      windowStart: WallClock(seconds: 1_000),
      destination: out
    )

    let duration = try await AVURLAsset(url: out).load(.duration).seconds
    // Sixteen seconds of wall clock, not the six seconds of tape it contains.
    #expect(abs(duration - 16) < 0.35)

    // One second in: the first segment, thirty frames past its start.
    let early = try await marker(in: out, at: 1.0)
    #expect(early != nil)
    #expect(abs((early ?? 0) - 1_030) <= 2)

    // Thirteen and a half seconds in: the second segment, which happened then. Before this fix it
    // sat at three seconds, ten seconds early, and every later frame with it.
    let late = try await marker(in: out, at: 13.5)
    #expect(late != nil)
    let expected = (500_000 + 15) & FrameMarker.maximumValue
    #expect(abs((late ?? 0) - expected) <= 2)
  }

  /// A gap holds the picture that was there before it.
  ///
  /// Placement alone leaves a real gap as an empty range, and an empty range has no samples at all —
  /// measured, every probe across the hole decoded nothing. So the freeze is manufactured: the last
  /// frame before the gap is inserted once and scaled to the length of the hole, which a passthrough
  /// export honours. One sample, not one per frame, so a 150 s dropout costs a single insertion.
  @Test("A gap holds the last frame before it, all the way across")
  func gapHoldsLastFrame() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("gapc-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let first = root.appendingPathComponent("a.mp4")
    let second = root.appendingPathComponent("b.mp4")
    try await markedMovie(at: first, firstValue: 1_000, frames: 90)
    try await markedMovie(at: second, firstValue: 500_000, frames: 90)

    let out = root.appendingPathComponent("out.mp4")
    try await ArchiveRemux.concatenate(
      files: [ first, second ],
      fileDurations: [ 3, 3 ],
      targetDuration: 16,
      startWalls: [ WallClock(seconds: 1_000), WallClock(seconds: 1_013) ],
      windowStart: WallClock(seconds: 1_000),
      destination: out
    )

    let lastBeforeGap = (1_000 + 89) & FrameMarker.maximumValue
    // Sampled right after the gap opens, in its middle, and just before it closes: a hold that only
    // covered part of the hole would pass a single probe in the middle.
    for instant in [ 3.5, 8.0, 12.5 ] {
      let value = try await marker(in: out, at: instant)
      #expect(value != nil, "nothing at \(instant)s — the gap is empty, not held")
      #expect(abs((value ?? 0) - lastBeforeGap) <= 2, "wrong picture held at \(instant)s")
    }

    // The hold must not run over the segment that follows it.
    let after = try await marker(in: out, at: 14.5)
    #expect(abs((after ?? 0) - ((500_000 + 45) & FrameMarker.maximumValue)) <= 2)
  }

  @Test("A camera that stops early holds its last frame to the end of the window")
  func tailHoldsLastFrame() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("tail-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let only = root.appendingPathComponent("a.mp4")
    try await markedMovie(at: only, firstValue: 7_000, frames: 90)

    let out = root.appendingPathComponent("out.mp4")
    try await ArchiveRemux.concatenate(
      files: [ only ],
      fileDurations: [ 3 ],
      targetDuration: 10,
      startWalls: [ WallClock(seconds: 2_000) ],
      windowStart: WallClock(seconds: 2_000),
      destination: out
    )

    let duration = try await AVURLAsset(url: out).load(.duration).seconds
    #expect(abs(duration - 10) < 0.35)
    // Seven seconds of tail the camera never covered, holding its last picture rather than going
    // black — the same answer a mid-take dropout gets.
    let value = try await marker(in: out, at: 8.0)
    #expect(value != nil)
    #expect(abs((value ?? 0) - ((7_000 + 89) & FrameMarker.maximumValue)) <= 2)
  }

  @Test("Two cameras that dropped out differently still line up with each other")
  func anglesAgreeAcrossDifferentGaps() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("pair-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    // Camera A loses the middle; camera B runs clean but joins two seconds late.
    let a1 = root.appendingPathComponent("a1.mp4")
    let a2 = root.appendingPathComponent("a2.mp4")
    let b1 = root.appendingPathComponent("b1.mp4")
    try await markedMovie(at: a1, firstValue: 10_000, frames: 90)
    try await markedMovie(at: a2, firstValue: 20_000, frames: 90)
    try await markedMovie(at: b1, firstValue: 30_000, frames: 90)

    let outA = root.appendingPathComponent("outA.mp4")
    let outB = root.appendingPathComponent("outB.mp4")
    try await ArchiveRemux.concatenate(
      files: [ a1, a2 ],
      fileDurations: [ 3, 3 ],
      targetDuration: 16,
      startWalls: [ WallClock(seconds: 1_000), WallClock(seconds: 1_013) ],
      windowStart: WallClock(seconds: 1_000),
      destination: outA
    )
    try await ArchiveRemux.concatenate(
      files: [ b1 ],
      fileDurations: [ 3 ],
      targetDuration: 16,
      startWalls: [ WallClock(seconds: 1_013) ],
      windowStart: WallClock(seconds: 1_000),
      destination: outB
    )

    let durationA = try await AVURLAsset(url: outA).load(.duration).seconds
    let durationB = try await AVURLAsset(url: outB).load(.duration).seconds
    // Same length whatever each camera lost — which is what lets them be played side by side.
    #expect(abs(durationA - durationB) < 0.35)

    // And at the same instant, both are showing the frame they captured then.
    let atA = try await marker(in: outA, at: 13.5)
    let atB = try await marker(in: outB, at: 13.5)
    #expect(atA != nil)
    #expect(atB != nil)
    #expect(abs((atA ?? 0) - ((20_000 + 15) & FrameMarker.maximumValue)) <= 2)
    #expect(abs((atB ?? 0) - ((30_000 + 15) & FrameMarker.maximumValue)) <= 2)
  }
}
