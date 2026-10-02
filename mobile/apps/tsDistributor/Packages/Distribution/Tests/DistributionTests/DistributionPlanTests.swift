import DirectorCore
import Distribution
import DistributorWire
import Foundation
import Testing

/// The order the Mac takes an export's files in.
///
/// One worker now: the iPad used to take every other track, which read as
/// twice the speed and was not — the Mac encodes far faster, and anything the
/// iPad made had to come back over USB afterwards.
@Suite("Which file is stitched next")
struct DistributionPlanTests {
  private let four: [Track] = [ .primary, .camera(SourceID("a")), .camera(SourceID("b")), .camera(SourceID("c")) ]

  @Test func handsThemOutInOrder() {
    var plan = DistributionPlan(tracks: four)
    #expect(plan.next() == four[0])
    #expect(plan.next() == four[1])
    #expect(plan.next() == four[2])
    #expect(plan.next() == four[3])
    #expect(plan.next() == nil)
  }

  @Test func isCompleteOnlyWhenNothingIsOutstanding() {
    var plan = DistributionPlan(tracks: four)
    for _ in four { _ = plan.next() }
    #expect(!plan.isComplete)
    for track in four { plan.finish(track) }
    #expect(plan.isComplete)
    #expect(plan.finished == four)
  }

  @Test func aTrackGivenBackIsTakenNext() {
    var plan = DistributionPlan(tracks: four)
    let first = plan.next()
    _ = plan.next()
    plan.giveBack(first!)
    // To the front: a failure is usually about the track, not the machine, so
    // it is retried before anything new is started.
    #expect(plan.next() == first)
  }

  @Test func givingBackSomethingNobodyHoldsChangesNothing() {
    var plan = DistributionPlan(tracks: four)
    let before = plan.pending
    plan.giveBack(.camera(SourceID("c")))
    #expect(plan.pending == before)
  }
}

@Suite("What a failed stitch says")
struct DistributionErrorTests {
  @Test("Each failure names what went wrong, and TS Director by name when it went away")
  func descriptions() {
    #expect(DistributionError.directorGone.description == "TS Director went away before it finished")
    #expect(DistributionError.iPadFailed("no space").description == "the iPad could not stitch it: no space")
    #expect(DistributionError.nothingToStitch.description == "there was nothing to stitch for that file")
    #expect(DistributionError.noDestination.description == "choose a folder to save into in Settings")
  }
}
