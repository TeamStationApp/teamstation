import Foundation

public struct UploadedVideo: Equatable, Sendable {
  public var id: Int?
  public var shortUUID: String?
  public var uuid: String?
}

extension PeerTubeAPI {
  public static let chunkBytes = 8 << 20

  /// Uploads `file` as a new video with PeerTube's resumable protocol.
  ///
  /// Eight-mebibyte chunks, each retried up to five times on a server error or 429 with a growing
  /// pause; a dropped connection asks the server how much it has and carries on from there. The
  /// access token is fetched before every chunk, so a long upload survives the token expiring.
  /// Transcoding is not waited for. The upload session is deleted at the end, as the web client
  /// does. `originallyPublishedAt` is when the video was recorded, so the start time travels with
  /// it.
  public func upload(
    file: URL,
    name: String,
    channelID: Int,
    privacy: Int,
    originallyPublishedAt: Date? = nil,
    token: @escaping @Sendable () async throws -> String,
    progress: (@Sendable (Int64, Int64) -> Void)? = nil
  ) async throws -> UploadedVideo {
    let size = ((try FileManager.default.attributesOfItem(atPath: file.path)[.size]) as? NSNumber)?.int64Value ?? 0
    let location = try await startUpload(
      file: file,
      size: size,
      name: name,
      channelID: channelID,
      privacy: privacy,
      originallyPublishedAt: originallyPublishedAt,
      token: try await token()
    )
    let handle = try FileHandle(forReadingFrom: file)
    defer { try? handle.close() }

    var offset: Int64 = 0
    var finished: UploadedVideo?
    while offset < size {
      let length = Int(min(Int64(Self.chunkBytes), size - offset))
      try handle.seek(toOffset: UInt64(offset))
      guard let chunk = try handle.read(upToCount: length), chunk.count == length else {
        throw PeerTubeError.http(status: 0, message: "could not read \(file.lastPathComponent)")
      }
      let end = offset + Int64(length) - 1
      var attempt = 0
      while true {
        attempt += 1
        var request = URLRequest(url: location)
        request.httpMethod = "PUT"
        request.setValue("Bearer \(try await token())", forHTTPHeaderField: "Authorization")
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.setValue("bytes \(offset)-\(end)/\(size)", forHTTPHeaderField: "Content-Range")
        do {
          let (data, response) = try await session.upload(for: request, from: chunk)
          let http = response as? HTTPURLResponse
          let status = http?.statusCode ?? 0
          if status == 200 || status == 201 {
            finished = Self.uploaded(data)
            break
          }
          if status == 308 {
            // The server says how much it holds; after a retry that can differ from what was sent.
            offset = http.flatMap(Self.received) ?? end + 1
            break
          }
          guard (status >= 500 || status == 429), attempt < 5 else { throw Self.failure(status, data) }
        } catch let error as PeerTubeError {
          throw error
        } catch {
          if Task.isCancelled { throw CancellationError() }
          // The connection dropped mid-chunk: ask where the server got to and go on from there.
          guard attempt < 5 else { throw error }
          if let resumeAt = try? await receivedSoFar(location: location, size: size, token: try await token()), resumeAt != offset {
            offset = resumeAt
            break
          }
        }
        try await Task.sleep(for: .seconds(Double(attempt)))
      }
      if finished != nil { offset = size }
      progress?(offset, size)
    }

    var cleanup = URLRequest(url: location)
    cleanup.httpMethod = "DELETE"
    cleanup.setValue("Bearer \(try await token())", forHTTPHeaderField: "Authorization")
    _ = try? await session.data(for: cleanup)
    return finished ?? UploadedVideo(id: nil, shortUUID: nil, uuid: nil)
  }

  /// Opens the upload and returns where its chunks go.
  func startUpload(
    file: URL,
    size: Int64,
    name: String,
    channelID: Int,
    privacy: Int,
    originallyPublishedAt: Date? = nil,
    token: String
  ) async throws -> URL {
    let boundary = "gs-\(UUID().uuidString)"
    var fields = [
      ("name", name),
      ("channelId", String(channelID)),
      ("privacy", String(privacy)),
      ("waitTranscoding", "false"),
      ("filename", file.lastPathComponent)
    ]
    if let originallyPublishedAt { fields.append(("originallyPublishedAt", Self.iso8601(originallyPublishedAt))) }
    let body = Self.multipart(fields, boundary: boundary)

    var request = URLRequest(url: base.appendingPathComponent("videos/upload-resumable"))
    request.httpMethod = "POST"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    request.setValue(String(size), forHTTPHeaderField: "X-Upload-Content-Length")
    request.setValue(Self.mimeType(file), forHTTPHeaderField: "X-Upload-Content-Type")
    request.httpBody = body
    let (data, response) = try await session.data(for: request)
    let http = response as? HTTPURLResponse
    let status = http?.statusCode ?? 0
    if status == 413 { throw PeerTubeError.overQuota(Self.message(data) ?? "over quota") }
    guard status == 201 || status == 200, let location = http?.value(forHTTPHeaderField: "Location"),
          let url = URL(string: location, relativeTo: URL(string: "https://\(host)")!)?.absoluteURL
    else { throw Self.failure(status, data) }
    return url
  }

  /// How many bytes the server holds for an interrupted upload.
  func receivedSoFar(location: URL, size: Int64, token: String) async throws -> Int64? {
    var request = URLRequest(url: location)
    request.httpMethod = "PUT"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("0", forHTTPHeaderField: "Content-Length")
    request.setValue("bytes */\(size)", forHTTPHeaderField: "Content-Range")
    let (_, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode == 308 else { return nil }
    return Self.received(http) ?? 0
  }

  /// The byte count a 308's `Range: bytes=0-<last>` reports; nil when it has no Range, which
  /// means nothing has arrived.
  static func received(_ response: HTTPURLResponse) -> Int64? {
    guard let range = response.value(forHTTPHeaderField: "Range"),
          let last = range.split(separator: "-").last.flatMap({ Int64($0) })
    else { return nil }
    return last + 1
  }

  static func uploaded(_ data: Data) -> UploadedVideo {
    struct Wire: Decodable {
      struct Video: Decodable {
        var id: Int?
        var shortUUID: String?
        var uuid: String?
      }
      var video: Video?
    }
    let video = (try? JSONDecoder().decode(Wire.self, from: data))?.video
    return UploadedVideo(id: video?.id, shortUUID: video?.shortUUID, uuid: video?.uuid)
  }

  static func mimeType(_ file: URL) -> String {
    switch file.pathExtension.lowercased() {
    case "mp4", "m4v": "video/mp4"
    case "webm": "video/webm"
    case "mkv": "video/x-matroska"
    default: "video/quicktime"
    }
  }
}
