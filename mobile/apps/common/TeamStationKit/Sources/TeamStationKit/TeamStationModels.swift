import Foundation

/// What TeamStation sends back, and nothing more.
///
/// Every field here is one the app draws or acts on. The server's replies carry
/// more than this — a stream's byte counters, a game's score — and leaving them
/// out is deliberate: a Director that decoded everything would break the day
/// the website grew a field, and it has no use for most of them.

/// A game the Director can be pointed at.
public struct TeamStationEvent: Sendable, Codable, Identifiable, Equatable {
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
public struct TeamStationClaim: Sendable, Codable, Equatable {
  public let gameId: String
  public let url: String
  public let opensAt: Date?
  public let closesAt: Date?
}

public struct TeamStationUser: Sendable, Codable, Equatable {
  public let id: String
  public let displayName: String
  public let email: String?
  public let isAdmin: Bool

  public init(id: String, displayName: String, email: String?, isAdmin: Bool) {
    self.id = id
    self.displayName = displayName
    self.email = email
    self.isAdmin = isAdmin
  }

  /// TeamStation sends `id` as a JSON number (a 53-bit integer). Swift's
  /// default `String` decode refuses that, so a correct sign-in came back
  /// unreadable, the waiting screen never cleared, and the two-second poll
  /// minted a fresh session on every tick.
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    if let text = try? container.decode(String.self, forKey: .id) {
      id = text
    } else {
      let number = try container.decode(Int64.self, forKey: .id)
      id = String(number)
    }
    displayName = try container.decode(String.self, forKey: .displayName)
    email = try container.decodeIfPresent(String.self, forKey: .email)
    isAdmin = try container.decode(Bool.self, forKey: .isAdmin)
  }
}

/**
 * What a Director holds while it waits to be signed in.
 *
 * The request names the sign-in; the secret proves this iPad is the one that
 * asked for it. Somebody taps the button in the e-mail anywhere, and this is
 * what lets the iPad find out and carry on.
 */
public struct TeamStationSignInWait: Sendable, Codable, Equatable {
  public let requestId: String
  public let clientSecret: String
}

/** A poll that has nothing to report yet. Not an error; the usual answer. */
enum TeamStationWaiting: Error {
  case notYet
}

public struct TeamStationSession: Sendable, Codable, Equatable {
  public let token: String
  public let expiresAt: Date
  public let user: TeamStationUser
}

/// This Director's own camera on a game, and why it is not publishing.
public struct TeamStationLiveStream: Sendable, Codable, Equatable {
  public let gameId: String
  public let state: String?
  public let lastError: String?
}

/// What went wrong, in words fit for a screen at a ball field.
public enum TeamStationError: Error, LocalizedError, Equatable {
  /// The request never left the iPad: no network, or the wrong address.
  case offline
  case notSignedIn
  /// The server answered, and said why.
  case server(String)

  public var errorDescription: String? {
    switch self {
    case .offline:
      return "Cannot reach TeamStation. Check the network and try again."
    case .notSignedIn:
      return "Sign in to TeamStation first."
    case let .server(message):
      return message
    }
  }
}

/// The error shape every TeamStation endpoint answers a failure with.
struct TeamStationApiError: Decodable {
  let code: String
  let message: String
}

// MARK: - Sending a recording in

/// An upload the server has opened, and how it wants the recording sent.
public struct TeamStationUpload: Sendable, Codable, Equatable {
  public let uploadId: String
  public let partSize: Int
  public let parts: Int
  public let received: [Int]
}

/// What the server has of an upload so far.
///
/// Asked before sending anything, which is the whole reason an upload from a
/// ball field can be resumed: the app sends what is missing rather than
/// starting a nine-gigabyte recording again because the network blinked.
public struct TeamStationUploadState: Sendable, Codable, Equatable {
  public let uploadId: String
  /// `open`, `assembling`, `ready`, `failed` or `abandoned`.
  public let state: String
  public let partSize: Int
  public let parts: Int
  public let received: [Int]
  public let missing: [Int]
  public let receivedBytes: Int
  /// Which part of taking it in the server is on, while `state` is
  /// `assembling`: `probing`, `remuxing`, `uploading`, `writing`.
  public let step: String?
  public let videoId: String?
  public let message: String?
}

/// What one part landing tells the app.
public struct TeamStationPartTaken: Sendable, Codable, Equatable {
  public let received: Int
  public let parts: Int
  public let missing: [Int]
}

/// The recording is in the library.
/// The answer to "every part is there, take it in".
///
/// **202 with no video.** The server assembles, probes, remuxes and copies
/// the recording before there is a video to name, which for a two-hour take
/// is minutes, so it acknowledges and works behind the request. `videoId`
/// arrives only when the upload was already finished — asking twice gets the
/// same video rather than a second one. Otherwise the app watches
/// `uploadState` until the server says `ready`.
public struct TeamStationUploadFinished: Sendable, Codable, Equatable {
  public let videoId: String?
  public let state: String
  /// Which part of taking it in, when it has started.
  public let step: String?
}
