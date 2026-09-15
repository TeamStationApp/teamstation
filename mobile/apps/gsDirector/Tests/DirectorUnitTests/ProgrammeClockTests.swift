import DirectorPipeline
import Testing

@Suite("Programme clock")
struct ProgrammeClockTests {
  private func run(_ clock: inout ProgrammeClock, seconds: Double) -> [ProgrammeClock.Tick] {
    let count = Int(seconds * Double(clock.rate))
    return (0 ..< count).compactMap { clock.tick(at: Double($0) / Double(clock.rate)) }
  }

  @Test("A 30 fps recording beside a 60 fps stream takes every other tick")
  func recordingOnItsOwnGrid() {
    var clock = ProgrammeClock(recordingRate: 30, streamRate: 60)
    let ticks = run(&clock, seconds: 1)
    #expect(ticks.count == 60)
    #expect(ticks.map(\.index) == Array(0 ..< 60).map(Int64.init))
    #expect(ticks.compactMap(\.recordingFrame) == Array(0 ..< 30).map(Int64.init))
  }

  @Test("At one rate for both, every tick is a recording frame")
  func equalRates() {
    var clock = ProgrammeClock(recordingRate: 60, streamRate: 60)
    let ticks = run(&clock, seconds: 0.5)
    #expect(ticks.allSatisfy { $0.recordingFrame == $0.index })
  }

  @Test("A rate that does not divide the tick rate still gets exactly its frames a second, in order")
  func unevenRates() {
    var clock = ProgrammeClock(recordingRate: 25, streamRate: 60)
    let frames = run(&clock, seconds: 2).compactMap(\.recordingFrame)
    #expect(frames == Array(0 ..< 50).map(Int64.init))
  }

  @Test("A stream slower than the recording does not slow the clock, and takes its own frames")
  func clockRunsAtTheFasterRate() {
    var clock = ProgrammeClock(recordingRate: 60, streamRate: 30)
    #expect(clock.rate == 60)
    let ticks = run(&clock, seconds: 1)
    #expect(ticks.compactMap(\.recordingFrame) == Array(0 ..< 60).map(Int64.init))
    #expect(ticks.compactMap(\.streamFrame) == Array(0 ..< 30).map(Int64.init))
  }

  @Test("A timer firing twice for one tick makes one frame, and one firing late skips a number")
  func timerJitter() {
    var clock = ProgrammeClock(recordingRate: 30, streamRate: 30)
    #expect(clock.tick(at: 10) == ProgrammeClock.Tick(index: 0, recordingFrame: 0, streamFrame: 0))
    #expect(clock.tick(at: 10 + 0.002) == nil)
    #expect(
      clock.tick(at: 10 + 2.0 / 30)
        == ProgrammeClock.Tick(index: 2, recordingFrame: 2, streamFrame: 2, recordingFramesMissed: 1)
    )
  }

  @Test("A late timer says how many recording frames it skipped, so they can be filled")
  func missedRecordingFrames() {
    var clock = ProgrammeClock(recordingRate: 60, streamRate: 60)
    #expect(clock.tick(at: 0)?.recordingFramesMissed == 0)
    #expect(clock.tick(at: 1.0 / 60)?.recordingFramesMissed == 0)
    // Four ticks late: frames 2, 3 and 4 were due and never taken.
    let late = clock.tick(at: 5.0 / 60)
    #expect(late?.recordingFrame == 5)
    #expect(late?.recordingFramesMissed == 3)
    #expect(clock.tick(at: 6.0 / 60)?.recordingFramesMissed == 0)
  }

  @Test("At a recording rate below the tick rate, only skipped recording frames count as missed")
  func missedAtLowerRate() {
    var clock = ProgrammeClock(recordingRate: 30, streamRate: 60)
    let ticks = run(&clock, seconds: 1)
    #expect(ticks.allSatisfy { $0.recordingFramesMissed == 0 })
  }
}
