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

  @Test func legacyAndMalformedAccountsAreSignedOutAndStaySignedOut() {
    for value in ["1", "9007199254740991", "", "0", "01", "9007199254740992", "usr_invalid"] {
      let store = RecordingStore()
      let original = saved(value)
      ScoreboardTarget.save(original, to: store)
      let expected = ScoreboardTarget.signedOut(original)
      #expect(ScoreboardTarget.load(store) == expected)
      #expect(store.string(forKey: userKey) == "")
      #expect(ScoreboardTarget.load(store) == expected)
      #expect(ScoreboardTarget.target(expected)?.authorization == nil)
    }
  }

  @Test func refusedRemovalStillReturnsSignedOutAndRetriesNextLoad() {
    let store = RecordingStore()
    let original = saved("1")
    ScoreboardTarget.save(original, to: store)
    store.refuse(true)
    #expect(ScoreboardTarget.load(store) == ScoreboardTarget.signedOut(original))
    #expect(store.string(forKey: userKey) == "1")
    store.refuse(false)
    #expect(ScoreboardTarget.load(store) == ScoreboardTarget.signedOut(original))
    #expect(store.string(forKey: userKey) == "")
  }

  @Test func canonicalAccountsIncludingANewSignInArePreservedWithoutWrites() {
    let store = RecordingStore()
    #expect(ScoreboardTarget.load(store).token == "")
    ScoreboardTarget.save(saved("1"), to: store)
    #expect(ScoreboardTarget.load(store).token == "")
    let current = saved("usr_1111111111111111111112")
    ScoreboardTarget.save(current, to: store)
    let before = store.count
    #expect(ScoreboardTarget.load(store) == current)
    #expect(store.count == before)
    #expect(ScoreboardTarget.target(current)?.authorization == "Bearer fixture-token")
    #expect(ScoreboardTarget.decimalUserId(current.userId) == current.userId)
    for raw in [1, true, "1", "usr_invalid"] as [Any] {
      #expect(ScoreboardTarget.decimalUserId(raw) == nil)
    }
    #expect(ScoreboardTarget.decimalUserId(nil) == nil)
  }
}
