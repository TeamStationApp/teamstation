import Foundation
import Testing

@testable import GameStationKit

@Suite("Where the app server is")
struct AppServerTests {
  /// The repository root, walked up from this file.
  private static var repositoryRoot: URL {
    URL(filePath: #filePath)
      .deletingLastPathComponent()  // GameStationKitTests
      .deletingLastPathComponent()  // Tests
      .deletingLastPathComponent()  // GameStationKit
      .deletingLastPathComponent()  // common
      .deletingLastPathComponent()  // apps
      .deletingLastPathComponent()  // mobile
      .deletingLastPathComponent()  // repository root
  }

  /// The name is written down twice — once for TypeScript, once for Swift —
  /// because the two cannot import from each other. This is what stops the
  /// two copies drifting, which is the failure the single `config.json` was
  /// introduced to fix and this replaces it with: not one file read by both,
  /// but one fact asserted across both.
  @Test("Swift and TypeScript name the same host")
  func theTwoCopiesAgree() throws {
    let source = try String(
      contentsOf: Self.repositoryRoot.appending(path: "src2/common/primaryUrl.ts"),
      encoding: .utf8
    )
    let pattern = #"PRIMARY_HOST = '([^']+)'"#
    let range = try #require(source.range(of: pattern, options: .regularExpression))
    let written = String(source[range]).replacingOccurrences(of: "PRIMARY_HOST = ", with: "")
      .trimmingCharacters(in: CharacterSet(charactersIn: "'"))
    #expect(written == AppServer.defaultHost)
  }

  @Test("The name in the source is a host and nothing else")
  func theDefaultIsBare() {
    #expect(!AppServer.defaultHost.contains("://"))
    #expect(!AppServer.defaultHost.contains("/"))
    #expect(AppServer.url(forHost: AppServer.defaultHost)?.host() == "gamestation.co")
  }

  /// A DNS name is behind TLS; the things nobody holds a certificate for are
  /// the things somebody testing locally is actually reaching.
  @Test("https is implied, except for an address")
  func theSchemeFollowsTheHost() {
    #expect(AppServer.url(forHost: "gamestation.co")?.absoluteString == "https://gamestation.co")
    #expect(
      AppServer.url(forHost: "develop2.gamestation.co")?.absoluteString
        == "https://develop2.gamestation.co")
    #expect(AppServer.url(forHost: "127.0.0.1:9100")?.absoluteString == "http://127.0.0.1:9100")
    #expect(AppServer.url(forHost: "localhost:8080")?.absoluteString == "http://localhost:8080")
  }

  @Test("An override is taken however somebody wrote it")
  func anOverrideIsTidiedUp() {
    #expect(AppServer.asHost("develop2.gamestation.co") == "develop2.gamestation.co")
    #expect(AppServer.asHost("https://develop2.gamestation.co/") == "develop2.gamestation.co")
    #expect(AppServer.asHost("  http://127.0.0.1:9100/api/v1  ") == "127.0.0.1:9100")
    #expect(AppServer.asHost("") == "")
  }

  @Test("Nothing usable is not an address")
  func rubbishIsRefused() {
    #expect(AppServer.url(forHost: "") == nil)
  }

  /// A bundle with no override — which is every release build — talks to the
  /// name in the source rather than to nothing.
  @Test("A bundle without an override uses the name in the source")
  func aBundleWithoutTheKey() {
    #expect(AppServer.host(in: Bundle(for: MarkerClass.self)) == AppServer.defaultHost)
  }
}

private final class MarkerClass {}

/// The URL a request is actually sent to.
///
/// `appending(path:)` escapes what it is handed, so a query written into the
/// path becomes `%3F…` and the server answers 404 — which reads as "no such
/// game" rather than "this app built the URL wrongly".
struct GameStationClientURLTests {
  @Test func queryIsAQueryAndNotPartOfThePath() {
    let url = GameStationClient.url(
      URL(string: "https://develop.gamestation.co")!,
      "director/events",
      [URLQueryItem(name: "when", value: "finished")]
    )
    #expect(url.absoluteString == "https://develop.gamestation.co/api/v1/director/events?when=finished")
  }

  @Test func noQueryLeavesTheAddressAlone() {
    let url = GameStationClient.url(
      URL(string: "https://gamestation.co")!,
      "director/events",
      []
    )
    #expect(url.absoluteString == "https://gamestation.co/api/v1/director/events")
  }
}
