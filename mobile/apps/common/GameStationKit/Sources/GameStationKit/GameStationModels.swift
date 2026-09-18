import Foundation

/// What GameStation sends back, and nothing more.
///
/// Every field here is one the app draws or acts on. The server's replies carry
/// more than this — a stream's byte counters, a game's score — and leaving them
/// out is deliberate: a Director that decoded everything would break the day
/// the website grew a field, and it has no use for most of them.

/// A game the Director can be pointed at.
public struct GameStationEvent: Sendable, Codable, Identifiable, Equatable {
  public let gameId: String
  public let startAt: Date
  public let venue: String?
  public let homeTeamName: String
  public let awayTeamName: String
  public let homeLogoURL: URL?
  public let awayLogoURL: URL?
  /// `none`, `idle`, `publishing` or `ended` — what the game's stream is doing.
  public let liveState: String

  public var id: String { gameId }

  /// `Trosky at Rangers` — the away side first, the way a game is spoken of.
  public var title: String { "\(awayTeamName) at \(homeTeamName)" }

  public var isLive: Bool { liveState == "publishing" }

  enum CodingKeys: String, CodingKey {
    case gameId, startAt, venue, homeTeamName, awayTeamName
    case homeLogoURL = "homeLogoUrl"
    case awayLogoURL = "awayLogoUrl"
    case liveState
  }

  public init(
    gameId: String,
    startAt: Date,
    venue: String?,
    homeTeamName: String,
    awayTeamName: String,
    homeLogoURL: URL?,
    awayLogoURL: URL?,
    liveState: String
  ) {
    self.gameId = gameId
    self.startAt = startAt
    self.venue = venue
    self.homeTeamName = homeTeamName
    self.awayTeamName = awayTeamName
    self.homeLogoURL = homeLogoURL
    self.awayLogoURL = awayLogoURL
    self.liveState = liveState
  }
}

/// Taking a game: where to publish it, which the operator never sees.
public struct GameStationClaim: Sendable, Codable, Equatable {
  public let gameId: String
  public let url: String
  public let opensAt: Date?
  public let closesAt: Date?
}

public struct GameStationUser: Sendable, Codable, Equatable {
  public let id: String
  public let displayName: String
  public let email: String?
  public let isAdmin: Bool
}

/**
 * What a Director holds while it waits to be signed in.
 *
 * The request names the sign-in; the secret proves this iPad is the one that
 * asked for it. Somebody taps the button in the e-mail anywhere, and this is
 * what lets the iPad find out and carry on.
 */
public struct GameStationSignInWait: Sendable, Codable, Equatable {
  public let requestId: String
  public let clientSecret: String
}

/** A poll that has nothing to report yet. Not an error; the usual answer. */
enum GameStationWaiting: Error {
  case notYet
}

public struct GameStationSession: Sendable, Codable, Equatable {
  public let token: String
  public let expiresAt: Date
  public let user: GameStationUser
}

/// This Director's own camera on a game, and why it is not publishing.
public struct GameStationLiveStream: Sendable, Codable, Equatable {
  public let gameId: String
  public let state: String?
  public let lastError: String?
}

/// What went wrong, in words fit for a screen at a ball field.
public enum GameStationError: Error, LocalizedError, Equatable {
  /// The request never left the iPad: no network, or the wrong address.
  case offline
  case notSignedIn
  /// The server answered, and said why.
  case server(String)

  public var errorDescription: String? {
    switch self {
    case .offline:
      return "Cannot reach GameStation. Check the network and try again."
    case .notSignedIn:
      return "Sign in to GameStation first."
    case let .server(message):
      return message
    }
  }
}

/// The error shape every GameStation endpoint answers a failure with.
struct GameStationApiError: Decodable {
  let code: String
  let message: String
}
