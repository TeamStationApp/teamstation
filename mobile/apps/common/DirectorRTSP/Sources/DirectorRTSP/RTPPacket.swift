import Foundation

/// One RTP packet, header stripped down to what the depacketizers need (RFC 3550 §5.1).
public struct RTPPacket: Sendable, Equatable {
  public let payloadType: UInt8
  public let sequenceNumber: UInt16
  public let timestamp: UInt32
  public let ssrc: UInt32
  /// Set on the last packet of an access unit, which is how a frame boundary is known.
  public let marker: Bool
  public let payload: Data

  public init(
    payloadType: UInt8,
    sequenceNumber: UInt16,
    timestamp: UInt32,
    ssrc: UInt32,
    marker: Bool,
    payload: Data
  ) {
    self.payloadType = payloadType
    self.sequenceNumber = sequenceNumber
    self.timestamp = timestamp
    self.ssrc = ssrc
    self.marker = marker
    self.payload = payload
  }

  /// Contributing sources, the extension header and trailing padding are all skipped here rather
  /// than in each depacketizer, so a camera that starts sending any of them cannot corrupt a frame.
  public static func parse(_ data: Data) -> RTPPacket? {
    let bytes = [UInt8](data)
    guard bytes.count >= 12 else { return nil }
    guard bytes[0] >> 6 == 2 else { return nil }

    let hasPadding = bytes[0] & 0x20 != 0
    let hasExtension = bytes[0] & 0x10 != 0
    let csrcCount = Int(bytes[0] & 0x0F)

    var offset = 12 + csrcCount * 4
    guard bytes.count >= offset else { return nil }

    if hasExtension {
      guard bytes.count >= offset + 4 else { return nil }
      let words = Int(bytes[offset + 2]) << 8 | Int(bytes[offset + 3])
      offset += 4 + words * 4
      guard bytes.count >= offset else { return nil }
    }

    var end = bytes.count
    if hasPadding {
      let padding = Int(bytes[end - 1])
      guard padding > 0, end - padding >= offset else { return nil }
      end -= padding
    }
    guard end >= offset else { return nil }

    return RTPPacket(
      payloadType: bytes[1] & 0x7F,
      sequenceNumber: UInt16(bytes[2]) << 8 | UInt16(bytes[3]),
      timestamp: UInt32(bytes[4]) << 24 | UInt32(bytes[5]) << 16 | UInt32(bytes[6]) << 8 | UInt32(bytes[7]),
      ssrc: UInt32(bytes[8]) << 24 | UInt32(bytes[9]) << 16 | UInt32(bytes[10]) << 8 | UInt32(bytes[11]),
      marker: bytes[1] & 0x80 != 0,
      payload: Data(bytes[offset ..< end])
    )
  }
}

/// Counts gaps in the sequence numbering.
///
/// This is the number that separates "the network dropped it" from "the iPad could not keep up",
/// which is the first question to ask when a tile looks slow.
public struct RTPSequenceTracker: Sendable, Equatable {
  public private(set) var lost: UInt64 = 0
  public private(set) var received: UInt64 = 0
  private var expected: UInt16?

  public init() {}

  /// Returns false when packets went missing immediately before this one, so the caller can mark
  /// the access unit under construction as unusable.
  @discardableResult
  public mutating func observe(_ sequenceNumber: UInt16) -> Bool {
    received &+= 1
    defer { expected = sequenceNumber &+ 1 }
    guard let expected else { return true }

    // Signed difference so the comparison keeps working across the wrap at 65535, where a plain
    // `>` would read the next packet as 65 000 packets in the past.
    let delta = Int16(bitPattern: sequenceNumber &- expected)
    if delta > 0 {
      lost &+= UInt64(delta)
      return false
    }
    return true
  }
}
