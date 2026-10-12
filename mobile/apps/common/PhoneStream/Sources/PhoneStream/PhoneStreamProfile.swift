import DirectorCore
import DirectorMedia
import Foundation

/// What a phone records and streams with. Fixed values, none of them shown to the user: a phone at a
/// ball field has nobody to tune it, and TS Director's live values are the ones proven there.
///
/// - Video: HEVC Main, 1920×1080, 30 fps, a 2 s stream GOP, no B-frames.
/// - Stream: adaptive between 0.5 and 4 Mbps, opening at 2 Mbps with `.rtmpStream` tuning. A phone
///   starts on an uplink nobody has measured, so it opens in the middle rather than at the top.
/// - Recording: a fixed 6 Mbps, crash-safe fragmented MP4.
/// - Sound: AAC at 48 kHz. The microphone is mono and is carried as the stereo mix Director's bus
///   makes; 128 kbps on the stream, 192 kbps in the recording (the encoders' own rates).
/// - The programme shows each picture a second after it was captured, Director's live value, and
///   the recording's mix waits a second for sound, because the microphone is local and never late.
/// - A stream whose connection has taken nothing for 6 s while the stream waits on it is replaced by a
///   fresh dial (`stallRedialSeconds`). A phone's network stack can sit on a dead connection far
///   longer than that, and the stream would come back only when the server gives up on it.
public enum PhoneStreamProfile {
  public static let codec: ProgramCodec = .hevc
  public static let resolution: ProgramResolution = .hd1080
  public static let frameRate = 30
  public static let gopSeconds: Double = 2

  public static let streamBitrateLow = 500_000
  public static let streamBitrateHigh = 4_000_000
  public static let streamBitrateStart = 2_000_000
  public static let recordingBitrate = 6_000_000

  public static let audioSampleRate = 48_000
  public static let streamAudioBitrate = 128_000
  public static let recordingAudioBitrate = 192_000

  public static let pictureDelaySeconds: Double = 1
  public static let recordingMixDelaySeconds: Double = 1
  /// How long the app may be away before an interrupted take is closed rather than resumed.
  public static let resumeDowntimeLimitSeconds: Double = 3_600
  /// How long the stream's connection may take nothing, with the stream waiting on it, before it is
  /// replaced.
  public static let stallRedialSeconds: Double = 6

  /// The recording's encoding, kept with every take so its export is made the way it was recorded.
  public static var recordingEncoding: EncodeSettings {
    EncodeSettings(
      codec: codec,
      resolution: resolution,
      frameRate: frameRate,
      bitrate: recordingBitrate,
      keyframeSeconds: gopSeconds
    )
  }

  /// A phone has one camera and no camera archive, so the raw camera encoding is the recording's.
  public static var takeEncoding: TakeEncoding {
    TakeEncoding(rawCamera: recordingEncoding, programme: recordingEncoding)
  }

  public static var programmeSettings: ProgrammeSettings {
    ProgrammeSettings(recordingEncoding, audioBitrate: recordingAudioBitrate)
  }

  public static var recordingSettings: RecordingSettings {
    RecordingSettings(
      programme: recordingEncoding,
      takeEncoding: takeEncoding,
      resumeDowntimeLimitSeconds: resumeDowntimeLimitSeconds
    )
  }

  public static var streamSettings: StreamSettings {
    StreamSettings(
      codec: codec,
      resolution: resolution,
      frameRate: frameRate,
      bitrateLow: streamBitrateLow,
      bitrateHigh: streamBitrateHigh,
      gopSeconds: gopSeconds,
      bitrateStart: streamBitrateStart,
      audioBitrate: streamAudioBitrate
    )
  }
}
