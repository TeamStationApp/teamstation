import CoreGraphics
import Foundation
import DirectorCore
import DirectorPipeline
import UIKit
import WebKit

/// Renders a web overlay off-screen and snapshots it when the page changes.
///
/// Snapshot-on-change rather than snapshot-per-frame: overlay pages are static for tens of
/// seconds at a time, and `takeSnapshot` at 30 fps would cost more than the compositor it
/// feeds. A `MutationObserver` in the page reports real changes, and a slow heartbeat covers
/// anything that updates through canvas or CSS animation without mutating the DOM.
@MainActor
public final class WebOverlayController: NSObject {
  public private(set) var latestImage: CGImage?
  public private(set) var lastUpdate: Date?
  public private(set) var loadError: String?
  /// The size the snapshot should occupy in the composited frame, in output pixels.
  public private(set) var latestSize: CGSize = .zero
  public private(set) var snapshotCount: UInt64 = 0

  /// One line describing whether this overlay is working, for the telemetry snapshot.
  public var status: String {
    if let loadError { return "error \(loadError)" }
    guard hasRequested else { return "idle" }
    guard snapshotCount > 0 else { return "loading" }
    return "\(Int(latestSize.width))x\(Int(latestSize.height)) n=\(snapshotCount)"
  }
  public var onSnapshot: ((CGImage?, CGSize) -> Void)?
  /// The page could not be loaded: not fetched at all, or failed part way.
  /// Nothing here tries again; the owner decides whether to.
  public var onLoadFailed: (() -> Void)?

  private let webView: WKWebView
  private let maximumSize: CGSize
  private var heartbeat: Timer?
  private var watchdog: Timer?
  private var hasRequested = false
  private var hasLoaded = false
  private var gate = OverlaySnapshotGate()

  public init(size: CGSize = CGSize(width: 1920, height: 1080)) {
    maximumSize = size
    let configuration = WKWebViewConfiguration()
    configuration.suppressesIncrementalRendering = false
    let controller = WKUserContentController()
    controller.addUserScript(WKUserScript(
      source: Self.mutationObserverScript,
      injectionTime: .atDocumentEnd,
      forMainFrameOnly: true
    ))
    configuration.userContentController = controller

    webView = WKWebView(frame: CGRect(origin: .zero, size: size), configuration: configuration)
    webView.isOpaque = false
    webView.backgroundColor = .clear
    webView.underPageBackgroundColor = .clear
    webView.scrollView.backgroundColor = .clear
    webView.scrollView.isOpaque = false
    webView.scrollView.isScrollEnabled = false
    webView.scrollView.contentInsetAdjustmentBehavior = .never

    super.init()

    controller.add(WebOverlayMessageProxy(controller: self), name: "overlayChanged")
    webView.navigationDelegate = self
  }

