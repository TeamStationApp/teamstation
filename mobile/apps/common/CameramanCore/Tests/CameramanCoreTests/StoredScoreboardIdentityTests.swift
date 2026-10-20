import CameramanCore
import EventControl
import Foundation
import Testing

private final class RecordingStore: SettingsStore, @unchecked Sendable {
  let memory = InMemorySettingsStore()
  private let lock = NSLock()
  private var deny = false
  private var writes = 0
  var count: Int { lock.withLock { writes } }
  func refuse(_ value: Bool) { lock.withLock { deny = value } }
  func string(forKey key: String) -> String? { memory.string(forKey: key) }
  func setString(_ value: String, forKey key: String) {
    lock.withLock {
      writes += 1
      if !deny { memory.setString(value, forKey: key) }
    }
  }
}

@Suite("Stored scoreboard account identity")
struct StoredScoreboardIdentityTests {
  @Test func hostDoesNotClaimAnIOSMemoryAllowance() {
    #if os(macOS)
    #expect(ProcessLoad.availableMemoryMB() == 0)
    #endif
  }
  private let userKey = "app.teamstation.cameraman.scoreboard.userId"
  private func saved(_ userId: String) -> ScoreboardSaved {
    ScoreboardSaved(route: .event, apiServer: "wss://legacy.example.test", v1EventId: "legacy",
      accountServer: "https://app.example.test", token: "fixture-token", displayName: "Hank Aaron",
      email: "fixture@example.test", gameId: "gam_fixture", gameTitle: "Visitors at Hosts",
      gameStartAt: "2026-01-01T00:00:00Z", userId: userId, allowDirectorOverride: true)
  }

  @Test func upgradesDecimalOnlyAndPreservesTokenServerAndChosenGame() {
    for decimal in ["1", "9007199254740991"] {
      let store = RecordingStore()
      let original = saved(decimal)
      ScoreboardTarget.save(original, to: store)
      let before = store.count
      var expected = original
      expected.userId = TeamStationUserID.fromLegacyDecimal(decimal)!
      #expect(ScoreboardTarget.load(store) == expected)
      #expect(store.string(forKey: userKey) == expected.userId)
      #expect(store.count == before + 1)
      #expect(ScoreboardTarget.load(store) == expected)
      #expect(store.count == before + 1)
      #expect(ScoreboardTarget.target(expected)?.authorization == "Bearer fixture-token")
    }
  }

  @Test func refusedWriteKeepsTheOldValueForRetry() {
    let store = RecordingStore()
    ScoreboardTarget.save(saved("1"), to: store)
    store.refuse(true)
    #expect(ScoreboardTarget.load(store).userId == "usr_1111111111111111111112")
    #expect(store.string(forKey: userKey) == "1")
    store.refuse(false)
    #expect(ScoreboardTarget.load(store).userId == "usr_1111111111111111111112")
    #expect(store.string(forKey: userKey) == "usr_1111111111111111111112")
  }

  @Test func canonicalAndInvalidStoredValuesAreNotRewritten() {
    let store = RecordingStore()
    #expect(ScoreboardTarget.load(store).userId == "")
    for value in ["usr_1111111111111111111112", "", "0", "01", "9007199254740992", "usr_invalid"] {
      ScoreboardTarget.save(saved(value), to: store)
      let before = store.count
      #expect(ScoreboardTarget.load(store).userId == (TeamStationUserID.canonical(value) ?? ""))
      #expect(store.count == before)
      #expect(store.string(forKey: userKey) == value)
    }
    #expect(ScoreboardTarget.decimalUserId("usr_1111111111111111111112") == "usr_1111111111111111111112")
    for raw in [1, true, "1", "usr_invalid"] as [Any] {
      #expect(ScoreboardTarget.decimalUserId(raw) == nil)
    }
    #expect(ScoreboardTarget.decimalUserId(nil) == nil)
  }
}
