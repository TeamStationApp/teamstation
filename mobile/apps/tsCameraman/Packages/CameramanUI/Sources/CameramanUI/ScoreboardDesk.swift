import CameramanCore
import Foundation
import os

struct ScoreboardWireError: LocalizedError {
  var message: String
  /// The HTTP status the server answered with, or 0 when it could not be reached.
  var status = 0
  var errorDescription: String? { message }
}

/// One HTTP exchange with the account server. `URLSession` in the app; a stub in tests.
public typealias ScoreboardHTTP = @Sendable (URLRequest) async throws -> (Data, URLResponse)

/// A publish socket, as the desk uses one.
public protocol ScoreboardSocket: AnyObject, Sendable {
  func send(_ text: String)
  func close(_ code: URLSessionWebSocketTask.CloseCode)
  /// Calls `handler` once: with nil when a message arrived, or with the close code once the socket
  /// has failed.
  func receiveNext(_ handler: @escaping @Sendable (Int?) -> Void)
}

/// Opens a started publish socket for a request.
public typealias ScoreboardSocketOpener = @Sendable (URLRequest) -> any ScoreboardSocket

/// `URLSessionWebSocketTask` as a `ScoreboardSocket`.
final class URLSessionScoreboardSocket: ScoreboardSocket, @unchecked Sendable {
  private let task: URLSessionWebSocketTask

  init(session: URLSession, request: URLRequest) {
    task = session.webSocketTask(with: request)
    task.resume()
  }

  func send(_ text: String) {
    task.send(.string(text)) { _ in }
  }

  func close(_ code: URLSessionWebSocketTask.CloseCode) {
    task.cancel(with: code, reason: nil)
  }

  func receiveNext(_ handler: @escaping @Sendable (Int?) -> Void) {
    let task = task
    task.receive { result in
      switch result {
      case .success: handler(nil)
      case .failure: handler(task.closeCode.rawValue)
      }
    }
  }
}

/// Sign-in, the event list, and the socket a radar reading is published on.
///
/// A Director on the local network may also set the event, through `applyAssignedEvent`, while the
/// operator allows it. Its hold is mirrored here by `setOverride`, which locks every way this
/// device has of changing the event until the hold ends.
@MainActor
public final class ScoreboardDesk {
  public private(set) var snapshot = ScoreboardSnapshot()
  public var onSnapshot: ((ScoreboardSnapshot) -> Void)?
  /// Called after a sign-in or a sign-out, once the saved login has changed.
  public var onAccountChange: (() -> Void)?

  private let store: SettingsStore
  private let origin: String
  private let deviceName: String
  private let http: ScoreboardHTTP
  private let openSocket: ScoreboardSocketOpener
  private let pitchHoldSeconds: TimeInterval
  private var saved: ScoreboardSaved
  private var awaitingCode = false
  private var pickerOpen = false
  private var recent: [ScoreboardEventChoice] = []
  private var upcoming: [ScoreboardEventChoice] = []
  private var pickerStatus = ""
  private var status = ""
  private var eventControlStatus = ""
  /// The Director holding the event, as the event-control receiver last reported it.
  private var override: ScoreboardAssignmentSource?
  /// The assignment last stored, for ordering the next one from the same Director.
  private var lastAssignment: ScoreboardAssignmentSource?
  /// Bumped by every Director assignment written, so a pick that was waiting on
  /// `directorHoldsEvent` while one was written gives way to it.
  private var assignmentsWritten = 0
  /// Asks the event-control receiver whether a Director holds the event or is writing it now: its
  /// lease, which `override` mirrors a step behind. Set by `EventOverrideController`; without it
  /// only `override` locks the picker.
  public var directorHoldsEvent: (@Sendable () async -> Bool)?
  /// Bumped by every sign-in and sign-out, so an answer to a request made for an earlier login is
  /// never applied to the current one.
  public private(set) var accountGeneration = 0
  /// Bumped every time readings start going somewhere else. A reading stamped with an older value
  /// arrived for the previous target and is dropped. Read off the main actor by the radar callback.
  nonisolated private let targetStamp = OSAllocatedUnfairLock(initialState: 0)
  private var reconnectTask: Task<Void, Never>?
  private var socket: (any ScoreboardSocket)?
  private var openURL: String?
  private var openAuthorization: String?
  private var stopped = false
  private var pitchGeneration = 0
  private var pitchHold: Task<Void, Never>?

