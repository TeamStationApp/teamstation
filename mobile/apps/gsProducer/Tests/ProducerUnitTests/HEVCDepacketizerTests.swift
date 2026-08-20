import Foundation
import ProducerRTSP
import Testing

/// Two of the three cameras are H.265, so these rules are as load-bearing as the H.264 ones. The
/// header is two bytes wide and the type sits in different bits, which is exactly the kind of
/// difference that produces a plausible-looking wrong picture if it is got wrong.
@Suite("HEVC depacketizer")
struct HEVCDepacketizerTests {
  private func nalLengths(in data: Data) -> [Int] {
    var lengths: [Int] = []
    var offset = data.startIndex
    while offset + 4 <= data.endIndex {
      let length = data[offset ..< offset + 4].reduce(0) { Int($0) << 8 | Int($1) }
      lengths.append(length)
      offset = data.index(offset, offsetBy: 4 + length)
    }
    return lengths
  }

  private func packet(
    _ payload: [UInt8],
    sequenceNumber: UInt16 = 1,
    timestamp: UInt32 = 3_000,
    marker: Bool = false
  ) -> RTPPacket {
    RTPPacket(
      payloadType: 96,
      sequenceNumber: sequenceNumber,
      timestamp: timestamp,
      ssrc: 1,
      marker: marker,
      payload: Data(payload)
    )
  }

  /// Type occupies bits 1–6 of the first byte, so a TRAIL_R slice (type 1) is 0x02.
  @Test("A picture in one packet completes on the marker bit")
  func singleNALUnit() throws {
    let depacketizer = HEVCDepacketizer()
    let unit = try #require(depacketizer.append(
      packet([ 0x02, 0x01, 0xAF, 0x1E ], marker: true),
      sequenceIntact: true
    ))

    #expect(nalLengths(in: unit.data) == [ 4 ])
    #expect(!unit.isKeyframe)
  }

  @Test("An IDR is recognised as a keyframe across the whole IRAP range")
  func irapRangeIsKeyframe() throws {
    // 19 is IDR_W_RADL: (19 << 1) == 0x26.
    let depacketizer = HEVCDepacketizer()
    let unit = try #require(depacketizer.append(
      packet([ 0x26, 0x01, 0xAF ], marker: true),
      sequenceIntact: true
    ))
    #expect(unit.isKeyframe)

    // 21 is CRA_NUT, the top of the range: (21 << 1) == 0x2A.
    let other = HEVCDepacketizer()
    let cra = try #require(other.append(packet([ 0x2A, 0x01, 0xAF ], marker: true), sequenceIntact: true))
    #expect(cra.isKeyframe)
  }

  @Test("VPS, SPS and PPS are lifted out of the sample data")
  func parameterSetsAreLiftedOut() throws {
    let depacketizer = HEVCDepacketizer()
    // 32, 33, 34 shifted left by one: 0x40, 0x42, 0x44.
    _ = depacketizer.append(packet([ 0x40, 0x01, 0x0C ], sequenceNumber: 1), sequenceIntact: true)
    _ = depacketizer.append(packet([ 0x42, 0x01, 0x01 ], sequenceNumber: 2), sequenceIntact: true)
    _ = depacketizer.append(packet([ 0x44, 0x01, 0xC0 ], sequenceNumber: 3), sequenceIntact: true)
    let unit = try #require(depacketizer.append(
      packet([ 0x26, 0x01, 0xAF ], sequenceNumber: 4, marker: true),
      sequenceIntact: true
    ))

    #expect(unit.parameterSets.map { ($0[$0.startIndex] >> 1) & 0x3F } == [ 32, 33, 34 ])
    #expect(nalLengths(in: unit.data) == [ 3 ])
  }

  @Test("An aggregation packet is split on its two-byte payload header, not H.264's one")
  func aggregationPacketIsSplit() throws {
    let depacketizer = HEVCDepacketizer()
    // Type 48 is 0x60, with a second header byte, then [size][NAL] pairs.
    let payload: [UInt8] = [
      0x60, 0x01,
      0x00, 0x03, 0x40, 0x01, 0x0C,
      0x00, 0x03, 0x42, 0x01, 0x01
    ]
    let unit = try #require(depacketizer.append(packet(payload, marker: true), sequenceIntact: true))

    #expect(unit.parameterSets.count == 2)
    #expect(unit.parameterSets.map { ($0[$0.startIndex] >> 1) & 0x3F } == [ 32, 33 ])
  }

  @Test("A fragmented picture is reassembled with its original two-byte header restored")
  func fragmentationUnitReassembly() throws {
    let depacketizer = HEVCDepacketizer()
    // Type 49 is 0x62; the third byte carries start/end and the real type (19, IDR_W_RADL).
    let start = depacketizer.append(
      packet([ 0x62, 0x01, 0x93, 0xAA, 0xAA ], sequenceNumber: 1),
      sequenceIntact: true
    )
    let middle = depacketizer.append(
      packet([ 0x62, 0x01, 0x13, 0xBB, 0xBB ], sequenceNumber: 2),
      sequenceIntact: true
    )
    #expect(start == nil)
    #expect(middle == nil)

    let unit = try #require(depacketizer.append(
      packet([ 0x62, 0x01, 0x53, 0xCC, 0xCC ], sequenceNumber: 3, marker: true),
      sequenceIntact: true
    ))

    // Two header bytes plus six payload bytes.
    #expect(nalLengths(in: unit.data) == [ 8 ])
    #expect(unit.data[unit.data.startIndex + 4] == 0x26)
    #expect(unit.data[unit.data.startIndex + 5] == 0x01)
    #expect(unit.isKeyframe)
  }

  @Test("A packet lost mid-picture marks it corrupt")
  func sequenceGapMarksTheUnitCorrupt() throws {
    let depacketizer = HEVCDepacketizer()
    _ = depacketizer.append(packet([ 0x62, 0x01, 0x93, 0xAA ], sequenceNumber: 1), sequenceIntact: true)
    let unit = try #require(depacketizer.append(
      packet([ 0x62, 0x01, 0x53, 0xCC ], sequenceNumber: 7, marker: true),
      sequenceIntact: false
    ))

    #expect(unit.isCorrupt)
  }

  @Test("PACI and the reserved types are counted rather than misread")
  func unsupportedTypesAreCounted() {
    let depacketizer = HEVCDepacketizer()
    // Type 50, PACI: (50 << 1) == 0x64.
    _ = depacketizer.append(packet([ 0x64, 0x01, 0xAA ], marker: true), sequenceIntact: true)

    #expect(depacketizer.unsupportedUnits == 1)
  }

  @Test("A one-byte payload cannot be a NAL and is refused")
  func tooShortForAnHEVCHeader() {
    let depacketizer = HEVCDepacketizer()
    let unit = depacketizer.append(packet([ 0x02 ], marker: true), sequenceIntact: true)

    #expect(unit == nil)
  }
}
