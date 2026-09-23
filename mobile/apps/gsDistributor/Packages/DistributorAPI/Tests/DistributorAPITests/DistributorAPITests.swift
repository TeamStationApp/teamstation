import DistributorAPI
import DistributorWire
import Foundation
import LoopbackHTTP
import Testing

/// Stands in for GS Distributor: canned answers, and what it was asked.
@MainActor
final class FakeActions: DistributorActions {
  var started: [APIRunRequest] = []
  var deleted: [Int64] = []
  var runs: [UUID: APIRun] = [:]
  var startFailure: HTTPError?
  var patches: [APISettingsPatch] = []

  static let recording = APIRecording(
    id: 361,
    startedAt: Date(timeIntervalSince1970: 1_787_533_500),
    endedAt: nil,
    isLive: false,
    files: [ APIFile(track: "primary", name: "Primary output", onMac: "saved", bytesOnMac: 10, path: "/Movies/2026-08-23/a.mov", preparedOnIPad: false) ],
    combined: APIFile(track: "combined", name: "Combined video", onMac: "missing", bytesOnMac: nil, path: nil, preparedOnIPad: false),
    folder: "/Movies/2026-08-23"
  )

  func status() -> APIStatus {
    APIStatus(iPad: APIIPad(state: "none", message: "Connect iPad"), destination: "/Movies", run: nil, gameStation: APIGameStation(state: "signedOut"))
  }

  func recordings() -> APIRecordingList {
    APIRecordingList(source: "cache", iPadName: "Field iPad", savedAt: Date(timeIntervalSince1970: 1_787_600_000), recordings: [ Self.recording ])
  }

  func recording(_ id: Int64) throws(HTTPError) -> APIRecording {
    guard id == 361 else { throw HTTPError.notFound("no recording \(id)") }
    return Self.recording
  }

  func still(recording: Int64, track: String, at seconds: Double) async throws(HTTPError) -> Data {
    Data([ 0xFF, 0xD8, UInt8(seconds) ])
  }

  func deleteRecordings(_ ids: [Int64]) async throws(HTTPError) -> [Int64] {
    deleted += ids
    return ids.filter { $0 == 1 }
  }

  func startRun(_ request: APIRunRequest) async throws(HTTPError) -> APIRun {
    if let startFailure { throw startFailure }
    started.append(request)
    let run = APIRun(id: UUID(), recording: request.recording ?? 0, folder: "/Movies", isFinished: false, wasCancelled: false, files: [], combined: nil, uploads: [])
    runs[run.id] = run
    return run
  }

  func run(_ id: UUID) -> APIRun? { runs[id] }
  func currentRun() -> APIRun? { runs.values.first }

  func cancelRun(_ id: UUID) throws(HTTPError) -> APIRun {
    guard var run = runs[id] else { throw HTTPError.notFound("no run") }
    run.wasCancelled = true
    return run
  }

  func settings() -> DistributorSettings { DistributorSettings(createCombined: true) }

  func updateSettings(_ patch: APISettingsPatch) async throws(HTTPError) -> DistributorSettings {
    patches.append(patch)
    return DistributorSettings(createCombined: patch.createCombined ?? true)
  }

  func gameStation() async -> APIGameStation {
    APIGameStation(
      state: "signedIn",
      email: "coach@example.org",
      games: [
        APIGame(
          id: "gam_1",
          title: "Titan at Ravens",
          startAt: Date(timeIntervalSince1970: 1_789_683_300),
          venue: "Vale Field"
        )
      ]
    )
  }
}

@Suite("Distributor API", .serialized)
@MainActor
struct DistributorAPITests {
  static func call(
    _ router: Router,
    _ method: String,
    _ path: String,
    query: [String: String] = [:],
    body: String = ""
  ) async throws -> (status: Int, type: String, data: Data) {
    let response = await router.handle(HTTPRequest(method: method, path: path, query: query, body: Data(body.utf8)))
    guard case let .data(status, type, data) = response else { throw CancellationError() }
    return (status, type, data)
  }

