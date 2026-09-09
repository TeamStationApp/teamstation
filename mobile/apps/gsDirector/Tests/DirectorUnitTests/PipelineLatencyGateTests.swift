import CoreMedia
import CoreVideo
import Foundation
import Testing
import DirectorCore
import DirectorPipeline
import DirectorSources

/// The gate's own arithmetic is covered in `FrameLatencyGateTests`. What matters here is that the
/// pipeline actually consults it on the way to disk, and reads the same clock the DVR does.
@Suite("Pipeline latency gate")
struct PipelineLatencyGateTests {
  @Test("A frame older than the disk cap never reaches the archive")
  func lateFrameIsNotArchived() throws {
    let clock = TestClock()
    let (pipeline, telemetry, source, archive) = try makePipeline(clock: clock)

    source.emit(compressed: frame(captured: clock.now, id: 0, arrived: clock.now))
    #expect(archive.appended == 1)

    // The operator's van drives behind a shed: this frame is a minute late.
    source.emit(compressed: frame(captured: clock.now - 60, id: 1, arrived: clock.now))
    #expect(archive.appended == 1)
    #expect(telemetry.snapshot.tiles[0].diskRefusedLate == 1)

    _ = pipeline
  }

  @Test("A frame with no capture time is archived rather than dropped")
  func unanchoredFrameIsArchived() throws {
    let clock = TestClock()
    let (pipeline, _, source, archive) = try makePipeline(clock: clock)

    source.emit(compressed: frame(captured: nil, id: 0, arrived: clock.now))
    #expect(archive.appended == 1)

    _ = pipeline
  }

  /// The harness moves time to reach retention roll-off. A gate reading `Date()` instead of the
  /// injected clock would call every frame an hour old and stop recording entirely.
  @Test("Advancing the test clock does not stop the recording")
  func advancingTheClockKeepsRecording() throws {
    let clock = TestClock()
    let (pipeline, _, source, archive) = try makePipeline(clock: clock)

    clock.advance(by: 3_600)
    source.emit(compressed: frame(captured: clock.now, id: 0, arrived: clock.now))
    #expect(archive.appended == 1)

    _ = pipeline
  }

  /// Arrival is "now": the gate judges capture-to-arrival, so a frame that reached us sixty
  /// seconds after it was taken is the late one, however long it then waits in the delay line.
  private func frame(captured: WallClock?, id: UInt64, arrived: WallClock) -> CompressedFrame {
    CompressedFrame(
      sourceID: SourceID("cam-0"),
      codec: .h264,
      data: Data([0, 0, 0, 1]),
      parameterSets: [],
      isKeyframe: true,
      presentationTime: CMTime(value: CMTimeValue(id), timescale: 60),
      decodeTime: CMTime(value: CMTimeValue(id), timescale: 60),
      wallClock: arrived,
      captureWallClock: captured,
      frameID: id
    )
  }

  private func makePipeline(
    clock: TestClock
  ) throws -> (SourcePipeline, PipelineTelemetry, GateDummySource, ArchiveSpy) {
    let telemetry = PipelineTelemetry(clock: clock)
    let source = GateDummySource()
    let pipeline = SourcePipeline(
      sourceID: SourceID("cam-0"),
      sourceIndex: 0,
      source: source,
      converter: PixelConverter(),
      telemetry: telemetry
    )
    let archive = ArchiveSpy()
    pipeline.setArchive(archive)
    pipeline.setLatencyCaps(.init(displaySeconds: 0.5, diskSeconds: 10))
    try pipeline.start()
    return (pipeline, telemetry, source, archive)
  }
}

private final class GateDummySource: FrameSource, @unchecked Sendable {
  let sourceID = SourceID("cam-0")
  let displayName = "CAM1"
  private(set) var isRunning = false
  var format: SourceFormat? { nil }
  private var sinks = FrameSinks()

  func start(sinks: FrameSinks) throws {
    self.sinks = sinks
    isRunning = true
  }

  func stop() {
    sinks = FrameSinks()
    isRunning = false
  }
  func emit(compressed frame: CompressedFrame) { sinks.compressed?(frame) }
}

private final class ArchiveSpy: ArchiveSink, @unchecked Sendable {
  private(set) var appended = 0
  func append(_ frame: CompressedFrame) { appended += 1 }
  func append(audio frame: CompressedAudioFrame) {}
}

/// The gate judges the *converted* frame, so anything the converter drops the gate never sees.
@Suite("Pixel conversion keeps timing")
struct PixelConverterTimingTests {
  @Test("Conversion preserves the capture time the gate judges by")
  func conversionKeepsCaptureWallClock() throws {
    var buffer: CVPixelBuffer?
    let created = CVPixelBufferCreate(
      kCFAllocatorDefault, 64, 64, kCVPixelFormatType_32BGRA,
      [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary] as CFDictionary,
      &buffer
    )
    try #require(created == kCVReturnSuccess)
    let pixels = try #require(buffer)

    let captured = WallClock(seconds: 5_000)
    let frame = PixelFrame(
      sourceID: SourceID("cam-0"),
      pixelBuffer: pixels,
      presentationTime: CMTime(value: 1, timescale: 60),
      wallClock: WallClock(seconds: 5_001),
      captureWallClock: captured,
      frameID: 1
    )

    let converted = try #require(PixelConverter().convert(frame))
    #expect(converted.captureWallClock == captured)
    #expect(converted.wallClock == frame.wallClock)
    #expect(converted.frameID == frame.frameID)
  }
}
