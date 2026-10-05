import AVFoundation
import CoreMedia
import CoreVideo
import DirectorCore
import DirectorPipeline
import DirectorSources
import Testing

@Suite("Programme clock in the router", .serialized)
struct ProgrammeClockRouterTests {
  /// A camera on air that goes quiet used to leave nothing in the programme until its next picture,
  /// which then landed a whole stall later: the picture before it became one sample seconds long,
  /// and players hang on those.
  @Test("A camera on air that stalls is recorded as its last picture repeated at the programme's rate")
  func stallIsRecordedAsRepeatedFrames() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("programme-clock-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let clock = SystemClock()
    let telemetry = PipelineTelemetry(clock: clock)
    let converter = PixelConverter()
    let config = AppConfig(programResolution: .hd720, programFrameRate: 30)
    let encoder = ProgramEncoder(telemetry: telemetry, converter: converter, config: config, directory: root)
    let router = TileRouter(
      telemetry: telemetry,
      converter: converter,
      compositor: nil,
      programEncoder: encoder,
      programStreamer: ProgramStreamer(telemetry: telemetry, converter: converter),
      clock: clock
    )
    router.setRecordingRate(30)
    let source = PushFrameSource()
    let pipe = SourcePipeline(
      sourceID: source.sourceID,
      sourceIndex: 0,
      source: source,
      converter: PixelConverter(),
      telemetry: telemetry
    )
    router.add(pipe)
    try pipe.start()
    router.selectProgram(sourceIndex: 0)
    try encoder.start(at: clock.now)

    let factory = try #require(PixelBufferFactory(width: 1280, height: 720, pixelFormat: kCVPixelFormatType_32BGRA))
    for index in 0 ..< 10 {
      let buffer = try #require(factory.makeBuffer())
      source.push(PixelFrame(
        sourceID: source.sourceID,
        pixelBuffer: buffer,
        presentationTime: CMTime(value: CMTimeValue(index), timescale: 30),
        wallClock: clock.now,
        // Captured the live delay ago, as a camera's picture is when the delay line releases it:
        // the programme takes a picture on the tick its capture time plus D comes due.
        captureWallClock: WallClock(seconds: clock.now.seconds - AudioMixer.defaultLiveReadLagSeconds),
        frameID: UInt64(index)
      ))
      try await Task.sleep(for: .milliseconds(33))
    }
    // The camera on air goes quiet for over a second.
    try await Task.sleep(for: .milliseconds(1_200))
    let counts = router.programmePictureCounts
    #expect(encoder.frameCount > 0, "the encoder took \(encoder.frameCount) frames; late \(counts.late) skipped \(counts.skipped)")
    let url = try #require(await encoder.finish(until: clock.now))

    let steps = try await frameSteps(of: url)
    #expect(steps.count >= 36, "only \(steps.count) frames for about a second and a half at 30 fps")
    #expect((steps.max() ?? 0) < 0.07, "one frame lasted \(steps.max() ?? 0) s")
    // An exact grid, the fill to the stop included, so an export can copy the master as it is.
    let offGrid = steps.filter { abs($0 - 1.0 / 30) > 0.0005 }
    #expect(offGrid.isEmpty, "\(offGrid.count) of \(steps.count) steps off 1/30 s: \(offGrid.prefix(5))")
  }

  /// D at a second holds more composed pictures than the compositor used to have, and every one past
  /// its pool went out without its overlay: Paul saw the team logo flicker.
  @Test("A picture the compositor cannot make is left out: nothing goes on air without its overlay")
  func composeMissLeavesPictureOut() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("programme-overlay-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let clock = SystemClock()
    let telemetry = PipelineTelemetry(clock: clock)
    let converter = PixelConverter()
    let compositor = try #require(MetalCompositor(width: 1280, height: 720, maximumBuffers: 4))
    let router = TileRouter(
      telemetry: telemetry,
      converter: converter,
      compositor: compositor,
      programEncoder: ProgramEncoder(telemetry: telemetry, converter: converter, config: AppConfig(programResolution: .hd720), directory: root),
      programStreamer: ProgramStreamer(telemetry: telemetry, converter: converter),
      clock: clock
    )
    let source = PushFrameSource()
    let pipe = SourcePipeline(sourceID: source.sourceID, sourceIndex: 0, source: source, converter: PixelConverter(), telemetry: telemetry)
    router.add(pipe)
    try pipe.start()
    router.selectProgram(sourceIndex: 0)
    let factory = try #require(PixelBufferFactory(width: 1280, height: 720, pixelFormat: kCVPixelFormatType_32BGRA))
    // Due far ahead, so every composed picture stays queued and holds its buffer.
    for index in 0 ..< 12 {
      source.push(PixelFrame(
        sourceID: source.sourceID,
        pixelBuffer: try #require(factory.makeBuffer()),
        presentationTime: CMTime(value: CMTimeValue(index), timescale: 30),
        wallClock: clock.now,
        captureWallClock: WallClock(seconds: clock.now.seconds + 30),
        frameID: UInt64(index)
      ))
      try await Task.sleep(for: .milliseconds(20))
    }
    try await Task.sleep(for: .milliseconds(200))
    #expect(compositor.frameCount <= 4)
    #expect(router.programmeComposeMisses > 0, "the pictures past the pool are left out, not sent bare")
    #expect(router.programmeComposeMisses + compositor.frameCount >= 12)
  }

  @Test("The compositor's pool holds D's ceiling of composed pictures at 60 fps")
  func compositorHoldsDsWorth() throws {
    #expect(MetalCompositor.maximumComposedPictures >= Int((2.0 + 0.25) * 60))
    let compositor = try #require(MetalCompositor(width: 320, height: 180))
    let factory = try #require(PixelBufferFactory(width: 320, height: 180, pixelFormat: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange))
    let input = try #require(factory.makeBuffer())
    var held: [CVPixelBuffer] = []
    for _ in 0 ..< 80 { held.append(try #require(compositor.compose(program: input))) }
    #expect(held.count == 80, "a second and a quarter of 60 fps pictures, all composed")
  }

  /// The time from each video sample to the next, in presentation order.
  private func frameSteps(of url: URL) async throws -> [Double] {
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
    times.sort()
    return zip(times.dropFirst(), times).map { $0 - $1 }
  }
}

/// A source whose pictures the test hands it one at a time.
private final class PushFrameSource: FrameSource, @unchecked Sendable {
  let sourceID = SourceID("push-cam")
  let displayName = "PUSH"
  private(set) var isRunning = false
  var format: SourceFormat? { nil }
  private let lock = NSLock()
  private var sinks = FrameSinks()

  func start(sinks: FrameSinks) throws {
    lock.lock()
    self.sinks = sinks
    isRunning = true
    lock.unlock()
  }

  func stop() {
    lock.lock()
    isRunning = false
    sinks = FrameSinks()
    lock.unlock()
  }

  func push(_ frame: PixelFrame) {
    lock.lock()
    let pixel = sinks.pixel
    lock.unlock()
    pixel?(frame)
  }
}
