import Foundation
@testable import PeerTubeKit
import Testing

@Suite("PeerTube sign-in")
struct PeerTubeSignInTests {
  static func instance(otp expected: String? = nil) -> StubPeerTube {
    StubPeerTube { seen in
      switch (seen.method, seen.path) {
      case ("GET", "/api/v1/config"):
        return StubPeerTube.json([ "instance": [ "name": "Test" ] ])
      case ("GET", "/api/v1/oauth-clients/local"):
        return StubPeerTube.json([ "client_id": "cid", "client_secret": "secret" ])
      case ("POST", "/api/v1/users/token"):
        let form = String(decoding: seen.body, as: UTF8.self)
        if form.contains("grant_type=refresh_token") {
          return form.contains("refresh_token=r1")
            ? StubPeerTube.json([ "access_token": "a2", "refresh_token": "r2", "expires_in": 86_400, "refresh_token_expires_in": 1_209_600 ])
            : StubPeerTube.json([ "error": "invalid_grant" ], status: 400)
        }
        if let expected, seen.headers["x-peertube-otp"] != expected {
          return StubPeerTube.json([ "detail": "Missing two factor auth token" ], status: 401, headers: [ "x-peertube-otp": "required; app" ])
        }
        return form.contains("password=right%20horse")
          ? StubPeerTube.json([ "access_token": "a1", "refresh_token": "r1", "expires_in": 86_400, "refresh_token_expires_in": 1_209_600 ])
          : StubPeerTube.json([ "detail": "Invalid grant: user credentials are invalid" ], status: 400)
      case ("POST", "/api/v1/users/revoke-token"):
        return (200, [:], Data())
      default:
        return StubPeerTube.json([ "error": "not found" ], status: 404)
      }
    }
  }

  @Test("A password is exchanged once and only the tokens are kept")
  func signIn() async throws {
    let stub = Self.instance()
    let storage = MemoryAccountStorage()
    let account = PeerTubeAccount(storage: storage, session: stub.session())
    let stored = try await account.signIn(host: "videos.example.org", username: "spjr", password: "right horse", otp: nil)
    #expect(stored.tokens.accessToken == "a1")
    #expect(stored.client == OAuthClient(clientID: "cid", clientSecret: "secret"))
    let saved = try JSONEncoder().encode(try #require(storage.load()))
    #expect(!String(decoding: saved, as: UTF8.self).contains("right horse"))
  }

  @Test("A wrong password says so; two-factor asks for the code, then accepts it")
  func failuresAndTwoFactor() async throws {
    let plain = PeerTubeAccount(storage: MemoryAccountStorage(), session: Self.instance().session())
    await #expect(throws: PeerTubeError.self) {
      try await plain.signIn(host: "videos.example.org", username: "spjr", password: "wrong", otp: nil)
    }

    let guarded = PeerTubeAccount(storage: MemoryAccountStorage(), session: Self.instance(otp: "123456").session())
    await #expect(throws: PeerTubeError.otpRequired) {
      try await guarded.signIn(host: "videos.example.org", username: "spjr", password: "right horse", otp: nil)
    }
    let stored = try await guarded.signIn(host: "videos.example.org", username: "spjr", password: "right horse", otp: "123456")
    #expect(stored.tokens.accessToken == "a1")
  }

  @Test("A host that is not PeerTube is caught before any password is sent")
  func notPeerTube() async throws {
    let stub = StubPeerTube { _ in StubPeerTube.json([ "hello": "world" ]) }
    let account = PeerTubeAccount(storage: MemoryAccountStorage(), session: stub.session())
    await #expect(throws: PeerTubeError.notPeerTube) {
      try await account.signIn(host: "example.org", username: "spjr", password: "x", otp: nil)
    }
    #expect(!stub.seen.contains { $0.path == "/api/v1/users/token" })
  }

  @Test("A token about to expire is refreshed and the new one kept; a refused refresh signs out")
  func refresh() async throws {
    let now = Date()
    let stale = StoredAccount(
      host: "videos.example.org",
      username: "spjr",
      client: OAuthClient(clientID: "cid", clientSecret: "secret"),
      tokens: TokenSet(accessToken: "a1", refreshToken: "r1", accessExpiresAt: now.addingTimeInterval(60), refreshExpiresAt: nil)
    )
    let storage = MemoryAccountStorage(stale)
    let account = PeerTubeAccount(storage: storage, session: Self.instance().session())
    let fresh = try await account.accessToken(now: now)
    #expect(fresh.token == "a2")
    #expect(storage.load()?.tokens.refreshToken == "r2")

    // A token with an hour left is used as it is.
    #expect(try await account.accessToken(now: now).token == "a2")

    var revoked = stale
    revoked.tokens.refreshToken = "gone"
    let dead = MemoryAccountStorage(revoked)
    let signedOut = PeerTubeAccount(storage: dead, session: Self.instance().session())
    await #expect(throws: PeerTubeError.signInAgain) { _ = try await signedOut.accessToken(now: now) }
    #expect(dead.load() == nil)
  }
}

