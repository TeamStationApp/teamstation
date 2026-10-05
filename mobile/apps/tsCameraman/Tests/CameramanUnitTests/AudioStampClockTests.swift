import Foundation
import Testing

@testable import CameramanRTSP

/// The iPhone's sound is stamped by capture position (U-C1). Counted from zero, every stamp after a
/// microphone dropout was early by what the microphone lost until the next sender report said so.
struct AudioStampClockTests {
  private let frame = 1_024.0 / 48_000

  @Test func stampsAdvanceBySampleCountWhateverTheCaptureJitter() {
    var clock = AudioStampClock(sampleRate: 48_000)
    let jitter = [0.0, 0.003, -0.004, 0.002, -0.001, 0.004]
    let stamps = (0 ..< 60).map { clock.next(capture: 100 + Double($0) * frame + jitter[$0 % jitter.count]) }
    #expect(stamps.map(\.timestamp) == (0 ..< 60).map { UInt32($0 * 1_024) })
    #expect(stamps.allSatisfy { !$0.afterGap })
    #expect(clock.gaps == 0)
  }

  @Test func aDropoutSkipsTheStampByWhatWasLost() {
    var clock = AudioStampClock(sampleRate: 48_000)
    for index in 0 ..< 10 { _ = clock.next(capture: 100 + Double(index) * frame) }
    // 2,400 samples (50 ms) never captured between frame 9 and the next.
    let after = clock.next(capture: 100 + 10 * frame + 0.05)
    #expect(after.afterGap)
    #expect(after.timestamp == 10 * 1_024 + 2_400)
    #expect(clock.skippedSamples == 2_400)
    #expect(clock.gaps == 1)
    // Then contiguous again from there.
    let next = clock.next(capture: 100 + 11 * frame + 0.05)
    #expect(next.timestamp == 11 * 1_024 + 2_400)
    #expect(!next.afterGap)
  }

  @Test func neverBackwardsAndANewSessionStartsAtZero() {
    var clock = AudioStampClock(sampleRate: 48_000)
    _ = clock.next(capture: 100)
    _ = clock.next(capture: 100 + frame)
    // A capture time that goes back still advances by a frame.
    let back = clock.next(capture: 99)
    #expect(back.timestamp == 2_048)
    clock.reset()
    let fresh = clock.next(capture: 500)
    #expect(fresh.timestamp == 0)
    #expect(clock.skippedSamples == 0)
  }

  @Test func theStampWrapsOnTheThirtyTwoBitCircle() {
    var clock = AudioStampClock(sampleRate: 48_000)
    _ = clock.next(capture: 0)
    // 25 hours in: past 2^32 samples at 48 kHz.
    let late = clock.next(capture: 90_000)
    #expect(late.afterGap)
    #expect(late.timestamp == UInt32(truncatingIfNeeded: Int64(90_000 * 48_000)))
  }

  @Test func eachStreamLeadsASessionWithASenderReportThenReportsOnceASecond() {
    var schedule = SenderReportSchedule()
    let start = Date(timeIntervalSince1970: 1_000)
    let answers = [
      schedule.reportBeforeFirstPacket(at: start),
      schedule.reportBeforeFirstPacket(at: start.addingTimeInterval(0.1)),
      schedule.reportIsDue(at: start.addingTimeInterval(0.5)),
      schedule.reportIsDue(at: start.addingTimeInterval(1.0)),
      schedule.reportIsDue(at: start.addingTimeInterval(1.5)),
    ]
    #expect(answers == [ true, false, false, true, false ])
    // A new session leads with a report again, however recently the last one went.
    schedule.reset()
    let again = schedule.reportBeforeFirstPacket(at: start.addingTimeInterval(1.6))
    #expect(again)
  }
}
