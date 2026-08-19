import CameramanRTSP
import Testing

/// Backpressure is the difference between a slow client and a killed app.
struct StreamSendQueueTests {
  @Test func sendsWhileUnderTheWaterMark() {
    var queue = StreamSendQueue(highWaterMark: 1_000)

    #expect(queue.decide(frameBytes: 400, isKeyframe: false) == .send)
    #expect(queue.decide(frameBytes: 400, isKeyframe: false) == .send)
    #expect(queue.droppedFrames == 0)
  }

  @Test func dropsNonKeyframesOnceOverBudget() {
    var queue = StreamSendQueue(highWaterMark: 1_000)
    #expect(queue.decide(frameBytes: 1_500, isKeyframe: true) == .send)

    // Nothing has completed, so the queue is still over budget.
    #expect(queue.decide(frameBytes: 100, isKeyframe: false) == .drop)
    #expect(queue.decide(frameBytes: 100, isKeyframe: false) == .drop)
    #expect(queue.droppedFrames == 2)
    #expect(queue.isDropping)
  }

  @Test func aKeyframeFlushesTheBacklogAndBecomesTheNewStart() {
    var queue = StreamSendQueue(highWaterMark: 1_000)
    _ = queue.decide(frameBytes: 5_000, isKeyframe: true)
    _ = queue.decide(frameBytes: 100, isKeyframe: false)

    // A keyframe is the one place a decoder can resynchronise, so the stale backlog is abandoned
    // rather than delivered late.
    #expect(queue.decide(frameBytes: 800, isKeyframe: true) == .flushThenSend)
    #expect(queue.pendingBytes == 800, "only the new keyframe is outstanding")
    #expect(queue.flushes == 1)
    #expect(!queue.isDropping)
  }

  @Test func staleCompletionAfterFlushDoesNotDebitTheNewKeyframe() {
    var queue = StreamSendQueue(highWaterMark: 1_000)
    #expect(queue.decide(frameBytes: 5_000, isKeyframe: true) == .send)
    let staleGeneration = queue.generation
    #expect(queue.decide(frameBytes: 800, isKeyframe: true) == .flushThenSend)

    // The transport still reports the abandoned send later. That completion belongs to the old
    // generation and must not subtract from the keyframe that replaced it.
    queue.complete(bytes: 5_000, generation: staleGeneration)
    #expect(queue.pendingBytes == 800)
  }

  @Test func completionCreditsTheQueueAndResumesSending() {
    var queue = StreamSendQueue(highWaterMark: 1_000)
    _ = queue.decide(frameBytes: 1_200, isKeyframe: true)
    #expect(queue.decide(frameBytes: 100, isKeyframe: false) == .drop)

    queue.complete(bytes: 1_200)
    #expect(queue.pendingBytes == 0)
    #expect(queue.decide(frameBytes: 100, isKeyframe: false) == .send)
    #expect(!queue.isDropping)
  }

  @Test func completionCannotDriveTheQueueNegative() {
    // A double completion, or one for a frame that was dropped, must not leave a credit that hides
    // real backpressure later.
    var queue = StreamSendQueue(highWaterMark: 1_000)
    _ = queue.decide(frameBytes: 500, isKeyframe: true)
    queue.complete(bytes: 5_000)

    #expect(queue.pendingBytes == 0)
  }

  @Test func audioIsNeverDropped() {
    var queue = StreamSendQueue(highWaterMark: 100)
    _ = queue.decide(frameBytes: 5_000, isKeyframe: true)

    // A gap in audio is far more noticeable than a dropped picture, and audio is a few percent of the
    // bitrate, so it is always enqueued.
    queue.enqueueAudio(bytes: 400)
    #expect(queue.pendingBytes == 5_400)
    #expect(queue.droppedFrames == 0)
  }

  @Test func aSustainedStallDropsToTheNextKeyframeRatherThanGrowing() {
    var queue = StreamSendQueue(highWaterMark: 10_000)
    // A client that has taken nothing at all: the first frame goes out, then 120 frames arrive with
    // one keyframe every 30.
    _ = queue.decide(frameBytes: 60_000, isKeyframe: true)

    var sent = 0
    for index in 1 ... 120 {
      let decision = queue.decide(frameBytes: 20_000, isKeyframe: index % 30 == 0)
      if decision != .drop { sent += 1 }
    }

    #expect(sent == 4, "only the keyframes get through")
    #expect(queue.droppedFrames == 116)
    // The decisive property: memory does not grow with the length of the stall.
    #expect(queue.pendingBytes == 20_000)
  }
}
