import DirectorCore
import DistributorWire
import Foundation

public enum DirectorClientError: Error, Equatable, CustomStringConvertible, Sendable {
  case http(status: Int, message: String)
  /// The Director speaks a different protocol version; one of the two apps needs updating.
  case protocolMismatch(director: Int, mac: Int)
  case badResponse

  public var description: String {
    switch self {
    case let .http(status, message): "GS Director answered \(status): \(message)"
    case let .protocolMismatch(director, mac): "GS Director speaks protocol \(director), this Mac \(mac)"
    case .badResponse: "GS Director sent something this Mac could not read"
    }
  }
}

/// GS Director's routes, as seen from the Mac. `baseURL` is the loopback forwarder's address.
public final class DirectorConnection: Sendable {
  public let baseURL: URL
  /// This Mac's hardware UUID, which keys its download folder on the iPad.
  public let macID: String
  let session: URLSession
  let downloader: StreamingDownloader

  public init(baseURL: URL, macID: String) {
    self.baseURL = baseURL
    self.macID = macID
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpMaximumConnectionsPerHost = 6
    configuration.timeoutIntervalForRequest = 60
    self.session = URLSession(configuration: configuration)
    self.downloader = StreamingDownloader(configuration: configuration)
  }

  public func hello() async throws -> Hello {
    let hello: Hello = try await get("/v1/hello")
    guard hello.protocolVersion == DistributorProtocol.version else {
      throw DirectorClientError.protocolMismatch(director: hello.protocolVersion, mac: DistributorProtocol.version)
    }
    return hello
  }

  public func recordings() async throws -> [RecordingListing] {
    try await get("/v1/recordings")
  }

  /// Deletes on the iPad. Returns the ids it refused, which is the take in progress if it was asked.
  public func deleteRecordings(_ ids: [Int64]) async throws -> [Int64] {
    let list = ids.map(String.init).joined(separator: ",")
    let (status, data) = try await send("DELETE", "/v1/recordings?ids=\(list)")
    switch status {
    case 200: return []
    case 409: return (try? JSONDecoder().decode(Refused.self, from: data).refused) ?? ids
    default: throw Self.failure(status, data)
    }
  }

  public func manifest(recordingID: Int64, tracks: [Track]) async throws -> ManifestResponse {
    let list = tracks.map { track in
      switch track {
      case .primary: "primary"
      case .camera(let sourceID): "camera:\(sourceID.rawValue)"
      }
    }.joined(separator: ",")
    let query = list.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? list
    return try await get("/v1/recordings/\(recordingID)/manifest?tracks=\(query)")
  }

  /// One JPEG frame of `camera` about `seconds` into the recording, for previews.
  public func still(recordingID: Int64, camera: SourceID, at seconds: Double = 10) async throws -> Data {
    let id = camera.rawValue.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? camera.rawValue
    let (status, data) = try await send("GET", "/v1/recordings/\(recordingID)/still?camera=\(id)&at=\(seconds)")
    guard status == 200 else { throw Self.failure(status, data) }
    return data
  }

  /// Asks GS Director to record and stream nothing while this Mac exports. Refused with a 409
  /// while it is recording or streaming.
  public func beginExport() async throws -> UUID {
    let (status, data) = try await send("POST", "/v1/export-lock")
    guard status == 200 else { throw Self.failure(status, data) }
    return try JSONDecoder().decode(ExportLockGranted.self, from: data).lockID
  }

  /// Keeps the export lock: GS Director drops one left unrenewed for half a minute. False when it
  /// is no longer held.
  public func renewExport(_ id: UUID) async throws -> Bool {
    let (status, data) = try await send("PUT", "/v1/export-lock/\(id.uuidString)")
    if status == 404 { return false }
    guard status == 200 else { throw Self.failure(status, data) }
    return true
  }

  public func endExport(_ id: UUID) async throws {
    let (status, data) = try await send("DELETE", "/v1/export-lock/\(id.uuidString)")
    guard status == 200 else { throw Self.failure(status, data) }
  }

  public func startJob(_ job: JobRequest) async throws -> UUID {
    let (status, data) = try await send("POST", "/v1/jobs", body: try JSONEncoder().encode(job))
    guard status == 200 else { throw Self.failure(status, data) }
    return try JSONDecoder().decode(JobAccepted.self, from: data).jobID
  }

  public func cancelJob(_ id: UUID) async throws {
    let (status, data) = try await send("DELETE", "/v1/jobs/\(id.uuidString)")
    guard status == 200 else { throw Self.failure(status, data) }
  }

