import DirectorCore
import DirectorSources
import DirectorTestHarness
import Foundation
import TeamStationObservability
import XCTest
@testable import DirectorUI

final class ObservabilityTests: XCTestCase {
  actor Capture {
    var lines = ""
    func send(_ data: Data) -> Int { lines += String(decoding: data, as: UTF8.self); return 202 }
    func text() -> String { lines }
  }

  @MainActor func testRecordingAndStreamingOutcomesUseClosedEvents() async throws {
    // Faults below affect only an explicitly isolated test host, never the operator app.
    guard Bundle.main.bundleIdentifier?.contains(".observability") == true else {
      throw XCTSkip("Requires an isolated observability test host")
    }
    let capture = Capture()
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    await AppLog.close()
    AppLog.start(app: .director, dsn: "https://public@logs.example.test/1", file: root.appendingPathComponent("queue"), sender: { await capture.send($0) })
    var launch = LaunchConfiguration()
    launch.isUITest = true
    launch.sourceProfile = .synthetic4
    launch.syntheticCount = 1
    launch.syntheticWidth = 320
    launch.syntheticHeight = 180
    launch.syntheticFrameRate = 24
    launch.streamURL = "rtmp://127.0.0.1:1/live/fixture"
    launch.programFrameRate = 24
    let model = AppEnvironment(launch: launch)
    await model.bootstrap()
    for _ in 0..<100 where model.selections.isEmpty { try await Task.sleep(for: .milliseconds(50)) }
    for selection in model.selections { _ = model.setEnabled(true, for: selection.id) }
    await model.enterDirecting()
    for _ in 0..<100 where model.router.activePipelines.isEmpty { try await Task.sleep(for: .milliseconds(50)) }
    XCTAssertFalse(model.router.activePipelines.isEmpty)
    model.startRecording()
    XCTAssertTrue(model.isRecording)
    try await Task.sleep(for: .milliseconds(300))
    await model.stopRecording()
    XCTAssertFalse(model.isRecording)

    // A real SQLite refusal reaches the open-take error branch without corrupting its table.
    let store = try SQLiteStore(url: DirectorPaths.indexDatabase)
    try store.execute("CREATE TRIGGER observability_refuse BEFORE INSERT ON recordings BEGIN SELECT RAISE(ABORT, 'private-canary'); END")
    defer { try? store.execute("DROP TRIGGER IF EXISTS observability_refuse") }
    model.startRecording()
    XCTAssertFalse(model.isRecording)
    try store.execute("DROP TRIGGER observability_refuse")

    // A file where each output directory should be exercises real filesystem failures.
    let manager = FileManager.default
    let destinations = [DirectorPaths.program, DirectorPaths.archives]
    defer {
      for url in destinations {
        let backup = url.appendingPathExtension("observability-backup")
        if manager.fileExists(atPath: backup.path) {
          try? manager.removeItem(at: url)
          try? manager.moveItem(at: backup, to: url)
        }
      }
    }
    for url in destinations {
      try manager.moveItem(at: url, to: url.appendingPathExtension("observability-backup"))
      try Data("private-canary".utf8).write(to: url)
    }
    model.startRecording()
    XCTAssertTrue(model.isRecording)
    await model.stopRecording()
    for url in destinations {
      try manager.removeItem(at: url)
      try manager.moveItem(at: url.appendingPathExtension("observability-backup"), to: url)
    }
    model.startStreaming()
    XCTAssertTrue(model.isStreaming)
    try await Task.sleep(for: .seconds(2))
    await model.stopStreaming()
    await model.stopRecording()
    await model.shutdown()
    await AppLog.close()
    let text = await capture.text()
    for event in ["recording_requested", "recording_started", "recording_stopped", "recording_failed", "stream_started", "stream_stopped", "stream_failed"] {
      XCTAssertTrue(text.contains("\"E\":\"\(event)\""), event)
    }
    XCTAssertFalse(text.contains("private-canary"))
    XCTAssertFalse(text.contains("127.0.0.1"))
  }
}
