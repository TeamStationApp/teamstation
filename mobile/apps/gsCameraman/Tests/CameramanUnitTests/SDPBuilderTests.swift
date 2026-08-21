import CameramanCore
import CameramanEncode
import CameramanRTSP
import Foundation
import DirectorRTSP
import Testing

/// Builds session descriptions and reads them back with GS Producer's parser.
///
/// An SDP that is subtly wrong produces a client that connects, negotiates, and shows nothing. Every
/// field here is checked through the parser that will actually consume it rather than by string
/// comparison, so a formatting change that stays parseable does not fail the test.
struct SDPBuilderTests {
  private let identity = DeviceIdentity(
    uuid: "3c8ea5d7-1111-4222-8333-444455556666",
    name: "Sideline Left"
  )

  private func builder(
    codec: StreamCodec = .h264,
    parameterSets: [Data]? = nil,
    audio: SDPBuilder.AudioTrack? = .init(
      audioSpecificConfig: Data([ 0x11, 0x88 ]),
      sampleRate: 48_000,
      channelCount: 1
    )
  ) -> SDPBuilder {
    let sets = parameterSets ?? (codec == .h264
      ? [ Self.realSPS, Self.realPPS ]
      : [ Data([ 0x40, 0x01, 0x0C ]), Data([ 0x42, 0x01, 0x01 ]), Data([ 0x44, 0x01, 0xC0 ]) ])

    return SDPBuilder(
      identity: identity,
      video: SDPBuilder.VideoTrack(
        codec: codec,
        parameterSets: sets,
        width: 1_920,
        height: 1_080
      ),
      audio: audio,
      videoSSRC: 0x1111_1111,
      audioSSRC: 0x2222_2222
    )
  }

  @Test func h264ParameterSetsSurviveTheRoundTrip() {
    let parsed = SDPDescription.parse(builder().build())
    let video = parsed.video

    #expect(video?.videoCodec == .h264)
    #expect(video?.rtpMap?.clockRate == 90_000)
    #expect(video?.parameterSets == [ Self.realSPS, Self.realPPS ], "SPS first, then PPS")
    #expect(video?.formatParameters["packetization-mode"] == "1")
  }

  @Test func hevcParameterSetsSurviveInVPSSPSPPSOrder() {
    let vps = Data([ 0x40, 0x01, 0x0C ])
    let sps = Data([ 0x42, 0x01, 0x01 ])
    let pps = Data([ 0x44, 0x01, 0xC0 ])
    let parsed = SDPDescription.parse(builder(codec: .hevc).build())

    #expect(parsed.video?.videoCodec == .hevc, "H265 must be recognised as HEVC")
    #expect(parsed.video?.parameterSets == [ vps, sps, pps ])
  }

  @Test func audioConfigAndFramingSurviveTheRoundTrip() {
    let parsed = SDPDescription.parse(builder().build())
    let audio = parsed.audio

    #expect(audio?.rtpMap?.encodingName.lowercased() == "mpeg4-generic")
    #expect(audio?.rtpMap?.clockRate == 48_000)
    #expect(audio?.rtpMap?.channels == 1)
    #expect(audio?.audioSpecificConfig == Data([ 0x11, 0x88 ]))

    // The declared widths must match what the packetizer actually writes, or every size after the
    // first is read at the wrong bit offset.
    #expect(audio?.aacFraming?.sizeLength == AACPacketizer.sizeLength)
    #expect(audio?.aacFraming?.indexLength == AACPacketizer.indexLength)
    #expect(audio?.aacFraming?.indexDeltaLength == AACPacketizer.indexDeltaLength)
  }

