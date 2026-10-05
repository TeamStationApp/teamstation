import CameramanCore
import CameramanRTSP
import Foundation
import Testing

@testable import CameramanUI

/// The random frame-rate wander (U-T2): a phone throttling from heat on a solid network, its rate
/// rising and falling irregularly, sometimes dipping hard. Seeded, so a run can be replayed.
@Suite("Frame-rate wander")
struct FrameRateWanderTests {
  static let wander = FrameRateWander(low: 20, high: 60, minHoldSeconds: 2, maxHoldSeconds: 20, seed: 42)

  @Test("The same seed gives the same schedule; another seed another")
  func seedReplays() {
    var a = WanderSchedule(Self.wander)
    var b = WanderSchedule(Self.wander)
    var other = Self.wander
    other.seed = 43
    var c = WanderSchedule(other)
    let times = stride(from: 0.0, to: 600, by: 0.5)
    let first = times.map { a.rate(atElapsed: $0) }
    #expect(first == times.map { b.rate(atElapsed: $0) })
    #expect(first != times.map { c.rate(atElapsed: $0) })
  }

  @Test("It starts high; targets stay in low–high, holds in minHold–maxHold, dips at 8–15 for 1–4 s")
  func bounds() {
    var schedule = WanderSchedule(Self.wander)
    #expect(schedule.rate(atElapsed: 0) == 60)
    schedule.extend(through: 20_000)
    for segment in schedule.segments {
      if segment.isDip {
        #expect(FrameRateWander.dipRates.contains(segment.from) && segment.from == segment.to)
        #expect(FrameRateWander.dipSeconds.contains(segment.end - segment.start))
      } else if segment.from == segment.to {
        #expect(segment.from >= 20 && segment.from <= 60)
        #expect(segment.end - segment.start >= 2 && segment.end - segment.start <= 20)
      } else {
        #expect(segment.to >= 20 && segment.to <= 60)
        #expect(FrameRateWander.rampSeconds.contains(segment.end - segment.start))
      }
    }
    // About one move in eight is a deep dip.
    let share = Double(schedule.dips) / Double(schedule.moves)
    #expect(share > 0.09 && share < 0.16, "\(schedule.dips) dips in \(schedule.moves) moves")
    // Both kinds of move happen: steps and ramps.
    #expect(schedule.segments.contains { $0.from != $0.to })
  }

  @Test("A ramp passes through the rates between, and a dip recovers")
  func rampsAndRecovery() throws {
    var schedule = WanderSchedule(Self.wander)
    schedule.extend(through: 5_000)
    let ramp = try #require(schedule.segments.first { $0.from != $0.to && abs($0.to - $0.from) > 10 })
    let middle = schedule.rate(atElapsed: (ramp.start + ramp.end) / 2)
    #expect(abs(middle - (ramp.from + ramp.to) / 2) < 1e-9)
    let dip = try #require(schedule.segments.firstIndex { $0.isDip })
    let after = schedule.segments[dip + 1]
    #expect(after.from == schedule.segments[dip].from && after.to >= 20)
  }

  @Test("Delivered rate follows the wander within 10% over 2 s windows, at each frame's capture time")
  func throttleFollows() {
    let throttle = FrameDeliveryThrottleTests.throttle()
    throttle.configure(FrameDelivery(frameRate: 24, swing: FrameRateSwing(low: 10, high: 12, periodSeconds: 5), wander: Self.wander))
    var schedule = WanderSchedule(Self.wander)
    let times = FrameDeliveryThrottleTests.captureTimes(seconds: 300)
    let kept = FrameDeliveryThrottleTests.kept(throttle, times)
    #expect(Set(kept).isSubset(of: Set(times)))
    var checked = 0
    var window = 1_002.0
    while window < 1_298 {
      let count = kept.filter { $0 >= window && $0 < window + 2 }.count
      // The mean target over the window, sampled finely.
      let target = stride(from: 0.0, to: 2, by: 0.01).map { schedule.rate(atElapsed: window - 1_000 + $0) }.reduce(0, +) / 200
      // Steady stretches only: a step inside the window moves the target faster than the
      // throttle's own jitter allows judging.
      let ends = stride(from: 0.0, through: 2, by: 1).map { schedule.rate(atElapsed: window - 1_000 + $0) }
      if (ends.max() ?? 0) - (ends.min() ?? 0) < 0.5 {
        #expect(abs(Double(count) / 2 - target) <= max(1.5, target * 0.1), "at \(window): \(Double(count) / 2) fps against \(target)")
        checked += 1
      }
      window += 2
    }
    #expect(checked > 40)
    #expect(throttle.wanderTarget != nil)
    // Wander wins over the swing and the steady rate; off restores every frame.
    #expect(FrameDelivery(frameRate: 24, wander: Self.wander).targetRate(atElapsed: 0) == 60)
    throttle.configure(.off)
    #expect(throttle.wanderTarget == nil)
    #expect(FrameDeliveryThrottleTests.kept(throttle, FrameDeliveryThrottleTests.captureTimes(seconds: 1, start: 2_000)).count == 60)
  }

