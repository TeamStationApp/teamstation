import DirectorCore
@testable import DirectorMedia
@testable import DirectorPipeline
import Foundation
import Testing

/// A take's once-a-second telemetry log (U-D6).
@Suite("Take telemetry log")
struct TakeTelemetryLogTests {
  private func directory() throws -> URL {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("take-telemetry-\(UUID().uuidString)", isDirectory: true)
    return url
  }

  private func snapshot(lateness: Double = 0) -> TelemetrySnapshot {
    var snapshot = TelemetrySnapshot()
    snapshot.thermalState = "serious"
    snapshot.programmeTickLatenessMaxMilliseconds = lateness
    snapshot.programmeMissedTicks = 3
    snapshot.composedFramesPerSecond = 59.9
    snapshot.isStreaming = true
    snapshot.streamPendingEncodes = 2
    snapshot.streamDroppedPackets = 5
    snapshot.liveSoundDelayMilliseconds = 500
    snapshot.audioMixFades = 1
    snapshot.tiles[0].sourceID = "cam-a"
    snapshot.tiles[0].displayName = "1st"
    snapshot.tiles[0].framesPerSecond = 30
    snapshot.tiles[0].displayedFramesPerSecond = 29
    snapshot.tiles[0].soundState = "playing"
    snapshot.tiles[0].soundHeldMilliseconds = 520
    snapshot.tiles[0].soundDriftPartsPerMillion = -48.5
    snapshot.tiles[0].soundTimelines = 2
    return snapshot
  }

  @Test("One line a second while a take records, every field in it, and the file closed at its end")
  func oneLinePerSecond() throws {
    let dir = try directory()
    defer { try? FileManager.default.removeItem(at: dir) }
    let log = TakeTelemetryLog(directory: dir)
    // Polled five times a second for 3.2 s; the worst tick lateness of each second is kept.
    for step in 0 ... 16 {
      log.note(recording: 7, snapshot: snapshot(lateness: step == 3 ? 42 : 1), at: 1_000 + Double(step) * 0.2)
    }
    #expect(log.isOpen)
    log.note(recording: nil, snapshot: snapshot(), at: 1_003.4)
    #expect(!log.isOpen)

    let text = try String(contentsOf: log.url(for: 7), encoding: .utf8)
    #expect(text.hasSuffix("\n"))
    let lines = text.split(separator: "\n").map { try! JSONDecoder().decode(TakeTelemetryLine.self, from: Data($0.utf8)) }
    #expect(lines.map(\.t) == [ 1_000, 1_001, 1_002, 1_003 ])
    #expect(lines[0].tickLatenessMaxMs == 1)
    #expect(lines[1].tickLatenessMaxMs == 42)
    #expect(lines[2].tickLatenessMaxMs == 1)
    let first = lines[0]
    #expect(first.recording == 7)
    #expect(first.thermal == "serious")
    #expect(first.missedTicks == 3)
    #expect(first.streaming && first.streamPendingEncodes == 2 && first.streamDroppedPackets == 5)
    #expect(first.liveSoundDelayMs == 500)
    #expect(first.cameras.count == 1)
    #expect(first.cameras[0].name == "1st")
    #expect(first.cameras[0].receivedFps == 30 && first.cameras[0].shownFps == 29)
    #expect(first.cameras[0].soundState == "playing" && first.cameras[0].soundHeldMs == 520)
    #expect(first.cameras[0].soundDriftPpm == -48.5 && first.cameras[0].soundTimelines == 2)
    // Every field is written, by name.
    let raw = try JSONSerialization.jsonObject(with: Data(text.split(separator: "\n")[0].utf8)) as? [String: Any]
    for key in [ "t", "recording", "thermal", "tickLatenessMaxMs", "missedTicks", "composedFps",
                 "programmeLatePictures", "programmeSkippedPictures", "streaming", "streamPendingEncodes",
                 "streamDroppedPackets", "streamQueuedBytes", "streamDisconnects", "liveSoundDelayMs",
                 "liveMixFades", "liveMixConcealedSeconds", "recordingMixFades",
                 "recordingMixConcealedSeconds", "cameras" ] {
      #expect(raw?[key] != nil, "\(key) missing")
    }
  }

  @Test("A take picked up again carries on in its own file; another take gets its own")
  func resumeAndSwitch() throws {
    let dir = try directory()
    defer { try? FileManager.default.removeItem(at: dir) }
    let log = TakeTelemetryLog(directory: dir)
    log.note(recording: 7, snapshot: snapshot(), at: 1_000)
    log.close()
    log.note(recording: 7, snapshot: snapshot(), at: 1_100)
    log.note(recording: 8, snapshot: snapshot(), at: 1_101)
    log.close()
    #expect(try String(contentsOf: log.url(for: 7), encoding: .utf8).split(separator: "\n").count == 2)
    #expect(try String(contentsOf: log.url(for: 8), encoding: .utf8).split(separator: "\n").count == 1)
    #expect(TakeTelemetryLog.filename(for: 12) == "rec-12-telemetry.jsonl")
  }

  @Test("The programme clock says how late each tick ran and how many it missed")
  func tickLatenessAndMisses() {
    var clock = ProgrammeClock(recordingRate: 60, streamRate: 60)
    _ = clock.tick(at: 10)
    let late = clock.tick(at: 10 + 1.0 / 60 + 0.004)
    #expect(abs((late?.lateness ?? 0) - 0.004) < 1e-9)
    #expect(late?.ticksMissed == 0)
    // Three ticks' worth of stall: two ticks never ran.
    let after = clock.tick(at: 10 + 4.0 / 60)
    #expect(after?.ticksMissed == 2)
  }
}
