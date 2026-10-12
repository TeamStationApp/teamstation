import DirectorCore
import Foundation

/// How the programme master is encoded: the values `ProgramEncoder` opens a part with.
public struct ProgrammeSettings: Hashable, Sendable {
  /// TS Director's recording sound: AAC at 192 kbps.
  public static let defaultAudioBitrate = 192_000

  public var codec: ProgramCodec
  public var resolution: ProgramResolution
  public var frameRate: Int
  public var bitrate: Int
  public var gopSeconds: Double
  /// The AAC rate of the master's sound, in bits per second.
  public var audioBitrate: Int

  public init(
    codec: ProgramCodec,
    resolution: ProgramResolution,
    frameRate: Int,
    bitrate: Int,
    gopSeconds: Double,
    audioBitrate: Int = ProgrammeSettings.defaultAudioBitrate
  ) {
    self.codec = codec
    self.resolution = resolution
    self.frameRate = frameRate
    self.bitrate = bitrate
    self.gopSeconds = gopSeconds
    self.audioBitrate = audioBitrate
  }

  public init(_ encoding: EncodeSettings, audioBitrate: Int = ProgrammeSettings.defaultAudioBitrate) {
    self.init(
      codec: encoding.codec,
      resolution: encoding.resolution,
      frameRate: encoding.frameRate,
      bitrate: encoding.bitrate,
      gopSeconds: encoding.keyframeSeconds,
      audioBitrate: audioBitrate
    )
  }

  /// The same values as a take's kept encoding.
  public var encoding: EncodeSettings {
    EncodeSettings(
      codec: codec,
      resolution: resolution,
      frameRate: frameRate,
      bitrate: bitrate,
      keyframeSeconds: gopSeconds
    )
  }
}

/// How the programme stream is encoded: the values `ProgramStreamer` opens a session with. The
/// bitrate starts at `bitrateStart` (`bitrateHigh` when that is nil) and moves between the low and
/// the high with the uplink.
public struct StreamSettings: Hashable, Sendable {
  /// TS Director's stream sound: AAC at 128 kbps.
  public static let defaultAudioBitrate = 128_000

  public var codec: ProgramCodec
  public var resolution: ProgramResolution
  public var frameRate: Int
  public var bitrateLow: Int
  public var bitrateHigh: Int
  public var gopSeconds: Double
  /// Where a session opens, below the high when the uplink is not known yet: a phone's starts at
  /// half its high rather than at the top of a link it has never measured. Nil opens at the high,
  /// as TS Director's stream always has.
  public var bitrateStart: Int?
  /// The AAC rate of the stream's sound, in bits per second.
  public var audioBitrate: Int

  public init(
    codec: ProgramCodec,
    resolution: ProgramResolution,
    frameRate: Int,
    bitrateLow: Int,
    bitrateHigh: Int,
    gopSeconds: Double,
    bitrateStart: Int? = nil,
    audioBitrate: Int = StreamSettings.defaultAudioBitrate
  ) {
    self.codec = codec
    self.resolution = resolution
    self.frameRate = frameRate
    self.bitrateLow = bitrateLow
    self.bitrateHigh = bitrateHigh
    self.gopSeconds = gopSeconds
    self.bitrateStart = bitrateStart
    self.audioBitrate = audioBitrate
  }

  /// The rate a session opens at: `bitrateStart` held between the low and the high, or the high.
  public var openingBitrate: Int {
    guard let bitrateStart else { return bitrateHigh }
    return min(max(bitrateLow, bitrateStart), bitrateHigh)
  }
}

/// What a take is recorded with: the programme master's encoding, the whole encoding kept with
/// the take for its exports, and how long the app may be away before an interrupted take is closed
/// rather than resumed.
public struct RecordingSettings: Hashable, Sendable {
  public var programme: EncodeSettings
  public var takeEncoding: TakeEncoding
  public var resumeDowntimeLimitSeconds: Double

  public init(
    programme: EncodeSettings,
    takeEncoding: TakeEncoding,
    resumeDowntimeLimitSeconds: Double
  ) {
    self.programme = programme
    self.takeEncoding = takeEncoding
    self.resumeDowntimeLimitSeconds = resumeDowntimeLimitSeconds
  }
}
