import Foundation

/// The video codecs Director publishes, and how each is framed on the wire.
///
/// H.264 goes out in classic FLV framing: codec ID 7 in the low nibble of the tag's first byte, the
/// way every RTMP server has taken it for fifteen years. Classic FLV has no codec ID for H.265, so
/// H.265 goes out in Enhanced RTMP (veovera/enhanced-rtmp, v1), which names the codec with a FourCC
/// in an extended tag header. YouTube, Twitch's enhanced broadcasting, OBS 29.1 and later, FFmpeg 6.1
/// and later, SRS and MediaMTX all read it; a server that predates it sees a codec it does not know.
public enum RTMPVideoCodec: String, Sendable, Equatable, CaseIterable {
  case h264
  case hevc

  /// Enhanced RTMP's name for the codec, as `connect`'s `fourCcList` spells it.
  public var fourCCString: String {
    switch self {
    case .h264: "avc1"
    case .hevc: "hvc1"
    }
  }

  /// The same name as a big-endian number, as the tag header and `onMetaData` carry it.
  public var fourCC: UInt32 {
    fourCCString.utf8.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
  }

  /// Whether this codec travels in Enhanced RTMP's extended tag header rather than classic FLV.
  public var isEnhanced: Bool { self == .hevc }

  /// `onMetaData`'s `videocodecid`: the classic codec ID for H.264, and for an Enhanced RTMP codec
  /// the FourCC read as a number, which is what the spec says a publisher sends.
  public var metadataCodecID: Double {
    switch self {
    case .h264: 7
    case .hevc: Double(fourCC)
    }
  }

  public var displayName: String {
    switch self {
    case .h264: "H.264"
    case .hevc: "H.265"
    }
  }
}

public enum FLVTag {
  /// Enhanced RTMP's video packet types, carried in the low nibble of an extended header.
  public enum EnhancedPacketType: UInt8, Sendable {
    /// The decoder configuration record: `hvcC` for H.265.
    case sequenceStart = 0
    /// Coded pictures, preceded by a 24-bit composition time offset.
    case codedFrames = 1
    case sequenceEnd = 2
    /// Coded pictures whose composition time offset is zero, which is therefore left out.
    case codedFramesX = 3
    case metadata = 4
  }

  /// Classic FLV video: frame type and codec ID 7 (AVC), AVC packet type, composition time.
  public static func video(keyframe: Bool, packetType: UInt8, compositionTime: Int32 = 0, payload: Data)
    -> Data
  {
    var data = Data(capacity: 5 + payload.count)
    let frameType: UInt8 = keyframe ? 1 : 2
    data.append((frameType << 4) | 7)
    data.append(packetType)
    appendSI24(compositionTime, to: &data)
    data.append(payload)
    return data
  }

  /// Enhanced RTMP video: `[IsExHeader:1][FrameType:3][PacketType:4]`, the FourCC, then the body.
  ///
  /// Only `codedFrames` carries a composition time offset, and only for the codecs the spec gives
  /// one (AVC and HEVC); `codedFramesX` is the same packet with the offset known to be zero.
  public static func enhancedVideo(
    keyframe: Bool,
    packetType: EnhancedPacketType,
    fourCC: UInt32,
    compositionTime: Int32 = 0,
    payload: Data
  ) -> Data {
    var data = Data(capacity: 8 + payload.count)
    let frameType: UInt8 = keyframe ? 1 : 2
    data.append(0x80 | (frameType << 4) | packetType.rawValue)
    appendUInt32BE(fourCC, to: &data)
    if packetType == .codedFrames, fourCC == Self.fourCC("hvc1") || fourCC == Self.fourCC("avc1") {
      appendSI24(compositionTime, to: &data)
    }
    data.append(payload)
    return data
  }

  /// The sequence header for `codec`: an AVC decoder configuration record in classic framing, or an
  /// HEVC one in an Enhanced RTMP SequenceStart.
  public static func videoSequenceHeader(codec: RTMPVideoCodec, record: Data) -> Data {
    codec.isEnhanced
      ? enhancedVideo(keyframe: true, packetType: .sequenceStart, fourCC: codec.fourCC, payload: record)
      : video(keyframe: true, packetType: 0, payload: record)
  }

