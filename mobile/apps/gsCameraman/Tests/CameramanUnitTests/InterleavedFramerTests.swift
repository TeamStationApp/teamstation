import CameramanRTSP
import Foundation
import DirectorRTSP
import Testing

/// Framing is checked against GS Producer's own `RTSPStreamParser` rather than against a second
/// reading of RFC 2326. If the two ever disagree, the client is the one that matters.
@Suite("Interleaved framing")
struct InterleavedFramerTests {
  @Test("A framed payload is what Producer's parser reads back")
  func roundTripThroughProducer() throws {
    let payload = Data([ 0x80, 0x60, 0x00, 0x01, 0xDE, 0xAD, 0xBE, 0xEF ])
    let framed = try #require(InterleavedFramer.frame(channel: InterleavedChannel.video, payload: payload))

    var parser = RTSPStreamParser()
    parser.append(framed)

    #expect(parser.next() == .interleaved(channel: 0, payload: payload))
    #expect(parser.next() == nil)
  }

  @Test("Several frames in one write are all recovered in order")
  func multipleFrames() {
    let first = Data([ 0x01, 0x02 ])
    let second = Data([ 0x03, 0x04, 0x05 ])
    let stream = InterleavedFramer.frames(channel: InterleavedChannel.audio, payloads: [ first, second ])

    var parser = RTSPStreamParser()
    parser.append(stream)

    #expect(parser.next() == .interleaved(channel: 2, payload: first))
    #expect(parser.next() == .interleaved(channel: 2, payload: second))
    #expect(parser.next() == nil)
  }

  @Test("A frame split across two writes is still recovered")
  func splitAcrossWrites() throws {
    // TCP will split a write anywhere, and a parser that assumes frame-aligned reads turns a video
    // packet into garbage exactly when the network is busiest.
    let payload = Data(repeating: 0x5A, count: 1400)
    let framed = try #require(InterleavedFramer.frame(channel: 0, payload: payload))

    var parser = RTSPStreamParser()
    parser.append(framed.prefix(700))
    #expect(parser.next() == nil)
    parser.append(framed.dropFirst(700))
    #expect(parser.next() == .interleaved(channel: 0, payload: payload))
  }

  @Test("The header is the four bytes RFC 2326 specifies")
  func headerLayout() throws {
    let framed = try #require(InterleavedFramer.frame(channel: 3, payload: Data([ 0xFF ])))
    #expect(Array(framed) == [ 0x24, 0x03, 0x00, 0x01, 0xFF ])
  }

  @Test("A length above 16 bits is refused rather than truncated")
  func oversizedPayloadIsRefused() {
    // The length field is 16 bits, so a larger payload would be silently framed as a short one and
    // desynchronise the whole connection.
    let payload = Data(repeating: 0, count: 0x1_0000)
    #expect(InterleavedFramer.frame(channel: 0, payload: payload) == nil)
  }

  @Test("The largest legal payload is accepted")
  func maximumPayload() throws {
    let payload = Data(repeating: 0, count: InterleavedFramer.maximumPayloadSize)
    let framed = try #require(InterleavedFramer.frame(channel: 0, payload: payload))
    #expect(Array(framed.prefix(4)) == [ 0x24, 0x00, 0xFF, 0xFF ])
  }

  @Test("An oversized payload in a batch is dropped without disturbing the rest")
  func batchSkipsOversized() {
    let good = Data([ 0x09 ])
    let stream = InterleavedFramer.frames(
      channel: 0,
      payloads: [ good, Data(repeating: 0, count: 0x1_0000), good ]
    )

    var parser = RTSPStreamParser()
    parser.append(stream)

    #expect(parser.next() == .interleaved(channel: 0, payload: good))
    #expect(parser.next() == .interleaved(channel: 0, payload: good))
    #expect(parser.next() == nil)
  }

  @Test("Channels match what Producer's SETUP asks for")
  func channelNumbering() {
    // Producer requests video on 0-1 and audio on 2-3; sending audio on 1 would deliver it into the
    // client's RTCP handler and it would never be heard.
    #expect(InterleavedChannel.video == 0)
    #expect(InterleavedChannel.videoControl == 1)
    #expect(InterleavedChannel.audio == 2)
    #expect(InterleavedChannel.audioControl == 3)
  }
}
