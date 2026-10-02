import DirectorCore
import DirectorPipeline
import DirectorSources
import Testing

@Suite("Replay session epoch")
struct ReplayEpochTests {
  @Test("beginScrubbing and returnToLive each advance the epoch")
  func scrubAndLiveBumpEpoch() {
    let pipe = makePipeline()
    #expect(pipe.currentReplayEpoch == 0)
    pipe.beginScrubbing()
    #expect(pipe.currentReplayEpoch == 1)
    pipe.returnToLive()
    #expect(pipe.currentReplayEpoch == 2)
    pipe.beginScrubbing()
    #expect(pipe.currentReplayEpoch == 3)
  }

  @Test("Instant replay bumps the generation without leaving live")
  func instantReplayKeepsLive() {
    let pipe = makePipeline()
    #expect(pipe.currentState == .live)
    pipe.beginInstantReplayGeneration()
    #expect(pipe.currentReplayEpoch == 1)
    #expect(pipe.currentState == .live)
    let epoch = pipe.currentReplayEpoch
    pipe.beginInstantReplayGeneration()
    #expect(pipe.currentReplayEpoch == 2)
    #expect(!pipe.isCurrentReplay(sourceID: pipe.sourceID, epoch: epoch))
  }

  @Test("Finger-up resumes live until the first archive file is decoded")
  func scrubResumesLiveForReplay() {
    let pipe = makePipeline()
    pipe.beginScrubbing()
    #expect(pipe.currentState == .scrubbing)
    pipe.beginInstantReplayGeneration()
    #expect(pipe.currentState == .live)
    #expect(pipe.currentReplayEpoch == 2)
  }

  @Test("A captured epoch matches only until the next scrub or return to live")
  func capturedEpochGoesStale() {
    let pipe = makePipeline()
    pipe.beginScrubbing()
    let epoch = pipe.currentReplayEpoch
    let id = pipe.sourceID
    #expect(pipe.isCurrentReplay(sourceID: id, epoch: epoch))

    pipe.returnToLive()
    #expect(!pipe.isCurrentReplay(sourceID: id, epoch: epoch))
    #expect(pipe.isCurrentReplay(sourceID: id, epoch: pipe.currentReplayEpoch))

    let liveEpoch = pipe.currentReplayEpoch
    pipe.beginScrubbing()
    #expect(!pipe.isCurrentReplay(sourceID: id, epoch: liveEpoch))
  }

  @Test("A different camera is never the current session even at the same epoch")
  func sourceIDMismatch() {
    let pipe = makePipeline()
    pipe.beginScrubbing()
    #expect(!pipe.isCurrentReplay(sourceID: SourceID("other"), epoch: pipe.currentReplayEpoch))
  }

  @Test("Stopping the pipeline invalidates any captured continuation")
  func stopInvalidatesEpoch() {
    let pipe = makePipeline()
    pipe.beginScrubbing()
    let epoch = pipe.currentReplayEpoch
    let id = pipe.sourceID
    pipe.stop()
    #expect(!pipe.isCurrentReplay(sourceID: id, epoch: epoch))
  }

  private func makePipeline() -> SourcePipeline {
    let clock = SystemClock()
    let telemetry = PipelineTelemetry(clock: clock)
    return SourcePipeline(
      sourceID: SourceID("cam-0"),
      sourceIndex: 0,
      source: EpochDummySource(),
      converter: PixelConverter(),
      telemetry: telemetry
    )
  }
}

private final class EpochDummySource: FrameSource, @unchecked Sendable {
  let sourceID = SourceID("cam-0")
  let displayName = "CAM1"
  private(set) var isRunning = false
  var format: SourceFormat? { nil }

  func start(sinks: FrameSinks) throws {
    isRunning = true
  }

  func stop() {
    isRunning = false
  }
}