  /// One coded picture for `codec`. Director never reorders frames, so the composition time is
  /// always zero. H.265 still goes out as CodedFrames with its explicit zero rather than CodedFramesX,
  /// which is what OBS sends for HEVC and so what every server that takes Enhanced RTMP has been
  /// tested against.
  public static func videoFrame(codec: RTMPVideoCodec, keyframe: Bool, payload: Data) -> Data {
    codec.isEnhanced
      ? enhancedVideo(keyframe: keyframe, packetType: .codedFrames, fourCC: codec.fourCC, payload: payload)
      : video(keyframe: keyframe, packetType: 1, payload: payload)
  }

  public static func audio(packetType: UInt8, payload: Data) -> Data {
    var data = Data(capacity: 2 + payload.count)
    // AAC, 44 kHz flag (ignored for AAC), 16-bit, stereo.
    data.append(0xAF)
    data.append(packetType)
    data.append(payload)
    return data
  }

  /// Whether a video tag is a decoder configuration record, in either framing. Classic FLV puts the
  /// AVC packet type in the second byte; Enhanced RTMP puts its packet type in the low nibble of the
  /// first, where SequenceStart is 0 — and its second byte is the FourCC's first letter.
  public static func isVideoSequenceHeader(_ tag: Data) -> Bool {
    guard let first = tag.first else { return false }
    if first & 0x80 != 0 {
      return first & 0x0F == EnhancedPacketType.sequenceStart.rawValue
    }
    return tag.count >= 2 && tag[tag.startIndex + 1] == 0
  }

  /// AAC's packet type is the second byte, and 0 is the AudioSpecificConfig.
  public static func isAudioSequenceHeader(_ tag: Data) -> Bool {
    tag.count >= 2 && tag[tag.startIndex + 1] == 0
  }

  /// Frame type 1 is a keyframe in both framings: the high nibble of a classic tag's first byte, and
  /// the three bits under Enhanced RTMP's IsExHeader flag.
  public static func isVideoKeyframe(_ tag: Data) -> Bool {
    guard let first = tag.first else { return false }
    let frameType = first & 0x80 != 0 ? (first >> 4) & 0x07 : first >> 4
    return frameType == 1
  }

  public static func fourCC(_ code: StaticString) -> UInt32 {
    code.withUTF8Buffer { bytes in
      bytes.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
    }
  }

  public static func avcDecoderConfigurationRecord(sps: Data, pps: Data) -> Data {
    var record = Data()
    record.append(1)
    if sps.count >= 4 {
      record.append(sps[sps.startIndex + 1])
      record.append(sps[sps.startIndex + 2])
      record.append(sps[sps.startIndex + 3])
    } else {
      record.append(contentsOf: [ 0x64, 0x00, 0x1F ])
    }
    record.append(0xFF)
    record.append(0xE1)
    record.append(UInt8((sps.count >> 8) & 0xFF))
    record.append(UInt8(sps.count & 0xFF))
    record.append(sps)
    record.append(1)
    record.append(UInt8((pps.count >> 8) & 0xFF))
    record.append(UInt8(pps.count & 0xFF))
    record.append(pps)
    return record
  }

  private static func appendSI24(_ value: Int32, to data: inout Data) {
    let bits = UInt32(bitPattern: value) & 0xFFFFFF
    data.append(UInt8((bits >> 16) & 0xFF))
    data.append(UInt8((bits >> 8) & 0xFF))
    data.append(UInt8(bits & 0xFF))
  }

  private static func appendUInt32BE(_ value: UInt32, to data: inout Data) {
    data.append(UInt8((value >> 24) & 0xFF))
    data.append(UInt8((value >> 16) & 0xFF))
    data.append(UInt8((value >> 8) & 0xFF))
    data.append(UInt8(value & 0xFF))
  }
}
