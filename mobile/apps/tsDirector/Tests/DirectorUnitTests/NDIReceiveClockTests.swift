import CNDI
import CoreMedia
import XCTest
import DirectorCore
@testable import DirectorNDI

/// The timeline an NDI camera's frames land on.
///
/// Two properties matter more than the arithmetic. Presentation time must be monotonic, because a
/// fragmented MP4 refuses a sample with no duration and a negative one takes the writer with it.
/// And capture time must be the sender's, not ours, because a segment's start is recorded from it —
/// taking it from arrival is why two cameras rewound to the same moment can land in different
/// places.
final class NDIReceiveClockTests: XCTestCase {
  private func makeFrame(rateN: Int32, rateD: Int32, timestamp: Int64) -> NDIlib_video_frame_v2_t {
    var frame = NDIlib_video_frame_v2_t()
    frame.xres = 1_920
    frame.yres = 1_080
    frame.frame_rate_N = rateN
    frame.frame_rate_D = rateD
    frame.timestamp = timestamp
    frame.timecode = timestamp
    return frame
  }

  /// NDI's clocks are in 100 ns units.
  private func ticks(secondsSince1970: Double) -> Int64 {
    Int64(secondsSince1970 * NDIReceiveClock.ticksPerSecond)
  }

  func testPresentationTimeAdvancesOneFrameAt30() {
    let clock = NDIReceiveClock(clock: SystemClock())
    let base = Date().timeIntervalSince1970

    var times: [Double] = []
    for index in 0 ..< 5 {
      let frame = makeFrame(
        rateN: 30_000,
        rateD: 1_000,
        timestamp: ticks(secondsSince1970: base + Double(index) / 30)
      )
      guard let timing = clock.timing(for: frame) else {
        return XCTFail("frame \(index) was refused")
      }
      XCTAssertEqual(timing.frameID, UInt64(index))
      XCTAssertEqual(timing.duration.seconds, 1.0 / 30, accuracy: 1e-9)
      times.append(timing.presentationTime.seconds)
    }
    for index in 1 ..< times.count {
      XCTAssertEqual(times[index] - times[index - 1], 1.0 / 30, accuracy: 1e-9)
    }
  }

  func testPresentationTimeAdvancesOneFrameAt60() {
    let clock = NDIReceiveClock(clock: SystemClock())
    let base = Date().timeIntervalSince1970
    var previous: CMTime?
    for index in 0 ..< 5 {
      let frame = makeFrame(
        rateN: 60_000,
        rateD: 1_000,
        timestamp: ticks(secondsSince1970: base + Double(index) / 60)
      )
      guard let timing = clock.timing(for: frame) else {
        return XCTFail("frame \(index) was refused")
      }
      XCTAssertEqual(timing.duration.seconds, 1.0 / 60, accuracy: 1e-9)
      if let previous {
        XCTAssertGreaterThan(timing.presentationTime, previous)
      }
      previous = timing.presentationTime
    }
  }

  /// 59.94, which is what an NTSC-timebase camera actually sends. The timescale has to come from
  /// the numerator rather than a fixed 90 kHz, which does not divide it.
  func testHandlesFractionalFrameRate() {
    let clock = NDIReceiveClock(clock: SystemClock())
    let frame = makeFrame(
      rateN: 60_000,
      rateD: 1_001,
      timestamp: ticks(secondsSince1970: Date().timeIntervalSince1970)
    )
    guard let timing = clock.timing(for: frame) else { return XCTFail("refused") }
    XCTAssertEqual(timing.duration.seconds, 1_001.0 / 60_000, accuracy: 1e-9)
  }

  /// The sender's own timestamp is the capture time, so a frame stamped a known moment ago comes
  /// back as that moment rather than as now.
  func testCaptureTimeComesFromTheSender() {
    let clock = NDIReceiveClock(clock: SystemClock())
    let now = Date().timeIntervalSince1970
    let frame = makeFrame(rateN: 30_000, rateD: 1_000, timestamp: ticks(secondsSince1970: now))
    guard let timing = clock.timing(for: frame) else { return XCTFail("refused") }
    guard let capture = timing.captureWallClock else { return XCTFail("no capture time") }
    XCTAssertEqual(capture.seconds, now, accuracy: 1.0)
  }

