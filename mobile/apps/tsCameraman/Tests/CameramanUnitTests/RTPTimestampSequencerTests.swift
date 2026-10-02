import Foundation
import Testing

@testable import CameramanRTSP

/// The sent timestamp has to advance for every picture, and it has to keep advancing across the
/// 32-bit field's own rollover — 13.3 hours at 90 kHz. Reading that rollover as a step backwards
/// nudges every later frame by one tick instead of a frame interval, which leaves the receiver
/// recording hours of video onto a fraction of a second.
@Suite("RTP timestamp sequencer")
struct RTPTimestampSequencerTests {
  private static let clockRate: UInt32 = 90_000
  private static let ticksPerFrame: UInt32 = 3_000

  @Test("The first timestamp is sent unchanged")
  func firstTimestampPassesThrough() {
    var sequencer = RTPTimestampSequencer()
    #expect(sequencer.next(natural: 12_345) == 12_345)
    #expect(sequencer.lastSent == 12_345)
  }

  @Test("A repeated capture time is nudged forward by one tick")
  func repeatedTimestampIsNudged() {
    var sequencer = RTPTimestampSequencer()
    #expect(sequencer.next(natural: 3_000) == 3_000)
    #expect(sequencer.next(natural: 3_000) == 3_001)
    #expect(sequencer.next(natural: 3_000) == 3_002)
  }

  @Test("A capture time that goes backwards is nudged rather than sent")
  func backwardsTimestampIsNudged() {
    var sequencer = RTPTimestampSequencer()
    #expect(sequencer.next(natural: 90_000) == 90_000)
    #expect(sequencer.next(natural: 60_000) == 90_001)
  }

  @Test("The 32-bit rollover is a forward step and is sent as-is")
  func rolloverIsSentUnchanged() {
    var sequencer = RTPTimestampSequencer()
    let beforeWrap = UInt32.max - 1_000
    #expect(sequencer.next(natural: beforeWrap) == beforeWrap)

    // One frame later the field has wrapped: 3000 ticks past `beforeWrap` is 1999.
    let afterWrap = beforeWrap &+ Self.ticksPerFrame
    #expect(afterWrap == 1_999)
    #expect(sequencer.next(natural: afterWrap) == afterWrap)
    #expect(sequencer.lastSent == 1_999)
  }

  @Test("Fourteen hours of 30 fps keeps a full frame interval per frame across the rollover")
  func rolloverKeepsTheFrameInterval() {
    var sequencer = RTPTimestampSequencer()
    let frames = 30 * 60 * 60 * 14
    var natural: UInt32 = 0
    var previous = sequencer.next(natural: natural)
    var nudged = 0

    for _ in 1 ..< frames {
      natural = natural &+ Self.ticksPerFrame
      let sent = sequencer.next(natural: natural)
      // Every frame must advance by a full frame interval, never by the one-tick nudge.
      if sent &- previous != Self.ticksPerFrame { nudged += 1 }
      previous = sent
    }

    #expect(nudged == 0)
    // The sender is still tracking the camera's own clock rather than drifting off it.
    #expect(sequencer.lastSent == natural)
  }

  @Test("Media time still advances in real time after the rollover")
  func mediaTimeAdvancesAfterTheRollover() {
    var sequencer = RTPTimestampSequencer()
    // Start one frame before the wrap so the very next frame crosses it.
    var natural = UInt32.max - Self.ticksPerFrame
    sequencer.next(natural: natural)

    var advanced: UInt64 = 0
    for _ in 0 ..< 30 {
      let before = sequencer.lastSent ?? 0
      natural = natural &+ Self.ticksPerFrame
      let sent = sequencer.next(natural: natural)
      advanced += UInt64(sent &- before)
    }

    // One second of frames must be one second of media time, not 30 ticks of it.
    #expect(advanced == UInt64(Self.clockRate))
  }

  @Test("Reset starts a new client's timeline from its own first frame")
  func resetStartsOver() {
    var sequencer = RTPTimestampSequencer()
    sequencer.next(natural: 90_000)
    sequencer.reset()
    #expect(sequencer.lastSent == nil)
    #expect(sequencer.next(natural: 42) == 42)
  }
}
