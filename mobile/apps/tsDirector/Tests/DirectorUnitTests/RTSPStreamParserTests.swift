import Foundation
import DirectorRTSP
import Testing

/// Media and control share one socket in interleaved mode, so this split is what stops a keepalive
/// reply from being decoded as part of a video frame.
@Suite("RTSP stream parser")
struct RTSPStreamParserTests {
  private func interleaved(channel: UInt8, payload: [UInt8]) -> Data {
    Data([ 0x24, channel, UInt8(payload.count >> 8), UInt8(payload.count & 0xFF) ] + payload)
  }

  @Test("An interleaved packet comes out with its channel")
  func singleInterleavedPacket() {
    var parser = RTSPStreamParser()
    parser.append(interleaved(channel: 0, payload: [ 0xAA, 0xBB ]))

    #expect(parser.next() == .interleaved(channel: 0, payload: Data([ 0xAA, 0xBB ])))
    #expect(parser.next() == nil)
  }

  @Test("Packets arriving in one read are all returned")
  func backToBackPackets() {
    var parser = RTSPStreamParser()
    var data = interleaved(channel: 0, payload: [ 0x01 ])
    data.append(interleaved(channel: 1, payload: [ 0x02, 0x03 ]))
    parser.append(data)

    #expect(parser.next() == .interleaved(channel: 0, payload: Data([ 0x01 ])))
    #expect(parser.next() == .interleaved(channel: 1, payload: Data([ 0x02, 0x03 ])))
  }

  @Test("A packet split across two reads waits for the rest instead of being truncated")
  func packetSplitAcrossReads() {
    var parser = RTSPStreamParser()
    let whole = interleaved(channel: 2, payload: [ 0x01, 0x02, 0x03, 0x04 ])
    parser.append(whole.prefix(5))

    #expect(parser.next() == nil)

    parser.append(whole.dropFirst(5))
    #expect(parser.next() == .interleaved(channel: 2, payload: Data([ 0x01, 0x02, 0x03, 0x04 ])))
  }

  @Test("A response sitting between two media packets is recognised as a response")
  func responseBetweenPackets() throws {
    var parser = RTSPStreamParser()
    var data = interleaved(channel: 0, payload: [ 0xAA ])
    data.append(Data("RTSP/1.0 200 OK\r\nCSeq: 4\r\n\r\n".utf8))
    data.append(interleaved(channel: 0, payload: [ 0xBB ]))
    parser.append(data)

    #expect(parser.next() == .interleaved(channel: 0, payload: Data([ 0xAA ])))
    guard case let .response(response)? = parser.next() else {
      Issue.record("expected a response between the two packets")
      return
    }
    #expect(response.cseq == 4)
    #expect(parser.next() == .interleaved(channel: 0, payload: Data([ 0xBB ])))
  }

  @Test("A stray byte costs one packet, not the whole session")
  func resynchronisesAfterGarbage() {
    var parser = RTSPStreamParser()
    var data = Data([ 0x99 ])
    data.append(interleaved(channel: 0, payload: [ 0xAA ]))
    parser.append(data)

    #expect(parser.next() == .interleaved(channel: 0, payload: Data([ 0xAA ])))
  }

  @Test("A zero-length packet is still consumed, so the stream keeps moving")
  func emptyPacketDoesNotStall() {
    var parser = RTSPStreamParser()
    var data = interleaved(channel: 1, payload: [])
    data.append(interleaved(channel: 0, payload: [ 0xAA ]))
    parser.append(data)

    #expect(parser.next() == .interleaved(channel: 1, payload: Data()))
    #expect(parser.next() == .interleaved(channel: 0, payload: Data([ 0xAA ])))
  }
}
