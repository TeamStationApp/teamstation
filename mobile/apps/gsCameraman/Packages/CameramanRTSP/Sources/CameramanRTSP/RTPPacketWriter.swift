import Foundation

/// Serializes the 12-byte RTP header defined in RFC 3550 §5.1.
///
/// No contributing sources, no header extension and no padding, which is what every packetizer here
/// wants and what keeps the header a fixed size.
public struct RTPPacketWriter: Sendable {
  public static let headerCount = 12

  public let payloadType: UInt8
  public let ssrc: UInt32

  public init(payloadType: UInt8, ssrc: UInt32) {
    self.payloadType = payloadType
    self.ssrc = ssrc
  }

  public func packet(
    sequenceNumber: UInt16,
    timestamp: UInt32,
    marker: Bool,
    payload: Data
  ) -> Data {
    var packet = Data(capacity: Self.headerCount + payload.count)
    // Version 2, no padding, no extension, no contributing sources.
    packet.append(0x80)
    packet.append(marker ? payloadType | 0x80 : payloadType & 0x7F)
    packet.append(bigEndian: sequenceNumber)
    packet.append(bigEndian: timestamp)
    packet.append(bigEndian: ssrc)
    packet.append(payload)
    return packet
  }
}

extension Data {
  mutating func append(bigEndian value: UInt16) {
    append(UInt8(truncatingIfNeeded: value >> 8))
    append(UInt8(truncatingIfNeeded: value))
  }

  mutating func append(bigEndian value: UInt32) {
    append(UInt8(truncatingIfNeeded: value >> 24))
    append(UInt8(truncatingIfNeeded: value >> 16))
    append(UInt8(truncatingIfNeeded: value >> 8))
    append(UInt8(truncatingIfNeeded: value))
  }
}
