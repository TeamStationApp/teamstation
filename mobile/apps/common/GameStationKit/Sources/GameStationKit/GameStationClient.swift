import Foundation

/// Talking to GameStation.
///
/// Small on purpose: a Director needs to sign in, list the games it may film,
/// and take one. Everything else a GameStation account can do is done on the
/// website, on a screen with room for it.
public struct GameStationClient: Sendable {
  public let baseURL: URL
  /// The device token. Absent until somebody signs in.
  public var token: String?
  private let session: URLSession

  public init(baseURL: URL, token: String? = nil, session: URLSession = .shared) {
    self.baseURL = baseURL
    self.token = token
    self.session = session
  }

  /// Where the API lives under whatever address the operator typed.
  static func apiBase(_ baseURL: URL) -> URL {
    baseURL.appending(path: "api/v1")
  }

  // MARK: - Signing in

  /// Asks GameStation to send a code and a link, and answers with what this
  /// Director needs to finish the sign-in however it is done.
  ///
  /// The reply says nothing about whether the address has an account — asking
  /// must not be a way to find out who does — so a wrong address gets a
  /// request and then a code that never arrives.
  ///
  /// `origin: ios` is recorded on the request, so the day the link can open
  /// this app directly it lands here rather than in a browser.
  public func startSignIn(email: String) async throws -> GameStationSignInWait {
    try await send(
      "auth/email-code",
      method: "POST",
      body: ["email": email, "origin": "ios"]
    )
  }

  /// Finishes a sign-in with the six-digit code.
  public func completeSignIn(
    email: String,
    code: String,
    deviceName: String
  ) async throws -> GameStationSession {
    try await send(
      "auth/email-code/verify",
      method: "POST",
      body: ["email": email, "code": code, "deviceName": deviceName]
    )
  }

  /// Asks whether the sign-in has been approved somewhere else yet.
  ///
  /// Somebody taps the button in the e-mail — on a phone, on a laptop, on
  /// anything — and this iPad, holding a secret nobody else has, finds out and
  /// signs itself in. Returning `nil` means not yet, which is the ordinary
  /// answer and not a failure.
  public func pollSignIn(
    requestId: String,
    clientSecret: String,
    deviceName: String
  ) async throws -> GameStationSession? {
    try await sendOptional(
      "auth/request/claim",
      method: "POST",
      body: [
        "requestId": requestId,
        "clientSecret": clientSecret,
        "deviceName": deviceName
      ]
    )
  }

  /// Who this device is signed in as, or a failure if it is not.
  public func whoAmI() async throws -> GameStationUser {
    try await send("auth/me", method: "GET")
  }

  // MARK: - Events

  /// The next ten games of the teams this account runs, soonest first.
  public func events() async throws -> [GameStationEvent] {
    try await send("director/events", method: "GET")
  }

  /// Takes a game, and gets the URL to publish it to.
  public func claim(gameId: String) async throws -> GameStationClaim {
    try await send(
      "director/events/\(escape(gameId))/claim",
      method: "POST",
      body: [:]
    )
  }

  /// What GameStation says about a game's stream.
  ///
  /// Asked when a publish will not start: the socket says `connection
  /// refused`, and the server says *why* — the key was rotated, somebody else
  /// is already streaming this game, the window has not opened yet.
  /// What this Director's camera on a game is doing, and why it is not.
  public func liveStream(gameId: String) async throws -> GameStationLiveStream {
    try await send("director/events/\(escape(gameId))/stream", method: "GET")
  }

  // MARK: - The wire

  private func escape(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
  }

  /// For an endpoint that answers `202` to mean "not yet".
  private func sendOptional<Reply: Decodable>(
    _ path: String,
    method: String,
    body: [String: any Sendable]? = nil
  ) async throws -> Reply? {
    do {
      return try await send(path, method: method, body: body, waitingIsNil: true)
    } catch GameStationWaiting.notYet {
      return nil
    }
  }

  private func send<Reply: Decodable>(
    _ path: String,
    method: String,
    body: [String: any Sendable]? = nil,
    waitingIsNil: Bool = false
  ) async throws -> Reply {
    var request = URLRequest(url: Self.apiBase(baseURL).appending(path: path))
    request.httpMethod = method
    request.setValue("application/json", forHTTPHeaderField: "accept")
    if let token {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    }
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "content-type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    // A field with no signal is the ordinary case, not the exception, and the
    // wait must not be the whole of a pre-game.
    request.timeoutInterval = 20

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw GameStationError.offline
    }

    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status == 202 && waitingIsNil { throw GameStationWaiting.notYet }
    if status == 401 || status == 403 { throw GameStationError.notSignedIn }
    guard (200 ..< 300).contains(status) else {
      throw GameStationError.server(Self.message(from: data, status: status))
    }
    do {
      return try Self.decoder.decode(Reply.self, from: data)
    } catch {
      throw GameStationError.server("GameStation sent something unreadable")
    }
  }

  /// The server's own sentence where there is one, rather than a status number.
  static func message(from data: Data, status: Int) -> String {
    if let api = try? JSONDecoder().decode(GameStationApiError.self, from: data) {
      return api.message
    }
    return "GameStation answered \(status)"
  }

  /// Dates arrive as ISO-8601, usually with fractional seconds because that is
  /// what JavaScript writes, and sometimes without because that is what a hand
  /// or another tool writes. Both are read.
  ///
  /// `Date.ISO8601FormatStyle` rather than `ISO8601DateFormatter`: the class is
  /// not `Sendable`, and this decoder is shared across tasks.
  static let decoder: JSONDecoder = {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let text = try decoder.singleValueContainer().decode(String.self)
      if let date = try? Date(text, strategy: fractional) { return date }
      if let date = try? Date(text, strategy: whole) { return date }
      throw DecodingError.dataCorrupted(
        DecodingError.Context(
          codingPath: decoder.codingPath,
          debugDescription: "Not a date: \(text)"
        )
      )
    }
    return decoder
  }()

  private static let fractional = Date.ISO8601FormatStyle(
    includingFractionalSeconds: true
  )
  private static let whole = Date.ISO8601FormatStyle()
}
