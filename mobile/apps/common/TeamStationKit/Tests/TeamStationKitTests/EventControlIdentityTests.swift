import EventControl
import Foundation
import Testing

@testable import TeamStationKit

/// A TeamStation whose answers a test sets per path: a status and a body, or no answer at all
/// (`nil`), which is what an iPad with no network gets.
private final class IdentityServer: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var answers: [String: (Int, String)?] = [:]
  nonisolated(unsafe) static var asked: [String] = []
  /// Runs as each request arrives, before it is answered: what happens while it is on its way.
  nonisolated(unsafe) static var whileAsking: (() -> Void)?

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let path = request.url!.path()
    Self.asked.append("\(request.httpMethod ?? "GET") \(path) \(request.value(forHTTPHeaderField: "authorization") ?? "-")")
    Self.whileAsking?()
    guard let found = Self.answers[path], let (status, body) = found else {
      client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
      return
    }
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

private let keyReply = """
{"version":2,"issuer":"https://app.example.test","userId":"usr_11111111111111111111JG",
 "accountTag":"3ce9e2793f1ced4924b58f9598f81da9","keyId":"5cbbb6482042eb0a",
 "key":"d47b3e64272b9c78fdd34c7439697d44dad28301356c5ba1f0c559dbed3eec04"}
"""
private let me = #"{"id":"usr_11111111111111111111JG","displayName":"Mookie Betts","email":null,"isAdmin":false}"#

private final class SignInWriteControl: @unchecked Sendable {
  private let lock = NSLock()
  private let refusedWrite: Int
  private var writes = 0

  init(refusedWrite: Int) { self.refusedWrite = refusedWrite }
  func accept() -> Bool {
    lock.withLock {
      writes += 1
      return writes != refusedWrite
    }
  }
}

@MainActor
private func account(
  _ keychain: KeychainStore,
  server: String = "https://app.example.test"
) -> TeamStationAccount {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [ IdentityServer.self ]
  return TeamStationAccount(
    serverURL: URL(string: server)!,
    deviceName: "a test",
    keychain: keychain,
    session: URLSession(configuration: configuration)
  )
}

@Suite("Device event-control identity", .serialized)
@MainActor
struct EventControlIdentityTests {
  init() {
    IdentityServer.answers = [:]
    IdentityServer.asked = []
    IdentityServer.whileAsking = nil
  }

  @Test func aSignInRemembersWhoAndWhere() async throws {
    let keychain = KeychainStore.inMemory()
    keychain.setToken("old-token")
    keychain.setAccountScope(TeamStationAccountScope(server: "https://app.example.test", userId: "1001"))
    IdentityServer.answers["/api/v1/auth/email-code/verify"] = (
      200,
      #"{"token":"tok_one","expiresAt":"2027-01-01T00:00:00Z","user":\#(me)}"#
    )
    let signedIn = account(keychain, server: "https://App.Example.Test:443/")
    #expect(!signedIn.hasToken)
    #expect(!signedIn.isEventControlEligible)
    try await signedIn.completeSignIn(email: "one@example.test", code: "123456")
    #expect(signedIn.scope == TeamStationAccountScope(server: "https://app.example.test", userId: "usr_11111111111111111111JG"))
    #expect(keychain.accountScope() == signedIn.scope)
    #expect(signedIn.isEventControlEligible)
    // Pointed at another server, the identity proved on this one does not count.
    signedIn.serverURL = URL(string: "https://develop9.example.test")!
    #expect(!signedIn.isEventControlEligible)
  }

  @Test(arguments: [1, 2])
  func aSignInRetriesAfterEitherCredentialWriteFails(refusedWrite: Int) async throws {
    let control = SignInWriteControl(refusedWrite: refusedWrite)
    let keychain = KeychainStore.inMemory(acceptWrites: { control.accept() })
    let signedIn = account(keychain)
    IdentityServer.answers["/api/v1/auth/email-code/verify"] = (
      200,
      #"{"token":"tok_one","expiresAt":"2027-01-01T00:00:00Z","user":\#(me)}"#
    )
    do {
      try await signedIn.completeSignIn(email: "one@example.test", code: "123456")
      Issue.record("A sign-in that cannot be saved must report failure")
    } catch {
      #expect(error as? TeamStationError == .accountStorageUnavailable)
    }
    #expect(!signedIn.isSignedIn)
    #expect(!signedIn.hasToken)
    #expect(signedIn.scope == nil)
    #expect(signedIn.lastError == TeamStationError.accountStorageUnavailable.localizedDescription)

    try await signedIn.completeSignIn(email: "one@example.test", code: "123456")
    #expect(signedIn.isSignedIn)
    #expect(signedIn.hasToken)
    #expect(signedIn.lastError == nil)
    #expect(keychain.accountScope() == signedIn.scope)
    #expect(account(keychain).isEventControlEligible)
    IdentityServer.answers["/api/v1/device-event-control/key"] = (200, keyReply)
    _ = try await signedIn.deviceEventControlKey()
    #expect(IdentityServer.asked.last == "GET /api/v1/device-event-control/key Bearer tok_one")
  }

