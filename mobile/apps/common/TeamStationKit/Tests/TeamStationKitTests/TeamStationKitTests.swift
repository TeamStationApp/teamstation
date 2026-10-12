import Foundation
import Testing

@testable import TeamStationKit

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
    let events = try TeamStationClient.decoder.decode(
      [TeamStationEvent].self,
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
    let json = """
    {"gameId":"g","startAt":"2026-09-17T20:15:00Z","venue":null,"homeTeamName":"Ravens",
     "awayTeamName":"Titan","homeLogoUrl":null,"awayLogoUrl":null,"liveState":"idle"}
    """
    let event = try TeamStationClient.decoder.decode(TeamStationEvent.self, from: Data(json.utf8))
    #expect(event.startAt.timeIntervalSince1970 == 1789676100)
  }
}

@Suite struct SignInTests {
  @Test func readsWhatTheServerHandsBackToWaitOn() throws {
    // The request names the sign-in and the secret proves this iPad asked for
    // it, which together are how a button tapped on a laptop signs the iPad in.
    let json = #"{"sent":true,"requestId":"emc_abc","clientSecret":"s3cret"}"#
    let wait = try TeamStationClient.decoder.decode(
      TeamStationSignInWait.self,
      from: Data(json.utf8)
    )
    #expect(wait.requestId == "emc_abc")
    #expect(wait.clientSecret == "s3cret")
  }

  @Test func readsASessionWhoseUserIdIsANumber() throws {
    // asUserId on the server is a JSON number. A String-only decode left the
    // Director flashing on the code screen while minting a session every poll.
    let json = """
    {
      "token": "tok_x",
      "expiresAt": "2027-03-26T04:56:21.869Z",
      "user": {
        "id": 7131311135112542,
        "displayName": "root",
        "email": "paul@vtex.net",
        "isAdmin": true,
        "avatarUrl": null
      }
    }
    """
    let session = try TeamStationClient.decoder.decode(
      TeamStationSession.self,
      from: Data(json.utf8)
    )
    #expect(session.user.id == "7131311135112542")
    #expect(session.user.email == "paul@vtex.net")
    #expect(session.user.isAdmin)
  }

  @Test func stillReadsASessionWhoseUserIdIsText() throws {
    let json = """
    {
      "token": "tok_y",
      "expiresAt": "2027-03-26T04:56:21Z",
      "user": {
        "id": "7131311135112542",
        "displayName": "root",
        "isAdmin": false
      }
    }
    """
    let session = try TeamStationClient.decoder.decode(
      TeamStationSession.self,
      from: Data(json.utf8)
    )
    #expect(session.user.id == "7131311135112542")
    #expect(session.user.email == nil)
  }
}

@Suite struct ErrorTests {
  @Test func readsWhyAStreamWouldNotStart() throws {
    // What `GET /games/{id}/live-streams` answers. The Director asks for this
    // only when a publish failed, and shows its own row's `lastError` in place
    // of the socket's own message.
    let json = """
    {
      "gameId": "gam_1",
      "mine": [{
        "id": "lst_1", "gameId": "gam_1", "userId": 7, "ownerName": "Mookie Betts", "slot": 1,
        "label": "Center Field", "keyPrefix": "abcd", "state": "publishing",
        "opensAt": "2026-09-17T20:15:00.000Z", "closesAt": null, "videoId": null,
        "lastError": "This event is already being streamed", "status": null,
        "deviceId": "00000000-0000-4000-8000-000000000001", "deviceModel": "iPad Pro",
        "localRecording": "none"
      }],
      "others": [{
        "id": "lst_2", "gameId": "gam_1", "label": "Home Plate", "state": "idle",
        "lastError": null, "deviceModel": "iPhone 13 Pro"
      }],
      "canAdd": 3,
      "maxCameras": 4
    }
    """
    let streams = try TeamStationClient.decoder.decode(
      TeamStationGameStreams.self,
      from: Data(json.utf8)
    )
    #expect(streams.mine.first?.state == "publishing")
    #expect(streams.mine.first?.lastError == "This event is already being streamed")
    #expect(streams.mine.first?.deviceId == "00000000-0000-4000-8000-000000000001")
    #expect(streams.others.first?.deviceModel == "iPhone 13 Pro")
    #expect(streams.others.first?.deviceId == nil)
  }

  @Test func readsAStreamWithNothingToSay() throws {
    let json = #"{"id":"lst_1","gameId":"gam_1"}"#
    let stream = try TeamStationClient.decoder.decode(
      TeamStationDeviceStream.self,
      from: Data(json.utf8)
    )
    #expect(stream.state == nil)
    #expect(stream.lastError == nil)
    #expect(stream.url == nil)
  }

  @Test func saysWhatAnEndedStreamMeans() {
    #expect(
      TeamStationError.streamEnded.localizedDescription
        == "This camera was ended. Start streaming again to go live."
    )
  }

  @Test func prefersTheServersOwnSentence() {
    let body = Data(#"{"code":"badRequest","message":"This game has no stream to send to yet."}"#.utf8)
    #expect(TeamStationClient.message(from: body, status: 400).hasPrefix("This game has no"))
    #expect(TeamStationClient.message(from: Data("<html>".utf8), status: 502) == "TeamStation answered 502")
  }
}

/// What a 401 means depends on whether the request carried a token.
///
/// Written after a sign-in that could not be finished: the code was from an
/// e-mail that had been superseded, the server said so plainly, and the app
/// showed "Sign in to TeamStation first" — a message that is true of every
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
  private func client(token: String?) -> TeamStationClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ OneAnswer.self ]
    return TeamStationClient(
      baseURL: URL(string: "https://develop.example")!,
      token: token,
      session: URLSession(configuration: configuration)
    )
  }

  @Test func keepsTheServersSentenceWhenSigningIn() async throws {
    OneAnswer.status = 401
    OneAnswer.body = #"{"code":"unauthorized","message":"That code is wrong or has expired"}"#

    await #expect(throws: TeamStationError.server("That code is wrong or has expired")) {
      _ = try await client(token: nil).completeSignIn(
        email: "paul@example.com", code: "000000", deviceName: "a Mac"
      )
    }
  }

  @Test func saysToSignInAgainWhenATokenWasRefused() async throws {
    OneAnswer.status = 401
    OneAnswer.body = #"{"code":"unauthorized","message":"Sign in to continue"}"#

    await #expect(throws: TeamStationError.notSignedIn) {
      _ = try await client(token: "stale").whoAmI()
    }
  }
}
