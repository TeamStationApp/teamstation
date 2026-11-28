import Foundation
import Testing
@testable import DirectorCore

/// The stream's bitrate ceiling follows its codec: 15 Mbps in H.264, 10 Mbps in HEVC, 1 Mbps the floor.
@Suite("Stream bitrate ceiling")
struct StreamBitrateCeilingTests {
  @Test("The ceiling is 15 Mbps for H.264 and 10 Mbps for HEVC")
  func ceilingPerCodec() {
    #expect(AppConfig.streamBitrateMaximum(for: .h264) == 15_000_000)
    #expect(AppConfig.streamBitrateMaximum(for: .hevc) == 10_000_000)
  }

  @Test("clampedStreamBitrates caps each codec at its ceiling and lifts both to 1 Mbps")
  func clampPerCodec() {
    #expect(AppConfig.clampedStreamBitrates(low: 9_000_000, high: 25_000_000, codec: .h264) == (9_000_000, 15_000_000))
    #expect(AppConfig.clampedStreamBitrates(low: 9_000_000, high: 25_000_000, codec: .hevc) == (9_000_000, 10_000_000))
    #expect(AppConfig.clampedStreamBitrates(low: 0, high: 200_000, codec: .h264) == (1_000_000, 1_000_000))
    #expect(AppConfig.clampedStreamBitrates(low: 0, high: 200_000, codec: .hevc) == (1_000_000, 1_000_000))
  }

  @Test("An H.264 config made or loaded at 15 Mbps keeps 15; an HEVC one gets 10")
  func initAndDecodeUseTheCodec() throws {
    let h264 = AppConfig(streamCodec: .h264, streamBitrateLow: 2_000_000, streamBitrateHigh: 15_000_000)
    #expect(h264.streamBitrateHigh == 15_000_000)
    let loaded = try JSONDecoder().decode(AppConfig.self, from: JSONEncoder().encode(h264))
    #expect(loaded.streamBitrateHigh == 15_000_000)
    let hevc = AppConfig(streamCodec: .hevc, streamBitrateLow: 2_000_000, streamBitrateHigh: 15_000_000)
    #expect(hevc.streamBitrateHigh == 10_000_000)
  }

  @Test("A saved config with no stream group streams H.264 at the programme bitrate, capped at 15")
  func legacyDecodeDefault() throws {
    let saved = Data(#"{"programBitrate":20000000}"#.utf8)
    let config = try JSONDecoder().decode(AppConfig.self, from: saved)
    #expect(config.streamCodec == .h264)
    #expect(config.streamBitrateHigh == 15_000_000)
    #expect(config.streamBitrateLow == 7_500_000)
  }

  @Test("settingStreamBitrates clamps with the codec in force")
  func settingUsesTheCodec() {
    var h264 = AppConfig(streamCodec: .h264)
    h264.settingStreamBitrates(low: 4_000_000, high: 15_000_000)
    #expect(h264.streamBitrateLow == 4_000_000)
    #expect(h264.streamBitrateHigh == 15_000_000)
    var hevc = AppConfig(streamCodec: .hevc)
    hevc.settingStreamBitrates(low: 4_000_000, high: 15_000_000)
    #expect(hevc.streamBitrateLow == 4_000_000)
    #expect(hevc.streamBitrateHigh == 10_000_000)
  }

  @Test("Switching an H.264 stream at 14 Mbps to HEVC clamps it to 10")
  func codecSwitchReclamps() {
    var config = AppConfig(streamCodec: .h264, streamBitrateLow: 12_000_000, streamBitrateHigh: 14_000_000)
    config.streamCodec = .hevc
    #expect(config.streamBitrateLow == 10_000_000)
    #expect(config.streamBitrateHigh == 10_000_000)
  }
}
