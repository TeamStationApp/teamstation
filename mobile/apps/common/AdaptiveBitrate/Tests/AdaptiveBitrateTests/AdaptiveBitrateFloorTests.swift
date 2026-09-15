import AdaptiveBitrate
import Testing

@Suite("Adaptive bitrate floor")
struct AdaptiveBitrateFloorTests {
  /// One tick of a link carrying `megabits` a second while the encoder offers far more and frames
  /// are being dropped: the case that cuts hardest.
  private func starved(megabits: Double) -> CongestionSample {
    let bytes = Int(megabits * 1_000_000 / 8 * 0.25)
    return CongestionSample(
      interval: 0.25,
      queueDelay: 0.5,
      deliveredBytes: bytes,
      offeredBytes: bytes * 6,
      droppedFrames: 1
    )
  }

  @Test("Without a floor of its own the controller comes down no further than half the ceiling")
  func defaultFloorIsHalf() {
    let controller = AdaptiveBitrateController(ceiling: 6_000_000)
    #expect(controller.floor == 3_000_000)
    #expect(controller.status.floor == 3_000_000)
  }

  @Test("A floor from settings is where cuts stop, however little the link carries")
  func settingsFloorHolds() {
    var controller = AdaptiveBitrateController(ceiling: 6_000_000, floor: 2_000_000)
    var now = 0.0
    for _ in 0 ..< 40 {
      now += 0.25
      _ = controller.update(starved(megabits: 0.5), now: now)
    }
    #expect(controller.bitrate == 2_000_000)
    #expect(controller.status.floor == 2_000_000)
  }

  @Test("A floor above the ceiling is held at the ceiling")
  func floorNeverAboveCeiling() {
    let controller = AdaptiveBitrateController(ceiling: 4_000_000, floor: 6_000_000)
    #expect(controller.floor == 4_000_000)
  }

  @Test("A reset takes a new floor, or half the new ceiling without one")
  func resetTakesFloor() {
    var controller = AdaptiveBitrateController(ceiling: 6_000_000, floor: 2_000_000)
    controller.reset(ceiling: 8_000_000, floor: 1_000_000)
    #expect(controller.floor == 1_000_000)
    controller.reset(ceiling: 8_000_000)
    #expect(controller.floor == 4_000_000)
  }

  @Test("Going idle returns to the ceiling and keeps the operator's floor")
  func idleResetKeepsFloor() {
    var controller = AdaptiveBitrateController(ceiling: 6_000_000, floor: 2_000_000)
    _ = controller.update(starved(megabits: 0.5), now: 0)
    #expect(controller.update(nil, now: 10.25) == 6_000_000)
    #expect(controller.floor == 2_000_000)
  }
}
