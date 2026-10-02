import CameramanCore
import CameramanRTSP
import Foundation
import DirectorRTSP
import Testing

/// The request parser sees whatever the network hands it, which is not whole messages.
struct RTSPServerMessageTests {
  @Test func parsesARequestProducerWouldSend() throws {
    // Built with Producer's own writer, so the two halves are checked against each other rather than
    // against a hand-written string that might not match what it emits.
    var builder = RTSPRequestBuilder()
    let outgoing = builder.make(
      .describe,
      uri: "rtsp://10.0.0.1/live",
      headers: [ (name: "Accept", value: "application/sdp") ]
    )

    let (request, consumed) = try #require(RTSPServerRequest.parse(outgoing.wireFormat))

    #expect(request.method == "DESCRIBE")
    #expect(request.uri == "rtsp://10.0.0.1/live")
    #expect(request.cseq == "1")
    #expect(request.headers["accept"] == "application/sdp")
    #expect(request.headers["user-agent"] == "TS Director/1.0")
    #expect(consumed == outgoing.wireFormat.count)
  }

  @Test func returnsNilUntilTheHeaderBlockIsComplete() {
    let full = Data("OPTIONS rtsp://x/ RTSP/1.0\r\nCSeq: 1\r\n\r\n".utf8)

    // Every prefix short of the terminator must read as "not yet", never as an error and never as a
    // request with missing headers.
    for count in 1 ..< full.count {
      #expect(RTSPServerRequest.parse(full.prefix(count)) == nil, "prefix of \(count)")
    }
    #expect(RTSPServerRequest.parse(full) != nil)
  }

  @Test func waitsForTheWholeBodyBeforeReturning() throws {
    let head = "SET_PARAMETER rtsp://x/ RTSP/1.0\r\nCSeq: 3\r\nContent-Length: 10\r\n\r\n"
    #expect(RTSPServerRequest.parse(Data(head.utf8)) == nil, "headers alone are not a whole request")
    #expect(RTSPServerRequest.parse(Data((head + "12345").utf8)) == nil, "a partial body is not either")

    let (request, consumed) = try #require(RTSPServerRequest.parse(Data((head + "1234567890").utf8)))
    #expect(request.body == Data("1234567890".utf8))
    #expect(consumed == head.utf8.count + 10)
  }

  @Test func consumedCountLetsPipelinedRequestsBeDrained() throws {
    // A client may put several requests in one segment. A parser that reports the wrong consumed
    // count either loses the second request or reparses part of the first.
    let text = "OPTIONS rtsp://x/ RTSP/1.0\r\nCSeq: 1\r\n\r\nDESCRIBE rtsp://x/ RTSP/1.0\r\nCSeq: 2\r\n\r\n"
    var buffer = Data(text.utf8)
    var methods: [String] = []

    while let (request, consumed) = RTSPServerRequest.parse(buffer) {
      methods.append(request.method)
      buffer.removeFirst(consumed)
    }

    #expect(methods == [ "OPTIONS", "DESCRIBE" ])
    #expect(buffer.isEmpty)
  }

  @Test func headerNamesAreCaseInsensitive() throws {
    let text = "PLAY rtsp://x/ RTSP/1.0\r\ncseq: 4\r\nSESSION: ABC\r\nTrAnSpOrT: RTP/AVP/TCP\r\n\r\n"
    let (request, _) = try #require(RTSPServerRequest.parse(Data(text.utf8)))

    #expect(request.cseq == "4")
    #expect(request.session == "ABC")
    #expect(request.headers["transport"] == "RTP/AVP/TCP")
  }

  @Test func foldedHeaderValuesAreJoined() throws {
    let text = "SETUP rtsp://x/ RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;\r\n interleaved=0-1\r\n\r\n"
    let (request, _) = try #require(RTSPServerRequest.parse(Data(text.utf8)))

    #expect(request.headers["transport"] == "RTP/AVP/TCP;unicast; interleaved=0-1")
  }

