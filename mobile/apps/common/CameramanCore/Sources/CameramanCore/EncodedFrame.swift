import Foundation

/// One coded picture, as elementary NAL units with no start codes and no length prefixes.
///
/// These types live in `CameramanCore` rather than in the encoder so that `CameramanEncode` and
/// `CameramanRTSP` are siblings instead of a chain. That is what lets every packetizer test run on
/// bytes with no VideoToolbox present.
public struct EncodedVideoFrame: Sendable, Equatable {
  public let nalUnits: [Data]
  /// SPS/PPS, or VPS/SPS/PPS for HEVC. Sent in-band before every keyframe as well as in the SDP,
  /// because a decoder that waits for the in-band copy shows a black tile until the next keyframe.
  public let parameterSets: [Data]
  public let isKeyframe: Bool
  /// Seconds on the capture clock. Converted to a 90 kHz RTP timestamp at packetization time.
  public let presentationTime: Double

  public init(
    nalUnits: [Data],
    parameterSets: [Data] = [],
    isKeyframe: Bool,
    presentationTime: Double
  ) {
    self.nalUnits = nalUnits
    self.parameterSets = parameterSets
    self.isKeyframe = isKeyframe
    self.presentationTime = presentationTime
  }

  public var isEmpty: Bool { nalUnits.isEmpty && parameterSets.isEmpty }
}

/// One AAC access unit, without an ADTS header — RTP `mpeg4-generic` carries raw AUs.
public struct EncodedAudioFrame: Sendable, Equatable {
  public let data: Data
  public let presentationTime: Double
  public let sampleRate: Int
  public let channelCount: Int
  /// When the first sample of this frame was captured, on the host clock video frames are stamped
  /// on. `presentationTime` counts samples from the start of a run and stays the RTP timeline; this
  /// follows the capture buffers themselves, so samples the system dropped do not put every later
  /// frame early. Nil when the encoder had no capture time to go on.
  public let captureTime: Double?

  public init(
    data: Data,
    presentationTime: Double,
    sampleRate: Int,
    channelCount: Int,
    captureTime: Double? = nil
  ) {
    self.data = data
    self.presentationTime = presentationTime
    self.sampleRate = sampleRate
    self.channelCount = channelCount
    self.captureTime = captureTime
  }
}
