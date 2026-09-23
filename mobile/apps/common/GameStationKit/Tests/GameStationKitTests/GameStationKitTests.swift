import Foundation
import Testing

@testable import GameStationKit

@Suite struct EventTests {
  @Test func readsWhatTheServerSends() throws {
    let json = """
    [{
      "gameId": "gam_1",
      "startAt": "2026-09-17T22:15:00.000Z",
      "venue": "Vale Field",
      "homeTeamName": "Ravens",
      "awayTeamName": "Titan",
      "homeLogoUrl": null,
      "awayLogoUrl": "https://example.com/a.png",
      "liveState": "none"
    }]
    """
    let events = try GameStationClient.decoder.decode(
      [GameStationEvent].self,
      from: Data(json.utf8)
    )
    #expect(events.count == 1)
    // The away side first: it is `Titan at Ravens`, not the other way round,
    // however the icons are laid out beside it.
    #expect(events[0].title == "Titan at Ravens")
    #expect(events[0].homeLogoURL == nil)
    #expect(events[0].awayLogoURL?.host() == "example.com")
    #expect(events[0].isLive == false)
    #expect(events[0].startAt.timeIntervalSince1970 == 1789683300)
  }

  @Test func readsADateWithoutFractionalSeconds() throws {
    let json = #"{"gameId":"g","url":"rtmp://x/live/k","opensAt":"2026-09-17T20:15:00Z","closesAt":null}"#
    let claim = try GameStationClient.decoder.decode(
      GameStationClaim.self,
      from: Data(json.utf8)
    )
    #expect(claim.opensAt != nil)
    #expect(claim.closesAt == nil)
  }
}

@Suite struct SignInTests {
  @Test func readsWhatTheServerHandsBackToWaitOn() throws {
    // The request names the sign-in and the secret proves this iPad asked for
    // it, which together are how a button tapped on a laptop signs the iPad in.
    let json = #"{"sent":true,"requestId":"emc_abc","clientSecret":"s3cret"}"#
    let wait = try GameStationClient.decoder.decode(
      GameStationSignInWait.self,
      from: Data(json.utf8)
    )
    #expect(wait.requestId == "emc_abc")
    #expect(wait.clientSecret == "s3cret")
  }
}

@Suite struct ErrorTests {
  @Test func readsWhyAStreamWouldNotStart() throws {
    // What `GET /games/{id}/live-stream` answers. The Director asks for this
    // only when a publish failed, and shows `lastError` in place of the
    // socket's own message.
    let json = """
    {
      "gameId": "gam_1",
      "exists": true,
      "state": "publishing",
      "lastError": "This event is already being streamed"
    }
    """
    let stream = try GameStationClient.decoder.decode(
      GameStationLiveStream.self,
      from: Data(json.utf8)
    )
    #expect(stream.state == "publishing")
    #expect(stream.lastError == "This event is already being streamed")
  }

  @Test func readsAStreamWithNothingToSay() throws {
    let json = #"{"gameId":"gam_1","exists":true}"#
    let stream = try GameStationClient.decoder.decode(
      GameStationLiveStream.self,
      from: Data(json.utf8)
    )
    #expect(stream.state == nil)
    #expect(stream.lastError == nil)
  }

  @Test func prefersTheServersOwnSentence() {
    let body = Data(#"{"code":"badRequest","message":"This game has no stream to send to yet."}"#.utf8)
    #expect(GameStationClient.message(from: body, status: 400).hasPrefix("This game has no"))
    #expect(GameStationClient.message(from: Data("<html>".utf8), status: 502) == "GameStation answered 502")
  }
}

/// What a 401 means depends on whether the request carried a token.
///
/// Written after a sign-in that could not be finished: the code was from an
/// e-mail that had been superseded, the server said so plainly, and the app
/// showed "Sign in to GameStation first" — a message that is true of every
/// unauthenticated request and useless on the one screen where somebody is
/// already trying to.
private final class OneAnswer: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var status = 401
  nonisolated(unsafe) static var body = ""

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let response = HTTPURLResponse(
      url: request.url!,
      statusCode: Self.status,
      httpVersion: nil,
      headerFields: [ "content-type": "application/json" ]
    )!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(Self.body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}

@Suite("What a 401 means", .serialized)
struct RefusalTests {
  private func client(token: String?) -> GameStationClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ OneAnswer.self ]
    return GameStationClient(
      baseURL: URL(string: "https://develop.example")!,
      token: token,
      session: URLSession(configuration: configuration)
    )
  }

  @Test func keepsTheServersSentenceWhenSigningIn() async throws {
    OneAnswer.status = 401
    OneAnswer.body = #"{"code":"unauthorized","message":"That code is wrong or has expired"}"#

    await #expect(throws: GameStationError.server("That code is wrong or has expired")) {
      _ = try await client(token: nil).completeSignIn(
        email: "paul@example.com", code: "000000", deviceName: "a Mac"
      )
    }
  }

  @Test func saysToSignInAgainWhenATokenWasRefused() async throws {
    OneAnswer.status = 401
    OneAnswer.body = #"{"code":"unauthorized","message":"Sign in to continue"}"#

    await #expect(throws: GameStationError.notSignedIn) {
      _ = try await client(token: "stale").whoAmI()
    }
  }
}
