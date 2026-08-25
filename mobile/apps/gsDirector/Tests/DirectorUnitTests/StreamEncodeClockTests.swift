import CoreMedia
import Foundation
import DirectorPipeline
import Testing

@Suite("Stream encode clock")
struct StreamEncodeClockTests {
  @Test("Steady live PTS follows wall clock")
  func steadyLiveIsMonotonic() {
    var clock = StreamEncodeClock(frameRate: 30, gopSeconds: 2)
    let start: CFAbsoluteTime = 1_000
    var previous = CMTime.negativeInfinity
    for index in 0 ..< 90 {
      let now = start + Double(index) / 30.0
      let time = clock.nextPresentationTime(source: CMTime(value: CMTimeValue(index), timescale: 30), now: now)
      if previous.isNumeric {
        #expect(time > previous)
      }
      previous = time
    }
    #expect(abs(previous.seconds - 89.0 / 30.0) < 0.001)
  }

  @Test("A replay rewind still advances encode PTS with wall clock")
  func replayRewindStaysMonotonic() {
    var clock = StreamEncodeClock(frameRate: 30, gopSeconds: 2)
    let live = CMTime(seconds: 60, preferredTimescale: 600)
    _ = clock.nextPresentationTime(source: live, now: 10)
    let afterLive = clock.lastTime
    let replay = CMTime(seconds: 50, preferredTimescale: 600)
    let time = clock.nextPresentationTime(source: replay, now: 10 + 1.0 / 30.0)
    #expect(time > afterLive)
  }

  @Test("Dropped frames catch up to wall clock instead of lagging")
  func droppedFramesCatchUpToWall() {
    var clock = StreamEncodeClock(frameRate: 30, gopSeconds: 2)
    _ = clock.nextPresentationTime(source: .zero, now: 5)
    // 6 seconds of dropped encodes: PTS must jump to wall, not step 1/30.
    let caught = clock.nextPresentationTime(source: .zero, now: 11)
    #expect(abs(caught.seconds - 6) < 0.05)
  }

  @Test("A camera-cut clock that clamps to zero still steps forward")
  func cameraCutZeroClamp() {
    var clock = StreamEncodeClock(frameRate: 30, gopSeconds: 2)
    let first = clock.nextPresentationTime(
      source: CMTime(seconds: 1_000, preferredTimescale: 600),
      now: 20
    )
    #expect(first.seconds == 0)
    let second = clock.nextPresentationTime(
      source: CMTime(seconds: 10, preferredTimescale: 600),
      now: 20 + 1.0 / 30.0
    )
    #expect(second > first)
  }

  @Test("GOP cadence forces a keyframe every gopSeconds")
  func gopCadence() {
    var clock = StreamEncodeClock(frameRate: 30, gopSeconds: 2)
    let now0: CFAbsoluteTime = 1_000
    var lastKey = CMTime.zero
    var forced = 0
    for index in 0 ..< 121 {
      let now = now0 + Double(index) / 30.0
      let time = clock.nextPresentationTime(source: CMTime(value: CMTimeValue(index), timescale: 30), now: now)
      if clock.shouldForceKey(at: time, now: now) {
        forced += 1
        clock.noteKeyframe(at: time, now: now)
        if forced > 1 {
          #expect(abs(time.seconds - lastKey.seconds - 2) < 1.0 / 30.0 + 0.001)
        }
        lastKey = time
      }
    }
    #expect(forced == 3)
  }

  @Test("requestKeyframe forces the next submitted frame")
  func requestKeyframeMidGOP() {
    var clock = StreamEncodeClock(frameRate: 30, gopSeconds: 2)
    let first = clock.nextPresentationTime(source: .zero, now: 10)
    clock.noteKeyframe(at: first, now: 10)
    let mid = clock.nextPresentationTime(source: CMTime(value: 15, timescale: 30), now: 10.5)
    let midGOP = clock.shouldForceKey(at: mid, now: 10.5)
    #expect(!midGOP)
    clock.requestKeyframe()
    let requested = clock.shouldForceKey(at: mid, now: 10.5)
    #expect(requested)
  }

  @Test("Wall-clock fallback forces an IDR when PTS stalls")
  func wallClockFallback() {
    var clock = StreamEncodeClock(frameRate: 30, gopSeconds: 2)
    let time = clock.nextPresentationTime(source: .zero, now: 50)
    clock.noteKeyframe(at: time, now: 50)
    let before = clock.shouldForceKey(at: time, now: 51)
    let after = clock.shouldForceKey(at: time, now: 52)
    #expect(!before)
    #expect(after)
  }

  @Test("Frame-count GOP cap matches frameRate times gopSeconds")
  func maxKeyFrameInterval() {
    let clock = StreamEncodeClock(frameRate: 30, gopSeconds: 2)
    #expect(clock.maxKeyFrameInterval == 60)
  }

  @Test("Audio timeline matches video wall clock")
  func audioMatchesVideoWall() {
    var clock = StreamEncodeClock(frameRate: 30, gopSeconds: 2)
    _ = clock.nextPresentationTime(source: .zero, now: 3)
    let audio = clock.timeNow(now: 5)
    #expect(abs(audio.seconds - 2) < 0.001)
  }

  @Test("AVCC IDR NAL is recognised and a P-frame is not")
  func payloadContainsIDR() {
    #expect(ProgramStreamer.payloadContainsIDR(Data([ 0, 0, 0, 1, 0x65 ])))
    #expect(!ProgramStreamer.payloadContainsIDR(Data([ 0, 0, 0, 1, 0x41 ])))
    #expect(!ProgramStreamer.payloadContainsIDR(Data()))
  }
}
