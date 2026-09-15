import Foundation

public enum PeerTubeError: Error, Equatable, CustomStringConvertible, Sendable {
  /// The account has two-factor sign-in; ask for the code and try again with it.
  case otpRequired
  case invalidCredentials(String)
  /// The refresh token is no longer good: expired, revoked, or the password changed. Sign in again.
  case signInAgain
  case notPeerTube
  case overQuota(String)
  case http(status: Int, message: String)

  public var description: String {
    switch self {
    case .otpRequired: "enter the two-factor code"
    case .invalidCredentials(let reason): "sign-in failed: \(reason)"
    case .signInAgain: "the PeerTube sign-in has expired; sign in again"
    case .notPeerTube: "that is not a PeerTube server"
    case .overQuota(let reason): "the account does not have room for this video: \(reason)"
    case let .http(status, message): "PeerTube answered \(status): \(message)"
    }
  }
}

/// The instance's own OAuth client, which every app signing in to it uses.
public struct OAuthClient: Codable, Equatable, Sendable {
  public var clientID: String
  public var clientSecret: String

  public init(clientID: String, clientSecret: String) {
    self.clientID = clientID
    self.clientSecret = clientSecret
  }
}

public struct TokenSet: Codable, Equatable, Sendable {
  public var accessToken: String
  public var refreshToken: String
  public var accessExpiresAt: Date
  public var refreshExpiresAt: Date?

  public init(accessToken: String, refreshToken: String, accessExpiresAt: Date, refreshExpiresAt: Date?) {
    self.accessToken = accessToken
    self.refreshToken = refreshToken
    self.accessExpiresAt = accessExpiresAt
    self.refreshExpiresAt = refreshExpiresAt
  }

  /// Due for a refresh: expired, or expiring within `margin`.
  public func needsRefresh(now: Date = Date(), margin: TimeInterval = 300) -> Bool {
    accessExpiresAt.timeIntervalSince(now) < margin
  }
}

public struct PeerTubeChannelInfo: Codable, Equatable, Sendable {
  public var id: Int
  public var name: String
  public var displayName: String
}

public struct PeerTubeAccountInfo: Equatable, Sendable {
  public var username: String
  public var channels: [PeerTubeChannelInfo]
  /// Bytes; -1 means unlimited.
  public var videoQuota: Int64
  public var videoQuotaDaily: Int64
}

/// PeerTube's REST API, as much of it as signing in and uploading need.
public struct PeerTubeAPI: Sendable {
  public let host: String
  let session: URLSession

  public init(host: String, session: URLSession = PeerTubeAPI.ephemeral) {
    self.host = host
    self.session = session
  }

  /// Keeps no cache and no cookies on disk. `URLSession.shared` would, under the app's bundle id,
  /// and GS Distributor keeps nothing on the Mac.
  public static let ephemeral = URLSession(configuration: .ephemeral)

  var base: URL { URL(string: "https://\(host)/api/v1/")! }

  /// Checked before signing in, so a typo reads as "not a PeerTube server" rather than a sign-in
  /// failure.
  public func checkInstance() async throws {
    let (data, status) = try await get("config")
    guard status == 200,
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          object["instance"] != nil
    else { throw PeerTubeError.notPeerTube }
  }

  public func localClient() async throws -> OAuthClient {
    let (data, status) = try await get("oauth-clients/local")
    guard status == 200 else { throw Self.failure(status, data) }
    struct Wire: Decodable {
      var client_id: String
      var client_secret: String
    }
    let wire = try JSONDecoder().decode(Wire.self, from: data)
    return OAuthClient(clientID: wire.client_id, clientSecret: wire.client_secret)
  }

  /// The password grant. The password is used here and nowhere else; only the tokens are kept.
  public func signIn(username: String, password: String, otp: String?, client: OAuthClient, now: Date = Date()) async throws -> TokenSet {
    var request = URLRequest(url: base.appendingPathComponent("users/token"))
    request.httpMethod = "POST"
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    if let otp, !otp.isEmpty { request.setValue(otp, forHTTPHeaderField: "x-peertube-otp") }
    request.httpBody = Self.form([
      "client_id": client.clientID,
      "client_secret": client.clientSecret,
      "grant_type": "password",
      "response_type": "code",
      "username": username,
      "password": password
    ])
    let (data, response) = try await session.data(for: request)
    let http = response as? HTTPURLResponse
    let status = http?.statusCode ?? 0
    if status == 401, http?.value(forHTTPHeaderField: "x-peertube-otp")?.lowercased().hasPrefix("required") == true {
      throw PeerTubeError.otpRequired
    }
    guard status == 200 else {
      throw PeerTubeError.invalidCredentials(Self.message(data) ?? "HTTP \(status)")
    }
    return try Self.tokens(data, now: now)
  }

