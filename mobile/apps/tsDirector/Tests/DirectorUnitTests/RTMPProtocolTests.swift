import Foundation
@testable import DirectorRTMP
import Testing

@Suite("RTMP URL")
struct RTMPURLTests {
  @Test("PeerTube live keys parse into app and stream")
  func peertubeLiveURL() throws {
    let url = try RTMPURL.parse(
      "rtmp://tube2.gamestation.co:1935/live/11111111-1111-4111-8111-111111111111"
    ).get()
    #expect(url.host == "tube2.gamestation.co")
    #expect(url.port == 1935)
    #expect(url.app == "live")
    #expect(url.stream == "11111111-1111-4111-8111-111111111111")
    #expect(url.tcURL == "rtmp://tube2.gamestation.co:1935/live")
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

  @Test("H.264 keeps classic FLV framing byte for byte")
  func h264StaysClassic() {
    let payload = Data([ 0, 0, 0, 2, 0x65, 0x88 ])
    #expect(FLVTag.videoFrame(codec: .h264, keyframe: true, payload: payload) == Data([ 0x17, 1, 0, 0, 0 ]) + payload)
    #expect(FLVTag.videoFrame(codec: .h264, keyframe: false, payload: payload) == Data([ 0x27, 1, 0, 0, 0 ]) + payload)
    let record = Data([ 1, 0x42, 0xC0, 0x1F ])
    #expect(FLVTag.videoSequenceHeader(codec: .h264, record: record) == Data([ 0x17, 0, 0, 0, 0 ]) + record)
  }
}

/// Enhanced RTMP v1 (veovera/enhanced-rtmp): `[IsExHeader:1][FrameType:3][PacketType:4]`, FourCC.
@Suite("Enhanced RTMP tags")
struct EnhancedRTMPTagTests {
  private let hvc1: [UInt8] = [ 0x68, 0x76, 0x63, 0x31 ]

  @Test("hvc1 is 0x68766331")
  func fourCC() {
    #expect(RTMPVideoCodec.hevc.fourCC == 0x6876_6331)
    #expect(RTMPVideoCodec.hevc.fourCCString == "hvc1")
    #expect(FLVTag.fourCC("hvc1") == 0x6876_6331)
    #expect(RTMPVideoCodec.hevc.metadataCodecID == 1_752_589_105)
    #expect(RTMPVideoCodec.h264.metadataCodecID == 7)
  }

  @Test("SequenceStart: ex header, keyframe, packet type 0, FourCC, then the record")
  func sequenceStart() {
    let record = Data([ 1, 2, 3 ])
    let tag = FLVTag.videoSequenceHeader(codec: .hevc, record: record)
    #expect(Array(tag) == [ 0x90 ] + hvc1 + [ 1, 2, 3 ])
    #expect(FLVTag.isVideoSequenceHeader(tag))
    #expect(FLVTag.isVideoKeyframe(tag))
  }

  @Test("CodedFrames carries a zero composition time; CodedFramesX leaves it out")
  func codedFrames() {
    let payload = Data([ 0, 0, 0, 1, 0x26 ])
    let key = FLVTag.videoFrame(codec: .hevc, keyframe: true, payload: payload)
    #expect(Array(key) == [ 0x91 ] + hvc1 + [ 0, 0, 0 ] + Array(payload))
    let inter = FLVTag.videoFrame(codec: .hevc, keyframe: false, payload: payload)
    #expect(Array(inter) == [ 0xA1 ] + hvc1 + [ 0, 0, 0 ] + Array(payload))
    let framesX = FLVTag.enhancedVideo(
      keyframe: false,
      packetType: .codedFramesX,
      fourCC: RTMPVideoCodec.hevc.fourCC,
      payload: payload
    )
    #expect(Array(framesX) == [ 0xA3 ] + hvc1 + Array(payload))
    let offset = FLVTag.enhancedVideo(
      keyframe: false,
      packetType: .codedFrames,
      fourCC: RTMPVideoCodec.hevc.fourCC,
      compositionTime: -2,
      payload: payload
    )
    #expect(Array(offset.prefix(8)) == [ 0xA1 ] + hvc1 + [ 0xFF, 0xFF, 0xFE ])
  }

