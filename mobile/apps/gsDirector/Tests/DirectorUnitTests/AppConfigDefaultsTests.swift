import Foundation
import DirectorCore
import Testing

@Suite("AppConfig defaults")
struct AppConfigDefaultsTests {
  @Test("Programme master is HEVC with 3-second archive segments")
  func programmeAndSegmentDefaults() {
    let config = AppConfig()
    #expect(config.programCodec == .hevc)
    #expect(config.segmentSeconds == 3)
    #expect(config.streamURL == "")
  }

  @Test("A config saved before those keys existed loads the same defaults")
  func missingKeysUseDefaults() throws {
    let config = try JSONDecoder().decode(AppConfig.self, from: Data("{}".utf8))
    #expect(config.programCodec == .hevc)
    #expect(config.segmentSeconds == 3)
    #expect(config.streamURL == "")
  }
}