  static func json(_ data: Data) throws -> [String: Any] {
    try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  @Test("The index lists every route with what it does, and nothing else")
  func index() async throws {
    let router = DistributorAPI.router(actions: FakeActions(), events: JSONEventHub())
    let answer = try await Self.call(router, "GET", "/api/v1")
    let index = try JSONDecoder().decode(APIIndex.self, from: answer.data)
    let routes = Set(index.routes.map { "\($0.method) \($0.path)" })
    #expect(routes == [
      "GET /api/v1", "GET /api/v1/status", "GET /api/v1/events",
      "GET /api/v1/recordings", "DELETE /api/v1/recordings", "GET /api/v1/recordings/{id}", "GET /api/v1/recordings/{id}/still",
      "POST /api/v1/recordings/{id}/download", "POST /api/v1/recordings/{id}/export",
      "POST /api/v1/recordings/{id}/combined", "POST /api/v1/recordings/{id}/upload",
      "POST /api/v1/runs", "GET /api/v1/runs/current", "GET /api/v1/runs/{id}", "DELETE /api/v1/runs/{id}",
      "GET /api/v1/settings", "PATCH /api/v1/settings", "GET /api/v1/gamestation"
    ])
    #expect(index.routes.allSatisfy { !$0.summary.isEmpty })
  }

  @Test("A path no route serves is 404")
  func unknownPath() async throws {
    let router = DistributorAPI.router(actions: FakeActions(), events: JSONEventHub())
    for (method, path) in [ ("GET", "/api/v1/teams"), ("POST", "/api/v1/signin"), ("GET", "/api/v1/nothing/here") ] {
      #expect(try await Self.call(router, method, path).status == 404, "\(method) \(path)")
    }
  }

  @Test("The settings answer carries only the Distributor's own settings")
  func settingsKeys() async throws {
    let router = DistributorAPI.router(actions: FakeActions(), events: JSONEventHub())
    let answer = try await Self.call(router, "GET", "/api/v1/settings")
    #expect(answer.status == 200)
    #expect(Set(try Self.json(answer.data).keys) == [ "version", "destinations", "createCombined", "combinedLayout", "upload", "stamps" ])
  }

  @Test("Each verb starts a run of its kind for the recording in the path, and answers 202")
  func verbs() async throws {
    let actions = FakeActions()
    let router = DistributorAPI.router(actions: actions, events: JSONEventHub())
    let combined = try await Self.call(router, "POST", "/api/v1/recordings/411/combined", body: #"{"combined":{"include":["Home","Away"],"audioCamera":"Home"}}"#)
    #expect(combined.status == 202)
    _ = try await Self.call(router, "POST", "/api/v1/recordings/411/upload", body: #"{"upload":{"game":"gam_1"}}"#)
    _ = try await Self.call(router, "POST", "/api/v1/recordings/362/download")
    #expect(actions.started.map(\.kind) == [ .combined, .upload, .download ])
    #expect(actions.started.map(\.recording) == [ 411, 411, 362 ])
    #expect(actions.started[0].combined == APICombinedRequest(include: [ "Home", "Away" ], audioCamera: "Home"))
    #expect(actions.started[1].upload?.game == "gam_1")

    let run = try JSONDecoder.api.decode(APIRun.self, from: combined.data)
    let followed = try await Self.call(router, "GET", "/api/v1/runs/\(run.id.uuidString)")
    #expect(followed.status == 200)
    let cancelled = try await Self.call(router, "DELETE", "/api/v1/runs/\(run.id.uuidString)")
    #expect(try JSONDecoder.api.decode(APIRun.self, from: cancelled.data).wasCancelled)
  }

  @Test("A refusal from the app reaches the caller with its status and code")
  func refusal() async throws {
    let actions = FakeActions()
    actions.startFailure = HTTPError(412, "iPadNotAttached", "Connect iPad with GS Director in the foreground to export videos.")
    let router = DistributorAPI.router(actions: actions, events: JSONEventHub())
    let answer = try await Self.call(router, "POST", "/api/v1/recordings/411/export")
    #expect(answer.status == 412)
    #expect(try Self.json(answer.data)["error"] as? String == "iPadNotAttached")
    let noRecording = try await Self.call(router, "POST", "/api/v1/runs", body: #"{"kind":"download"}"#)
    #expect(noRecording.status == 400)
    #expect(try await Self.call(router, "GET", "/api/v1/recordings/9").status == 404)
    #expect(try await Self.call(router, "GET", "/api/v1/runs/current").status == 404)
  }

  @Test("Deleting recordings needs confirm=true, and says which the iPad refused")
  func delete() async throws {
    let actions = FakeActions()
    let router = DistributorAPI.router(actions: actions, events: JSONEventHub())
    let unconfirmed = try await Self.call(router, "DELETE", "/api/v1/recordings", query: [ "ids": "1,2" ])
    #expect(unconfirmed.status == 400)
    #expect(actions.deleted.isEmpty)
    let confirmed = try await Self.call(router, "DELETE", "/api/v1/recordings", query: [ "ids": "1,2", "confirm": "true" ])
    let body = try Self.json(confirmed.data)
    #expect(body["deleted"] as? [Int] == [ 2 ])
    #expect(body["refused"] as? [Int] == [ 1 ])
  }

  @Test("Recordings, stills, settings and GameStation answer as the app says")
  func answers() async throws {
    let actions = FakeActions()
    let router = DistributorAPI.router(actions: actions, events: JSONEventHub())
    let list = try JSONDecoder.api.decode(APIRecordingList.self, from: try await Self.call(router, "GET", "/api/v1/recordings").data)
    #expect(list.source == "cache")
    #expect(list.recordings == [ FakeActions.recording ])
    let still = try await Self.call(router, "GET", "/api/v1/recordings/411/still", query: [ "track": "camera:a", "at": "20" ])
    #expect(still.type == "image/jpeg")
    #expect(still.data == Data([ 0xFF, 0xD8, 20 ]))
    let patched = try await Self.call(router, "PATCH", "/api/v1/settings", body: #"{"createCombined":false}"#)
    #expect(patched.status == 200)
    #expect(actions.patches == [ APISettingsPatch(createCombined: false) ])
    let account = try await Self.call(router, "GET", "/api/v1/gamestation")
    let gameStation = try JSONDecoder.api.decode(APIGameStation.self, from: account.data)
    #expect(gameStation.state == "signedIn")
    // The games an upload may name, which is what this call is for.
    #expect(gameStation.games.map(\.id) == [ "gam_1" ])
  }

  @Test("Served on loopback, the API answers a real request, and streams the status")
  func served() async throws {
    let events = JSONEventHub<APIEvent>(encoder: .api)
    let router = DistributorAPI.router(actions: FakeActions(), events: events)
    let server = LinkServer(port: 0) { await router.handle($0) }
    let port = try await server.start()
    defer { server.stop() }
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }

    let (data, response) = try await session.data(from: URL(string: "http://127.0.0.1:\(port)/api/v1/status")!)
    #expect((response as? HTTPURLResponse)?.statusCode == 200)
    #expect(try Self.json(data)["destination"] as? String == "/Movies")

    // URLSession hands over a streamed response only once its first bytes arrive, so the stream is
    // read alongside while the event is published.
    let eventsURL = URL(string: "http://127.0.0.1:\(port)/api/v1/events")!
    let reading = Task { () async throws -> String? in
      let (bytes, _) = try await session.bytes(from: eventsURL)
      var lines = bytes.lines.makeAsyncIterator()
      return try await lines.next()
    }
    for _ in 0..<100 where events.subscriberCount == 0 {
      try await Task.sleep(for: .milliseconds(20))
    }
    let status = FakeActions().status()
    events.publish(APIEvent(at: Date(timeIntervalSince1970: 1_800_000_000), status: status))
    let line = try #require(try await reading.value)
    #expect(line.contains(#""at":"2027-01-15T08:00:00Z""#))
    #expect(try JSONDecoder.api.decode(APIEvent.self, from: Data(line.utf8)).status == status)
  }
}
