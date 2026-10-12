import Foundation
import Testing

@testable import TeamStationKit

/// Sending a recording over a network that misbehaves.
///
/// Written after a real upload was lost to a single failed request. Every
/// byte of a 3.6 GB take had arrived, the server was restarted between two
/// files, the *opening* request for the second file failed once, and the
/// whole camera was abandoned having sent nothing. Parts were retried;
/// nothing either side of them was.
///
/// The fake server below fails whichever step the test names, as many times
/// as it says, and then behaves. What is being checked is that the upload
/// still finishes.
private final class FlakyServer: URLProtocol, @unchecked Sendable {
  /// How many more times each kind of request should fail. Static because
  /// `URLProtocol` is made by the loading system, not by the test.
  nonisolated(unsafe) static var failuresLeft: [String: Int] = [:]
  nonisolated(unsafe) static var seen: [String] = []
  /// The body of each opening request, so a test can read what was asked for.
  nonisolated(unsafe) static var opened: [[String: Any]] = []

  static func step(for request: URLRequest) -> String {
    let path = request.url?.path ?? ""
    if path.hasSuffix("/finish") { return "finish" }
    if path.contains("/parts/") { return "part" }
    if request.httpMethod == "POST" { return "open" }
    if request.httpMethod == "GET" { return "state" }
    return "other"
  }

  /// What `POST /finish` says. The real server acknowledges and works
  /// behind the request, naming no video until it has made one.
  nonisolated(unsafe) static var finishReply =
    #"{"videoId":null,"state":"assembling","step":"assembling"}"#

  /// What `GET /uploads/{id}` says while and after that work.
  nonisolated(unsafe) static var stateReply =
    #"{"uploadId":"dup_1","state":"ready","partSize":8,"parts":2,"received":[0,1],"missing":[],"receivedBytes":12,"videoId":"vid_1"}"#

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let step = Self.step(for: request)
    Self.seen.append(step)
    if step == "open", let body = Self.body(of: request),
      let fields = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
    {
      Self.opened.append(fields)
    }

    if let left = Self.failuresLeft[step], left > 0 {
      Self.failuresLeft[step] = left - 1
      client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
      return
    }

    let body: String
    switch step {
    case "open":
      body = #"{"uploadId":"dup_1","partSize":8,"parts":2,"received":[]}"#
    case "part":
      body = #"{"received":1,"parts":2,"missing":[]}"#
    case "finish":
      body = Self.finishReply
    case "state":
      body = Self.stateReply
    default:
      body = "{}"
    }
    let response = HTTPURLResponse(
      url: request.url!,
      statusCode: 200,
      httpVersion: nil,
      headerFields: [ "content-type": "application/json" ]
    )!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}

  /// The request's body, wherever the loading system put it: set directly on
  /// a `URLRequest` it arrives as a stream by the time a protocol sees it.
  static func body(of request: URLRequest) -> Data? {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
      let read = stream.read(&buffer, maxLength: buffer.count)
      if read <= 0 { break }
      data.append(contentsOf: buffer[0 ..< read])
    }
    return data
  }
}

// Serialised: the fake server keeps its tally in static state, because
// `URLProtocol` instances are made by the loading system rather than by the
// test. Run in parallel, the tests count each other's requests.
@Suite("Sending a recording over a network that misbehaves", .serialized)
struct UploadServiceTests {
  /// When the take being sent began — not when it is being sent.
  static let began = Date(timeIntervalSince1970: 1_789_672_609)

  /// A twelve-byte file, which the fake server cuts into two parts of eight.
  private func aFile() throws -> URL {
    let url = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("take-\(UUID().uuidString).mov")
    try Data(repeating: 0x2a, count: 12).write(to: url)
    return url
  }

  /// Resets the fake server to "the finish is answered with a video", which
  /// is the already-finished case and keeps the tests that are about other
  /// things from having to watch.
  private func finishesAtOnce() {
    FlakyServer.finishReply = #"{"videoId":"vid_1","state":"ready","step":null}"#
  }

