import AVFAudio
import MediaPlayer
import UIKit

/// The phone's own volume, moved for fading Apple Music.
///
/// `ApplicationMusicPlayer` has no volume of its own, so the only way to fade
/// a walk-up clip is the one BallparkDJ uses: the system volume, set through
/// the `UISlider` inside a `MPVolumeView`. The view is 1x1 and off-screen in
/// the key window, so iOS shows no volume pop-up at each step. Apple does not
/// support this (App Review 2.5.9 is about volume controls), which is why the
/// Account screen can turn it off.
///
/// Two promises keep the phone from being left quiet:
///
/// - **Restore.** Before a fade takes the volume down, the level the person
///   chose is saved in `UserDefaults` (`walkUpRestoreVolume`), and cleared
///   when it has been set back. A saved level found at launch or on becoming
///   active means a clip was cut off mid-fade — the app was killed — and it is
///   set back then.
/// - **The person wins.** A change this class did not make, such as the
///   buttons pressed mid-clip, stops the fade where it is, leaves the volume
///   where they put it, and forgets the saved level. A reading within one
///   detent of a level this class set is the system's echo of that set.
final class SystemVolume: NSObject {
  static let restoreKey = "walkUpRestoreVolume"

  private var volumeView: MPVolumeView?
  private var slider: UISlider?
  private var observation: NSKeyValueObservation?
  private var ramp: Timer?
  /// Bumped when a new clip takes the volume, so a restore still settling
  /// from the previous clip does not write over this one.
  private var epoch = 0
  /// The last level `set` asked for. A ramp starts here, because
  /// `outputVolume` can still be the old level when the slider has not
  /// applied yet.
  private var commanded: Float = 1
  /// The levels this class set lately: what the observer should not mistake
  /// for the person's hand, since each lands a moment after it is set.
  /// A fade-out is thirty 50 ms steps, and the reading of an early step can
  /// arrive after the ramp has finished, so the whole ramp is kept.
  private var recent: [Float] = []
  /// One hardware detent is 1/16 (0.0625), and this phone also reports
  /// twentieths. A reading that close to a level we set is the system's echo.
  private static let echo: Float = 0.08
  private static let recentLimit = 40

  /// The lowest level set since `begin`.
  private(set) var lowest: Float = 1
  /// Called on the main thread when the person moves the volume mid-clip.
  var onTakeover: (() -> Void)?

  var level: Float { AVAudioSession.sharedInstance().outputVolume }

  var saved: Float? {
    guard let value = UserDefaults.standard.object(forKey: Self.restoreKey) as? Double else {
      return nil
    }
    return Float(value)
  }

  /// Adds the hidden slider to the key window, once there is one.
  func install() {
    if volumeView != nil {
      if slider == nil { attachSlider() }
      return
    }
    let window = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first { $0.isKeyWindow }
    guard let window else { return }
    let view = MPVolumeView(frame: CGRect(x: -2000, y: -2000, width: 1, height: 1))
    view.alpha = 0.01
    view.isUserInteractionEnabled = false
    window.addSubview(view)
    window.layoutIfNeeded()
    volumeView = view
    attachSlider()
  }

  /// `MPVolumeSlider` is created on layout, sometimes nested, and assigning
  /// `value` alone does not move the system volume.
  private func attachSlider() {
    guard let volumeView else { return }
    volumeView.layoutIfNeeded()
    slider = findSlider(in: volumeView)
  }

  private func findSlider(in view: UIView) -> UISlider? {
    let name = String(describing: type(of: view))
    if name == "MPVolumeSlider", let slider = view as? UISlider { return slider }
    for subview in view.subviews {
      if let found = findSlider(in: subview) { return found }
    }
    return view as? UISlider
  }

  /// Sets the volume, at once.
  func set(_ value: Float) {
    install()
    let clamped = max(0, min(1, value))
    commanded = clamped
    recent.append(clamped)
    if recent.count > Self.recentLimit {
      recent.removeFirst(recent.count - Self.recentLimit)
    }
    lowest = min(lowest, clamped)
    guard let slider else { return }
    slider.setValue(clamped, animated: false)
    slider.sendActions(for: .valueChanged)
    slider.sendActions(for: .touchUpInside)
  }

