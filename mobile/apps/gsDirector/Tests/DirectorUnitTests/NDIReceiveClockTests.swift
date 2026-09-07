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

  /// A sender whose clock is not set reports 1970. Anchoring the DVR to that would put every one
  /// of its segments outside the recording's own span, so it is treated as having no clock.
  func testAbsurdSenderClockIsIgnored() {
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

  func testAudioTimeIsOnItsOwnClock() {
    let clock = NDIReceiveClock(clock: SystemClock())
    let first = clock.audioPresentationTime(sampleIndex: 0, sampleRate: 48_000)
    let second = clock.audioPresentationTime(sampleIndex: 1_024, sampleRate: 48_000)
    XCTAssertEqual(first.seconds, 0, accuracy: 1e-9)
    XCTAssertEqual(second.seconds, 1_024.0 / 48_000, accuracy: 1e-9)
  }
}