  // No `deinit` teardown: a nonisolated deinit cannot touch the main-actor `Timer`. The
  // heartbeat holds `self` weakly and is invalidated in `stop()`, which the owner calls.
  public func load(urlString: String) {
    guard let url = URL(string: urlString) else {
      loadError = "invalid overlay URL"
      return
    }
    loadError = nil
    hasRequested = true
    attachToWindow()
    webView.load(URLRequest(url: url))

    heartbeat?.invalidate()
    heartbeat = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.snapshot() }
    }
  }

  public func stop() {
    heartbeat?.invalidate()
    heartbeat = nil
    watchdog?.invalidate()
    watchdog = nil
    hasLoaded = false
    hasRequested = false
    gate.cancel()
    webView.stopLoading()
    webView.removeFromSuperview()
    latestImage = nil
    latestSize = .zero
    onSnapshot?(nil, .zero)
  }

  public func snapshot() {
    // Nothing has loaded yet, so there is nothing to measure. `evaluateJavaScript` against a web
    // view with no page never calls back at all, which used to wedge `isSnapshotting` true forever
    // and stop the overlay updating for the rest of the session.
    guard hasLoaded else { return }
    // A change while a snapshot runs is not lost: it gets one snapshot of its own as soon as this
    // one ends, however it ends.
    guard let run = gate.request() else { return }
    armWatchdog(run)
    attachToWindow()

    // Measure before capturing. The web view is laid out to the page's own content size so the
    // snapshot is the overlay graphic and nothing else — capturing at the full frame size instead would
    // wrap the graphic in a sheet of transparent pixels, and positioning it would then mean
    // positioning that sheet rather than the graphic.
    measureContent { [weak self] size in
      guard let self else { return }
      guard size.width >= 1, size.height >= 1 else {
        self.finishSnapshot(run)
        return
      }
      self.webView.frame = CGRect(origin: .zero, size: size)
      self.webView.layoutIfNeeded()

      let configuration = WKSnapshotConfiguration()
      configuration.rect = self.webView.bounds
      configuration.afterScreenUpdates = true

      self.webView.takeSnapshot(with: configuration) { [weak self] image, error in
        Task { @MainActor in
          guard let self else { return }
          let outcome = self.endSnapshot(run)
          if let image, let cgImage = image.cgImage {
            let displayScale = max(
              self.webView.window?.screen.scale ?? 0,
              self.webView.traitCollection.displayScale,
              1
            )
            // Layout uses the CSS shrink-wrap, not the bitmap. Pixel size / image.scale is wrong
            // on the first capture when UIImage.scale is still 1 on a retina device.
            let native = OverlayLayout.webNativeSize(
              measured: size,
              pixelWidth: CGFloat(cgImage.width),
              pixelHeight: CGFloat(cgImage.height),
              imageScale: image.scale,
              displayScale: displayScale
            )
            self.latestImage = cgImage
            self.latestSize = native
            self.snapshotCount &+= 1
            self.lastUpdate = Date()
            self.onSnapshot?(cgImage, native)
          } else if let error {
            self.loadError = error.localizedDescription
          }
          if outcome == .again { self.snapshot() }
        }
      }
    }
  }

  /// Puts the web view in the window, behind everything, so WebKit will actually render it.
  ///
  /// A `WKWebView` renders in another process and only does so while it belongs to a window: left
  /// detached it loads the page, runs its JavaScript and reports success, but every `takeSnapshot`
  /// hangs. Nothing about that failure points at the view hierarchy, which is why this is spelled
  /// out here. It goes in at index zero under an opaque root view, so it is never visible.
  private func attachToWindow() {
    guard webView.superview == nil else { return }
    let window = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
      .first { $0.isKeyWindow }
    guard let window else { return }
    webView.isUserInteractionEnabled = false
    window.insertSubview(webView, at: 0)
  }

  /// Releases the snapshot path if a measure or capture never calls back, so one wedged callback
  /// costs a single missed update instead of every update after it. A change that arrived while it
  /// was wedged is snapshotted straight away, not at the next heartbeat.
  private func armWatchdog(_ run: Int) {
    watchdog?.invalidate()
    watchdog = Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { [weak self] _ in
      Task { @MainActor in
        guard let self, self.gate.isRunning(run) else { return }
        self.loadError = "overlay snapshot timed out"
        self.finishSnapshot(run)
      }
    }
  }

  /// Ends snapshot `run` and says whether a change arrived during it.
  private func endSnapshot(_ run: Int) -> OverlaySnapshotGate.Outcome {
    let outcome = gate.finish(run)
    // A capture that returns after the watchdog released it must not stop the watchdog of the
    // snapshot that has started since.
    if outcome != .stale {
      watchdog?.invalidate()
      watchdog = nil
    }
    return outcome
  }

  /// Ends snapshot `run`, and takes the next one now if a change arrived during it.
  private func finishSnapshot(_ run: Int) {
    if endSnapshot(run) == .again { snapshot() }
  }

  /// Lays the page out in a large viewport, then shrink-wraps to the graphic — not to the
  /// viewport. Full-bleed wrappers would otherwise report the whole programme width.
  private func measureContent(_ completion: @escaping @MainActor (CGSize) -> Void) {
    let viewport = CGSize(width: maximumSize.width, height: max(maximumSize.height * 2, 2160))
    webView.frame = CGRect(origin: .zero, size: viewport)
    webView.layoutIfNeeded()

    webView.evaluateJavaScript(Self.contentSizeScript) { [weak self] value, _ in
      Task { @MainActor in
        guard let self else { return }
        let numbers = value as? [Double] ?? []
        let measuredWidth = numbers.count >= 2 ? numbers[0] : 0
        let measuredHeight = numbers.count >= 2 ? numbers[1] : 0
        guard measuredWidth >= 1, measuredHeight >= 1 else {
          completion(.zero)
          return
        }
        completion(CGSize(width: measuredWidth, height: measuredHeight))
      }
    }
  }

  private static let contentSizeScript = """
  (function () {
    var b = document.body;
    if (!b) { return [0, 0]; }
    // Refuse to measure a page that is still arriving. A late web font measures too narrow and a
    // wrapper that has not shrink-wrapped measures the whole viewport, and either one persisted
    // would resize the overlay to something the finished page never looks like.
    if (document.readyState !== 'complete') { return [0, 0]; }
    if (document.fonts && document.fonts.status === 'loading') { return [0, 0]; }
    var vw = document.documentElement.clientWidth || 0;
    var vh = document.documentElement.clientHeight || 0;
    if (vw < 1 || vh < 1) { return [0, 0]; }
    var right = 0;
    var bottom = 0;
    var nodes = b.getElementsByTagName('*');
    for (var i = 0; i < nodes.length; i++) {
      var box = nodes[i].getBoundingClientRect();
      if (box.width < 1 || box.height < 1) { continue; }
      // Skip page-sized wrappers. A block that fills the web view would make the overlay
      // as wide as Output with the graphic smashed into one strip of it.
      if (vw > 0 && box.width >= vw * 0.98) { continue; }
      if (vh > 0 && box.height >= vh * 0.98) { continue; }
      right = Math.max(right, box.right);
      bottom = Math.max(bottom, box.bottom);
    }
    if (right < 1 || bottom < 1) {
      right = 0;
      bottom = 0;
      for (var j = 0; j < nodes.length; j++) {
        var all = nodes[j].getBoundingClientRect();
        if (all.width < 1 || all.height < 1) { continue; }
        right = Math.max(right, all.right);
        bottom = Math.max(bottom, all.bottom);
      }
    }
    if (right < 1) { right = b.scrollWidth; }
    if (bottom < 1) { bottom = b.scrollHeight; }
    return [Math.ceil(right), Math.ceil(bottom)];
  })();
  """

  fileprivate func handleChangeMessage() {
    snapshot()
  }

  private static let mutationObserverScript = """
  (function () {
    var pending = false;
    function notify() {
      if (pending) { return; }
      pending = true;
      setTimeout(function () {
        pending = false;
        window.webkit.messageHandlers.overlayChanged.postMessage(1);
      }, 120);
    }
    var observer = new MutationObserver(notify);
    observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true
    });
    // The measure refuses to run until images and fonts have landed, so ask for a snapshot when
    // they do. Without these the first correct measure would wait for the 5s heartbeat.
    window.addEventListener('load', notify);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(notify);
    }
    notify();
  })();
  """
}

