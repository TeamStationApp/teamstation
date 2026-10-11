import Foundation
import Testing

@testable import TeamStationKit

private let token = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456"
private let appOrigin = URL(string: "https://app1.example.test")!
private let own = "https://api.example.test"

@Suite("Reading a sign-in link")
struct SignInLinkReadTests {
  private func read(_ text: String, app: URL? = appOrigin) -> SignInLink {
    SignInLink.read(URL(string: text)!, appOrigin: app, serverOrigin: own)
  }

  @Test func spendsALinkForThisServerOrNone() {
    #expect(read("https://app1.example.test/signin/\(token)") == .spend(token: token))
    #expect(read("https://APP1.example.test/signin/\(token)?server=https%3A%2F%2Fapi.example.test") == .spend(token: token))
  }

  @Test func asksBeforeSpendingALinkForAnotherName() {
    #expect(
      read("https://app1.example.test/signin/\(token)?server=https%3A%2F%2Fweb.example.test")
        == .confirm(token: token, server: "https://web.example.test")
    )
  }

  @Test func isNoSignInLinkOffTheAppsHostOrPath() {
    #expect(read("https://other.example.test/signin/\(token)") == .notSignIn)
    #expect(read("https://app1.example.test:8443/signin/\(token)") == .notSignIn)
    #expect(read("http://app1.example.test/signin/\(token)") == .notSignIn)
    #expect(read("https://app1.example.test/games/g1") == .notSignIn)
    #expect(read("https://app1.example.test/signin/short") == .notSignIn)
    #expect(read("https://app1.example.test/signin/\(token)/more") == .notSignIn)
    #expect(read("tsdirector://configure?x=1") == .notSignIn)
    #expect(read("https://app1.example.test/signin/\(token)", app: nil) == .notSignIn)
  }

  @Test func saysWhatHappened() {
    #expect(SignInLinkOutcome.signedIn(displayName: "Pat").message == "Signed in to TeamStation as Pat")
    #expect(
      SignInLinkOutcome.wrongServer(server: "https://b.example.test", own: own).message
        == "This link is for https://b.example.test. This app signs in to https://api.example.test."
    )
    #expect(
      SignInLinkOutcome.unreachable(own: own).message
        == "Couldn’t reach https://api.example.test to check this link. Try again."
    )
    #expect(SignInLinkOutcome.notSignIn.message == nil)
    #expect(SignInLinkOutcome.failed("No").message == "No")
  }
}

