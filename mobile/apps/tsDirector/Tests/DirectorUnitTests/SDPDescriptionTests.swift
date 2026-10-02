import Foundation
import DirectorRTSP
import Testing

/// Driven by SDP captured verbatim from the cameras in use, because every assumption this project
/// made about their streams before capturing it was wrong in some detail.
@Suite("SDP description")
struct SDPDescriptionTests {
  /// The fixtures sit beside the test source rather than in a bundle: `#filePath` needs no
  /// resource-copying build phase and cannot go stale.
  private func fixture(_ name: String) throws -> String {
    let url = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .appendingPathComponent("Fixtures/\(name)")
    return try String(contentsOf: url, encoding: .utf8)
  }

  // MARK: - H.265 camera

  @Test("The H.265 camera's session description yields both tracks")
  func hevcTracks() throws {
    let sdp = SDPDescription.parse(try fixture("vm33-h265-describe.sdp"))

    #expect(sdp.sessionName == "Streamed by Hamedal Server/1.0(Jan 16 2026)")
    #expect(sdp.media.count == 2)
    #expect(sdp.video?.control == "trackID=0")
    #expect(sdp.audio?.control == "trackID=1")
  }

  @Test("Session-level control is not mistaken for a track")
  func sessionControlIsSeparate() throws {
    let sdp = SDPDescription.parse(try fixture("vm33-h265-describe.sdp"))

    // `a=control:*` appears before the first media line and would otherwise be read as the video
    // track's control URL, sending SETUP to the wrong place.
    #expect(sdp.sessionControl == "*")
    #expect(sdp.video?.control == "trackID=0")
  }

  @Test("H.265 is recognised and its three parameter sets come out in decoder order")
  func hevcParameterSets() throws {
    let video = try #require(SDPDescription.parse(try fixture("vm33-h265-describe.sdp")).video)

    #expect(video.videoCodec == .hevc)
    #expect(video.rtpMap?.payloadType == 96)
    #expect(video.rtpMap?.clockRate == 90_000)

    let sets = video.parameterSets
    #expect(sets.count == 3)
    // VPS, SPS then PPS, identified by their NAL types: (byte0 >> 1) & 0x3F.
    #expect(sets.map { ($0[$0.startIndex] >> 1) & 0x3F } == [ 32, 33, 34 ])
  }

  // MARK: - H.264 camera

  @Test("The H.264 camera is recognised as a different codec on the same fields")
  func h264ParameterSets() throws {
    let video = try #require(SDPDescription.parse(try fixture("vm33-h264-describe.sdp")).video)

    #expect(video.videoCodec == .h264)
    #expect(video.formatParameters["packetization-mode"] == "1")
    #expect(video.formatParameters["profile-level-id"] == "4DC01F")

    let sets = video.parameterSets
    #expect(sets.count == 2)
    // SPS then PPS, by NAL type byte0 & 0x1F.
    #expect(sets.map { $0[$0.startIndex] & 0x1F } == [ 7, 8 ])
  }

  @Test("A base64 parameter set containing padding is not cut short at the '='")
  func base64ValuesSurviveTheFmtpSplit() throws {
    let video = try #require(SDPDescription.parse(try fixture("vm33-h264-describe.sdp")).video)

    // The SPS ends in "==" and the pair separator is also "=", so a naive split loses the tail.
    #expect(video.formatParameters["sprop-parameter-sets"]?.hasSuffix("aM48gA==") == true)
  }

  // MARK: - Audio

  @Test("Audio is described as AAC-LC 32 kHz stereo on both cameras")
  func audioConfiguration() throws {
    for name in [ "vm33-h265-describe.sdp", "vm33-h264-describe.sdp" ] {
      let audio = try #require(SDPDescription.parse(try fixture(name)).audio)

      #expect(audio.rtpMap?.encodingName == "mpeg4-generic")
      #expect(audio.rtpMap?.clockRate == 32_000)
      #expect(audio.rtpMap?.channels == 2)

      let config = try #require(audio.audioSpecificConfig)
      let parsed = try #require(AudioSpecificConfig(config))
      #expect(parsed.objectType == 2)
      #expect(parsed.sampleRate == 32_000)
      #expect(parsed.channelCount == 2)
    }
  }

  @Test("AAC framing widths are read from the camera rather than assumed")
  func aacFraming() throws {
    let audio = try #require(SDPDescription.parse(try fixture("vm33-h265-describe.sdp")).audio)
    let framing = try #require(audio.aacFraming)

    #expect(framing.sizeLength == 13)
    #expect(framing.indexLength == 3)
    #expect(framing.indexDeltaLength == 3)
  }

  @Test("A description with no audio line is handled, not assumed away")
  func videoOnlyDescription() {
    let sdp = SDPDescription.parse("""
      v=0\r
      m=video 0 RTP/AVP 96\r
      a=rtpmap:96 H264/90000\r
      a=control:trackID=0\r

      """)

    #expect(sdp.audio == nil)
    #expect(sdp.video != nil)
  }

  // MARK: - Control URL resolution

  @Test("A relative track control joins the session base")
  func relativeControlResolves() {
    #expect(SDPDescription.absoluteControlURL(
      control: "trackID=0",
      base: "rtsp://10.10.7.148:554/live/mainstream/"
    ) == "rtsp://10.10.7.148:554/live/mainstream/trackID=0")

    // The camera's Content-Base ends in a slash; a base without one must still not concatenate
    // the path and the track into one word.
    #expect(SDPDescription.absoluteControlURL(
      control: "trackID=1",
      base: "rtsp://10.10.7.148:554/live/mainstream"
    ) == "rtsp://10.10.7.148:554/live/mainstream/trackID=1")
  }

  @Test("An absolute or wildcard control is used as given")
  func absoluteAndWildcardControl() {
    #expect(SDPDescription.absoluteControlURL(
      control: "rtsp://10.10.7.148:554/other/trackID=0",
      base: "rtsp://10.10.7.148:554/live/mainstream/"
    ) == "rtsp://10.10.7.148:554/other/trackID=0")

    #expect(SDPDescription.absoluteControlURL(
      control: "*",
      base: "rtsp://10.10.7.148:554/live/mainstream/"
    ) == "rtsp://10.10.7.148:554/live/mainstream/")
  }

  @Test("A rooted control replaces the path instead of extending it")
  func rootedControl() {
    #expect(SDPDescription.absoluteControlURL(
      control: "/live/mainstream/trackID=0",
      base: "rtsp://10.10.7.148:554/live/mainstream/"
    ) == "rtsp://10.10.7.148:554/live/mainstream/trackID=0")
  }

  @Test("RFC 5576 SSRC attributes yield the sender's CNAME and name")
  func ssrcAttributes() {
    let sdp = SDPDescription.parse("""
      v=0
      s=TS Cameraman
      m=video 0 RTP/AVP 96
      a=rtpmap:96 H265/90000
      a=ssrc:286331153 cname:3f2504e04f8911d3@ts-cameraman
      a=ssrc:286331153 name:Third Base
      """)

    #expect(sdp.streamCNAME == "3f2504e04f8911d3@ts-cameraman")
    #expect(sdp.streamName == "Third Base")
    #expect(sdp.video?.cname == "3f2504e04f8911d3@ts-cameraman")
    #expect(sdp.video?.name == "Third Base")
  }
}
