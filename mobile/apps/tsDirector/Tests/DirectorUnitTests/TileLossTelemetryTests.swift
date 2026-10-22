import Foundation
import DirectorPipeline
import Testing

@Suite("Tile loss telemetry")
struct TileLossTelemetryTests {
  private func liveTile() -> TileTelemetry {
    var tile = TileTelemetry(index: 0)
    tile.state = .live
    tile.framesPerSecond = 60
    tile.packetsLostPerSecond = 4
    return tile
  }

  @Test("A delivering camera shows its rate")
  func showsRate() {
    #expect(liveTile().lossPerSecondLabel == "4")
  }

  @Test("A clean delivering camera shows zero rather than hiding")
  func showsZero() {
    var tile = liveTile()
    tile.packetsLostPerSecond = 0
    #expect(tile.lossPerSecondLabel == "0")
  }

  /// Loss is counted from gaps between packets that arrive, so a dead link stops moving the
  /// counter and folds to zero — the same reading a clean link gives.
  @Test("A camera delivering nothing shows a dash, not zero")
  func dashWhenSilent() {
    var tile = liveTile()
    tile.framesPerSecond = 0
    tile.packetsLostPerSecond = 0
    #expect(tile.lossPerSecondLabel == "—")
  }

  @Test("A stalled camera shows a dash even while its last rate stands")
  func dashWhenStalled() {
    var tile = liveTile()
    tile.stalledForSeconds = 3
    #expect(tile.lossPerSecondLabel == "—")
  }

  @Test("Recording seconds and the actively-recording flag follow the operator, not the flush")
  func recordingHelpers() {
    var snapshot = TelemetrySnapshot()
    snapshot.clockSeconds = 100
    snapshot.dvr.recordingStartedAt = 40
    #expect(snapshot.recordingSeconds == 0)
    #expect(!snapshot.isActivelyRecording)

    snapshot.dvr.isRecording = true
    #expect(snapshot.recordingSeconds == 60)
    #expect(snapshot.isActivelyRecording)

    // The stop path keeps `dvr.isRecording` true while it flushes; the stage says otherwise.
    snapshot.recordingStage = "finishing archives"
    #expect(!snapshot.isActivelyRecording)
  }

  @Test("The on-air tile is found once, by the snapshot itself")
  func programTile() {
    var snapshot = TelemetrySnapshot()
    var tile = TileTelemetry(index: 3)
    tile.displayName = "CAM4"
    snapshot.tiles = [TileTelemetry(index: 0), tile]
    #expect(snapshot.programTile == nil)
    snapshot.programSource = 3
    #expect(snapshot.programTile?.displayName == "CAM4")
    #expect(snapshot.programSourceLabel == "CAM4")
  }

  /// A reset exists to clear stale readings. A tracker that kept its baseline would publish the
  /// pre-reset rate straight back into the fresh snapshot on the next poll.
  @Test("A reset forgets the rate trackers, not only the numbers they produced")
  func resetClearsRateTrackers() {
    let telemetry = PipelineTelemetry()
    telemetry.recordPacketsLost(tile: 0, cumulative: 0)
    telemetry.recordComposedFrames(0)
    telemetry.reset()
    // Immediately after a reset, well inside the one-second fold window: a retained baseline
    // would fold this delta and republish a rate.
    telemetry.recordPacketsLost(tile: 0, cumulative: 500)
    telemetry.recordComposedFrames(500)
    let snapshot = telemetry.snapshot
    #expect(snapshot.tiles.first { $0.index == 0 }?.packetsLostPerSecond == 0)
    #expect(snapshot.composedFramesPerSecond == 0)
  }

  @Test("Delay-line trims reach the HUD line, the Performance panel and dump-state")
  func trimsAreReported() throws {
    var tile = liveTile()
    tile.codedPicturesTrimmed = 3
    tile.decodedPicturesTrimmed = 4
    #expect(tile.accessibilityValue.contains(" trim=3/4"))
    #expect(tile.trimSummary == "trimmed 3 coded · 4 decoded")
    let json = try #require(String(data: try JSONEncoder().encode(tile), encoding: .utf8))
    #expect(json.contains("\"codedPicturesTrimmed\":3"))
    #expect(json.contains("\"decodedPicturesTrimmed\":4"))
  }
}
