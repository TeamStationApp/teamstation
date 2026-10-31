import CoreMedia
import CoreVideo
import DirectorCore
@testable import DirectorPipeline
import DirectorSources
import DirectorTestHarness
@testable import DirectorUI
import Foundation
import Testing

/// A cut with the programme clock running: cameras feed at 60 fps, and every new picture on air is
/// logged with when it went on.
@Suite("Programme handover at a cut", .serialized)
struct ProgrammeHandoverTests {
  /// The live delay for these tests: long enough for several cuts inside it, short enough to run.
  private static let delay = 0.5
  /// How old a picture is when a camera hands it to the programme.
  private static let age = 0.05
  /// Longest step between two new pictures that is not a hold. The clock and the feed are both
  /// timers, on a busy simulator.
  private static let longestStep = 0.15

  private final class ShownLog: @unchecked Sendable {
    private let lock = NSLock()
    private var all: [(sourceID: SourceID, at: Double)] = []

    func add(_ sourceID: SourceID) {
      lock.lock()
      all.append((sourceID, Date().timeIntervalSince1970))
      lock.unlock()
    }

    var entries: [(sourceID: SourceID, at: Double)] {
      lock.lock()
      defer { lock.unlock() }
      return all
    }

    var longestStep: Double {
      let times = entries.map(\.at)
      return zip(times.dropFirst(), times).map { $0 - $1 }.max() ?? 0
    }
  }

  private final class Rig: @unchecked Sendable {
    let clock = SystemClock()
    let telemetry: PipelineTelemetry
    let router: TileRouter
    let root: URL
    var sources: [PushFrameSource] = []
    var pipes: [SourcePipeline] = []
    let shown = ShownLog()
    let factory: PixelBufferFactory
    private let lock = NSLock()
    private var feeding = true

    init(cameras: Int, compositor: MetalCompositor? = nil) throws {
      root = FileManager.default.temporaryDirectory
        .appendingPathComponent("programme-handover-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      telemetry = PipelineTelemetry(clock: clock)
      let converter = PixelConverter()
      router = TileRouter(
        telemetry: telemetry,
        converter: converter,
        compositor: compositor,
        programEncoder: ProgramEncoder(telemetry: telemetry, converter: converter, config: AppConfig(programResolution: .hd720), directory: root),
        programStreamer: ProgramStreamer(telemetry: telemetry, converter: converter),
        clock: clock
      )
      router.setLiveSoundDelay(seconds: ProgrammeHandoverTests.delay)
      factory = try #require(PixelBufferFactory(width: 320, height: 180, pixelFormat: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange))
      for index in 0 ..< cameras {
        let source = PushFrameSource(id: "camera-\(index)")
        let pipe = SourcePipeline(sourceID: source.sourceID, sourceIndex: index, source: source, converter: PixelConverter(), telemetry: telemetry)
        router.add(pipe)
        try pipe.start()
        sources.append(source)
        pipes.append(pipe)
      }
      router.onProgrammeShown = { [shown] in shown.add($0) }
    }

    /// Feeds the cameras at 60 fps until `stop`. A camera in `silent` sends nothing, and one in
    /// `untimed` sends pictures with no capture time.
    func feed(silent: Set<Int> = [], untimed: Set<Int> = []) {
      let cameras = Array(sources.enumerated())
      Thread.detachNewThread { [self] in
        var index = 0
        while isFeeding {
          for (number, source) in cameras where !silent.contains(number) {
            guard let buffer = factory.makeBuffer() else { continue }
            fillNV12(buffer, luma: 63, cb: 102, cr: 240)
            source.push(PixelFrame(
              sourceID: source.sourceID,
              pixelBuffer: buffer,
              presentationTime: CMTime(value: CMTimeValue(index), timescale: 60),
              wallClock: clock.now,
              captureWallClock: untimed.contains(number) ? nil : WallClock(seconds: clock.now.seconds - ProgrammeHandoverTests.age),
              frameID: UInt64(index)
            ))
          }
          index += 1
          Thread.sleep(forTimeInterval: 1.0 / 60)
        }
      }
    }

    private var isFeeding: Bool {
      lock.lock()
      defer { lock.unlock() }
      return feeding
    }

    func stop() {
      lock.lock()
      feeding = false
      lock.unlock()
      try? FileManager.default.removeItem(at: root)
    }

    func id(_ camera: Int) -> SourceID { sources[camera].sourceID }

    /// Puts camera 0 on air and waits for it to be there.
    func goOnAir() async throws {
      router.selectProgram(sourceIndex: 0)
      try await Task.sleep(for: .seconds(ProgrammeHandoverTests.delay + 0.2))
      #expect(shown.entries.last?.sourceID == id(0))
    }
  }

