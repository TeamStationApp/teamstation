import Foundation

/// Talking to TeamStation.
///
/// Small on purpose: a Director needs to sign in, list the games it may film,
/// and take one. Everything else a TeamStation account can do is done on the
/// website, on a screen with room for it.
public struct TeamStationClient: Sendable {
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

  /// An endpoint, with its query where it belongs.
  ///
  /// `appending(path:)` escapes what it is given, so a `?` handed to it
  /// becomes `%3F` and the request asks for a path nothing serves. The
  /// server answers **404**, which reads as "that game is not there" rather
  /// than "this app built the URL wrongly" — an hour went on that.
  static func url(_ baseURL: URL, _ path: String, _ query: [URLQueryItem]) -> URL {
    let endpoint = apiBase(baseURL).appending(path: path)
    guard !query.isEmpty else { return endpoint }
    var parts = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)
    parts?.queryItems = query
    return parts?.url ?? endpoint
  }

  // MARK: - Signing in

  /// Asks TeamStation to send a code and a link, and answers with what this
  /// Director needs to finish the sign-in however it is done.
  ///
  /// The reply says nothing about whether the address has an account — asking
  /// must not be a way to find out who does — so a wrong address gets a
  /// request and then a code that never arrives.
  ///
  /// `appOrigin`, the app's own link host, is where the mailed link goes, so
  /// the operating system opens it in the app rather than in a browser.
  /// Without one the link is the server's own web link.
  public func startSignIn(
    email: String,
    appOrigin: String? = nil
  ) async throws -> TeamStationSignInWait {
    var body: [String: any Sendable] = ["email": email, "origin": "ios"]
    if let appOrigin { body["appOrigin"] = appOrigin }
    return try await send("auth/email-code", method: "POST", body: body)
  }

  /// Spends a sign-in link's token, naming this device so its session is the
  /// long, named one a typed code gives.
  /// `requestId` is the sign-in this app asked for and is polling, when it has one: the server then
  /// does not approve that poll as well, so the app gets one session.
  public func signInWithLink(
    token: String,
    deviceName: String,
    requestId: String? = nil
  ) async throws -> TeamStationSession {
    var body: [String: any Sendable] = ["token": token, "deviceName": deviceName]
    if let requestId { body["requestId"] = requestId }
    return try await send("auth/link/verify", method: "POST", body: body)
  }

  /// The server's OpenID issuer, `<its public origin>/oauth`: what the server
  /// calls itself, which is not always the address this app was built to talk
  /// to. Nil when the server answered without one (with OAuth off it has no
  /// discovery, and vouches for no other name). Throws when it could not be
  /// asked: no answer, or a 5xx.
  public func issuer() async throws -> String? {
    var request = URLRequest(
      url: baseURL.appending(path: "oauth/.well-known/openid-configuration")
    )
    request.setValue("application/json", forHTTPHeaderField: "accept")
    request.timeoutInterval = 20
    let (data, response) = try await session.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status == 0 || status >= 500 { throw URLError(.badServerResponse) }
    guard
      status == 200,
      let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    return body["issuer"] as? String
  }

  /// Finishes a sign-in with the six-digit code.
  public func completeSignIn(
    email: String,
    code: String,
    deviceName: String
  ) async throws -> TeamStationSession {
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
  ) async throws -> TeamStationSession? {
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
  public func whoAmI() async throws -> TeamStationUser {
    try await send("auth/me", method: "GET")
  }

  /// This device's key for device event control, fetched with this device's own session.
  ///
  /// Human sign-ins only: the server answers 401 to a machine token, which arrives here as
  /// `notSignedIn`. A server with the feature switched off answers 503, and one from before the
  /// route existed 404; both arrive as `unavailable` with the server's own sentence, so a caller
  /// can tell them from a failure worth asking again after (`offline`, or `server` for any other
  /// answer, such as a 502 while the server restarts).
  public func deviceEventControlKey() async throws -> TeamStationEventControlKey {
    try await send("device-event-control/key", method: "GET", unavailableStatuses: [ 404, 503 ])
  }

  // MARK: - Events

  /// The next twenty games of the teams this account runs, soonest first.
  public func events() async throws -> [TeamStationEvent] {
    try await send(
      "events",
      method: "GET",
      query: [
        URLQueryItem(name: "scope", value: "run"),
        URLQueryItem(name: "lookbackHours", value: "2"),
        URLQueryItem(name: "limit", value: "20")
      ]
    )
  }

  /// The last ten games already played, latest first.
  ///
  /// The list an **upload** needs, which is the opposite of the one claiming
  /// needs: claiming is about the game starting now, uploading is about the
  /// game that has just finished.
  public func finishedEvents() async throws -> [TeamStationEvent] {
    try await send(
      "events",
      method: "GET",
      query: [
        URLQueryItem(name: "scope", value: "run"),
        URLQueryItem(name: "when", value: "finished"),
        URLQueryItem(name: "lookbackHours", value: "2"),
        URLQueryItem(name: "limit", value: "10")
      ]
    )
  }

  // MARK: - Sending a recording in

  /// Opens an upload, and is told how the server wants it sent.
  ///
  /// `startedAt` is when the **recording** began, which is not when this
  /// upload began and is not negotiable: the library places a video on the
  /// game's wall clock, and the multi-camera view lays a take's angles side by
  /// side on it. Sent with every file of a take, the same instant each time,
  /// however long the one before took to go up.
  ///
  /// `liveStreamId` names the live stream this recording is the local copy of, and `wholeStream`
  /// says the recording ran for every moment that stream published: the server then replaces
  /// exactly that stream's live copy with it. Both are left out unless given, which is every
  /// upload but a phone's own recording.
  public func openUpload(
    gameId: String,
    title: String,
    kind: String,
    filename: String,
    sizeBytes: Int,
    startedAt: Date,
    liveStreamId: String? = nil,
    wholeStream: Bool? = nil
  ) async throws -> TeamStationUpload {
    var body: [String: any Sendable] = [
      "gameId": gameId,
      "title": title,
      "kind": kind,
      "filename": filename,
      "sizeBytes": sizeBytes,
      "startAt": Self.instant(startedAt)
    ]
    if let liveStreamId { body["liveStreamId"] = liveStreamId }
    if let wholeStream { body["wholeStream"] = wholeStream }
    return try await send("director/uploads", method: "POST", body: body)
  }

  /// ISO 8601 with fractional seconds, which is what the server reads.
  ///
  /// Made per call rather than shared: `ISO8601DateFormatter` is a class with
  /// mutable options and is not `Sendable`, and this is called twice per file
  /// of a take.
  static func instant(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [ .withInternetDateTime, .withFractionalSeconds ]
    return formatter.string(from: date)
  }

  /// What the server already has, so the app can send only what is missing.
  public func uploadState(uploadId: String) async throws -> TeamStationUploadState {
    try await send("director/uploads/\(escape(uploadId))", method: "GET")
  }

  /// One part of the recording.
  public func sendPart(
    uploadId: String,
    index: Int,
    bytes: Data
  ) async throws -> TeamStationPartTaken {
    try await sendBytes(
      "director/uploads/\(escape(uploadId))/parts/\(index)",
      bytes: bytes
    )
  }

  /// Every part is there: turn it into a video, and let it replace the stream.
  ///
  /// The server does the work before it answers — assembles the parts, probes
  /// and remuxes the recording, copies it to storage — which for a two-hour
  /// take is **minutes**, measured at 282 to 406 seconds for 3.5 GB. Asked
  /// with the twenty seconds a question gets, this timed out while the server
  /// was still working and reported an upload as failed that had in fact
  /// landed.
  public func finishUpload(uploadId: String) async throws -> TeamStationUploadFinished {
    try await send(
      "director/uploads/\(escape(uploadId))/finish",
      method: "POST",
      body: [:],
      timeout: 900
    )
  }

  /// Given up on, so the server can drop the parts rather than keep them.
  ///
  /// Nothing comes back but a 204, and nothing is done with a failure: the
  /// upload the app has stopped caring about is the server's to time out.
  public func abandonUpload(uploadId: String) async {
    var request = URLRequest(
      url: Self.apiBase(baseURL).appending(
        path: "director/uploads/\(escape(uploadId))"
      )
    )
    request.httpMethod = "DELETE"
    if let token {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    }
    _ = try? await session.data(for: request)
  }

  /// This device's camera on a game, and the URL to publish it to.
  ///
  /// `POST /games/:gameId/live-streams` with the device's install id: the stream this device
  /// already has under `label` on the game comes back, or one it may take over, or a new one in the
  /// caller's lowest free slot. `heldStreamId` names the stream the device holds, which a redial
  /// sends: if that stream has been ended the server answers 410, thrown as
  /// `TeamStationError.streamEnded`, and makes nothing — only a request without it can start a
  /// fresh stream.
  public func requestLiveStream(
    gameId: String,
    label: String,
    deviceId: String,
    deviceModel: String,
    heldStreamId: String? = nil
  ) async throws -> TeamStationDeviceStream {
    var body: [String: any Sendable] = [
      "label": label,
      "deviceId": deviceId,
      "deviceModel": deviceModel
    ]
    if let heldStreamId { body["heldStreamId"] = heldStreamId }
    return try await send(
      "games/\(escape(gameId))/live-streams",
      method: "POST",
      body: body,
      goneIsEnded: true
    )
  }

  /// Every camera on a game: this person's own, with their state and why the ingest last refused
  /// them, and everybody else's.
  ///
  /// Asked when a publish will not start: the socket says `connection refused`, and the server
  /// says *why* — the key was rotated, the window has not opened yet.
  public func liveStreams(gameId: String) async throws -> TeamStationGameStreams {
    try await send("games/\(escape(gameId))/live-streams", method: "GET")
  }

  /// Renames one of this person's cameras, keeping its stream and key.
  public func updateLiveStream(
    gameId: String,
    streamId: String,
    label: String
  ) async throws -> TeamStationDeviceStream {
    try await send(
      "games/\(escape(gameId))/live-streams/\(escape(streamId))",
      method: "PATCH",
      body: [ "label": label ],
      goneIsEnded: true
    )
  }

  /// Says when the first picture of a stream's first publish was captured, on this device's wall
  /// clock: TeamStation places the stream's live video there, where the angle grid lines it up with
  /// the game's other cameras, instead of at the moment the publish reached it. The first account
  /// holds; one of a later publish is ignored.
  @discardableResult
  public func reportLiveStart(
    gameId: String,
    streamId: String,
    startedAt: Date
  ) async throws -> TeamStationDeviceStream {
    let instant = ISO8601DateFormatter()
    instant.formatOptions = [ .withInternetDateTime, .withFractionalSeconds ]
    return try await send(
      "games/\(escape(gameId))/live-streams/\(escape(streamId))",
      method: "PATCH",
      body: [ "liveStartedAt": instant.string(from: startedAt) ],
      goneIsEnded: true
    )
  }

  private struct ServerTime: Decodable {
    let serverTime: Double
  }

  /// What to add to `now` to read TeamStation's clock (`ServerClock`), from `samples` round trips
  /// to `GET /time`. `now` is the clock the caller's instants are on. Throws only when no round trip
  /// came back.
  public func serverClockOffset(
    samples: Int = ServerClock.samples,
    now: @Sendable () -> Double = { Date().timeIntervalSince1970 }
  ) async throws -> Double {
    var taken: [ServerClock.Sample] = []
    var failure: (any Error)?
    for _ in 0 ..< max(1, samples) {
      let sent = now()
      do {
        let reply: ServerTime = try await send("time", method: "GET", timeout: 5)
        taken.append(ServerClock.Sample(sent: sent, server: reply.serverTime / 1_000, received: now()))
      } catch {
        failure = error
      }
    }
    guard let offset = ServerClock.offset(from: taken) else {
      throw failure ?? TeamStationError.server("no answer from the server's clock")
    }
    return offset
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
    } catch TeamStationWaiting.notYet {
      return nil
    }
  }

  /// A request whose body is bytes rather than JSON.
  ///
  /// Its own path because a part is megabytes of recording: it is handed over
  /// as a body, and the timeout is minutes rather than the twenty seconds a
  /// question deserves — a part on a field's uplink is not a question.
  private func sendBytes<Reply: Decodable>(
    _ path: String,
    bytes: Data
  ) async throws -> Reply {
    var request = URLRequest(url: Self.apiBase(baseURL).appending(path: path))
    request.httpMethod = "PUT"
    request.setValue("application/json", forHTTPHeaderField: "accept")
    request.setValue("application/octet-stream", forHTTPHeaderField: "content-type")
    if let token {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    }
    request.timeoutInterval = 300

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.upload(for: request, from: bytes)
    } catch {
      throw TeamStationError.offline
    }
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status == 401 || status == 403 { throw TeamStationError.notSignedIn }
    guard (200 ..< 300).contains(status) else {
      throw TeamStationError.server(Self.message(from: data, status: status))
    }
    do {
      return try Self.decoder.decode(Reply.self, from: data)
    } catch {
      throw TeamStationError.server("TeamStation sent something unreadable")
    }
  }

  private func send<Reply: Decodable>(
    _ path: String,
    method: String,
    body: [String: any Sendable]? = nil,
    query: [URLQueryItem] = [],
    waitingIsNil: Bool = false,
    unavailableStatuses: Set<Int> = [],
    goneIsEnded: Bool = false,
    timeout: TimeInterval = 20
  ) async throws -> Reply {
    var request = URLRequest(url: Self.url(baseURL, path, query))
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
    // wait must not be the whole of a pre-game. A request that asks the server
    // to *do* something lengthy says so.
    request.timeoutInterval = timeout

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw TeamStationError.offline
    }

    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status == 202 && waitingIsNil { throw TeamStationWaiting.notYet }
    // Only a *signed-in* request can be told it is not signed in. Signing in
    // is unauthenticated by definition, and its 401 means something else
    // entirely — a wrong code, an expired one — so it keeps the server's own
    // sentence. Mapping it to `notSignedIn` told somebody halfway through
    // signing in to "Sign in to TeamStation first", which is the least useful
    // true statement the app can make.
    if status == 401 || status == 403, token != nil {
      throw TeamStationError.notSignedIn
    }
    if status == 410, goneIsEnded { throw TeamStationError.streamEnded }
    if unavailableStatuses.contains(status) {
      throw TeamStationError.unavailable(Self.message(from: data, status: status))
    }
    guard (200 ..< 300).contains(status) else {
      throw TeamStationError.server(Self.message(from: data, status: status))
    }
    do {
      return try Self.decoder.decode(Reply.self, from: data)
    } catch {
      throw TeamStationError.server("TeamStation sent something unreadable")
    }
  }

  /// The server's own sentence where there is one, rather than a status number.
  static func message(from data: Data, status: Int) -> String {
    if let api = try? JSONDecoder().decode(TeamStationApiError.self, from: data) {
      return api.message
    }
    return "TeamStation answered \(status)"
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
