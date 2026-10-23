import Foundation
import Testing
import DirectorClient
import DirectorCore
import DistributorWire
import TeamStationObservability
@testable import Distribution

@Suite("Private distribution events", .serialized)
struct ObservabilityTests {
  @Test @MainActor func realExportAndUploadOutcomes() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    actor Capture {
      var lines = ""
      func send(_ data: Data) -> Int { lines += String(decoding: data, as: UTF8.self); return 202 }
    }
    let capture = Capture()
    await AppLog.close()
    AppLog.start(app: .distributor, dsn: "https://public@logs.example.test/1", file: root.appendingPathComponent("queue"), sender: { await capture.send($0) })
    let recording = RecordingListing(id: 1, startedAt: WallClock(seconds: 1_000), endedAt: WallClock(seconds: 1_010),
                                     isLive: false, hasPrimary: true, cameras: [], preparedTracks: [])
    let folder = DistributionRun.folder(for: recording, in: root)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    try Data("synthetic video".utf8).write(to: folder.appendingPathComponent(DistributionRun.filename(for: .primary, of: recording)))
    for fail in [false, true] {
      let upload = TeamStationPlan(gameId: "fixture", title: "private-canary", tracks: [.primary]) { _, _, _, _, _ in
        if fail { throw NSError(domain: "private-canary", code: 1) }
        return "vid_fixture"
      }
      let run = DistributionRun(recording: recording, tracks: [.primary], connection: nil, jobs: JobWatcher(), destination: root, teamStation: upload)
      await run.run()
      #expect(run.isFinished)
    }
    let missing = DistributionRun(recording: recording, tracks: [.primary], connection: nil, jobs: JobWatcher(), destination: root.appendingPathComponent("absent"))
    await missing.run()
    let cancelled = DistributionRun(recording: recording, tracks: [.primary], connection: nil, jobs: JobWatcher(), destination: root)
    cancelled.stop()
    await cancelled.run()
    await AppLog.close()
    let text = await capture.lines
    for event in ["export_started", "export_completed", "export_failed", "upload_started", "upload_completed", "upload_failed"] {
      #expect(text.contains(event))
    }
    #expect(!text.contains("private-canary"))
    let events = text.split(separator: "\n").compactMap { line in
      ((try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any])?["E"] as? String
    }
    // Other suites can send through the process logger while this test awaits.
    // The isolated app API test also checks the exact per-batch outcomes.
    #expect(events.filter { $0 == "export_completed" }.count >= 1)
    #expect(events.filter { $0 == "export_failed" }.count >= 3)
  }
}