  @Test("A cut plays the old camera until the new camera's first picture, and then only the new one")
  func handsOverAtTheNewCamerasFirstPicture() async throws {
    let rig = try Rig(cameras: 2)
    defer { rig.stop() }
    rig.feed()
    try await rig.goOnAir()
    let held = rig.shown.entries.count
    let cutAt = Date().timeIntervalSince1970
    rig.router.selectProgram(sourceIndex: 1)
    #expect(rig.router.outgoingSourceID == rig.id(0))
    try await Task.sleep(for: .seconds(Self.delay + 0.2))
    let after = Array(rig.shown.entries.dropFirst(held))
    let first = try #require(after.firstIndex { $0.sourceID == rig.id(1) })
    #expect(after[first].at - cutAt > Self.delay - Self.age - 0.1, "the new camera came on before it was due")
    #expect(after[..<first].allSatisfy { $0.sourceID == rig.id(0) })
    #expect(after[first...].allSatisfy { $0.sourceID == rig.id(1) })
    #expect(rig.shown.longestStep < Self.longestStep, "the programme held a picture")
    // And the old camera's sink is gone.
    #expect(rig.router.outgoingSourceID == nil)
    #expect(!rig.pipes[0].hasProgramSink)
  }

  @Test("A cut to a camera that sends nothing holds the old camera until the deadline, then its last picture")
  func silentCameraEndsAtTheDeadline() async throws {
    let rig = try Rig(cameras: 2)
    defer { rig.stop() }
    rig.feed(silent: [1])
    try await rig.goOnAir()
    rig.router.selectProgram(sourceIndex: 1)
    try await Task.sleep(for: .seconds(Self.delay))
    #expect(rig.router.outgoingSourceID == rig.id(0))
    #expect(rig.pipes[0].hasProgramSink)
    try await Task.sleep(for: .seconds(0.4))
    #expect(rig.router.outgoingSourceID == nil)
    #expect(!rig.pipes[0].hasProgramSink)
    #expect(rig.shown.entries.allSatisfy { $0.sourceID == rig.id(0) })
  }

  @Test("Cuts away and back faster than D never stop the camera on air, and nothing else is shown")
  func rapidCutsKeepTheCameraOnAir() async throws {
    let rig = try Rig(cameras: 2)
    defer { rig.stop() }
    rig.feed()
    try await rig.goOnAir()
    for camera in [1, 0, 1, 0, 1, 0] {
      rig.router.selectProgram(sourceIndex: camera)
      try await Task.sleep(for: .seconds(0.08))
    }
    try await Task.sleep(for: .seconds(Self.delay))
    #expect(rig.shown.entries.allSatisfy { $0.sourceID == rig.id(0) }, "the other camera was shown")
    #expect(rig.shown.longestStep < Self.longestStep, "the programme held a picture")
    #expect(rig.router.outgoingSourceID == nil)
    #expect(rig.pipes[0].hasProgramSink)
    #expect(!rig.pipes[1].hasProgramSink)
    #expect(rig.pipes[0].onProgramDiscontinuity != nil, "a cancelled handover left the camera without it")
  }

