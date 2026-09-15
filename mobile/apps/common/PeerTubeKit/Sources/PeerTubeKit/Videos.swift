import Foundation

/// One video of the signed-in account, as the video lists and `GET videos/{id}` describe it.
public struct PeerTubeVideo: Equatable, Sendable {
  public var id: Int
  public var uuid: String
  public var shortUUID: String?
  public var name: String
  /// In a list, PeerTube shortens this; `video(_:accessToken:)` has all of it.
  public var description: String?
  public var channel: PeerTubeChannelInfo
  public var publishedAt: Date?
  /// When the video was recorded, where whoever uploaded it said so.
  public var originallyPublishedAt: Date?
  public var privacy: Int?
  public var duration: Int?

  public init(
    id: Int,
    uuid: String,
    shortUUID: String? = nil,
    name: String,
    description: String? = nil,
    channel: PeerTubeChannelInfo,
    publishedAt: Date? = nil,
    originallyPublishedAt: Date? = nil,
    privacy: Int? = nil,
    duration: Int? = nil
  ) {
    self.id = id
    self.uuid = uuid
    self.shortUUID = shortUUID
    self.name = name
    self.description = description
    self.channel = channel
    self.publishedAt = publishedAt
    self.originallyPublishedAt = originallyPublishedAt
    self.privacy = privacy
    self.duration = duration
  }

  /// `https://<host>/w/<shortUUID>`, else the long id.
  public func watchURL(host: String) -> URL? {
    URL(string: "https://\(host)/w/\(shortUUID ?? uuid)")
  }
}

extension PeerTubeAPI {
  public static let videoPageSize = 100

  /// Every video of the signed-in account, on all its channels, newest first. Pages through the
  /// list `videoPageSize` at a time and stops at `limit`.
  public func myVideos(accessToken: String, search: String? = nil, limit: Int = 5_000) async throws -> [PeerTubeVideo] {
    var videos: [PeerTubeVideo] = []
    var start = 0
    while videos.count < limit {
      var components = URLComponents()
      components.path = "users/me/videos"
      var items = [
        URLQueryItem(name: "start", value: String(start)),
        URLQueryItem(name: "count", value: String(Self.videoPageSize)),
        URLQueryItem(name: "sort", value: "-publishedAt")
      ]
      if let search, !search.isEmpty { items.append(URLQueryItem(name: "search", value: search)) }
      components.queryItems = items
      let (data, status) = try await get(components.string!, token: accessToken)
      guard status == 200 else { throw Self.failure(status, data) }
      let page = try Self.decoder.decode(VideoPage.self, from: data)
      videos += page.data.map(\.video)
      start += page.data.count
      if page.data.isEmpty || start >= page.total { break }
    }
    return Array(videos.prefix(limit))
  }

  /// One video, with its whole description. `id` is its number, uuid or short uuid.
  public func video(_ id: String, accessToken: String) async throws -> PeerTubeVideo {
    let (data, status) = try await get("videos/\(id)", token: accessToken)
    guard status == 200 else { throw Self.failure(status, data) }
    return try Self.decoder.decode(VideoWire.self, from: data).video
  }

  /// Changes a video's description and when it was recorded; whatever is nil is left as it is.
  public func updateVideo(
    _ id: String,
    description: String? = nil,
    originallyPublishedAt: Date? = nil,
    accessToken: String
  ) async throws {
    var fields: [(String, String)] = []
    if let description { fields.append(("description", description)) }
    if let originallyPublishedAt { fields.append(("originallyPublishedAt", Self.iso8601(originallyPublishedAt))) }
    guard !fields.isEmpty else { return }
    let boundary = "gs-\(UUID().uuidString)"
    var request = URLRequest(url: base.appendingPathComponent("videos/\(id)"))
    request.httpMethod = "PUT"
    request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    request.httpBody = Self.multipart(fields, boundary: boundary)
    let (data, response) = try await session.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard status == 204 || status == 200 else { throw Self.failure(status, data) }
  }

  // MARK: - Plumbing

  static func multipart(_ fields: [(String, String)], boundary: String) -> Data {
    var body = Data()
    for (field, value) in fields {
      body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(field)\"\r\n\r\n\(value)\r\n".utf8))
    }
    body.append(Data("--\(boundary)--\r\n".utf8))
    return body
  }

  static func iso8601(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [ .withInternetDateTime, .withFractionalSeconds ]
    return formatter.string(from: date)
  }

  /// PeerTube writes dates with milliseconds, which `.iso8601` alone does not read.
  static var decoder: JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let text = try decoder.singleValueContainer().decode(String.self)
      let withFraction = ISO8601DateFormatter()
      withFraction.formatOptions = [ .withInternetDateTime, .withFractionalSeconds ]
      if let date = withFraction.date(from: text) ?? ISO8601DateFormatter().date(from: text) { return date }
      throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "not a date: \(text)"))
    }
    return decoder
  }

  struct VideoPage: Decodable {
    var total: Int
    var data: [VideoWire]
  }

  struct VideoWire: Decodable {
    struct Channel: Decodable {
      var id: Int
      var name: String
      var displayName: String?
    }
    struct Privacy: Decodable {
      var id: Int
    }
    var id: Int
    var uuid: String
    var shortUUID: String?
    var name: String
    var description: String?
    var channel: Channel
    var publishedAt: Date?
    var originallyPublishedAt: Date?
    var privacy: Privacy?
    var duration: Int?

    var video: PeerTubeVideo {
      PeerTubeVideo(
        id: id,
        uuid: uuid,
        shortUUID: shortUUID,
        name: name,
        description: description,
        channel: PeerTubeChannelInfo(id: channel.id, name: channel.name, displayName: channel.displayName ?? channel.name),
        publishedAt: publishedAt,
        originallyPublishedAt: originallyPublishedAt,
        privacy: privacy?.id,
        duration: duration
      )
    }
  }
}