  /// A timestamp that goes backwards would put a negative-duration sample into the archive, which
  /// the muxer refuses outright — so the frame is dropped and counted instead.
  func testBackwardsTimestampIsDroppedAndCounted() {
    let clock = NDIReceiveClock(clock: SystemClock())
    let base = Date().timeIntervalSince1970

    XCTAssertNotNil(clock.timing(for: makeFrame(
      rateN: 30_000, rateD: 1_000, timestamp: ticks(secondsSince1970: base + 1)
    )))
    XCTAssertNil(
      clock.timing(for: makeFrame(
        rateN: 30_000, rateD: 1_000, timestamp: ticks(secondsSince1970: base)
      )),
      "a frame that went backwards in time was accepted"
    )
    XCTAssertEqual(clock.outOfOrderFrames, 1)

    // And the timeline recovers rather than stopping.
    XCTAssertNotNil(clock.timing(for: makeFrame(
      rateN: 30_000, rateD: 1_000, timestamp: ticks(secondsSince1970: base + 2)
    )))
  }

  /// A sender with no clock still has to produce a usable timeline; arrival time stands in.
  func testMissingTimestampFallsBackToArrival() {
    let clock = NDIReceiveClock(clock: SystemClock())
    var frame = makeFrame(rateN: 30_000, rateD: 1_000, timestamp: 0)
    frame.timestamp = NDIlib_recv_timestamp_undefined
    guard let timing = clock.timing(for: frame) else { return XCTFail("refused") }
    XCTAssertNotNil(timing.captureWallClock)
    XCTAssertEqual(
      timing.captureWallClock!.seconds,
      Date().timeIntervalSince1970,
      accuracy: 2.0
    )
  }

  /// A zero timestamp is no clock at all, so the frame is placed at its arrival.
  func testZeroSenderClockIsIgnored() {
    let clock = NDIReceiveClock(clock: SystemClock())
    let frame = makeFrame(rateN: 30_000, rateD: 1_000, timestamp: ticks(secondsSince1970: 0))
    guard let timing = clock.timing(for: frame) else { return XCTFail("refused") }
    guard let capture = timing.captureWallClock else { return XCTFail("no capture time") }
    XCTAssertEqual(capture.seconds, Date().timeIntervalSince1970, accuracy: 2.0)
  }

  func testResetRestartsTheTimeline() {
    let clock = NDIReceiveClock(clock: SystemClock())
    let base = Date().timeIntervalSince1970
    for index in 0 ..< 3 {
      _ = clock.timing(for: makeFrame(
        rateN: 30_000, rateD: 1_000, timestamp: ticks(secondsSince1970: base + Double(index) / 30)
      ))
    }
    clock.reset()
    guard let timing = clock.timing(for: makeFrame(
      rateN: 30_000, rateD: 1_000, timestamp: ticks(secondsSince1970: base)
    )) else { return XCTFail("refused after reset") }
    XCTAssertEqual(timing.frameID, 0)
    XCTAssertEqual(timing.presentationTime, .zero)
  }

  /// A Hollyland Cosmo C2 declares `frame_rate_N/D` of 120/1 and sends 60 fps. Measured against
  /// its own timestamps and the SDK's dropped-frame counters, both of which say 60.00 with nothing
  /// lost, so this is a false declaration rather than frames going missing.
  ///
  /// Stepping the timeline by the declared 1/120 wrote a video track lasting half the audio track
  /// beside it: 360 frames spanning 3.000 s of video against 5.887 s of audio, which plays the
  /// picture at double speed and drifts nearly three seconds out of sync inside one segment.
  func testMisdeclaredFrameRateIsMeasuredRatherThanBelieved() {
    let clock = NDIReceiveClock(clock: SystemClock())
    let base = Date().timeIntervalSince1970
    let realRate = 60.0

    var times: [Double] = []
    for index in 0 ..< 40 {
      let frame = makeFrame(
        rateN: 120,
        rateD: 1,
        timestamp: ticks(secondsSince1970: base + Double(index) / realRate)
      )
      guard let timing = clock.timing(for: frame) else {
        return XCTFail("frame \(index) was refused")
      }
      times.append(timing.presentationTime.seconds)
    }

    XCTAssertEqual(clock.measuredFrameRate, realRate)
    // The last stretch is measured; the opening frames ran on the declaration while the window
    // filled, which is why the whole span is not asserted.
    let step = times[39] - times[38]
    XCTAssertEqual(step, 1 / realRate, accuracy: 1e-6)
  }

