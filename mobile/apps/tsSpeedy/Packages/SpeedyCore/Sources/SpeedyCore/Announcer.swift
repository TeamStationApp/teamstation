import Foundation

/// Something the announcer can cancel: its pending pitch's timer.
@MainActor
public protocol SpeedyTimer: AnyObject {
  func cancel()
}

/// Runs `work` on the main actor after `delay`. The app's default is a `Task`; tests step a clock.
@MainActor
public protocol SpeedyScheduler: AnyObject {
  func after(_ delay: Duration, _ work: @escaping @MainActor () -> Void) -> SpeedyTimer
}

/// Decides what to say for each reading.
///
/// A pitch waits `hold` for an exit to follow it. An exit inside that window joins it ("56 and 52
/// exit"); otherwise the pitch is said alone when the window closes ("56"), and a later exit is said
/// on its own ("52 exit"). A reading that carries both says them together at once: in Pitch & Hit
/// the hit's frame repeats the pitch it follows, so a pitch still waiting is the same pitch and is
/// not said twice. Nor is a pitch already said alone: a hit frame that comes after the hold, while
/// that pitch is still on the board, says only its exit. With audio off, readings are ignored.
@MainActor
public final class Announcer {
  /// How long a pitch waits for its exit.
  public static let hold: Duration = .milliseconds(250)

  public var audioOn: Bool {
    didSet {
      if !audioOn { dropPending() }
    }
  }

  private let scheduler: SpeedyScheduler
  private let speak: @MainActor ([String]) -> Void
  private let now: () -> Date
  private var pendingPitch: Int?
  private var timer: SpeedyTimer?
  /// The pitch last said, and when, so a hit frame repeating it does not say it again.
  private var saidPitch: (mph: Int, at: Date)?

  public init(
    audioOn: Bool,
    scheduler: SpeedyScheduler,
    now: @escaping () -> Date = Date.init,
    speak: @escaping @MainActor ([String]) -> Void
  ) {
    self.audioOn = audioOn
    self.scheduler = scheduler
    self.now = now
    self.speak = speak
  }

  public func receive(pitch: Int, exit: Int) {
    guard audioOn else { return }
    switch (pitch > 0, exit > 0) {
    case (true, true):
      // A waiting pitch is this frame's pitch, new and unsaid; with none waiting, the frame may
      // repeat a pitch already said.
      let isRepeat = pendingPitch == nil && alreadySaid(pitch)
      dropPending()
      say(pitch: isRepeat ? nil : pitch, exit: exit)
    case (true, false):
      flushPending()
      pendingPitch = pitch
      timer = scheduler.after(Self.hold) { [weak self] in self?.flushPending() }
    case (false, true):
      if let pending = pendingPitch {
        dropPending()
        say(pitch: pending, exit: exit)
      } else {
        say(pitch: nil, exit: exit)
      }
    case (false, false):
      break
    }
  }

  /// Forgets a pitch that has not been said.
  public func reset() {
    dropPending()
  }

  private func flushPending() {
    guard let pending = pendingPitch else { return }
    dropPending()
    say(pitch: pending, exit: nil)
  }

  private func dropPending() {
    timer?.cancel()
    timer = nil
    pendingPitch = nil
  }

  /// Whether `pitch` was said on its own within the time the board still shows it.
  private func alreadySaid(_ pitch: Int) -> Bool {
    guard let said = saidPitch, said.mph == pitch else { return false }
    return now().timeIntervalSince(said.at) < SpeedBoard.hold
  }

  private func say(pitch: Int?, exit: Int?) {
    if let pitch { saidPitch = (pitch, now()) }
    let clips = Phrase.clips(pitch: pitch, exit: exit)
    if !clips.isEmpty { speak(clips) }
  }
}

/// The app's scheduler: a main-actor `Task` that sleeps.
@MainActor
public final class TaskScheduler: SpeedyScheduler {
  public init() {}

  public func after(_ delay: Duration, _ work: @escaping @MainActor () -> Void) -> SpeedyTimer {
    TaskTimer(Task { @MainActor in
      try? await Task.sleep(for: delay)
      guard !Task.isCancelled else { return }
      work()
    })
  }

  final class TaskTimer: SpeedyTimer {
    let task: Task<Void, Never>
    init(_ task: Task<Void, Never>) { self.task = task }
    func cancel() { task.cancel() }
  }
}
