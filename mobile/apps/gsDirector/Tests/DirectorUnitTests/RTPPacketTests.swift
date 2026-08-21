import Foundation
import DirectorRTSP
import Testing

/// Builds RTP packets byte by byte so the parser is tested against the wire layout rather than
/// against another copy of its own assumptions.
enum RTPFixture {
  static func packet(
    payloadType: UInt8 = 96,
    sequenceNumber: UInt16 = 1,
    timestamp: UInt32 = 0,
    ssrc: UInt32 = 0xDEAD_BEEF,
    marker: Bool = false,
    csrcCount: UInt8 = 0,
    hasExtension: Bool = false,
    padding: Int = 0,
    payload: Data
  ) -> Data {
    var bytes: [UInt8] = []
    var first: UInt8 = 0x80 | (csrcCount & 0x0F)
    if hasExtension { first |= 0x10 }
    if padding > 0 { first |= 0x20 }
    bytes.append(first)
    bytes.append(marker ? payloadType | 0x80 : payloadType)
    bytes.append(UInt8(sequenceNumber >> 8))
    bytes.append(UInt8(sequenceNumber & 0xFF))
    for shift in [ 24, 16, 8, 0 ] { bytes.append(UInt8((timestamp >> UInt32(shift)) & 0xFF)) }
    for shift in [ 24, 16, 8, 0 ] { bytes.append(UInt8((ssrc >> UInt32(shift)) & 0xFF)) }
    bytes.append(contentsOf: [UInt8](repeating: 0xAA, count: Int(csrcCount) * 4))
    if hasExtension {
      // Profile-specific id, then a length of one 32-bit word.
      bytes.append(contentsOf: [ 0xBE, 0xDE, 0x00, 0x01, 0x11, 0x22, 0x33, 0x44 ])
    }
    bytes.append(contentsOf: [UInt8](payload))
    if padding > 0 {
      bytes.append(contentsOf: [UInt8](repeating: 0, count: padding - 1))
      bytes.append(UInt8(padding))
    }
    return Data(bytes)
  }
}

@Suite("RTP packets")
struct RTPPacketTests {
  @Test("Header fields are read where the specification puts them")
  func headerFields() throws {
    let data = RTPFixture.packet(
      payloadType: 96,
      sequenceNumber: 4_660,
      timestamp: 0x1234_5678,
      ssrc: 0x0BAD_F00D,
      marker: true,
      payload: Data([ 0x61, 0x02 ])
    )

    let packet = try #require(RTPPacket.parse(data))
    #expect(packet.payloadType == 96)
    #expect(packet.sequenceNumber == 4_660)
    #expect(packet.timestamp == 0x1234_5678)
    #expect(packet.ssrc == 0x0BAD_F00D)
    #expect(packet.marker)
    #expect(packet.payload == Data([ 0x61, 0x02 ]))
  }

  @Test("Contributing sources are stepped over, not read as payload")
  func csrcListIsSkipped() throws {
    let packet = try #require(RTPPacket.parse(
      RTPFixture.packet(csrcCount: 2, payload: Data([ 0x41, 0x9A ]))
    ))

    #expect(packet.payload == Data([ 0x41, 0x9A ]))
  }

  @Test("An extension header is stepped over by its stated length")
  func extensionHeaderIsSkipped() throws {
    let packet = try #require(RTPPacket.parse(
      RTPFixture.packet(hasExtension: true, payload: Data([ 0x41, 0x9A ]))
    ))

    #expect(packet.payload == Data([ 0x41, 0x9A ]))
  }

  @Test("Trailing padding is not delivered as picture data")
  func paddingIsStripped() throws {
    let packet = try #require(RTPPacket.parse(
      RTPFixture.packet(padding: 4, payload: Data([ 0x41, 0x9A ]))
    ))

    #expect(packet.payload == Data([ 0x41, 0x9A ]))
  }

  @Test("A truncated or wrong-version packet is rejected rather than half-read")
  func malformedPacketsAreRejected() {
    #expect(RTPPacket.parse(Data([ 0x80, 0x60, 0x00 ])) == nil)
    // Version 1 in the top two bits.
    #expect(RTPPacket.parse(RTPFixture.packet(payload: Data([ 0x41 ])).replacingFirstByte(0x40)) == nil)
  }

  @Test("Consecutive packets report no loss")
  func sequentialPacketsAreIntact() {
    var tracker = RTPSequenceTracker()
    for sequenceNumber in UInt16(10) ... 20 {
      let intact = tracker.observe(sequenceNumber)
      #expect(intact)
    }

    #expect(tracker.lost == 0)
    #expect(tracker.received == 11)
  }

  @Test("A gap is counted, and by how many packets")
  func gapIsCounted() {
    var tracker = RTPSequenceTracker()
    tracker.observe(10)
    let intact = tracker.observe(14)

    #expect(!intact)
    #expect(tracker.lost == 3)
  }

  @Test("The wrap at 65535 is not read as sixty-five thousand lost packets")
  func sequenceWrapsCleanly() {
    var tracker = RTPSequenceTracker()
    tracker.observe(65_534)
    let across = [ UInt16(65_535), 0, 1 ].map { tracker.observe($0) }

    #expect(across.allSatisfy { $0 })
    #expect(tracker.lost == 0)
  }

  @Test("A packet arriving out of order is not counted as loss twice")
  func reorderedPacketIsNotLoss() {
    var tracker = RTPSequenceTracker()
    tracker.observe(10)
    tracker.observe(12)
    let lostAfterGap = tracker.lost
    // 11 turning up late must not add to the count.
    tracker.observe(11)

    #expect(tracker.lost == lostAfterGap)
  }
}

private extension Data {
  func replacingFirstByte(_ byte: UInt8) -> Data {
    var copy = self
    copy[copy.startIndex] = byte
    return copy
  }
}
