import Foundation
import Testing
import DirectorCore
import DirectorSources

@Suite("Frame latency gate")
struct FrameLatencyGateTests {
  private let now = WallClock(seconds: 10_000)

  @Test("Admits everything when neither cap is on")
  func noCapsAdmitEverything() {
    let gate = FrameLatencyGate()
    let ancient = WallClock(seconds: 9_000)
    #expect(gate.admitsForDisplay(captured: ancient, now: now))
    #expect(gate.admitsForDisk(captured: ancient, now: now))
  }

  @Test("Refuses a picture older than the display cap and keeps a fresh one")
  func displayCap() {
    let gate = FrameLatencyGate(caps: .init(displaySeconds: 0.5))
    #expect(gate.admitsForDisplay(captured: WallClock(seconds: 9_999.8), now: now))
    #expect(!gate.admitsForDisplay(captured: WallClock(seconds: 9_998), now: now))
  }

  /// The point of having two caps. A monitor is worthless showing action that has happened; the
  /// recording is watched afterwards, where the same picture is simply a picture.
  @Test("A picture too old to show is still young enough to keep")
  func lateForDisplayStillReachesDisk() {
    let gate = FrameLatencyGate(caps: .init(displaySeconds: 0.5, diskSeconds: 10))
    let twoSecondsOld = WallClock(seconds: 9_998)
    #expect(!gate.admitsForDisplay(captured: twoSecondsOld, now: now))
    #expect(gate.admitsForDisk(captured: twoSecondsOld, now: now))
  }

  @Test("Refuses a picture older than the disk cap")
  func diskCap() {
    let gate = FrameLatencyGate(caps: .init(diskSeconds: 10))
    #expect(gate.admitsForDisk(captured: WallClock(seconds: 9_995), now: now))
    #expect(!gate.admitsForDisk(captured: WallClock(seconds: 9_980), now: now))
  }

  /// A camera whose clock has not been anchored yet reports no capture time at all. Refusing on an
  /// unknown age would blank it entirely, which is worse than showing a picture of unknown age.
  @Test("Admits a picture whose capture time is unknown")
  func unknownCaptureTimeIsAdmitted() {
    let gate = FrameLatencyGate(caps: .init(displaySeconds: 0.1, diskSeconds: 0.1))
    #expect(gate.admitsForDisplay(captured: nil, now: now))
    #expect(gate.admitsForDisk(captured: nil, now: now))
  }

  /// A camera a few milliseconds ahead of us is ordinary; reading that as a negative age would
  /// make the picture look infinitely fresh, which is the same bug with the sign flipped.
  @Test("A capture time slightly in the future is treated as brand new, not as an error")
  func futureCaptureIsClampedToZero() {
    #expect(FrameLatencyGate.age(captured: WallClock(seconds: 10_000.05), now: now) == 0)
    #expect(FrameLatencyGate.age(captured: nil, now: now) == nil)
  }

  @Test("Caps come from the operator's settings, and are off when switched off")
  func capsFromConfig() {
    var config = AppConfig()
    // A new install has both on since D7: 1 s and 20 s.
    #expect(FrameLatencyGate.Caps(config: config).displaySeconds == 1)
    #expect(FrameLatencyGate.Caps(config: config).diskSeconds == 20)
    config.displayLatencyCapEnabled = false
    config.diskLatencyCapEnabled = false
    #expect(FrameLatencyGate.Caps(config: config).displaySeconds == nil)
    #expect(FrameLatencyGate.Caps(config: config).diskSeconds == nil)

    config.displayLatencyCapEnabled = true
    config.displayLatencyCapMilliseconds = 400
    config.diskLatencyCapEnabled = true
    config.diskLatencyCapMilliseconds = 8_000
    let caps = FrameLatencyGate.Caps(config: config)
    #expect(caps.displaySeconds == 0.4)
    #expect(caps.diskSeconds == 8)
  }

  /// The disk cap is meant to be the generous one, and its default should already be well clear of
  /// the display cap's ceiling so the two do not fight out of the box.
  @Test("The disk default is more generous than the display maximum")
  func defaultsDoNotFight() {
    #expect(AppConfig.diskLatencyCapDefaultMilliseconds > AppConfig.displayLatencyCapMaximumMilliseconds)
  }
}
