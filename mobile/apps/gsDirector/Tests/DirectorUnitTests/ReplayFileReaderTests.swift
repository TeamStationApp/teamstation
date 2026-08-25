import AVFoundation
import CoreVideo
import DirectorSources
import Foundation
import os
import Testing

@testable import DirectorPipeline

@Suite("Replay file reader")
struct ReplayFileReaderTests {
  @Test("A rewind spanning three complete files plays past the first file")
  func readsAcrossCompleteFiles() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("replay-files-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    var urls: [URL] = []
    for index in 0..<3 {
      let url = root.appendingPathComponent("seg-\(index).mp4")
      try await writeTestMovie(to: url, seconds: 0.6, framesPerSecond: 10)
      urls.append(url)
    }

    let reader = ReplayFileReader(urls: urls, durations: [ 0.6, 0.6, 0.6 ], frameRate: 10)
    try reader.open(startOffset: 0.2)
    var lastMedia: TimeInterval = 0
    var count = 0
    while let frame = reader.next() {
      lastMedia = frame.media
      count += 1
      if count > 80 { break }
    }
    reader.cancel()
    #expect(count > 10)
    #expect(lastMedia > 1.0)
  }

  @Test("A later append starts the next file while the current file is still playing")
  func appendStartsNextFileBeforeEOF() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("replay-append-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    var urls: [URL] = []
    for index in 0..<3 {
      let url = root.appendingPathComponent("seg-\(index).mp4")
      try await writeTestMovie(to: url, seconds: 0.6, framesPerSecond: 10)
      urls.append(url)
    }

    let reader = ReplayFileReader(urls: [ urls[0] ], durations: [ 0.6 ], frameRate: 10)
    try reader.open(startOffset: 0)
    reader.append(urls: [ urls[1], urls[2] ], durations: [ 0.6, 0.6 ])
    var lastMedia: TimeInterval = 0
    var count = 0
    while let frame = reader.next() {
      lastMedia = frame.media
      count += 1
      if count > 80 { break }
    }
    reader.cancel()
    #expect(count > 10)
    #expect(lastMedia > 1.0)
  }

  @Test("Skip walks samples from the first PTS so a file that does not start at zero still plays")
  func skipsHighPTSFile() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("replay-pts-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let url = root.appendingPathComponent("seg-high.mp4")
    try await writeTestMovie(to: url, seconds: 0.8, framesPerSecond: 10, ptsStart: 12)
    let reader = ReplayFileReader(urls: [ url ], durations: [ 0.8 ], frameRate: 10)
    try reader.open(startOffset: 0.2)
    var count = 0
    var lastMedia: TimeInterval = 0
    while let frame = reader.next() {
      lastMedia = frame.media
      count += 1
      if count > 40 { break }
    }
    reader.cancel()
    #expect(count >= 3)
    #expect(lastMedia < 1.0)
  }

  @Test("Instant replay plays the requested content duration across file boundaries")
  func decoderPlaysRequestedDuration() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("replay-decoder-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    var urls: [URL] = []
    for index in 0..<3 {
      let url = root.appendingPathComponent("seg-\(index).mp4")
      try await writeTestMovie(to: url, seconds: 0.6, framesPerSecond: 10)
      urls.append(url)
    }

    let finished = Expectation()
    let decoder = ReplayDecoder(
      configuration: .init(
        url: urls[0],
        startOffset: 0.1,
        frameRate: 10,
        port: 19_001,
        rate: 1,
        playDuration: 1.2,
        fileURLs: urls,
        fileDurations: [ 0.6, 0.6, 0.6 ]
      ),
      onFrame: { _, _, _ in },
      onFinish: { finished.fulfill() },
      onFailure: { error in
        Issue.record("replay failed: \(error)")
        finished.fulfill()
      }
    )
    let started = DispatchTime.now().uptimeNanoseconds
    try await decoder.start()
    try await finished.wait(seconds: 4)
    let elapsed = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000_000
    decoder.stop()
    #expect(elapsed >= 1.0)
    #expect(elapsed < 2.4)
    #expect(decoder.playedSeconds >= 1.0)
  }
}

private final class Expectation: @unchecked Sendable {
  private let flag = OSAllocatedUnfairLock(initialState: false)

  func fulfill() {
    flag.withLock { $0 = true }
  }

  func wait(seconds: TimeInterval) async throws {
    let deadline = ContinuousClock.now + .seconds(seconds)
    while ContinuousClock.now < deadline {
      if flag.withLock({ $0 }) { return }
      try await Task.sleep(for: .milliseconds(20))
    }
    throw ReplayTimeout()
  }
}

private struct ReplayTimeout: Error {}

private func writeTestMovie(
  to url: URL,
  seconds: TimeInterval,
  framesPerSecond: Double,
  ptsStart: TimeInterval = 0
) async throws {
  try? FileManager.default.removeItem(at: url)
  let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
  let input = AVAssetWriterInput(
    mediaType: .video,
    outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: 160,
      AVVideoHeightKey: 120
    ]
  )
  input.expectsMediaDataInRealTime = false
  let adaptor = AVAssetWriterInputPixelBufferAdaptor(
    assetWriterInput: input,
    sourcePixelBufferAttributes: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
      kCVPixelBufferWidthKey as String: 160,
      kCVPixelBufferHeightKey as String: 120
    ]
  )
  writer.add(input)
  writer.shouldOptimizeForNetworkUse = true
  guard writer.startWriting() else {
    throw ReplayTimeout()
  }
  let start = CMTime(seconds: ptsStart, preferredTimescale: 600)
  writer.startSession(atSourceTime: start)
  let frames = max(4, Int((seconds * framesPerSecond).rounded(.down)))
  let factory = PixelBufferFactory(
    width: 160,
    height: 120,
    pixelFormat: kCVPixelFormatType_32BGRA,
    minimumBuffers: 2,
    maximumBuffers: 4
  )
  for index in 0..<frames {
    while !input.isReadyForMoreMediaData {
      try await Task.sleep(for: .milliseconds(5))
    }
    let time = CMTime(
      seconds: ptsStart + Double(index) / framesPerSecond,
      preferredTimescale: 600
    )
    guard let buffer = factory?.makeBuffer() else { continue }
    adaptor.append(buffer, withPresentationTime: time)
  }
  input.markAsFinished()
  await writer.finishWriting()
  guard writer.status == .completed else {
    throw writer.error ?? ReplayTimeout()
  }
}