@Suite("PeerTube upload")
struct PeerTubeUploadTests {
  /// An instance that takes a resumable upload, optionally dropping the second chunk once.
  final class UploadServer: @unchecked Sendable {
    let lock = NSLock()
    var received = Data()
    var dropSecondChunk: Bool
    var dropped = false
    var quotaFull = false

    init(dropSecondChunk: Bool = false) {
      self.dropSecondChunk = dropSecondChunk
    }

    func stub() -> StubPeerTube {
      StubPeerTube { [self] seen in
        lock.withLock {
          switch (seen.method, seen.path) {
          case ("POST", "/api/v1/videos/upload-resumable"):
            if quotaFull { return StubPeerTube.json([ "detail": "quota exceeded" ], status: 413) }
            return (201, [ "Location": "//videos.example.org/api/v1/videos/upload-resumable?upload_id=abc" ], Data())
          case ("PUT", "/api/v1/videos/upload-resumable?upload_id=abc"):
            let range = seen.headers["Content-Range"] ?? ""
            if range.hasPrefix("bytes */") {
              let header = received.isEmpty ? [:] : [ "Range": "bytes=0-\(received.count - 1)" ]
              return (308, header, Data())
            }
            let parts = range.dropFirst("bytes ".count).split(separator: "/")
            let bounds = parts[0].split(separator: "-").compactMap { Int($0) }
            let total = Int(parts[1]) ?? 0
            if dropSecondChunk, !dropped, bounds[0] > 0 {
              dropped = true
              received.append(seen.body.prefix(1_000_000))
              return (500, [:], Data())
            }
            if bounds[0] == received.count { received.append(seen.body) }
            if received.count >= total {
              return StubPeerTube.json([ "video": [ "id": 42, "shortUUID": "short", "uuid": "long" ] ])
            }
            return (308, [ "Range": "bytes=0-\(received.count - 1)" ], Data())
          case ("DELETE", "/api/v1/videos/upload-resumable?upload_id=abc"):
            return (204, [:], Data())
          default:
            return (404, [:], Data())
          }
        }
      }
    }
  }

  static func file(bytes: Int) throws -> (URL, Data) {
    let data = Data((0..<bytes).map { UInt8(truncatingIfNeeded: $0 &* 13 &+ $0 >> 7) })
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("upload-\(UUID().uuidString).mov")
    try data.write(to: url)
    return (url, data)
  }

  @Test("A file goes up in 8 MiB chunks, whole, with the fields and a fresh token for each chunk")
  func uploads() async throws {
    let server = UploadServer()
    let stub = server.stub()
    let (url, data) = try Self.file(bytes: 20 << 20)
    defer { try? FileManager.default.removeItem(at: url) }
    let tokens = Counter()
    let video = try await PeerTubeAPI(host: "videos.example.org", session: stub.session()).upload(
      file: url,
      name: "2026-09-13 badgers versus blueberries Home",
      channelID: 3,
      privacy: 6,
      token: { tokens.next() }
    )
    #expect(video == UploadedVideo(id: 42, shortUUID: "short", uuid: "long"))
    #expect(server.received == data)
    let start = try #require(stub.seen.first { $0.method == "POST" })
    let form = String(decoding: start.body, as: UTF8.self)
    #expect(form.contains("2026-09-13 badgers versus blueberries Home"))
    #expect(form.contains("name=\"privacy\"\r\n\r\n6"))
    #expect(form.contains("name=\"waitTranscoding\"\r\n\r\nfalse"))
    #expect(start.headers["X-Upload-Content-Length"] == String(20 << 20))
    #expect(stub.seen.filter { $0.method == "PUT" }.count == 3)
    #expect(tokens.count >= 4)
    #expect(stub.seen.last?.method == "DELETE")
  }

  @Test("A chunk the server fails is sent again, and the upload completes intact")
  func retriesAfterFailure() async throws {
    let server = UploadServer(dropSecondChunk: true)
    let (url, data) = try Self.file(bytes: 12 << 20)
    defer { try? FileManager.default.removeItem(at: url) }
    _ = try await PeerTubeAPI(host: "videos.example.org", session: server.stub().session()).upload(
      file: url, name: "t", channelID: 1, privacy: 2, token: { "a" }
    )
    #expect(server.received.count == data.count)
  }

  @Test("An account with no room is told so before anything is sent")
  func quota() async throws {
    let server = UploadServer()
    server.quotaFull = true
    let (url, _) = try Self.file(bytes: 1_000)
    defer { try? FileManager.default.removeItem(at: url) }
    await #expect(throws: PeerTubeError.overQuota("quota exceeded")) {
      _ = try await PeerTubeAPI(host: "videos.example.org", session: server.stub().session()).upload(
        file: url, name: "t", channelID: 1, privacy: 2, token: { "a" }
      )
    }
  }
}

final class Counter: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0
  func next() -> String { lock.withLock { value += 1; return "token-\(value)" } }
  var count: Int { lock.withLock { value } }
}