  @Test("Keyframe and sequence-header checks read both framings")
  func classifiers() {
    let payload = Data([ 0, 0, 0, 1, 0x01 ])
    // An Enhanced tag's second byte is the FourCC's 'h', not a packet type, so a classic-only check
    // would have called every H.265 sequence header a coded frame and shed it over budget.
    #expect(!FLVTag.isVideoSequenceHeader(FLVTag.videoFrame(codec: .hevc, keyframe: true, payload: payload)))
    #expect(!FLVTag.isVideoKeyframe(FLVTag.videoFrame(codec: .hevc, keyframe: false, payload: payload)))
    #expect(FLVTag.isVideoKeyframe(FLVTag.videoFrame(codec: .hevc, keyframe: true, payload: payload)))
    #expect(FLVTag.isVideoSequenceHeader(FLVTag.video(keyframe: true, packetType: 0, payload: payload)))
    #expect(!FLVTag.isVideoSequenceHeader(FLVTag.video(keyframe: true, packetType: 1, payload: payload)))
    #expect(FLVTag.isVideoKeyframe(FLVTag.video(keyframe: true, packetType: 1, payload: payload)))
    #expect(!FLVTag.isVideoKeyframe(FLVTag.video(keyframe: false, packetType: 1, payload: payload)))
  }
}

/// Parameter sets and `hvcC` from VideoToolbox's hardware HEVC encoder (1920x1080, Main, realtime,
/// no reordering), captured on an M-series Mac on 2026-09-14.
@Suite("HEVC decoder configuration record")
struct HEVCDecoderConfigurationTests {
  static let vps = Data([
    0x40, 0x01, 0x0C, 0x01, 0xFF, 0xFF, 0x01, 0x60, 0x00, 0x00, 0x03, 0x00, 0xB0, 0x00, 0x00, 0x03,
    0x00, 0x00, 0x03, 0x00, 0x78, 0x17, 0x02, 0x40
  ])
  static let sps = Data([
    0x42, 0x01, 0x01, 0x01, 0x60, 0x00, 0x00, 0x03, 0x00, 0xB0, 0x00, 0x00, 0x03, 0x00, 0x00, 0x03,
    0x00, 0x78, 0xA0, 0x03, 0xC0, 0x80, 0x11, 0x07, 0xCB, 0x88, 0x17, 0xB9, 0x16, 0x45, 0x2F, 0xFC,
    0xB9, 0xFC, 0x4F, 0xE8, 0x80
  ])
  static let pps = Data([ 0x44, 0x01, 0xC0, 0x72, 0xF0, 0x53, 0x24 ])
  static let videoToolboxHVCC = Data([
    0x01, 0x01, 0x60, 0x00, 0x00, 0x00, 0xB0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x78, 0xF0, 0x00, 0xFC,
    0xFD, 0xF8, 0xF8, 0x00, 0x00, 0x0B, 0x03, 0xA0, 0x00, 0x01, 0x00, 0x18
  ] + Array(vps) + [ 0xA1, 0x00, 0x01, 0x00, 0x25 ] + Array(sps) + [ 0xA2, 0x00, 0x01, 0x00, 0x07 ] + Array(pps))

  @Test("Built from VPS, SPS and PPS it matches VideoToolbox's own hvcC")
  func matchesVideoToolbox() throws {
    let record = try #require(HEVCDecoderConfiguration.record(parameterSets: [ Self.vps, Self.sps, Self.pps ]))
    #expect(record.count == Self.videoToolboxHVCC.count)
    // Byte 21 is constantFrameRate / numTemporalLayers / temporalIdNested / lengthSizeMinusOne. The
    // SPS sets sps_temporal_id_nesting_flag, which VideoToolbox's atom leaves clear.
    #expect(record[21] == 0x0F)
    var expected = Self.videoToolboxHVCC
    expected[21] = 0x0F
    #expect(record == expected)
  }

  @Test("The header fields come out of the SPS: Main profile, level 4, 4:2:0, 8 bit")
  func headerFields() throws {
    let record = try #require(HEVCDecoderConfiguration.record(parameterSets: [ Self.pps, Self.sps, Self.vps ]))
    #expect(record[0] == 1)
    #expect(record[1] & 0x1F == 1)
    #expect(record[12] == 120)
    #expect(record[16] & 0x03 == 1)
    #expect(record[17] & 0x07 == 0)
    #expect(record[18] & 0x07 == 0)
    #expect(record[21] & 0x03 == 3)
    #expect(record[22] == 3)
    // Arrays in VPS, SPS, PPS order whatever order the sets were given in.
    #expect(record[23] == 0x80 | 32)
  }

