import Foundation
@testable import SpeedyCore
import Testing

private let start = Date(timeIntervalSince1970: 1_800_000_000)

@Suite("Speed board")
struct SpeedBoardTests {
  @Test
  func emptySidesShowTheDash() {
    let board = SpeedBoard()
    #expect(board.text(.pitch, at: start) == "--")
    #expect(board.text(.exit, at: start) == "--")
  }

  @Test
  func eachSideExpiresFiveSecondsAfterItsOwnReading() {
    var board = SpeedBoard()
    board.receive(pitch: 56, exit: 0, at: start)
    board.receive(pitch: 0, exit: 52, at: start + 2)
    #expect(board.text(.pitch, at: start + 4.999) == "56")
    #expect(board.text(.pitch, at: start + 5) == "--")
    #expect(board.text(.exit, at: start + 5) == "52")
    #expect(board.text(.exit, at: start + 6.999) == "52")
    #expect(board.text(.exit, at: start + 7) == "--")
  }

  @Test
  func aZeroSideLeavesTheOtherAlone() {
    var board = SpeedBoard()
    board.receive(pitch: 56, exit: 52, at: start)
    board.receive(pitch: 61, exit: 0, at: start + 1)
    #expect(board.text(.pitch, at: start + 1) == "61")
    #expect(board.text(.exit, at: start + 1) == "52")
    board.receive(pitch: 0, exit: 0, at: start + 4)
    #expect(board.text(.exit, at: start + 5) == "--", "a reading of nothing does not refresh a side")
  }

  @Test
  func clearEmptiesBothSides() {
    var board = SpeedBoard()
    board.receive(pitch: 56, exit: 52, at: start)
    board.clear()
    #expect(board == SpeedBoard())
  }
}

@Suite("Phrase")
struct PhraseTests {
  @Test
  func pitchAndExitJoinWithAnd() {
    #expect(Phrase.clips(pitch: 56, exit: 52) == [ "n56-and", "word-and", "n52-exit", "word-exit" ])
    #expect(Phrase.words(Phrase.clips(pitch: 56, exit: 52)) == "56 and 52 exit")
  }

  @Test
  func aPitchAloneIsItsFallingTake() {
    #expect(Phrase.clips(pitch: 56, exit: nil) == [ "n56-final" ])
    #expect(Phrase.words([ "n56-final" ]) == "56")
  }

  @Test
  func anExitAloneEndsInExit() {
    #expect(Phrase.clips(pitch: nil, exit: 53) == [ "n53-exit", "word-exit" ])
    #expect(Phrase.words(Phrase.clips(pitch: nil, exit: 53)) == "53 exit")
  }

  @Test
  func onlyTwentyToNinetyNineIsSpoken() {
    #expect(Phrase.clips(pitch: 19, exit: nil).isEmpty)
    #expect(Phrase.clips(pitch: 20, exit: nil) == [ "n20-final" ])
    #expect(Phrase.clips(pitch: 99, exit: nil) == [ "n99-final" ])
    #expect(Phrase.clips(pitch: 100, exit: nil).isEmpty)
    #expect(Phrase.clips(pitch: nil, exit: nil).isEmpty)
    #expect(Phrase.clips(pitch: 104, exit: 52) == [ "n52-exit", "word-exit" ])
    #expect(Phrase.clips(pitch: 56, exit: 110) == [ "n56-final" ])
    #expect(Phrase.clips(pitch: 12, exit: 101).isEmpty)
  }
}

@Suite("Announcer")
@MainActor
struct AnnouncerTests {
  @MainActor
  final class Bench {
    let scheduler = StepScheduler()
    var said: [String] = []
    lazy var announcer = Announcer(audioOn: true, scheduler: scheduler) { [unowned self] clips in
      self.said.append(Phrase.words(clips))
    }
  }

  @Test
  func aPitchIsSaidWhenItsWindowCloses() {
    let bench = Bench()
    bench.announcer.receive(pitch: 56, exit: 0)
    bench.scheduler.advance(by: .milliseconds(249))
    #expect(bench.said.isEmpty)
    bench.scheduler.advance(by: .milliseconds(1))
    #expect(bench.said == [ "56" ])
  }

  @Test
  func anExitInsideTheWindowJoinsThePitch() {
    let bench = Bench()
    bench.announcer.receive(pitch: 56, exit: 0)
    bench.scheduler.advance(by: .milliseconds(249))
    bench.announcer.receive(pitch: 0, exit: 52)
    bench.scheduler.advance(by: .seconds(1))
    #expect(bench.said == [ "56 and 52 exit" ])
  }

