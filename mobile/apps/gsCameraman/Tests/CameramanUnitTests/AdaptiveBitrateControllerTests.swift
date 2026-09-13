import CameramanRTSP
import Testing

/// The rate the encoder is told, tick by tick, for links that behave the way stadium Wi-Fi does.
/// The Android suite runs the same scenarios and expects the same numbers.
struct AdaptiveBitrateControllerTests {
  static let tick = 0.25

  /// One tick of a link carrying `mbps` with the oldest frame waiting `delay` seconds.
  static func sample(
    delay: Double = 0.01,
    mbps: Double,
    offeredMbps: Double? = nil,
    drops: Int = 0,
    transportBacklogBytes: Int? = nil
  ) -> CongestionSample {
    let bytes = Int(mbps * 1_000_000 / 8 * tick)
    return CongestionSample(
      interval: tick,
      queueDelay: delay,
      deliveredBytes: bytes,
      offeredBytes: offeredMbps.map { Int($0 * 1_000_000 / 8 * tick) } ?? bytes,
      transportBacklogBytes: transportBacklogBytes,
      droppedFrames: drops
    )
  }

  /// Runs `samples` a tick apart from `start`, returning every rate the encoder was handed.
  static func run(
    _ controller: inout AdaptiveBitrateController,
    _ samples: [CongestionSample?],
    start: Double = 0
  ) -> [Int] {
    var pushed: [Int] = []
    for (index, sample) in samples.enumerated() {
      if let rate = controller.update(sample, now: start + Double(index) * tick) { pushed.append(rate) }
    }
    return pushed
  }

  @Test func aCleanLinkStaysAtTheCeiling() {
    var controller = AdaptiveBitrateController(ceiling: 6_000_000)
    let pushed = Self.run(&controller, Array(repeating: Self.sample(mbps: 6), count: 80))

    #expect(pushed.isEmpty)
    #expect(controller.bitrate == 6_000_000)
    #expect(controller.status.decreases == 0)
  }

  @Test func droppedFramesCutAtOnce() {
    var controller = AdaptiveBitrateController(ceiling: 6_000_000)

    // No delivery rate yet, so the cut is the fixed emergency step.
    #expect(controller.update(Self.sample(mbps: 6, drops: 3), now: 0) == 4_200_000)
    #expect(controller.status.lastDecision == .emergency)
  }

  @Test func sustainedCongestionCutsToWhatTheLinkCarried() {
    var controller = AdaptiveBitrateController(ceiling: 6_000_000)
    // A link carrying 4 Mbps with a quarter of a second queued, tick after tick.
    let pushed = Self.run(&controller, Array(repeating: Self.sample(delay: 0.25, mbps: 4), count: 6))

    // The first cut comes before a full second of delivery is measured, so it is the fixed 10%.
    // One GOP later the measured rate is known, and the cut goes to 0.85 of it.
    #expect(pushed == [ 5_400_000, 3_400_000 ])
  }

  @Test func aLatencyBurstOnALinkStillCarryingTheRateCostsOneSmallStep() {
    var controller = AdaptiveBitrateController(ceiling: 6_000_000)
    let clean = Array(repeating: Self.sample(mbps: 6), count: 4)
    let burst = Array(repeating: Self.sample(delay: 0.3, mbps: 6), count: 2)
    let pushed = Self.run(&controller, clean + burst)

    #expect(pushed == [ 5_100_000 ])
  }

  @Test func aGrowingQueueIsTrimmedBeforeItIsLong() {
    var controller = AdaptiveBitrateController(ceiling: 6_000_000)
    let pushed = Self.run(&controller, [ 0.11, 0.12, 0.13, 0.14 ].map { Self.sample(delay: $0, mbps: 6) })

    #expect(pushed == [ 5_700_000 ], "trimmed on the third rising tick, then held for a GOP")
    #expect(controller.status.decreases == 1)
  }

  @Test func theRateNeverGoesBelowHalfTheCeiling() {
    var controller = AdaptiveBitrateController(ceiling: 6_000_000)
    let collapse = Array(repeating: Self.sample(delay: 2, mbps: 0.5, drops: 1), count: 40)
    let pushed = Self.run(&controller, collapse)

    #expect(pushed.allSatisfy { $0 >= 3_000_000 })
    #expect(controller.bitrate == 3_000_000)
    #expect(controller.floor == 3_000_000)
  }

  @Test func aStandingTransportBacklogOnALinkFallingShortCountsAsQueue() {
    var controller = AdaptiveBitrateController(ceiling: 6_000_000)
    // A second of a clean link with a round trip's worth in flight, then the link carries 3 Mbps of
    // the encoder's 6 and 400 KB builds in TCP: congestion, cut to 0.85 of the 3.75 Mbps the last
    // second carried.
    let clean = Array(repeating: Self.sample(mbps: 6, transportBacklogBytes: 8_000), count: 4)
    let backlog = Array(
      repeating: Self.sample(delay: 0, mbps: 3, offeredMbps: 6, transportBacklogBytes: 400_000),
      count: 3
    )

    #expect(Self.run(&controller, clean + backlog) == [ 3_100_000 ])
    #expect(controller.status.lastDecision == .congested)
  }

