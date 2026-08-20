import Foundation
import ProducerRTSP
import Testing

@Suite("H.264 depacketizer")
struct H264DepacketizerTests {
  /// Length-prefixed NAL units, as VideoToolbox wants them.
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

  @Test("A picture in one packet completes on the marker bit")
  func singleNALUnit() throws {
    let depacketizer = H264Depacketizer()
    // Type 1: a non-IDR slice.
    let unit = try #require(depacketizer.append(packet([ 0x41, 0x9A, 0xBC ], marker: true), sequenceIntact: true))

    #expect(nalLengths(in: unit.data) == [ 3 ])
    #expect(!unit.isKeyframe)
    #expect(unit.rtpTimestamp == 3_000)
    #expect(!unit.isCorrupt)
  }

  @Test("A STAP-A aggregate is split back into the units it carried")
  func stapAIsSplit() throws {
    let depacketizer = H264Depacketizer()
    // STAP-A holding a 4-byte SPS and a 2-byte PPS.
    let payload: [UInt8] = [
      0x78,
      0x00, 0x04, 0x67, 0x42, 0xC0, 0x1F,
      0x00, 0x02, 0x68, 0xCE
    ]
    let unit = try #require(depacketizer.append(packet(payload, marker: true), sequenceIntact: true))

    // Both were parameter sets, so they are reported separately and the sample data is empty.
    #expect(unit.parameterSets.count == 2)
    #expect(unit.parameterSets.map { $0[$0.startIndex] & 0x1F } == [ 7, 8 ])
    #expect(nalLengths(in: unit.data).isEmpty)
  }

  @Test("Parameter sets are kept out of the sample data VideoToolbox decodes")
  func parameterSetsAreLiftedOut() throws {
    let depacketizer = H264Depacketizer()
    _ = depacketizer.append(packet([ 0x67, 0x42, 0xC0, 0x1F ], sequenceNumber: 1), sequenceIntact: true)
    _ = depacketizer.append(packet([ 0x68, 0xCE ], sequenceNumber: 2), sequenceIntact: true)
    let unit = try #require(depacketizer.append(
      packet([ 0x65, 0x88, 0x84 ], sequenceNumber: 3, marker: true),
      sequenceIntact: true
    ))

    #expect(unit.parameterSets.count == 2)
    #expect(nalLengths(in: unit.data) == [ 3 ])
    #expect(unit.isKeyframe)
  }

  @Test("A picture fragmented across three packets is reassembled into one NAL")
  func fuAReassembly() throws {
    let depacketizer = H264Depacketizer()
    // FU-A: indicator 0x7C, then start / middle / end of an IDR slice (type 5).
    let start = depacketizer.append(packet([ 0x7C, 0x85, 0xAA, 0xAA ], sequenceNumber: 1), sequenceIntact: true)
    let middle = depacketizer.append(packet([ 0x7C, 0x05, 0xBB, 0xBB ], sequenceNumber: 2), sequenceIntact: true)
    #expect(start == nil)
    #expect(middle == nil)

    let unit = try #require(depacketizer.append(
      packet([ 0x7C, 0x45, 0xCC, 0xCC ], sequenceNumber: 3, marker: true),
      sequenceIntact: true
    ))

    // One NAL: the rebuilt 1-byte header plus six payload bytes.
    #expect(nalLengths(in: unit.data) == [ 7 ])
    // Header rebuilt from the indicator's F/NRI bits and the fragment's type.
    #expect(unit.data[unit.data.startIndex + 4] == 0x65)
    #expect(unit.isKeyframe)
  }

  @Test("A packet lost mid-picture marks it corrupt rather than decoding into visible garbage")
  func sequenceGapMarksTheUnitCorrupt() throws {
    let depacketizer = H264Depacketizer()
    _ = depacketizer.append(packet([ 0x7C, 0x85, 0xAA ], sequenceNumber: 1), sequenceIntact: true)
    let unit = try #require(depacketizer.append(
      packet([ 0x7C, 0x45, 0xCC ], sequenceNumber: 5, marker: true),
      sequenceIntact: false
    ))

    #expect(unit.isCorrupt)
  }

  @Test("Joining mid-fragment yields no picture rather than a NAL with a guessed header")
  func fragmentWithoutAStartIsDropped() {
    let depacketizer = H264Depacketizer()
    // The loss itself is already counted by the sequence tracker; there is simply nothing here
    // worth handing to a decoder, and inventing a NAL header would decode into garbage.
    let unit = depacketizer.append(packet([ 0x7C, 0x45, 0xCC ], marker: true), sequenceIntact: true)

    #expect(unit == nil)
  }

  @Test("A timestamp change ends the previous picture even with no marker bit")
  func timestampChangeClosesTheUnit() throws {
    let depacketizer = H264Depacketizer()
    let pending = depacketizer.append(
      packet([ 0x41, 0x01 ], sequenceNumber: 1, timestamp: 3_000),
      sequenceIntact: true
    )
    #expect(pending == nil)

    let unit = try #require(depacketizer.append(
      packet([ 0x41, 0x02 ], sequenceNumber: 2, timestamp: 6_000),
      sequenceIntact: true
    ))
    #expect(unit.rtpTimestamp == 3_000)
  }

  @Test("Two pictures in sequence come out as two, each with its own timestamp")
  func consecutivePictures() throws {
    let depacketizer = H264Depacketizer()
    let first = try #require(depacketizer.append(
      packet([ 0x41, 0x01 ], sequenceNumber: 1, timestamp: 3_000, marker: true),
      sequenceIntact: true
    ))
    let second = try #require(depacketizer.append(
      packet([ 0x41, 0x02 ], sequenceNumber: 2, timestamp: 6_000, marker: true),
      sequenceIntact: true
    ))

    #expect(first.rtpTimestamp == 3_000)
    #expect(second.rtpTimestamp == 6_000)
  }

  @Test("A packetization mode no camera here uses is counted, not guessed at")
  func unsupportedTypesAreCounted() {
    let depacketizer = H264Depacketizer()
    // FU-B, type 29.
    _ = depacketizer.append(packet([ 0x7D, 0x85, 0xAA ], marker: true), sequenceIntact: true)

    #expect(depacketizer.unsupportedUnits == 1)
  }

  @Test("A STAP-A claiming more than it carries is dropped, not read past its end")
  func truncatedAggregateIsRejected() throws {
    let depacketizer = H264Depacketizer()
    let unit = depacketizer.append(
      packet([ 0x78, 0x00, 0xFF, 0x67, 0x42 ], marker: true),
      sequenceIntact: true
    )

    #expect(unit == nil)
  }
}
