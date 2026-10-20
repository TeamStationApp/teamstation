import EventControl
import Foundation
import Testing
import Security
@testable import TeamStationKit

private final class WriteControl: @unchecked Sendable {
  private let lock = NSLock()
  private var allowed = true
  private var attempts = 0
  func allow(_ value: Bool) { lock.withLock { allowed = value } }
  func accept() -> Bool { lock.withLock { attempts += 1; return allowed } }
  var count: Int { lock.withLock { attempts } }
}

private final class SecurityStorage: @unchecked Sendable {
  let lock = NSLock()
  var data: Data?
  var refuse = false
  var adds = 0
  var deletes = 0
  func update(_ query: CFDictionary, _ values: CFDictionary) -> OSStatus {
    lock.withLock {
      if refuse { return errSecInteractionNotAllowed }
      if data == nil { return errSecItemNotFound }
      data = (values as NSDictionary)[kSecValueData] as? Data
      return errSecSuccess
    }
  }
  func add(_ query: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus {
    lock.withLock { adds += 1; data = (query as NSDictionary)[kSecValueData] as? Data; return errSecSuccess }
  }
  func delete(_ query: CFDictionary) -> OSStatus {
    lock.withLock { deletes += 1; data = nil; return errSecSuccess }
  }
}

@Suite("Stored account identity upgrade")
@MainActor
struct StoredAccountIdentityTests {
  @Test func aFreshSecurityServiceHasNoStoredAccount() {
    let store = KeychainStore(service: "test.account-identity.\(UUID().uuidString)")
    #expect(store.token() == nil)
    #expect(store.accountScope() == nil)
    #expect(store.chosenEvent() == nil)
  }
  @Test func securityWriteUpdatesInPlaceAndNeverDeletesOnFailure() {
    let security = SecurityStorage()
    let store = KeychainStore(service: "fixture", update: security.update, add: security.add, delete: security.delete)
    store.setToken("old")
    #expect(security.data == Data("old".utf8))
    #expect(security.adds == 1)
    store.setToken("upgraded")
    #expect(security.data == Data("upgraded".utf8))
    #expect(security.adds == 1)
    security.refuse = true
    store.setToken("refused")
    #expect(security.data == Data("upgraded".utf8))
    #expect(security.deletes == 0)
    store.setToken(nil)
    #expect(security.data == nil)
    #expect(security.deletes == 1)
  }
  @Test func reloadUpgradesOnlyTheIdentityAndWritesItOnce() throws {
    let control = WriteControl()
    let store = KeychainStore.inMemory(acceptWrites: { control.accept() })
    let server = URL(string: "https://app.example.test")!
    store.setToken("fixture-token")
    let chosen = TeamStationAccount.ChosenEvent(
      gameId: "gam_fixture", title: "Visitors at Hosts", startAt: Date(timeIntervalSince1970: 1),
      streamURL: nil, streamId: nil
    )
    store.setChosenEvent(chosen)
    store.write("teamStationAccountScope", data: Data(#"{"server":"https://app.example.test","userId":"9007199254740991"}"#.utf8))
    let before = control.count
    let account = TeamStationAccount(serverURL: server, deviceName: "fixture", keychain: store)
    #expect(account.scope?.userId == "usr_1111111111112DLNrMSKug")
    #expect(account.isEventControlEligible)
    #expect(account.chosen == chosen)
    #expect(store.token() == "fixture-token")
    #expect(control.count == before + 1)
    #expect(store.accountScope() == account.scope)
    #expect(control.count == before + 1)
    let raw = try #require(store.read("teamStationAccountScope"))
    #expect(String(decoding: raw, as: UTF8.self).contains("usr_1111111111112DLNrMSKug"))
    account.serverURL = URL(string: "https://other.example.test")!
    #expect(!account.isEventControlEligible)
  }

  @Test func failedWritePreservesTheSerializedLegacyScopeForRetry() throws {
    let control = WriteControl()
    let store = KeychainStore.inMemory(acceptWrites: { control.accept() })
    let old = Data(#"{"server":"https://app.example.test","userId":"1"}"#.utf8)
    store.write("teamStationAccountScope", data: old)
    control.allow(false)
    #expect(store.accountScope()?.userId == "usr_1111111111111111111112")
    #expect(store.read("teamStationAccountScope") == old)
    control.allow(true)
    #expect(store.accountScope()?.userId == "usr_1111111111111111111112")
    #expect(store.read("teamStationAccountScope") != old)
  }

  @Test func malformedAndMissingIdentitiesNeverBecomeEligible() throws {
    let store = KeychainStore.inMemory()
    #expect(store.accountScope() == nil)
    for raw in ["{}", #"{"server":"https://app.example.test","userId":1}"#,
                #"{"server":"https://app.example.test","userId":"01"}"#,
                #"{"server":"https://app.example.test","userId":"9007199254740992"}"#] {
      let data = Data(raw.utf8)
      store.write("teamStationAccountScope", data: data)
      #expect(store.accountScope() == nil)
      #expect(store.read("teamStationAccountScope") == data)
    }
    for raw in ["1", "\"1\"", "\"usr_1111111111111111111111\""] {
      let data = Data("{\"id\":\(raw),\"displayName\":\"Hank Aaron\",\"isAdmin\":false}".utf8)
      #expect(throws: (any Error).self) { try JSONDecoder().decode(TeamStationUser.self, from: data) }
    }
  }
}
