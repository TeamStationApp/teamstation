import CoreMedia
import Foundation
import Testing
@testable import DirectorMedia
@testable import DirectorPipeline

@Suite("Where a publish's first picture was captured")
struct StreamTimelineStartTests {
  @Test("The first picture sent is placed by its own capture, a picture delay before its stamp")
  func firstSentPictureByItsCapture() {
    var start = StreamTimelineStart()
    let startWall = 1_000.0
    // Pictures stamped while the publish was still dialling, each a second and a bit old.
    for index in 0 ..< 12 {
      let now = startWall + Double(index) / 30
      start.submitted(
        time: CMTime(seconds: now - startWall, preferredTimescale: 600),
        now: now,
        captureWall: now - 1.0 - Double(index % 3) / 100
      )
    }
    #expect(start.captured == nil)
    // The eleventh goes out first: its stamp less its own age.
    start.sent(time: CMTime(seconds: 10.0 / 30, preferredTimescale: 600), startWall: startWall)
    let captured = start.captured
    #expect(captured != nil)
    #expect(abs((captured ?? 0) - (startWall + 10.0 / 30 - 1.01)) < 0.000_001)
    // Settled: nothing later moves it.
    start.sent(time: CMTime(seconds: 1, preferredTimescale: 600), startWall: startWall)
    start.submitted(time: CMTime(seconds: 2, preferredTimescale: 600), now: startWall + 2, captureWall: startWall)
    #expect(start.captured == captured)
  }

  @Test("A repeat borrows the last age, a picture with none goes as sent, and a stepped clock is ignored")
  func agesBorrowedOrNone() {
    var none = StreamTimelineStart()
    none.submitted(time: .zero, now: 50, captureWall: nil)
    none.sent(time: .zero, startWall: 50)
    #expect(none.captured == 50)

    var borrowed = StreamTimelineStart()
    borrowed.submitted(time: .zero, now: 50, captureWall: 49.2)
    borrowed.submitted(time: CMTime(value: 1, timescale: 30), now: 50.033, captureWall: nil)
    // A capture in the future, or ten seconds old, is a clock that stepped: the age before stands.
    borrowed.submitted(time: CMTime(value: 2, timescale: 30), now: 50.066, captureWall: 51)
    borrowed.submitted(time: CMTime(value: 3, timescale: 30), now: 50.1, captureWall: 30)
    // Sent at a stamp it never saw submitted: the last age.
    borrowed.sent(time: CMTime(value: 3, timescale: 30), startWall: 50)
    #expect(abs((borrowed.captured ?? 0) - (50 + 0.1 - 0.8)) < 0.000_001)

    var invalid = StreamTimelineStart()
    invalid.submitted(time: .invalid, now: 50, captureWall: 49)
    invalid.sent(time: .invalid, startWall: 50)
    #expect(invalid.captured == nil)
  }

  @Test("Only the last half minute of pictures waiting for the publish is held")
  func holdsABoundedWait() {
    var start = StreamTimelineStart()
    let count = StreamTimelineStart.maximumHeld + 30
    for index in 0 ..< count {
      start.submitted(
        time: CMTime(value: CMTimeValue(index), timescale: 30),
        now: Double(index) / 30,
        captureWall: Double(index) / 30 - (index == 0 ? 0.5 : 1)
      )
    }
    // The very first picture's own age has gone; the last measured stands in for it.
    start.sent(time: .zero, startWall: 0)
    #expect(start.captured == -1)
  }

  @Test("A streamer that has sent nothing has no live start")
  func streamerBeforeAnything() {
    let streamer = ProgramStreamer(telemetry: PipelineTelemetry(), converter: PixelConverter())
    #expect(streamer.liveTimelineStart == nil)
    streamer.stop()
    #expect(streamer.liveTimelineStart == nil)
  }
}
