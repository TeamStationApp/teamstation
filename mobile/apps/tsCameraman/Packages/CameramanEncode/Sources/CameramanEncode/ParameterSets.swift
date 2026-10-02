import CameramanCore
import CoreMedia
import Foundation

/// Pulls the decoder configuration out of an encoded sample's format description.
///
/// These have to be sent two ways at once: in the SDP so a client can decode the very first frame it
/// receives, and in-band before every keyframe so a client that joined mid-stream, or one whose
/// decoder was reset, recovers without a new `DESCRIBE`.
public enum ParameterSets {
  public static func extract(
    from formatDescription: CMFormatDescription,
    codec: StreamCodec
  ) -> [Data] {
    switch codec {
    case .h264: h264(from: formatDescription)
    case .hevc: hevc(from: formatDescription)
    }
  }

  /// SPS then PPS, which is the order `sprop-parameter-sets` requires.
  public static func h264(from formatDescription: CMFormatDescription) -> [Data] {
    var count = 0
    guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
      formatDescription,
      parameterSetIndex: 0,
      parameterSetPointerOut: nil,
      parameterSetSizeOut: nil,
      parameterSetCountOut: &count,
      nalUnitHeaderLengthOut: nil
    ) == noErr else { return [] }

    return (0 ..< count).compactMap { index in
      var pointer: UnsafePointer<UInt8>?
      var size = 0
      guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        formatDescription,
        parameterSetIndex: index,
        parameterSetPointerOut: &pointer,
        parameterSetSizeOut: &size,
        parameterSetCountOut: nil,
        nalUnitHeaderLengthOut: nil
      ) == noErr, let pointer else { return nil }
      return Data(bytes: pointer, count: size)
    }
  }

  /// VPS, SPS then PPS — the order `CMVideoFormatDescriptionCreateFromHEVCParameterSets` expects on
  /// the receiving side, which is what TS Director builds its decoder from.
  public static func hevc(from formatDescription: CMFormatDescription) -> [Data] {
    var count = 0
    guard CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
      formatDescription,
      parameterSetIndex: 0,
      parameterSetPointerOut: nil,
      parameterSetSizeOut: nil,
      parameterSetCountOut: &count,
      nalUnitHeaderLengthOut: nil
    ) == noErr else { return [] }

    return (0 ..< count).compactMap { index in
      var pointer: UnsafePointer<UInt8>?
      var size = 0
      guard CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
        formatDescription,
        parameterSetIndex: index,
        parameterSetPointerOut: &pointer,
        parameterSetSizeOut: &size,
        parameterSetCountOut: nil,
        nalUnitHeaderLengthOut: nil
      ) == noErr, let pointer else { return nil }
      return Data(bytes: pointer, count: size)
    }
  }

  /// The `profile-level-id` for H.264's `fmtp` line: profile_idc, the constraint byte and level_idc
  /// from the SPS, as six hex digits.
  public static func h264ProfileLevelID(sps: Data) -> String? {
    // Byte 0 is the NAL header, so the three bytes of interest start at 1.
    guard sps.count >= 4 else { return nil }
    let bytes = [UInt8](sps)
    return String(format: "%02X%02X%02X", bytes[1], bytes[2], bytes[3])
  }
}