  public init(
    store: SettingsStore,
    origin: String = "ios",
    deviceName: String = "TS Cameraman",
    session: URLSession = .shared,
    http: ScoreboardHTTP? = nil,
    openSocket: ScoreboardSocketOpener? = nil,
    pitchHoldSeconds: TimeInterval = ScoreboardTarget.pitchHoldSeconds
  ) {
    self.store = store
    self.origin = origin
    self.deviceName = deviceName
    self.http = http ?? { request in try await session.data(for: request) }
    self.openSocket = openSocket ?? { request in URLSessionScoreboardSocket(session: session, request: request) }
    self.pitchHoldSeconds = pitchHoldSeconds
    let loaded = ScoreboardTarget.load(store)
    let account = ScoreboardTarget.accountOrigin()
    var pinned = loaded
    if pinned.accountServer != account {
      pinned.accountServer = account
      ScoreboardTarget.save(pinned, to: store)
    }
    self.saved = pinned
    snapshot = makeSnapshot()
  }

  // MARK: - What the event-control receiver reads

  public var isSignedIn: Bool { !saved.token.isEmpty }
  /// The signed-in user's ID in decimal; empty while signed out or not yet known.
  public var userId: String { saved.userId }
  public var accountServer: String { saved.accountServer }
  public var allowsDirectorOverride: Bool { saved.allowDirectorOverride }
  /// The Director holding the event, if one does.
  public var currentOverride: ScoreboardAssignmentSource? { override }

  public func selectRoute(_ route: ScoreboardRoute) {
    if route == .event && saved.token.isEmpty { return }
    saved.route = route
    persist()
    status = idleStatus()
    publish()
    moveTarget()
  }

  public func setV1(apiServer: String, eventId: String) {
    if saved.apiServer == apiServer && saved.v1EventId == eventId { return }
    saved.apiServer = apiServer
    saved.v1EventId = eventId
    persist()
    publish()
    scheduleReconnect()
  }

  public func setAccountServer(_ server: String) {
    if saved.accountServer == server { return }
    saved.accountServer = server
    persist()
    publish()
    if ScoreboardTarget.effectiveRoute(saved.route, token: saved.token) == .event {
      scheduleReconnect()
    }
  }

  public func sendCode(email: String) {
    let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty {
      status = "Enter an email"
      publish()
      return
    }
    Task {
      status = "Sending a code"
      publish()
      do {
        _ = try await call(
          method: "POST",
          path: "auth/email-code",
          body: ["email": trimmed, "origin": origin],
          token: nil
        )
        awaitingCode = true
        status = "Check your email for a code"
      } catch {
        status = error.localizedDescription
      }
      publish()
    }
  }

  public func verify(email: String, code: String) {
    let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedCode = code.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmedEmail.isEmpty || trimmedCode.isEmpty {
      status = "Enter the email and the code"
      publish()
      return
    }
    Task {
      status = "Signing in"
      publish()
      do {
        let json = try await call(
          method: "POST",
          path: "auth/email-code/verify",
          body: ["email": trimmedEmail, "code": trimmedCode, "deviceName": deviceName],
          token: nil
        )
        guard
          let object = json as? [String: Any],
          let token = object["token"] as? String,
          let user = object["user"] as? [String: Any]
        else {
          throw ScoreboardWireError(message: "The server's answer was not understood")
        }
        saved.token = token
        saved.displayName = user["displayName"] as? String ?? ""
        saved.email = (user["email"] as? String)?.isEmpty == false
          ? (user["email"] as? String ?? trimmedEmail)
          : trimmedEmail
        // Empty when the server leaves it out; `refreshIdentity` then asks `auth/me`.
        saved.userId = ScoreboardTarget.decimalUserId(user["id"]) ?? ""
        awaitingCode = false
        status = "Signed in"
        persist()
        accountGeneration += 1
        publish()
        onAccountChange?()
        return
      } catch {
        status = error.localizedDescription
      }
      publish()
    }
  }

  public func signOut() {
    saved = ScoreboardTarget.signedOut(saved)
    awaitingCode = false
    pickerOpen = false
    override = nil
    lastAssignment = nil
    status = "Signed out"
    persist()
    accountGeneration += 1
    publish()
    moveTarget()
    onAccountChange?()
  }

  public func openEvents() {
    // While a Director holds the event, the list is not offered at all.
    if saved.token.isEmpty || override != nil { return }
    let written = assignmentsWritten
    Task {
      guard await mayPick(since: written) else { return }
      pickerOpen = true
      pickerStatus = "Loading events"
      publish()
      do {
        let json = try await call(
          method: "GET",
          path: "events?scope=run&lookbackHours=2&limit=20",
          body: nil,
          token: saved.token
        )
        recent = []
        upcoming = rows(json)
        pickerStatus = ""
      } catch {
        pickerStatus = error.localizedDescription
      }
      publish()
    }
  }