  public func refresh(_ tokens: TokenSet, client: OAuthClient, now: Date = Date()) async throws -> TokenSet {
    var request = URLRequest(url: base.appendingPathComponent("users/token"))
    request.httpMethod = "POST"
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    request.httpBody = Self.form([
      "client_id": client.clientID,
      "client_secret": client.clientSecret,
      "grant_type": "refresh_token",
      "refresh_token": tokens.refreshToken
    ])
    let (data, response) = try await session.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard status == 200 else {
      if status == 400 || status == 401 { throw PeerTubeError.signInAgain }
      throw Self.failure(status, data)
    }
    return try Self.tokens(data, now: now)
  }

  /// Best effort: signing out locally does not wait on the server agreeing.
  public func revoke(accessToken: String) async {
    var request = URLRequest(url: base.appendingPathComponent("users/revoke-token"))
    request.httpMethod = "POST"
    request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    _ = try? await session.data(for: request)
  }

  public func me(accessToken: String) async throws -> PeerTubeAccountInfo {
    let (data, status) = try await get("users/me", token: accessToken)
    guard status == 200 else { throw Self.failure(status, data) }
    struct Wire: Decodable {
      var username: String
      var videoQuota: Int64?
      var videoQuotaDaily: Int64?
      var videoChannels: [PeerTubeChannelInfo]?
    }
    let wire = try JSONDecoder().decode(Wire.self, from: data)
    return PeerTubeAccountInfo(
      username: wire.username,
      channels: wire.videoChannels ?? [],
      videoQuota: wire.videoQuota ?? -1,
      videoQuotaDaily: wire.videoQuotaDaily ?? -1
    )
  }

  /// The instance's privacy settings by id. Upstream has 1 to 5; some instances add more.
  public func privacies() async throws -> [Int: String] {
    let (data, status) = try await get("videos/privacies")
    guard status == 200, let object = try JSONSerialization.jsonObject(with: data) as? [String: String] else {
      throw Self.failure(status, data)
    }
    var result: [Int: String] = [:]
    for (key, value) in object {
      if let id = Int(key) { result[id] = value }
    }
    return result
  }

  /// The channel of the account's most recently published video, which is where the next one most
  /// likely belongs.
  public func latestChannelID(accessToken: String) async throws -> Int? {
    let (data, status) = try await get("users/me/videos?count=1&sort=-publishedAt", token: accessToken)
    guard status == 200 else { return nil }
    struct Wire: Decodable {
      struct Video: Decodable {
        struct Channel: Decodable { var id: Int }
        var channel: Channel
      }
      var data: [Video]
    }
    return (try? JSONDecoder().decode(Wire.self, from: data))?.data.first?.channel.id
  }

  public func quotaUsed(accessToken: String) async throws -> (used: Int64, daily: Int64) {
    let (data, status) = try await get("users/me/video-quota-used", token: accessToken)
    guard status == 200 else { throw Self.failure(status, data) }
    struct Wire: Decodable {
      var videoQuotaUsed: Int64
      var videoQuotaUsedDaily: Int64
    }
    let wire = try JSONDecoder().decode(Wire.self, from: data)
    return (wire.videoQuotaUsed, wire.videoQuotaUsedDaily)
  }

  // MARK: - Plumbing

  func get(_ path: String, token: String? = nil) async throws -> (Data, Int) {
    var request = URLRequest(url: URL(string: path, relativeTo: base)!)
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    let (data, response) = try await session.data(for: request)
    return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
  }

  static func tokens(_ data: Data, now: Date) throws -> TokenSet {
    struct Wire: Decodable {
      var access_token: String
      var refresh_token: String
      var expires_in: Double
      var refresh_token_expires_in: Double?
    }
    let wire = try JSONDecoder().decode(Wire.self, from: data)
    return TokenSet(
      accessToken: wire.access_token,
      refreshToken: wire.refresh_token,
      accessExpiresAt: now.addingTimeInterval(wire.expires_in),
      refreshExpiresAt: wire.refresh_token_expires_in.map { now.addingTimeInterval($0) }
    )
  }

  static func form(_ fields: [String: String]) -> Data {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~")
    let body = fields
      .sorted { $0.key < $1.key }
      .map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? $0.value)" }
      .joined(separator: "&")
    return Data(body.utf8)
  }

  static func message(_ data: Data) -> String? {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return (object["detail"] ?? object["error"] ?? object["message"]) as? String
  }

  static func failure(_ status: Int, _ data: Data) -> PeerTubeError {
    .http(status: status, message: message(data) ?? String(decoding: data.prefix(200), as: UTF8.self))
  }
}
