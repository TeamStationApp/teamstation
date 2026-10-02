import Foundation
import Testing

@testable import TeamStationKit

@Suite("Where the app server is")
struct AppServerTests {
  /// The repository root, walked up from this file.
  private static var repositoryRoot: URL {
    URL(filePath: #filePath)
      .deletingLastPathComponent()  // TeamStationKitTests
      .deletingLastPathComponent()  // Tests
      .deletingLastPathComponent()  // TeamStationKit
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
      contentsOf: Self.repositoryRoot.appending(path: "src/common/primaryUrl.ts"),
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
    #expect(AppServer.url(forHost: AppServer.defaultHost)?.host() == "app.teamstation.app")
  }

  /// A DNS name is behind TLS; the things nobody holds a certificate for are
  /// the things somebody testing locally is actually reaching.
  @Test("https is implied, except for an address")
  func theSchemeFollowsTheHost() {
    #expect(AppServer.url(forHost: "app.teamstation.app")?.absoluteString == "https://app.teamstation.app")
    #expect(
      AppServer.url(forHost: "develop2.teamstation.app")?.absoluteString
        == "https://develop2.teamstation.app")
    #expect(AppServer.url(forHost: "127.0.0.1:9100")?.absoluteString == "http://127.0.0.1:9100")
    #expect(AppServer.url(forHost: "localhost:8080")?.absoluteString == "http://localhost:8080")
  }

  @Test("An override is taken however somebody wrote it")
  func anOverrideIsTidiedUp() {
    #expect(AppServer.asHost("develop2.teamstation.app") == "develop2.teamstation.app")
    #expect(AppServer.asHost("https://develop2.teamstation.app/") == "develop2.teamstation.app")
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
struct TeamStationClientURLTests {
  @Test func queryIsAQueryAndNotPartOfThePath() {
    let url = TeamStationClient.url(
      URL(string: "https://develop1.teamstation.app")!,
      "events",
      [
        URLQueryItem(name: "scope", value: "run"),
        URLQueryItem(name: "when", value: "finished"),
        URLQueryItem(name: "lookbackHours", value: "2"),
        URLQueryItem(name: "limit", value: "10")
      ]
    )
    #expect(url.absoluteString == "https://develop1.teamstation.app/api/v1/events?scope=run&when=finished&lookbackHours=2&limit=10")
  }

  @Test func noQueryLeavesTheAddressAlone() {
    let url = TeamStationClient.url(
      URL(string: "https://app.teamstation.app")!,
      "events",
      []
    )
    #expect(url.absoluteString == "https://app.teamstation.app/api/v1/events")
  }
}
