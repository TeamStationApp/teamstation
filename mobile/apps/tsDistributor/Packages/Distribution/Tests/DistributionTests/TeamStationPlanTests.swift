import DirectorCore
import Distribution
import DistributorWire
import Foundation
import Testing

/// What each upload of a take is told about the server's clock.
///
/// TS Director lists each take with how far the server's clock was ahead of the iPad's while it was
/// made; every file of the take goes up with that, so the server places the videos on its own
/// clock, where the game's scoring is.
@Suite("The server clock offset an upload carries")
struct TeamStationPlanTests {
  private actor Offsets {
    var sent: [(kind: String, offset: Int?)] = []
    func add(_ kind: String, _ offset: Int?) { sent.append((kind, offset)) }
  }

  private static func listing(offset: Int?) -> RecordingListing {
    var listing = ContinueExportTests.recording
    listing.serverClockOffsetMs = offset
    return listing
  }

  private static func plan(for listing: RecordingListing, into offsets: Offsets) -> TeamStationPlan {
    TeamStationPlan(
      listing: listing,
      gameId: "gam_1",
      title: "2026-01-01 Home at Away",
      tracks: [ .primary, .camera("home") ]
    ) { _, _, kind, offset, _ in
      await offsets.add(kind, offset)
      return "vid_\(kind)"
    }
  }

  @Test("A plan made from a listing carries its offset, and the plain one none")
  func takesTheListingsOffset() {
    let offsets = Offsets()
    #expect(Self.plan(for: Self.listing(offset: 1_234), into: offsets).serverClockOffsetMs == 1_234)
    #expect(Self.plan(for: Self.listing(offset: nil), into: offsets).serverClockOffsetMs == nil)
    let plan = Self.plan(for: Self.listing(offset: -5), into: offsets)
    #expect(plan.gameId == "gam_1")
    #expect(plan.title == "2026-01-01 Home at Away")
    #expect(plan.tracks == [ .primary, .camera("home") ])
    #expect(TeamStationPlan(gameId: "gam_1", title: "t", tracks: []) { _, _, _, _, _ in "vid" }.serverClockOffsetMs == nil)
  }

  @Test("Every file of the take is sent with the listing's offset, or with none")
  @MainActor
  func handsItToSend() async throws {
    for offset in [ Optional(1_234), nil ] {
      let destination = try ContinueExportTests.temporary("plan-offset")
      defer { try? FileManager.default.removeItem(at: destination) }
      let listing = Self.listing(offset: offset)
      try ContinueExportTests.place(DistributionRun.filename(for: .primary, of: listing), bytes: 5, in: destination)
      try ContinueExportTests.place(
        DistributionRun.filename(for: .camera(ContinueExportTests.camera), of: listing), bytes: 5, in: destination
      )
      let offsets = Offsets()

      // Every file is already on this Mac, so the export needs no iPad and goes straight to sending.
      let run = DistributionRun(
        recording: listing,
        tracks: [],
        connection: nil,
        jobs: JobWatcher(),
        destination: destination,
        teamStation: Self.plan(for: listing, into: offsets)
      )
      await run.run()

      #expect(run.uploadStates[.primary] == .done)
      #expect(run.uploadStates[.camera("home")] == .done)
      let sent = await offsets.sent
      #expect(sent.map(\.kind) == [ "program", "home" ])
      #expect(sent.map(\.offset) == [ offset, offset ])
    }
  }
}
