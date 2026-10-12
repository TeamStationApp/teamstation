// The programme's recorder and streamer, their clocks and sound, and recovery live in
// `DirectorMedia`, shared with the TeamStation app. Re-exported so `import DirectorPipeline` still
// sees them.
@_exported import DirectorMedia
import DirectorCore
import Foundation

extension PipelineTelemetry: MediaTelemetry {
  /// The recording's last error is the HUD's and the status line's `dvr.lastError`.
  public func recordRecordingError(_ message: String) {
    mutate { $0.dvr.lastError = message }
  }
}

/// Director's settings values are built from `AppConfig`, so the moved code reads exactly what it
/// read before.
extension ProgrammeSettings {
  public init(config: AppConfig) {
    self.init(
      codec: config.programCodec,
      resolution: config.programResolution,
      frameRate: config.programFrameRate,
      bitrate: config.programBitrate,
      gopSeconds: config.gopSeconds
    )
  }
}

extension StreamSettings {
  public init(config: AppConfig) {
    self.init(
      codec: config.streamCodec,
      resolution: config.streamResolution,
      frameRate: config.streamFrameRate,
      bitrateLow: config.streamBitrateLow,
      bitrateHigh: config.streamBitrateHigh,
      gopSeconds: config.gopSeconds
    )
  }
}

extension RecordingSettings {
  public init(config: AppConfig) {
    self.init(
      programme: config.programEncoding,
      takeEncoding: config.takeEncoding,
      resumeDowntimeLimitSeconds: config.resumeDowntimeLimitSeconds
    )
  }
}

extension ProgramEncoder {
  /// The programme master with Director's own telemetry and settings.
  public convenience init(
    telemetry: PipelineTelemetry,
    converter: PixelConverter,
    config: AppConfig,
    directory: URL = DirectorPaths.program,
    clock: DirectorClock = SystemClock()
  ) {
    self.init(
      telemetry: telemetry as any MediaTelemetry,
      converter: converter,
      settings: ProgrammeSettings(config: config),
      directory: directory,
      clock: clock
    )
  }
}
