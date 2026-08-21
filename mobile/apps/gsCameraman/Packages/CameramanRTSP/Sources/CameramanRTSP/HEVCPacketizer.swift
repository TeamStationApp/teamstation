import CameramanCore
import Foundation

/// RFC 7798 packetization.
///
/// Kept separate from the H.264 version on purpose: the NAL header is two bytes, the type sits in
/// different bits, the fragmentation type is 49 rather than 28, and the start/end bits live in a third
/// byte. Sharing the code would make each of those a silent wrong-picture bug.
public struct HEVCPacketizer: Sendable {
  public static let clockRate: UInt32 = 90_000

  private static let fragmentationType: UInt8 = 49

  public let maximumPayloadCount: Int

  public init(maximumPayloadCount: Int = RTPLimits.defaultMaximumPayloadCount) {
    self.maximumPayloadCount = maximumPayloadCount
  }

  public func payloads(for frame: EncodedVideoFrame) -> [Data] {
    var units = frame.parameterSets
    units.append(contentsOf: frame.nalUnits)
    return units.flatMap(payloads(forNALUnit:))
  }

  public func payloads(forNALUnit nal: Data) -> [Data] {
    guard nal.count >= 2 else { return [] }
    if nal.count <= maximumPayloadCount { return [ nal ] }

    // The fragment carries a 2-byte payload header plus a 1-byte FU header, replacing the 2-byte NAL
    // header, so it costs one byte more than the original per fragment.
    let bodyCount = maximumPayloadCount - 3
    guard bodyCount > 0 else { return [] }

    let first = nal[nal.startIndex]
    let second = nal[nal.index(after: nal.startIndex)]
    let type = (first >> 1) & 0x3F
    // Keep the forbidden-zero bit and the layer id, substitute the fragmentation type.
    let payloadHeaderFirst = (first & 0x81) | (Self.fragmentationType << 1)

    let body = nal.dropFirst(2)
    var payloads: [Data] = []
    var offset = body.startIndex
    while offset < body.endIndex {
      let end = min(body.index(offset, offsetBy: bodyCount, limitedBy: body.endIndex) ?? body.endIndex, body.endIndex)
      let isStart = offset == body.startIndex
      let isEnd = end == body.endIndex

      var fragment = Data(capacity: 3 + bodyCount)
      fragment.append(payloadHeaderFirst)
      fragment.append(second)
      fragment.append((isStart ? 0x80 : 0) | (isEnd ? 0x40 : 0) | type)
      fragment.append(body[offset ..< end])
      payloads.append(fragment)

      offset = end
    }
    return payloads
  }
}
