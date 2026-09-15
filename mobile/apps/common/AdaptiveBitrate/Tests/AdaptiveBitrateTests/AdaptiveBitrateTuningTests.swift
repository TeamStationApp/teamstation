import Testing
@testable import AdaptiveBitrate

@Suite("Adaptive bitrate tuning presets")
struct AdaptiveBitrateTuningTests {
  @Test("The RTMP stream's preset differs from the defaults only in its delivery window and emergency delay")
  func rtmpStream() {
    var expected = AdaptiveBitrateController.Tuning()
    expected.deliveryWindow = 0.5
    expected.emergencyDelay = 0.2
    #expect(AdaptiveBitrateController.Tuning.rtmpStream == expected)
    #expect(AdaptiveBitrateController.Tuning.rtmpStream.emergencyDelay > AdaptiveBitrateController.Tuning.rtmpStream.congestedDelay)
  }

  @Test("With the preset, an emergency in the first second cuts to what the link delivers")
  func firstCutUsesDelivery() {
    var controller = AdaptiveBitrateController(ceiling: 4_000_000, floor: 1_000_000, tuning: .rtmpStream)
    // Half a second of a link carrying 2 Mbps of the 4 the encoder offers, with the queue building.
    var now = 0.0
    var cut: Int?
    for tick in 1 ... 3 {
      now += 0.25
      let sample = CongestionSample(
        interval: 0.25,
        queueDelay: 0.1 * Double(tick),
        deliveredBytes: 62_500,
        offeredBytes: 125_000
      )
      if let rate = controller.update(sample, now: now) { cut = rate }
    }
    // 0.85 of 2 Mbps, not 0.7 of 4.
    #expect(cut == 1_700_000)
  }
}