  @Test func aLongerRoundTripOnALinkThatKeepsUpIsNotQueue() {
    var controller = AdaptiveBitrateController(ceiling: 6_000_000)
    // 150 ms more each way puts 240 KB in flight — 320 ms at 6 Mbps — but the link still carries
    // everything the encoder makes, so nothing is waiting.
    let clean = Array(repeating: Self.sample(mbps: 6, transportBacklogBytes: 8_000), count: 4)
    let longer = Array(repeating: Self.sample(mbps: 6, transportBacklogBytes: 240_000), count: 40)

    #expect(Self.run(&controller, clean + longer).isEmpty)
  }

  @Test func bytesInFlightOnACleanLinkAreNotQueue() {
    var controller = AdaptiveBitrateController(ceiling: 6_000_000)
    // 20 KB in flight is 27 ms at 6 Mbps, every tick, for 20 s.
    let pushed = Self.run(&controller, Array(repeating: Self.sample(mbps: 6, transportBacklogBytes: 20_000), count: 80))

    #expect(pushed.isEmpty)
    #expect(controller.status.transportBaseMilliseconds == 27)
  }

  @Test func aKeyframeBurstInTheTransportIsNotQueue() {
    var controller = AdaptiveBitrateController(ceiling: 6_000_000)
    // A 150 KB keyframe in the kernel once a second, gone by the next tick: 200 ms if it counted.
    let second = [ 150_000, 10_000, 10_000, 10_000 ].map { Self.sample(mbps: 6, transportBacklogBytes: $0) }
    let pushed = Self.run(&controller, Array(repeating: second, count: 20).flatMap { $0 })

    #expect(pushed.isEmpty)
  }

  @Test func theRateWaitsForACleanLinkThenClimbsBackToTheCeiling() {
    var controller = AdaptiveBitrateController(ceiling: 6_000_000)
    #expect(controller.update(Self.sample(mbps: 6, drops: 1), now: 0) == 4_200_000)

    var increases: [(time: Double, rate: Int)] = []
    var now = 0.0
    while now < 40, controller.bitrate < 6_000_000 {
      now += Self.tick
      // A clean link carries whatever the encoder was last told to produce.
      let clean = Self.sample(mbps: Double(controller.bitrate) / 1_000_000)
      if let rate = controller.update(clean, now: now) { increases.append((now, rate)) }
    }

    #expect(controller.bitrate == 6_000_000)
    #expect(increases.first.map { $0.time >= 4 } == true, "no climb until the link has been clean for 4 s")
    #expect(now < 25, "back at the ceiling in well under half a minute")
    let gaps = zip(increases, increases.dropFirst()).map { $1.time - $0.time }
    #expect(gaps.allSatisfy { $0 >= 1 }, "increases reach the encoder at most once a second")
    #expect(zip(increases, increases.dropFirst()).allSatisfy { $0.rate < $1.rate })
  }

  @Test func theClimbSlowsNearWhatTheLinkCarriedNotWhereTheCutStarted() {
    var controller = AdaptiveBitrateController(ceiling: 6_000_000)
    // A second of a link carrying 3.5 Mbps, then a drop: the cut lands on the 3 Mbps floor.
    _ = Self.run(&controller, Array(repeating: Self.sample(mbps: 3.5), count: 4))
    #expect(controller.update(Self.sample(mbps: 3.5, drops: 1), now: 1) == 3_000_000)

    var now = 1.0
    var reachedCapacityAt: Double?
    while now < 30, reachedCapacityAt == nil {
      now += Self.tick
      _ = controller.update(Self.sample(mbps: Double(controller.bitrate) / 1_000_000), now: now)
      if controller.bitrate >= 3_500_000 { reachedCapacityAt = now }
    }

    // Four seconds' hold, then under 3% a second near 3.5 Mbps rather than 8%: GCC's full rate
    // would get there in two seconds and find the same congestion.
    #expect((reachedCapacityAt ?? 0) - 5 >= 5)
  }

  @Test func nobodyPlayingForLongStartsTheNextClientAtTheCeiling() {
    var controller = AdaptiveBitrateController(ceiling: 6_000_000)
    _ = controller.update(Self.sample(mbps: 6, drops: 1), now: 0)

    #expect(controller.update(nil, now: 5) == nil, "a short gap holds the rate")
    #expect(controller.update(nil, now: 10.25) == 6_000_000)
  }

  @Test func aResetStartsAtTheNewCeilingAndKeepsTheSessionCounts() {
    var controller = AdaptiveBitrateController(ceiling: 6_000_000)
    _ = controller.update(Self.sample(mbps: 6, drops: 1), now: 0)
    controller.reset(ceiling: 8_000_000)

    #expect(controller.bitrate == 8_000_000)
    #expect(controller.floor == 4_000_000)
    #expect(controller.status.decreases == 1)
  }
}