  @Test("A chain of cuts longer than the deadline leaves the camera on air feeding until the last camera's first picture")
  func chainOutlastsTheDeadline() async throws {
    let rig = try Rig(cameras: 3)
    defer { rig.stop() }
    rig.feed()
    try await rig.goOnAir()
    for camera in [1, 2, 1, 2, 1, 2, 1, 2] {
      rig.router.selectProgram(sourceIndex: camera)
      try await Task.sleep(for: .seconds(0.15))
    }
    #expect(rig.router.outgoingSourceID == rig.id(0))
    #expect(rig.shown.entries.allSatisfy { $0.sourceID == rig.id(0) })
    try await Task.sleep(for: .seconds(Self.delay))
    #expect(rig.shown.entries.last?.sourceID == rig.id(2))
    #expect(!rig.shown.entries.contains { $0.sourceID == rig.id(1) })
    #expect(rig.shown.longestStep < Self.longestStep, "the programme held a picture")
  }

  @Test("The preview takes the new camera from the cut, and the stream's keyframe comes once, with its first picture")
  func previewAndKeyframeFollowTheCut() async throws {
    let rig = try Rig(cameras: 2)
    defer { rig.stop() }
    rig.feed()
    try await rig.goOnAir()
    let delivered = ShownLog()
    let requests = rig.router.programmeKeyframeRequests
    rig.router.onProgrammeDelivered = { sourceID, _ in delivered.add(sourceID) }
    rig.router.selectProgram(sourceIndex: 1)
    let cutAt = Date().timeIntervalSince1970
    #expect(rig.router.programmeKeyframeRequests == requests)
    try await Task.sleep(for: .seconds(Self.delay + 0.2))
    let afterCut = delivered.entries.filter { $0.at > cutAt + 0.02 }
    #expect(!afterCut.isEmpty)
    #expect(afterCut.allSatisfy { $0.sourceID == rig.id(1) })
    #expect(rig.router.programmeKeyframeRequests == requests + 1)
  }

  @Test("Removing the outgoing camera ends the handover, and neither a slot swap nor the same camera starts or ends one")
  func removalSwapAndNoChange() async throws {
    let rig = try Rig(cameras: 2)
    defer { rig.stop() }
    rig.feed()
    try await rig.goOnAir()
    rig.router.selectProgram(sourceIndex: 0)
    rig.router.reassign(from: 0, to: 2)
    #expect(rig.router.outgoingSourceID == nil)
    #expect(rig.pipes[0].hasProgramSink)
    rig.router.selectProgram(sourceIndex: 1)
    #expect(rig.router.outgoingSourceID == rig.id(0))
    rig.router.selectProgram(sourceIndex: 1)
    #expect(rig.router.outgoingSourceID == rig.id(0))
    #expect(rig.pipes[0].hasProgramSink, "a call with no change of camera took the outgoing camera's sink")
    rig.router.remove(sourceIndex: 2)
    #expect(rig.router.outgoingSourceID == nil)
  }

  @Test("A cut from or to a camera off live does not hand over, and one to it ends a handover")
  func noHandoverOffLive() async throws {
    let rig = try Rig(cameras: 3)
    defer { rig.stop() }
    rig.feed()
    try await rig.goOnAir()
    // To a camera off live.
    rig.pipes[1].beginScrubbing()
    rig.router.selectProgram(sourceIndex: 1)
    #expect(rig.router.outgoingSourceID == nil)
    #expect(!rig.pipes[0].hasProgramSink)
    // From a camera off live.
    rig.router.selectProgram(sourceIndex: 2)
    #expect(rig.router.outgoingSourceID == nil)
    #expect(!rig.pipes[1].hasProgramSink)
    try await Task.sleep(for: .seconds(Self.delay + 0.2))
    // A handover running, ended by a cut to a camera off live.
    rig.router.selectProgram(sourceIndex: 0)
    #expect(rig.router.outgoingSourceID == rig.id(2))
    rig.router.selectProgram(sourceIndex: 1)
    #expect(rig.router.outgoingSourceID == nil)
    #expect(!rig.pipes[2].hasProgramSink)
  }

