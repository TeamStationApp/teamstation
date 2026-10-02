import CameramanCore
import Foundation

/// Builds the RTCP packets that accompany each RTP stream: a sender report so a receiver can map RTP
/// timestamps onto a wall clock, and a source description carrying the camera's identity.
///
/// The identity travels as `CNAME` and `NAME` items (RFC 3550 §6.5). That is the standard place for
/// it, so a client that knows nothing about this app still reads it.
public struct RTCPWriter: Sendable {
  private enum PacketType {
    static let senderReport: UInt8 = 200
    static let sourceDescription: UInt8 = 202
  }

  private enum SDESItem {
    static let cname: UInt8 = 1
    static let name: UInt8 = 2
    static let tool: UInt8 = 6
  }

  public let ssrc: UInt32
  public let identity: DeviceIdentity

  public init(ssrc: UInt32, identity: DeviceIdentity) {
    self.ssrc = ssrc
    self.identity = identity
  }

  /// A sender report and a source description sent as one compound packet, which RFC 3550 §6.1
  /// requires: every compound packet must lead with a report and carry an SDES with a CNAME.
  public func compoundPacket(
    ntpTime: UInt64,
    rtpTimestamp: UInt32,
    packetCount: UInt32,
    octetCount: UInt32
  ) -> Data {
    var packet = senderReport(
      ntpTime: ntpTime,
      rtpTimestamp: rtpTimestamp,
      packetCount: packetCount,
      octetCount: octetCount
    )
    packet.append(sourceDescription())
    return packet
  }

  public func senderReport(
    ntpTime: UInt64,
    rtpTimestamp: UInt32,
    packetCount: UInt32,
    octetCount: UInt32
  ) -> Data {
    var body = Data()
    body.append(bigEndian: ssrc)
    body.append(bigEndian: UInt32(truncatingIfNeeded: ntpTime >> 32))
    body.append(bigEndian: UInt32(truncatingIfNeeded: ntpTime))
    body.append(bigEndian: rtpTimestamp)
    body.append(bigEndian: packetCount)
    body.append(bigEndian: octetCount)

    // No reception reports: this end only sends.
    return header(type: PacketType.senderReport, count: 0, bodyCount: body.count) + body
  }

  public func sourceDescription() -> Data {
    var chunk = Data()
    chunk.append(bigEndian: ssrc)
    chunk.append(item(SDESItem.cname, identity.cname))
    chunk.append(item(SDESItem.name, identity.name))
    chunk.append(item(SDESItem.tool, "TS Cameraman"))
    // A single zero terminates the item list; the chunk then pads to a 4-byte boundary. There must be
    // at least one zero byte, so a chunk already on a boundary still gets four.
    let padding = 4 - (chunk.count % 4)
    chunk.append(Data(repeating: 0, count: padding))

    return header(type: PacketType.sourceDescription, count: 1, bodyCount: chunk.count) + chunk
  }

  /// The 4-byte RTCP header. `length` is in 32-bit words **minus one**, counting the header itself,
  /// which is the off-by-one every hand-rolled RTCP writer gets wrong.
  private func header(type: UInt8, count: UInt8, bodyCount: Int) -> Data {
    var data = Data(capacity: 4)
    data.append(0x80 | (count & 0x1F))
    data.append(type)
    data.append(bigEndian: UInt16((4 + bodyCount) / 4 - 1))
    return data
  }

  private func item(_ type: UInt8, _ text: String) -> Data {
    // The length field is a single byte, so an over-long name is truncated on a character boundary
    // rather than mid-UTF-8, which would make the item unparseable.
    var bytes = Array(text.utf8)
    if bytes.count > 255 {
      var truncated = text
      while truncated.utf8.count > 255 { truncated.removeLast() }
      bytes = Array(truncated.utf8)
    }

    var data = Data(capacity: 2 + bytes.count)
    data.append(type)
    data.append(UInt8(bytes.count))
    data.append(contentsOf: bytes)
    return data
  }

  /// Seconds since 1900 in the upper 32 bits, fraction in the lower, per RFC 3550 §4.
  public static func ntpTime(from date: Date) -> UInt64 {
    // 1900 to 1970 is 70 years including 17 leap days.
    let secondsFrom1900To1970: Double = 2_208_988_800
    let seconds = date.timeIntervalSince1970 + secondsFrom1900To1970
    let whole = UInt64(seconds.rounded(.down))
    let fraction = UInt64((seconds - seconds.rounded(.down)) * 4_294_967_296)
    return (whole << 32) | (fraction & 0xFFFF_FFFF)
  }
}