  private func service() -> UploadService {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ FlakyServer.self ]
    return UploadService(
      client: TeamStationClient(
        baseURL: URL(string: "https://develop.example")!,
        token: "tok",
        session: URLSession(configuration: configuration)
      )
    )
  }

  @Test func survivesAFailureOpeningTheUpload() async throws {
    finishesAtOnce()
    FlakyServer.failuresLeft = [ "open": 2 ]
    FlakyServer.seen = []
    let file = try aFile()
    defer { try? FileManager.default.removeItem(at: file) }

    let videoId = try await service().send(
      file: file, gameId: "gam_1", title: "a take", kind: "home", startedAt: Self.began
    )

    #expect(videoId == "vid_1")
    // Three opens: two refused, one that worked.
    #expect(FlakyServer.seen.filter { $0 == "open" }.count == 3)
  }

  @Test func watchesTheServerTakeItIn() async throws {
    // Every byte is already there, and what is left is the longest part of
    // the business — assemble, probe, remux, copy — which the server does
    // behind the request. Holding that request open instead timed out after
    // twenty seconds and reported a 3.6 GB upload that had landed as failed.
    FlakyServer.failuresLeft = [:]
    FlakyServer.seen = []
    FlakyServer.finishReply =
      #"{"videoId":null,"state":"assembling","step":"assembling"}"#
    FlakyServer.stateReply =
      #"{"uploadId":"dup_1","state":"ready","partSize":8,"parts":2,"received":[0,1],"missing":[],"receivedBytes":12,"step":null,"videoId":"vid_landed"}"#
    let file = try aFile()
    defer { try? FileManager.default.removeItem(at: file) }

    let videoId = try await service().send(
      file: file, gameId: "gam_1", title: "a take", kind: "home", startedAt: Self.began
    )

    #expect(videoId == "vid_landed")
    // Asked for once, then watched — never sent again.
    #expect(FlakyServer.seen.filter { $0 == "finish" }.count == 1)
    #expect(FlakyServer.seen.contains("state"))
  }

  @Test func survivesAFailedPart() async throws {
    finishesAtOnce()
    FlakyServer.failuresLeft = [ "part": 1 ]
    FlakyServer.seen = []
    let file = try aFile()
    defer { try? FileManager.default.removeItem(at: file) }

    let videoId = try await service().send(
      file: file, gameId: "gam_1", title: "a take", kind: "home", startedAt: Self.began
    )

    #expect(videoId == "vid_1")
    // Two parts, one of them sent twice.
    #expect(FlakyServer.seen.filter { $0 == "part" }.count == 3)
  }

  @Test func givesUpNamingTheStepThatWouldNotWork() async throws {
    // Four tries and no more: a token that has genuinely expired must not be
    // retried all afternoon.
    FlakyServer.failuresLeft = [ "open": 99 ]
    FlakyServer.seen = []
    let file = try aFile()
    defer { try? FileManager.default.removeItem(at: file) }

    await #expect(throws: UploadService.UploadError.self) {
      _ = try await service().send(
        file: file, gameId: "gam_1", title: "a take", kind: "home", startedAt: Self.began
      )
    }
    #expect(FlakyServer.seen.filter { $0 == "open" }.count == 4)
  }

  @Test func refusesAFileThatIsNotThere() async throws {
    FlakyServer.failuresLeft = [:]
    await #expect(throws: UploadService.UploadError.self) {
      _ = try await service().send(
        file: URL(fileURLWithPath: "/nowhere/at/all.mov"),
        gameId: "gam_1",
        title: "a take",
        kind: "home",
        startedAt: Self.began
      )
    }
  }

  @Test func tellsTheServerWhenTheRecordingBegan() async throws {
    finishesAtOnce()
    // The whole point: the library places a video on the game's wall clock and
    // lays a take's angles out against it, so every file of a take must say
    // the same instant however long each one took to send. Sending "now"
    // instead put one take's two cameras thirty-four minutes apart.
    FlakyServer.failuresLeft = [:]
    FlakyServer.seen = []
    FlakyServer.opened = []
    let file = try aFile()
    defer { try? FileManager.default.removeItem(at: file) }

    _ = try await service().send(
      file: file, gameId: "gam_1", title: "a take", kind: "home", startedAt: Self.began
    )

    let asked = try #require(FlakyServer.opened.first)
    let said = try #require(asked["startAt"] as? String)
    // Fractional seconds, which a bare `ISO8601DateFormatter` will not read.
    let reader = ISO8601DateFormatter()
    reader.formatOptions = [ .withInternetDateTime, .withFractionalSeconds ]
    let when = try #require(reader.date(from: said))
    #expect(abs(when.timeIntervalSince(Self.began)) < 0.001)
  }

  @Test func sendsTheTakesServerClockOffsetWhenItHasOne() async throws {
    // The server adds it to the start, so the video sits on the server's clock
    // with the game's scoring rather than on the iPad's.
    finishesAtOnce()
    FlakyServer.failuresLeft = [:]
    FlakyServer.opened = []
    let file = try aFile()
    defer { try? FileManager.default.removeItem(at: file) }

    _ = try await service().send(
      file: file, gameId: "gam_1", title: "a take", kind: "home", startedAt: Self.began,
      serverClockOffsetMs: -1234
    )
    _ = try await service().send(
      file: file, gameId: "gam_1", title: "a take", kind: "home", startedAt: Self.began
    )

    #expect(FlakyServer.opened.count == 2)
    #expect(FlakyServer.opened[0]["serverClockOffsetMs"] as? Int == -1234)
    // Nothing measured, nothing said: the server takes the start as it is.
    #expect(FlakyServer.opened[1]["serverClockOffsetMs"] == nil)
  }

  /// An account signed in to the fake server.
  @MainActor
  private func account() -> TeamStationAccount {
    let keychain = KeychainStore.inMemory()
    keychain.setToken("tok")
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ FlakyServer.self ]
    return TeamStationAccount(
      serverURL: URL(string: "https://develop.example")!,
      deviceName: "a test",
      keychain: keychain,
      session: URLSession(configuration: configuration)
    )
  }

  @Test @MainActor func theAccountPassesTheOffsetThrough() async throws {
    // TS Distributor sends through `send`, TS Director through `upload`; both
    // reach the opening request.
    finishesAtOnce()
    FlakyServer.failuresLeft = [:]
    FlakyServer.opened = []
    let file = try aFile()
    defer { try? FileManager.default.removeItem(at: file) }
    let account = account()

    let sent = try await account.send(
      file: file, gameId: "gam_1", title: "a take", kind: "program", startedAt: Self.began,
      serverClockOffsetMs: 250
    )
    let uploaded = await account.upload(
      file: file, recordingID: 7, gameId: "gam_1", title: "a take", kind: "program",
      startedAt: Self.began, serverClockOffsetMs: 40
    )
    let plain = await account.upload(
      file: file, recordingID: 8, gameId: "gam_1", title: "a take", kind: "program",
      startedAt: Self.began
    )

    #expect(sent == "vid_1")
    #expect(uploaded == "vid_1")
    #expect(plain == "vid_1")
    #expect(account.uploads[7]?.done == true)
    #expect(FlakyServer.opened.map { $0["serverClockOffsetMs"] as? Int } == [ 250, 40, nil ])
  }

  @Test func saysSoWhenTheServerCouldNotFinishIt() async throws {
    FlakyServer.failuresLeft = [:]
    FlakyServer.seen = []
    FlakyServer.finishReply =
      #"{"videoId":null,"state":"assembling","step":"assembling"}"#
    FlakyServer.stateReply =
      #"{"uploadId":"dup_1","state":"failed","partSize":8,"parts":2,"received":[0,1],"missing":[],"receivedBytes":12,"step":null,"videoId":null,"message":"that recording has no video stream"}"#
    let file = try aFile()
    defer { try? FileManager.default.removeItem(at: file) }

    await #expect(throws: UploadService.UploadError.self) {
      _ = try await service().send(
        file: file, gameId: "gam_1", title: "a take", kind: "home", startedAt: Self.began
      )
    }
  }
}
