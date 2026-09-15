import Distribution
import DistributorWire
import Foundation
import PeerTubeKit
import Testing

/// GS Director as an upload's token source sees it: connected or not, and what it hands over.
actor TokenDirector {
  var connected: Bool
  private(set) var fetches = 0
  let hands: PeerTubeToken?

  init(connected: Bool, hands: PeerTubeToken?) {
    self.connected = connected
    self.hands = hands
  }

  func connect() { connected = true }

  func fetch() throws -> PeerTubeToken {
    fetches += 1
    guard let hands else { throw PeerTubeError.signInAgain }
    return hands
  }
}

@Suite("Upload tokens")
struct UploadTokenSourceTests {
  static func token(_ value: String, minutesLeft: Double) -> PeerTubeToken {
    PeerTubeToken(host: "tube.example", username: "paul", accessToken: value, expiresAt: Date().addingTimeInterval(minutesLeft * 60))
  }

  static func source(_ director: TokenDirector, held: PeerTubeToken?, patience: Duration = .seconds(5)) -> UploadTokenSource {
    UploadTokenSource(
      held: held,
      patience: patience,
      poll: .milliseconds(10),
      isConnected: { await director.connected },
      fetch: { try await director.fetch() }
    )
  }

  @Test("A token PeerTube still honours is used while GS Director is away")
  func keepsHeldToken() async throws {
    let director = TokenDirector(connected: false, hands: Self.token("fresh", minutesLeft: 1_440))
    let tokens = Self.source(director, held: Self.token("held", minutesLeft: 60))
    #expect(try await tokens.accessToken() == "held")
    #expect(await director.fetches == 0)
  }

  @Test("A token about to run out waits for GS Director to come back, then takes a fresh one")
  func waitsForDirector() async throws {
    let director = TokenDirector(connected: false, hands: Self.token("fresh", minutesLeft: 1_440))
    let tokens = Self.source(director, held: Self.token("held", minutesLeft: 1))
    Task {
      try await Task.sleep(for: .milliseconds(60))
      await director.connect()
    }
    #expect(try await tokens.accessToken() == "fresh")
    #expect(try await tokens.accessToken() == "fresh")
    #expect(await director.fetches == 1)
  }

  @Test("GS Director away past the patience says so, rather than blaming the sign-in")
  func directorAwayTooLong() async throws {
    let director = TokenDirector(connected: false, hands: Self.token("fresh", minutesLeft: 1_440))
    let tokens = Self.source(director, held: nil, patience: .milliseconds(50))
    await #expect(throws: UploadTokenSource.DirectorAway.self) { _ = try await tokens.accessToken() }
  }

  @Test("An account GS Director no longer has fails at once")
  func signedOut() async throws {
    let director = TokenDirector(connected: true, hands: nil)
    let tokens = Self.source(director, held: nil)
    await #expect(throws: PeerTubeError.signInAgain) { _ = try await tokens.accessToken() }
    #expect(await director.fetches == 1)
  }
}
