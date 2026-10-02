import CameramanCore
import CameramanRTSP
import Foundation
import Testing

/// Checks the RTCP packets byte by byte against RFC 3550.
///
/// Nothing in TS Director parses RTCP yet, so there is no round-trip to lean on here. These packets
/// are what a client uses to derive a wall clock and to identify the camera, and a malformed one is
/// usually discarded silently, so the structure is asserted directly.
struct RTCPWriterTests {
  private let identity = DeviceIdentity(
    uuid: "3c8ea5d7-1111-4222-8333-444455556666",
    name: "Sideline Left"
  )
  private var writer: RTCPWriter {
    RTCPWriter(ssrc: 0xDEAD_BEEF, identity: identity)
  }

  @Test func senderReportHasTheStructureRFC3550Describes() {
    let packet = writer.senderReport(
      ntpTime: 0x0123_4567_89AB_CDEF,
      rtpTimestamp: 0x1122_3344,
      packetCount: 1_000,
      octetCount: 2_000_000
    )

    #expect(packet.count == 28, "header plus the 24-byte sender info, no reception reports")
    #expect(packet[0] == 0x80, "version 2, no padding, zero reception reports")
    #expect(packet[1] == 200)
    #expect(length(of: packet) == 6, "28 bytes is 7 words, and the field is words minus one")

    #expect(uint32(packet, at: 4) == 0xDEAD_BEEF)
    #expect(uint32(packet, at: 8) == 0x0123_4567, "NTP seconds")
    #expect(uint32(packet, at: 12) == 0x89AB_CDEF, "NTP fraction")
    #expect(uint32(packet, at: 16) == 0x1122_3344)
    #expect(uint32(packet, at: 20) == 1_000)
    #expect(uint32(packet, at: 24) == 2_000_000)
  }

  @Test func sourceDescriptionCarriesTheIdentity() throws {
    let packet = writer.sourceDescription()

    #expect(packet[0] == 0x81, "one chunk")
    #expect(packet[1] == 202)
    #expect(packet.count % 4 == 0, "RTCP packets must be a whole number of words")
    #expect(length(of: packet) == packet.count / 4 - 1)
    #expect(uint32(packet, at: 4) == 0xDEAD_BEEF)

    let items = parseSDESItems(packet.dropFirst(8))
    #expect(items[1] == identity.cname, "CNAME must be the UUID")
    #expect(items[2] == "Sideline Left", "NAME must be the human label")
    #expect(items[6] == "TS Cameraman")
  }

  @Test func sourceDescriptionIsPaddedWithAtLeastOneTerminator() {
    // A chunk whose items already end on a word boundary still needs a zero byte to terminate the
    // list, so it must gain a full word rather than nothing.
    for nameLength in 1 ... 16 {
      let identity = DeviceIdentity(
        uuid: self.identity.uuid,
        name: String(repeating: "x", count: nameLength)
      )
      let packet = RTCPWriter(ssrc: 1, identity: identity).sourceDescription()

      #expect(packet.count % 4 == 0, "name of \(nameLength)")
      #expect(packet.last == 0, "the item list must be terminated, name of \(nameLength)")
      #expect(length(of: packet) == packet.count / 4 - 1, "name of \(nameLength)")
    }
  }

  @Test func compoundPacketLeadsWithAReportAndCarriesACNAME() throws {
    let packet = writer.compoundPacket(
      ntpTime: 1,
      rtpTimestamp: 2,
      packetCount: 3,
      octetCount: 4
    )

    // RFC 3550 §6.1: a compound packet must start with a report and include an SDES CNAME.
    #expect(packet[1] == 200)

    let reportCount = (Int(length(of: packet)) + 1) * 4
    let second = packet.dropFirst(reportCount)
    #expect(second[second.startIndex + 1] == 202)

    let items = parseSDESItems(second.dropFirst(8))
    #expect(items[1] == identity.cname)
  }

  @Test func anOverLongNameIsTruncatedOnACharacterBoundary() throws {
    // The SDES length field is one byte. Truncating mid-UTF-8 would make the item unparseable, and a
    // client that cannot parse one item usually discards the whole packet.
    let long = String(repeating: "é", count: 300)
    let packet = RTCPWriter(
      ssrc: 1,
      identity: DeviceIdentity(uuid: identity.uuid, name: long)
    ).sourceDescription()

    let items = parseSDESItems(packet.dropFirst(8))
    let name = try #require(items[2])
    #expect(name.utf8.count <= 255)
    #expect(name.allSatisfy { $0 == "é" }, "no partial character survived")
  }

  @Test func ntpTimeIsSecondsSince1900() {
    // 1970-01-01 is 2208988800 seconds after 1900-01-01, the epoch offset RFC 3550 §4 specifies.
    let time = RTCPWriter.ntpTime(from: Date(timeIntervalSince1970: 0))
    #expect(time >> 32 == 2_208_988_800)
    #expect(time & 0xFFFF_FFFF == 0)

    // Half a second must land in the top bit of the fraction, not the bottom.
    let half = RTCPWriter.ntpTime(from: Date(timeIntervalSince1970: 0.5))
    #expect(half >> 32 == 2_208_988_800)
    #expect(half & 0xFFFF_FFFF == 0x8000_0000)
  }

  // MARK: - Helpers

  private func length(of packet: Data) -> UInt16 {
    UInt16(packet[packet.startIndex + 2]) << 8 | UInt16(packet[packet.startIndex + 3])
  }

  private func uint32(_ packet: Data, at offset: Int) -> UInt32 {
    let base = packet.startIndex + offset
    return UInt32(packet[base]) << 24
      | UInt32(packet[base + 1]) << 16
      | UInt32(packet[base + 2]) << 8
      | UInt32(packet[base + 3])
  }

  /// Walks the `[type][length][text]` item list, keyed by type.
  private func parseSDESItems(_ data: Data) -> [UInt8: String] {
    var items: [UInt8: String] = [:]
    var offset = data.startIndex
    while offset < data.endIndex {
      let type = data[offset]
      if type == 0 { break }
      guard data.index(offset, offsetBy: 1) < data.endIndex else { break }
      let count = Int(data[data.index(offset, offsetBy: 1)])
      let start = data.index(offset, offsetBy: 2)
      guard let end = data.index(start, offsetBy: count, limitedBy: data.endIndex) else { break }
      items[type] = String(data: data[start ..< end], encoding: .utf8)
      offset = end
    }
    return items
  }
}
