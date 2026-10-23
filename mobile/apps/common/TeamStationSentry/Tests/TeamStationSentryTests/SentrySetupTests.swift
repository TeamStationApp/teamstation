import Foundation
import XCTest
import Sentry
@testable import TeamStationSentry

final class SentrySetupTests: XCTestCase {
  func testReleaseJavaScriptFramesSurviveNativeScrub() throws {
    for kind in ["TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError"] {
      let event = Event(level: .error)
      let error = Exception(value: "private-canary", type: kind)
      let frame = Frame(); frame.fileName = "app:///main.jsbundle"; frame.lineNumber = 1; frame.columnNumber = 12345
      error.stacktrace = SentryStacktrace(frames: [frame], registers: [:]); event.exceptions = [error]
      let safe = NativeSentryPrivacy.scrub(event)
      XCTAssertEqual(safe.exceptions?.first?.type, kind)
      XCTAssertEqual(safe.exceptions?.first?.stacktrace?.frames.first?.fileName, "main.jsbundle")
      XCTAssertEqual(safe.exceptions?.first?.stacktrace?.frames.first?.columnNumber, 12345)
      XCTAssertFalse(String(decoding: try JSONSerialization.data(withJSONObject: safe.serialize()), as: UTF8.self).contains("private-canary"))
      for column in [-1, 0.5, 100_000_001] as [NSNumber] {
        frame.columnNumber = column
        XCTAssertNil(NativeSentryPrivacy.scrub(event).exceptions?.first?.stacktrace?.frames.first?.columnNumber)
      }
    }
  }
  func testSDKStartupAndCrashDispatch() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".bundle")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { SentrySDK.close(); try? FileManager.default.removeItem(at: root) }
    let plist: [String: Any] = ["CFBundleIdentifier": "app.example.fixture", "CFBundleVersion": "1", "CFBundleShortVersionString": "1.0", "TSSentryDsn": "https://public@logs.example.test/1", "TSPrimaryHost": "develop1.example.test"]
    try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: root.appendingPathComponent("Info.plist"))
    let bundle = try XCTUnwrap(Bundle(path: root.path))
    NativeSentryPrivacy.start(bundle: bundle)
    XCTAssertTrue(SentrySDK.isEnabled)
    SentrySDK.close()
    var received = 0
    SentrySetup.start(appId: "app.teamstation.director", bundle: bundle, arguments: ["app", "-sentryTest", "error"], configure: { options in
      XCTAssertFalse(options.sendDefaultPii)
      XCTAssertFalse(options.enableAutoSessionTracking)
      XCTAssertFalse(options.sendClientReports)
      XCTAssertNil(options.beforeBreadcrumb?(Breadcrumb()))
      let safe = options.beforeSend
      options.beforeSend = { event in
        XCTAssertEqual(safe?(event)?.exceptions?.first?.value, "internal")
        received += 1
        return nil
      }
    })
    XCTAssertEqual(received, 1)
    var crashes = 0
    SentrySetup.start(appId: "app.teamstation.director", bundle: bundle, arguments: ["app", "-sentryTest", "crash"], crash: { crashes += 1 })
    XCTAssertEqual(crashes, 1)
  }

  func testReconstructsOnlyApprovedFields() throws {
    let event = Event(level: .fatal)
    event.timestamp = Date()
    event.releaseName = "app.teamstation.director@1.0+1"
    event.message = SentryMessage(formatted: "private-canary")
    event.extra = ["chat": "private-canary"]
    event.context = ["anything": ["payload": "private-canary"]]
    event.transaction = "/private-canary"
    event.user = User(); event.user?.email = "private-canary"
    let exception = Exception(value: "private-canary", type: "NSException")
    let good = Frame(); good.fileName = "source/RecordingEngine.swift"; good.lineNumber = 12; good.contextLine = "private-canary"
    let bad = Frame(); bad.fileName = "private-canary"; bad.lineNumber = 1
    exception.stacktrace = SentryStacktrace(frames: [good, bad], registers: ["private-canary": "private-canary"])
    event.exceptions = [exception]
    let safe = SentrySetup.scrub(event)
    XCTAssertEqual(safe.eventId, event.eventId)
    XCTAssertEqual(safe.timestamp, event.timestamp)
    XCTAssertEqual(safe.releaseName, event.releaseName)
    XCTAssertEqual(safe.level, .fatal)
    XCTAssertEqual(safe.exceptions?.last?.type, "NSException")
    XCTAssertEqual(safe.exceptions?.last?.stacktrace?.frames.count, 1)
    XCTAssertFalse(String(decoding: try JSONSerialization.data(withJSONObject: safe.serialize()), as: UTF8.self).contains("private-canary"))
    event.releaseName = "private-canary"
    event.exceptions = [Exception(value: "secret", type: "private-canary")]
    XCTAssertNil(SentrySetup.scrub(event).releaseName)
    XCTAssertEqual(SentrySetup.scrub(event).exceptions?.last?.type, "Error")
    XCTAssertEqual(SentrySetup.scrub(Event()).level, .error)
  }

  func testMissingConfigurationStartsNothing() {
    SentrySDK.close()
    NativeSentryPrivacy.start(bundle: Bundle(for: Self.self))
    XCTAssertFalse(SentrySDK.isEnabled)
    SentrySetup.start(appId: "app.teamstation.director", bundle: Bundle(for: Self.self), arguments: [])
  }
}