  public func dismissEvents() {
    pickerOpen = false
    publish()
  }

  public func choose(gameId: String) {
    // A Director's event is not changed from here until its hold ends.
    if override != nil { return }
    guard directorHoldsEvent != nil else { return pick(gameId: gameId) }
    let written = assignmentsWritten
    Task {
      guard await mayPick(since: written) else { return }
      pick(gameId: gameId)
    }
  }

  /// Whether the operator may still change the event: no Director holds it by the receiver's own
  /// account, and none was written here while the receiver was being asked.
  private func mayPick(since written: Int) async -> Bool {
    if let directorHoldsEvent, await directorHoldsEvent() { return false }
    return override == nil && assignmentsWritten == written
  }

  private func pick(gameId: String) {
    let row = (recent + upcoming).first { $0.gameId == gameId }
    guard let row else { return }
    saved.route = .event
    saved.gameId = row.gameId
    saved.gameTitle = row.title
    saved.gameStartAt = row.startAt
    pickerOpen = false
    status = ""
    persist()
    publish()
    moveTarget()
  }

  // MARK: - Director override

  /// "Allow Director Override". Turning it off gives the event back at once; the receiver is told
  /// separately and releases its lease.
  public func setAllowDirectorOverride(_ allowed: Bool) {
    if saved.allowDirectorOverride == allowed { return }
    saved.allowDirectorOverride = allowed
    if !allowed {
      override = nil
      lastAssignment = nil
    }
    persist()
    publish()
  }

  /// The Director holding the event, or nil once its hold ended for any reason. The event it set
  /// stays selected either way.
  public func setOverride(_ source: ScoreboardAssignmentSource?) {
    override = source
    if source == nil {
      lastAssignment = nil
    } else {
      pickerOpen = false
    }
    publish()
  }

  /// The line under the toggle saying why this device cannot take a Director's event yet.
  public func setEventControlStatus(_ text: String) {
    if eventControlStatus == text { return }
    eventControlStatus = text
    publish()
  }

  /// Stores a Director's event as the event route's game and moves the publishing connection to
  /// it, checking first, with nothing in between, that this is still allowed: the operator's
  /// consent, the signed-in user the request was proved for, and its order.
  ///
  /// Which Director holds the event is the receiver's to say, not this desk's: it calls this only
  /// for the Director whose lease it holds or has just freed. `override` mirrors that lease a step
  /// behind (it changes when the receiver's event is handled), so a hold that has just ended there
  /// can still show here when the next Director's assignment arrives.
  ///
  /// The game ID, title and start time are written together. The route, the servers, the V1 event,
  /// the login and the radar are left alone, so a device on the V1 route stores the event for when
  /// it switches. Only after the store and the move does it answer `.applied`, which says the
  /// target is set, not that anything has been published to it yet.
  public func applyAssignedEvent(
    gameId: String,
    title: String,
    startAt: String,
    from source: ScoreboardAssignmentSource
  ) -> ScoreboardAssignmentOutcome {
    guard !saved.token.isEmpty, !saved.userId.isEmpty, saved.userId == source.userId
    else { return .wrongAccount }
    guard saved.allowDirectorOverride else { return .disabled }
    if let lastAssignment, lastAssignment.owner == source.owner, source.revision < lastAssignment.revision {
      return .stale
    }
    let before = ScoreboardTarget.target(saved)
    saved = ScoreboardTarget.assigning(saved, gameId: gameId, title: title, startAt: startAt)
    persist()
    lastAssignment = source
    assignmentsWritten += 1
    pickerOpen = false
    if ScoreboardTarget.effectiveRoute(saved.route, token: saved.token) == .event,
       ScoreboardTarget.target(saved) != before
    {
      status = ""
      moveTarget()
    }
    publish()
    return .applied
  }

  /// Whether the saved login still stands, and whose it is.
  public enum IdentityCheck: Equatable, Sendable {
    /// The server named the token's user, now in `userId`.
    case valid
    /// The server refused the token. `userId` is cleared, so nothing on the local network trusts it.
    case rejected
    /// The server could not be asked. A user already validated stays as it was.
    case offline
    /// Nobody is signed in.
    case signedOut
    /// The login changed while the server was being asked; the answer was for the earlier one.
    case superseded
  }

