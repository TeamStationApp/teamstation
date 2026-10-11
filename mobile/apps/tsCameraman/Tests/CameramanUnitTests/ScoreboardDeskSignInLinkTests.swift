import CameramanCore
@testable import CameramanUI
import EventControl
import Foundation
import TeamStationKit
import Testing

private let token = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456"
private let appOrigin = URL(string: "https://app1.example.test")!

/// An account server that answers a sign-in's requests and writes down every path and body.
private final class LinkServer: @unchecked Sendable {
  private let lock = NSLock()
  private var log: [(path: String, body: String)] = []
  var issuer: String? = "https://web.example.test/oauth"
  /// Discovery answers 503: the server cannot be asked.
  var down = false
  var refuseLink = false

  var requests: [(path: String, body: String)] { lock.withLock { log } }
  func body(_ path: String) -> String? { requests.last { $0.path == path }?.body }

  var http: ScoreboardHTTP {
    { [self] request in
      let url = request.url!
      let body = request.httpBody.flatMap { String(data: $0, encoding: .utf8) } ?? ""
      lock.withLock { log.append((url.path, body)) }
      var status = 200
      var json: Any = [String: Any]()
      switch url.path {
      case "/oauth/.well-known/openid-configuration":
        if down { status = 503 } else if let issuer { json = [ "issuer": issuer ] } else { status = 404 }
      case "/api/v1/auth/email-code":
        status = 202
        json = [ "sent": true, "requestId": "emc_1", "clientSecret": "s" ]
      case "/api/v1/auth/link/verify" where refuseLink:
        status = 401
        json = [ "code": "unauthorized", "message": "That link is no longer good" ]
      case "/api/v1/auth/link/verify":
        json = [
          "token": "session",
          "expiresAt": "2027-04-01T00:00:00Z",
          "user": [ "id": "1001", "displayName": "Mookie Betts", "email": "one@example.test" ]
        ]
      default:
        status = 404
      }
      let data = try JSONSerialization.data(withJSONObject: json)
      return (data, HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
  }
}

@MainActor
private func desk(_ server: LinkServer, appOrigin app: URL? = appOrigin) -> ScoreboardDesk {
  let store = InMemorySettingsStore()
  return ScoreboardDesk(store: store, appOrigin: app, http: server.http, openSocket: FakeScoreboardSockets().opener)
}

@Suite("Signing the desk in with a link", .serialized)
@MainActor
struct ScoreboardDeskSignInLinkTests {
  @Test
  func asksForTheLinkToComeToTheAppsHost() async {
    let server = LinkServer()
    let board = desk(server)
    board.sendCode(email: "one@example.test")
    #expect(await eventually { server.body("/api/v1/auth/email-code") != nil })
    let body = server.body("/api/v1/auth/email-code") ?? ""
    #expect(body.contains(#""appOrigin":"https:\/\/app1.example.test""#))

    let plain = LinkServer()
    let unlinked = desk(plain, appOrigin: nil)
    unlinked.sendCode(email: "one@example.test")
    #expect(await eventually { plain.body("/api/v1/auth/email-code") != nil })
    #expect(plain.body("/api/v1/auth/email-code")?.contains("appOrigin") == false)
  }

  @Test
  func signsInWithItsOwnLink() async {
    let server = LinkServer()
    let board = desk(server)
    let outcome = await board.signIn(link: URL(string: "https://app1.example.test/signin/\(token)")!)
    #expect(outcome == .signedIn(displayName: "Mookie Betts"))
    #expect(board.isSignedIn)
    #expect(board.userId == "1001")
    #expect(server.body("/api/v1/auth/link/verify")?.contains(#""deviceName":"TS Cameraman""#) == true)
  }

  @Test
  func signsInWhenAnotherNameIsItsServersIssuer() async {
    let server = LinkServer()
    let board = desk(server)
    let outcome = await board.signIn(
      link: URL(string: "https://app1.example.test/signin/\(token)?server=https%3A%2F%2Fweb.example.test")!
    )
    #expect(outcome == .signedIn(displayName: "Mookie Betts"))
  }

  @Test
  func neverSendsAnotherServersToken() async {
    let server = LinkServer()
    let board = desk(server)
    let outcome = await board.signIn(
      link: URL(string: "https://app1.example.test/signin/\(token)?server=https%3A%2F%2Fseat.example.test")!
    )
    guard case let .wrongServer(server: named, own: _) = outcome else {
      Issue.record("expected a wrong-server outcome, got \(outcome)")
      return
    }
    #expect(named == "https://seat.example.test")
    #expect(!server.requests.contains { $0.path == "/api/v1/auth/link/verify" })
    #expect(board.snapshot.status.hasPrefix("This link is for https://seat.example.test."))
    #expect(!board.isSignedIn)
  }

  @Test
  func callsALinkAnotherServersWhenItsServerNamesNoIssuer() async {
    let server = LinkServer()
    server.issuer = nil
    let board = desk(server)
    let outcome = await board.signIn(
      link: URL(string: "https://app1.example.test/signin/\(token)?server=https%3A%2F%2Fweb.example.test")!
    )
    guard case .wrongServer = outcome else {
      Issue.record("expected a wrong-server outcome, got \(outcome)")
      return
    }
    #expect(!server.requests.contains { $0.path == "/api/v1/auth/link/verify" })
  }

  @Test
  func saysWhenItCouldNotAskItsServer() async {
    let server = LinkServer()
    server.down = true
    let board = desk(server)
    let outcome = await board.signIn(
      link: URL(string: "https://app1.example.test/signin/\(token)?server=https%3A%2F%2Fweb.example.test")!
    )
    guard case .unreachable = outcome else {
      Issue.record("expected an unreachable outcome, got \(outcome)")
      return
    }
    #expect(!server.requests.contains { $0.path == "/api/v1/auth/link/verify" })
    #expect(board.snapshot.status.hasPrefix("Couldn’t reach "))
    #expect(!board.isSignedIn)
  }

  @Test
  func leavesOtherAddressesAlone() async {
    let server = LinkServer()
    let board = desk(server)
    #expect(await board.signIn(link: URL(string: "https://other.example.test/signin/\(token)")!) == .notSignIn)
    #expect(server.requests.isEmpty)
  }

  @Test
  func saysSoWhenTheLinkIsSpent() async {
    let server = LinkServer()
    server.refuseLink = true
    let board = desk(server)
    let outcome = await board.signIn(link: URL(string: "https://app1.example.test/signin/\(token)")!)
    guard case .failed = outcome else {
      Issue.record("expected a failure, got \(outcome)")
      return
    }
    #expect(!board.isSignedIn)
    #expect(!board.snapshot.status.isEmpty)
  }

  @Test
  func theAppHandsOnlyWebAddressesToTheDesk() async {
    let server = LinkServer()
    let environment = AppEnvironment(
      broadcastStore: InMemorySettingsStore(),
      eventControlKeys: .inMemory(),
      scoreboardHTTP: server.http,
      scoreboardSockets: FakeScoreboardSockets().opener
    )
    defer { environment.eventOverride.listener.stop() }
    environment.handleSignInLink(URL(string: "tscameraman://test/x")!)
    environment.handleSignInLink(URL(string: "https://other.example.test/signin/\(token)")!)
    try? await Task.sleep(for: .milliseconds(200))
    #expect(!server.requests.contains { $0.path == "/api/v1/auth/link/verify" })
  }

  @Test
  func theAppSaysWhatALinkDidOverWhicheverScreenIsUp() async {
    let server = LinkServer()
    let environment = AppEnvironment(
      broadcastStore: InMemorySettingsStore(),
      eventControlKeys: .inMemory(),
      scoreboardHTTP: server.http,
      scoreboardSockets: FakeScoreboardSockets().opener
    )
    defer { environment.eventOverride.listener.stop() }
    environment.linkMessageDuration = .milliseconds(300)
    environment.handleSignInLink(URL(string: "tscameraman://test/x")!)
    #expect(environment.linkMessage == nil)

    environment.showLinkMessage("This link is for https://seat.example.test. This app signs in to https://api.example.test.")
    environment.showLinkMessage(nil)
    #expect(environment.linkMessage?.hasPrefix("This link is for https://seat.example.test.") == true)
    try? await Task.sleep(for: .milliseconds(100))
    environment.showLinkMessage("Signed in to TeamStation as Pat")
    try? await Task.sleep(for: .milliseconds(250))
    #expect(environment.linkMessage == "Signed in to TeamStation as Pat")
    try? await Task.sleep(for: .milliseconds(300))
    #expect(environment.linkMessage == nil)
  }
}