  public func settings() async throws -> DistributorSettings {
    try await get("/v1/settings")
  }

  /// Saves on the iPad. Only this Mac's download folder is taken from `settings`.
  public func saveSettings(_ settings: DistributorSettings) async throws -> DistributorSettings {
    let (status, data) = try await send(
      "PUT",
      "/v1/settings",
      body: try JSONEncoder().encode(settings),
      headers: [ "X-Distributor-Mac": macID ]
    )
    guard status == 200 else { throw Self.failure(status, data) }
    return try JSONDecoder().decode(DistributorSettings.self, from: data)
  }

  /// Signs GS Director in to PeerTube. The password goes to the iPad, which sends it to PeerTube
  /// and keeps only the tokens.
  public func peerTubeSignIn(_ signIn: PeerTubeSignIn) async throws -> PeerTubeSignInResult {
    let (status, data) = try await send("POST", "/v1/peertube/signin", body: try JSONEncoder().encode(signIn))
    guard status == 200 else { throw Self.failure(status, data) }
    return try JSONDecoder().decode(PeerTubeSignInResult.self, from: data)
  }

  /// An access token from the iPad's account; nil when it is not signed in.
  public func peerTubeToken() async throws -> PeerTubeToken? {
    let (status, data) = try await send("GET", "/v1/peertube/token")
    if status == 401 { return nil }
    guard status == 200 else { throw Self.failure(status, data) }
    return try JSONDecoder().decode(PeerTubeToken.self, from: data)
  }

  public func peerTubeSignOut() async throws {
    let (status, data) = try await send("POST", "/v1/peertube/signout")
    guard status == 200 else { throw Self.failure(status, data) }
  }

  /// GS Director's events until the connection drops.
  public func events() -> AsyncThrowingStream<DistributorEvent, Error> {
    let session = self.session
    let url = baseURL.appendingPathComponent("v1/events")
    return AsyncThrowingStream { continuation in
      let task = Task {
        do {
          var request = URLRequest(url: url)
          request.timeoutInterval = .infinity
          let (bytes, response) = try await session.bytes(for: request)
          guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw DirectorClientError.badResponse
          }
          for try await line in bytes.lines where !line.isEmpty {
            if let event = try? JSONDecoder().decode(DistributorEvent.self, from: Data(line.utf8)) {
              continuation.yield(event)
            }
          }
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }

  /// Where `file` is served. Each path component is percent-encoded on its own.
  public func url(for file: RemoteFile) -> URL {
    var url = baseURL.appendingPathComponent("v1/files").appendingPathComponent(file.root.rawValue)
    for component in file.path.split(separator: "/") {
      url.appendPathComponent(String(component))
    }
    return url
  }

  /// Fetches `file` to `destination`, resuming from a `.partial` file left by an earlier attempt.
  /// The finished file is renamed into place only once all of it has arrived.
  public func download(
    _ file: RemoteFile,
    to destination: URL,
    progress: (@Sendable (_ received: Int64, _ total: Int64) -> Void)? = nil
  ) async throws {
    try await downloader.download(from: url(for: file), to: destination, progress: progress)
  }

  // MARK: - Plumbing

  private struct Refused: Decodable {
    var refused: [Int64]
  }

  private struct ErrorBody: Decodable {
    var error: String?
  }

  static func failure(_ status: Int, _ data: Data) -> DirectorClientError {
    let message = (try? JSONDecoder().decode(ErrorBody.self, from: data).error) ?? nil
    return .http(status: status, message: message ?? String(decoding: data.prefix(200), as: UTF8.self))
  }

  private func get<Value: Decodable>(_ path: String) async throws -> Value {
    let (status, data) = try await send("GET", path)
    guard status == 200 else { throw Self.failure(status, data) }
    do {
      return try JSONDecoder().decode(Value.self, from: data)
    } catch {
      throw DirectorClientError.badResponse
    }
  }

  private func send(
    _ method: String,
    _ path: String,
    body: Data? = nil,
    headers: [String: String] = [:]
  ) async throws -> (Int, Data) {
    guard let url = URL(string: path, relativeTo: baseURL) else { throw DirectorClientError.badResponse }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.httpBody = body
    if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    for (name, value) in headers {
      request.setValue(value, forHTTPHeaderField: name)
    }
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw DirectorClientError.badResponse }
    return (http.statusCode, data)
  }
}
