import Foundation
@testable import SpeedyCore
import Testing

@Suite("Speedy model")
@MainActor
struct SpeedyModelTests {
  @MainActor
  final class Bench {
    let radar = FakeSpeedyRadar()
    let player = RecordingPlayer()
    let scheduler = StepScheduler()
    let defaults = freshDefaults()
    var clock = Date(timeIntervalSince1970: 1_800_000_000)

    func model(uiTest: Bool = true) -> SpeedyModel {
      SpeedyModel(
        radar: radar,
        player: player,
        audioSetting: AudioSetting(defaults: defaults),
        scheduler: scheduler,
        clock: { [unowned self] in self.clock },
        uiTest: uiTest
      )
    }
  }

  @Test
  func startStartsTheRadarAndReadsItsStatus() {
    let bench = Bench()
    let model = bench.model()
    bench.radar.status = RadarStatus(serial: "ADFA1", link: .connected, power: .on)
    model.start()
    #expect(bench.radar.calls == [ "start" ])
    #expect(model.radarStatus.text == "Connected")
    #expect(!model.showsPairHint)
  }

  @Test
  func theHintShowsUntilARadarIsPaired() {
    let bench = Bench()
    let model = bench.model()
    #expect(model.showsPairHint)
    bench.radar.status = RadarStatus(serial: "ADFA1", link: .searching, power: .on)
    #expect(!model.showsPairHint)
  }

  @Test
  func aReadingShowsAtOnceAndIsSpokenAfterTheHold() {
    let bench = Bench()
    let model = bench.model()
    bench.radar.reading(pitch: 56, exit: 0)
    #expect(model.pitchText(at: bench.clock) == "56")
    #expect(model.exitText(at: bench.clock) == "--")
    #expect(bench.player.played.isEmpty)
    bench.scheduler.advance(by: .milliseconds(250))
    #expect(bench.player.played == [ [ "n56-final" ] ])
    #expect(model.speechLog == "56")
    #expect(model.pitchText(at: bench.clock + 5) == "--")
    #expect(model.now == bench.clock)
  }

  @Test
  func aReadingOfNothingIsIgnored() {
    let bench = Bench()
    let model = bench.model()
    bench.radar.reading(pitch: 0, exit: 0)
    #expect(model.board == SpeedBoard())
  }

  @Test
  func audioOffShowsButDoesNotSpeakAndIsRemembered() {
    let bench = Bench()
    let model = bench.model()
    #expect(model.audioOn)
    model.toggleAudio()
    #expect(!model.audioOn)
    #expect(bench.player.stops == 1)
    bench.radar.reading(pitch: 70, exit: 0)
    bench.scheduler.advance(by: .seconds(1))
    #expect(model.pitchText(at: bench.clock) == "70")
    #expect(bench.player.played.isEmpty)
    #expect(model.speechLog == "muted")
    #expect(!bench.model().audioOn, "a relaunch keeps audio off")
    model.toggleAudio()
    #expect(model.audioOn)
  }

  @Test
  func outsideAUITestTheSpeechLogStaysEmpty() {
    let bench = Bench()
    let model = bench.model(uiTest: false)
    bench.radar.reading(pitch: 0, exit: 53)
    #expect(bench.player.played == [ [ "n53-exit", "word-exit" ] ])
    #expect(model.speechLog == "")
    model.setAudio(false)
    bench.radar.reading(pitch: 0, exit: 53)
    #expect(model.speechLog == "")
  }

  @Test
  func settingsPairsAndUnpairsThroughTheRadar() {
    let bench = Bench()
    let model = bench.model()
    model.openSettings()
    #expect(model.showingSettings)
    model.startPairing()
    model.pair("ADFA0000001")
    model.stopPairing()
    model.unpair()
    model.closeSettings()
    #expect(!model.showingSettings)
    #expect(bench.radar.calls == [ "startPairing", "pair ADFA0000001", "stopPairing", "stopPairing", "unpair", "stopPairing" ])
  }