  /// Asks `auth/me` who the saved token belongs to, with that token. This is how a login saved
  /// before user IDs were kept gets one.
  public func refreshIdentity() async -> IdentityCheck {
    let token = saved.token
    if token.isEmpty { return .signedOut }
    let generation = accountGeneration
    do {
      let json = try await call(method: "GET", path: "auth/me", body: nil, token: token)
      guard generation == accountGeneration else { return .superseded }
      guard let id = ScoreboardTarget.decimalUserId((json as? [String: Any])?["id"]) else { return .offline }
      if saved.userId != id {
        saved.userId = id
        persist()
      }
      return .valid
    } catch {
      guard generation == accountGeneration else { return .superseded }
      guard (error as? ScoreboardWireError)?.status == 401 else { return .offline }
      if !saved.userId.isEmpty {
        saved.userId = ""
        persist()
      }
      return .rejected
    }
  }

  /// What `GET device-event-control/key` gave this device's own login.
  public enum KeyFetch: Equatable, Sendable {
    /// The server's reply, for `EventControlCredentials.decode(serverReply:)`.
    case key(Data)
    /// The server refused the token.
    case rejected
    /// The server does not offer event control.
    case unavailable
    /// The server could not be asked.
    case offline
    /// Signed out, or the login changed while the server was being asked.
    case superseded
  }

  public func fetchEventControlKey() async -> KeyFetch {
    let token = saved.token
    if token.isEmpty { return .superseded }
    let generation = accountGeneration
    do {
      let json = try await call(method: "GET", path: "device-event-control/key", body: nil, token: token)
      guard generation == accountGeneration else { return .superseded }
      guard let object = json as? [String: Any], !object.isEmpty,
            let data = try? JSONSerialization.data(withJSONObject: object)
      else { return .unavailable }
      return .key(data)
    } catch {
      guard generation == accountGeneration else { return .superseded }
      switch (error as? ScoreboardWireError)?.status ?? 0 {
      case 401: return .rejected
      // Switched off on this server, or a server from before the route existed.
      case 404, 503: return .unavailable
      default: return .offline
      }
    }
  }

  /// A pitch or exit that just arrived. Zeros and dashes are not readings.
  ///
  /// A pitch above zero is sent, then cleared with `{"pitchSpeed":0}` five
  /// seconds later unless another pitch arrives. Exit velocity does not
  /// restart that wait, and the clear does not mention exit velocity.
  ///
  /// `stamp` is `currentTargetStamp()` read when the reading arrived. A reading that arrived before
  /// the target last moved belonged to the old one and is dropped rather than sent to the new one.
  public func publish(pitchMph: Int, exitMph: Int, stamp: Int? = nil) {
    if let stamp, stamp != currentTargetStamp() { return }
    guard let reading = ScoreboardTarget.reading(pitchMph: pitchMph, exitMph: exitMph) else {
      return
    }
    if reading.restartsPitchHold {
      pitchGeneration += 1
      let mine = pitchGeneration
      let hold = pitchHoldSeconds
      pitchHold?.cancel()
      pitchHold = Task { @MainActor in
        try? await Task.sleep(for: .seconds(hold))
        guard !Task.isCancelled, mine == self.pitchGeneration else { return }
        self.send(ScoreboardTarget.pitchClearPayload)
      }
    }
    send(reading.text)
  }

  /// Which target a reading arriving now is for. Safe to read from the radar's own queue.
  public nonisolated func currentTargetStamp() -> Int {
    targetStamp.withLock { $0 }
  }

  private func send(_ text: String) {
    guard let target = ScoreboardTarget.target(saved) else { return }
    guard let url = URL(string: target.url) else { return }
    let same = openURL == target.url && openAuthorization == target.authorization
    if stopped && same { return }
    if socket == nil || !same {
      socket?.close(.normalClosure)
      stopped = false
      openURL = target.url
      openAuthorization = target.authorization
      var request = URLRequest(url: url)
      if let authorization = target.authorization {
        request.setValue(authorization, forHTTPHeaderField: "Authorization")
      }
      let opened = openSocket(request)
      socket = opened
      listen(opened)
      opened.send(text)
      return
    }
    socket?.send(text)
  }

  /// Readings go somewhere else from now on. Nothing meant for the old target may reach the new
  /// one: the old socket is closed (its late callbacks are ignored, since it is no longer
  /// `socket`), a pending reconnect is cancelled, a pending pitch clear is fenced off, and readings
  /// still on their way in are stamped with the old target and dropped.
  private func moveTarget() {
    targetStamp.withLock { $0 += 1 }
    pitchGeneration += 1
    pitchHold?.cancel()
    pitchHold = nil
    reconnectTask?.cancel()
    reconnectTask = nil
    reconnect()
  }