  @Test func theConfigDescribesTheRateItIsSentAt() throws {
    // A config that decodes to the wrong sample rate is the classic half-speed-audio bug, and the
    // rtpmap agreeing with it is not enough — the bits have to say the same thing.
    let config = try #require(AudioSpecificConfigBuilder.aacLC(sampleRate: 48_000, channelCount: 1))
    let sdp = builder(audio: .init(
      audioSpecificConfig: config,
      sampleRate: 48_000,
      channelCount: 1
    )).build()

    let parsed = SDPDescription.parse(sdp)
    let decoded = try #require(parsed.audio?.audioSpecificConfig.flatMap(AudioSpecificConfig.init))

    #expect(decoded.sampleRate == 48_000)
    #expect(decoded.channelCount == 1)
    #expect(decoded.objectType == AudioSpecificConfigBuilder.aacLCObjectType)
  }

  @Test func tracksAreSeparatelyControllable() {
    let parsed = SDPDescription.parse(builder().build())

    #expect(parsed.sessionControl == "*")
    #expect(parsed.video?.control == SDPBuilder.videoTrackControl)
    #expect(parsed.audio?.control == SDPBuilder.audioTrackControl)

    // The client resolves these against the DESCRIBE URL, so a relative control that resolves wrong
    // produces a SETUP the server answers with 404.
    let base = "rtsp://192.168.1.50:554/live"
    #expect(SDPDescription.absoluteControlURL(control: parsed.video?.control, base: base)
      == "rtsp://192.168.1.50:554/live/trackID=0")
    #expect(SDPDescription.absoluteControlURL(control: parsed.audio?.control, base: base)
      == "rtsp://192.168.1.50:554/live/trackID=1")
  }

  @Test func theIdentityTravelsAsSessionNameAndCNAME() {
    let sdp = builder().build()
    let parsed = SDPDescription.parse(sdp)

    #expect(parsed.sessionName == "Sideline Left")
    // RFC 5576 §6.1. The same string the RTCP SDES CNAME carries.
    #expect(sdp.contains("a=ssrc:286331153 cname:\(identity.cname)"))
    #expect(sdp.contains("a=ssrc:572662306 cname:\(identity.cname)"))
  }

  @Test func audioIsOmittedEntirelyWhenMuted() {
    let parsed = SDPDescription.parse(builder(audio: nil).build())

    #expect(parsed.audio == nil, "a muted camera must not advertise a track it will not send")
    #expect(parsed.video != nil)
  }

  @Test func linesAreCRLFTerminated() {
    let sdp = builder().build()

    #expect(sdp.hasSuffix("\r\n"))
    #expect(!sdp.contains("\n\n"))
    // Every LF must be preceded by a CR. ffmpeg and VLC both want it, whatever the parser tolerates.
    let characters = Array(sdp)
    for (index, character) in characters.enumerated() where character == "\n" {
      #expect(index > 0 && characters[index - 1] == "\r", "bare LF at \(index)")
    }
  }

  @Test func theProfileLevelIDAgreesWithTheSPS() {
    let parsed = SDPDescription.parse(builder().build())
    let declared = parsed.video?.formatParameters["profile-level-id"]

    // The real SPS below is High profile (100) at level 4.0 (40), so the hex triplet is 640028.
    #expect(declared?.lowercased() == "640028")
  }

  @Test func theSDPStartsWithAProtocolVersion() {
    // RFC 4566 requires v=0 as the very first line, and some clients reject anything else outright.
    #expect(builder().build().hasPrefix("v=0\r\n"))
  }

  /// Captured from the H.264 encoder on the iPhone 13 Pro at 1080p, so the profile-level-id under
  /// test is derived from bits a real decoder accepted.
  private static let realSPS = Data([
    0x67, 0x64, 0x00, 0x28, 0xAC, 0xD9, 0x40, 0x78,
    0x02, 0x27, 0xE5, 0x84, 0x00, 0x00, 0x03, 0x00,
    0x04, 0x00, 0x00, 0x03, 0x00, 0xCA, 0x3C, 0x60,
    0xC6, 0x58
  ])
  private static let realPPS = Data([ 0x68, 0xEB, 0xE3, 0xCB, 0x22, 0xC0 ])
}
