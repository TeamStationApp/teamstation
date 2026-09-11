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

  /// A rewind almost never starts on a segment boundary: it skips into its first file. The producer
  /// once counted that skip as footage already played and stopped short by exactly the skip — up
  /// to a whole segment — which is how one 5 s slow-mo played its full ten seconds and the next
  /// stopped at 7.8. The requested duration is measured from the first frame shown.
  @Test("A rewind that starts partway into a segment still produces the full requested duration")
  func capCountsFromFirstFrameNotFileStart() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("replay-skip-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    var urls: [URL] = []
    for index in 0..<3 {
      let url = root.appendingPathComponent("seg-\(index).mp4")
      try await writeTestMovie(to: url, seconds: 1.0, framesPerSecond: 10)
      urls.append(url)
    }

    let reader = ReplayFileReader(
      urls: urls,
      durations: [ 1.0, 1.0, 1.0 ],
      frameRate: 10,
      playDuration: 1.5
    )
    try reader.open(startOffset: 0.55)
    var first: TimeInterval?
    var last: TimeInterval = 0
    var count = 0
    // `next()` gives up after two seconds without a frame, which a loaded simulator can hit
    // mid-replay. Only the reader saying it is exhausted ends the replay; a timeout just asks again.
    let deadline = Date().addingTimeInterval(10)
    while count <= 100, Date() < deadline {
      guard let frame = reader.next() else {
        if reader.isExhausted { break }
        continue
      }
      if first == nil { first = frame.media }
      last = frame.media
      count += 1
    }
    let diagnostics = reader.diagnostics
    reader.cancel()
    let produced = last - (first ?? last) + 0.1
    // At least what was asked for, and at most one frame more: a replay ends on a whole frame.
    // Anything short is the bug this guards.
    let detail: Comment = "produced \(produced) s of a 1.5 s request; decode misses \(diagnostics.decodeMisses), failed readers \(diagnostics.failedReaders)"
    if diagnostics.decodeMisses == 0 {
      #expect(produced >= 1.5 - 0.001 && produced <= 1.6 + 0.001, detail)
    } else {
      // The simulator's decoder intermittently refuses a run of samples — nine, in every case seen
      // — and then the length depends on which ones it refused. Recorded, not failed: the reader is
      // judged above, on runs where the decoder delivered everything. The iPad's hardware decoder
      // played every rewind in full.
      withKnownIssue("simulator decoder dropped samples", isIntermittent: true) {
        #expect(produced >= 1.5 - 0.001 && produced <= 1.6 + 0.001, detail)
      }
    }
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

  @Test("Preload only pulls the next two files and a cancel drops the cache")
  func preloadDoesNotRetainTheWholeArchive() async {
    let urls = (0..<20).map { URL(fileURLWithPath: "/tmp/replay-preload-\($0).mp4") }
    ReplayFileReader.clearPreparedAssets()
    ReplayFileReader.preloadAssets(urls: urls, from: 0)
    let deadline = Date().addingTimeInterval(2)
    while Date() < deadline, ReplayFileReader.preparedAssetCount < 1 {
      try? await Task.sleep(nanoseconds: 20_000_000)
    }
    #expect(ReplayFileReader.preparedAssetCount <= ReplayFileReader.preloadAheadFiles)
    ReplayFileReader.clearPreparedAssets()
    try? await Task.sleep(nanoseconds: 300_000_000)
    #expect(ReplayFileReader.preparedAssetCount == 0)
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

/// A short H.264 movie of solid frames, for tests that need a real replay to attach.
func writeTestMovie(
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
