import Foundation
import DirectorCore
import Testing

/// The recording keeps what arrives late. A picture or a stretch of sound that reaches the iPad after
/// its moment is still that moment's picture or sound, and it goes into the recording where it was
/// captured; only the live monitor may refuse it. The archive is fed on arrival and placed by capture
/// time, and a camera's late sound is re-anchored rather than dropped from the mix
/// (`AudioPlayoutAnchorTests`). What stands between a late picture and the disk is one setting, and it
/// has to stay off unless the operator turns it on.
@Suite("Late material is kept")
struct LateMaterialKeptTests {
  @Test("The disk latency cap is off for a new install")
  func diskCapOffByDefault() {
    #expect(AppConfig().diskLatencyCapEnabled == false)
  }

  @Test("A saved config that never set the disk latency cap keeps it off")
  func diskCapOffWhenNeverSaved() throws {
    let saved = #"{"programBitrate":12000000,"displayLatencyCapEnabled":true}"#
    let config = try JSONDecoder().decode(AppConfig.self, from: Data(saved.utf8))
    #expect(config.diskLatencyCapEnabled == false)
    // The monitor's cap and the disk's are separate: turning one on does not turn on the other.
    #expect(config.displayLatencyCapEnabled == true)
  }
}
