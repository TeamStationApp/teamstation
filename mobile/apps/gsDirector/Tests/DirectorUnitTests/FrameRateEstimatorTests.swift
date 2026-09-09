import Foundation
import DirectorSources
import Testing

@Suite("Frame rate estimation")
struct FrameRateEstimatorTests {
  /// Feeds `count` access units spaced for `rate` on a 90 kHz clock, starting from `origin`.
  private func feed(
    _ estimator: inout FrameRateEstimator,
    rate: Double,
    count: Int,
    from origin: UInt32 = 0
  ) {
    let step = 90_000 / rate
    for index in 0 ..< count {
      estimator.note(timestamp: origin &+ UInt32((Double(index) * step).rounded()))
    }
  }

  @Test("A 30 fps camera reads as 30")
  func measuresThirty() {
    var estimator = FrameRateEstimator()
    feed(&estimator, rate: 30, count: 40)
    #expect(estimator.frameRate == 30)
  }

  @Test("A 60 fps camera reads as 60, which is the whole point")
  func measuresSixty() {
    var estimator = FrameRateEstimator()
    feed(&estimator, rate: 60, count: 40)
    #expect(estimator.frameRate == 60)
  }

  @Test("Nothing is reported until enough intervals have been seen")
  func withholdsUntilConverged() {
    var estimator = FrameRateEstimator()
    // n timestamps yield n-1 intervals, so this stops exactly one short.
    feed(&estimator, rate: 60, count: FrameRateEstimator.minimumSamples)
    #expect(estimator.frameRate == nil)

    estimator.note(timestamp: UInt32(FrameRateEstimator.minimumSamples) * 1_500)
    #expect(estimator.frameRate == 60)
  }

  @Test("Dropped frames do not halve the answer")
  func survivesDrops() {
    var estimator = FrameRateEstimator()
    var timestamp: UInt32 = 0
    // Every fifth frame missing: those intervals are double width, so a mean would report 25.
    for index in 0 ..< 60 {
      timestamp &+= (index % 5 == 4) ? 3_000 : 1_500
      estimator.note(timestamp: timestamp)
    }
    #expect(estimator.frameRate == 60)
  }

  @Test("Packets of one picture sharing a timestamp are not counted as frames")
  func ignoresRepeatedTimestamps() {
    var estimator = FrameRateEstimator()
    var timestamp: UInt32 = 0
    for _ in 0 ..< 40 {
      // The depacketizer can emit an access unit twice at the same instant; a naive counter would
      // see a zero interval and report an absurd rate.
      estimator.note(timestamp: timestamp)
      estimator.note(timestamp: timestamp)
      timestamp &+= 1_500
    }
    #expect(estimator.frameRate == 60)
  }

  @Test("The 32-bit RTP clock wrapping does not read as a gap")
  func survivesClockWrap() {
    var estimator = FrameRateEstimator()
    feed(&estimator, rate: 60, count: 40, from: UInt32.max - 15_000)
    #expect(estimator.frameRate == 60)
  }

  @Test("A reconnect discards what the previous session measured")
  func resetForgets() {
    var estimator = FrameRateEstimator()
    feed(&estimator, rate: 60, count: 40)
    #expect(estimator.frameRate == 60)

    estimator.reset()
    #expect(estimator.frameRate == nil)

    feed(&estimator, rate: 30, count: 40)
    #expect(estimator.frameRate == 30)
  }

  @Test("Broadcast rates snap to the nominal figure rather than drifting")
  func snapsNearbyRates() {
    #expect(FrameRateEstimator.snap(29.97) == 29.97)
    #expect(FrameRateEstimator.snap(59.94) == 59.94)
    // 90000/1501 — a 60 fps camera whose timestamps round unevenly.
    #expect(FrameRateEstimator.snap(90_000 / 1_501) == 59.94)
    #expect(FrameRateEstimator.snap(30.2) == 30)
    #expect(FrameRateEstimator.snap(49.5) == 50)
  }

  @Test("A rate that is nowhere near a standard one is reported as measured")
  func doesNotInventARate() {
    // A camera throttled to 17 fps in low light is a fact worth seeing, not something to round
    // onto 24 and then pace replay against.
    #expect(FrameRateEstimator.snap(17) == 17)
    #expect(FrameRateEstimator.snap(12.5) == 12.5)
  }
}
