import Foundation

/// Which scoreboard a radar reading is aimed at.
public enum ScoreboardRoute: String, Equatable, Sendable {
  /// The 1.0 autoState socket. No account.
  case v1
  /// One event's publish socket. Needs a signed-in account and a chosen event.
  case event
}

/// A socket to open, and the bearer token to say at the door when the route needs one.
public struct ScoreboardSocketTarget: Equatable, Sendable {
  public var url: String
  public var authorization: String?

  public init(url: String, authorization: String?) {
    self.url = url
    self.authorization = authorization
  }
}

/// What Settings saved. An empty token is signed out.
public struct ScoreboardSaved: Equatable, Sendable {
  public var route: ScoreboardRoute
  public var apiServer: String
  public var v1EventId: String
  public var accountServer: String
  public var token: String
  public var displayName: String
  public var email: String
  public var gameId: String
  public var gameTitle: String
  public var gameStartAt: String

  public init(
    route: ScoreboardRoute,
    apiServer: String,
    v1EventId: String,
    accountServer: String,
    token: String,
    displayName: String,
    email: String,
    gameId: String,
    gameTitle: String,
    gameStartAt: String
  ) {
    self.route = route
    self.apiServer = apiServer
    self.v1EventId = v1EventId
    self.accountServer = accountServer
    self.token = token
    self.displayName = displayName
    self.email = email
    self.gameId = gameId
    self.gameTitle = gameTitle
    self.gameStartAt = gameStartAt
  }
}

/**
 Where a TAG One reading goes, matching GS Watcher.

 V1 is `<apiServer>/sockets/api/v1/autoState/<eventId>` with the server string used as typed.
 An event is `<server>/api/v1/scoreboard/<gameId>/publish` over `wss://` (`ws://` for an `http://`
 server), with the session bearer token.
 */
public enum ScoreboardTarget {
  public static let defaultV1Server = "wss://app.gamestation.co"
  public static let defaultAccountServer = "https://gamestation.co"

  public static func trimmed(_ origin: String) -> String {
    var text = origin.trimmingCharacters(in: .whitespacesAndNewlines)
    while text.hasSuffix("/") { text.removeLast() }
    return text
  }

  /// `ws://` and `wss://` read as `http://` and `https://`.
  public static func httpOrigin(_ server: String) -> String {
    let origin = trimmed(server)
    if origin.lowercased().hasPrefix("wss://") { return "https://" + origin.dropFirst(6) }
    if origin.lowercased().hasPrefix("ws://") { return "http://" + origin.dropFirst(5) }
    return origin
  }

  /// `https://` becomes `wss://`, `http://` becomes `ws://`.
  public static func socketOrigin(_ server: String) -> String {
    let origin = trimmed(server)
    if origin.lowercased().hasPrefix("https://") { return "wss://" + origin.dropFirst(8) }
    if origin.lowercased().hasPrefix("http://") { return "ws://" + origin.dropFirst(7) }
    return origin
  }

  /**
   The event route only sends while a token is saved. Otherwise the V1 socket is the one
   that is live, which is also what the radio falls back to after sign-out.
   */
  public static func effectiveRoute(_ selected: ScoreboardRoute, token: String) -> ScoreboardRoute {
    selected == .event && !token.isEmpty ? .event : .v1
  }

  public static func target(_ saved: ScoreboardSaved) -> ScoreboardSocketTarget? {
    switch effectiveRoute(saved.route, token: saved.token) {
    case .v1:
      guard let url = v1Url(saved.apiServer, eventId: saved.v1EventId) else { return nil }
      return ScoreboardSocketTarget(url: url, authorization: nil)
    case .event:
      return eventTarget(saved.accountServer, gameId: saved.gameId, token: saved.token)
    }
  }

  public static func v1Url(_ apiServer: String, eventId: String) -> String? {
    if apiServer.trimmingCharacters(in: .whitespaces).isEmpty { return nil }
    if eventId.trimmingCharacters(in: .whitespaces).isEmpty { return nil }
    return "\(trimmed(apiServer))/sockets/api/v1/autoState/\(encode(eventId))"
  }

  public static func eventTarget(
    _ server: String,
    gameId: String,
    token: String
  ) -> ScoreboardSocketTarget? {
    if server.trimmingCharacters(in: .whitespaces).isEmpty { return nil }
    if gameId.trimmingCharacters(in: .whitespaces).isEmpty { return nil }
    if token.trimmingCharacters(in: .whitespaces).isEmpty { return nil }
    return ScoreboardSocketTarget(
      url: "\(socketOrigin(server))/api/v1/scoreboard/\(encode(gameId))/publish",
      authorization: "Bearer \(token)"
    )
  }

  /// Pitch and exit only, and only the numbers that just arrived. A dash is not a reading.
  public static func payload(pitchMph: Int, exitMph: Int) -> String? {
    var parts: [String] = []
    if pitchMph > 0 { parts.append("\"pitchSpeed\":\(pitchMph)") }
    if exitMph > 0 { parts.append("\"exitVelocity\":\(exitMph)") }
    if parts.isEmpty { return nil }
    return "{" + parts.joined(separator: ",") + "}"
  }

  /// What a radar packet puts on the wire, and whether it starts the pitch hold.
  ///
  /// Exit velocity alone is a reading and does not restart the pitch timer.
  /// A pitch above zero does, even when the number is the one already showing.
  public struct PitchReading: Equatable, Sendable {
    public var text: String
    public var restartsPitchHold: Bool