  private func scheduleReconnect() {
    reconnectTask?.cancel()
    reconnectTask = Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(400))
      guard !Task.isCancelled else { return }
      self.reconnect()
    }
  }

  /// Drops the current socket. The next reading opens the one the radios now point at.
  private func reconnect() {
    socket?.close(.goingAway)
    socket = nil
    stopped = false
    openURL = nil
    openAuthorization = nil
  }

  private func listen(_ task: any ScoreboardSocket) {
    task.receiveNext { [weak self] closeCode in
      Task { @MainActor in
        guard let self, self.socket === task else { return }
        switch closeCode {
        case nil:
          self.listen(task)
        case let code?:
          self.socket = nil
          if ScoreboardTarget.stopsRetry(code) {
            self.stopped = true
            self.status = code == 4401 ? "Signed out" : "The scoreboard refused this camera"
            self.publish()
          }
        }
      }
    }
  }

  private func persist() {
    ScoreboardTarget.save(saved, to: store)
  }

  private func idleStatus() -> String {
    if saved.route == .event && saved.gameId.isEmpty { return "Choose an event" }
    if saved.route == .v1 && saved.v1EventId.trimmingCharacters(in: .whitespaces).isEmpty {
      return "Enter a V1 event id"
    }
    return ""
  }

  private func publish() {
    snapshot = makeSnapshot()
    onSnapshot?(snapshot)
  }

  private func makeSnapshot() -> ScoreboardSnapshot {
    let label: String
    if saved.token.isEmpty {
      label = ""
    } else if !saved.email.isEmpty {
      label = saved.email
    } else {
      label = saved.displayName
    }
    return ScoreboardSnapshot(
      route: saved.route,
      signedIn: !saved.token.isEmpty,
      accountLabel: label,
      apiServer: saved.apiServer,
      v1EventId: saved.v1EventId,
      accountServer: saved.accountServer,
      accountHost: ScoreboardTarget.accountHost(primaryHost: saved.accountServer),
      gameTitle: saved.gameTitle,
      gameWhen: saved.gameStartAt.isEmpty
        ? ""
        : ScoreboardTarget.localStartTime(saved.gameStartAt, zone: .current),
      status: status,
      awaitingCode: awaitingCode,
      pickerOpen: pickerOpen,
      recent: recent,
      upcoming: upcoming,
      pickerStatus: pickerStatus,
      allowDirectorOverride: saved.allowDirectorOverride,
      overrideHost: override?.host ?? "",
      eventControlStatus: saved.allowDirectorOverride ? eventControlStatus : ""
    )
  }

  private func rows(_ value: Any?) -> [ScoreboardEventChoice] {
    let list: [[String: Any]]
    if let objects = value as? [[String: Any]] {
      list = objects
    } else if let any = value as? [Any] {
      list = any.compactMap { $0 as? [String: Any] }
    } else {
      return []
    }
    return list.compactMap { item in
      guard let gameId = item["gameId"] as? String, !gameId.isEmpty else { return nil }
      let away = item["awayTeamName"] as? String ?? ""
      let home = item["homeTeamName"] as? String ?? ""
      let startAt = item["startAt"] as? String ?? ""
      return ScoreboardEventChoice(
        gameId: gameId,
        title: ScoreboardTarget.eventTitle(away: away, home: home),
        startAt: startAt,
        whenLabel: ScoreboardTarget.localStartTime(startAt, zone: .current)
      )
    }
  }

  private func call(
    method: String,
    path: String,
    body: [String: Any]?,
    token: String?
  ) async throws -> Any {
    let origin = ScoreboardTarget.httpOrigin(saved.accountServer)
    guard let url = URL(string: origin + "/api/v1/" + path) else {
      throw ScoreboardWireError(message: "Cannot reach \(origin)")
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let token, !token.isEmpty {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await http(request)
    } catch {
      throw ScoreboardWireError(message: "Cannot reach \(origin)")
    }
    let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
    let json = try? JSONSerialization.jsonObject(with: data)
    if statusCode < 200 || statusCode > 299 {
      throw ScoreboardWireError(
        message: message(of: json) ?? "The server answered \(statusCode)",
        status: statusCode
      )
    }
    if method == "POST", let object = json as? [String: Any], object["requestId"] == nil, object["token"] == nil {
      throw ScoreboardWireError(message: "The server's answer was not understood")
    }
    return json ?? [:]
  }

  private func message(of json: Any?) -> String? {
    guard let object = json as? [String: Any] else { return nil }
    if let message = object["message"] as? String, !message.isEmpty { return message }
    if let error = object["error"] as? String, !error.isEmpty { return error }
    return nil
  }
}
