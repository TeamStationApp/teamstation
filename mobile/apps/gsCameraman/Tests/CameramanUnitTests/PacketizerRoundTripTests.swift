import CameramanCore
import CameramanRTSP
import Foundation
import DirectorRTSP
import Testing

/// Packetizes frames and puts the bytes back through GS Producer's own depacketizers.
///
/// Producer is the client this camera exists to feed, and it cannot be run from here. Compiling its
/// RTSP package into this test target is the closest thing to an end-to-end check that does not need
/// two devices: a packetization mistake shows up as Producer failing to reassemble, which is exactly
/// how it would show up in the field.
struct PacketizerRoundTripTests {
  private let ssrc: UInt32 = 0x1234_5678

  // MARK: - H.264

  @Test func h264SingleNALUnitSurvives() throws {
    let nal = nalUnit(header: 0x65, count: 200)
    let reassembled = try depacketizeH264([ nal ])
    #expect(reassembled == nal)
  }

  @Test func h264FragmentedNALUnitSurvives() throws {
    // Well over the payload limit, so it has to be split into several FU-A fragments.
    let nal = nalUnit(header: 0x65, count: 20_000)
    let packetizer = H264Packetizer()
    let payloads = packetizer.payloads(forNALUnit: nal)

    #expect(payloads.count > 10, "a 20 kB NAL must fragment")
    #expect(payloads.allSatisfy { $0.count <= packetizer.maximumPayloadCount })

    let reassembled = try depacketizeH264([ nal ])
    #expect(reassembled == nal, "\(payloads.count) fragments must rebuild the original exactly")
  }

  @Test func h264FragmentBoundariesAreExact() throws {
    // A NAL one byte over the limit is the case where an off-by-one produces two fragments whose
    // total is right and whose split is wrong.
    for count in [ 99, 100, 101, 102, 197, 198, 199, 200 ] {
      let nal = nalUnit(header: 0x65, count: count)
      let reassembled = try depacketizeH264([ nal ], maximumPayloadCount: 100)
      #expect(reassembled == nal, "NAL of \(count) bytes")
    }
  }

  @Test func h264ParameterSetsArriveAheadOfTheKeyframe() throws {
    let sps = nalUnit(header: 0x67, count: 20)
    let pps = nalUnit(header: 0x68, count: 8)
    let idr = nalUnit(header: 0x65, count: 5_000)

    let frame = EncodedVideoFrame(
      nalUnits: [ idr ],
      parameterSets: [ sps, pps ],
      isKeyframe: true,
      presentationTime: 0
    )

    let completed = try reassemble(
      payloads: H264Packetizer().payloads(for: frame),
      into: H264Depacketizer()
    )
    let accessUnit = try #require(completed)

    #expect(accessUnit.isKeyframe)
    #expect(!accessUnit.isCorrupt)
    #expect(accessUnit.parameterSets == [ sps, pps ], "in SPS-then-PPS order")
  }

  @Test func h264MarkerEndsThePicture() throws {
    let depacketizer = H264Depacketizer()
    let writer = RTPPacketWriter(payloadType: 96, ssrc: ssrc)
    let first = nalUnit(header: 0x65, count: 100)
    let second = nalUnit(header: 0x61, count: 100)

    // Two pictures at different timestamps. The first must complete on its marker bit, not linger
    // until the second one's data arrives.
    var completed: [VideoAccessUnit] = []
    for (index, item) in [ (0, first), (1, second) ] {
      let packet = writer.packet(
        sequenceNumber: UInt16(index),
        timestamp: UInt32(index) * 3_000,
        marker: true,
        payload: item
      )
      let parsed = try #require(RTPPacket.parse(packet))
      if let unit = depacketizer.append(parsed, sequenceIntact: true) { completed.append(unit) }
    }

    #expect(completed.count == 2)
    #expect(completed.first?.rtpTimestamp == 0)
    #expect(completed.last?.rtpTimestamp == 3_000)
  }

  @Test func h264DroppedFragmentIsReportedCorrupt() throws {
    let nal = nalUnit(header: 0x65, count: 20_000)
    let payloads = H264Packetizer().payloads(forNALUnit: nal)
    #expect(payloads.count > 3)

    let depacketizer = H264Depacketizer()
    let writer = RTPPacketWriter(payloadType: 96, ssrc: ssrc)
    var tracker = RTPSequenceTracker()
    var completed: VideoAccessUnit?

    // Skip a middle fragment and keep the sequence numbering honest about the gap, which is what a
    // real loss looks like.
    for (index, payload) in payloads.enumerated() where index != 2 {
      let packet = writer.packet(
        sequenceNumber: UInt16(index),
        timestamp: 9_000,
        marker: index == payloads.count - 1,
        payload: payload
      )
      let parsed = try #require(RTPPacket.parse(packet))
      let intact = tracker.observe(parsed.sequenceNumber)
      if let unit = depacketizer.append(parsed, sequenceIntact: intact) { completed = unit }
    }

    let unit = try #require(completed)
    #expect(unit.isCorrupt, "a lost fragment must not produce a frame that looks whole")
    #expect(tracker.lost == 1)
  }