  @Test("No record without all three parameter sets, or with an SPS that runs out")
  func incomplete() {
    #expect(HEVCDecoderConfiguration.record(parameterSets: [ Self.sps, Self.pps ]) == nil)
    #expect(HEVCDecoderConfiguration.record(parameterSets: [ Self.vps, Self.pps ]) == nil)
    #expect(HEVCDecoderConfiguration.record(parameterSets: [ Self.vps, Self.sps.prefix(8), Self.pps ]) == nil)
  }

  @Test("Emulation prevention bytes are dropped before the SPS is read")
  func emulationPrevention() {
    #expect(HEVCDecoderConfiguration.SPSInfo.rbsp([ 0x00, 0x00, 0x03, 0x01, 0x00, 0x00, 0x03, 0x00 ])
      == [ 0x00, 0x00, 0x01, 0x00, 0x00, 0x00 ])
  }
}

@Suite("RTMP codec announcement")
struct RTMPCodecAnnouncementTests {
  private let url = try! RTMPURL.parse("rtmp://example.test/live/key").get()

  @Test("connect names hvc1 in fourCcList for H.265")
  func connectHEVC() throws {
    let values = AMF0.decodeList(RTMPClient.connectPayload(url: url, codec: .hevc))
    #expect(values.first?.stringValue == "connect")
    let object = try #require(values.dropFirst(2).first?.objectValue)
    #expect(object["fourCcList"] == .strictArray([ .string("hvc1") ]))
    #expect(object["app"]?.stringValue == "live")
  }

  @Test("connect for H.264 is what it always was")
  func connectH264() throws {
    let values = AMF0.decodeList(RTMPClient.connectPayload(url: url, codec: .h264))
    let object = try #require(values.dropFirst(2).first?.objectValue)
    #expect(object["fourCcList"] == nil)
    #expect(object.keys.sorted() == [
      "app", "audioCodecs", "flashVer", "tcUrl", "type", "videoCodecs", "videoFunction"
    ])
  }

  @Test("onMetaData's videocodecid is the FourCC number for H.265 and 7 for H.264")
  func metadata() throws {
    for (codec, id) in [ (RTMPVideoCodec.hevc, 1_752_589_105.0), (.h264, 7) ] {
      let values = AMF0.decodeList(
        RTMPClient.metadataPayload(width: 1920, height: 1080, frameRate: 60, bitrate: 6_000_000, codec: codec)
      )
      #expect(values.map(\.stringValue).prefix(2) == [ "@setDataFrame", "onMetaData" ])
      let fields = try #require(values.dropFirst(2).first?.objectValue)
      #expect(fields["videocodecid"]?.numberValue == id)
      #expect(fields["framerate"]?.numberValue == 60)
    }
  }

  @Test("A strict array round-trips")
  func strictArray() {
    let value = AMF0.strictArray([ .string("hvc1"), .string("av01"), .number(3) ])
    #expect(AMF0.decodeList(value.encode()) == [ value ])
  }

  @Test("An early refusal of H.265 says so; H.264 and late hang-ups do not")
  func codecRefusal() {
    let closed = RTMPClientError.disconnected("server closed the socket")
    guard case let .disconnected(early) = RTMPClient.explainingCodecRefusal(closed, codec: .hevc, secondsLive: 1)
    else { Issue.record("expected a disconnect"); return }
    #expect(early.contains("H.265"))
    #expect(early.contains("H.264"))
    guard case let .rejected(refused) = RTMPClient.explainingCodecRefusal(
      .rejected("NetStream.Publish.Rejected"), codec: .hevc, secondsLive: nil
    ) else { Issue.record("expected a rejection"); return }
    #expect(refused.hasPrefix("NetStream.Publish.Rejected"))
    #expect(refused.contains("Enhanced RTMP"))
    #expect(RTMPClient.explainingCodecRefusal(closed, codec: .h264, secondsLive: 1) == closed)
    #expect(RTMPClient.explainingCodecRefusal(closed, codec: .hevc, secondsLive: 600) == closed)
    #expect(RTMPClient.explainingCodecRefusal(.timeout, codec: .hevc, secondsLive: nil) == .timeout)
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
