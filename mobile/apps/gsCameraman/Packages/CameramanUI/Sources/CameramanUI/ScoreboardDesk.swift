import CameramanCore
import Foundation

struct ScoreboardWireError: LocalizedError {
  var message: String
  var errorDescription: String? { message }
}

/// Sign-in, the event list, and the socket a radar reading is published on.
@MainActor
public final class ScoreboardDesk {
  public private(set) var snapshot: ScoreboardSnapshot
  public var onSnapshot: ((ScoreboardSnapshot) -> Void)?

  private let store: SettingsStore
  private let origin: String
  private let deviceName: String
  private let session: URLSession
  private var saved: ScoreboardSaved
  private var awaitingCode = false
  private var pickerOpen = false
  private var recent: [ScoreboardEventChoice] = []
  private var upcoming: [ScoreboardEventChoice] = []
  private var pickerStatus = ""
  private var status = ""
  private var reconnectTask: Task<Void, Never>?
  private var socket: URLSessionWebSocketTask?
  private var openURL: String?
  private var openAuthorization: String?
  private var stopped = false
  private var pitchGeneration = 0
  private var pitchHold: Task<Void, Never>?

  public init(
    store: SettingsStore,
    origin: String = "ios",
    deviceName: String = "GS Cameraman",
    session: URLSession = .shared
  ) {
    self.store = store
    self.origin = origin
    self.deviceName = deviceName
    self.session = session
    let loaded = ScoreboardTarget.load(store)
    let account = ScoreboardTarget.accountOrigin()
    var pinned = loaded
    if pinned.accountServer != account {
      pinned.accountServer = account
      ScoreboardTarget.save(pinned, to: store)
    }
    self.saved = pinned
    self.snapshot = ScoreboardSnapshot(
      route: pinned.route,
      signedIn: !pinned.token.isEmpty,
      accountLabel: pinned.email.isEmpty ? pinned.displayName : pinned.email,
      apiServer: pinned.apiServer,
      v1EventId: pinned.v1EventId,
      accountServer: account,
      accountHost: ScoreboardTarget.accountHost(primaryHost: account),
      gameTitle: pinned.gameTitle,
      gameWhen: pinned.gameStartAt.isEmpty
        ? ""
        : ScoreboardTarget.localStartTime(pinned.gameStartAt, zone: .current)
    )
  }

  public func selectRoute(_ route: ScoreboardRoute) {
    if route == .event && saved.token.isEmpty { return }
    saved.route = route
    persist()
    status = idleStatus()
    publish()
    reconnect()
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
        awaitingCode = false
        status = "Signed in"
        persist()
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
    status = "Signed out"
    persist()
    publish()
    reconnect()
  }

  public func openEvents() {
    if saved.token.isEmpty { return }
    Task {
      pickerOpen = true
      pickerStatus = "Loading events"
      publish()
      do {
        let json = try await call(
          method: "GET",
          path: "scoreboard/events",
          body: nil,
          token: saved.token
        )
        let object = json as? [String: Any] ?? [:]
        recent = rows(object["recent"])
        upcoming = rows(object["upcoming"])
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
    reconnect()
  }

  /// A pitch or exit that just arrived. Zeros and dashes are not readings.
  ///
  /// A pitch above zero is sent, then cleared with `{"pitchSpeed":0}` five
  /// seconds later unless another pitch arrives. Exit velocity does not
  /// restart that wait, and the clear does not mention exit velocity.
  public func publish(pitchMph: Int, exitMph: Int) {
    guard let reading = ScoreboardTarget.reading(pitchMph: pitchMph, exitMph: exitMph) else {
      return
    }
    if reading.restartsPitchHold {
      pitchGeneration += 1
      let mine = pitchGeneration
      pitchHold?.cancel()
      pitchHold = Task { @MainActor in
        try? await Task.sleep(for: .seconds(ScoreboardTarget.pitchHoldSeconds))
        guard !Task.isCancelled, mine == self.pitchGeneration else { return }
        self.send(ScoreboardTarget.pitchClearPayload)
      }
    }
    send(reading.text)
  }

  private func send(_ text: String) {
    guard let target = ScoreboardTarget.target(saved) else { return }
    guard let url = URL(string: target.url) else { return }
    let same = openURL == target.url && openAuthorization == target.authorization
    if stopped && same { return }
    if socket == nil || !same {
      socket?.cancel(with: .normalClosure, reason: nil)
      stopped = false
      openURL = target.url
      openAuthorization = target.authorization
      var request = URLRequest(url: url)
      if let authorization = target.authorization {
        request.setValue(authorization, forHTTPHeaderField: "Authorization")
      }
      let task = session.webSocketTask(with: request)
      socket = task
      task.resume()
      listen(task)
      task.send(.string(text)) { _ in }
      return
    }
    socket?.send(.string(text)) { _ in }
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
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    stopped = false
    openURL = nil
    openAuthorization = nil
  }

  private func listen(_ task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      Task { @MainActor in
        guard let self, self.socket === task else { return }
        switch result {
        case .success:
          self.listen(task)
        case .failure:
          let code = task.closeCode.rawValue
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
    let label: String
    if saved.token.isEmpty {
      label = ""
    } else if !saved.email.isEmpty {
      label = saved.email
    } else {
      label = saved.displayName
    }
    snapshot = ScoreboardSnapshot(
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
      pickerStatus: pickerStatus
    )
    onSnapshot?(snapshot)
  }

  private func rows(_ value: Any?) -> [ScoreboardEventChoice] {
    guard let list = value as? [[String: Any]] else { return [] }
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
      (data, response) = try await session.data(for: request)
    } catch {
      throw ScoreboardWireError(message: "Cannot reach \(origin)")
    }
    let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
    let json = try? JSONSerialization.jsonObject(with: data)
    if statusCode < 200 || statusCode > 299 {
      throw ScoreboardWireError(message: message(of: json) ?? "The server answered \(statusCode)")
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
