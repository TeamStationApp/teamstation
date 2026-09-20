import Foundation
import Testing

@testable import GameStationKit

@Suite("Where the app server is")
struct AppServerTests {
  /// The committed file itself. This is the copy the server and the tools
  /// read, and the one the app bundles, so it is the one worth asserting on.
  private static var committedConfig: Data {
    get throws {
      let here = URL(filePath: #filePath)
      let root = here
        .deletingLastPathComponent()  // GameStationKitTests
        .deletingLastPathComponent()  // Tests
        .deletingLastPathComponent()  // GameStationKit
        .deletingLastPathComponent()  // common
        .deletingLastPathComponent()  // apps
        .deletingLastPathComponent()  // mobile
        .deletingLastPathComponent()  // repository root
      return try Data(contentsOf: root.appending(path: "config.json"))
    }
  }

  @Test("The repository's config.json names an app server")
  func theCommittedFileIsUsable() throws {
    let url = try #require(AppServer.url(fromConfig: Self.committedConfig))
    #expect(url.scheme == "https")
    #expect(url.host() == "gamestation.co")
  }

  @Test("A config without the key is not an address")
  func aFileWithoutTheKeyIsRefused() {
    #expect(AppServer.url(fromConfig: Data(#"{}"#.utf8)) == nil)
    #expect(AppServer.url(fromConfig: Data(#"not json"#.utf8)) == nil)
  }

  /// A bare word parses as a URL with no scheme and no host, and would then
  /// be asked for `/api/v1` and fail somewhere far from here.
  @Test("A config with something that is not an address is refused")
  func aFileWithRubbishIsRefused() {
    #expect(AppServer.url(fromConfig: Data(#"{"appServerUrl":"nonsense"}"#.utf8)) == nil)
    #expect(AppServer.url(fromConfig: Data(#"{"appServerUrl":""}"#.utf8)) == nil)
  }

  @Test("A bundle without the file is not an address")
  func aBundleWithoutTheFile() {
    #expect(AppServer.url(in: Bundle(for: MarkerClass.self)) == nil)
  }
}

private final class MarkerClass {}
