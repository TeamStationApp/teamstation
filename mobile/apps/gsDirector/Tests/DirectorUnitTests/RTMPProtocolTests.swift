import Foundation
import DirectorRTMP
import Testing

@Suite("RTMP URL")
struct RTMPURLTests {
  @Test("PeerTube live keys parse into app and stream")
  func peertubeLiveURL() throws {
    let url = try RTMPURL.parse(
      "rtmp://tube.gamestation.co:1935/live/11111111-1111-4111-8111-111111111111"
    ).get()
    #expect(url.host == "tube.gamestation.co")
    #expect(url.port == 1935)
    #expect(url.app == "live")
    #expect(url.stream == "11111111-1111-4111-8111-111111111111")
    #expect(url.tcURL == "rtmp://tube.gamestation.co:1935/live")
  }

  @Test("Default port is 1935")
  func defaultPort() throws {
    let url = try RTMPURL.parse("rtmp://example.test/live/key").get()
    #expect(url.port == 1935)
  }

  @Test("Empty, rtmps and missing pieces each have their own error")
  func parseErrors() {
    #expect(RTMPURL.parse("  ").error == .empty)
    #expect(RTMPURL.parse("rtmps://host/live/key").error == .rtmpsUnsupported)
    #expect(RTMPURL.parse("https://host/live/key").error == .notRTMP)
    #expect(RTMPURL.parse("rtmp://host").error == .missingApp)
    #expect(RTMPURL.parse("rtmp://host/live").error == .missingStream)
  }
}

private extension Result {
  var error: Failure? {
    if case let .failure(error) = self { return error }
    return nil
  }
}

@Suite("AMF0")
struct AMF0Tests {
  @Test("A connect command round-trips")
  func connectRoundTrip() {
    let encoded = AMF0.encode([
      .string("connect"),
      .number(1),
      .object([ "app": .string("live"), "tcUrl": .string("rtmp://h/live") ])
    ])
    let values = AMF0.decodeList(encoded)
    #expect(values.count == 3)
    #expect(values[0].stringValue == "connect")
    #expect(values[1].numberValue == 1)
    #expect(values[2].objectValue?["app"]?.stringValue == "live")
  }

  @Test("Null and boolean survive the wire")
  func nullAndBool() {
    let values = AMF0.decodeList(AMF0.encode([ .null, .boolean(true) ]))
    #expect(values == [ .null, .boolean(true) ])
  }
}

@Suite("RTMP handshake and chunks")
struct RTMPWireTests {
  @Test("C0C1 is version 3 and 1537 bytes")
  func c0c1Size() {
    let packet = RTMPHandshake.c0c1(time: 1)
    #expect(packet.count == 1 + RTMPHandshake.packetSize)
    #expect(packet[0] == 3)
  }

  @Test("S0 plus S1 is not yet a full hello")
  func splitHelloNeedsS2() {
    var hello = Data([ 0x03 ])
    hello.append(Data(count: RTMPHandshake.packetSize))
    #expect(RTMPHandshake.splitServerHello(hello) == nil)
    hello.append(Data(count: RTMPHandshake.packetSize))
    let parts = RTMPHandshake.splitServerHello(hello)
    #expect(parts?.s0 == 3)
    #expect(parts?.s1.count == RTMPHandshake.packetSize)
    #expect(parts?.s2.count == RTMPHandshake.packetSize)
  }

  @Test("A fmt-0 command message round-trips through the chunk reader")
  func chunkRoundTrip() {
    let payload = AMF0.encode([ .string("createStream"), .number(2), .null ])
    let message = RTMPMessage(streamID: 0, type: .amf0Command, timestamp: 0, payload: payload)
    let wire = RTMPChunk.encode(message, chunkStreamID: 3, chunkSize: 128)
    let reader = RTMPChunkReader()
    let decoded = reader.push(wire)
    #expect(decoded.count == 1)
    #expect(decoded[0].type == .amf0Command)
    #expect(decoded[0].payload == payload)
  }

  @Test("Payloads larger than the chunk size reassemble")
  func splitChunks() {
    let payload = Data(repeating: 0xAB, count: 300)
    let message = RTMPMessage(streamID: 1, type: .video, timestamp: 40, payload: payload)
    let wire = RTMPChunk.encode(message, chunkStreamID: 9, chunkSize: 128)
    let decoded = RTMPChunkReader().push(wire)
    #expect(decoded.count == 1)
    #expect(decoded[0].payload.count == 300)
    #expect(decoded[0].timestamp == 40)
  }

  @Test("Inbound setChunkSize applies before the next message in the same packet")
  func setChunkSizeBeforeFollowingMessage() {
    var size = UInt32(4096).bigEndian
    let sizeBytes = withUnsafeBytes(of: &size) { Data($0) }
    let control = RTMPChunk.encode(
      RTMPMessage(streamID: 0, type: .setChunkSize, timestamp: 0, payload: sizeBytes),
      chunkStreamID: 2,
      chunkSize: 128
    )
    let payload = AMF0.encode([ .string("_result"), .number(1), .null ])
      + Data(repeating: 0x02, count: 80)
    let command = RTMPChunk.encode(
      RTMPMessage(streamID: 0, type: .amf0Command, timestamp: 0, payload: payload),
      chunkStreamID: 3,
      chunkSize: 4096
    )
    let decoded = RTMPChunkReader().push(control + command)
    #expect(decoded.count == 2)
    #expect(decoded[0].type == .setChunkSize)
    #expect(decoded[1].type == .amf0Command)
    #expect(decoded[1].payload == payload)
  }
}

@Suite("FLV tags")
struct FLVTagTests {
  @Test("A keyframe AVC NALU is framed as codec 7 packet type 1")
  func keyframeNALU() {
    let tag = FLVTag.video(keyframe: true, packetType: 1, payload: Data([ 0, 0, 0, 1, 0x65 ]))
    #expect(tag[0] == 0x17)
    #expect(tag[1] == 1)
  }

  @Test("AAC stereo uses 0xAF")
  func aacHeader() {
    let tag = FLVTag.audio(packetType: 1, payload: Data([ 0x21 ]))
    #expect(tag[0] == 0xAF)
    #expect(tag[1] == 1)
  }

  @Test("The AVC record carries SPS and PPS lengths")
  func avcRecord() {
    let sps = Data([ 0x67, 0x64, 0x00, 0x1F, 0x01 ])
    let pps = Data([ 0x68, 0xEE ])
    let record = FLVTag.avcDecoderConfigurationRecord(sps: sps, pps: pps)
    #expect(record[0] == 1)
    #expect(record[1] == 0x64)
  }
}

@Suite("Stream metrics and error gate")
struct StreamMetricsTests {
  @Test("4.234 Mbps rounds to the hundredth")
  func rounding() {
    // 4.234 Mbps over 1s is 4.234e6 / 8 = 529250 bytes.
    #expect(StreamMetrics.megabits(bytes: 529_250, windowSeconds: 1) == 4.23)
  }

  @Test("The same error is shown once per session")
  func errorGate() {
    var gate = StreamErrorGate()
    #expect(gate.shouldPresent("could not connect") == true)
    #expect(gate.shouldPresent("could not connect") == false)
    #expect(gate.shouldPresent("stream disconnected") == true)
    gate.reset()
    #expect(gate.shouldPresent("could not connect") == true)
  }
}
