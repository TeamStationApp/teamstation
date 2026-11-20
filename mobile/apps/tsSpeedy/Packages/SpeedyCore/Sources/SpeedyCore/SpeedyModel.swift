import Foundation
import Observation

/// Everything TS Speedy's two screens show and do.
@MainActor
@Observable
public final class SpeedyModel {
  public private(set) var board = SpeedBoard()
  public private(set) var radarStatus: RadarStatus
  public private(set) var audioOn: Bool
  /// The last phrase handed to the player, as words, or "muted" for a reading heard with audio off.
  /// Kept only for UI tests, which cannot hear.
  public private(set) var speechLog = ""
  public var showingSettings = false
  public let uiTest: Bool

  @ObservationIgnored private let radar: SpeedyRadar
  @ObservationIgnored private let player: PhrasePlayer
  @ObservationIgnored private let audioSetting: AudioSetting
  @ObservationIgnored private let scheduler: SpeedyScheduler
  @ObservationIgnored private let clock: () -> Date
  @ObservationIgnored private var announcer: Announcer!
  @ObservationIgnored private var sequence: SpeedyTimer?
  public private(set) var isPaused = false

  public init(
    radar: SpeedyRadar,
    player: PhrasePlayer,
    audioSetting: AudioSetting = AudioSetting(),
    scheduler: SpeedyScheduler = TaskScheduler(),
    clock: @escaping () -> Date = Date.init,
    uiTest: Bool = false
  ) {
    self.radar = radar
    self.player = player
    self.audioSetting = audioSetting
    self.scheduler = scheduler
    self.clock = clock
    self.uiTest = uiTest
    radarStatus = radar.status
    audioOn = audioSetting.isOn
    announcer = Announcer(audioOn: audioOn, scheduler: scheduler, now: clock) { [weak self] clips in
      self?.speak(clips)
    }
    radar.onChange = { [weak self] in self?.radarChanged() }
    radar.onSpeeds = { [weak self] pitch, exit in self?.receive(pitch: pitch, exit: exit) }
  }

  public func start() {
    radar.start()
    radarChanged()
  }

  /// The app left the screen: the radar is let go, so another phone can take it, nothing more is
  /// said, and a reading still on its way is dropped. The audio setting is kept.
  public func pause() {
    isPaused = true
    radar.pause()
    sequence?.cancel()
    announcer.reset()
    player.stop()
  }

  public func resume() {
    guard isPaused else { return }
    isPaused = false
    radar.resume()
    radarChanged()
  }

  // MARK: The readout

  public func pitchText(at date: Date) -> String { board.text(.pitch, at: date) }
  public func exitText(at date: Date) -> String { board.text(.exit, at: date) }
  public var now: Date { clock() }
  public var showsPairHint: Bool { !radarStatus.isPaired }

  /// A reading from the radar: on screen at once, and to the announcer.
  public func receive(pitch: Int, exit: Int) {
    guard !isPaused, pitch > 0 || exit > 0 else { return }
    board.receive(pitch: pitch, exit: exit, at: clock())
    if audioOn {
      announcer.receive(pitch: pitch, exit: exit)
    } else if uiTest {
      speechLog = "muted"
    }
  }

  public func setAudio(_ on: Bool) {
    audioOn = on
    audioSetting.isOn = on
    announcer.audioOn = on
    if !on { player.stop() }
  }

  public func toggleAudio() { setAudio(!audioOn) }

  // MARK: Settings

  public func openSettings() { showingSettings = true }

  public func closeSettings() {
    radar.stopPairing()
    showingSettings = false
  }

  public func startPairing() { radar.startPairing() }
  public func stopPairing() { radar.stopPairing() }

  public func pair(_ name: String) {
    radar.pair(name)
    radar.stopPairing()
  }

  public func unpair() { radar.unpair() }

  // MARK: UI tests

  /// Acts on a `tsspeedy://test/…` link when launched for a UI test; ignores every link otherwise.
  @discardableResult
  public func handle(_ url: URL) -> Bool {
    guard uiTest, let command = ControlCommand.parse(url) else { return false }
    switch command {
    case let .radarFeed(pitch, exit):
      receive(pitch: pitch, exit: exit)
    case let .radarSequence(pitch, exit, gapMs):
      sequence?.cancel()
      receive(pitch: pitch, exit: 0)
      sequence = scheduler.after(.milliseconds(gapMs)) { [weak self] in
        self?.receive(pitch: 0, exit: exit)
      }
    case .reset:
      sequence?.cancel()
      sequence = nil
      board.clear()
      announcer.reset()
      player.stop()
      speechLog = ""
    }
    return true
  }

  // MARK: Private

  private func speak(_ clips: [String]) {
    if uiTest { speechLog = Phrase.words(clips) }
    player.play(clips)
  }

  private func radarChanged() {
    radarStatus = radar.status
  }
}
