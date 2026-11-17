#if canImport(UIKit)
  import TeamStationSplashCore
  import UIKit

  /// Puts the splash over an app's window at launch and takes it away again:
  /// once the timeline has ended and the app has drawn its first content, or
  /// at the cap, with a short fade. Accessibility sees only the splash until
  /// then, so VoiceOver and UI tests wait for the real screen. The window's
  /// other views take no touches, presses or focus meanwhile, so the Siri
  /// Remote cannot work a screen the splash hides.
  @MainActor
  public final class SplashOverlay {
    /// How many overlays this process has installed; the app's hosted tests read it.
    public private(set) static var installCount = 0
    /// The overlays on screen, held here until they dismiss, so a caller may
    /// drop the one `install` returns.
    private static var showing: [ObjectIdentifier: SplashOverlay] = [:]
    /// Posted as a splash starts to leave, so the app can restyle its status bar.
    public static let didDismiss = Notification.Name("TSSplashDidDismiss")

    /// Whether a splash is up: the status bar stays light over it, whatever
    /// React Native has asked for.
    public static var isShowing: Bool { !showing.isEmpty }

    public let view: SplashView
    private var policy: SplashPolicy
    private var observer: NSObjectProtocol?
    private var timers: [Timer] = []
    /// The window's other views, and whether each took input before the splash.
    private var covered: [(view: UIView, enabled: Bool)] = []
    private(set) var dismissed = false
    /// When the splash went up, in media time: the cap counts from here.
    private let installedAt = CACurrentMediaTime()

    /// Installs a splash over `window` and starts it. `firstContent` is the
    /// notification the app posts when it has drawn (React Native's
    /// `RCTContentDidAppearNotification`); `frozenMs` is the test hook.
    @discardableResult
    public static func install(
      in window: UIWindow,
      firstContent: Notification.Name,
      frozenMs: Double?
    ) -> SplashOverlay {
      let overlay = SplashOverlay(frame: window.bounds, firstContent: firstContent, frozenMs: frozenMs)
      overlay.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      overlay.covered = window.subviews.map { ($0, $0.isUserInteractionEnabled) }
      for (view, _) in overlay.covered { view.isUserInteractionEnabled = false }
      window.addSubview(overlay.view)
      // React Native's start can hold the main thread for a second or more
      // after this; frame 0 goes to the screen now rather than after it.
      overlay.view.layoutIfNeeded()
      CATransaction.flush()
      installCount += 1
      showing[ObjectIdentifier(overlay)] = overlay
      overlay.view.start { [weak overlay] in overlay?.started() }
      return overlay
    }

    /// `install(in:firstContent:frozenMs:)` with the test hook read from this
    /// process's launch arguments; `develop` says whether this is a develop build.
    @discardableResult
    public static func install(in window: UIWindow, firstContent: Notification.Name, develop: Bool) -> SplashOverlay {
      install(in: window, firstContent: firstContent, frozenMs: SplashLaunchOptions.current(develop: develop))
    }

    init(frame: CGRect, firstContent: Notification.Name, frozenMs: Double?) {
      view = SplashView(frame: frame, frozenMs: frozenMs)
      policy = SplashPolicy(frozen: frozenMs != nil)
      observer = NotificationCenter.default.addObserver(forName: firstContent, object: nil, queue: .main) {
        [weak self] _ in
        MainActor.assumeIsolated { self?.contentDidAppear() }
      }
      // The cap holds from the moment the splash goes up, however long the
      // images take to decode, or if they never do.
      if !policy.frozen { checkAfter(SplashTimeline.capMs) }
    }

    /// The timeline has started: check again when it ends.
    func started() {
      guard !policy.frozen else { return }
      checkAfter(SplashTimeline.durationMs - view.elapsedMs())
      check()
    }

    private func checkAfter(_ ms: Double) {
      guard ms > 0 else { return }
      let timer = Timer(timeInterval: ms / 1000, repeats: false) { [weak self] _ in
        MainActor.assumeIsolated { self?.check() }
      }
      RunLoop.main.add(timer, forMode: .common)
      timers.append(timer)
    }

    func contentDidAppear() {
      policy.contentDidAppear()
      view.contentDidAppear()
      check()
    }

    /// Dismisses when the policy says so.
    func check(now: CFTimeInterval = CACurrentMediaTime()) {
      guard !dismissed else { return }
      let timelineMs = view.startedAt.map { _ in view.elapsedMs(now: now) }
      if policy.decision(sinceInstallMs: (now - installedAt) * 1000, timelineMs: timelineMs) == .dismiss { dismiss() }
    }

    /// Fades the splash out and removes it.
    func dismiss(animated: Bool = true) {
      guard !dismissed else { return }
      dismissed = true
      Self.showing[ObjectIdentifier(self)] = nil
      NotificationCenter.default.post(name: Self.didDismiss, object: self)
      for timer in timers { timer.invalidate() }
      timers.removeAll()
      if let observer { NotificationCenter.default.removeObserver(observer) }
      observer = nil
      view.accessibilityViewIsModal = false
      view.isAccessibilityElement = false
      for (covered, enabled) in covered { covered.isUserInteractionEnabled = enabled }
      covered = []
      if let root = view.window?.rootViewController {
        root.setNeedsFocusUpdate()
        root.updateFocusIfNeeded()
      }
      let remove = { [view] in
        view.removeFromSuperview()
        UIAccessibility.post(notification: .screenChanged, argument: nil)
      }
      guard animated else {
        remove()
        return
      }
      UIView.animate(
        withDuration: SplashTimeline.fadeMs / 1000,
        delay: 0,
        options: [.curveEaseOut, .beginFromCurrentState],
        animations: { [view] in view.alpha = 0 },
        completion: { _ in remove() }
      )
    }
  }
#endif