  @Test
  func anExitAfterTheWindowIsSaidOnItsOwn() {
    let bench = Bench()
    bench.announcer.receive(pitch: 61, exit: 0)
    bench.scheduler.advance(by: .milliseconds(251))
    bench.announcer.receive(pitch: 0, exit: 48)
    #expect(bench.said == [ "61", "48 exit" ])
  }

  @Test
  func aReadingWithBothIsSaidAtOnce() {
    let bench = Bench()
    bench.announcer.receive(pitch: 56, exit: 52)
    #expect(bench.said == [ "56 and 52 exit" ])
    #expect(bench.scheduler.pending == 0)
  }

  @Test
  func aHitFrameAfterItsPitchSaysThePitchOnce() {
    let bench = Bench()
    bench.announcer.receive(pitch: 56, exit: 0)
    bench.scheduler.advance(by: .milliseconds(100))
    bench.announcer.receive(pitch: 56, exit: 52)
    bench.scheduler.advance(by: .seconds(1))
    #expect(bench.said == [ "56 and 52 exit" ])
  }

  @Test
  func aSecondPitchSaysTheFirstAlone() {
    let bench = Bench()
    bench.announcer.receive(pitch: 56, exit: 0)
    bench.announcer.receive(pitch: 62, exit: 0)
    #expect(bench.said == [ "56" ])
    bench.scheduler.advance(by: .milliseconds(250))
    #expect(bench.said == [ "56", "62" ])
  }

  @Test
  func anExitWithNothingWaitingIsSaidAtOnce() {
    let bench = Bench()
    bench.announcer.receive(pitch: 0, exit: 53)
    #expect(bench.said == [ "53 exit" ])
  }

  @Test
  func aReadingOfNothingSaysNothing() {
    let bench = Bench()
    bench.announcer.receive(pitch: 0, exit: 0)
    bench.scheduler.advance(by: .seconds(1))
    #expect(bench.said.isEmpty)
  }

  @Test
  func anUnspeakablePitchIsSilentAndAnExitStillSpeaks() {
    let bench = Bench()
    bench.announcer.receive(pitch: 104, exit: 0)
    bench.scheduler.advance(by: .seconds(1))
    #expect(bench.said.isEmpty)
    bench.announcer.receive(pitch: 104, exit: 0)
    bench.announcer.receive(pitch: 0, exit: 52)
    #expect(bench.said == [ "52 exit" ])
  }

  @Test
  func audioOffIgnoresReadingsAndDropsTheWaitingPitch() {
    let bench = Bench()
    bench.announcer.receive(pitch: 56, exit: 0)
    bench.announcer.audioOn = false
    bench.scheduler.advance(by: .seconds(1))
    bench.announcer.receive(pitch: 70, exit: 0)
    bench.announcer.receive(pitch: 0, exit: 52)
    bench.scheduler.advance(by: .seconds(1))
    #expect(bench.said.isEmpty)
    bench.announcer.audioOn = true
    bench.announcer.receive(pitch: 0, exit: 52)
    #expect(bench.said == [ "52 exit" ])
  }

  @Test
  func resetForgetsTheWaitingPitch() {
    let bench = Bench()
    bench.announcer.receive(pitch: 56, exit: 0)
    bench.announcer.reset()
    bench.scheduler.advance(by: .seconds(1))
    #expect(bench.said.isEmpty)
  }

  @Test
  func theAppSchedulerRunsWorkAndCancels() async throws {
    let scheduler = TaskScheduler()
    final class Ran { var names: [String] = [] }
    let ran = Ran()
    _ = scheduler.after(.milliseconds(10)) { ran.names.append("kept") }
    let cancelled = scheduler.after(.milliseconds(10)) { ran.names.append("cancelled") }
    cancelled.cancel()
    try await Task.sleep(for: .milliseconds(200))
    #expect(ran.names == [ "kept" ])
  }
}

@Suite("Readout metrics")
struct ReadoutMetricsTests {
  @Test
  func theLineSitsFifteenPercentBelowCenter() {
    let metrics = ReadoutMetrics(width: 400, height: 800, unitWidth88: 1.2)
    #expect(metrics.lineY == 520)
    #expect(metrics.gap == 24)
  }

