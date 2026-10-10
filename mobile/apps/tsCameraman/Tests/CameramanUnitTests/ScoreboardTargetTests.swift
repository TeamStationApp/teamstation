import CameramanCore
import Foundation
import Testing

@Suite("Scoreboard target")
struct ScoreboardTargetTests {
  @Test
  func v1UsesTheServerStringAsTypedAndAnEventConvertsToASocket() {
    #expect(
      ScoreboardTarget.v1Url("wss://app.teamstation.app/", eventId: "game 1")
        == "wss://app.teamstation.app/sockets/api/v1/autoState/game%201"
    )
    #expect(ScoreboardTarget.v1Url("wss://app.teamstation.app", eventId: "") == nil)
    #expect(ScoreboardTarget.v1Url("", eventId: "game") == nil)
    let event = ScoreboardTarget.eventTarget("https://app.teamstation.app/", gameId: "game 1", token: "token")
    #expect(event?.url == "wss://app.teamstation.app/api/v1/scoreboard/game%201/publish")
    #expect(event?.authorization == "Bearer token")
    #expect(ScoreboardTarget.socketOrigin("http://10.0.2.2:9100/") == "ws://10.0.2.2:9100")
    #expect(ScoreboardTarget.httpOrigin("wss://app.teamstation.app/") == "https://app.teamstation.app")
    #expect(ScoreboardTarget.eventTarget("https://app.teamstation.app", gameId: "game", token: "") == nil)
  }

  @Test
  func eventRouteWaitsForATokenAndAChosenGame() {
    let saved = sample(route: .event, token: "", gameId: "g")
    #expect(ScoreboardTarget.effectiveRoute(saved.route, token: saved.token) == .v1)
    #expect(
      ScoreboardTarget.target(saved)?.url
        == "wss://app.teamstation.app/sockets/api/v1/autoState/evt"
    )
    let signedIn = sample(route: .event, token: "tok", gameId: "")
    #expect(ScoreboardTarget.target(signedIn) == nil)
    let live = sample(route: .event, token: "tok", gameId: "g1")
    #expect(ScoreboardTarget.target(live)?.url == "wss://app.teamstation.app/api/v1/scoreboard/g1/publish")
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
    #expect(ScoreboardTarget.accountHost(primaryHost: nil) == "app.teamstation.app")
    #expect(ScoreboardTarget.accountHost(primaryHost: "") == "app.teamstation.app")
    #expect(ScoreboardTarget.accountHost(primaryHost: "$(TS_PRIMARY_HOST)") == "app.teamstation.app")
    #expect(ScoreboardTarget.accountOrigin(primaryHost: nil) == "https://app.teamstation.app")
    #expect(
      ScoreboardTarget.accountHost(primaryHost: "https://devhost3.example-ts.test/")
        == "devhost3.example-ts.test"
    )
    #expect(
      ScoreboardTarget.accountOrigin(primaryHost: "devhost3.example-ts.test")
        == "https://devhost3.example-ts.test"
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

    store.setString("", forKey: "app.teamstation.cameraman.scoreboard.token")
    #expect(ScoreboardTarget.load(store).route == .v1)
    let out = ScoreboardTarget.signedOut(chosen)
    #expect(out.route == .v1)
    #expect(out.token == "")
    #expect(out.gameId == "g1")
  }

  @Test
  func aLoginSavedBeforeUserIdsReadsBackWithNoneAndConsentOff() {
    // Exactly the keys an earlier build wrote, one at a time.
    let store = InMemorySettingsStore(values: [
      "app.teamstation.cameraman.scoreboard.route": "event",
      "app.teamstation.cameraman.scoreboard.token": "tok",
      "app.teamstation.cameraman.scoreboard.gameId": "g1",
      "app.teamstation.cameraman.scoreboard.gameTitle": "Away at Home",
      "app.teamstation.cameraman.scoreboard.gameStartAt": "2026-09-28T22:05:00Z"
    ])
    let loaded = ScoreboardTarget.load(store)
    #expect(loaded.route == .event)
    #expect(loaded.gameId == "g1")
    #expect(loaded.gameTitle == "Away at Home")
    #expect(loaded.userId == "")
    #expect(loaded.allowDirectorOverride == false)
  }

  @Test
  func theUserIdConsentAndGameRoundTripAndTheGameIsOneRecord() {
    let store = InMemorySettingsStore()
    var saved = sample(route: .event, token: "tok", gameId: "g1")
    saved.userId = "1001"
    saved.allowDirectorOverride = true
    ScoreboardTarget.save(saved, to: store)
    #expect(ScoreboardTarget.load(store) == saved)
    let record = store.string(forKey: "app.teamstation.cameraman.scoreboard.game") ?? ""
    #expect(record.contains("\"gameId\":\"g1\""))
    #expect(record.contains("\"title\":\"Away at Home\""))
    // The one record wins over the separate keys, which an older build may still read.
    store.setString("stale", forKey: "app.teamstation.cameraman.scoreboard.gameId")
    #expect(ScoreboardTarget.load(store).gameId == "g1")
    store.setString("not json", forKey: "app.teamstation.cameraman.scoreboard.game")
    #expect(ScoreboardTarget.load(store).gameId == "stale")
    store.setString("12x", forKey: "app.teamstation.cameraman.scoreboard.userId")
    #expect(ScoreboardTarget.load(store).userId == "")

    let out = ScoreboardTarget.signedOut(saved)
    #expect(out.userId == "")
    #expect(out.allowDirectorOverride)
  }

  @Test
  func anAssignmentChangesTheGameOnly() {
    var saved = sample(route: .v1, token: "tok", gameId: "g1")
    saved.userId = "1001"
    let next = ScoreboardTarget.assigning(saved, gameId: "g2", title: "Visitors at Pioneers", startAt: "2026-09-21T17:30:00Z")
    #expect(next.gameId == "g2")
    #expect(next.gameTitle == "Visitors at Pioneers")
    #expect(next.gameStartAt == "2026-09-21T17:30:00Z")
    var back = next
    back.gameId = saved.gameId
    back.gameTitle = saved.gameTitle
    back.gameStartAt = saved.gameStartAt
    #expect(back == saved)
  }

  @Test
  func userIdsAreReadAsDecimal() {
    #expect(ScoreboardTarget.decimalUserId("1001") == "1001")
    #expect(ScoreboardTarget.decimalUserId(" 1001 ") == "1001")
    #expect(ScoreboardTarget.decimalUserId("0042") == "42")
    #expect(ScoreboardTarget.decimalUserId(1001) == "1001")
    #expect(ScoreboardTarget.decimalUserId(NSNumber(value: 9_007_199_254_740_993 as Int64)) == "9007199254740993")
    #expect(ScoreboardTarget.decimalUserId(NSNumber(value: 1.5)) == nil)
    #expect(ScoreboardTarget.decimalUserId(0) == nil)
    #expect(ScoreboardTarget.decimalUserId(-3) == nil)
    #expect(ScoreboardTarget.decimalUserId(true) == nil)
    #expect(ScoreboardTarget.decimalUserId("0") == nil)
    #expect(ScoreboardTarget.decimalUserId("") == nil)
    #expect(ScoreboardTarget.decimalUserId("12a") == nil)
    #expect(ScoreboardTarget.decimalUserId(String(repeating: "9", count: 33)) == nil)
    #expect(ScoreboardTarget.decimalUserId(nil) == nil)
    #expect(ScoreboardTarget.decimalUserId([ "id": 1 ]) == nil)
  }

  @Test
  func changeGameIsOffOnlyWhileADirectorHoldsTheEvent() {
    var snapshot = ScoreboardSnapshot(signedIn: true, gameTitle: "Pioneers at Comets")
    #expect(snapshot.canPickEvent)
    snapshot.overrideHost = "192.0.2.10"
    #expect(snapshot.canPickEvent == false)
    #expect(snapshot.gameTitle == "Pioneers at Comets")
    snapshot.overrideHost = ""
    #expect(snapshot.canPickEvent)
  }

  @Test
  func theSnapshotSaysWhenADirectorHoldsTheEvent() {
    var snapshot = ScoreboardSnapshot(signedIn: true)
    #expect(snapshot.eventLocked == false)
    #expect(snapshot.overrideLine == "")
    #expect(snapshot.canPickEvent)
    snapshot.overrideHost = "192.0.2.10"
    #expect(snapshot.eventLocked)
    #expect(snapshot.overrideLine == "Override from Director 192.0.2.10")
    #expect(snapshot.canPickEvent == false)
    #expect(ScoreboardSnapshot(signedIn: false).canPickEvent == false)
    let defaults = ScoreboardSnapshot()
    #expect(defaults.allowDirectorOverride == false)
    #expect(defaults.eventControlStatus == "")
  }

  private func sample(route: ScoreboardRoute, token: String, gameId: String) -> ScoreboardSaved {
    ScoreboardSaved(
      route: route,
      apiServer: "wss://app.teamstation.app",
      v1EventId: "evt",
      accountServer: "https://app.teamstation.app",
      token: token,
      displayName: "",
      email: "",
      gameId: gameId,
      gameTitle: "Away at Home",
      gameStartAt: "2026-09-28T22:05:00Z"
    )
  }
}
