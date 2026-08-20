import Foundation
import ProducerRTSP
import Testing

@Suite("RTSP messages")
struct RTSPMessageTests {
  @Test("A request goes on the wire with CRLF endings and its own CSeq")
  func requestWireFormat() {
    var builder = RTSPRequestBuilder(userAgent: "GS Producer/1.0")
    let request = builder.make(.describe, uri: "rtsp://10.10.7.148:554/live/mainstream", headers: [
      (name: "Accept", value: "application/sdp")
    ])

    let text = String(decoding: request.wireFormat, as: UTF8.self)
    #expect(text == """
      DESCRIBE rtsp://10.10.7.148:554/live/mainstream RTSP/1.0\r
      CSeq: 1\r
      User-Agent: GS Producer/1.0\r
      Accept: application/sdp\r
      \r

      """)
  }

  @Test("CSeq advances on every request, since a repeat desynchronises the session for good")
  func cseqIncrements() {
    var builder = RTSPRequestBuilder()
    #expect(builder.make(.options, uri: "rtsp://host").cseq == 1)
    #expect(builder.make(.describe, uri: "rtsp://host").cseq == 2)
    #expect(builder.make(.setup, uri: "rtsp://host").cseq == 3)
  }

  @Test("Once a session exists every request carries it")
  func sessionHeaderIsCarried() {
    var builder = RTSPRequestBuilder()
    builder.session = "12345678"
    let request = builder.make(.play, uri: "rtsp://host")

    #expect(request.headers.contains { $0.name == "Session" && $0.value == "12345678" })
  }

  @Test("A body is measured for the camera rather than left for it to guess")
  func bodyGetsContentLength() {
    var builder = RTSPRequestBuilder()
    let request = builder.make(.setParameter, uri: "rtsp://host", body: Data("x=1".utf8))

    #expect(String(decoding: request.wireFormat, as: UTF8.self).contains("Content-Length: 3\r\n"))
  }

  @Test("A response parses into status, headers and body")
  func responseParses() throws {
    let raw = Data("""
      RTSP/1.0 200 OK\r
      CSeq: 2\r
      Content-Type: application/sdp\r
      Content-Length: 5\r
      \r
      v=0\r

      """.utf8)

    let parsed = try #require(RTSPResponse.parse(raw))
    #expect(parsed.response.statusCode == 200)
    #expect(parsed.response.reasonPhrase == "OK")
    #expect(parsed.response.cseq == 2)
    #expect(parsed.response.header("content-type") == "application/sdp")
    #expect(parsed.response.bodyText == "v=0\r\n")
    #expect(parsed.consumed == raw.count)
  }

  @Test("Header names match whatever case the camera chose")
  func headerLookupIsCaseInsensitive() throws {
    let raw = Data("RTSP/1.0 200 OK\r\nSESSION: abc;timeout=90\r\n\r\n".utf8)
    let parsed = try #require(RTSPResponse.parse(raw))

    #expect(parsed.response.header("Session") == "abc;timeout=90")
    #expect(parsed.response.session == "abc")
    #expect(parsed.response.sessionTimeout == 90)
  }

  @Test("A session with no stated timeout gets the RFC default, not forever")
  func missingTimeoutFallsBackToTheStandard() throws {
    // Exactly what the cameras here send.
    let raw = Data("RTSP/1.0 200 OK\r\nSession: 1846875828\r\n\r\n".utf8)
    let parsed = try #require(RTSPResponse.parse(raw))

    #expect(parsed.response.sessionTimeout == 60)
  }

  @Test("A wrapped header keeps the part on the continuation line")
  func foldedHeadersAreJoined() throws {
    let raw = Data("RTSP/1.0 200 OK\r\nPublic: OPTIONS, DESCRIBE,\r\n  SETUP, PLAY\r\n\r\n".utf8)
    let parsed = try #require(RTSPResponse.parse(raw))

    #expect(parsed.response.header("public") == "OPTIONS, DESCRIBE, SETUP, PLAY")
  }

  @Test("A response split across reads is not an error, it is just not finished")
  func partialResponseReturnsNil() {
    #expect(RTSPResponse.parse(Data("RTSP/1.0 200 OK\r\nCSeq: 1\r\n".utf8)) == nil)
    // Header block complete but the body has not arrived.
    #expect(RTSPResponse.parse(Data("RTSP/1.0 200 OK\r\nContent-Length: 10\r\n\r\nshort".utf8)) == nil)
  }

  @Test("Only this response is consumed, so the next one is still there to read")
  func consumedCountStopsAtTheBoundary() throws {
    let first = "RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n"
    let raw = Data((first + "RTSP/1.0 200 OK\r\nCSeq: 2\r\n\r\n").utf8)

    let parsed = try #require(RTSPResponse.parse(raw))
    #expect(parsed.consumed == first.utf8.count)
  }

  @Test("A reason phrase containing spaces survives intact")
  func multiWordReasonPhrase() throws {
    let parsed = try #require(RTSPResponse.parse(Data("RTSP/1.0 404 Stream Not Found\r\n\r\n".utf8)))

    #expect(parsed.response.statusCode == 404)
    #expect(parsed.response.reasonPhrase == "Stream Not Found")
    #expect(!parsed.response.isSuccess)
  }
}
