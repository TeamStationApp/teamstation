import CameramanCore
@testable import CameramanUI
@testable import EventControl
import Foundation
import os

/// Synthetic keys, as the account server would answer `GET device-event-control/key` for users
/// 1001 and 1002 of one test server (the `one` and `two` vectors of EventControl's keys.json).
enum EventKeys {
  nonisolated(unsafe) static let one: [String: Any] = [
    "version": 1,
    "issuer": "https://app.example.test",
    "userId": "1001",
    "accountTag": "3ce9e2793f1ced4924b58f9598f81da9",
    "keyId": "5cbbb6482042eb0a",
    "key": "d47b3e64272b9c78fdd34c7439697d44dad28301356c5ba1f0c559dbed3eec04"
  ]
  nonisolated(unsafe) static let two: [String: Any] = [
    "version": 1,
    "issuer": "https://app.example.test",
    "userId": "1002",
    "accountTag": "a64a1771b862c93822bca4b3f17f1a0a",
    "keyId": "5cbbb6482042eb0a",
    "key": "8e94910e983787f2c54d1d4cd3c33938150dff776e02c083333eb31fb5ca92c7"
  ]
  /// User 1001's key after the server secret was rotated.
  nonisolated(unsafe) static let oneRotated: [String: Any] = [
    "version": 1,
    "issuer": "https://app.example.test",
    "userId": "1001",
    "accountTag": "2044958a33a0ae13e4c18814be059440",
    "keyId": "db120a71e5f6d52a",
    "key": "9588624261acb64de091ebf66222159f7eea9179349a3a1032dc7824f20f8047"
  ]

  static func credentials(_ reply: [String: Any]) -> EventControlCredentials {
    try! EventControlCredentials.decode(serverReply: JSONSerialization.data(withJSONObject: reply))
  }
}

/// The account server, answering by path under `/api/v1/`. A path with no answer is unreachable.
final class AccountServerStub: @unchecked Sendable {
  private let lock = NSLock()
  private var answers: [String: (Int, Any)] = [:]
  private var log: [String] = []

  func answer(_ path: String, _ status: Int, _ json: Any = [String: Any]()) {
    lock.withLock { answers[path] = (status, json) }
  }

  func unreachable(_ path: String) {
    _ = lock.withLock { answers.removeValue(forKey: path) }
  }

  /// "<path> <authorization>" for every request, oldest first.
  var requests: [String] { lock.withLock { log } }

  func count(_ path: String) -> Int {
    requests.filter { $0.hasPrefix(path + " ") }.count
  }

