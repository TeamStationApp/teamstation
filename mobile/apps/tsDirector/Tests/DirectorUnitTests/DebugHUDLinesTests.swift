import Foundation
import DirectorPipeline
import DirectorUI
import Testing

@Suite("Debug HUD lines")
struct DebugHUDLinesTests {
  @Test("The stream's bitrate controller has a row of its own")
  func streamRateRow() {
    var snapshot = TelemetrySnapshot()
    snapshot.streamRate.codec = "hevc"
    snapshot.streamRate.bitrate = 4_300_000
    snapshot.streamRate.low = 2_000_000
    snapshot.streamRate.high = 6_000_000
    snapshot.streamRate.lastDecision = "congested"
    snapshot.streamRate.queueMilliseconds = 180
    snapshot.streamRate.deliveryBitsPerSecond = 4_120_000
    snapshot.streamRate.decreases = 3
    snapshot.streamRate.increases = 1
    snapshot.streamDroppedPackets = 0

    // Keyed by the first occurrence: two rows already share `hud-program-source`.
    let texts = Dictionary(
      DebugHUDLines.make(snapshot).flatMap { $0 }.map { ($0.id, $0.text) },
      uniquingKeysWith: { first, _ in first }
    )
    #expect(texts["hud-stream-codec"] == "scodec=hevc")
    #expect(texts["hud-stream-bitrate"] == "sbr=4.3")
    #expect(texts["hud-stream-range"] == "srange=2.0-6.0")
    #expect(texts["hud-stream-decision"] == "sdec=congested")
    #expect(texts["hud-stream-queue"] == "sq=180")
    #expect(texts["hud-stream-delivery"] == "sdlv=4.1")
    #expect(texts["hud-stream-decreases"] == "scut=3")
    #expect(texts["hud-stream-increases"] == "sup=1")
    #expect(texts["hud-stream-dropped"] == "sdrop=0")
  }

  @Test("Every Maestro hud-* identifier is present")
  func identifiersMatchContract() {
    var snapshot = TelemetrySnapshot()
    snapshot.sourceProfile = "rtsp"
    snapshot.sourceAvailable = true
    snapshot.discoveredSourceCount = 4
    snapshot.discoveryStatus = "scan=192.168.7.0/24 confirmed=4"
    snapshot.dvr.isRecording = true
    snapshot.dvr.recordingStartedAt = 10
    snapshot.clockSeconds = 25
    snapshot.programSource = 0
    var tile = TileTelemetry(index: 0)
    tile.state = .live
    tile.displayName = "00003 1st"
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

  @Test("The programme composer's time, drops and test delay reach the panel and dump-state")
  func programmeComposeTelemetry() throws {
    var snapshot = TelemetrySnapshot()
    snapshot.programmeComposeMillisecondsAverage = 1.24
    snapshot.programmeComposeMillisecondsMax = 21.5
    snapshot.programmeComposeDropped = 42
    snapshot.programmeComposeDelayMilliseconds = 20
    #expect(snapshot.programmeComposeSummary == "1.2 avg · 21.5 max ms")
    let json = try #require(String(data: try JSONEncoder().encode(snapshot), encoding: .utf8))
    #expect(json.contains("\"programmeComposeDropped\":42"))
    #expect(json.contains("\"programmeComposeMillisecondsMax\":21.5"))
    #expect(json.contains("\"programmeComposeMillisecondsAverage\":1.24"))
    #expect(json.contains("\"programmeComposeDelayMilliseconds\":20"))
  }
}