  @Test("It parses low:high:minHold:maxHold[:seed], picks and reports a seed when none is given")
  func parsing() throws {
    let given = try #require(FrameRateWander(text: "20:60.0:2:20:42"))
    #expect(given == Self.wander)
    #expect(given.text == "20:60:2:20:42")
    let picked = try #require(FrameRateWander(text: "20:60:2:20", randomSeed: { 7 }))
    #expect(picked.text == "20:60:2:20:7")
    let random = try #require(FrameRateWander(text: "20:60:2:20"))
    #expect(random.seed != 0 || random.text.hasSuffix(":0"))
    for bad in [ "20:60:2", "60:20:2:20", "20:60:0:5", "20:60:5:2", "20:60:2:20:x", "0.5:60:2:20", "20:60:2:20:1:2" ] {
      #expect(FrameRateWander(text: bad) == nil, "\(bad)")
    }
  }

  @Test("SET test.deliveredFrameRateWander throttles, reads back with its seed, and clears")
  @MainActor
  func parameterPort() throws {
    let environment = AppEnvironment(broadcastStore: InMemorySettingsStore())
    let before = environment.settings
    let set = environment.handleParameters(RTSPResponder.ParameterRequest(
      method: .set,
      body: "test.deliveredFrameRateWander: 20:60:2:20:42\r\n"
    ))
    #expect(set.statusCode == 200)
    #expect(set.body == "test.deliveredFrameRateWander: 20:60:2:20:42\r\n")
    #expect(environment.frameThrottle.delivery.wander == Self.wander)
    #expect(environment.settings == before)
    for time in FrameDeliveryThrottleTests.captureTimes(seconds: 1) { _ = environment.frameThrottle.shouldDeliver(captureTime: time) }
    let dump = environment.stateDump.frameDelivery
    #expect(dump.wander == "20:60:2:20:42")
    #expect(dump.wanderTarget == 60)

    let unseeded = environment.handleParameters(RTSPResponder.ParameterRequest(
      method: .set,
      body: "test.deliveredFrameRateWander: 20:60:2:20\r\n"
    ))
    #expect(unseeded.statusCode == 200)
    let seed = try #require(environment.frameThrottle.delivery.wander?.seed)
    #expect(unseeded.body == "test.deliveredFrameRateWander: 20:60:2:20:\(seed)\r\n")

    let bad = environment.handleParameters(RTSPResponder.ParameterRequest(method: .set, body: "test.deliveredFrameRateWander: 60:20:2:20\r\n"))
    #expect(bad.statusCode == 400)
    let off = environment.handleParameters(RTSPResponder.ParameterRequest(method: .set, body: "test.deliveredFrameRateWander:\r\n"))
    #expect(off.statusCode == 200)
    #expect(environment.frameThrottle.delivery == .off)
  }

  @Test("SplitMix64 gives the reference sequence, so iOS and Android agree")
  func splitMixReference() {
    var random = SeededRandom(seed: 1_234_567)
    // The reference values for seed 1234567 (Vigna's splitmix64.c).
    #expect(random.next() == 6_457_827_717_110_365_317)
    #expect(random.next() == 3_203_168_211_198_807_973)
    let unit = random.unit()
    #expect(unit >= 0 && unit < 1)
  }
}
