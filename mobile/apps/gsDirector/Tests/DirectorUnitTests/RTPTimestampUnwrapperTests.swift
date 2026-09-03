import Foundation
import Testing

@testable import DirectorRTSP

/// The 32-bit RTP field wraps every 13 hours at 90 kHz, and a signed reading of it gives up at half
/// that. Both are inside the length of one long recording session, so the unwrap is what decides
/// whether hour seven of a game has a picture.
@Suite("RTP timestamp unwrapper")
struct RTPTimestampUnwrapperTests {
  private static let videoClock: UInt64 = 90_000

  @Test("The first timestamp starts the timeline at zero however large it is")
  func firstTimestampIsZero() {
    var timeline = RTPTimestampUnwrapper()
    #expect(timeline.hasStarted == false)
    #expect(timeline.unwrap(3_000_000_000) == 0)
    #expect(timeline.hasStarted)
    #expect(timeline.ticks == 0)
  }

  @Test("Ticks accumulate across a step that a signed 32-bit delta would read as negative")
  func survivesTheSignedBoundary() {
    var timeline = RTPTimestampUnwrapper()
    let base: UInt32 = 1000
    timeline.unwrap(base)

    // 2^31 ticks is 6.6 hours at 90 kHz — where a signed delta flips and the old code clamped
    // every later frame onto presentation time zero.
    let step: UInt32 = 1 << 30
    #expect(timeline.unwrap(base &+ step) == UInt64(step))
    #expect(timeline.unwrap(base &+ step &+ step) == UInt64(step) * 2)
    #expect(timeline.ticks == UInt64(1) << 31)
    #expect(Int32(bitPattern: (base &+ step &+ step) &- base) < 0)
  }

  @Test("A rollover past 2^32 keeps counting instead of returning to zero")
  func survivesTheRollover() {
    var timeline = RTPTimestampUnwrapper()
    timeline.unwrap(UInt32.max - 90_000)

    // One second before the wrap, then one second after it.
    let afterWrap = timeline.unwrap(9_999)
    #expect(afterWrap == 90_000 + 10_000)
    #expect(timeline.ticks == afterWrap)
  }

  @Test("Seven hours of 30 fps video advances monotonically the whole way")
  func sevenHoursStaysMonotonic() {
    var timeline = RTPTimestampUnwrapper()
    let tickStep = UInt32(Self.videoClock / 30)
    var timestamp = UInt32(4_294_000_000)
    timeline.unwrap(timestamp)

    var last: UInt64 = 0
    var regressions = 0
    let frames = 30 * 60 * 60 * 7
    for _ in 0 ..< frames {
      timestamp = timestamp &+ tickStep
      let ticks = timeline.unwrap(timestamp)
      if ticks <= last { regressions += 1 }
      last = ticks
    }

    #expect(regressions == 0)
    let seconds = Double(last) / Double(Self.videoClock)
    #expect(abs(seconds - Double(frames) / 30) < 0.001)
    #expect(seconds > 6.628 * 3600)
  }

  @Test("A repeated timestamp holds the count rather than jumping a full circle")
  func repeatedTimestampHolds() {
    var timeline = RTPTimestampUnwrapper()
    timeline.unwrap(500)
    let advanced = timeline.unwrap(3_500)
    #expect(timeline.unwrap(3_500) == advanced)
  }

  @Test("A small step backwards moves back, and never below the start of the timeline")
  func backwardsStepIsClampedAtZero() {
    var timeline = RTPTimestampUnwrapper()
    timeline.unwrap(10_000)
    #expect(timeline.unwrap(13_000) == 3_000)
    #expect(timeline.unwrap(12_000) == 2_000)
    #expect(timeline.unwrap(1_000) == 0)
  }

  @Test("Reset starts a fresh timeline for a reconnected camera")
  func resetStartsOver() {
    var timeline = RTPTimestampUnwrapper()
    timeline.unwrap(1_000)
    #expect(timeline.unwrap(91_000) == 90_000)
    timeline.reset()
    #expect(timeline.hasStarted == false)
    #expect(timeline.unwrap(700_000) == 0)
  }
}