  /// The declaration is still what the first frames run on: a measurement needs a window, and a
  /// timeline cannot wait for one.
  func testDeclaredRateIsUsedUntilThereIsAMeasurement() {
    let clock = NDIReceiveClock(clock: SystemClock())
    let base = Date().timeIntervalSince1970
    guard let first = clock.timing(for: makeFrame(
      rateN: 60, rateD: 1, timestamp: ticks(secondsSince1970: base)
    )) else { return XCTFail("first frame refused") }
    guard let second = clock.timing(for: makeFrame(
      rateN: 60, rateD: 1, timestamp: ticks(secondsSince1970: base + 1 / 60)
    )) else { return XCTFail("second frame refused") }
    XCTAssertNil(clock.measuredFrameRate)
    XCTAssertEqual(second.presentationTime.seconds - first.presentationTime.seconds, 1 / 60, accuracy: 1e-9)
  }

  /// A clock that goes back by less than `clockJumpSeconds` and stays back is not reordering
  /// either. It is refused for `clockRestartFrames` frames, then adopted, so the tile is never
  /// wedged; a bigger move, a reboot, is adopted on its first frame (`NDISenderClockTests`).
  func testSmallPersistentClockStepIsAdoptedAfterTheBackstop() {
    let clock = NDIReceiveClock(clock: SystemClock())
    let base = Date().timeIntervalSince1970

    for index in 0 ..< 20 {
      _ = clock.timing(for: makeFrame(
        rateN: 60, rateD: 1, timestamp: ticks(secondsSince1970: base + Double(index) / 60)
      ))
    }
    let beforeRestart = clock.outOfOrderFrames

    // The clock comes back five seconds behind where it was, and stays there.
    let sent = 90
    var acceptedTail = 0
    var lastPresentation: Double = -1
    for index in 0 ..< sent {
      guard let timing = clock.timing(for: makeFrame(
        rateN: 60,
        rateD: 1,
        timestamp: ticks(secondsSince1970: base - 5 + Double(index) / 60)
      )) else { continue }
      if index >= NDIReceiveClock.clockRestartFrames - 1 { acceptedTail += 1 }
      // Monotonic across the restart, because the timeline is a counter and not the sender's clock.
      XCTAssertGreaterThan(timing.presentationTime.seconds, lastPresentation)
      lastPresentation = timing.presentationTime.seconds
    }

    XCTAssertEqual(clock.clockRestarts, 1, "the restart should be recognised exactly once")
    XCTAssertEqual(acceptedTail, sent - NDIReceiveClock.clockRestartFrames + 1)
    XCTAssertEqual(
      clock.outOfOrderFrames - beforeRestart,
      UInt64(NDIReceiveClock.clockRestartFrames),
      "a restart should cost the diagnosis window and nothing more"
    )
  }

  /// And a genuinely reordered frame is still refused, which is what the guard is for.
  func testSingleReorderedFrameIsStillRefused() {
    let clock = NDIReceiveClock(clock: SystemClock())
    let base = Date().timeIntervalSince1970
    for index in 0 ..< 20 {
      _ = clock.timing(for: makeFrame(
        rateN: 60, rateD: 1, timestamp: ticks(secondsSince1970: base + Double(index) / 60)
      ))
    }
    let before = clock.outOfOrderFrames
    // One frame arriving two frame intervals late.
    XCTAssertNil(clock.timing(for: makeFrame(
      rateN: 60, rateD: 1, timestamp: ticks(secondsSince1970: base + 17.0 / 60)
    )))
    XCTAssertEqual(clock.outOfOrderFrames - before, 1)
    XCTAssertEqual(clock.clockRestarts, 0)
  }

  func testAudioTimeIsOnItsOwnClock() {
    let clock = NDIReceiveClock(clock: SystemClock())
    let first = clock.audioPresentationTime(sampleIndex: 0, sampleRate: 48_000)
    let second = clock.audioPresentationTime(sampleIndex: 1_024, sampleRate: 48_000)
    XCTAssertEqual(first.seconds, 0, accuracy: 1e-9)
    XCTAssertEqual(second.seconds, 1_024.0 / 48_000, accuracy: 1e-9)
  }
}
