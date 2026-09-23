import CameramanCore
import Foundation
import Testing

@Suite("Scoreboard target")
struct ScoreboardTargetTests {
  @Test
  func v1UsesTheServerStringAsTypedAndAnEventConvertsToASocket() {
    #expect(
      ScoreboardTarget.v1Url("wss://app.gamestation.co/", eventId: "game 1")
        == "wss://app.gamestation.co/sockets/api/v1/autoState/game%201"
    )
    #expect(ScoreboardTarget.v1Url("wss://app.gamestation.co", eventId: "") == nil)
    #expect(ScoreboardTarget.v1Url("", eventId: "game") == nil)
    let event = ScoreboardTarget.eventTarget("https://gamestation.co/", gameId: "game 1", token: "token")
    #expect(event?.url == "wss://gamestation.co/api/v1/scoreboard/game%201/publish")
    #expect(event?.authorization == "Bearer token")
    #expect(ScoreboardTarget.socketOrigin("http://10.0.2.2:9100/") == "ws://10.0.2.2:9100")
    #expect(ScoreboardTarget.httpOrigin("wss://gamestation.co/") == "https://gamestation.co")
    #expect(ScoreboardTarget.eventTarget("https://gamestation.co", gameId: "game", token: "") == nil)
  }

  @Test
  func eventRouteWaitsForATokenAndAChosenGame() {
    let saved = sample(route: .event, token: "", gameId: "g")
    #expect(ScoreboardTarget.effectiveRoute(saved.route, token: saved.token) == .v1)
    #expect(
      ScoreboardTarget.target(saved)?.url
        == "wss://app.gamestation.co/sockets/api/v1/autoState/evt"
    )
    let signedIn = sample(route: .event, token: "tok", gameId: "")
    #expect(ScoreboardTarget.target(signedIn) == nil)
    let live = sample(route: .event, token: "tok", gameId: "g1")
    #expect(ScoreboardTarget.target(live)?.url == "wss://gamestation.co/api/v1/scoreboard/g1/publish")
    #expect(ScoreboardTarget.target(live)?.authorization == "Bearer tok")
  }

  @Test
  func payloadIsTheSpeedsThatArrived() {
    #expect(ScoreboardTarget.payload(pitchMph: 50, exitMph: 70) == "{\"pitchSpeed\":50,\"exitVelocity\":70}")
    #expect(ScoreboardTarget.payload(pitchMph: 50, exitMph: 0) == "{\"pitchSpeed\":50}")
    #expect(ScoreboardTarget.payload(pitchMph: 0, exitMph: 70) == "{\"exitVelocity\":70}")
    #expect(ScoreboardTarget.payload(pitchMph: 0, exitMph: 0) == nil)
    #expect(ScoreboardTarget.payload(pitchMph: -1, exitMph: 0) == nil)
  }

  @Test
  func aRefusedSocketIsNotRetried() {
    #expect(ScoreboardTarget.stopsRetry(4401))
    #expect(ScoreboardTarget.stopsRetry(4403))
    #expect(ScoreboardTarget.stopsRetry(4404))
    #expect(ScoreboardTarget.stopsRetry(1000) == false)
  }

  @Test
  func aPitchRestartsTheHoldAndAnExitDoesNot() {
    let both = ScoreboardTarget.reading(pitchMph: 50, exitMph: 70)
    #expect(both?.text == "{\"pitchSpeed\":50,\"exitVelocity\":70}")
    #expect(both?.restartsPitchHold == true)
    #expect(ScoreboardTarget.reading(pitchMph: 50, exitMph: 0)?.restartsPitchHold == true)
    let exitOnly = ScoreboardTarget.reading(pitchMph: 0, exitMph: 70)
    #expect(exitOnly?.text == "{\"exitVelocity\":70}")
    #expect(exitOnly?.restartsPitchHold == false)
    #expect(ScoreboardTarget.reading(pitchMph: 0, exitMph: 0) == nil)
    #expect(ScoreboardTarget.pitchClearPayload == "{\"pitchSpeed\":0}")
    #expect(ScoreboardTarget.pitchHoldSeconds == 5)
  }

  @Test
  func signInUsesTheBuildHost() {
    #expect(ScoreboardTarget.accountHost(primaryHost: nil) == "gamestation.co")
    #expect(ScoreboardTarget.accountHost(primaryHost: "") == "gamestation.co")
    #expect(ScoreboardTarget.accountHost(primaryHost: "$(GS_PRIMARY_HOST)") == "gamestation.co")
    #expect(ScoreboardTarget.accountOrigin(primaryHost: nil) == "https://gamestation.co")
    #expect(
      ScoreboardTarget.accountHost(primaryHost: "https://devhost3.examplegs.test/")
        == "devhost3.examplegs.test"
    )
    #expect(
      ScoreboardTarget.accountOrigin(primaryHost: "devhost3.examplegs.test")
        == "https://devhost3.examplegs.test"
    )
    #expect(ScoreboardTarget.accountOrigin(primaryHost: "localhost") == "http://localhost")
  }

  @Test
  func eventLabelsMatchTheWatcher() {
    #expect(ScoreboardTarget.eventTitle(away: "Visitors", home: "Home") == "Visitors at Home")
    let zone = TimeZone(identifier: "America/Los_Angeles")!
    #expect(ScoreboardTarget.localStartTime("2026-09-28T22:05:00Z", zone: zone) == "Mon Sep 28, 2026 3:05 PM")
    #expect(ScoreboardTarget.localStartTime("2026-12-23T00:35:00Z", zone: zone) == "Tue Dec 22, 2026 4:35 PM")
    #expect(ScoreboardTarget.localStartTime("not-a-date", zone: zone) == "not-a-date")
  }

  @Test
  func savedRouteFallsBackToV1UntilATokenExists() {
    let store = InMemorySettingsStore()
    let fresh = ScoreboardTarget.load(store)
    #expect(fresh.route == .v1)
    #expect(fresh.apiServer == ScoreboardTarget.defaultV1Server)
    #expect(fresh.accountServer == ScoreboardTarget.defaultAccountServer)
    #expect(fresh.token == "")

    let chosen = sample(route: .event, token: "tok", gameId: "g1")
    ScoreboardTarget.save(chosen, to: store)
    #expect(ScoreboardTarget.load(store) == chosen)

    store.setString("", forKey: "co.gamestation.cameraman.scoreboard.token")
    #expect(ScoreboardTarget.load(store).route == .v1)
    let out = ScoreboardTarget.signedOut(chosen)
    #expect(out.route == .v1)
    #expect(out.token == "")
    #expect(out.gameId == "g1")
  }

  private func sample(route: ScoreboardRoute, token: String, gameId: String) -> ScoreboardSaved {
    ScoreboardSaved(
      route: route,
      apiServer: "wss://app.gamestation.co",
      v1EventId: "evt",
      accountServer: "https://gamestation.co",
      token: token,
      displayName: "",
      email: "",
      gameId: gameId,
      gameTitle: "Away at Home",
      gameStartAt: "2026-09-28T22:05:00Z"
    )
  }
}
