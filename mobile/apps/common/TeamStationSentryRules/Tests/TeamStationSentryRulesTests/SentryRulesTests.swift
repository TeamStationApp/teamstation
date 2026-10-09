import TeamStationSentryRules
import XCTest

/// The same cases as the TeamStation app's `src/common/sentry/sentry.test.ts`.
final class SentryRulesTests: XCTestCase {
  func testTextRules() {
    let cases: [(String, String)] = [
      ("https://app.example.test/signin/abc123", "https://app.example.test/signin/[Filtered]"),
      ("/i/INVITE42?ref=x", "/i/[Filtered]"),
      ("https://app.example.test/c/invite/INVITE42", "https://app.example.test/c/invite/[Filtered]"),
      ("GET /api/v1/oauth/approvals/h4ndleAbc_-123", "GET /api/v1/oauth/approvals/[Filtered]"),
      ("teamstation:///oauth/native-approval/h4ndleAbc_-123", "teamstation:///oauth/native-approval/[Filtered]"),
      ("undefined is not a function (evaluating 'a?.b()')", "undefined is not a function (evaluating 'a?.b()')"),
      ("Unexpected token '?'", "Unexpected token '?'"),
      ("POST /api/v1/join/INVITE42/redeem", "POST /api/v1/join/[Filtered]/redeem"),
      ("/media/1700000000/sig_abc/videos/9/hls/x.m3u8", "/media/[Filtered]/videos/9/hls/x.m3u8"),
      ("rtmps://live.example.test:1936/live/streamkey123", "rtmps://live.example.test:1936/live/[Filtered]"),
      ("rtmp://live.example.test/streamkey123", "rtmp://live.example.test/[Filtered]"),
      ("/api/v1/teams?token", "/api/v1/teams"),
      ("/api/v1/teams?token=abc&x=1", "/api/v1/teams"),
      ("sign-in code for ruth@example.test: 123456", "sign-in code for [email]: 123456"),
      ("Why did it fail?", "Why did it fail?"),
      ("/api/v1/teams/7/games", "/api/v1/teams/7/games")
    ]
    for (input, output) in cases {
      XCTAssertEqual(SentryRules.scrubText(input), output, input)
    }
  }

  func testSecretKeysAtAnyDepth() {
    let scrubbed = SentryRules.scrubValue([
      "a": [ "b": [ "clientHash": "h", "code": "123456", "nested": [ [ "token": "t" ] ] ] ],
      "streamKey": "k",
      "sessionId": "s",
      "status_code": 400,
      "http.response.status_code": 500,
      "errorCode": "E_FAIL",
      "csrfToken": "x",
      "count": 3,
      "link": "/signin/abc"
    ] as [String: Any]) as? [String: Any]
    let inner = ((scrubbed?["a"] as? [String: Any])?["b"] as? [String: Any])
    XCTAssertEqual(inner?["clientHash"] as? String, SentryRules.filtered)
    XCTAssertEqual(inner?["code"] as? String, SentryRules.filtered)
    XCTAssertEqual(((inner?["nested"] as? [Any])?.first as? [String: Any])?["token"] as? String, SentryRules.filtered)
    XCTAssertEqual(scrubbed?["streamKey"] as? String, SentryRules.filtered)
    XCTAssertEqual(scrubbed?["sessionId"] as? String, SentryRules.filtered)
    XCTAssertEqual(scrubbed?["status_code"] as? Int, 400)
    XCTAssertEqual(scrubbed?["http.response.status_code"] as? Int, 500)
    XCTAssertEqual(scrubbed?["errorCode"] as? String, "E_FAIL")
    XCTAssertEqual(scrubbed?["csrfToken"] as? String, SentryRules.filtered)
    XCTAssertEqual(scrubbed?["count"] as? Int, 3)
    XCTAssertEqual(scrubbed?["link"] as? String, "/signin/[Filtered]")
  }

  func testContexts() {
    let scrubbed = SentryRules.scrubContexts([
      "session": [ "id": "s" ],
      "upload": [ "token": "t", "bytes": 4 ]
    ])
    XCTAssertNil(scrubbed["session"])
    XCTAssertEqual(scrubbed["upload"]?["token"] as? String, SentryRules.filtered)
    XCTAssertEqual(scrubbed["upload"]?["bytes"] as? Int, 4)
  }

  func testDepthLimit() {
    var deep: Any = [ "leaf": 1 ]
    for _ in 0..<12 { deep = [ "next": deep ] }
    XCTAssertTrue(String(describing: SentryRules.scrubValue(deep)).contains(SentryRules.filtered))
  }

  func testHeaders() {
    XCTAssertEqual(
      SentryRules.scrubHeaders([
        "Authorization": "Bearer t", "Cookie": "c", "X-OAuth-CSRF": "x", "X-Api-Key": "k",
        "User-Agent": "ua", "Referer": "/i/abc"
      ]),
      [ "User-Agent": "ua", "Referer": "/i/[Filtered]" ]
    )
  }

  func testRelease() {
    let full = SentryRules.release(appId: "app.teamstation.director", version: "1.0", build: "1.0.42")
    XCTAssertEqual(full.release, "app.teamstation.director@1.0+1.0.42")
    XCTAssertEqual(full.dist, "1.0.42")
    let bare = SentryRules.release(appId: "app.teamstation.director", version: "1.0", build: nil)
    XCTAssertEqual(bare.release, "app.teamstation.director@1.0")
    XCTAssertNil(bare.dist)
    XCTAssertNil(SentryRules.release(appId: "a", version: "1", build: "").dist)
  }

  func testEnvironment() {
    let cases: [(String?, String)] = [
      ("app.teamstation.app", "production"),
      ("", "production"),
      (nil, "production"),
      ("develop6.example.test", "develop6"),
      ("APP.teamstation.app:443", "production"),
      ("localhost", "development"),
      ("localhost:9100", "development"),
      ("192.168.1.20", "development"),
      ("[::1]", "development"),
      ("host.local", "development")
    ]
    for (host, environment) in cases {
      XCTAssertEqual(SentryRules.environment(host: host), environment, String(describing: host))
    }
  }

  func testLaunchArgument() {
    XCTAssertEqual(SentryRules.test(arguments: [ "app", "-sentryTest", "error" ]), .error)
    XCTAssertEqual(SentryRules.test(arguments: [ "app", "-sentryTest", "crash" ]), .crash)
    XCTAssertNil(SentryRules.test(arguments: [ "app", "-sentryTest", "other" ]))
    XCTAssertNil(SentryRules.test(arguments: [ "app", "-sentryTest" ]))
    XCTAssertNil(SentryRules.test(arguments: [ "app" ]))
  }
}
