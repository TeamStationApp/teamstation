import DirectorCore
import DirectorExport
import Foundation
import DistributorWire
import Testing

@Suite("Settings and wire messages")
struct SettingsAndWireTests {
  @Test("Settings round-trip through JSON")
  func settingsRoundTrip() throws {
    let settings = DistributorSettings(
      destinations: [ "8A1F-MAC": "/Users/someone/Movies/GameStation" ],
      createCombined: true,
      combinedLayout: CombinedLayoutSettings(
        included: [ "Home", "Away", "Wide" ],
        placements: [ QuadrantPlacement(camera: "Home", quadrant: .topLeading) ],
        solo: SoloPlacement(camera: "Wide", axis: .vertical, position: 0.5),
        audioCamera: "Home"
      ),
      peerTube: PeerTubeSettings(
        enabled: true,
        host: "videos.example.org",
        username: "spjr",
        channelID: 3,
        privacy: 6,
        uploadChoice: UploadChoice(primary: true, cameras: [ "Home" ], combined: true)
      )
    )
    let decoded = try JSONDecoder().decode(DistributorSettings.self, from: JSONEncoder().encode(settings))
    #expect(decoded == settings)
  }

  @Test("Settings written before a field existed still load, with that field's default")
  func olderSettingsLoad() throws {
    let old = #"{"createCombined":true,"peerTube":{"enabled":true,"host":"videos.example.org"}}"#
    let decoded = try JSONDecoder().decode(DistributorSettings.self, from: Data(old.utf8))
    #expect(decoded.createCombined)
    #expect(decoded.destinations.isEmpty)
    #expect(decoded.peerTube.host == "videos.example.org")
    #expect(decoded.peerTube.uploadChoice == UploadChoice())
    #expect(decoded.combinedLayout == CombinedLayoutSettings())
  }

  @Test("The upload choice shows only what this export makes, and remembers the rest")
  func uploadChoice() {
    let saved = UploadChoice(primary: true, cameras: [ "Home", "Old" ], combined: true)
    let shown = saved.applied(hasPrimary: true, cameras: [ "Home", "Away" ], makesCombined: false)
    #expect(shown == UploadChoice(primary: true, cameras: [ "Home" ], combined: false))

    let ticked = UploadChoice(primary: false, cameras: [ "Away" ], combined: false)
    let remembered = saved.remembering(ticked, from: [ "Home", "Away" ])
    #expect(remembered == UploadChoice(primary: false, cameras: [ "Away", "Old" ], combined: false))
  }

  @Test("Protocol messages round-trip through JSON")
  func wireRoundTrip() throws {
    let window = ExportWindow(start: WallClock(seconds: 1_000), end: WallClock(seconds: 4_600))
    let request = JobRequest(recordingID: 361, track: .camera(SourceID("cam-a")), window: window, reprocess: false)
    #expect(try JSONDecoder().decode(JobRequest.self, from: JSONEncoder().encode(request)) == request)

    let events: [DistributorEvent] = [
      .jobProgress(jobID: UUID(), fraction: 0.4),
      .jobFinished(jobID: UUID(), file: RemoteFile(root: .prepared, path: "rec-361/a.mov", bytes: 12)),
      .jobFailed(jobID: UUID(), reason: "no segments"),
      .recordingsChanged,
      .recordingStateChanged(isRecording: true),
      .directorBackgrounded
    ]
    for event in events {
      #expect(try JSONDecoder().decode(DistributorEvent.self, from: JSONEncoder().encode(event)) == event)
    }

    let listing = RecordingListing(
      id: 361,
      startedAt: WallClock(seconds: 1_000),
      endedAt: nil,
      isLive: true,
      hasPrimary: true,
      cameras: [ CameraListing(sourceID: SourceID("cam-a"), name: "Home", isNamed: true, bytes: 1_234) ],
      preparedTracks: [ .primary ]
    )
    #expect(try JSONDecoder().decode(RecordingListing.self, from: JSONEncoder().encode(listing)) == listing)
  }
}
