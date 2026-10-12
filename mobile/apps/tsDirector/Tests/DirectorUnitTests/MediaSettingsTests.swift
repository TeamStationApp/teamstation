import DirectorCore
import Foundation
import Testing
@testable import DirectorMedia
@testable import DirectorPipeline

/// The settings values the moved code reads in place of `AppConfig` carry exactly what it read.
@Suite("Media settings from AppConfig")
struct MediaSettingsTests {
  private var config: AppConfig {
    var config = AppConfig.default
    config.programCodec = .h264
    config.programResolution = .hd720
    config.programFrameRate = 60
    config.programBitrate = 9_000_000
    config.streamCodec = .hevc
    config.streamResolution = .hd1080
    config.streamFrameRate = 30
    config.streamBitrateLow = 700_000
    config.streamBitrateHigh = 3_500_000
    config.gopSeconds = 1.5
    config.resumeDowntimeLimitSeconds = 1_200
    return config
  }

  @Test("The programme master's settings are the programme group's")
  func programme() {
    let settings = ProgrammeSettings(config: config)
    #expect(settings.codec == config.programCodec)
    #expect(settings.resolution == config.programResolution)
    #expect(settings.frameRate == config.programFrameRate)
    #expect(settings.bitrate == config.programBitrate)
    #expect(settings.gopSeconds == config.gopSeconds)
    #expect(settings.encoding == config.programEncoding)
    #expect(ProgrammeSettings(config.programEncoding) == settings)
  }

  @Test("The stream's settings are the stream group's")
  func stream() {
    let settings = StreamSettings(config: config)
    #expect(settings.codec == config.streamCodec)
    #expect(settings.resolution == config.streamResolution)
    #expect(settings.frameRate == config.streamFrameRate)
    #expect(settings.bitrateLow == config.streamBitrateLow)
    #expect(settings.bitrateHigh == config.streamBitrateHigh)
    #expect(settings.gopSeconds == config.gopSeconds)
  }

  @Test("A take's settings are its programme encoding, its kept encoding and the resume limit")
  func recording() {
    let settings = RecordingSettings(config: config)
    #expect(settings.programme == config.programEncoding)
    #expect(settings.takeEncoding == config.takeEncoding)
    #expect(settings.resumeDowntimeLimitSeconds == config.resumeDowntimeLimitSeconds)
  }

  @Test("Director's telemetry takes the recording's error as the HUD's last error")
  func telemetry() {
    let telemetry = PipelineTelemetry()
    let media: any MediaTelemetry = telemetry
    media.recordRecordingError("program master did not finalise: test")
    #expect(telemetry.snapshot.dvr.lastError == "program master did not finalise: test")
  }
}