  var http: ScoreboardHTTP {
    { [self] request in
      let url = request.url!
      let path = String(url.path.dropFirst("/api/v1/".count))
      let answer: (Int, Any)? = lock.withLock {
        log.append("\(path) \(request.value(forHTTPHeaderField: "Authorization") ?? "")")
        return answers[path]
      }
      guard let (status, json) = answer else { throw URLError(.notConnectedToInternet) }
      let data = try JSONSerialization.data(withJSONObject: json)
      return (data, HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
  }

  /// The usual signed-in server: user 1001, with its key.
  static func signedIn() -> AccountServerStub {
    let server = AccountServerStub()
    server.answer("auth/me", 200, [ "id": "1001", "displayName": "Mookie Betts", "email": "one@example.test" ])
    server.answer("device-event-control/key", 200, EventKeys.one)
    return server
  }
}

/// A publish socket that records what it is asked to do.
final class FakeScoreboardSocket: ScoreboardSocket, @unchecked Sendable {
  let url: String
  let authorization: String?
  private let lock = NSLock()
  private var texts: [String] = []
  private var closeCode: URLSessionWebSocketTask.CloseCode?
  private var handlers: [@Sendable (Int?) -> Void] = []

  init(_ request: URLRequest) {
    url = request.url!.absoluteString
    authorization = request.value(forHTTPHeaderField: "Authorization")
  }

  var sent: [String] { lock.withLock { texts } }
  var closed: URLSessionWebSocketTask.CloseCode? { lock.withLock { closeCode } }
  /// Receive callbacks waiting for the server.
  var waiting: Int { lock.withLock { handlers.count } }

  func send(_ text: String) { lock.withLock { texts.append(text) } }
  func close(_ code: URLSessionWebSocketTask.CloseCode) { lock.withLock { closeCode = code } }
  func receiveNext(_ handler: @escaping @Sendable (Int?) -> Void) { lock.withLock { handlers.append(handler) } }

  /// What the server does next: nil delivers a message, a code fails the socket with it.
  func deliver(_ code: Int?) {
    let handler = lock.withLock { handlers.isEmpty ? nil : handlers.removeFirst() }
    handler?(code)
  }
}

final class FakeScoreboardSockets: @unchecked Sendable {
  private let lock = NSLock()
  private var list: [FakeScoreboardSocket] = []

  var opened: [FakeScoreboardSocket] { lock.withLock { list } }

  var opener: ScoreboardSocketOpener {
    { [self] request in
      let socket = FakeScoreboardSocket(request)
      lock.withLock { list.append(socket) }
      return socket
    }
  }

  /// Everything sent to sockets for `url`, in order.
  func sent(to url: String) -> [String] {
    opened.filter { $0.url == url }.flatMap(\.sent)
  }
}

enum EventOverrideFixture {
  static let gameA = "gam_demoA"
  static let gameB = "gam_demoB"
  static let urlA = ScoreboardTarget.socketOrigin(ScoreboardTarget.accountOrigin()) + "/api/v1/scoreboard/gam_demoA/publish"
  static let urlB = ScoreboardTarget.socketOrigin(ScoreboardTarget.accountOrigin()) + "/api/v1/scoreboard/gam_demoB/publish"
  static let assignmentA = try! EventAssignment(
    gameId: gameA,
    title: "Visitors at Pioneers",
    startAt: Date(timeIntervalSince1970: 1_790_013_600)
  )
  static let assignmentB = try! EventAssignment(
    gameId: gameB,
    title: "Pioneers at Comets",
    startAt: Date(timeIntervalSince1970: 1_790_040_600)
  )

  /// A store signed in as user 1001 (or, with `userId: ""`, a login an older build saved).
  static func store(
    route: ScoreboardRoute = .event,
    userId: String = "1001",
    allow: Bool = false,
    gameId: String = "gam_local"
  ) -> InMemorySettingsStore {
    let store = InMemorySettingsStore()
    ScoreboardTarget.save(
      ScoreboardSaved(
        route: route,
        apiServer: "wss://v1.example.test",
        v1EventId: "evt7",
        accountServer: ScoreboardTarget.accountOrigin(),
        token: "tok-one",
        displayName: "Mookie Betts",
        email: "one@example.test",
        gameId: gameId,
        gameTitle: "Local at Home",
        gameStartAt: "2026-09-28T22:05:00Z",
        userId: userId,
        allowDirectorOverride: allow
      ),
      to: store
    )
    return store
  }

  /// A port nothing else on this Mac is likely to hold, so a test never meets a real receiver:
  /// below the system's ephemeral range, where outgoing connections take theirs, and a different
  /// one for every listener a run makes.
  static func port() -> UInt16 {
    nextPort.withLock { value -> UInt16 in
      value = value == 0 ? UInt16.random(in: 41_000 ... 45_000) : value + 1
      return value
    }
  }

  private static let nextPort = OSAllocatedUnfairLock(initialState: UInt16(0))

  static let fast = EventControlDirectorTiming(
    connectTimeout: 1,
    replyTimeout: 1,
    renewInterval: 0.05,
    reconnectDelays: [ 0.02, 0.02 ],
    maxFailures: 3
  )

  private static let connectionIds = OSAllocatedUnfairLock(initialState: UInt64(1_000))

  /// A Director talking to `receiver` over an in-memory connection. The receiver sees it at
  /// 192.0.2.1.
  static func director(
    _ receiver: EventControlReceiver,
    instance: String = "d001",
    desired: EventControlDesired?,
    key: [String: Any] = EventKeys.one
  ) -> EventControlDirectorLink {
    let connector = EventControlMemoryConnector { _, far in
      let id = connectionIds.withLock { value -> UInt64 in
        value += 1
        return value
      }
      Task { await receiver.serve(far, id: id) }
    }
    return EventControlDirectorLink(
      endpoint: EventControlEndpoint(host: "192.0.2.30", port: 47614),
      instanceId: EventControlInstanceID(hex: String(repeating: "0", count: 32 - instance.count) + instance)!,
      credentials: EventKeys.credentials(key),
      desired: desired,
      connector: connector,
      timing: fast,
      onUpdate: { _ in }
    )
  }
}

/// Waits up to `timeout` for `condition`, checking every 10 ms.
@MainActor
func eventually(
  _ timeout: Duration = .seconds(5),
  _ condition: @MainActor () async -> Bool
) async -> Bool {
  let deadline = ContinuousClock.now + timeout
  while ContinuousClock.now < deadline {
    if await condition() { return true }
    try? await Task.sleep(for: .milliseconds(10))
  }
  return await condition()
}