  @Test
  func feedLinksDeliverReadings() {
    let bench = Bench()
    let model = bench.model()
    #expect(model.handle(URL(string: "tsspeedy://test/radar-feed?pitch=0&exit=53")!))
    #expect(model.exitText(at: bench.clock) == "53")
    #expect(model.speechLog == "53 exit")
  }

  @Test
  func aSequenceInsideTheHoldIsOnePhrase() {
    let bench = Bench()
    let model = bench.model()
    model.handle(URL(string: "tsspeedy://test/radar-sequence?pitch=56&exit=52&gapMs=100")!)
    #expect(model.pitchText(at: bench.clock) == "56")
    bench.scheduler.advance(by: .milliseconds(100))
    #expect(model.exitText(at: bench.clock) == "52")
    bench.scheduler.advance(by: .seconds(1))
    #expect(bench.player.played == [ [ "n56-and", "word-and", "n52-exit", "word-exit" ] ])
    #expect(model.speechLog == "56 and 52 exit")
  }

  @Test
  func aSequenceOutsideTheHoldIsTwoPhrases() {
    let bench = Bench()
    let model = bench.model()
    model.handle(URL(string: "tsspeedy://test/radar-sequence?pitch=61&exit=48&gapMs=600")!)
    bench.scheduler.advance(by: .milliseconds(600))
    #expect(bench.player.played == [ [ "n61-final" ], [ "n48-exit", "word-exit" ] ])
    #expect(model.speechLog == "48 exit")
  }

  @Test
  func resetClearsEverything() {
    let bench = Bench()
    let model = bench.model()
    model.handle(URL(string: "tsspeedy://test/radar-sequence?pitch=56&exit=52&gapMs=100")!)
    model.handle(URL(string: "tsspeedy://test/radar-feed?pitch=0&exit=40")!)
    model.handle(URL(string: "tsspeedy://test/reset")!)
    bench.scheduler.advance(by: .seconds(1))
    #expect(model.board == SpeedBoard())
    #expect(model.speechLog == "")
    #expect(bench.player.stops == 1)
    #expect(bench.player.played == [ [ "n56-and", "word-and", "n40-exit", "word-exit" ] ])
  }

  @Test
  func offTheScreenTheRadarIsLetGoAndNothingIsSaid() {
    let bench = Bench()
    let model = bench.model()
    model.resume()
    #expect(bench.radar.calls.isEmpty, "a resume with nothing paused does nothing")
    bench.radar.reading(pitch: 56, exit: 0)
    model.pause()
    #expect(model.isPaused)
    #expect(bench.radar.calls == [ "pause" ])
    #expect(bench.player.stops == 1)
    bench.scheduler.advance(by: .seconds(1))
    bench.radar.reading(pitch: 0, exit: 53)
    #expect(bench.player.played.isEmpty, "nothing is said while away")
    #expect(model.audioOn, "the audio setting is kept")
    model.resume()
    #expect(!model.isPaused)
    #expect(bench.radar.calls == [ "pause", "resume" ])
    bench.radar.reading(pitch: 0, exit: 53)
    #expect(bench.player.played == [ [ "n53-exit", "word-exit" ] ])
  }

  @Test
  func theDefaultClockIsTheWallClock() {
    let model = SpeedyModel(radar: FakeSpeedyRadar(), player: RecordingPlayer(), audioSetting: AudioSetting(defaults: freshDefaults()))
    #expect(abs(model.now.timeIntervalSinceNow) < 5)
    #expect(!model.uiTest)
  }

  @Test
  func linksAreIgnoredOutsideAUITest() {
    let bench = Bench()
    let model = bench.model(uiTest: false)
    #expect(!model.handle(URL(string: "tsspeedy://test/radar-feed?pitch=56")!))
    #expect(model.board == SpeedBoard())
    #expect(!bench.model().handle(URL(string: "tsspeedy://test/nope")!))
  }
}
