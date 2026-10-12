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

  /// Director keeps composing while Stop lays the tail. Frames that arrive during the fill used to
  /// be stamped among the fill's own, the writer refused them out of order and failed, and the
  /// stop that followed crashed. Live pictures now stop at the fill, and the file stays whole.
  @Test("Live pictures arriving during the Stop fill leave the master whole and on the grid")
  func livePicturesDuringTheTailFill() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("program-tail-\(UUID().uuidString)", isDirectory: true)
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
    let started = WallClock(date: Date())
    try encoder.start(at: started)
    let factory = try #require(PixelBufferFactory(width: 160, height: 120, pixelFormat: kCVPixelFormatType_32BGRA))
    let buffer = try #require(factory.makeBuffer())
    for number in 0 ..< 15 {
      encoder.append(buffer, presentationTime: CMTime(value: CMTimeValue(number), timescale: 30), onClockGrid: true)
      try await Task.sleep(nanoseconds: 33_000_000)
    }
    // The compositor carries on while the stop asks for two seconds more than it has written. Like
    // the programme clock, it hands over every frame number in order, the ones a late wake skipped
    // included, so a frame left out of the master can only be the encoder's doing.
    let feederStart = Date()
    let feeder = Task.detached {
      var number = 15
      while !Task.isCancelled {
        let due = 15 + Int(Date().timeIntervalSince(feederStart) * 30)
        while number <= due {
          encoder.append(buffer, presentationTime: CMTime(value: CMTimeValue(number), timescale: 30), onClockGrid: true)
          number += 1
        }
        try? await Task.sleep(nanoseconds: 33_000_000)
      }
    }
    let url = try #require(await encoder.finish(until: WallClock(seconds: started.seconds + 2.5)))
    feeder.cancel()
    _ = await feeder.value

    let times = try await sampleTimes(of: url)
    let steps = zip(times.dropFirst(), times).map { $0 - $1 }
    let offGrid = steps.filter { abs($0 - 1.0 / 30) > 0.0005 }
    #expect(times.count >= 60, "\(times.count) frames for a 2.5 s take")
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