  @Test func aMethodItDoesNotKnowStillParses() throws {
    // Answering 501 requires parsing the request first, so an unknown method must not fail to parse.
    let (request, _) = try #require(RTSPServerRequest.parse(
      Data("REDIRECT rtsp://x/ RTSP/1.0\r\nCSeq: 1\r\n\r\n".utf8)
    ))
    #expect(request.method == "REDIRECT")
  }

  @Test func responsesAreReadableByProducersParser() throws {
    let response = RTSPServerResponse(
      headers: [ (name: "CSeq", value: "5"), (name: "Session", value: "ABC;timeout=60") ],
      body: Data("v=0\r\n".utf8)
    )

    let (parsed, consumed) = try #require(RTSPResponse.parse(response.wireFormat))

    #expect(parsed.statusCode == 200)
    #expect(parsed.cseq == 5)
    #expect(parsed.session == "ABC")
    #expect(parsed.sessionTimeout == 60)
    #expect(parsed.bodyText == "v=0\r\n")
    #expect(consumed == response.wireFormat.count)
  }

  @Test func contentLengthIsWrittenOnlyWhenThereIsABody() {
    let empty = RTSPServerResponse(headers: [ (name: "CSeq", value: "1") ])
    let text = String(decoding: empty.wireFormat, as: UTF8.self)

    #expect(!text.contains("Content-Length"))
    #expect(text.hasSuffix("\r\n\r\n"), "the header block must still be terminated")
  }

  @Test func contentLengthCountsBytesNotCharacters() throws {
    // A multi-byte body with a character count in Content-Length leaves the client waiting for bytes
    // that never come, which presents as a hang rather than an error.
    let body = Data("s=Café ⚽\r\n".utf8)
    let response = RTSPServerResponse(headers: [ (name: "CSeq", value: "1") ], body: body)
    let (parsed, _) = try #require(RTSPResponse.parse(response.wireFormat))

    #expect(parsed.body == body)
    #expect(parsed.header("content-length") == String(body.count))
  }

  @Test func bonjourTXTCarriesTheLiveNameAndUUID() {
    let identity = DeviceIdentity(uuid: "c94df9ca-d7c2-468f-8529-97d01fba14e7", name: "handheld")
    // `control` tells a browsing client this build answers the parameter verbs.
    #expect(RTSPServer.bonjourTXT(identity: identity, path: "/live/mainstream") == [
      "uuid": "c94df9ca-d7c2-468f-8529-97d01fba14e7",
      "name": "handheld",
      "path": "/live/mainstream",
      "control": "params/1"
    ])
    #expect(
      RTSPServer.bonjourTXT(
        identity: identity,
        path: "/live/mainstream",
        ip: "10.10.7.219",
        port: 554
      ) == [
        "uuid": "c94df9ca-d7c2-468f-8529-97d01fba14e7",
        "name": "handheld",
        "path": "/live/mainstream",
        "control": "params/1",
        "ip": "10.10.7.219",
        "port": "554"
      ]
    )
  }

  @Test("Cellular is never advertised, even when it is the only address left")
  func preferredLANIPv4NeverOffersCellular() {
    #expect(RTSPServer.preferredLANIPv4(addresses: [("pdp_ip0", "48.146.19.16")]) == nil)
    #expect(RTSPServer.preferredLANIPv4(addresses: [("pdp_ip0", "10.44.2.9")]) == nil)
    #expect(RTSPServer.preferredLANIPv4(addresses: [("pdp_ip0", "48.146.19.16"), ("en0", "10.10.7.151")]) == "10.10.7.151")
    #expect(RTSPServer.preferredLANIPv4(addresses: [("en2", "100.64.3.3")]) == nil)
  }

  @Test func preferredLANIPv4SkipsLinkLocalAndPrefersWiFi() {
    #expect(
      RTSPServer.preferredLANIPv4(addresses: [
        (interface: "en2", ip: "169.254.1.1"),
        (interface: "en0", ip: "10.10.7.219"),
        (interface: "lo0", ip: "127.0.0.1")
      ]) == "10.10.7.219"
    )
    #expect(
      RTSPServer.preferredLANIPv4(addresses: [
        (interface: "en2", ip: "10.10.8.4"),
        (interface: "utun0", ip: "10.0.0.2")
      ]) == "10.10.8.4"
    )
    #expect(
      RTSPServer.preferredLANIPv4(addresses: [
        (interface: "en0", ip: "169.254.12.4"),
        (interface: "lo0", ip: "127.0.0.1")
      ]) == nil
    )
  }
}