    public init(text: String, restartsPitchHold: Bool) {
      self.text = text
      self.restartsPitchHold = restartsPitchHold
    }
  }

  public static let pitchHoldSeconds: TimeInterval = 5
  /// A pitch clear. Exit velocity is absent, so a held exit is left alone.
  public static let pitchClearPayload = "{\"pitchSpeed\":0}"

  public static func reading(pitchMph: Int, exitMph: Int) -> PitchReading? {
    guard let text = payload(pitchMph: pitchMph, exitMph: exitMph) else { return nil }
    return PitchReading(text: text, restartsPitchHold: pitchMph > 0)
  }

  /// Where sign-in goes. A release build is gamestation.co. `GSPrimaryHost`
  /// reroutes a special build; the operator does not type it.
  public static let productionAccountHost = "gamestation.co"

  public static func accountHost(primaryHost: String?) -> String {
    var text = (primaryHost ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if text == "$(GS_PRIMARY_HOST)" { return productionAccountHost }
    if let range = text.range(of: "^[a-z][a-z0-9+.-]*://", options: [.regularExpression, .caseInsensitive]) {
      text.removeSubrange(range)
    }
    if let cut = text.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" }) {
      text = String(text[..<cut])
    }
    return text.isEmpty ? productionAccountHost : text
  }

  public static func accountOrigin(primaryHost: String?) -> String {
    let host = accountHost(primaryHost: primaryHost)
    let plain = host == "localhost" || host.range(of: #"^\d{1,3}(\.\d{1,3}){3}$"#, options: .regularExpression) != nil
    return "\(plain ? "http" : "https")://\(host)"
  }

  /// The host named by this build's `GSPrimaryHost`, or gamestation.co.
  public static func accountOrigin(bundle: Bundle = .main) -> String {
    let written = bundle.object(forInfoDictionaryKey: "GSPrimaryHost") as? String
    return accountOrigin(primaryHost: written)
  }

  /// The server closed the door. Retrying would only repeat the refusal.
  public static func stopsRetry(_ closeCode: Int) -> Bool {
    closeCode == 4401 || closeCode == 4403 || closeCode == 4404
  }

  public static func eventTitle(away: String, home: String) -> String {
    "\(away) at \(home)"
  }

  /// "Tue Dec 22, 2026 4:35 PM" in `zone`. An unreadable stamp is returned as typed.
  public static func localStartTime(_ startAt: String, zone: TimeZone) -> String {
    guard let date = parseISO(startAt) else { return startAt }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = zone
    formatter.dateFormat = "EEE MMM d, yyyy h:mm a"
    return formatter.string(from: date)
  }

  public static func load(_ store: SettingsStore) -> ScoreboardSaved {
    let token = store.string(forKey: Keys.token) ?? ""
    let route: ScoreboardRoute =
      store.string(forKey: Keys.route) == "event" && !token.isEmpty ? .event : .v1
    return ScoreboardSaved(
      route: route,
      apiServer: store.string(forKey: Keys.apiServer) ?? defaultV1Server,
      v1EventId: store.string(forKey: Keys.v1Event) ?? "",
      accountServer: store.string(forKey: Keys.accountServer) ?? defaultAccountServer,
      token: token,
      displayName: store.string(forKey: Keys.displayName) ?? "",
      email: store.string(forKey: Keys.email) ?? "",
      gameId: store.string(forKey: Keys.gameId) ?? "",
      gameTitle: store.string(forKey: Keys.gameTitle) ?? "",
      gameStartAt: store.string(forKey: Keys.gameStart) ?? ""
    )
  }

  public static func save(_ saved: ScoreboardSaved, to store: SettingsStore) {
    store.setString(saved.route == .event ? "event" : "v1", forKey: Keys.route)
    store.setString(saved.apiServer, forKey: Keys.apiServer)
    store.setString(saved.v1EventId, forKey: Keys.v1Event)
    store.setString(saved.accountServer, forKey: Keys.accountServer)
    store.setString(saved.token, forKey: Keys.token)
    store.setString(saved.displayName, forKey: Keys.displayName)
    store.setString(saved.email, forKey: Keys.email)
    store.setString(saved.gameId, forKey: Keys.gameId)
    store.setString(saved.gameTitle, forKey: Keys.gameTitle)
    store.setString(saved.gameStartAt, forKey: Keys.gameStart)
  }

  /// Sign-out drops the account and the event route. The last chosen game stays for next time.
  public static func signedOut(_ saved: ScoreboardSaved) -> ScoreboardSaved {
    var next = saved
    next.route = .v1
    next.token = ""
    next.displayName = ""
    next.email = ""
    return next
  }

  public static func encode(_ value: String) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-_.!~*'()")
    return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
  }

  private static func parseISO(_ text: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: text) { return date }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return plain.date(from: text)
  }

  private enum Keys {
    static let route = "co.gamestation.cameraman.scoreboard.route"
    static let apiServer = "co.gamestation.cameraman.scoreboard.apiServer"
    static let v1Event = "co.gamestation.cameraman.scoreboard.v1EventId"
    static let accountServer = "co.gamestation.cameraman.scoreboard.accountServer"
    static let token = "co.gamestation.cameraman.scoreboard.token"
    static let displayName = "co.gamestation.cameraman.scoreboard.displayName"
    static let email = "co.gamestation.cameraman.scoreboard.email"
    static let gameId = "co.gamestation.cameraman.scoreboard.gameId"
    static let gameTitle = "co.gamestation.cameraman.scoreboard.gameTitle"
    static let gameStart = "co.gamestation.cameraman.scoreboard.gameStartAt"
  }
}
