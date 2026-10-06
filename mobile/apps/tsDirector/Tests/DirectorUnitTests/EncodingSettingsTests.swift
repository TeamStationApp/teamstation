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
    // The stream was the programme's settings in H.264; 12 Mbps is capped at the stream's 10.
    #expect(config.streamCodec == .h264)
    #expect(config.streamResolution == .hd720)
    #expect(config.streamFrameRate == 30)
    #expect(config.streamBitrateHigh == 10_000_000)
    #expect(config.streamBitrateLow == 5_000_000)
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

  @Test("Stream bitrates sit on the half-megabit grid inside 1–10 Mbps, the low never above the high")
  func streamBitratesClamp() {
    #expect(AppConfig.clampedStreamBitrates(low: 2_300_000, high: 6_100_000) == (2_500_000, 6_000_000))
    #expect(AppConfig.clampedStreamBitrates(low: 200_000, high: 25_000_000) == (1_000_000, 10_000_000))
    #expect(AppConfig.clampedStreamBitrates(low: 8_000_000, high: 3_000_000) == (3_000_000, 3_000_000))
    let config = AppConfig(streamBitrateLow: 7_000_000, streamBitrateHigh: 4_000_000)
    #expect(config.streamBitrateLow == 4_000_000)
    #expect(config.streamBitrateHigh == 4_000_000)
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
