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
/// not said twice. With audio off, readings are ignored.
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
  private var pendingPitch: Int?
  private var timer: SpeedyTimer?

  public init(audioOn: Bool, scheduler: SpeedyScheduler, speak: @escaping @MainActor ([String]) -> Void) {
    self.audioOn = audioOn
    self.scheduler = scheduler
    self.speak = speak
  }

  public func receive(pitch: Int, exit: Int) {
    guard audioOn else { return }
    switch (pitch > 0, exit > 0) {
    case (true, true):
      dropPending()
      say(pitch: pitch, exit: exit)
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

  private func say(pitch: Int?, exit: Int?) {
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
