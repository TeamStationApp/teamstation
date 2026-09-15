import DirectorCore
import DirectorExport
import DistributorWire
import Foundation
import PeerTubeKit

/// What the Director is, for `/v1/hello`.
public struct DirectorIdentity: Sendable {
  public var deviceName: String
  public var directorVersion: String
  public var directorID: UUID
  public var isRecording: Bool
  public var isStreaming: Bool

  public init(deviceName: String, directorVersion: String, directorID: UUID, isRecording: Bool, isStreaming: Bool = false) {
    self.deviceName = deviceName
    self.directorVersion = directorVersion
    self.directorID = directorID
    self.isRecording = isRecording
    self.isStreaming = isStreaming
  }
}

public enum DistributorRefusal: Error, Equatable, Sendable {
  /// Exporting, and stitching on the iPad, are refused while it records or streams, so neither
  /// competes with a live game.
  case recording
  case streaming
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
  /// One JPEG frame of `sourceID` about `seconds` into the recording, for previews; nil when there
  /// is no picture there.
  func still(recordingID: Int64, sourceID: SourceID, at seconds: Double) async throws -> Data?
  /// Starts GS Distributor's export: from now until `endExport`, GS Director records and streams
  /// nothing. Refused while it records or streams.
  func beginExport() async throws -> UUID
  /// Keeps the lock from expiring. False when it is no longer held.
  func renewExport(_ id: UUID) async -> Bool
  func endExport(_ id: UUID) async
}

public extension DistributorBackend {
  func still(recordingID: Int64, sourceID: SourceID, at seconds: Double) async throws -> Data? { nil }
  func renewExport(_ id: UUID) async -> Bool { true }
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
  /// The PeerTube account GS Director signs in to for GS Distributor, with its own tokens; the Mac
  /// signs in with its own too.
  private let peerTube: PeerTubeAccount

  public init(
    backend: any DistributorBackend,
    roots: FileRoots,
    settings: DistributorSettingsStore,
    peerTube: PeerTubeAccount,
    events: EventHub = EventHub()
  ) {
    self.backend = backend
    self.roots = roots
    self.settings = settings
    self.peerTube = peerTube
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
          isStreaming: identity.isStreaming,
          sessionID: sessionID
        ))

      case ("POST", "export-lock") where route.count == 1:
        return .json(ExportLockGranted(lockID: try await backend.beginExport()))

      case ("PUT", "export-lock") where route.count == 2:
        guard let id = UUID(uuidString: route[1]) else { return .error(400, "bad lock id") }
        return await backend.renewExport(id) ? .ok : .error(404, "that export lock is no longer held")

      case ("DELETE", "export-lock") where route.count == 2:
        guard let id = UUID(uuidString: route[1]) else { return .error(400, "bad lock id") }
        await backend.endExport(id)
        return .ok

      case ("GET", "recordings") where route.count == 1:
        return .json(try await backend.recordings())

      case ("DELETE", "recordings") where route.count == 1:
        let ids = (request.query["ids"] ?? "").split(separator: ",").compactMap { Int64($0) }
        guard !ids.isEmpty else { return .error(400, "ids required") }
        let refused = try await backend.deleteRecordings(ids)
        return refused.isEmpty
          ? .ok
          : .json(DeleteRefused(refused: refused, reason: "a recording in progress cannot be deleted"), status: 409)

      case ("GET", "recordings") where route.count == 3 && route[2] == "still":
        guard let id = Int64(route[1]), let camera = request.query["camera"], !camera.isEmpty else {
          return .error(400, "recording and camera required")
        }
        let at = request.query["at"].flatMap(Double.init) ?? 10
        guard let jpeg = try await backend.still(recordingID: id, sourceID: SourceID(camera), at: at) else {
          return .error(404, "no picture there")
        }
        return .data(status: 200, contentType: "image/jpeg", body: jpeg)

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

      case ("POST", "peertube") where route.count == 2 && route[1] == "signin":
        guard let signIn = try? JSONDecoder().decode(PeerTubeSignIn.self, from: request.body),
              let host = try? PeerTubeHost.normalize(signIn.host),
              !signIn.username.isEmpty
        else { return .error(400, "instance, username and password required") }
        do {
          try await peerTube.signIn(host: host, username: signIn.username, password: signIn.password, otp: signIn.otp)
        } catch PeerTubeError.otpRequired {
          return .json(PeerTubeSignInResult.otpRequired)
        }
        try rememberPeerTubeAccount(host: host, username: signIn.username)
        return .json(PeerTubeSignInResult.signedIn(account: signIn.username))

      case ("GET", "peertube") where route.count == 2 && route[1] == "token":
        let token = try await peerTube.accessToken()
        return .json(PeerTubeToken(
          host: token.host,
          username: token.username,
          accessToken: token.token,
          expiresAt: token.expiresAt
        ))

      case ("POST", "peertube") where route.count == 2 && route[1] == "signout":
        await peerTube.signOut()
        return .ok

      default:
        return .error(404, "unknown route")
      }
    } catch PeerTubeError.signInAgain {
      return .error(401, "GS Director is not signed in to PeerTube")
    } catch let error as PeerTubeError {
      switch error {
      case .invalidCredentials, .notPeerTube: return .error(401, error.description)
      default: return .error(502, error.description)
      }
    } catch let error as URLError {
      return .error(502, "the iPad could not reach PeerTube: \(error.localizedDescription)")
    } catch DistributorRefusal.recording {
      return .error(409, "GS Director is recording; export once the take has stopped")
    } catch DistributorRefusal.streaming {
      return .error(409, "GS Director is streaming; export once the stream has stopped")
    } catch DistributorRefusal.notFound {
      return .error(404, "not found")
    } catch {
      return .error(500, "\(error)")
    }
  }

  /// Notes the account in the settings, stamped as changed on the iPad.
  private func rememberPeerTubeAccount(host: String, username: String) throws {
    let before = settings.load()
    var saved = before
    saved.peerTube.host = host
    saved.peerTube.username = username
    try settings.save(saved.stampingChanges(from: before, by: SettingsStamp.iPad))
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