  // MARK: - HEVC

  @Test func hevcSingleNALUnitSurvives() throws {
    let nal = hevcNALUnit(type: 19, count: 300)
    let reassembled = try depacketizeHEVC([ nal ])
    #expect(reassembled == nal)
  }

  @Test func hevcFragmentedNALUnitSurvives() throws {
    let nal = hevcNALUnit(type: 19, count: 30_000)
    let packetizer = HEVCPacketizer()
    let payloads = packetizer.payloads(forNALUnit: nal)

    #expect(payloads.count > 15)
    #expect(payloads.allSatisfy { $0.count <= packetizer.maximumPayloadCount })

    let reassembled = try depacketizeHEVC([ nal ])
    #expect(reassembled == nal)
  }

  @Test func hevcParameterSetsArriveInVPSSPSPPSOrder() throws {
    let vps = hevcNALUnit(type: 32, count: 24)
    let sps = hevcNALUnit(type: 33, count: 40)
    let pps = hevcNALUnit(type: 34, count: 10)
    let irap = hevcNALUnit(type: 19, count: 8_000)

    let frame = EncodedVideoFrame(
      nalUnits: [ irap ],
      parameterSets: [ vps, sps, pps ],
      isKeyframe: true,
      presentationTime: 0
    )

    let completed = try reassemble(
      payloads: HEVCPacketizer().payloads(for: frame),
      into: HEVCDepacketizer()
    )
    let accessUnit = try #require(completed)

    #expect(accessUnit.isKeyframe, "type 19 is in the IRAP range")
    #expect(!accessUnit.isCorrupt)
    #expect(accessUnit.parameterSets == [ vps, sps, pps ])
  }

  @Test func hevcFragmentPreservesTheLayerAndTemporalID() throws {
    // The second header byte carries the temporal id, and the fragment header must carry it through
    // untouched or the decoder reads the picture at the wrong temporal layer.
    var nal = hevcNALUnit(type: 19, count: 5_000)
    nal[nal.startIndex + 1] = 0x03
    let reassembled = try #require(try depacketizeHEVC([ nal ]))
    #expect(reassembled == nal)
    #expect(reassembled[reassembled.startIndex + 1] == 0x03)
  }

  // MARK: - AAC

