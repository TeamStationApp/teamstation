import Foundation

public enum FLVTag {
  public static func video(keyframe: Bool, packetType: UInt8, compositionTime: Int32 = 0, payload: Data)
    -> Data
  {
    var data = Data(capacity: 5 + payload.count)
    let frameType: UInt8 = keyframe ? 1 : 2
    data.append((frameType << 4) | 7)
    data.append(packetType)
    let cts = UInt32(bitPattern: compositionTime) & 0xFFFFFF
    data.append(UInt8((cts >> 16) & 0xFF))
    data.append(UInt8((cts >> 8) & 0xFF))
    data.append(UInt8(cts & 0xFF))
    data.append(payload)
    return data
  }

  public static func audio(packetType: UInt8, payload: Data) -> Data {
    var data = Data(capacity: 2 + payload.count)
    // AAC, 44 kHz flag (ignored for AAC), 16-bit, stereo.
    data.append(0xAF)
    data.append(packetType)
    data.append(payload)
    return data
  }

  public static func avcDecoderConfigurationRecord(sps: Data, pps: Data) -> Data {
    var record = Data()
    record.append(1)
    if sps.count >= 4 {
      record.append(sps[1])
      record.append(sps[2])
      record.append(sps[3])
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
}