  @Test func anOfflineRelaunchStaysEligibleAndAnExplicit401Clears() async {
    let keychain = KeychainStore.inMemory()
    keychain.setToken("tok_one")
    keychain.setAccountScope(TeamStationAccountScope(server: "https://app.example.test", userId: "usr_11111111111111111111JG"))
    // No network: whoAmI fails, user stays nil, the identity stays.
    let offline = account(keychain)
    await offline.restore()
    #expect(offline.user == nil)
    #expect(offline.scope?.userId == "usr_11111111111111111111JG")
    #expect(offline.isEventControlEligible)
    // Back online: the server confirms it.
    IdentityServer.answers["/api/v1/auth/me"] = (200, me)
    await offline.restore()
    #expect(offline.user?.id == "usr_11111111111111111111JG")
    #expect(offline.isEventControlEligible)
    // The server rejects the token: everything goes.
    IdentityServer.answers["/api/v1/auth/me"] = (401, #"{"code":"unauthorized","message":"Sign in to continue"}"#)
    await offline.restore()
    #expect(offline.scope == nil)
    #expect(keychain.accountScope() == nil)
    #expect(!offline.hasToken)
    #expect(!offline.isEventControlEligible)
  }

  @Test func aRelaunchWithoutATokenHasNoIdentity() {
    let keychain = KeychainStore.inMemory()
    keychain.setAccountScope(TeamStationAccountScope(server: "https://app.example.test", userId: "usr_11111111111111111111JG"))
    #expect(account(keychain).scope == nil)
  }

  @Test func signingOutForgetsTheIdentity() {
    let keychain = KeychainStore.inMemory()
    keychain.setToken("tok_one")
    keychain.setAccountScope(TeamStationAccountScope(server: "https://app.example.test", userId: "usr_11111111111111111111JG"))
    let signedIn = account(keychain)
    #expect(signedIn.isEventControlEligible)
    signedIn.signOut()
    #expect(signedIn.scope == nil)
    #expect(keychain.accountScope() == nil)
    #expect(!signedIn.isEventControlEligible)
  }

  @Test func fetchesItsOwnKeyWithItsOwnToken() async throws {
    let keychain = KeychainStore.inMemory()
    keychain.setToken("tok_one")
    keychain.setAccountScope(TeamStationAccountScope(server: "https://app.example.test", userId: "usr_11111111111111111111JG"))
    let signedIn = account(keychain)
    IdentityServer.answers["/api/v1/device-event-control/key"] = (200, keyReply)
    let key = try await signedIn.deviceEventControlKey()
    #expect(IdentityServer.asked == [ "GET /api/v1/device-event-control/key Bearer tok_one" ])
    #expect(key.userId == "usr_11111111111111111111JG")
    #expect(key.issuer == "https://app.example.test")
    #expect(key.keyId == "5cbbb6482042eb0a")
    #expect(signedIn.scope?.userId == "usr_11111111111111111111JG")
    #expect(!key.description.contains(key.key))
    #expect(!key.debugDescription.contains(key.key))
    // The same key again leaves the identity as it was.
    _ = try await signedIn.deviceEventControlKey()
    #expect(keychain.accountScope()?.userId == "usr_11111111111111111111JG")
  }

  @Test func aServerWithoutTheFeatureSaysSoAndChangesNothing() async {
    let keychain = KeychainStore.inMemory()
    keychain.setToken("tok_one")
    keychain.setAccountScope(TeamStationAccountScope(server: "https://app.example.test", userId: "usr_11111111111111111111JG"))
    let signedIn = account(keychain)
    IdentityServer.answers["/api/v1/device-event-control/key"] = (
      503,
      #"{"code":"unavailable","message":"Device event control is not set up on this server","error":"deviceEventControlUnavailable"}"#
    )
    await #expect(throws: TeamStationError.unavailable("Device event control is not set up on this server")) {
      try await signedIn.deviceEventControlKey()
    }
    #expect(signedIn.isEventControlEligible)
    // A server from before the route existed: unavailable too.
    IdentityServer.answers["/api/v1/device-event-control/key"] = (404, #"{"code":"notFound","message":"Not found"}"#)
    await #expect(throws: TeamStationError.unavailable("Not found")) { try await signedIn.deviceEventControlKey() }
    // A server restarting behind its proxy is worth asking again: not unavailable.
    IdentityServer.answers["/api/v1/device-event-control/key"] = (502, "")
    await #expect(throws: TeamStationError.server("TeamStation answered 502")) {
      try await signedIn.deviceEventControlKey()
    }
    #expect(signedIn.isEventControlEligible)
    // Offline: thrown, and the identity kept.
    IdentityServer.answers = [:]
    await #expect(throws: TeamStationError.offline) { try await signedIn.deviceEventControlKey() }
    #expect(signedIn.isEventControlEligible)
  }

