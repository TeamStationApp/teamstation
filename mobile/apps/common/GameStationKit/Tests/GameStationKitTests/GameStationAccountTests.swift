import Foundation
import Testing

@testable import GameStationKit

/// A GameStation that answers every claim, or refuses every one, and writes
/// down what it was asked.
private final class ClaimServer: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var refuse = false
  nonisolated(unsafe) static var asked: [String] = []

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let path = request.url!.path()
    Self.asked.append("\(request.httpMethod ?? "GET") \(path)")
    let gameId = path.split(separator: "/").dropLast().last.map(String.init) ?? ""
    let status = Self.refuse ? 409 : 200
    let body = Self.refuse
      ? #"{"code":"conflict","message":"This game is not yours to stream"}"#
      : #"{"gameId":"\#(gameId)","url":"rtmp://ingest/live/\#(gameId)","opensAt":null,"closesAt":null}"#
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

  override func stopLoading() {}
}

@MainActor
private func makeAccount(
  server: String = "https://gamestation.example",
  keychain: KeychainStore = .inMemory()
) -> GameStationAccount {
  ClaimServer.refuse = false
  ClaimServer.asked = []
  keychain.setToken("tok")
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [ ClaimServer.self ]
  return GameStationAccount(
    serverURL: URL(string: server)!,
    deviceName: "a test",
    keychain: keychain,
    session: URLSession(configuration: configuration)
  )
}

private func event(_ gameId: String) -> GameStationEvent {
  GameStationEvent(
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
    let kept = try GameStationClient.decoder.decode(
      GameStationAccount.ChosenEvent.self,
      from: Data(json.utf8)
    )
    #expect(kept.streamURL == "rtmp://ingest/live/k")

    let unclaimed = #"{"gameId":"g1","title":"T","startAt":"2026-09-21T18:00:00Z"}"#
    let bare = try GameStationClient.decoder.decode(
      GameStationAccount.ChosenEvent.self,
      from: Data(unclaimed.utf8)
    )
    #expect(bare.streamURL == nil)
  }

  @Test func choosesWithoutClaimingAndAsksNothing() async {
    let keychain = KeychainStore.inMemory()
    let account = makeAccount(keychain: keychain)
    let chose = await account.choose(event: event("g1"), claim: false)
    #expect(chose)
    #expect(ClaimServer.asked.isEmpty)
    #expect(account.chosen?.gameId == "g1")
    #expect(account.chosen?.title == "Visitors at Pioneers")
    #expect(account.chosen?.streamURL == nil)
    #expect(keychain.chosenEvent() == account.chosen)
  }

  @Test func choosingTheSameGameUnclaimedKeepsItsAddress() async {
    let account = makeAccount()
    await account.choose(event: event("g1"))
    await account.choose(event: event("g1"), claim: false)
    #expect(account.chosen?.streamURL == "rtmp://ingest/live/g1")
    await account.choose(event: event("g2"), claim: false)
    #expect(account.chosen?.streamURL == nil)
  }

  @Test func claimsByDefaultAndWhenAsked() async {
    let account = makeAccount()
    #expect(await account.choose(event: event("g1")))
    #expect(ClaimServer.asked == [ "POST /api/v1/director/events/g1/claim" ])
    #expect(account.chosen?.streamURL == "rtmp://ingest/live/g1")

    #expect(await account.choose(event: event("g2"), claim: true))
    #expect(ClaimServer.asked.last == "POST /api/v1/director/events/g2/claim")
    #expect(account.chosen?.gameId == "g2")
    #expect(account.chosen?.streamURL == "rtmp://ingest/live/g2")
  }

  @Test func aRefusedClaimKeepsTheGameChosenBefore() async {
    let account = makeAccount()
    await account.choose(event: event("g1"), claim: false)
    ClaimServer.refuse = true
    #expect(await account.choose(event: event("g2")) == false)
    #expect(account.chosen?.gameId == "g1")
    #expect(account.lastError == "This game is not yours to stream")
  }

  @Test func claimsTheChosenGameOnDemand() async {
    let keychain = KeychainStore.inMemory()
    let account = makeAccount(keychain: keychain)
    #expect(await account.claimChosen() == false)
    #expect(account.lastError == "Pick a GameStation event first.")
    #expect(ClaimServer.asked.isEmpty)

    await account.choose(event: event("g1"), claim: false)
    #expect(await account.claimChosen())
    #expect(account.lastError == nil)
    #expect(account.chosen?.streamURL == "rtmp://ingest/live/g1")
    #expect(keychain.chosenEvent()?.streamURL == "rtmp://ingest/live/g1")

    ClaimServer.refuse = true
    #expect(await account.claimChosen() == false)
    #expect(account.lastError == "This game is not yours to stream")
    #expect(account.chosen?.streamURL == "rtmp://ingest/live/g1")
  }

  @Test func refreshesTheChosenGameQuietly() async {
    let account = makeAccount()
    await account.refreshChosen()
    #expect(ClaimServer.asked.isEmpty)
    await account.choose(event: event("g1"), claim: false)
    await account.refreshChosen()
    #expect(account.chosen?.streamURL == "rtmp://ingest/live/g1")
    ClaimServer.refuse = true
    await account.refreshChosen()
    #expect(account.lastError == nil)
    #expect(account.chosen?.streamURL == "rtmp://ingest/live/g1")
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
      makeAccount(server: "https://gamestation.co").scoreboardURL(for: "g1").absoluteString
        == "https://gamestation.co/scoreboard/g1?quiet=1"
    )
    #expect(
      makeAccount(server: "http://10.0.2.2:9100").scoreboardURL(for: "gam_7").absoluteString
        == "http://10.0.2.2:9100/scoreboard/gam_7?quiet=1"
    )
    #expect(ClaimServer.asked.isEmpty)
  }
}