  @Test
  func eightyEightFillsEightyPercentForPitchAndSixtyForExit() {
    let metrics = ReadoutMetrics(width: 400, height: 800, unitWidth88: 1.25)
    #expect(metrics.pitchSize == 256)
    #expect(metrics.pitchSize * 1.25 == 320)
    #expect(metrics.exitSize == 192)
    #expect(metrics.exitSize * 1.25 == 240)
  }

  @Test
  func aWideNumberShrinksToNinetyPercent() {
    let metrics = ReadoutMetrics(width: 400, height: 800, unitWidth88: 1.25)
    #expect(metrics.fitted(size: 256, textWidthAtSize: 320) == 256)
    #expect(metrics.fitted(size: 256, textWidthAtSize: 720) == 128)
  }

  @Test
  func noMeasurementMeansNoSize() {
    #expect(ReadoutMetrics.pitchSize(unitWidth88: 0, width: 400) == 0)
  }
}

@Suite("Audio setting")
struct AudioSettingTests {
  @Test
  func onByDefaultAndRemembered() {
    let defaults = freshDefaults()
    let setting = AudioSetting(defaults: defaults)
    #expect(setting.isOn)
    setting.isOn = false
    #expect(!AudioSetting(defaults: defaults).isOn)
    #expect(defaults.bool(forKey: "app.teamstation.speedy.audio") == false)
  }
}

@Suite("Radar status")
struct RadarStatusTests {
  @Test
  func bluetoothOffComesFirst() {
    #expect(RadarStatus(power: .off).text == "Bluetooth off")
    #expect(RadarStatus(serial: "ADFA1", link: .connected, power: .off).text == "Bluetooth off")
  }

  @Test
  func nothingPaired() {
    let status = RadarStatus(power: .on)
    #expect(status.text == "No radar paired")
    #expect(!status.isPaired)
    #expect(RadarStatus(power: .unknown).text == "No radar paired")
    #expect(RadarStatus(serial: "ADFA1", link: nil, power: .on).text == "No radar paired")
  }

  @Test
  func eachLink() {
    func text(_ link: RadarStatus.Link) -> String { RadarStatus(serial: "ADFA1", link: link, power: .on).text }
    #expect(text(.off) == "Off")
    #expect(text(.searching) == "Searching")
    #expect(text(.connecting) == "Connecting")
    #expect(text(.connected) == "Connected")
    #expect(text(.bluetoothOff) == "Bluetooth off")
    #expect(RadarStatus(serial: "ADFA1", link: .connected).isPaired)
  }
}

@Suite("Control links")
struct ControlLinkTests {
  private func parse(_ link: String) -> ControlCommand? { ControlCommand.parse(URL(string: link)!) }

  @Test
  func eachCommandParses() {
    #expect(parse("tsspeedy://test/radar-feed?pitch=56&exit=0") == .radarFeed(pitch: 56, exit: 0))
    #expect(parse("TSSPEEDY://test/radar-feed?exit=53") == .radarFeed(pitch: 0, exit: 53))
    #expect(parse("tsspeedy://test/radar-feed?pitch=-3") == .radarFeed(pitch: 0, exit: 0))
    #expect(parse("tsspeedy://test/radar-sequence?pitch=56&exit=52&gapMs=100") == .radarSequence(pitch: 56, exit: 52, gapMs: 100))
    #expect(parse("tsspeedy://test/reset") == .reset)
  }

  @Test
  func anythingElseIsNil() {
    #expect(parse("tsspeedy://test/radar-sequence?pitch=56&exit=52") == nil)
    #expect(parse("tsspeedy://test/radar-sequence?pitch=56&gapMs=-1") == nil)
    #expect(parse("tsspeedy://test/unknown") == nil)
    #expect(parse("tsspeedy://other/reset") == nil)
    #expect(parse("tscameraman://test/reset") == nil)
    #expect(parse("tsspeedy:reset") == nil)
  }

  @Test
  func uiTestLaunchArguments() {
    #expect(LaunchFlags.isUITest([ "app", "-uiTest", "true" ]))
    #expect(LaunchFlags.isUITest([ "app", "-uiTest", "YES" ]))
    #expect(LaunchFlags.isUITest([ "app", "-uiTest", "1" ]))
    #expect(!LaunchFlags.isUITest([ "app", "-uiTest", "false" ]))
    #expect(!LaunchFlags.isUITest([ "app", "-uiTest" ]))
    #expect(!LaunchFlags.isUITest([ "app" ]))
  }
}
