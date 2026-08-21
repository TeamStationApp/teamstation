import CameramanCore
import Foundation

/// RFC 6184 packetization: a NAL that fits goes out on its own, one that does not is split into FU-A
/// fragments.
///
/// STAP-A aggregation is deliberately not used. It only saves packets on the parameter sets, and a
/// receiver that mishandles it produces a picture that looks decodable and is wrong.
public struct H264Packetizer: Sendable {
  /// The RTP clock for H.264 is fixed at 90 kHz by RFC 6184 §8.1, independent of the frame rate.
  public static let clockRate: UInt32 = 90_000

  private static let fuAType: UInt8 = 28

  public let maximumPayloadCount: Int

  public init(maximumPayloadCount: Int = RTPLimits.defaultMaximumPayloadCount) {
    self.maximumPayloadCount = maximumPayloadCount
  }

  /// Returns the payloads for one access unit, in order. The caller sets the marker bit on the last
  /// one and gives them all the same timestamp, which is what tells the receiver where the picture
  /// ends.
  public func payloads(for frame: EncodedVideoFrame) -> [Data] {
    var units = frame.parameterSets
    units.append(contentsOf: frame.nalUnits)
    return units.flatMap(payloads(forNALUnit:))
  }

  public func payloads(forNALUnit nal: Data) -> [Data] {
    guard let header = nal.first else { return [] }
    if nal.count <= maximumPayloadCount { return [ nal ] }

    // FU-A replaces the 1-byte NAL header with a 2-byte one, so each fragment carries that much less.
    let bodyCount = maximumPayloadCount - 2
    guard bodyCount > 0 else { return [] }

    let body = nal.dropFirst()
    let indicator = (header & 0xE0) | Self.fuAType
    let type = header & 0x1F

    var payloads: [Data] = []
    var offset = body.startIndex
    while offset < body.endIndex {
      let end = min(body.index(offset, offsetBy: bodyCount, limitedBy: body.endIndex) ?? body.endIndex, body.endIndex)
      let isStart = offset == body.startIndex
      let isEnd = end == body.endIndex

      var fragment = Data(capacity: 2 + bodyCount)
      fragment.append(indicator)
      fragment.append((isStart ? 0x80 : 0) | (isEnd ? 0x40 : 0) | type)
      fragment.append(body[offset ..< end])
      payloads.append(fragment)

      offset = end
    }
    return payloads
  }
}

public enum RTPLimits {
  /// 1500-byte Ethernet MTU less 20 bytes of IPv4, 8 of UDP and 12 of RTP header.
  ///
  /// Interleaved RTSP rides on TCP where this does not strictly apply, but a stream that is also
  /// deliverable over UDP without refragmenting is worth more than the few percent of overhead.
  public static let defaultMaximumPayloadCount = 1460
}
