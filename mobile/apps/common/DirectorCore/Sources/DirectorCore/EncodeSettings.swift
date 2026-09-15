import Foundation

/// How one kind of file Director makes is encoded: its codec, size, frame rate, bitrate and keyframe
/// spacing.
///
/// Three groups of these are the operator's to set: the raw camera encoding (an NDI camera's archive,
/// and every exported camera file), the programme master recording, and the programme master stream.
public struct EncodeSettings: Hashable, Sendable, Codable {
  public var codec: ProgramCodec
  public var resolution: ProgramResolution
  public var frameRate: Int
  public var bitrate: Int
  public var keyframeSeconds: Double

  public init(
    codec: ProgramCodec,
    resolution: ProgramResolution,
    frameRate: Int,
    bitrate: Int,
    keyframeSeconds: Double
  ) {
    self.codec = codec
    self.resolution = resolution
    self.frameRate = frameRate
    self.bitrate = bitrate
    self.keyframeSeconds = keyframeSeconds
  }
}

/// The encoding a take was recorded with.
///
/// Kept with the take, not read from Settings at export time: an export made tomorrow, or on the Mac,
/// must come out the way the take was set up, whatever Settings say by then.
public struct TakeEncoding: Hashable, Sendable, Codable {
  /// NDI archives, and every exported camera file.
  public var rawCamera: EncodeSettings
  /// The programme master, and a programme export that has to be re-encoded.
  public var programme: EncodeSettings

  public init(rawCamera: EncodeSettings, programme: EncodeSettings) {
    self.rawCamera = rawCamera
    self.programme = programme
  }
}
