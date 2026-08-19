import CameramanRTSP
import Foundation
import ProducerRTSP
import Testing

/// Drives the responder through the method sequence a real client uses, and reads its answers back
/// with GS Producer's response parser.
struct RTSPResponderTests {
  private let sdp = "v=0\r\ns=Test\r\nm=video 0 RTP/AVP 96\r\na=control:trackID=0\r\n"

  private func responder(hasAudio: Bool = true) -> RTSPResponder {
    RTSPResponder(sessionIdentifier: "ABCD1234EF", sdp: sdp, hasAudio: hasAudio)
  }

  private func request(
    _ method: String,
    uri: String = "rtsp://10.0.0.1/live",
    cseq: String? = "1",
    headers: [String: String] = [:]
  ) -> RTSPServerRequest {
    var all = headers
    if let cseq { all["cseq"] = cseq }
    return RTSPServerRequest(method: method, uri: uri, headers: all)
  }

  /// Every response has to be readable by the client's parser, which is the one in Producer.
  private func parse(_ response: RTSPServerResponse) throws -> RTSPResponse {
    let parsed = RTSPResponse.parse(response.wireFormat)
    return try #require(parsed?.response)
  }

  @Test func optionsAdvertisesTheMethodsItImplements() throws {
    var responder = responder()
    let parsed = try parse(responder.respond(to: request("OPTIONS")).response)

    #expect(parsed.statusCode == 200)
    let publicHeader = try #require(parsed.header("public"))
    // A client picks its keepalive method from this list, so anything advertised must be handled.
    for method in [ "OPTIONS", "DESCRIBE", "SETUP", "PLAY", "TEARDOWN", "GET_PARAMETER" ] {
      #expect(publicHeader.contains(method), "\(method) is advertised but not handled")
    }
  }

  @Test func describeReturnsTheSDPWithAContentBase() throws {
    var responder = responder()
    let parsed = try parse(responder.respond(to: request("DESCRIBE")).response)

    #expect(parsed.statusCode == 200)
    #expect(parsed.header("content-type") == "application/sdp")
    #expect(parsed.bodyText == sdp)
    // Without a trailing slash the client resolves trackID=0 against the parent, dropping "live".
    #expect(parsed.header("content-base") == "rtsp://10.0.0.1/live/")
  }

  @Test func describeRefusesAFormatItCannotProduce() throws {
    var responder = responder()
    let outcome = responder.respond(to: request("DESCRIBE", headers: [ "accept": "application/mikey" ]))

    #expect(try parse(outcome.response).statusCode == 406)
  }

  @Test func cseqIsEchoedOnSuccessAndOnError() throws {
    var responder = responder()

    let success = try parse(responder.respond(to: request("OPTIONS", cseq: "17")).response)
    #expect(success.cseq == 17)

    // A client that cannot match an error to its request treats the session as desynchronised.
    let failure = try parse(responder.respond(to: request("FLY", cseq: "18")).response)
    #expect(failure.statusCode == 501)
    #expect(failure.cseq == 18)
  }

  @Test func setupAcceptsInterleavedTCPAndEchoesTheChannels() throws {
    var responder = responder()
    let outcome = responder.respond(to: request(
      "SETUP",
      uri: "rtsp://10.0.0.1/live/trackID=0",
      headers: [ "transport": "RTP/AVP/TCP;unicast;interleaved=0-1" ]
    ))
    let parsed = try parse(outcome.response)

    #expect(parsed.statusCode == 200)
    #expect(parsed.session == "ABCD1234EF")
    #expect(parsed.sessionTimeout == RTSPResponder.sessionTimeout)
    #expect(parsed.header("transport")?.contains("interleaved=0-1") == true)
    #expect(responder.state == .ready)
  }

  @Test func setupHonoursTheChannelNumbersTheClientChose() throws {
    // ffmpeg picks its own channel numbers and reads its own numbers back, so overriding them sends
    // media on channels it ignores.
    var responder = responder()
    let outcome = responder.respond(to: request(
      "SETUP",
      uri: "rtsp://10.0.0.1/live/trackID=0",
      headers: [ "transport": "RTP/AVP/TCP;unicast;interleaved=4-5" ]
    ))

    #expect(try parse(outcome.response).header("transport")?.contains("interleaved=4-5") == true)
    #expect(responder.videoSetup?.dataChannel == 4)
    #expect(responder.videoSetup?.controlChannel == 5)
  }

  @Test func setupRefusesUDPWithTheSpecificCode() throws {
    var responder = responder()
    let outcome = responder.respond(to: request(
      "SETUP",
      uri: "rtsp://10.0.0.1/live/trackID=0",
      headers: [ "transport": "RTP/AVP;unicast;client_port=8000-8001" ]
    ))

    // 461 tells the client to offer something else; a 400 or 500 makes it give up.
    #expect(try parse(outcome.response).statusCode == 461)
    #expect(responder.state == .initial)
  }

  @Test func setupOnAnUnknownTrackIsNotFound() throws {
    var responder = responder()
    let outcome = responder.respond(to: request(
      "SETUP",
      uri: "rtsp://10.0.0.1/live/trackID=9",
      headers: [ "transport": "RTP/AVP/TCP;unicast;interleaved=0-1" ]
    ))

    #expect(try parse(outcome.response).statusCode == 404)
  }

  @Test func audioTrackIsNotFoundWhenMuted() throws {
    var responder = responder(hasAudio: false)
    let outcome = responder.respond(to: request(
      "SETUP",
      uri: "rtsp://10.0.0.1/live/trackID=1",
      headers: [ "transport": "RTP/AVP/TCP;unicast;interleaved=2-3" ]
    ))

    #expect(try parse(outcome.response).statusCode == 404)
  }

