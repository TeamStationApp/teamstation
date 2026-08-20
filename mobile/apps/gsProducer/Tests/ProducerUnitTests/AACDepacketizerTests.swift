import Foundation
import ProducerRTSP
import Testing

@Suite("AAC depacketizer")
struct AACDepacketizerTests {
  private let framing = AACFraming(sizeLength: 13, indexLength: 3, indexDeltaLength: 3)

  private func packet(_ payload: [UInt8]) -> RTPPacket {
    RTPPacket(
      payloadType: 98,
      sequenceNumber: 1,
      timestamp: 0,
      ssrc: 1,
      marker: true,
      payload: Data(payload)
    )
  }

  /// One AU header is 13 size bits plus 3 index bits, which is exactly two bytes: the size sits in
  /// the top 13 bits.
  private func auHeader(size: Int) -> [UInt8] {
    let value = UInt16(size) << 3
    return [ UInt8(value >> 8), UInt8(value & 0xFF) ]
  }

  @Test("One access unit is sliced off at the size its header states")
  func singleAccessUnit() {
    let depacketizer = AACDepacketizer(framing: framing)
    let payload = [ 0x00, 0x10 ] + auHeader(size: 4) + [ 0x21, 0x1A, 0xBC, 0xDE ]

    #expect(depacketizer.accessUnits(from: packet(payload)) == [ Data([ 0x21, 0x1A, 0xBC, 0xDE ]) ])
  }

  @Test("Several access units in one packet all come out, in order")
  func multipleAccessUnits() {
    let depacketizer = AACDepacketizer(framing: framing)
    // Two 16-bit headers, so AU-headers-length is 32 bits.
    let payload = [ 0x00, 0x20 ]
      + auHeader(size: 3)
      + auHeader(size: 2)
      + [ 0xA1, 0xA2, 0xA3, 0xB1, 0xB2 ]

    #expect(depacketizer.accessUnits(from: packet(payload)) == [
      Data([ 0xA1, 0xA2, 0xA3 ]),
      Data([ 0xB1, 0xB2 ])
    ])
  }

  @Test("The index-delta width is stepped over, or every size after the first is misread")
  func indexDeltaIsConsumed() {
    // With indexdeltalength wrongly treated as 0, the second header would be read from the wrong
    // bit offset and produce a nonsense size.
    let depacketizer = AACDepacketizer(framing: framing)
    let payload = [ 0x00, 0x20 ] + auHeader(size: 1) + auHeader(size: 1) + [ 0xAA, 0xBB ]

    #expect(depacketizer.accessUnits(from: packet(payload)) == [ Data([ 0xAA ]), Data([ 0xBB ]) ])
  }

  @Test("A header promising more audio than the packet holds yields only what is there")
  func truncatedPayloadStopsEarly() {
    let depacketizer = AACDepacketizer(framing: framing)
    let payload = [ 0x00, 0x20 ] + auHeader(size: 2) + auHeader(size: 9) + [ 0xAA, 0xBB, 0xCC ]

    #expect(depacketizer.accessUnits(from: packet(payload)) == [ Data([ 0xAA, 0xBB ]) ])
  }

  @Test("With no AU headers the payload is one unit")
  func noAUHeaders() {
    let depacketizer = AACDepacketizer(framing: framing)

    #expect(depacketizer.accessUnits(from: packet([ 0x00, 0x00, 0xAA, 0xBB ])) == [ Data([ 0xAA, 0xBB ]) ])
  }

  @Test("A payload too short to hold a header is refused")
  func emptyPayload() {
    let depacketizer = AACDepacketizer(framing: framing)

    #expect(depacketizer.accessUnits(from: packet([ 0x00 ])).isEmpty)
  }
}
