import DirectorPipeline
import DirectorUI
import Testing

@Suite("Debug HUD lines")
struct DebugHUDLinesTests {
  @Test("Every Maestro hud-* identifier is present")
  func identifiersMatchContract() {
    var snapshot = TelemetrySnapshot()
    snapshot.sourceProfile = "rtsp"
    snapshot.sourceAvailable = true
    snapshot.discoveredSourceCount = 4
    snapshot.discoveryStatus = "scan=10.10.7.0/24 confirmed=4"
    snapshot.dvr.isRecording = true
    snapshot.dvr.recordingStartedAt = 10
    snapshot.clockSeconds = 25
    snapshot.programSource = 0
    var tile = TileTelemetry(index: 0)
    tile.state = .live
    tile.displayName = "010D2 1st"
    snapshot.tiles = [tile]

    let lines = DebugHUDLines.make(snapshot).flatMap { $0 }
    let ids = Set(lines.map(\.id))
    for id in [
      "hud-profile",
      "hud-program-source",
      "hud-thermal-state",
      "hud-source-available",
      "hud-disc",
      "hud-discovery-status",
      "hud-recording",
      "hud-dvr-duration",
      "hud-memory",
      "hud-resident",
      "hud-source-1-state"
    ] {
      #expect(ids.contains(id))
    }
    #expect(lines.contains { $0.id == "hud-profile" && $0.text == "profile=rtsp" })
    #expect(lines.contains { $0.id == "hud-source-available" && $0.text == "live=1" })
    #expect(lines.contains { $0.id == "hud-recording" && $0.text == "rec=1" })
    #expect(lines.contains { $0.id == "hud-dvr-duration" && $0.text == "dur=15" })
    #expect(lines.contains { $0.id == "hud-source-1-state" && $0.text.contains("state=live") })
  }

  @Test("An empty discovery status is omitted")
  func omitsEmptyDiscovery() {
    let lines = DebugHUDLines.make(TelemetrySnapshot()).flatMap { $0 }
    #expect(!lines.contains { $0.id == "hud-discovery-status" })
    #expect(lines.contains { $0.id == "hud-source-available" && $0.text == "live=0" })
  }
}
