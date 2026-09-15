import Testing
@testable import AdaptiveBitrate

@Suite("Adaptive bitrate tuning presets")
struct AdaptiveBitrateTuningTests {
  static let tick = 0.25

  @Test("The RTMP stream's preset waits seconds rather than milliseconds, and takes a stall for no rate")
  func rtmpStream() {
    var expected = AdaptiveBitrateController.Tuning()
    expected.clearDelay = 0.25
    expected.growingDelay = 1.0
    expected.congestedDelay = 1.5
    expected.emergencyDelay = 5.0
    expected.stallShare = 0.1
    expected.holdWhileDraining = true
    let preset = AdaptiveBitrateController.Tuning.rtmpStream
    #expect(preset == expected)
    #expect(preset.clearDelay < preset.growingDelay)
    #expect(preset.growingDelay < preset.congestedDelay)
    #expect(preset.congestedDelay < preset.emergencyDelay)
  }

  /// Ticks of a link carrying `mbps` of the `offeredMbps` the encoder makes, with the queue's oldest
  /// write `delays[i]` old at tick `i`. Returns every rate pushed and when.
  static func run(
    _ controller: inout AdaptiveBitrateController,
    delays: [Double],
    mbps: Double,
    offeredMbps: Double
  ) -> [(time: Double, rate: Int)] {
    var pushed: [(time: Double, rate: Int)] = []
    for (index, delay) in delays.enumerated() {
      let now = Double(index + 1) * tick
      let sample = CongestionSample(
        interval: tick,
        queueDelay: delay,
        deliveredBytes: Int(mbps * 1_000_000 / 8 * tick),
        offeredBytes: Int(offeredMbps * 1_000_000 / 8 * tick)
      )
      if let rate = controller.update(sample, now: now) { pushed.append((now, rate)) }
    }
    return pushed
  }

  @Test("With the preset, a link carrying half the rate is cut to what it carries once the queue stands")
  func slowLinkCutsToDelivery() {
    var controller = AdaptiveBitrateController(ceiling: 4_000_000, floor: 1_000_000, tuning: .rtmpStream)
    // 2 Mbps of the 4 offered: the queue ages half a second every second, an eighth a tick.
    let pushed = Self.run(&controller, delays: (1 ... 20).map { Double($0) * 0.125 }, mbps: 2, offeredMbps: 4)
    // Nothing while the queue is under a second, which is a dip the send buffer is there for.
    #expect(pushed.allSatisfy { $0.time > 2.0 })
    // 0.85 of 2 Mbps once a second and a half has stood for two ticks.
    #expect(pushed.contains { $0.rate == 1_700_000 })
    #expect(controller.bitrate == 1_700_000)
  }

  @Test("With the preset, a four-second stall takes fixed steps rather than going to the floor")
  func stallIsNotARate() {
    var controller = AdaptiveBitrateController(ceiling: 4_000_000, floor: 1_000_000, tuning: .rtmpStream)
    // The link carries nothing, so the queue ages a quarter-second a tick.
    let pushed = Self.run(&controller, delays: (1 ... 16).map { Double($0) * 0.25 }, mbps: 0, offeredMbps: 4)
    #expect(!pushed.isEmpty)
    #expect(pushed.allSatisfy { $0.rate >= 3_000_000 })
    #expect(controller.bitrate >= 3_000_000)
  }

  @Test("The default tuning still takes a stalled link's rate at its word")
  func defaultTrustsDelivery() {
    var controller = AdaptiveBitrateController(ceiling: 4_000_000, floor: 1_000_000)
    let pushed = Self.run(&controller, delays: (1 ... 8).map { Double($0) * 0.25 }, mbps: 0, offeredMbps: 4)
    #expect(pushed.last?.rate == 1_000_000)
  }

  @Test("With the preset, a stall past five seconds takes the large steps")
  func longStallTakesLargeSteps() {
    var controller = AdaptiveBitrateController(ceiling: 4_000_000, floor: 1_000_000, tuning: .rtmpStream)
    let pushed = Self.run(&controller, delays: (1 ... 24).map { Double($0) * 0.25 }, mbps: 0, offeredMbps: 4)
    // Past five seconds the backlog is slow to drain even once the link is back, so it stops
    // growing at the high rate.
    #expect(pushed.filter { $0.time <= 5.0 }.allSatisfy { $0.rate >= 2_600_000 })
    #expect(controller.bitrate < 2_000_000)
  }

  @Test("With the preset, a queue the link is already emptying is not cut again")
  func drainingQueueHolds() {
    var controller = AdaptiveBitrateController(ceiling: 4_000_000, floor: 1_000_000, tuning: .rtmpStream)
    // A second of clean link so there is a delivery rate, then two seconds queued while the link
    // carries 3 Mbps of the 2 offered: the backlog is going.
    let delays = Array(repeating: 0.1, count: 4) + Array(repeating: 2.0, count: 12)
    let pushed = Self.run(&controller, delays: delays, mbps: 3, offeredMbps: 2)
    #expect(pushed.isEmpty)
    #expect(controller.status.decreases == 0)
  }
}
