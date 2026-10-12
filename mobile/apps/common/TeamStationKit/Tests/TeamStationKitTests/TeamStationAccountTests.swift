import Foundation
import Testing

@testable import TeamStationKit

/// A TeamStation that hands out device streams, or refuses every request, and
/// writes down what it was asked.
///
/// One stream per game at a time: a request naming the stream held gets it
/// back, unless it was ended (410); a request naming none gets the game's
/// current stream, or a fresh one when that was ended.
private final class StreamServer: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var refuse = false
  nonisolated(unsafe) static var asked: [String] = []
  nonisolated(unsafe) static var bodies: [[String: String]] = []
  nonisolated(unsafe) static var current: [String: String] = [:]
  nonisolated(unsafe) static var ended: Set<String> = []
  nonisolated(unsafe) static var made = 0

  static func reset() {
    refuse = false
    asked = []
    bodies = []
    current = [:]
    ended = []
    made = 0
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let path = request.url!.path()
    let method = request.httpMethod ?? "GET"
    Self.asked.append("\(method) \(path)")
    let bytes = Self.requestBody(request)
    let fields = (try? JSONSerialization.jsonObject(with: bytes) as? [String: Any]) ?? [:]
    if !fields.isEmpty { Self.bodies.append(fields.mapValues { "\($0)" }) }
    let parts = path.split(separator: "/").map(String.init)
    let gameId = parts.count > 3 ? parts[3] : ""
    let (status, body) = answer(method: method, gameId: gameId, parts: parts, fields: fields)
    let response = HTTPURLResponse(
      url: request.url!,
      statusCode: status,
      httpVersion: nil,
      headerFields: [ "content-type": "application/json" ]
    )!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  private func answer(
    method: String,
    gameId: String,
    parts: [String],
    fields: [String: Any]
  ) -> (Int, String) {
    if Self.refuse {
      return (409, #"{"code":"conflict","message":"This game is not yours to stream"}"#)
    }
    switch method {
    case "POST":
      let id: String
      if let held = fields["heldStreamId"] as? String {
        guard !Self.ended.contains(held) else {
          return (410, #"{"code":"gone","message":"This camera was ended. Start streaming again to go live"}"#)
        }
        id = held
      } else if let live = Self.current[gameId], !Self.ended.contains(live) {
        id = live
      } else {
        Self.made += 1
        id = "lst_\(Self.made)"
      }
      Self.current[gameId] = id
      return (200, #"{"id":"\#(id)","gameId":"\#(gameId)","url":"rtmp://ingest/live/\#(gameId)-\#(id)","state":"idle"}"#)
    case "PATCH":
      let id = parts.last ?? ""
      let label = fields["label"] as? String ?? ""
      return (200, #"{"id":"\#(id)","gameId":"\#(gameId)","label":"\#(label)"}"#)
    default:
      return (200, """
        {"gameId":"\(gameId)","mine":[
          {"id":"lst_8","gameId":"\(gameId)","deviceId":"00000000-0000-4000-8000-000000000009","lastError":"not this one"},
          {"id":"lst_9","gameId":"\(gameId)","deviceId":"00000000-0000-4000-8000-000000000001","state":"idle","lastError":"The key is not open yet"}
        ],"others":[]}
        """)
    }
  }

  override func stopLoading() {}

  /// URLSession hands a protocol the body as a stream, not as `httpBody`.
  private static func requestBody(_ request: URLRequest) -> Data {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return Data() }
    stream.open()
    defer { stream.close() }
    var data = Data()
    let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 1024)
    defer { buffer.deallocate() }
    while stream.hasBytesAvailable {
      let count = stream.read(buffer, maxLength: 1024)
      if count <= 0 { break }
      data.append(buffer, count: count)
    }
    return data
  }
}

private let installId = "00000000-0000-4000-8000-000000000001"

@MainActor
private func makeAccount(
  server: String = "https://teamstation.example",
  keychain: KeychainStore = .inMemory(),
  clock: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 }
) -> TeamStationAccount {
  StreamServer.reset()
  keychain.setToken("tok")
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [ StreamServer.self ]
  return TeamStationAccount(
    serverURL: URL(string: server)!,
    deviceName: "a test",
    installId: installId,
    deviceModel: "iPad Pro",
    keychain: keychain,
    session: URLSession(configuration: configuration),
    clock: clock
  )
}

private func event(_ gameId: String) -> TeamStationEvent {
  TeamStationEvent(
    gameId: gameId,
    startAt: Date(timeIntervalSince1970: 1_790_000_000),
    venue: nil,
    homeTeamName: "Pioneers",
    awayTeamName: "Visitors",
    homeLogoURL: nil,
    awayLogoURL: nil,
    liveState: "none"
  )
}

@Suite("Choosing a game, and claiming it", .serialized)
@MainActor
struct ChooseTests {
  @Test func readsAnEventKeptBeforeClaimingWasOptional() throws {
    // What the keychain held before `streamURL` could be absent.
    let json = #"{"gameId":"g1","title":"Visitors at Pioneers","startAt":"2026-09-21T18:00:00Z","streamURL":"rtmp://ingest/live/k"}"#
    let kept = try TeamStationClient.decoder.decode(
      TeamStationAccount.ChosenEvent.self,
      from: Data(json.utf8)
    )
    #expect(kept.streamURL == "rtmp://ingest/live/k")

    let unclaimed = #"{"gameId":"g1","title":"T","startAt":"2026-09-21T18:00:00Z"}"#
    let bare = try TeamStationClient.decoder.decode(
      TeamStationAccount.ChosenEvent.self,
      from: Data(unclaimed.utf8)
    )
    #expect(bare.streamURL == nil)
    #expect(bare.streamId == nil)
  }

  @Test func choosesWithoutClaimingAndAsksNothing() async {
    let keychain = KeychainStore.inMemory()
    let account = makeAccount(keychain: keychain)
    let chose = await account.choose(event: event("g1"), claim: false)
    #expect(chose)
    #expect(StreamServer.asked.isEmpty)
    #expect(account.chosen?.gameId == "g1")
    #expect(account.chosen?.title == "Visitors at Pioneers")
    #expect(account.chosen?.streamURL == nil)
    #expect(keychain.chosenEvent() == account.chosen)
  }

  @Test func choosingTheSameGameUnclaimedKeepsItsAddress() async {
    let account = makeAccount()
    await account.choose(event: event("g1"))
    await account.choose(event: event("g1"), claim: false)
    #expect(account.chosen?.streamURL == "rtmp://ingest/live/g1-lst_1")
    #expect(account.chosen?.streamId == "lst_1")
    await account.choose(event: event("g2"), claim: false)
    #expect(account.chosen?.streamURL == nil)
    #expect(account.chosen?.streamId == nil)
  }

  @Test func claimPostsTheLabelWithTheInstallIdAndModel() async throws {
    let account = makeAccount()
    #expect(await account.choose(event: event("g1"), cameraName: "Center Field"))
    #expect(await account.claimChosen(cameraName: ""))
    try await account.refreshChosen(cameraName: "Left Field", reason: .start)
    let device = [ "deviceId": installId, "deviceModel": "iPad Pro" ]
    #expect(StreamServer.bodies == [
      device.merging([ "label": "Center Field" ]) { $1 },
      device.merging([ "label": "" ]) { $1 },
      device.merging([ "label": "Left Field" ]) { $1 }
    ])
    #expect(StreamServer.asked == Array(repeating: "POST /api/v1/games/g1/live-streams", count: 3))
  }

  @Test func claimsByDefaultAndWhenAsked() async {
    let account = makeAccount()
    #expect(await account.choose(event: event("g1")))
    #expect(StreamServer.asked == [ "POST /api/v1/games/g1/live-streams" ])
    #expect(account.chosen?.streamURL == "rtmp://ingest/live/g1-lst_1")

    #expect(await account.choose(event: event("g2"), claim: true))
    #expect(StreamServer.asked.last == "POST /api/v1/games/g2/live-streams")
    #expect(account.chosen?.gameId == "g2")
    #expect(account.chosen?.streamURL == "rtmp://ingest/live/g2-lst_2")
    #expect(account.chosen?.streamId == "lst_2")
  }

  @Test func aRefusedClaimKeepsTheGameChosenBefore() async {
    let account = makeAccount()
    await account.choose(event: event("g1"), claim: false)
    StreamServer.refuse = true
    #expect(await account.choose(event: event("g2")) == false)
    #expect(account.chosen?.gameId == "g1")
    #expect(account.lastError == "This game is not yours to stream")
  }

  @Test func claimsTheChosenGameOnDemand() async {
    let keychain = KeychainStore.inMemory()
    let account = makeAccount(keychain: keychain)
    #expect(await account.claimChosen() == false)
    #expect(account.lastError == "Pick a TeamStation event first.")
    #expect(StreamServer.asked.isEmpty)

    await account.choose(event: event("g1"), claim: false)
    #expect(await account.claimChosen())
    #expect(account.lastError == nil)
    #expect(account.chosen?.streamURL == "rtmp://ingest/live/g1-lst_1")
    #expect(keychain.chosenEvent()?.streamURL == "rtmp://ingest/live/g1-lst_1")
    #expect(keychain.chosenEvent()?.streamId == "lst_1")

    StreamServer.refuse = true
    #expect(await account.claimChosen() == false)
    #expect(account.lastError == "This game is not yours to stream")
    #expect(account.chosen?.streamURL == "rtmp://ingest/live/g1-lst_1")
  }

  @Test func refreshesTheChosenGameQuietly() async throws {
    let account = makeAccount()
    try await account.refreshChosen()
    #expect(StreamServer.asked.isEmpty)
    await account.choose(event: event("g1"), claim: false)
    try await account.refreshChosen()
    #expect(account.chosen?.streamURL == "rtmp://ingest/live/g1-lst_1")
    // Any failure but an ended stream leaves the cached address to dial.
    StreamServer.refuse = true
    try await account.refreshChosen(reason: .redial)
    #expect(account.lastError == nil)
    #expect(account.chosen?.streamURL == "rtmp://ingest/live/g1-lst_1")
  }

  @Test func aStartAsksWithoutTheHeldStreamAndKeepsTheFreshOne() async throws {
    let account = makeAccount()
    #expect(await account.choose(event: event("g1")))
    StreamServer.ended = [ "lst_1" ]
    try await account.refreshChosen(cameraName: "Center Field", reason: .start)
    #expect(StreamServer.bodies.last?["heldStreamId"] == nil)
    #expect(account.chosen?.streamId == "lst_2")
    #expect(account.chosen?.streamURL == "rtmp://ingest/live/g1-lst_2")
  }

  @Test func aRedialNamesTheHeldStream() async throws {
    let account = makeAccount()
    #expect(await account.choose(event: event("g1")))
    try await account.refreshChosen(cameraName: "Center Field", reason: .redial)
    #expect(StreamServer.bodies.last?["heldStreamId"] == "lst_1")
    #expect(account.chosen?.streamId == "lst_1")
  }

  @Test func aRedialOfAnEndedStreamThrowsAndMakesNothing() async throws {
    let account = makeAccount()
    #expect(await account.choose(event: event("g1")))
    StreamServer.ended = [ "lst_1" ]
    await #expect(throws: TeamStationError.streamEnded) {
      try await account.refreshChosen(cameraName: "Center Field", reason: .redial)
    }
    #expect(StreamServer.made == 1)
    #expect(account.chosen?.streamId == "lst_1")
  }

  @Test func aKeptChoiceWithoutAStreamIdIsFilledInByTheNextRefresh() async throws {
    let keychain = KeychainStore.inMemory()
    keychain.setChosenEvent(TeamStationAccount.ChosenEvent(
      gameId: "g1",
      title: "Visitors at Pioneers",
      startAt: Date(timeIntervalSince1970: 1_790_000_000),
      streamURL: "rtmp://ingest/live/old"
    ))
    let account = makeAccount(keychain: keychain)
    #expect(account.chosen?.streamId == nil)
    try await account.refreshChosen(cameraName: "Center Field", reason: .redial)
    #expect(StreamServer.bodies.last?["heldStreamId"] == nil)
    #expect(account.chosen?.streamId == "lst_1")
    #expect(keychain.chosenEvent()?.streamId == "lst_1")
  }

  @Test func readsThisDevicesOwnRowForARefusal() async {
    let account = makeAccount()
    #expect(await account.reasonForRefusal() == nil)
    await account.choose(event: event("g1"), claim: false)
    #expect(await account.reasonForRefusal() == "The key is not open yet")
    #expect(StreamServer.asked == [ "GET /api/v1/games/g1/live-streams" ])
    StreamServer.refuse = true
    #expect(await account.reasonForRefusal() == nil)
  }

  @Test func renamesTheHeldStreamWithAPatch() async {
    let account = makeAccount()
    #expect(await account.renameStream(label: "Left Field") == false)
    await account.choose(event: event("g1"), claim: false)
    #expect(await account.renameStream(label: "Left Field") == false)
    #expect(StreamServer.asked.isEmpty)
    #expect(await account.choose(event: event("g1")))
    #expect(await account.renameStream(label: "Left Field"))
    #expect(StreamServer.asked.last == "PATCH /api/v1/games/g1/live-streams/lst_1")
    #expect(StreamServer.bodies.last == [ "label": "Left Field" ])
    StreamServer.refuse = true
    #expect(await account.renameStream(label: "Right Field") == false)
    #expect(account.lastError == "This game is not yours to stream")
  }

  @Test func reportsTheHeldStreamsLiveStartAsItIsGiven() async throws {
    // The caller has put it on the server's clock already; the account asks nothing more.
    let account = makeAccount()
    let started = Date(timeIntervalSince1970: 1_790_000_000.5)
    #expect(await account.reportLiveStart(startedAt: started) == false)
    #expect(await account.choose(event: event("g1")))
    #expect(await account.reportLiveStart(startedAt: started))
    #expect(StreamServer.asked.last == "PATCH /api/v1/games/g1/live-streams/lst_1")
    #expect(StreamServer.bodies.last == [ "liveStartedAt": "2026-09-21T14:13:20.500Z" ])
    StreamServer.refuse = true
    #expect(await account.reportLiveStart(startedAt: started) == false)
    #expect(account.lastError == nil)
  }

  @Test func saysWhyFromTheRowsStateAndWindowBeforeTheIngestsWord() {
    let now = Date(timeIntervalSince1970: 1_790_000_000)
    func row(
      state: String? = "idle",
      opensAt: Date? = nil,
      closesAt: Date? = nil,
      lastError: String? = nil
    ) -> TeamStationDeviceStream {
      TeamStationDeviceStream(
        id: "lst_9", gameId: "g1", state: state, lastError: lastError,
        deviceId: installId, opensAt: opensAt, closesAt: closesAt
      )
    }
    let ended = TeamStationError.streamEnded.localizedDescription
    #expect(TeamStationAccount.refusal(of: row(state: "ended", lastError: "x"), now: now) == ended)
    #expect(TeamStationAccount.refusal(of: row(state: "revoked"), now: now) == ended)
    let early = TeamStationAccount.refusal(of: row(opensAt: now.addingTimeInterval(600), lastError: "x"), now: now)
    #expect(early?.hasPrefix("This camera can go live from ") == true)
    let late = TeamStationAccount.refusal(of: row(opensAt: now.addingTimeInterval(-600), closesAt: now, lastError: "x"), now: now)
    #expect(late?.hasPrefix("This camera's streaming window closed at ") == true)
    // Inside its window, the ingest's own sentence; nothing to say, nil.
    let open = row(opensAt: now.addingTimeInterval(-600), closesAt: now.addingTimeInterval(600), lastError: "Disk full")
    #expect(TeamStationAccount.refusal(of: open, now: now) == "Disk full")
    #expect(TeamStationAccount.refusal(of: row(lastError: ""), now: now) == nil)
    #expect(TeamStationAccount.refusal(of: row(), now: now) == nil)
  }

  @Test func aPhoneSaysItRecordsLocallyWhenItAsksForItsStream() async throws {
    StreamServer.reset()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ StreamServer.self ]
    let client = TeamStationClient(
      baseURL: URL(string: "https://teamstation.example")!,
      token: "tok",
      session: URLSession(configuration: configuration)
    )
    _ = try await client.requestLiveStream(
      gameId: "g1", label: "Home Plate", deviceId: installId, deviceModel: "iPhone 13 Pro",
      heldStreamId: "lst_1", recordsLocally: true
    )
    #expect(StreamServer.bodies.last?["recordsLocally"] == "1")
    _ = try await client.requestLiveStream(gameId: "g1", label: "Home Plate", deviceId: installId, deviceModel: "iPad Pro")
    #expect(StreamServer.bodies.last?["recordsLocally"] == nil)
  }

  @Test func reportsWhenAStreamsFirstPictureWasCapturedWithAPatch() async throws {
    StreamServer.reset()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ StreamServer.self ]
    let client = TeamStationClient(
      baseURL: URL(string: "https://teamstation.example")!,
      token: "tok",
      session: URLSession(configuration: configuration)
    )
    let answer = try await client.reportLiveStart(
      gameId: "g1",
      streamId: "lst_1",
      startedAt: Date(timeIntervalSince1970: 1_790_000_000.375)
    )
    #expect(answer.id == "lst_1")
    #expect(StreamServer.asked == [ "PATCH /api/v1/games/g1/live-streams/lst_1" ])
    #expect(StreamServer.bodies == [ [ "liveStartedAt": "2026-09-21T14:13:20.375Z" ] ])
  }

  @Test func forgetsTheChosenGameEverywhere() async {
    let keychain = KeychainStore.inMemory()
    let account = makeAccount(keychain: keychain)
    await account.choose(event: event("g1"))
    #expect(keychain.chosenEvent() != nil)
    account.forgetChosenEvent()
    #expect(account.chosen == nil)
    #expect(keychain.chosenEvent() == nil)
    // A fresh account over the same keychain has nothing chosen either.
    #expect(makeAccount(keychain: keychain).chosen == nil)
  }

  @Test func knowsEachGamesQuietScoreboard() {
    #expect(
      makeAccount(server: "https://app.teamstation.app").scoreboardURL(for: "g1").absoluteString
        == "https://app.teamstation.app/scoreboard/g1?quiet=1"
    )
    #expect(
      makeAccount(server: "http://10.0.2.2:9100").scoreboardURL(for: "gam_7").absoluteString
        == "http://10.0.2.2:9100/scoreboard/gam_7?quiet=1"
    )
    #expect(StreamServer.asked.isEmpty)
  }
}