/// A TeamStation that answers sign-in requests, link spends and discovery as
/// told, and writes down what it was asked.
private final class LinkServer: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var issuer: String? = "https://web.example.test/oauth"
  nonisolated(unsafe) static var refuseLink = false
  /// Discovery answers 503: the server cannot be asked.
  nonisolated(unsafe) static var down = false
  nonisolated(unsafe) static var asked: [String] = []
  nonisolated(unsafe) static var bodies: [String: String] = [:]

  static func reset() {
    issuer = "https://web.example.test/oauth"
    refuseLink = false
    down = false
    asked = []
    bodies = [:]
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let path = request.url!.path()
    Self.asked.append(path)
    Self.bodies[path] = String(data: Self.body(request), encoding: .utf8)
    var status = 200
    var body = "{}"
    switch path {
    case "/oauth/.well-known/openid-configuration":
      if Self.down {
        status = 503
      } else if let issuer = Self.issuer {
        body = #"{"issuer":"\#(issuer)"}"#
      } else {
        status = 404
      }
    case "/api/v1/auth/email-code":
      status = 202
      body = #"{"sent":true,"requestId":"emc_1","clientSecret":"s"}"#
    case "/api/v1/auth/link/verify":
      if Self.refuseLink {
        status = 401
        body = #"{"code":"unauthorized","message":"That link is no longer good"}"#
      } else {
        body = #"{"token":"session","expiresAt":"2027-04-01T00:00:00Z","user":{"id":"7","displayName":"Pat","email":null,"isAdmin":false}}"#
      }
    default:
      status = 404
    }
    let response = HTTPURLResponse(
      url: request.url!, statusCode: status, httpVersion: nil,
      headerFields: [ "content-type": "application/json" ]
    )!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}

  private static func body(_ request: URLRequest) -> Data {
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

@MainActor
private func account(appOrigin app: URL? = appOrigin, keychain: KeychainStore = .inMemory()) -> TeamStationAccount {
  LinkServer.reset()
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [ LinkServer.self ]
  return TeamStationAccount(
    serverURL: URL(string: own)!,
    deviceName: "Bench iPad",
    appOrigin: app,
    keychain: keychain,
    session: URLSession(configuration: configuration)
  )
}

@Suite("Signing in with a link", .serialized)
@MainActor
struct SignInLinkAccountTests {
  @Test func asksForTheLinkToComeToTheAppsHost() async throws {
    let subject = account()
    try await subject.startSignIn(email: "pat@example.com")
    let body = try #require(LinkServer.bodies["/api/v1/auth/email-code"])
    #expect(body.contains(#""appOrigin":"https:\/\/app1.example.test""#))
    #expect(body.contains(#""origin":"ios""#))

    let plain = account(appOrigin: nil)
    try await plain.startSignIn(email: "pat@example.com")
    #expect(LinkServer.bodies["/api/v1/auth/email-code"]?.contains("appOrigin") == false)
  }

  @Test func spendsItsOwnLinkAndKeepsTheSession() async throws {
    let keychain = KeychainStore.inMemory()
    let subject = account(keychain: keychain)
    let outcome = await subject.signIn(link: URL(string: "https://app1.example.test/signin/\(token)")!)
    #expect(outcome == .signedIn(displayName: "Pat"))
    #expect(keychain.token() == "session")
    #expect(subject.user?.displayName == "Pat")
    let body = try #require(LinkServer.bodies["/api/v1/auth/link/verify"])
    #expect(body.contains(#""deviceName":"Bench iPad""#))
    #expect(!LinkServer.asked.contains("/oauth/.well-known/openid-configuration"))
  }

  @Test func namesTheSignInItIsWaitingOnWhenItSpendsItsLink() async throws {
    let subject = account()
    try await subject.startSignIn(email: "pat@example.com")
    #expect(subject.waiting?.requestId == "emc_1")
    let outcome = await subject.signIn(link: URL(string: "https://app1.example.test/signin/\(token)")!)
    #expect(outcome == .signedIn(displayName: "Pat"))
    let body = try #require(LinkServer.bodies["/api/v1/auth/link/verify"])
    #expect(body.contains(#""requestId":"emc_1""#))
    #expect(subject.waiting == nil)

    let fresh = account()
    _ = await fresh.signIn(link: URL(string: "https://app1.example.test/signin/\(token)")!)
    #expect(LinkServer.bodies["/api/v1/auth/link/verify"]?.contains("requestId") == false)
  }

  @Test func spendsALinkItsServerIssuedUnderAnotherName() async {
    let subject = account()
    let outcome = await subject.signIn(
      link: URL(string: "https://app1.example.test/signin/\(token)?server=https%3A%2F%2Fweb.example.test")!
    )
    #expect(outcome == .signedIn(displayName: "Pat"))
    #expect(LinkServer.asked == [ "/oauth/.well-known/openid-configuration", "/api/v1/auth/link/verify" ])
  }

  @Test func neverSendsAnotherServersToken() async {
    let subject = account()
    let outcome = await subject.signIn(
      link: URL(string: "https://app1.example.test/signin/\(token)?server=https%3A%2F%2Fseat.example.test")!
    )
    #expect(outcome == .wrongServer(server: "https://seat.example.test", own: own))
    #expect(!LinkServer.asked.contains("/api/v1/auth/link/verify"))

    // A server with OAuth off answers discovery 404: it vouches for no other name.
    let seat = account()
    LinkServer.issuer = nil
    let noIssuer = await seat.signIn(
      link: URL(string: "https://app1.example.test/signin/\(token)?server=https%3A%2F%2Fweb.example.test")!
    )
    #expect(noIssuer == .wrongServer(server: "https://web.example.test", own: own))

    let silent = account()
    LinkServer.down = true
    let unknown = await silent.signIn(
      link: URL(string: "https://app1.example.test/signin/\(token)?server=https%3A%2F%2Fweb.example.test")!
    )
    // Not asked is not another server's: it says so, and spends nothing.
    #expect(unknown == .unreachable(own: own))
    #expect(silent.lastError == "Couldn’t reach https://api.example.test to check this link. Try again.")
    #expect(!LinkServer.asked.contains("/api/v1/auth/link/verify"))
  }

  @Test func saysSoWhenTheLinkIsSpent() async {
    let subject = account()
    LinkServer.refuseLink = true
    let outcome = await subject.signIn(link: URL(string: "https://app1.example.test/signin/\(token)")!)
    #expect(outcome == .failed("That link is no longer good"))
    #expect(subject.lastError == "That link is no longer good")
  }

  @Test func leavesOtherLinksAlone() async {
    let subject = account()
    #expect(await subject.signIn(link: URL(string: "tsdirector://configure")!) == .notSignIn)
    #expect(LinkServer.asked.isEmpty)
  }
}

@Suite("The app's own link host")
struct AppOriginTests {
  @Test func comesFromTheBundleAsAnOrigin() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "AppOrigin-\(UUID().uuidString).bundle")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    func bundle(_ host: String?) throws -> Bundle {
      var info: [String: Any] = [ "CFBundleIdentifier": "test.example.app" ]
      if let host { info[AppServer.appLinkKey] = host }
      let data = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
      try data.write(to: directory.appending(path: "Info.plist"))
      return try #require(Bundle(url: directory))
    }
    #expect(AppServer.appOrigin(in: try bundle("app1.example.test"))?.absoluteString == "https://app1.example.test")
    let empty = directory.appending(path: "empty.bundle")
    try FileManager.default.createDirectory(at: empty, withIntermediateDirectories: true)
    let data = try PropertyListSerialization.data(fromPropertyList: [ AppServer.appLinkKey: "" ], format: .xml, options: 0)
    try data.write(to: empty.appending(path: "Info.plist"))
    #expect(AppServer.appOrigin(in: try #require(Bundle(url: empty))) == nil)
  }
}