  @Test func aRejectedTokenWhileFetchingTheKeySignsOut() async {
    let keychain = KeychainStore.inMemory()
    keychain.setToken("tok_machine")
    keychain.setAccountScope(TeamStationAccountScope(server: "https://app.example.test", userId: "usr_11111111111111111111JG"))
    let signedIn = account(keychain)
    IdentityServer.answers["/api/v1/device-event-control/key"] = (401, #"{"code":"unauthorized","message":"Sign in to continue"}"#)
    await #expect(throws: TeamStationError.notSignedIn) { try await signedIn.deviceEventControlKey() }
    #expect(!signedIn.hasToken)
    #expect(signedIn.scope == nil)
  }

  @Test func aKeyAnsweredAfterTheTokenChangedIsThrownAway() async {
    let keychain = KeychainStore.inMemory()
    keychain.setToken("tok_one")
    let scope = TeamStationAccountScope(server: "https://app.example.test", userId: "usr_11111111111111111111JG")
    keychain.setAccountScope(scope)
    let signedIn = account(keychain)
    // The operator signs in as someone else while the first account's key is on its way.
    IdentityServer.whileAsking = { keychain.setToken("tok_two") }
    IdentityServer.answers["/api/v1/device-event-control/key"] = (200, keyReply)
    await #expect(throws: TeamStationError.accountChanged) { try await signedIn.deviceEventControlKey() }
    #expect(signedIn.scope == scope)
    #expect(keychain.accountScope() == scope)
    // The first token's rejection, arriving late, does not sign the second session out.
    keychain.setToken("tok_one")
    IdentityServer.answers["/api/v1/device-event-control/key"] = (401, #"{"code":"unauthorized","message":"Sign in to continue"}"#)
    await #expect(throws: TeamStationError.accountChanged) { try await signedIn.deviceEventControlKey() }
    #expect(keychain.token() == "tok_two")
    #expect(signedIn.hasToken)
    #expect(TeamStationError.accountChanged.errorDescription?.isEmpty == false)
  }

  @Test func rejectsLegacyGrantsAndNumericIdentities() throws {
    let numeric = keyReply.replacingOccurrences(of: #""userId":"usr_11111111111111111111JG""#, with: #""userId":1001"#)
    let oldVersion = keyReply.replacingOccurrences(of: #""version":2"#, with: #""version":1"#)
    let unversioned = keyReply.replacingOccurrences(of: #""version":2,"#, with: "")
    for invalid in [numeric, oldVersion, unversioned] {
      #expect(throws: (any Error).self) {
        try TeamStationClient.decoder.decode(TeamStationEventControlKey.self, from: Data(invalid.utf8))
      }
    }
    let made = TeamStationEventControlKey(issuer: "i", userId: "usr_1111111111111111111112", accountTag: "a", keyId: "k", key: "s")
    #expect(made.version == 2)
  }

  @Test func originsAreCanonical() {
    func origin(_ text: String) -> String { TeamStationAccountScope.origin(of: URL(string: text)!) }
    #expect(origin("https://App.Example.Test/") == "https://app.example.test")
    #expect(origin("http://192.0.2.4:80/x") == "http://192.0.2.4")
    #expect(origin("http://127.0.0.1:9100") == "http://127.0.0.1:9100")
    #expect(origin("http://[::1]:9100").hasSuffix("]:9100"))
    // The same name device event control files its keys under.
    for text in [ "https://App.Example.Test:443/", "http://192.0.2.4:80/x", "http://[::1]:9100" ] {
      #expect(origin(text) == EventControlCredentials.canonicalOrigin(of: URL(string: text)!))
    }
    #expect(origin("file:///tmp").isEmpty)
  }

  @Test func anOldKeychainHasNoIdentityAndAnUnreadableOneIsIgnored() {
    let keychain = KeychainStore.inMemory()
    #expect(keychain.accountScope() == nil)
    keychain.setAccountScope(TeamStationAccountScope(server: "https://app.example.test", userId: "1"))
    keychain.setAccountScope(nil)
    #expect(keychain.accountScope() == nil)
  }
}
