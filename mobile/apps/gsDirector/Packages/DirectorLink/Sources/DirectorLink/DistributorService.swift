import DirectorCore
import DirectorExport
import DistributorWire
import Foundation

/// What the Director is, for `/v1/hello`.
public struct DirectorIdentity: Sendable {
  public var deviceName: String
  public var directorVersion: String
  public var directorID: UUID
  public var isRecording: Bool

  public init(deviceName: String, directorVersion: String, directorID: UUID, isRecording: Bool) {
    self.deviceName = deviceName
    self.directorVersion = directorVersion
    self.directorID = directorID
    self.isRecording = isRecording
  }
}

public enum DistributorRefusal: Error, Equatable, Sendable {
  /// Stitching on the iPad is refused while it records, so a remux never competes with a live take.
  case recording
  case notFound
}

/// What the service needs from GS Director itself.
public protocol DistributorBackend: Sendable {
  func identity() async -> DirectorIdentity
  func recordings() async throws -> [RecordingListing]
  /// Deletes what it may and returns the ids it refused: the live take, if it was asked for.
  func deleteRecordings(_ ids: [Int64]) async throws -> [Int64]
  func manifest(recordingID: Int64, tracks: [Track]) async throws -> ManifestResponse?
  /// Starts stitching one track on the iPad, reporting through `events` under `id`.
  func startJob(_ request: JobRequest, id: UUID, events: EventHub) async throws
  func cancelJob(_ id: UUID) async
}

/// The routes GS Distributor calls. See `DistributorWire` for the message types.
public final class DistributorService: Sendable {
  /// What `/v1/events` streams. Shared with GS Director, which publishes its own changes on it.
  public let events: EventHub
  /// New every launch; `Hello.sessionID`.
  public let sessionID = UUID()

  private let backend: any DistributorBackend
  private let roots: FileRoots
  private let settings: DistributorSettingsStore

  public init(
    backend: any DistributorBackend,
    roots: FileRoots,
    settings: DistributorSettingsStore,
    events: EventHub = EventHub()
  ) {
    self.backend = backend
    self.roots = roots
    self.settings = settings
    self.events = events
  }

  public func handle(_ request: HTTPRequest) async -> HTTPResponse {
    let parts = request.path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
    guard parts.first == "v1" else { return .error(404, "unknown route") }
    let route = Array(parts.dropFirst())

    do {
      switch (request.method, route.first) {
      case ("GET", "hello"):
        let identity = await backend.identity()
        return .json(Hello(
          deviceName: identity.deviceName,
          directorVersion: identity.directorVersion,
          directorID: identity.directorID,
          isRecording: identity.isRecording,
          sessionID: sessionID
        ))

      case ("GET", "recordings") where route.count == 1:
        return .json(try await backend.recordings())

      case ("DELETE", "recordings") where route.count == 1:
        let ids = (request.query["ids"] ?? "").split(separator: ",").compactMap { Int64($0) }
        guard !ids.isEmpty else { return .error(400, "ids required") }
        let refused = try await backend.deleteRecordings(ids)
        return refused.isEmpty
          ? .ok
          : .json(DeleteRefused(refused: refused, reason: "a recording in progress cannot be deleted"), status: 409)

      case ("GET", "recordings") where route.count == 3 && route[2] == "manifest":
        guard let id = Int64(route[1]) else { return .error(400, "bad recording id") }
        guard let tracks = Self.tracks(request.query["tracks"]) else { return .error(400, "bad tracks") }
        guard let manifest = try await backend.manifest(recordingID: id, tracks: tracks) else {
          return .error(404, "no such recording")
        }
        return .json(manifest)

      case ("GET", "files") where route.count >= 3:
        guard let root = FileRoot(rawValue: route[1]),
              let url = roots.url(root: root, relativePath: route.dropFirst(2).joined(separator: "/"))
        else { return .error(404, "not found") }
        return .file(url, contentType: Self.contentType(of: url))

      case ("POST", "jobs") where route.count == 1:
        guard let job = try? JSONDecoder().decode(JobRequest.self, from: request.body) else {
          return .error(400, "bad job")
        }
        let id = UUID()
        try await backend.startJob(job, id: id, events: events)
        return .json(JobAccepted(jobID: id))

      case ("DELETE", "jobs") where route.count == 2:
        guard let id = UUID(uuidString: route[1]) else { return .error(400, "bad job id") }
        await backend.cancelJob(id)
        return .ok

      case ("GET", "events") where route.count == 1:
        return .events(events)

      case ("GET", "settings") where route.count == 1:
        return .json(settings.load())

      case ("PUT", "settings") where route.count == 1:
        guard let incoming = try? JSONDecoder().decode(DistributorSettings.self, from: request.body) else {
          return .error(400, "bad settings")
        }
        let merged = DistributorSettingsStore.merge(
          incoming,
          into: settings.load(),
          mac: request.header("x-distributor-mac")
        )
        try settings.save(merged)
        return .json(merged)

      default:
        return .error(404, "unknown route")
      }
    } catch DistributorRefusal.recording {
      return .error(409, "GS Director is recording; the Mac stitches everything until it stops")
    } catch DistributorRefusal.notFound {
      return .error(404, "not found")
    } catch {
      return .error(500, "\(error)")
    }
  }

  /// `primary,camera:<source id>,…`
  static func tracks(_ value: String?) -> [Track]? {
    guard let value, !value.isEmpty else { return [] }
    var tracks: [Track] = []
    for item in value.split(separator: ",") {
      if item == "primary" {
        tracks.append(.primary)
      } else if item.hasPrefix("camera:"), item.count > "camera:".count {
        tracks.append(.camera(SourceID(String(item.dropFirst("camera:".count)))))
      } else {
        return nil
      }
    }
    return tracks
  }

  static func contentType(of url: URL) -> String {
    switch url.pathExtension.lowercased() {
    case "mp4", "mov", "m4v": "video/mp4"
    case "jpg", "jpeg": "image/jpeg"
    default: "application/octet-stream"
    }
  }
}

struct DeleteRefused: Codable {
  var refused: [Int64]
  var reason: String
}
