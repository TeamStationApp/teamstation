import Foundation
import DirectorSources
import Testing

@Suite("Capture timeline smoothing")
struct CaptureTimelineSmootherTests {
  /// Deterministic scatter so a failure reproduces: a linear congruential generator in [-1, 1].
  private struct Scatter {
    var state: UInt64 = 0x9E37_79B9_7F4A_7C15
    mutating func next() -> Double {
      state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
      return Double(state >> 11) / Double(1 << 53) * 2 - 1
    }
  }

  private func gaps(_ values: [Double]) -> [Double] {
    zip(values.dropFirst(), values).map { $0 - $1 }
  }

  @Test("Clean timestamps pass through unchanged")
  func cleanPassesThrough() {
    var smoother = CaptureTimelineSmoother()
    let period = 1.0 / 60
    for index in 0 ..< 300 {
      let capture = 1_000 + Double(index) * period
      #expect(abs(smoother.place(capture: capture, period: period) - capture) < 1e-9)
    }
  }

  /// The Cosmo C2 trace: an exact 60.03 fps sender whose consecutive stamps land 3–37 ms apart.
  @Test("A sender's timestamp scatter does not reach the release schedule")
  func scatterIsRemoved() {
    var smoother = CaptureTimelineSmoother()
    var scatter = Scatter()
    let truePeriod = 1.0 / 60.03
    var placed: [Double] = []
    var raw: [Double] = []
    for index in 0 ..< 1_500 {
      let capture = 1_000 + Double(index) * truePeriod + scatter.next() * 0.012
      raw.append(capture)
      placed.append(smoother.place(capture: capture, period: 1.0 / 60))
    }
    let rawGaps = gaps(raw)
    #expect(rawGaps.max()! > 0.035, "the fixture should be as uneven as the camera")
    let settled = gaps(Array(placed.dropFirst(120)))
    #expect(settled.min()! > 0.0135, "shortest release gap \(settled.min()!)")
    #expect(settled.max()! < 0.0200, "longest release gap \(settled.max()!)")
  }

  /// The trace that actually stuttered, recorded from a Hollyland Cosmo C2: frames stamped in
  /// pairs ~5 ms then ~30 ms apart. Released raw, a 60 Hz screen drops one of each pair and holds
  /// the other for two refreshes — 30 fps judder from a 60 fps camera.
  @Test("Frames stamped in pairs are released one period apart")
  func pairedStampsAreEvened() {
    let trace: [Double] = [
      0.007555, 0.030308, 0.005428, 0.022488, 0.007765, 0.030063, 0.005194, 0.030788,
      0.004782, 0.021975, 0.007409, 0.030459, 0.005026, 0.020159, 0.012884, 0.023216,
      0.007197, 0.030703, 0.005019, 0.023841, 0.008047, 0.030499, 0.005442, 0.021837
    ]
    let period = trace.reduce(0, +) / Double(trace.count)
    var smoother = CaptureTimelineSmoother()
    var capture = 1_000.0
    var placed: [Double] = []
    for round in 0 ..< 60 {
      for interval in trace {
        capture += interval
        let value = smoother.place(capture: capture, period: period)
        if round >= 5 { placed.append(value) }
      }
    }
    let spacing = gaps(placed)
    #expect(spacing.min()! > period - 0.002, "shortest release gap \(spacing.min()!)")
    #expect(spacing.max()! < period + 0.002, "longest release gap \(spacing.max()!)")
  }

  /// Stepping by a measured period that is slightly wrong must not let the timeline walk away from
  /// real time: that slip is what emptied the delay line when the NDI tile ran on a bare counter.
  @Test("A wrong period settles to a constant lag instead of drifting")
  func wrongPeriodDoesNotDrift() {
    var smoother = CaptureTimelineSmoother()
    let truePeriod = 1.0 / 60
    var errors: [Int: Double] = [:]
    for index in 0 ..< 36_000 {
      let capture = Double(index) * truePeriod
      // The rate estimator once read this camera as 70.41 fps.
      let error = smoother.place(capture: capture, period: 1.0 / 70.41) - capture
      if index == 18_000 || index == 35_999 { errors[index] = error }
    }
    // Five minutes and ten minutes in, the same lag: it has stopped moving.
    #expect(abs(errors[18_000]! - errors[35_999]!) < 1e-6)
    #expect(abs(errors[35_999]!) < CaptureTimelineSmoother.reseatSeconds)
  }

  /// The frame after a drop is not stepped over the gap — with stamps this scattered a drop cannot
  /// be told from an ordinary long interval — so it lands about one period after the frame before
  /// it and the lag is repaid a little per frame. What must not happen is any single release gap
  /// far from a period: that is what the screen shows as a hitch.
  @Test("A dropped frame does not jolt the timeline")
  func dropIsAbsorbed() {
    var smoother = CaptureTimelineSmoother()
    let period = 1.0 / 60
    var placed: [Double] = []
    for index in 0 ..< 300 where index != 100 {
      placed.append(smoother.place(capture: Double(index) * period, period: period))
    }
    for (index, gap) in gaps(placed).enumerated() {
      #expect(abs(gap - period) < period * 0.1, "release \(index + 1) stepped \(gap)")
    }
    // And the lag it cost has gone a few seconds later.
    #expect(abs(placed.last! - 299 * period) < 0.001)
  }

  @Test("A discontinuity is taken at once rather than eased toward")
  func jumpReseats() {
    var smoother = CaptureTimelineSmoother()
    let period = 1.0 / 60
    for index in 0 ..< 60 {
      _ = smoother.place(capture: Double(index) * period, period: period)
    }
    #expect(smoother.place(capture: 500, period: period) == 500)
    #expect(abs(smoother.place(capture: 500 + period, period: period) - (500 + period)) < 1e-9)
  }

  @Test("Reset forgets the previous session")
  func resetForgets() {
    var smoother = CaptureTimelineSmoother()
    _ = smoother.place(capture: 10, period: 1.0 / 60)
    smoother.reset()
    #expect(smoother.place(capture: 10.1, period: 1.0 / 60) == 10.1)
  }
}