  @Test("A camera back to live before the cut is handed over to, as the remote's cut-live does it")
  func cutToACameraJustBackToLive() async throws {
    let rig = try Rig(cameras: 2)
    defer { rig.stop() }
    rig.feed()
    try await rig.goOnAir()
    rig.pipes[1].beginScrubbing()
    rig.pipes[1].returnToLive()
    rig.router.selectProgram(sourceIndex: 1)
    #expect(rig.router.outgoingSourceID == rig.id(0))
  }

  @Test("A cut back on the very tick the new camera goes on air starts the old camera again")
  func cutBackOnTheTickTheNewCameraGoesOn() async throws {
    let rig = try Rig(cameras: 2)
    defer { rig.stop() }
    rig.feed()
    try await rig.goOnAir()
    let shown = rig.shown
    let router = rig.router
    let newCamera = rig.id(1)
    router.onProgrammeShown = { sourceID in
      shown.add(sourceID)
      // After the tick's lock, where a cut can land before anything else of the tick has run.
      if sourceID == newCamera {
        router.onProgrammeShown = { shown.add($0) }
        router.selectProgram(sourceIndex: 0)
      }
    }
    router.selectProgram(sourceIndex: 1)
    try await Task.sleep(for: .seconds(Self.delay + 0.1))
    let reached = try #require(shown.entries.lastIndex { $0.sourceID == newCamera })
    try await Task.sleep(for: .seconds(Self.delay + 0.4))
    let after = shown.entries.dropFirst(reached + 1)
    // That camera is on air now, so it plays on until the old camera's first picture is due.
    #expect(after.count > 10, "the programme froze on the new camera")
    #expect(after.last?.sourceID == rig.id(0), "the old camera never came back")
    #expect(rig.shown.longestStep < Self.longestStep, "the programme held a picture")
    #expect(rig.pipes[0].hasProgramSink)
  }

  @MainActor
  @Test("The remote's cut-live to a camera off live hands over, because it goes live first")
  func remoteCutLiveHandsOver() async throws {
    var launch = LaunchConfiguration()
    launch.isUITest = true
    launch.sourceProfile = .synthetic4
    launch.syntheticCount = 2
    launch.syntheticWidth = 320
    launch.syntheticHeight = 180
    let model = AppEnvironment(launch: launch)
    await model.bootstrap()
    for _ in 0 ..< 100 where model.selections.isEmpty { try await Task.sleep(for: .milliseconds(50)) }
    for selection in model.selections { _ = model.setEnabled(true, for: selection.id) }
    await model.enterDirecting()
    for _ in 0 ..< 100 where model.router.activePipelines.count < 2 { try await Task.sleep(for: .milliseconds(50)) }
    let pipelines = model.router.activePipelines
    try #require(pipelines.count >= 2)
    try await Task.sleep(for: .seconds(1.5))
    // The app puts its own choice of camera on program as it settles.
    let onAir = try #require(model.router.currentProgramSource)
    let other = try #require(pipelines.first { $0.sourceIndex != onAir })
    other.beginScrubbing()
    let handovers = model.router.handoverCount
    model.cutSourceLive(sourceIndex: other.sourceIndex)
    #expect(model.router.handoverCount == handovers + 1)
  }