  /// Saves the person's level and starts watching for their hand. Returns
  /// the level saved.
  @discardableResult
  func begin() -> Float {
    epoch += 1
    install()
    let session = AVAudioSession.sharedInstance()
    // Mixable and ambient, so being active interrupts nobody's music; it is
    // what makes `outputVolume` report changes.
    try? session.setCategory(.ambient, options: [.mixWithOthers])
    try? session.setActive(true)
    let start = saved ?? level
    UserDefaults.standard.set(Double(start), forKey: Self.restoreKey)
    commanded = start
    lowest = start
    if !isRamping { recent = [start] }
    observation = session.observe(\.outputVolume, options: [.new]) { [weak self] _, change in
      guard let self, let value = change.newValue else { return }
      DispatchQueue.main.async { self.observed(value) }
    }
    return start
  }

  private func observed(_ value: Float) {
    guard observation != nil else { return }
    // The ramp is writing the slider. Its echoes, including a one-detent
    // click of the reading, are not the person's hand.
    if ramp != nil { return }
    if recent.contains(where: { abs($0 - value) <= Self.echo }) { return }
    if abs(commanded - value) <= Self.echo { return }
    // Not ours: the person's. They have the volume now.
    cancelRamp()
    observation = nil
    UserDefaults.standard.removeObject(forKey: Self.restoreKey)
    onTakeover?()
  }

  /// Steps from the last commanded level to `target` over `ms`, 50 ms at a time.
  /// `from` overrides that start, for a climb that begins at the speaker's
  /// own reading rather than a level that was asked for and did not land.
  func ramp(to target: Float, over ms: Double, from explicit: Float? = nil, done: (() -> Void)? = nil) {
    cancelRamp()
    let from = explicit ?? commanded
    let steps = max(1, Int((ms / 50).rounded(.up)))
    var step = 0
    if ms <= 0 {
      set(target)
      done?()
      return
    }
    let timer = Timer(timeInterval: 0.05, repeats: true) { [weak self] timer in
      guard let self else {
        timer.invalidate()
        return
      }
      step += 1
      let progress = Float(step) / Float(steps)
      self.set(from + (target - from) * min(1, progress))
      if step >= steps {
        timer.invalidate()
        if self.ramp === timer { self.ramp = nil }
        done?()
      }
    }
    RunLoop.main.add(timer, forMode: .common)
    ramp = timer
  }

  /// Whether a fade is still moving the volume.
  var isRamping: Bool { ramp != nil }

  func cancelRamp() {
    ramp?.invalidate()
    ramp = nil
  }

  /// Whether the person has taken the volume over during this clip.
  var released: Bool { observation == nil }

  /// Puts the saved level back. A single jump from silence to full does not
  /// move this phone's volume slider — the fade-down's small steps do — so
  /// the return is a ramp of `ms`, the same rate as the fade down. The key
  /// stays until the speaker is actually there. Returns the level aimed at,
  /// or nil when there was nothing to restore (the person took over).
  @discardableResult
  func end(restoreOver ms: Double) -> Float? {
    cancelRamp()
    let wasWatching = observation != nil
    observation = nil
    guard wasWatching, let value = saved else { return nil }
    let epoch = self.epoch
    let from = level
    if ms <= 0 || abs(from - value) <= Self.echo {
      set(value)
      confirm(value, epoch: epoch)
      return value
    }
    ramp(to: value, over: ms, from: from) { [weak self] in
      self?.confirm(value, epoch: epoch)
    }
    return value
  }

  /// Drops the saved level once the speaker has arrived, and only for the
  /// clip that asked.
  private func confirm(_ value: Float, epoch: Int) {
    guard epoch == self.epoch else { return }
    if abs(level - value) <= Self.echo {
      UserDefaults.standard.removeObject(forKey: Self.restoreKey)
      return
    }
    set(value)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
      guard let self, epoch == self.epoch else { return }
      if abs(self.level - value) <= Self.echo {
        UserDefaults.standard.removeObject(forKey: Self.restoreKey)
      }
    }
  }

  /// A level saved by a clip that never finished, brought back the same way.
  func restoreInterrupted() -> Float? {
    guard observation == nil, ramp == nil, let value = saved else { return nil }
    if abs(level - value) <= Self.echo {
      UserDefaults.standard.removeObject(forKey: Self.restoreKey)
      return value
    }
    let epoch = self.epoch
    ramp(to: value, over: 1500) { [weak self] in
      self?.confirm(value, epoch: epoch)
    }
    return value
  }
}
