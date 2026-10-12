import DirectorClient
import DirectorCore
import Distribution
import DistributorWire
import Foundation
import Testing

@Suite("What an export fetches for its uploads")
struct UploadNeedsTests {
  static let home = SourceID("cam-home")
  static let away = SourceID("cam-away")
  static let recording = RecordingListing(
    id: 1, startedAt: WallClock(seconds: 1_000), endedAt: WallClock(seconds: 1_010), isLive: false,
    hasPrimary: true,
    cameras: [
      CameraListing(sourceID: home, name: "home", isNamed: true, bytes: 10),
      CameraListing(sourceID: away, name: "away", isNamed: true, bytes: 10)
    ],
    preparedTracks: []
  )

  static func upload(_ tracks: [UploadTrack]) -> TeamStationPlan {
    TeamStationPlan(gameId: "gam_1", title: "2026-01-01 Home at Away", tracks: tracks) { _, _, _, _, _ in "vid" }
  }

  @Test("Every file an upload sends is fetched, in the recording's order, though only one was asked for")
  func uploadsAddTheirFiles() {
    let tracks = DistributionRun.tracks(
      of: Self.recording,
      asked: [ .camera(Self.away) ],
      combined: nil,
      teamStation: Self.upload([ .camera("home"), .primary ])
    )
    #expect(tracks == [ .primary, .camera(Self.home), .camera(Self.away) ])
  }

  @Test("A combined video that goes up brings the files it is made from")
  func combinedBringsItsInputs() {
    let combined = CombinedPlan(
      inputs: [ (name: "home", track: .camera(Self.home)), (name: "away", track: .camera(Self.away)) ],
      frames: [:],
      audioCamera: nil
    )
    let tracks = DistributionRun.tracks(
      of: Self.recording, asked: [], combined: combined, teamStation: Self.upload([ .combined ])
    )
    #expect(tracks == [ .camera(Self.home), .camera(Self.away) ])
  }

  @Test("An export with nothing to upload fetches what was asked for and nothing else")
  func onlyWhatWasAsked() {
    let tracks = DistributionRun.tracks(of: Self.recording, asked: [ .camera(Self.home) ], combined: nil, teamStation: nil)
    #expect(tracks == [ .camera(Self.home) ])
  }

  @Test("With no iPad, a file an upload needs that is not here says so, and is not uploaded")
  @MainActor
  func missingFileIsNotUploaded() async throws {
    let destination = FileManager.default.temporaryDirectory
      .appendingPathComponent("upload-needs-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: destination) }
    let run = DistributionRun(
      recording: Self.recording,
      tracks: [],
      connection: nil,
      jobs: JobWatcher(),
      destination: destination,
      teamStation: Self.upload([ .camera("home") ])
    )
    #expect(run.tracks == [ .camera(Self.home) ])
    await run.run()
    #expect(run.states[.camera(Self.home)] == .failed(DistributionRun.noIPad))
    #expect(run.uploadStates[.camera("home")] == .failed("not saved, so not uploaded"))
  }
}
