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

  /// Recorded from a Hollyland Cosmo C2 over NDI: the sender paces an exact 60.00 fps by its own
  /// span, but stamps frames in pairs, ~5 ms then ~30 ms apart. The median interval sits in the
  /// short cluster and read as 80.78 fps on the Mac and 70.41 on the iPad.
  @Test("A sender that stamps frames in pairs reads at its real rate, not its median interval")
  func pairedStampsReadAtSpanRate() {
    let trace: [Double] = [
      0.007555, 0.030308, 0.005428, 0.022488, 0.007765, 0.030063, 0.005194, 0.030788,
      0.004782, 0.021975, 0.007409, 0.030459, 0.005026, 0.020159, 0.012884, 0.023216,
      0.007197, 0.030703, 0.005019, 0.023841, 0.008047, 0.030499, 0.005442, 0.021837
    ]
    var estimator = FrameRateEstimator()
    for _ in 0 ..< 10 {
      for interval in trace { estimator.note(intervalSeconds: interval) }
    }
    #expect(estimator.frameRate == 60)
  }

  /// Scattered stamps around an exact rate: frames displaced in pairs by about ±6 ms, the way the
  /// Cosmo stamps them, so no single window of 120 intervals can say whether it is 59.94 or 60.
  private func scatteredIntervals(rate: Double, count: Int) -> [Double] {
    var state: UInt64 = 0x2545_F491_4F6C_DD1D
    func noise() -> Double {
      state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
      return Double(state >> 11) / Double(1 << 53) * 2 - 1
    }
    let stamps = (0 ... count).map { index in
      // ±6 ms in pairs plus ±2 ms of noise: every interval stays positive, as the camera's do.
      Double(index) / rate + (index % 2 == 0 ? -0.006 : 0.006) + noise() * 0.002
    }
    return zip(stamps.dropFirst(), stamps).map { $0 - $1 }
  }

  @Test("Scattered stamps settle on 60 rather than flipping to its broadcast twin", arguments: [60.0, 59.94])
  func scatteredStampsResolveTheFractionalTwin(rate: Double) {
    var estimator = FrameRateEstimator()
    var readings: [Double] = []
    for (index, interval) in scatteredIntervals(rate: rate, count: 7_200).enumerated() {
      estimator.note(intervalSeconds: interval)
      if index >= 3_600, let reading = estimator.frameRate { readings.append(reading) }
    }
    #expect(!readings.isEmpty)
    #expect(readings.allSatisfy { $0 == rate }, "read \(Set(readings)) for a \(rate) fps sender")
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