  @Test func playBeforeSetupIsRejected() throws {
    var responder = responder()
    let outcome = responder.respond(to: request("PLAY"))

    #expect(try parse(outcome.response).statusCode == 455)
    #expect(outcome.effect == .none, "nothing must start streaming without a transport")
  }

  @Test func playAfterSetupStartsStreamingBothTracks() throws {
    var responder = responder()
    _ = responder.respond(to: request(
      "SETUP",
      uri: "rtsp://10.0.0.1/live/trackID=0",
      headers: [ "transport": "RTP/AVP/TCP;unicast;interleaved=0-1" ]
    ))
    _ = responder.respond(to: request(
      "SETUP",
      uri: "rtsp://10.0.0.1/live/trackID=1",
      headers: [ "transport": "RTP/AVP/TCP;unicast;interleaved=2-3" ]
    ))

    let outcome = responder.respond(to: request("PLAY"))
    let parsed = try parse(outcome.response)

    #expect(parsed.statusCode == 200)
    #expect(parsed.header("range") == "npt=now-")
    #expect(responder.state == .playing)

    let expectedVideo = RTSPResponder.Setup(track: .video, dataChannel: 0, controlChannel: 1)
    let expectedAudio = RTSPResponder.Setup(track: .audio, dataChannel: 2, controlChannel: 3)
    #expect(outcome.effect == .startStreaming(video: expectedVideo, audio: expectedAudio))
  }

  @Test func pauseStopsStreamingAndPlayResumesIt() throws {
    var responder = responder(hasAudio: false)
    _ = responder.respond(to: request(
      "SETUP",
      uri: "rtsp://10.0.0.1/live/trackID=0",
      headers: [ "transport": "RTP/AVP/TCP;unicast;interleaved=0-1" ]
    ))
    _ = responder.respond(to: request("PLAY"))

    let paused = responder.respond(to: request("PAUSE"))
    #expect(try parse(paused.response).statusCode == 200)
    #expect(paused.effect == .stopStreaming)
    #expect(responder.state == .ready)

    let resumed = responder.respond(to: request("PLAY"))
    #expect(responder.state == .playing)
    if case .startStreaming = resumed.effect {} else {
      Issue.record("PLAY after PAUSE must resume streaming, got \(resumed.effect)")
    }
  }

  @Test func teardownClosesTheConnectionAndForgetsTheSetup() throws {
    var responder = responder()
    _ = responder.respond(to: request(
      "SETUP",
      uri: "rtsp://10.0.0.1/live/trackID=0",
      headers: [ "transport": "RTP/AVP/TCP;unicast;interleaved=0-1" ]
    ))
    _ = responder.respond(to: request("PLAY"))

    let outcome = responder.respond(to: request("TEARDOWN"))
    #expect(try parse(outcome.response).statusCode == 200)
    #expect(outcome.effect == .close)
    #expect(responder.state == .initial)
    #expect(responder.videoSetup == nil)
  }

  @Test func anotherClientsSessionIdentifierCannotActOnThisSession() throws {
    var responder = responder()
    _ = responder.respond(to: request(
      "SETUP",
      uri: "rtsp://10.0.0.1/live/trackID=0",
      headers: [ "transport": "RTP/AVP/TCP;unicast;interleaved=0-1" ]
    ))

    let outcome = responder.respond(to: request("PLAY", headers: [ "session": "SOMEONEELSE" ]))
    #expect(try parse(outcome.response).statusCode == 454)
    #expect(responder.state == .ready, "the real session must be untouched")
  }

  @Test func theSessionIdentifierIsAcceptedWithATimeoutParameterAttached() throws {
    // Clients echo back what they were given, including `;timeout=60`.
    var responder = responder()
    _ = responder.respond(to: request(
      "SETUP",
      uri: "rtsp://10.0.0.1/live/trackID=0",
      headers: [ "transport": "RTP/AVP/TCP;unicast;interleaved=0-1" ]
    ))

    let outcome = responder.respond(to: request(
      "PLAY",
      headers: [ "session": "ABCD1234EF;timeout=60" ]
    ))
    #expect(try parse(outcome.response).statusCode == 200)
  }

  @Test func getParameterIsAKeepalive() throws {
    var responder = responder()
    let outcome = responder.respond(to: request("GET_PARAMETER"))

    #expect(try parse(outcome.response).statusCode == 200)
    #expect(outcome.effect == .none)
  }

  @Test func setupIsRejectedWhileAlreadyPlaying() throws {
    var responder = responder()
    _ = responder.respond(to: request(
      "SETUP",
      uri: "rtsp://10.0.0.1/live/trackID=0",
      headers: [ "transport": "RTP/AVP/TCP;unicast;interleaved=0-1" ]
    ))
    _ = responder.respond(to: request("PLAY"))

    let outcome = responder.respond(to: request(
      "SETUP",
      uri: "rtsp://10.0.0.1/live/trackID=1",
      headers: [ "transport": "RTP/AVP/TCP;unicast;interleaved=2-3" ]
    ))
    #expect(try parse(outcome.response).statusCode == 455)
  }

  @Test func generatedSessionIdentifiersAreLongAndDistinct() {
    let identifiers = (0 ..< 200).map { _ in RTSPResponder.generateSessionIdentifier() }

    #expect(Set(identifiers).count == identifiers.count)
    // RFC 2326 §3.4 requires at least eight octets.
    #expect(identifiers.allSatisfy { $0.count >= 8 })
  }
}
