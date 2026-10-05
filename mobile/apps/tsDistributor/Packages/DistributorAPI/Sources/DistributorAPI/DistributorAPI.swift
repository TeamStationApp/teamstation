import DistributorWire
import Foundation
import LoopbackHTTP

/// What the API asks of TS Distributor. The app answers with its model; the tests with a stand-in.
/// A failure is an `HTTPError` whose status and code the caller sees as they are.
@MainActor
public protocol DistributorActions: AnyObject, Sendable {
  func status() -> APIStatus
  func recordings() -> APIRecordingList
  func recording(_ id: Int64) throws(HTTPError) -> APIRecording
  func still(recording: Int64, track: String, at seconds: Double) async throws(HTTPError) -> Data
  /// Deletes on the iPad and returns the ids it refused: the take in progress, if it was asked.
  func deleteRecordings(_ ids: [Int64]) async throws(HTTPError) -> [Int64]
  func startRun(_ request: APIRunRequest) async throws(HTTPError) -> APIRun
  func run(_ id: UUID) -> APIRun?
  func currentRun() -> APIRun?
  func cancelRun(_ id: UUID) throws(HTTPError) -> APIRun
  func settings() -> DistributorSettings
  func updateSettings(_ patch: APISettingsPatch) async throws(HTTPError) -> DistributorSettings
  /// The account, and the games an upload may name. Asks TeamStation for the
  /// games, so it is the one call here that needs the network.
  func teamStation() async -> APITeamStation
}

/// TS Distributor's REST API: JSON over HTTP/1.1 on 127.0.0.1, so only this Mac can reach it.
/// `GET /api/v1` lists every route with what it does.
public enum DistributorAPI {
  public static let port: UInt16 = 8771

  public static let about = """
    TS Distributor exports TS Director's recordings from an iPad on the USB-C cable into this Mac's \
    export folder, makes the combined video, and uploads to a game on TeamStation. A recording's files are named \
    by track: "primary", or "camera:<source id>"; a camera's name also works. Starting work answers \
    202 with the run; follow it with GET /api/v1/runs/{id} or /api/v1/events. One run at a time: a \
    second answers 409, and several recordings go in one run: POST /api/v1/runs with recordings or \
    takes. Work that needs the iPad answers 412 iPadNotAttached while none is attached, \
    and 423 while TS Director records or streams; files already on this Mac need no iPad.
    """

  struct Deleted: Codable {
    var deleted: [Int64]
    var refused: [Int64]
  }

