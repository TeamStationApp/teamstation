import CameramanCore
import CameramanRTSP
import DirectorRTSP
import Foundation
import Testing

/// A parameter exchange with GS Director's request builder on one end and its response parser on
/// the other, and Cameraman's server parser and responder in the middle. Both ends are the real
/// code, so agreement here is agreement on the wire.
@Suite("RTSP parameter interop")
struct RTSPParameterInteropTests {
  private let uri = "rtsp://192.168.7.118:554/live/mainstream"

  /// A responder whose parameters come from a mutable snapshot, the way the phone's do.
  private func responder(_ snapshot: CameraSnapshot) -> RTSPResponder {
    let box = SnapshotBox(snapshot)
    return RTSPResponder(sessionIdentifier: "S1", sdp: "v=0\r\n", hasAudio: true) { request in
      let current = box.value
      switch request.method {
      case .get:
        switch CameraParameters.respondToGet(body: request.body, snapshot: current) {
        case .success(let set): return .init(body: set.encoded)
        case .failure(let error): return .init(statusCode: error.statusCode, reasonPhrase: error.reasonPhrase, body: error.body)
        }
      case .set:
        switch CameraParameters.parseSet(body: request.body, snapshot: current) {
        case .success(let write):
          let applied = CameraParameters.snapshot(applying: write, to: current)
          box.value = applied
          return .init(body: CameraParameters.echo(write, applied: applied).encoded)
        case .failure(let error):
          return .init(statusCode: error.statusCode, reasonPhrase: error.reasonPhrase, body: error.body)
        }
      }
    }
  }

  private func exchange(_ request: RTSPRequest, through responder: inout RTSPResponder) throws -> RTSPResponse {
    let parsed = try #require(RTSPServerRequest.parse(request.wireFormat))
    #expect(parsed.consumed == request.wireFormat.count)
    let outcome = responder.respond(to: parsed.request)
    return try #require(RTSPResponse.parse(outcome.response.wireFormat)?.response)
  }

  @Test("Director asks for everything and rebuilds the phone's state")
  func getEverything() throws {
    var responder = responder(CameraParametersTests.snapshot())
    var builder = RTSPRequestBuilder()
    let request = builder.make(
      .getParameter,
      uri: uri,
      headers: [ (name: "Content-Type", value: CameraParameters.contentType) ],
      body: Data("*\r\n".utf8)
    )
    let response = try exchange(request, through: &responder)

    #expect(response.statusCode == 200)
    #expect(response.cseq == request.cseq)
    #expect(response.header("content-type") == "text/parameters")
    let set = try CameraParameterSet.decode(response.bodyText).get()
    let snapshot = try #require(CameraParameters.decodeSnapshot(set))
    #expect(snapshot.mapping.presetDisplayedZooms == [ 0.5, 1, 3, 9 ])
    #expect(snapshot.name == "Third Base")
  }

  @Test("Director writes a zoom and reads the clamped value back")
  func setZoom() throws {
    var responder = responder(CameraParametersTests.snapshot())
    var builder = RTSPRequestBuilder()
    let request = builder.make(
      .setParameter,
      uri: uri,
      headers: [ (name: "Content-Type", value: CameraParameters.contentType) ],
      body: Data("ptz.zoom: 12\r\n".utf8)
    )
    let response = try exchange(request, through: &responder)

    #expect(response.statusCode == 200)
    let set = try CameraParameterSet.decode(response.bodyText).get()
    #expect(set.pairs.map(\.name) == [ "ptz.zoom" ])
    #expect(set["ptz.zoom"] == "9")

    // The next read sees the write.
    let read = builder.make(.getParameter, uri: uri, body: Data("ptz.zoom\r\n".utf8))
    let readBack = try exchange(read, through: &responder)
    #expect(try CameraParameterSet.decode(readBack.bodyText).get()["ptz.zoom"] == "9")
  }

  @Test("A codec change carries its default bitrate, applied as one settings change")
  func setCodec() throws {
    var responder = responder(CameraParametersTests.snapshot())
    var builder = RTSPRequestBuilder()
    let request = builder.make(
      .setParameter,
      uri: uri,
      body: Data("videoEncoder.encoding: H264\r\n".utf8)
    )
    let response = try exchange(request, through: &responder)
    #expect(response.statusCode == 200)

    let read = builder.make(.getParameter, uri: uri, body: Data("videoEncoder.encoding\r\nvideoEncoder.rateControl.bitrateLimit\r\n".utf8))
    let set = try CameraParameterSet.decode(try exchange(read, through: &responder).bodyText).get()
    #expect(set["videoEncoder.encoding"] == "H264")
    #expect(set["videoEncoder.rateControl.bitrateLimit"] == "6000")
  }

  @Test("Errors reach Director with their RTSP status and the offending name")
  func errors() throws {
    var responder = responder(CameraParametersTests.snapshot())
    var builder = RTSPRequestBuilder()

    let readOnly = try exchange(builder.make(.setParameter, uri: uri, body: Data("device.cname: x\r\n".utf8)), through: &responder)
    #expect(readOnly.statusCode == 458)
    #expect(readOnly.bodyText.hasPrefix("device.cname\r\n"))

    let unknown = try exchange(builder.make(.getParameter, uri: uri, body: Data("ptz.tilt\r\n".utf8)), through: &responder)
    #expect(unknown.statusCode == 451)

    let bad = try exchange(builder.make(.setParameter, uri: uri, body: Data("ptz.zoom: 3\r\nvideoEncoder.encoding: AV1\r\n".utf8)), through: &responder)
    #expect(bad.statusCode == 400)
    #expect(bad.bodyText.hasPrefix("videoEncoder.encoding\r\n"))

    // Nothing from the mixed request took.
    let zoom = try exchange(builder.make(.getParameter, uri: uri, body: Data("ptz.zoom\r\n".utf8)), through: &responder)
    #expect(try CameraParameterSet.decode(zoom.bodyText).get()["ptz.zoom"] == "1")
  }

  @Test("An empty GET_PARAMETER is still the keepalive it always was")
  func keepalive() throws {
    var responder = responder(CameraParametersTests.snapshot())
    var builder = RTSPRequestBuilder()
    let response = try exchange(builder.make(.getParameter, uri: uri), through: &responder)
    #expect(response.statusCode == 200)
    #expect(response.body.isEmpty)
    #expect(response.header("content-type") == nil)
  }
}

/// The responder's handler is `@Sendable`; this is the smallest thing it can mutate.
private final class SnapshotBox: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: CameraSnapshot
  init(_ value: CameraSnapshot) { stored = value }
  var value: CameraSnapshot {
    get { lock.withLock { stored } }
    set { lock.withLock { stored = newValue } }
  }
}
