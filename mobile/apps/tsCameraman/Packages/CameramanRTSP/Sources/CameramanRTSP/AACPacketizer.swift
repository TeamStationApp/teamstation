import CameramanCore
import Foundation

/// RFC 3640 `mpeg4-generic` in AAC-hbr mode: a 16-bit AU-headers-length in **bits**, then one
/// 13-bit size and 3-bit index per access unit, then the units back to back.
///
/// One access unit per packet. At 1024 samples that is 21 ms of audio per packet, well inside any
/// jitter budget, and it keeps the AU-header section a fixed two bytes.
public struct AACPacketizer: Sendable {
  /// The declared sizeLength/indexLength/indexDeltaLength, which the SDP has to repeat exactly or the
  /// receiver reads the size field at the wrong width.
  public static let sizeLength = 13
  public static let indexLength = 3
  public static let indexDeltaLength = 3

  public init() {}

  /// Returns nil for an access unit too large for the 13-bit size field, rather than emitting a
  /// packet whose length field has silently wrapped.
  public func payload(for frame: EncodedAudioFrame) -> Data? {
    let count = frame.data.count
    guard count > 0, count < (1 << Self.sizeLength) else { return nil }

    var payload = Data(capacity: 4 + count)
    // One AU header of sizeLength + indexLength bits.
    payload.append(bigEndian: UInt16(Self.sizeLength + Self.indexLength))
    // 13 bits of size then 3 bits of AU-index, which is zero for the first unit in a packet. The two
    // fields happen to total 16 bits, so no bit-level packing is needed.
    payload.append(bigEndian: UInt16(count << Self.indexLength))
    payload.append(frame.data)
    return payload
  }

  /// AAC's RTP clock is the sample rate itself, so the timestamp advances by 1024 per access unit.
  public static func timestamp(forFrameIndex index: Int) -> UInt32 {
    UInt32(truncatingIfNeeded: index * 1024)
  }
}