  public static func router(actions: any DistributorActions, events: JSONEventHub<APIEvent>) -> Router {
    var router = Router()

    router.add("GET", "/api/v1/status", summary: "The iPad, this Mac's export folder, the run under way, and TeamStation") { _, _ in
      .apiJSON(await actions.status())
    }
    router.add("GET", "/api/v1/events", summary: "The status again, as a line of JSON, each time it changes") { _, _ in
      .events(events)
    }

    router.add("GET", "/api/v1/recordings", summary: "Every recording of the attached iPad (or the last list seen from one), with what of each is on this Mac") { _, _ in
      .apiJSON(await actions.recordings())
    }
    router.add("DELETE", "/api/v1/recordings", summary: "Deletes recordings on the iPad: ?ids=361,362&confirm=true") { request, _ in
      guard request.query["confirm"] == "true" else {
        throw HTTPError(400, "confirmRequired", "deleting recordings on the iPad needs confirm=true")
      }
      let ids = (request.query["ids"] ?? "").split(separator: ",").compactMap { Int64($0) }
      guard !ids.isEmpty else { throw HTTPError.badRequest("ids is required, like ids=361,362") }
      let refused = try await actions.deleteRecordings(ids)
      return .apiJSON(Deleted(deleted: ids.filter { !refused.contains($0) }, refused: refused))
    }
    router.add("GET", "/api/v1/recordings/{id}", summary: "One recording and what of it is on this Mac") { _, parameters in
      .apiJSON(try await actions.recording(try parameters.int64("id")))
    }
    router.add("GET", "/api/v1/recordings/{id}/still", summary: "One JPEG of a file about ?at=<seconds> in (default 10): ?track=primary|camera:<id>|<name>") { request, parameters in
      let jpeg = try await actions.still(
        recording: try parameters.int64("id"),
        track: request.query["track"] ?? "primary",
        at: request.query["at"].flatMap(Double.init) ?? 10
      )
      return .data(status: 200, contentType: "image/jpeg", body: jpeg)
    }

    let verbs: [(String, APIRunKind, String)] = [
      ("download", .download, "Brings files onto this Mac, every one off the iPad before any is stitched: {tracks?, reprocess?}"),
      ("export", .export, "Files, then the combined video as the settings say, then uploads to the take's game when signed in: {tracks?, reprocess?, combined?, upload?}"),
      ("combined", .combined, "Makes the combined video, fetching any file it needs: {combined: {include?, audioCamera?}}"),
      ("upload", .upload, "Uploads to the take's game on TeamStation, fetching any file not on this Mac first: {upload?: {game?, tracks?, title?}}")
    ]
    for (verb, kind, summary) in verbs {
      router.add("POST", "/api/v1/recordings/{id}/\(verb)", summary: summary) { request, parameters in
        var body: APIRunRequest = try request.decode()
        body.kind = kind
        body.recording = try parameters.int64("id")
        _ = try body.perTake()
        return .apiJSON(try await actions.startRun(body), status: 202)
      }
    }
    router.add("POST", "/api/v1/runs", summary: "Starts exactly the run described, of one recording or several, every file of every one off the iPad first: {kind?, recording | recordings | takes: [{recording, tracks?, combined?, upload?}], tracks?, reprocess?, combined?, upload?}") { request, _ in
      var body: APIRunRequest = try request.decode()
      _ = try body.perTake()
      body.kind = body.kind ?? .custom
      return .apiJSON(try await actions.startRun(body), status: 202)
    }
    router.add("GET", "/api/v1/runs/current", summary: "The run under way, or the last one") { _, _ in
      guard let run = await actions.currentRun() else { throw HTTPError.notFound("nothing has run since TS Distributor started") }
      return .apiJSON(run)
    }
    router.add("GET", "/api/v1/runs/{id}", summary: "One run: for each of its recordings, each file, the combined video and each upload, and where they have got to") { _, parameters in
      guard let id = UUID(uuidString: parameters["id"] ?? "") else { throw HTTPError.badRequest("a run id is a UUID") }
      guard let run = await actions.run(id) else { throw HTTPError.notFound("no run \(id)") }
      return .apiJSON(run)
    }
    router.add("DELETE", "/api/v1/runs/{id}", summary: "Cancels a run; files already saved stay, and a cut-off download resumes next time") { _, parameters in
      guard let id = UUID(uuidString: parameters["id"] ?? "") else { throw HTTPError.badRequest("a run id is a UUID") }
      return .apiJSON(try await actions.cancelRun(id))
    }

    router.add("GET", "/api/v1/settings", summary: "The settings, as this Mac holds them") { _, _ in
      .apiJSON(await actions.settings())
    }
    router.add("PATCH", "/api/v1/settings", summary: "Changes settings; what is left out stays: {destination?, createCombined?, upload?: {choice?: {primary?, cameras?, combined?}}}") { request, _ in
      .apiJSON(try await actions.updateSettings(try request.decode()))
    }

    router.add("GET", "/api/v1/teamstation", summary: "The TeamStation account this Mac uploads with, and the games already played that an upload can name") { _, _ in
      .apiJSON(await actions.teamStation())
    }

    let index = APIRoute(method: "GET", path: "/api/v1", summary: "This list")
    let listing = [ index ] + router.routes.map { APIRoute(method: $0.method, path: $0.pattern, summary: $0.summary) }
    router.add(index.method, index.path, summary: index.summary) { _, _ in
      .apiJSON(APIIndex(name: "TS Distributor", about: about, routes: listing))
    }
    return router
  }
}
