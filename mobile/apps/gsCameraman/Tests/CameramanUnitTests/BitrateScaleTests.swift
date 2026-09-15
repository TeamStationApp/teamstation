import CameramanCore
import Foundation
import Testing

/// The bitrate runs from 1 to 16 Mbps: in the Settings sliders, over the wire, and in what is saved.
struct BitrateScaleTests {
  @Test func theScaleTopsOutAtSixteenMegabits() {
    #expect(StreamSettings.maximumBitrate == 16_000_000)
    #expect(CameraParameters.maximumBitrateKbps == 16_000)
  }

  @Test func aRateAboveTheScaleComesDownToItsTop() {
    #expect(StreamSettings(bitrate: 30_000_000).bitrate == 16_000_000)
    var settings = StreamSettings(bitrate: 8_000_000)
    settings.setBitrate(20_000_000)
    #expect(settings.bitrate == 16_000_000)
    #expect(settings.bitrateFloor <= settings.bitrate)
  }

  @Test func aRateSavedWhenTheScaleReachedFiftyLoadsAtTheTop() throws {
    let saved = try JSONEncoder().encode([ "bitrate": 45_000_000, "bitrateFloor": 20_000_000 ])
    let settings = try JSONDecoder().decode(StreamSettings.self, from: saved)
    #expect(settings.bitrate == 16_000_000)
    #expect(settings.bitrateFloor == 16_000_000)
  }
}