/// One overlay snapshot at a time, and a change that arrives during one owed exactly one more.
///
/// A page can change while its snapshot is being measured or captured, or while a wedged capture
/// waits for the watchdog. That change must not wait for the page's next change or the 5 s
/// heartbeat: the snapshot running may have measured the page before it. So the gate marks
/// itself dirty, and the run's end, however it ends, starts one more. Several changes during one
/// run still cost one more snapshot, which sees them all.
///
/// Runs are numbered, so a callback that returns after the watchdog released its run, or after
/// the page was stopped, cannot end the run that has started since.
struct OverlaySnapshotGate: Equatable {
  enum Outcome: Equatable {
    /// The run ended and nothing changed during it.
    case done
    /// The run ended and something changed during it: snapshot again now.
    case again
    /// Not the running run: it was already released. Nothing changes.
    case stale
  }

  private var running: Int?
  private var next = 0
  private(set) var isDirty = false

  /// A snapshot is wanted. Returns its run number when it may start now, or nil when one is
  /// already running, which then owes one more.
  mutating func request() -> Int? {
    guard running == nil else {
      isDirty = true
      return nil
    }
    next += 1
    running = next
    return next
  }

  func isRunning(_ run: Int) -> Bool {
    running == run
  }

  /// Run `run` ended: captured, refused by the measure, failed, or released by the watchdog.
  mutating func finish(_ run: Int) -> Outcome {
    guard running == run else { return .stale }
    running = nil
    guard isDirty else { return .done }
    isDirty = false
    return .again
  }

  /// The page stopped: whatever runs now is stale, and nothing is owed.
  mutating func cancel() {
    running = nil
    isDirty = false
  }
}

extension WebOverlayController: WKNavigationDelegate {
  public nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    Task { @MainActor in
      self.hasLoaded = true
      self.loadError = nil
      self.snapshot()
    }
  }

  public nonisolated func webView(
    _ webView: WKWebView,
    didFail navigation: WKNavigation!,
    withError error: Error
  ) {
    let said = error.localizedDescription
    Task { @MainActor in self.failed(said) }
  }

  public nonisolated func webView(
    _ webView: WKWebView,
    didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    let said = error.localizedDescription
    Task { @MainActor in self.failed(said) }
  }

  private func failed(_ said: String) {
    loadError = said
    onLoadFailed?()
  }
}

/// Breaks the retain cycle WKUserContentController would otherwise create with its handler.
private final class WebOverlayMessageProxy: NSObject, WKScriptMessageHandler {
  private weak var controller: WebOverlayController?

  init(controller: WebOverlayController) {
    self.controller = controller
  }

  func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage
  ) {
    Task { @MainActor in self.controller?.handleChangeMessage() }
  }
}