  @Test("Once the new camera is on air the old one's pictures are refused, ahead of the tick ending the handover")
  func outgoingRefusedOnceTheNewCameraIsOn() async throws {
    let rig = try Rig(cameras: 2)
    defer { rig.stop() }
    rig.feed()
    try await rig.goOnAir()
    let run = rig.router.currentRunForTest
    rig.router.selectProgram(sourceIndex: 1)
    try await Task.sleep(for: .seconds(Self.delay + 0.2))
    let buffer = try #require(rig.factory.makeBuffer())
    let job = ProgrammeComposer.Job(
      buffer: buffer,
      presentationTime: .zero,
      captureWall: nil,
      dueHost: nil,
      sourceID: rig.id(0),
      generation: run
    )
    #expect(!rig.router.isCurrentProgramme(job))
  }

  @Test("The camera on program leaving live ends a handover")
  func programLeavingLiveEndsTheHandover() async throws {
    let rig = try Rig(cameras: 2)
    defer { rig.stop() }
    rig.feed()
    try await rig.goOnAir()
    rig.router.selectProgram(sourceIndex: 1)
    rig.pipes[1].beginScrubbing()
    try await Task.sleep(for: .seconds(0.1))
    #expect(rig.router.outgoingSourceID == nil)
    #expect(!rig.pipes[0].hasProgramSink)
  }

  @Test("During a handover the outgoing camera's live pictures are taken, and a replay's are not")
  func outgoingReplayIsRefused() async throws {
    let rig = try Rig(cameras: 2)
    defer { rig.stop() }
    rig.feed()
    try await rig.goOnAir()
    let run = rig.router.currentRunForTest
    rig.router.selectProgram(sourceIndex: 1)
    let buffer = try #require(rig.factory.makeBuffer())
    let job = { (due: Double?) in
      ProgrammeComposer.Job(
        buffer: buffer,
        presentationTime: .zero,
        captureWall: nil,
        dueHost: due,
        sourceID: rig.id(0),
        generation: run
      )
    }
    #expect(rig.router.isCurrentProgramme(job(nil)))
    #expect(!rig.router.isCurrentProgramme(job(1)))
  }

  @Test("A camera whose sink has gone never becomes the outgoing one")
  func noSinkNoHandover() async throws {
    let rig = try Rig(cameras: 3)
    defer { rig.stop() }
    rig.feed(silent: [1, 2])
    try await rig.goOnAir()
    rig.router.selectProgram(sourceIndex: 1)
    try await Task.sleep(for: .seconds(Self.delay + 0.35))
    #expect(!rig.pipes[0].hasProgramSink)
    rig.router.selectProgram(sourceIndex: 2)
    #expect(rig.router.outgoingSourceID == nil)
    rig.router.selectProgram(sourceIndex: 0)
    #expect(rig.pipes[0].hasProgramSink, "the camera back on program has no sink")
  }

  @Test("With the compositor's pool run dry a handover still completes, and the misses are counted")
  func poolAtItsCeiling() async throws {
    let compositor = try #require(MetalCompositor(width: 320, height: 180, maximumBuffers: 20))
    let rig = try Rig(cameras: 2, compositor: compositor)
    defer { rig.stop() }
    rig.feed()
    try await rig.goOnAir()
    let misses = rig.router.programmeComposeMisses
    rig.router.selectProgram(sourceIndex: 1)
    try await Task.sleep(for: .seconds(Self.delay + 0.5))
    #expect(rig.router.programmeComposeMisses > misses)
    #expect(rig.router.outgoingSourceID == nil)
    #expect(rig.shown.entries.last?.sourceID == rig.id(1))
  }

  @Test("A camera with no capture times hands over like any other")
  func untimedCameraHandsOver() async throws {
    let rig = try Rig(cameras: 2)
    defer { rig.stop() }
    rig.feed(untimed: [0])
    try await rig.goOnAir()
    rig.router.selectProgram(sourceIndex: 1)
    #expect(rig.router.outgoingSourceID == rig.id(0))
    try await Task.sleep(for: .seconds(Self.delay + 0.2))
    #expect(rig.shown.entries.last?.sourceID == rig.id(1))
    #expect(rig.shown.longestStep < Self.longestStep, "the programme held a picture")
  }
}
