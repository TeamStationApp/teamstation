import AdaptiveBitrate
import CameramanRTSP
import Testing

/// The ledger the bitrate controller reads a link from.
struct CongestionMeterTests {
  @Test func theQueueDelayIsTheAgeOfTheOldestUnfinishedSend() {
    var meter = CongestionMeter()
    #expect(meter.queueDelay(at: 5) == 0, "nothing waiting is no delay")

    meter.sent(bytes: 100, at: 1)
    meter.sent(bytes: 200, at: 2)
    #expect(meter.queueDelay(at: 3) == 2)
    #expect(meter.pendingBytes == 300)

    meter.delivered()
    #expect(meter.queueDelay(at: 3) == 1)
    meter.delivered()
    #expect(meter.queueDelay(at: 3) == 0)
  }

  @Test func aSampleCoversOnlyWhatHappenedSinceThePreviousOne() {
    var meter = CongestionMeter()
    _ = meter.sample(at: 0, droppedFrames: 0, flushes: 0)

    meter.offered(bytes: 500)
    meter.sent(bytes: 300, at: 0.1)
    meter.delivered()
    let first = meter.sample(at: 0.25, droppedFrames: 3, flushes: 1)
    #expect(first.interval == 0.25)
    #expect(first.offeredBytes == 500)
    #expect(first.deliveredBytes == 300)
    #expect(first.droppedFrames == 3)
    #expect(first.flushes == 1)

    let second = meter.sample(at: 0.5, droppedFrames: 5, flushes: 1)
    #expect(second.offeredBytes == 0)
    #expect(second.deliveredBytes == 0)
    #expect(second.droppedFrames == 2, "the send queue's totals become per-interval counts")
    #expect(second.flushes == 0)
  }

  @Test func bytesThatOnlyMovedIntoTheTransportBacklogHaveNotDrained() {
    var meter = CongestionMeter()
    _ = meter.sample(at: 0, droppedFrames: 0, flushes: 0, transportBacklogBytes: 1_000)
    meter.sent(bytes: 800, at: 0.1)
    meter.delivered()

    let sample = meter.sample(at: 0.25, droppedFrames: 0, flushes: 0, transportBacklogBytes: 1_500)
    #expect(sample.deliveredBytes == 800)
    #expect(sample.drainedBytes == 300)
  }

  @Test func theWorstClientIsTheOneLosingFramesThenTheOneWaitingLongest() {
    let slow = CongestionSample(interval: 0.25, queueDelay: 0.3)
    let dropping = CongestionSample(interval: 0.25, queueDelay: 0.1, droppedFrames: 1)
    let fine = CongestionSample(interval: 0.25, queueDelay: 0.01)

    #expect(CongestionSample.worst(of: [ slow, dropping, fine ]) == dropping)
    #expect(CongestionSample.worst(of: [ fine, slow ]) == slow)
    #expect(CongestionSample.worst(of: []) == nil)
  }
}
