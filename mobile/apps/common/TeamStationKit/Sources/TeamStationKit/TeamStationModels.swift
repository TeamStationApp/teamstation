import EventControl
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

  /// `Titan at Ravens` — the away side first, the way a game is spoken of.
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

  /// Current API replies carry a validated canonical account identity.
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let text = try container.decode(String.self, forKey: .id)
    guard let canonical = TeamStationUserID.canonical(text) else {
      throw EventControlCredentials.Problem.badUserId
    }
    id = canonical
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

/// One camera on a game, as `…/games/:gameId/live-streams` describes it.
///
/// `url`, the address to publish to with its key, comes only to the person the camera belongs to,
/// and only from a request for one; a list leaves it out. `deviceId` is in the caller's own rows
/// only.
public struct TeamStationDeviceStream: Sendable, Codable, Equatable {
  public let id: String
  public let gameId: String
  public let label: String?
  /// `idle`, `publishing`, `ended` or `revoked`.
  public let state: String?
  /// Why the ingest last refused it, in its own words. Only for the person it belongs to.
  public let lastError: String?
  public let url: String?
  public let deviceId: String?
  public let deviceModel: String?
  /// When the ingest starts taking this stream, and when it stops (nil: when the game's window
  /// does).
  public let opensAt: Date?
  public let closesAt: Date?

  public init(
    id: String,
    gameId: String,
    label: String? = nil,
    state: String? = nil,
    lastError: String? = nil,
    url: String? = nil,
    deviceId: String? = nil,
    deviceModel: String? = nil,
    opensAt: Date? = nil,
    closesAt: Date? = nil
  ) {
    self.id = id
    self.gameId = gameId
    self.label = label
    self.state = state
    self.lastError = lastError
    self.url = url
    self.deviceId = deviceId
    self.deviceModel = deviceModel
    self.opensAt = opensAt
    self.closesAt = closesAt
  }
}

/// Every camera on a game: the caller's own, and everybody else's.
public struct TeamStationGameStreams: Sendable, Codable, Equatable {
  public let gameId: String
  public let mine: [TeamStationDeviceStream]
  public let others: [TeamStationDeviceStream]
}

/// Why a device asks for its stream, which decides what the server may hand back.
public enum LiveStreamRequestReason: String, Sendable, Equatable {
  /// Somebody pressed start: the stream this device holds, or a fresh one if it was ended.
  case start
  /// Putting a dropped stream back: only the stream this device holds. If that was ended the
  /// server says so (`TeamStationError.streamEnded`) and makes nothing.
  case redial
}

/// What went wrong, in words fit for a screen at a ball field.
public enum TeamStationError: Error, LocalizedError, Equatable {
  /// The request never left the iPad: no network, or the wrong address.
  case offline
  case notSignedIn
  /// The server answered, and said why.
  case server(String)
  /// The server does not offer what was asked for, and says why: asking again will not change
  /// that until the account or the server does.
  case unavailable(String)
  /// The token changed while the request was on its way, so its answer is for another session.
  case accountChanged
  /// The stream this device holds was ended on TeamStation (a 410). Only starting again makes a
  /// new one; a redial never does.
  case streamEnded

  public var errorDescription: String? {
    switch self {
    case .offline:
      return "Cannot reach TeamStation. Check the network and try again."
    case .notSignedIn:
      return "Sign in to TeamStation first."
    case let .server(message), let .unavailable(message):
      return message
    case .accountChanged:
      return "The TeamStation account changed. Try again."
    case .streamEnded:
      return "This camera was ended. Start streaming again to go live."
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

// MARK: - Device event control

/// This device's key for device event control: what
/// `GET /api/v1/device-event-control/key` answers to the device's own session.
///
/// Devices signed in to the same account on the same server get equal keys and tags; nobody else
/// does. It authenticates the local event-control protocol only, so it belongs in the keychain and
/// never in a log: `description` leaves the key out.
public struct TeamStationEventControlKey: Sendable, Codable, Equatable, CustomStringConvertible,
  CustomDebugStringConvertible
{
  public let version: Int
  /// The server's canonical public origin, as the server states it.
  public let issuer: String
  /// The signed-in user's canonical account ID.
  public let userId: String
  /// 32 hex characters, equal on every device of the account.
  public let accountTag: String
  /// 16 hex characters naming the server secret the key came from.
  public let keyId: String
  /// 64 hex characters.
  public let key: String

  public init(
    version: Int = 2,
    issuer: String,
    userId: String,
    accountTag: String,
    keyId: String,
    key: String
  ) {
    self.version = version
    self.issuer = issuer
    self.userId = userId
    self.accountTag = accountTag
    self.keyId = keyId
    self.key = key
  }

  enum CodingKeys: String, CodingKey {
    case version, issuer, userId, accountTag, keyId, key
  }

  /// Validate the same v2 contract as the signing implementation.
  public init(from decoder: Decoder) throws {
    let credentials = try EventControlCredentials(from: decoder)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    version = 2
    issuer = credentials.scope.issuer
    userId = credentials.scope.userId
    accountTag = credentials.scope.accountTag
    keyId = credentials.keyId
    key = try container.decode(String.self, forKey: .key)
  }

  public var description: String {
    "TeamStationEventControlKey(issuer: \(issuer), userId: \(userId), accountTag: \(accountTag), "
      + "keyId: \(keyId), key: <redacted>)"
  }

  public var debugDescription: String { description }
}

/// Which account this device last proved it is signed in to, and on which server.
///
/// Kept beside the token, so a Director relaunched with no network still knows the validated user
/// and server its token belongs to — `user` stays nil until the server answers, but the device is
/// no less signed in. Cleared when the server rejects the token or the operator signs out.
public struct TeamStationAccountScope: Sendable, Codable, Equatable {
  /// The canonical origin of the server the token was issued by (`origin(of:)`).
  public let server: String
  /// The user's canonical account ID on that server.
  public let userId: String

  public init(server: String, userId: String) {
    self.server = server
    self.userId = userId
  }

  /// `scheme://host[:port]` in lower case, with the scheme's default port dropped: the same
  /// name device event control files its keys under (`EventControlCredentials.canonicalOrigin`),
  /// so the two can never disagree about which server is meant. Empty for a URL with no scheme
  /// or host, which matches no server.
  public static func origin(of url: URL) -> String {
    EventControlCredentials.canonicalOrigin(of: url) ?? ""
  }
}
