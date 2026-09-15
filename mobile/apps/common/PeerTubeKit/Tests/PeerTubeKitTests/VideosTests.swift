import Foundation
@testable import PeerTubeKit
import Testing

@Suite("PeerTube videos")
struct PeerTubeVideosTests {
  static func video(_ id: Int, channel: Int = 1) -> [String: Any] {
    [
      "id": id,
      "uuid": "uuid-\(id)",
      "shortUUID": "s\(id)",
      "name": "Game \(id)",
      "description": "short",
      "channel": [ "id": channel, "name": "chan\(channel)", "displayName": "Channel \(channel)" ],
      "publishedAt": "2026-08-24T02:00:00.123Z",
      "originallyPublishedAt": id == 1 ? "2026-08-24T01:05:00.000Z" : NSNull(),
      "privacy": [ "id": 2, "label": "Unlisted" ],
      "duration": 3_600
    ]
  }

  @Test("Every video of the account is listed, page after page, across its channels")
  func listsAllPages() async throws {
    let stub = StubPeerTube { seen in
      guard seen.path.hasPrefix("/api/v1/users/me/videos") else { return StubPeerTube.json([:], status: 404) }
      let start = seen.path.contains("start=100") ? 100 : 0
      let count = start == 0 ? 100 : 50
      return StubPeerTube.json([
        "total": 150,
        "data": (0..<count).map { Self.video(start + $0 + 1, channel: ($0 % 2) + 1) }
      ])
    }
    let videos = try await PeerTubeAPI(host: "videos.example.org", session: stub.session())
      .myVideos(accessToken: "a1", search: "Taipans")
    #expect(videos.count == 150)
    #expect(Set(videos.map(\.channel.displayName)) == [ "Channel 1", "Channel 2" ])
    #expect(videos[0].originallyPublishedAt == Date(timeIntervalSince1970: 1_787_533_500))
    #expect(videos[0].publishedAt != nil)
    #expect(videos[1].originallyPublishedAt == nil)
    #expect(videos[0].watchURL(host: "videos.example.org")?.absoluteString == "https://videos.example.org/w/s1")
    #expect(stub.seen.count == 2)
    #expect(stub.seen.allSatisfy { $0.path.contains("search=Taipans") && $0.headers["Authorization"] == "Bearer a1" })
  }

  @Test("One video comes with its whole description")
  func oneVideo() async throws {
    let stub = StubPeerTube { seen in
      var body = Self.video(7)
      body["description"] = String(repeating: "x", count: 500)
      return seen.path == "/api/v1/videos/s7" ? StubPeerTube.json(body) : StubPeerTube.json([:], status: 404)
    }
    let video = try await PeerTubeAPI(host: "videos.example.org", session: stub.session()).video("s7", accessToken: "a1")
    #expect(video.description?.count == 500)
    #expect(video.privacy == 2)
  }

  @Test("A description and recording time go up as a multipart PUT, and nothing goes when both are nil")
  func updates() async throws {
    let stub = StubPeerTube { seen in
      seen.method == "PUT" && seen.path == "/api/v1/videos/uuid-3" ? (204, [:], Data()) : StubPeerTube.json([:], status: 404)
    }
    let api = PeerTubeAPI(host: "videos.example.org", session: stub.session())
    try await api.updateVideo(
      "uuid-3",
      description: "Trosky vs Taipans\n\n1:02 Single by Ava R",
      originallyPublishedAt: Date(timeIntervalSince1970: 1_787_533_500),
      accessToken: "a1"
    )
    let sent = try #require(stub.seen.first)
    let body = String(decoding: sent.body, as: UTF8.self)
    #expect(sent.headers["Content-Type"]?.hasPrefix("multipart/form-data; boundary=") == true)
    #expect(body.contains("name=\"description\"\r\n\r\nTrosky vs Taipans\n\n1:02 Single by Ava R\r\n"))
    #expect(body.contains("name=\"originallyPublishedAt\"\r\n\r\n2026-08-24T01:05:00.000Z\r\n"))

    try await api.updateVideo("uuid-3", accessToken: "a1")
    #expect(stub.seen.count == 1)
  }

  @Test("A refused update says why")
  func refusedUpdate() async throws {
    let stub = StubPeerTube { _ in StubPeerTube.json([ "detail": "Cannot manage a video of another user" ], status: 403) }
    await #expect(throws: PeerTubeError.http(status: 403, message: "Cannot manage a video of another user")) {
      try await PeerTubeAPI(host: "videos.example.org", session: stub.session())
        .updateVideo("uuid-3", description: "x", accessToken: "a1")
    }
  }

  @Test("An upload says when the video was recorded")
  func uploadCarriesRecordingTime() async throws {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("gs-\(UUID().uuidString).mp4")
    try Data(repeating: 1, count: 1_000).write(to: file)
    defer { try? FileManager.default.removeItem(at: file) }
    let stub = StubPeerTube { seen in
      switch (seen.method, seen.path) {
      case ("POST", "/api/v1/videos/upload-resumable"):
        return (201, [ "Location": "/api/v1/videos/upload-resumable?upload_id=u1" ], Data())
      case ("PUT", _):
        return StubPeerTube.json([ "video": [ "id": 9, "shortUUID": "s9", "uuid": "uuid-9" ] ])
      default:
        return (204, [:], Data())
      }
    }
    let uploaded = try await PeerTubeAPI(host: "videos.example.org", session: stub.session()).upload(
      file: file,
      name: "2026-08-23 Trosky vs Taipans",
      channelID: 1,
      privacy: 2,
      originallyPublishedAt: Date(timeIntervalSince1970: 1_787_533_500),
      token: { "a1" }
    )
    #expect(uploaded.shortUUID == "s9")
    let opened = try #require(stub.seen.first { $0.method == "POST" })
    #expect(String(decoding: opened.body, as: UTF8.self).contains("name=\"originallyPublishedAt\"\r\n\r\n2026-08-24T01:05:00.000Z\r\n"))
  }
}
