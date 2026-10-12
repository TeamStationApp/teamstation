import AdaptiveBitrate
import Foundation
import Testing

@Suite("Adaptive bitrate opening rate")
struct AdaptiveBitrateStartTests {
  @Test("A start below the ceiling is where the rate opens, and a climb leaves from there")
  func opensAtStart() {
    var controller = AdaptiveBitrateController(
      ceiling: 4_000_000,
      floor: 500_000,
      tuning: .rtmpStream,
      start: 2_000_000
    )
    #expect(controller.bitrate == 2_000_000)
    #expect(controller.status.bitrate == 2_000_000)
    // A clean link that carries everything offered: the rate climbs from the start, not the top.
    var now = 0.0
    var last = controller.bitrate
    for _ in 0 ..< 40 {
      now += 0.25
      let bytes = Int(Double(last) / 8 * 0.25)
      if let next = controller.update(
        CongestionSample(interval: 0.25, queueDelay: 0, deliveredBytes: bytes, offeredBytes: bytes),
        now: now
      ) {
        last = next
      }
    }
    #expect(controller.bitrate > 2_000_000)
    #expect(controller.bitrate <= 4_000_000)
  }

  @Test("A start outside the range is held between the floor and the ceiling")
  func startIsClamped() {
    #expect(AdaptiveBitrateController(ceiling: 4_000_000, floor: 500_000, start: 9_000_000).bitrate == 4_000_000)
    #expect(AdaptiveBitrateController(ceiling: 4_000_000, floor: 500_000, start: 100_000).bitrate == 500_000)
    #expect(AdaptiveBitrateController(ceiling: 4_000_000, floor: 500_000).bitrate == 4_000_000)
  }

  @Test("A reset with a start opens there again, and without one at the ceiling")
  func resetTakesStart() {
    var controller = AdaptiveBitrateController(ceiling: 4_000_000, floor: 500_000)
    controller.reset(ceiling: 4_000_000, floor: 500_000, start: 2_000_000)
    #expect(controller.bitrate == 2_000_000)
    controller.reset(ceiling: 4_000_000, floor: 500_000)
    #expect(controller.bitrate == 4_000_000)
  }

  @Test("The loop hands the encoder the opening rate when it is configured")
  func loopAppliesStart() async throws {
    final class Applied: @unchecked Sendable {
      let lock = NSLock()
      var rates: [Int] = []
      func add(_ rate: Int) { lock.lock(); rates.append(rate); lock.unlock() }
      var first: Int? { lock.lock(); defer { lock.unlock() }; return rates.first }
    }
    let applied = Applied()
    let loop = AdaptiveBitrateLoop(
      ceiling: 4_000_000,
      floor: 500_000,
      tuning: .rtmpStream,
      sample: { reply in reply(nil) },
      apply: { applied.add($0) }
    )
    loop.configure(ceiling: 4_000_000, floor: 500_000, start: 2_000_000, enabled: false)
    for _ in 0 ..< 50 where applied.first == nil {
      try await Task.sleep(for: .milliseconds(10))
    }
    #expect(applied.first == 2_000_000)
    #expect(loop.status.controller.bitrate == 2_000_000)
    loop.stop()
  }
}