  @Test func aacAccessUnitSurvives() throws {
    let unit = Data((0 ..< 400).map { UInt8($0 % 251) })
    let frame = EncodedAudioFrame(
      data: unit,
      presentationTime: 0,
      sampleRate: 48_000,
      channelCount: 1
    )

    let payload = try #require(AACPacketizer().payload(for: frame))
    let writer = RTPPacketWriter(payloadType: 97, ssrc: ssrc)
    let parsed = try #require(RTPPacket.parse(writer.packet(
      sequenceNumber: 0,
      timestamp: 0,
      marker: true,
      payload: payload
    )))

    let framing = AACFraming(
      sizeLength: AACPacketizer.sizeLength,
      indexLength: AACPacketizer.indexLength,
      indexDeltaLength: AACPacketizer.indexDeltaLength
    )
    #expect(AACDepacketizer(framing: framing).accessUnits(from: parsed) == [ unit ])
  }

  @Test func aacSizeFieldSurvivesItsBoundaries() throws {
    let framing = AACFraming(
      sizeLength: AACPacketizer.sizeLength,
      indexLength: AACPacketizer.indexLength,
      indexDeltaLength: AACPacketizer.indexDeltaLength
    )
    let writer = RTPPacketWriter(payloadType: 97, ssrc: ssrc)

    for count in [ 1, 255, 256, 1_024, 8_191 ] {
      let unit = Data(repeating: 0xA5, count: count)
      let frame = EncodedAudioFrame(
        data: unit,
        presentationTime: 0,
        sampleRate: 48_000,
        channelCount: 1
      )
      let payload = try #require(AACPacketizer().payload(for: frame), "\(count) bytes")
      let parsed = try #require(RTPPacket.parse(writer.packet(
        sequenceNumber: 0,
        timestamp: 0,
        marker: true,
        payload: payload
      )))
      #expect(AACDepacketizer(framing: framing).accessUnits(from: parsed) == [ unit ], "\(count) bytes")
    }
  }

  @Test func aacRejectsAnAccessUnitTooLargeForTheSizeField() {
    let frame = EncodedAudioFrame(
      data: Data(repeating: 0, count: 8_192),
      presentationTime: 0,
      sampleRate: 48_000,
      channelCount: 1
    )
    #expect(AACPacketizer().payload(for: frame) == nil)
  }

  @Test func aacTimestampAdvancesOneFramePerAccessUnit() {
    #expect(AACPacketizer.timestamp(forFrameIndex: 0) == 0)
    #expect(AACPacketizer.timestamp(forFrameIndex: 1) == 1_024)
    // Must wrap rather than trap, since the field is 32 bits and a long session will reach it.
    #expect(AACPacketizer.timestamp(forFrameIndex: 4_194_304) == 0)
  }

  // MARK: - RTP header

  @Test func rtpHeaderRoundTripsThroughProducersParser() throws {
    let writer = RTPPacketWriter(payloadType: 96, ssrc: 0xDEAD_BEEF)
    let payload = Data([ 0x65, 0x01, 0x02 ])
    let parsed = try #require(RTPPacket.parse(writer.packet(
      sequenceNumber: 65_535,
      timestamp: 0xFFFF_FFFF,
      marker: true,
      payload: payload
    )))

    #expect(parsed.payloadType == 96)
    #expect(parsed.sequenceNumber == 65_535)
    #expect(parsed.timestamp == 0xFFFF_FFFF)
    #expect(parsed.ssrc == 0xDEAD_BEEF)
    #expect(parsed.marker)
    #expect(parsed.payload == payload)
  }

  @Test func rtpMarkerBitIsAbsentWhenNotSet() throws {
    let writer = RTPPacketWriter(payloadType: 96, ssrc: 1)
    let parsed = try #require(RTPPacket.parse(writer.packet(
      sequenceNumber: 1,
      timestamp: 1,
      marker: false,
      payload: Data([ 0x01 ])
    )))
    #expect(!parsed.marker)
    #expect(parsed.payloadType == 96, "the payload type must not be corrupted by the marker bit")
  }

  // MARK: - Helpers

  /// A NAL unit whose body is a recognisable pattern, so a fragment reassembled in the wrong order
  /// fails rather than happening to match.
  private func nalUnit(header: UInt8, count: Int) -> Data {
    var data = Data([ header ])
    data.append(contentsOf: (0 ..< count).map { UInt8($0 % 253) })
    return data
  }

  private func hevcNALUnit(type: UInt8, count: Int) -> Data {
    var data = Data([ (type << 1) & 0x7E, 0x01 ])
    data.append(contentsOf: (0 ..< count).map { UInt8($0 % 253) })
    return data
  }

  private func depacketizeH264(
    _ units: [Data],
    maximumPayloadCount: Int = RTPLimits.defaultMaximumPayloadCount
  ) throws -> Data? {
    let packetizer = H264Packetizer(maximumPayloadCount: maximumPayloadCount)
    let payloads = units.flatMap { packetizer.payloads(forNALUnit: $0) }
    let completed = try reassemble(payloads: payloads, into: H264Depacketizer())
    return completed.flatMap { Self.nalUnits(fromAVCC: $0.data).first }
  }

  private func depacketizeHEVC(
    _ units: [Data],
    maximumPayloadCount: Int = RTPLimits.defaultMaximumPayloadCount
  ) throws -> Data? {
    let packetizer = HEVCPacketizer(maximumPayloadCount: maximumPayloadCount)
    let payloads = units.flatMap { packetizer.payloads(forNALUnit: $0) }
    let completed = try reassemble(payloads: payloads, into: HEVCDepacketizer())
    return completed.flatMap { Self.nalUnits(fromAVCC: $0.data).first }
  }

  /// Producer hands the decoder length-prefixed NALs rather than start codes, so the round trip has to
  /// undo that to compare against what went in. Parsing it here also means a wrong length prefix
  /// shows up as a failure rather than being skipped over.
  static func nalUnits(fromAVCC data: Data) -> [Data] {
    var units: [Data] = []
    var offset = data.startIndex
    while data.index(offset, offsetBy: 4, limitedBy: data.endIndex) != nil {
      let lengthEnd = data.index(offset, offsetBy: 4)
      let length = data[offset ..< lengthEnd].reduce(0) { Int($0) << 8 | Int($1) }
      guard let end = data.index(lengthEnd, offsetBy: length, limitedBy: data.endIndex) else { break }
      units.append(data[lengthEnd ..< end])
      offset = end
    }
    return units
  }

  private func reassemble(
    payloads: [Data],
    into depacketizer: some VideoDepacketizer
  ) throws -> VideoAccessUnit? {
    let writer = RTPPacketWriter(payloadType: 96, ssrc: ssrc)
    var result: VideoAccessUnit?
    for (index, payload) in payloads.enumerated() {
      let packet = writer.packet(
        sequenceNumber: UInt16(truncatingIfNeeded: index),
        timestamp: 9_000,
        marker: index == payloads.count - 1,
        payload: payload
      )
      let parsed = try #require(RTPPacket.parse(packet))
      if let unit = depacketizer.append(parsed, sequenceIntact: true) { result = unit }
    }
    return result
  }
}
