import CameramanCore
import Foundation

/// VideoToolbox hands back AVCC-style samples: each NAL unit preceded by a big-endian length,
/// usually 4 bytes but the length size is declared per format. RTP carries elementary NAL units
/// with no prefix at all, so the two layouts have to be converted rather than passed through.
///
/// Pure byte manipulation, deliberately separate from the encoder, so it is testable without
/// VideoToolbox.
public enum NALUnitConversion {
  /// Splits a length-prefixed buffer into elementary NAL units.
  ///
  /// Returns nil on a malformed buffer rather than a partial list, because a truncated final unit
  /// decodes into visible corruption and is better dropped than sent.
  public static func elementaryUnits(fromAVCC data: Data, lengthSize: Int = 4) -> [Data]? {
    guard (1 ... 4).contains(lengthSize) else { return nil }
    let bytes = [UInt8](data)
    var units: [Data] = []
    var offset = 0

    while offset < bytes.count {
      guard offset + lengthSize <= bytes.count else { return nil }
      var length = 0
      for index in 0 ..< lengthSize {
        length = length << 8 | Int(bytes[offset + index])
      }
      offset += lengthSize
      guard length > 0, offset + length <= bytes.count else { return nil }
      units.append(Data(bytes[offset ..< offset + length]))
      offset += length
    }
    return units
  }

  /// The inverse, which the round-trip tests use to rebuild what VideoToolbox would have produced.
  public static func avcc(fromElementaryUnits units: [Data], lengthSize: Int = 4) -> Data {
    var result = Data()
    for unit in units {
      let length = UInt32(unit.count)
      for shift in stride(from: (lengthSize - 1) * 8, through: 0, by: -8) {
        result.append(UInt8((length >> UInt32(shift)) & 0xFF))
      }
      result.append(unit)
    }
    return result
  }

  /// Annex-B, for writing an elementary stream to disk that ffmpeg and ffprobe can read.
  public static func annexB(fromElementaryUnits units: [Data]) -> Data {
    var result = Data()
    for unit in units {
      result.append(contentsOf: [ 0x00, 0x00, 0x00, 0x01 ])
      result.append(unit)
    }
    return result
  }
}
