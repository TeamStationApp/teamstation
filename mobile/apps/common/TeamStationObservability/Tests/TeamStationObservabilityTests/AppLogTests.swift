import Foundation
import XCTest
@testable import TeamStationObservability

final class AppLogTests: XCTestCase {
  @MainActor func testCloseDoesNotMixAnotherDestinationIntoItsDrain() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    actor Capture {
      var lines = ""
      var waiting: CheckedContinuation<Void, Never>?
      var entered = false
      var released = false
      func send(_ data: Data) async -> Int {
        lines += String(decoding: data, as: UTF8.self)
        entered = true
        if !released { await withCheckedContinuation { waiting = $0 } }
        return 202
      }
      func release() { released = true; waiting?.resume(); waiting = nil }
    }
    let capture = Capture()
    await AppLog.close()
    AppLog.start(app: .director, dsn: "https://public@logs.example.test/1", file: root.appendingPathComponent("old"), version: "1.0+1", sender: { await capture.send($0) })
    let closing = Task { await AppLog.close() }
    while !(await capture.entered) { await Task.yield() }
    AppLog.start(app: .cameraman, dsn: "https://public@logs.example.test/2", file: root.appendingPathComponent("new"), version: "2.0+1", sender: { _ in XCTFail("New destination started during close"); return 202 })
    AppLog.record(.recordingStarted)
    await AppLog.close()
    await capture.release()
    await closing.value
    let text = await capture.lines
    XCTAssertFalse(text.contains("cam"))
    XCTAssertFalse(text.contains("recording_started"))
    XCTAssertTrue(text.contains("1.0+1"))
    XCTAssertFalse(text.contains("2.0+1"))
  }

  func testEndpoint() {
    XCTAssertEqual(LogEndpoint.from(dsn: "https://public@logs.example.test/12")?.absoluteString, "https://logs.example.test/ingest/12")
    for value in ["", "invalid", "http://key@example.test/1", "https://key:secret@example.test/1", "https://key@example.test/1?q=x", "https://key@example.test/1#x", "https://example.test/1", "https://key@example.test/path/1"] {
      XCTAssertNil(LogEndpoint.from(dsn: value))
    }
  }

  @MainActor func testLifecycleAndClosedProperties() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    actor Capture {
      var lines = ""
      func send(_ data: Data) -> Int { lines += String(decoding: data, as: UTF8.self); return 202 }
    }
    let capture = Capture()
    await AppLog.close()
    AppLog.record(.error, error: .unknown)
    AppLog.start(app: .director, dsn: "", file: root.appendingPathComponent("unused"))
    AppLog.start(app: .director, dsn: "https://public@logs.example.test/1", file: root.appendingPathComponent("queue"), version: "1.0+1", sender: { await capture.send($0) })
    AppLog.start(app: .cameraman, dsn: "https://public@logs.example.test/1", file: root.appendingPathComponent("other"))
    AppLog.record(.recordingStarted, video: "vid_fixture")
    AppLog.record(.error, operation: .record, error: .storage)
    AppLog.record(.recordingStarted, video: "private-canary")
    await AppLog.close()
    let text = await capture.lines
    XCTAssertEqual(text.split(separator: "\n").count, 4)
    XCTAssertTrue(text.contains("TS dir"))
    XCTAssertTrue(text.contains("\"V\":\"1.0+1\""))
    XCTAssertFalse(text.contains("private-canary"))
    XCTAssertTrue(text.contains("service_stopped"))
    AppLog.start(app: .distributor, bundle: Bundle(for: Self.self))
    await AppLog.close()
  }

  @MainActor func testInputIsBoundedBeforeDiskWork() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    await AppLog.close()
    AppLog.start(app: .director, dsn: "https://public@logs.example.test/1", file: root.appendingPathComponent("queue"), sender: { _ in 202 })
    let before = AppLog.dropped
    for _ in 0..<600 { AppLog.record(.recordingStarted) }
    XCTAssertEqual(AppLog.dropped - before, 101)
    await AppLog.close()
    XCTAssertNil(LogRecord(app: .director, kind: .started, version: "private-canary"))
  }
}
