import DirectorPipeline
import Testing

@Suite("Counter rate tracker")
struct CounterRateTrackerTests {
  @Test("Nothing is reported until a whole second has been observed")
  func silentForTheFirstSecond() {
    var tracker = CounterRateTracker()
    #expect(tracker.record(0, at: 100) == 0)
    #expect(tracker.record(5, at: 100.5) == 0)
    #expect(tracker.record(9, at: 100.9) == 0)
  }

  @Test("Twelve lost over one second reads twelve")
  func wholeSecond() {
    var tracker = CounterRateTracker()
    tracker.record(100, at: 10)
    #expect(tracker.record(112, at: 11) == 12)
  }

  @Test("The rate is normalised to a second, not the poll interval")
  func normalisedToOneSecond() {
    var tracker = CounterRateTracker()
    tracker.record(0, at: 0)
    tracker.record(3, at: 0.6)
    #expect(tracker.record(6, at: 1.5) == 4)
  }

  @Test("The last rate holds between folds, and a quiet second returns it to zero")
  func holdsThenClears() {
    var tracker = CounterRateTracker()
    tracker.record(0, at: 0)
    tracker.record(10, at: 1)
    #expect(tracker.record(10, at: 1.2) == 10)
    #expect(tracker.record(10, at: 2.0) == 0)
  }

  @Test("A counter that goes backwards is a new pipeline, not negative loss")
  func resetOnDecrease() {
    var tracker = CounterRateTracker()
    tracker.record(500, at: 0)
    tracker.record(520, at: 1)
    #expect(tracker.perSecond == 20)
    // Pipeline rebuilt on the same slot: its counter restarts near zero.
    #expect(tracker.record(3, at: 1.2) == 0)
    // And the fold after the restart measures from the restart, not from 520.
    #expect(tracker.record(7, at: 2.2) == 4)
  }
}
