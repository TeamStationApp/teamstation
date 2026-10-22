import AVFoundation
import CoreMedia
import CoreVideo
import DirectorCore
@testable import DirectorPipeline
import DirectorSources
import Foundation
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
    for _ in 0 ..< 80 { held.append(try #require(compositor.composeAndWait(program: input))) }
    #expect(held.count == 80, "a second and a quarter of 60 fps pictures, all composed")
  }

  /// The camera on air used to compose the programme on its own drain thread, so a slow compose was
  /// a frame the camera lost. Its handover now returns at once whatever the compositor costs.
  @Test("The camera on air hands its picture over without waiting for a slow compositor")
  func slowComposeNeverHoldsTheCamera() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("programme-handover-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let clock = SystemClock()
    let telemetry = PipelineTelemetry(clock: clock)
    let converter = PixelConverter()
    let config = AppConfig(programResolution: .hd720, programFrameRate: 30)
    let encoder = ProgramEncoder(telemetry: telemetry, converter: converter, config: config, directory: root)
    let compositor = try #require(MetalCompositor(width: 1280, height: 720))
    let router = TileRouter(
      telemetry: telemetry,
      converter: converter,
      compositor: compositor,
      programEncoder: encoder,
      programStreamer: ProgramStreamer(telemetry: telemetry, converter: converter),
      clock: clock
    )
    router.setRecordingRate(30)
    // Slower than the pictures come, whatever pace the test's sleeps keep.
    router.setProgrammeComposeDelay(milliseconds: 40)
    let source = PushFrameSource()
    let pipe = SourcePipeline(sourceID: source.sourceID, sourceIndex: 0, source: source, converter: PixelConverter(), telemetry: telemetry)
    router.add(pipe)
    try pipe.start()
    router.selectProgram(sourceIndex: 0)
    try encoder.start(at: clock.now)

    let factory = try #require(PixelBufferFactory(width: 1280, height: 720, pixelFormat: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange))
    let timer = ContinuousClock()
    var spent: [Duration] = []
    for index in 0 ..< 70 {
      let buffer = try #require(factory.makeBuffer())
      fillNV12(buffer, luma: 128, cb: 128, cr: 128)
      let frame = PixelFrame(
        sourceID: source.sourceID,
        pixelBuffer: buffer,
        presentationTime: CMTime(value: CMTimeValue(index), timescale: 60),
        wallClock: clock.now,
        captureWallClock: WallClock(seconds: clock.now.seconds - AudioMixer.defaultLiveReadLagSeconds),
        frameID: UInt64(index)
      )
      let took = timer.measure { source.push(frame) }
      // The first pushes build the converter's pool and the renderer's format; not what is measured.
      if index >= 10 { spent.append(took) }
      try await Task.sleep(for: .milliseconds(16))
    }
    #expect(router.waitUntilProgrammeIdle())
    let sorted = spent.sorted()
    // Measured against the 40 ms compose, which a push that waited for it could not beat.
    #expect(sorted.last! < .milliseconds(30), "the slowest push took \(sorted.last!)")
    #expect(sorted[sorted.count / 2] < .milliseconds(2), "the median push took \(sorted[sorted.count / 2])")
    let statistics = router.programmeComposerStatistics()
    #expect(statistics.dropped > 0, "a 40 ms compositor cannot keep up with a picture every 16 ms")
    #expect(statistics.millisecondsMax >= 40)
    try await Task.sleep(for: .milliseconds(300))
    #expect(encoder.frameCount > 0, "the programme still records")
    _ = await encoder.finish(until: clock.now)
  }

  /// A picture of the camera cut away from that was already composing must not land after the cut.
  @Test("After a cut, the programme shows only the new camera, even what was composing at the cut")
  func cutShowsOnlyTheNewCamera() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("programme-cut-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let clock = SystemClock()
    let telemetry = PipelineTelemetry(clock: clock)
    let converter = PixelConverter()
    let compositor = try #require(MetalCompositor(width: 320, height: 180))
    let router = TileRouter(
      telemetry: telemetry,
      converter: converter,
      compositor: compositor,
      programEncoder: ProgramEncoder(telemetry: telemetry, converter: converter, config: AppConfig(programResolution: .hd720), directory: root),
      programStreamer: ProgramStreamer(telemetry: telemetry, converter: converter),
      clock: clock
    )
    let red = PushFrameSource(id: "red-cam")
    let blue = PushFrameSource(id: "blue-cam")
    for (index, source) in [red, blue].enumerated() {
      let pipe = SourcePipeline(sourceID: source.sourceID, sourceIndex: index, source: source, converter: PixelConverter(), telemetry: telemetry)
      router.add(pipe)
      try pipe.start()
    }
    router.selectProgram(sourceIndex: 0)
    router.setProgrammeComposeDelay(milliseconds: 50)
    let delivered = DeliveryLog()
    router.onProgrammeDelivered = { sourceID, composed in delivered.add(sourceID, centreBGR(of: composed)) }

    let factory = try #require(PixelBufferFactory(width: 320, height: 180, pixelFormat: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange))
    func push(_ source: PushFrameSource, index: Int, cb: UInt8, cr: UInt8, luma: UInt8) throws {
      let buffer = try #require(factory.makeBuffer())
      fillNV12(buffer, luma: luma, cb: cb, cr: cr)
      source.push(PixelFrame(
        sourceID: source.sourceID,
        pixelBuffer: buffer,
        presentationTime: CMTime(value: CMTimeValue(index), timescale: 60),
        wallClock: clock.now,
        captureWallClock: WallClock(seconds: clock.now.seconds - AudioMixer.defaultLiveReadLagSeconds),
        frameID: UInt64(index)
      ))
    }
    // Video-range red and blue.
    for index in 0 ..< 6 { try push(red, index: index, cb: 102, cr: 240, luma: 63) }
    try await Task.sleep(for: .milliseconds(60))
    router.selectProgram(sourceIndex: 1)
    let cutAt = delivered.count
    for index in 0 ..< 6 { try push(blue, index: index, cb: 240, cr: 110, luma: 41) }
    #expect(router.waitUntilProgrammeIdle())

    let afterCut = delivered.entries.dropFirst(cutAt)
    #expect(!afterCut.isEmpty, "the new camera reached the programme")
    for entry in afterCut {
      #expect(entry.sourceID == blue.sourceID, "a red picture landed after the cut")
      #expect(entry.bgr[0] > 150 && entry.bgr[2] < 100, "the picture after the cut is \(entry.bgr) (BGR), not blue")
    }
  }

  /// A camera whose pictures reach the programme at their moment leaves no time for composing: the
  /// composer must judge a waiting picture at its delivery, or it spends the compose on one that
  /// arrives late while a newer one that would have made it waits.
  @Test("Pictures handed over at their moment under a slow compose are dropped as behind, never shown late")
  func atTheirMomentNothingArrivesLate() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("programme-moment-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let clock = SystemClock()
    let telemetry = PipelineTelemetry(clock: clock)
    let converter = PixelConverter()
    let router = TileRouter(
      telemetry: telemetry,
      converter: converter,
      compositor: nil,
      programEncoder: ProgramEncoder(telemetry: telemetry, converter: converter, config: AppConfig(programResolution: .hd720), directory: root),
      programStreamer: ProgramStreamer(telemetry: telemetry, converter: converter),
      clock: clock
    )
    let source = PushFrameSource()
    let pipe = SourcePipeline(sourceID: source.sourceID, sourceIndex: 0, source: source, converter: PixelConverter(), telemetry: telemetry)
    router.add(pipe)
    try pipe.start()
    router.selectProgram(sourceIndex: 0)
    // A 30 fps programme, so 33 ms a tick, and a 20 ms compose: a picture taken at its moment still
    // makes it, one that waited a compose behind another does not.
    router.setProgrammeComposeDelay(milliseconds: 20)
    let factory = try #require(PixelBufferFactory(width: 320, height: 180, pixelFormat: kCVPixelFormatType_32BGRA))
    for index in 0 ..< 90 {
      source.push(PixelFrame(
        sourceID: source.sourceID,
        pixelBuffer: try #require(factory.makeBuffer()),
        presentationTime: CMTime(value: CMTimeValue(index), timescale: 60),
        wallClock: clock.now,
        // Captured D ago: due on the programme now.
        captureWallClock: WallClock(seconds: clock.now.seconds - AudioMixer.defaultLiveReadLagSeconds),
        frameID: UInt64(index)
      ))
      try await Task.sleep(for: .milliseconds(16))
    }
    #expect(router.waitUntilProgrammeIdle())
    try await Task.sleep(for: .milliseconds(100))
    #expect(router.programmePictureCounts.late == 0, "\(router.programmePictureCounts.late) pictures arrived late")
    #expect(router.programmeComposerStatistics().dropped > 0, "the compositor's losses are counted as dropped")
  }

  /// A camera cut away from and straight back is a new time on air: a picture of it that was
  /// composing before the first cut is not shown after the second.
  @Test("A picture composing across a cut away and back is not shown")
  func cutAwayAndBackDropsTheOldPicture() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("programme-cut-back-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let clock = SystemClock()
    let telemetry = PipelineTelemetry(clock: clock)
    let converter = PixelConverter()
    let compositor = try #require(MetalCompositor(width: 320, height: 180))
    let router = TileRouter(
      telemetry: telemetry,
      converter: converter,
      compositor: compositor,
      programEncoder: ProgramEncoder(telemetry: telemetry, converter: converter, config: AppConfig(programResolution: .hd720), directory: root),
      programStreamer: ProgramStreamer(telemetry: telemetry, converter: converter),
      clock: clock
    )
    let cameraA = PushFrameSource(id: "a-cam")
    let cameraB = PushFrameSource(id: "b-cam")
    for (index, source) in [cameraA, cameraB].enumerated() {
      let pipe = SourcePipeline(sourceID: source.sourceID, sourceIndex: index, source: source, converter: PixelConverter(), telemetry: telemetry)
      router.add(pipe)
      try pipe.start()
    }
    router.selectProgram(sourceIndex: 0)
    router.setProgrammeComposeDelay(milliseconds: 100)
    let delivered = DeliveryLog()
    router.onProgrammeDelivered = { sourceID, composed in delivered.add(sourceID, centreBGR(of: composed)) }

    let factory = try #require(PixelBufferFactory(width: 320, height: 180, pixelFormat: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange))
    let buffer = try #require(factory.makeBuffer())
    fillNV12(buffer, luma: 63, cb: 102, cr: 240)
    cameraA.push(PixelFrame(
      sourceID: cameraA.sourceID,
      pixelBuffer: buffer,
      presentationTime: CMTime(value: 0, timescale: 60),
      wallClock: clock.now,
      captureWallClock: WallClock(seconds: clock.now.seconds - AudioMixer.defaultLiveReadLagSeconds),
      frameID: 0
    ))
    // A's picture is in its 100 ms delay when the operator cuts to B and straight back.
    try await Task.sleep(for: .milliseconds(20))
    router.selectProgram(sourceIndex: 1)
    router.selectProgram(sourceIndex: 0)
    #expect(router.waitUntilProgrammeIdle())
    #expect(delivered.count == 0, "the picture from A's earlier time on air was shown")
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
final class PushFrameSource: FrameSource, @unchecked Sendable {
  let sourceID: SourceID
  let displayName = "PUSH"

  init(id: String = "push-cam") {
    sourceID = SourceID(id)
  }

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

/// Programme pictures as the router delivered them, from the composer's queue.
private final class DeliveryLog: @unchecked Sendable {
  private let lock = NSLock()
  private var all: [(sourceID: SourceID, bgr: [UInt8])] = []

  func add(_ sourceID: SourceID, _ bgr: [UInt8]) {
    lock.lock()
    all.append((sourceID, bgr))
    lock.unlock()
  }

  var count: Int {
    lock.lock()
    defer { lock.unlock() }
    return all.count
  }

  var entries: [(sourceID: SourceID, bgr: [UInt8])] {
    lock.lock()
    defer { lock.unlock() }
    return all
  }
}
