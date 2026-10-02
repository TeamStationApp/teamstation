import DirectorPipeline
import DirectorUI
import Testing

@Suite("Output tile stats")
struct OutputStatsTests {
  private func snapshot(recording: Bool, stage: String = "idle") -> TelemetrySnapshot {
    var snapshot = TelemetrySnapshot()
    snapshot.clockSeconds = 3_725
    snapshot.dvr.isRecording = recording
    snapshot.dvr.recordingStartedAt = 1
    snapshot.recordingStage = stage
    snapshot.composedFramesPerSecond = 59.6
    snapshot.programSource = 2
    var tile = TileTelemetry(index: 2)
    tile.packetsLostPerSecond = 7
    tile.framesPerSecond = 60
    tile.frameAgeMilliseconds = 183.4
    snapshot.tiles = [TileTelemetry(index: 0), tile]
    return snapshot
  }

  @Test("Recording, output rate, and the on-air camera's loss and arrival age, in that order")
  func fourPillsWhileRecording() {
    let pills = OutputStats.pills(snapshot(recording: true))
    #expect(pills.map(\.id) == ["output-rec", "output-fps", "output-loss", "output-age"])
    #expect(pills.map(\.text) == ["REC 01:02:04", "60 fps", "loss 7", "age 183 ms"])
  }

  @Test("No recording clock while idle")
  func noClockWhileIdle() {
    let pills = OutputStats.pills(snapshot(recording: false))
    #expect(pills.map(\.id) == ["output-fps", "output-loss", "output-age"])
  }

  /// `dvr.isRecording` stays true through the whole stop path, which can take twenty seconds of
  /// writer flushing. The clock belongs to the operator's take, not to the flush.
  @Test("The clock stops when the operator stops, not when the last writer has flushed")
  func clockStopsWithTheOperator() {
    let stopping = snapshot(recording: true, stage: "finishing archives")
    #expect(!OutputStats.pills(stopping).contains { $0.id == "output-rec" })
    #expect(OutputStats.accessibilityValue(stopping).contains("rec=0"))
  }

  @Test("No on-air camera means only the output rate")
  func noProgramSource() {
    var snapshot = snapshot(recording: false)
    snapshot.programSource = nil
    #expect(OutputStats.pills(snapshot).map(\.id) == ["output-fps"])
  }

  /// A link that has died stops moving the loss counter, so a bare zero here would read exactly
  /// like a clean link at the moment it matters most.
  @Test("A camera that is not delivering shows a dash rather than zero")
  func dashWhenNothingArrives() {
    var snapshot = snapshot(recording: false)
    snapshot.tiles[1].framesPerSecond = 0
    #expect(OutputStats.pills(snapshot).first { $0.id == "output-loss" }?.text == "loss —")
  }

  @Test("The accessibility value carries the same numbers for a flow to read")
  func accessibilityValue() {
    #expect(
      OutputStats.accessibilityValue(snapshot(recording: true))
        == "fps=60 loss=7 age=183 rec=3724"
    )
  }
}
