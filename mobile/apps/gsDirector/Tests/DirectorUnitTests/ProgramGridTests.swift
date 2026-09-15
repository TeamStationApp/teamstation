import AVFoundation
import CoreMedia
import CoreVideo
import DirectorCore
import DirectorPipeline
import DirectorSources
import Foundation
import Testing

/// The programme master on an exact grid, so an export can copy it as a constant frame rate.
@Suite("Programme master grid", .serialized)
struct ProgramGridTests {
  /// What the router does when its timer fires three frames late: the three skipped numbers and the
  /// due one arrive together, and each must still land one frame after the last.
  @Test("Frames a late timer skipped are written in their own slots, exactly one frame apart")
  func skippedFramesKeepTheGrid() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("program-grid-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let encoder = ProgramEncoder(
      telemetry: PipelineTelemetry(),
      converter: PixelConverter(),
      config: AppConfig(
        programCodec: .h264,
        programResolution: ProgramResolution(width: 160, height: 120),
        programFrameRate: 30,
        programBitrate: 1_000_000
      ),
      directory: root
    )
    try encoder.start(at: WallClock(date: Date()))
    let factory = try #require(PixelBufferFactory(width: 160, height: 120, pixelFormat: kCVPixelFormatType_32BGRA))
    let buffer = try #require(factory.makeBuffer())
    func frame(_ number: Int) {
      encoder.append(
        buffer,
        presentationTime: CMTime(value: CMTimeValue(number), timescale: 30),
        onClockGrid: true
      )
    }
    for number in 0 ..< 30 {
      frame(number)
      try await Task.sleep(nanoseconds: 33_000_000)
    }
    // The timer comes back four frames on: 30, 31 and 32 were skipped, 33 is due.
    try await Task.sleep(nanoseconds: 100_000_000)
    for number in 30 ... 33 { frame(number) }
    for number in 34 ..< 60 {
      try await Task.sleep(nanoseconds: 33_000_000)
      frame(number)
    }
    let url = try #require(await encoder.finish())

    let times = try await sampleTimes(of: url)
    let steps = zip(times.dropFirst(), times).map { $0 - $1 }
    let offGrid = steps.filter { abs($0 - 1.0 / 30) > 0.0005 }
    #expect(times.count == 60, "\(times.count) frames written for 60")
    #expect(offGrid.isEmpty, "\(offGrid.count) of \(steps.count) steps off 1/30 s: \(offGrid.prefix(5))")
  }

  private func sampleTimes(of url: URL) async throws -> [Double] {
    let asset = AVURLAsset(url: url)
    let track = try #require(try await asset.loadTracks(withMediaType: .video).first)
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    reader.add(output)
    reader.startReading()
    var times: [Double] = []
    while let sample = output.copyNextSampleBuffer() {
      guard CMSampleBufferGetNumSamples(sample) > 0 else { continue }
      times.append(CMSampleBufferGetPresentationTimeStamp(sample).seconds)
    }
    return times.sorted()
  }
}
