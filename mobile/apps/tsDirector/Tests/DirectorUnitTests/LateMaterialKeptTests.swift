import Foundation
import DirectorCore
import Testing

/// The recording keeps what arrives late. A picture or a stretch of sound that reaches the iPad after
/// its moment is still that moment's picture or sound, and it goes into the recording where it was
/// captured; only the live monitor may refuse it. The archive is fed on arrival and placed by capture
/// time, and a camera's late sound waits on its own timeline for the recording's mix
/// (`SourceSoundTimelineTests`). What stands between a late picture and the disk is one setting: on
/// for a new install since D7, but at 20 s, far beyond any delivery hiccup worth keeping.
@Suite("Late material is kept")
struct LateMaterialKeptTests {
  @Test("The disk latency cap is on at 20 s for a new install")
  func diskCapAtTwentySecondsByDefault() {
    // On since D7 (2026-10-05), at 20 s: far beyond any delivery hiccup, so late material within
    // that is still kept.
    #expect(AppConfig().diskLatencyCapEnabled)
    #expect(AppConfig().diskLatencyCapMilliseconds == 20_000)
  }

  @Test("A saved config keeps the disk latency cap it saved, and the two caps stay separate")
  func diskCapAsSaved() throws {
    let saved = #"{"programBitrate":12000000,"displayLatencyCapEnabled":true,"diskLatencyCapEnabled":false}"#
    let config = try JSONDecoder().decode(AppConfig.self, from: Data(saved.utf8))
    #expect(config.diskLatencyCapEnabled == false)
    // The monitor's cap and the disk's are separate: turning one on does not turn on the other.
    #expect(config.displayLatencyCapEnabled == true)
  }
}
