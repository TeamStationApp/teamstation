import CameramanEncode
import Foundation
import Testing

@Suite("NAL unit conversion")
struct NALUnitConversionTests {
  private let sps = Data([ 0x67, 0x64, 0x00, 0x1F ])
  private let pps = Data([ 0x68, 0xEE, 0x3C, 0x80 ])
  private let slice = Data([ 0x65, 0x88, 0x84, 0x00, 0x21 ])

  @Test("A length-prefixed buffer splits into its units")
  func splitsAVCC() {
    let buffer = NALUnitConversion.avcc(fromElementaryUnits: [ sps, pps, slice ])
    #expect(NALUnitConversion.elementaryUnits(fromAVCC: buffer) == [ sps, pps, slice ])
  }

  @Test("Round-tripping any unit list returns it unchanged")
  func roundTrip() {
    let units = [ Data([ 0x41, 0x9A ]), Data(repeating: 0xAB, count: 3000), Data([ 0x01 ]) ]
    let buffer = NALUnitConversion.avcc(fromElementaryUnits: units)
    #expect(NALUnitConversion.elementaryUnits(fromAVCC: buffer) == units)
  }

  @Test("A truncated buffer is rejected rather than partly decoded")
  func truncatedBufferIsRejected() {
    // A unit whose declared length runs past the end would decode into visible corruption, so it is
    // better dropped than sent.
    var buffer = NALUnitConversion.avcc(fromElementaryUnits: [ slice ])
    buffer.removeLast(2)
    #expect(NALUnitConversion.elementaryUnits(fromAVCC: buffer) == nil)
  }

  @Test("A truncated length field is rejected")
  func truncatedLengthIsRejected() {
    #expect(NALUnitConversion.elementaryUnits(fromAVCC: Data([ 0x00, 0x00 ])) == nil)
  }

  @Test("A zero-length unit is rejected")
  func zeroLengthIsRejected() {
    #expect(NALUnitConversion.elementaryUnits(fromAVCC: Data([ 0, 0, 0, 0 ])) == nil)
  }

  @Test("An empty buffer yields no units and is not an error")
  func emptyBuffer() {
    #expect(NALUnitConversion.elementaryUnits(fromAVCC: Data()) == [])
  }

  @Test("A non-default length size is honoured in both directions")
  func alternateLengthSize() {
    // VideoToolbox declares the length size per format; assuming 4 would misread a 2-byte stream.
    let buffer = NALUnitConversion.avcc(fromElementaryUnits: [ sps, pps ], lengthSize: 2)
    #expect(buffer.count == sps.count + pps.count + 4)
    #expect(NALUnitConversion.elementaryUnits(fromAVCC: buffer, lengthSize: 2) == [ sps, pps ])
  }

  @Test("An impossible length size is refused")
  func invalidLengthSize() {
    let buffer = NALUnitConversion.avcc(fromElementaryUnits: [ sps ])
    #expect(NALUnitConversion.elementaryUnits(fromAVCC: buffer, lengthSize: 0) == nil)
    #expect(NALUnitConversion.elementaryUnits(fromAVCC: buffer, lengthSize: 5) == nil)
  }

  @Test("Annex-B output carries a start code before every unit")
  func annexB() {
    let stream = NALUnitConversion.annexB(fromElementaryUnits: [ sps, slice ])
    #expect(stream.prefix(4) == Data([ 0x00, 0x00, 0x00, 0x01 ]))
    #expect(stream.count == 8 + sps.count + slice.count)
  }
}
