import Foundation
import DirectorCore
import Testing

@Suite("Encoding settings")
struct EncodingSettingsTests {
  @Test("A new install records raw cameras at 1080p60 HEVC 4 Mbps and streams 1080p60 HEVC at 1–6 Mbps")
  func newInstallDefaults() {
    let config = AppConfig()
    #expect(config.programBitrate == 4_000_000)
    #expect(config.programFrameRate == 60)
    #expect(config.rawCameraEncoding == EncodeSettings(
      codec: .hevc, resolution: .hd1080, frameRate: 60, bitrate: 4_000_000, keyframeSeconds: 2
    ))
    #expect(config.streamEncoding == EncodeSettings(
      codec: .hevc, resolution: .hd1080, frameRate: 60, bitrate: 6_000_000, keyframeSeconds: 2
    ))
    #expect(config.streamBitrateLow == 1_000_000)
  }

  @Test("A new install has both latency caps on, at 1 s and 20 s, and the subnet override off")
  func newInstallCaps() {
    let config = AppConfig()
    #expect(config.displayLatencyCapEnabled)
    #expect(config.displayLatencyCapMilliseconds == 1_000)
    #expect(config.diskLatencyCapEnabled)
    #expect(config.diskLatencyCapMilliseconds == 20_000)
    #expect(config.subnetScanOverrideEnabled == false)
    #expect(config.activeScanSubnets.isEmpty)
  }

  /// An iPad saved before the groups existed: 720p30 programme at 12 Mbps, NDI archived in H.264.
  @Test("A saved config keeps what it had, and its new groups carry on what the iPad was already doing")
  func savedConfigCarriesOn() throws {
    let saved = """
    {"programCodec":"hevc","sourceEncodeCodec":"h264","programResolution":{"width":1280,"height":720},
     "programFrameRate":30,"programBitrate":12000000,"gopSeconds":2}
    """
    let config = try JSONDecoder().decode(AppConfig.self, from: Data(saved.utf8))
    // Nothing the operator chose is replaced by a new install's default.
    #expect(config.programBitrate == 12_000_000)
    #expect(config.programFrameRate == 30)
    // NDI was archived in the old codec setting at the programme's bitrate.
    #expect(config.rawCameraCodec == .h264)
    #expect(config.rawCameraBitrate == 12_000_000)
    // The stream was the programme's settings in H.264, whose 15 Mbps ceiling leaves 12 alone.
    #expect(config.streamCodec == .h264)
    #expect(config.streamResolution == .hd720)
    #expect(config.streamFrameRate == 30)
    #expect(config.streamBitrateHigh == 12_000_000)
    #expect(config.streamBitrateLow == 6_000_000)
  }

  @Test("An old H.264 config above 15 Mbps streams at 15, with half that as its floor")
  func savedConfigCappedAtH264Ceiling() throws {
    let saved = """
    {"programCodec":"hevc","programBitrate":20000000,"gopSeconds":2}
    """
    let config = try JSONDecoder().decode(AppConfig.self, from: Data(saved.utf8))
    #expect(config.streamCodec == .h264)
    #expect(config.streamBitrateHigh == 15_000_000)
    #expect(config.streamBitrateLow == 7_500_000)
  }

  @Test("An H.264 stream saved at 15 Mbps loads at 15 Mbps; an HEVC one saved there loads at 10")
  func savedStreamBitrateKeepsItsCodecCeiling() throws {
    var h264 = AppConfig(streamCodec: .h264)
    h264.settingStreamBitrates(low: 2_000_000, high: 15_000_000)
    let loaded = try JSONDecoder().decode(AppConfig.self, from: JSONEncoder().encode(h264))
    #expect(loaded.streamCodec == .h264)
    #expect(loaded.streamBitrateHigh == 15_000_000)
    #expect(loaded.streamBitrateLow == 2_000_000)

    let hevc = """
    {"streamCodec":"hevc","streamBitrateLow":2000000,"streamBitrateHigh":15000000}
    """
    let clamped = try JSONDecoder().decode(AppConfig.self, from: Data(hevc.utf8))
    #expect(clamped.streamBitrateHigh == 10_000_000)
    #expect(clamped.streamBitrateLow == 2_000_000)
  }

  @Test("Every new setting survives a save and a load")
  func roundTrips() throws {
    var config = AppConfig()
    config.rawCameraCodec = .h264
    config.rawCameraResolution = .hd720
    config.rawCameraFrameRate = 25
    config.rawCameraBitrate = 9_000_000
    config.streamCodec = .h264
    config.streamResolution = .hd720
    config.streamFrameRate = 30
    config.streamBitrateLow = 1_500_000
    config.streamBitrateHigh = 3_500_000
    let loaded = try JSONDecoder().decode(AppConfig.self, from: JSONEncoder().encode(config))
    #expect(loaded == config)
  }

  @Test("Stream bitrates sit on the half-megabit grid inside 1 Mbps to the codec's ceiling, the low never above the high")
  func streamBitratesClamp() {
    #expect(AppConfig.streamBitrateMaximum(for: .hevc) == 10_000_000)
    #expect(AppConfig.streamBitrateMaximum(for: .h264) == 15_000_000)
    #expect(AppConfig.clampedStreamBitrates(low: 2_300_000, high: 6_100_000, codec: .hevc) == (2_500_000, 6_000_000))
    #expect(AppConfig.clampedStreamBitrates(low: 200_000, high: 25_000_000, codec: .hevc) == (1_000_000, 10_000_000))
    #expect(AppConfig.clampedStreamBitrates(low: 200_000, high: 25_000_000, codec: .h264) == (1_000_000, 15_000_000))
    #expect(AppConfig.clampedStreamBitrates(low: 8_000_000, high: 3_000_000, codec: .h264) == (3_000_000, 3_000_000))
    let config = AppConfig(streamBitrateLow: 7_000_000, streamBitrateHigh: 4_000_000)
    #expect(config.streamBitrateLow == 4_000_000)
    #expect(config.streamBitrateHigh == 4_000_000)
    let h264 = AppConfig(streamCodec: .h264, streamBitrateLow: 15_000_000, streamBitrateHigh: 15_000_000)
    #expect(h264.streamBitrateHigh == 15_000_000)
    let hevc = AppConfig(streamCodec: .hevc, streamBitrateLow: 15_000_000, streamBitrateHigh: 15_000_000)
    #expect(hevc.streamBitrateLow == 10_000_000)
    #expect(hevc.streamBitrateHigh == 10_000_000)
  }

  @Test("settingStreamBitrates clamps to the codec in force: 15 Mbps in H.264, 10 in HEVC, 1 at least")
  func settingStreamBitratesUsesTheCodec() {
    var h264 = AppConfig(streamCodec: .h264)
    h264.settingStreamBitrates(low: 3_000_000, high: 15_000_000)
    #expect(h264.streamBitrateLow == 3_000_000)
    #expect(h264.streamBitrateHigh == 15_000_000)
    h264.settingStreamBitrates(low: 0, high: 0)
    #expect(h264.streamBitrateLow == 1_000_000)
    #expect(h264.streamBitrateHigh == 1_000_000)

    var hevc = AppConfig(streamCodec: .hevc)
    hevc.settingStreamBitrates(low: 3_000_000, high: 15_000_000)
    #expect(hevc.streamBitrateLow == 3_000_000)
    #expect(hevc.streamBitrateHigh == 10_000_000)
    hevc.settingStreamBitrates(low: 0, high: 0)
    #expect(hevc.streamBitrateLow == 1_000_000)
    #expect(hevc.streamBitrateHigh == 1_000_000)
  }

  @Test("Switching an H.264 stream at 14 Mbps to HEVC clamps it to 10; switching back leaves it at 10")
  func codecSwitchReclamps() {
    var config = AppConfig(streamCodec: .h264, streamBitrateLow: 12_000_000, streamBitrateHigh: 14_000_000)
    #expect(config.streamBitrateHigh == 14_000_000)
    config.streamCodec = .hevc
    #expect(config.streamBitrateLow == 10_000_000)
    #expect(config.streamBitrateHigh == 10_000_000)
    config.streamCodec = .h264
    #expect(config.streamBitrateHigh == 10_000_000)
  }

  @Test("A take records the raw camera and programme settings it started with")
  func takeEncoding() {
    var config = AppConfig()
    config.gopSeconds = 1
    config.programFrameRate = 30
    let take = config.takeEncoding
    #expect(take.rawCamera == config.rawCameraEncoding)
    #expect(take.programme.frameRate == 30)
    #expect(take.programme.keyframeSeconds == 1)
    #expect(take.rawCamera.keyframeSeconds == 1)
  }
}
