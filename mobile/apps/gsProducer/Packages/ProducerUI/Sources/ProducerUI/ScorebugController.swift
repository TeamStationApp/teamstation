import CoreGraphics
import Foundation
import ProducerPipeline
import UIKit
import WebKit

/// Renders the gamestation scoreboard page off-screen and snapshots it when it changes.
///
/// Snapshot-on-change rather than snapshot-per-frame: a scoreboard is static for tens of
/// seconds at a time, and `takeSnapshot` at 30 fps would cost more than the compositor it
/// feeds. A `MutationObserver` in the page reports real changes, and a slow heartbeat covers
/// anything that updates through canvas or CSS animation without mutating the DOM.
@MainActor
public final class ScorebugController: NSObject {
  public private(set) var latestImage: CGImage?
  public private(set) var lastUpdate: Date?
  public private(set) var loadError: String?
  /// The size the snapshot should occupy in the composited frame, in output pixels.
  public private(set) var latestSize: CGSize = .zero
  public private(set) var snapshotCount: UInt64 = 0

  /// One line describing whether the scorebug is working, for the telemetry snapshot.
  ///
  /// Until now a scorebug that failed to load looked exactly like one that was working: the load
  /// error was recorded on this object and read by nobody, so a wrong URL only revealed itself in
  /// the recorded file, after the game.
  public var status: String {
    if let loadError { return "error \(loadError)" }
    guard hasRequested else { return "idle" }
    guard snapshotCount > 0 else { return "loading" }
    return "\(Int(latestSize.width))x\(Int(latestSize.height)) n=\(snapshotCount)"
  }
  public var onSnapshot: ((CGImage?, CGSize) -> Void)?

  private let webView: WKWebView
  private let maximumSize: CGSize
  private var heartbeat: Timer?
  private var watchdog: Timer?
  private var hasRequested = false
  private var hasLoaded = false
  private var isSnapshotting = false
  private var pendingSnapshot = false

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
    webView.scrollView.backgroundColor = .clear
    webView.scrollView.isScrollEnabled = false

    super.init()

    controller.add(ScorebugMessageProxy(controller: self), name: "scorebugChanged")
    webView.navigationDelegate = self
  }

  // No `deinit` teardown: a nonisolated deinit cannot touch the main-actor `Timer`. The
  // heartbeat holds `self` weakly and is invalidated in `stop()`, which the owner calls.
  public func load(urlString: String) {
    guard let url = URL(string: urlString) else {
      loadError = "invalid scoreboard URL"
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
    webView.stopLoading()
    webView.removeFromSuperview()
    latestImage = nil
    latestSize = .zero
    onSnapshot?(nil, .zero)
  }

  public func snapshot() {
    // Nothing has loaded yet, so there is nothing to measure. `evaluateJavaScript` against a web
    // view with no page never calls back at all, which used to wedge `isSnapshotting` true forever
    // and stop the scorebug updating for the rest of the session.
    guard hasLoaded else { return }
    guard !isSnapshotting else {
      pendingSnapshot = true
      return
    }
    isSnapshotting = true
    armWatchdog()

    // Measure before capturing. The web view is laid out to the page's own content size so the
    // snapshot is the scorebug and nothing else — capturing at the full frame size instead would
    // wrap the graphic in a sheet of transparent pixels, and positioning it would then mean
    // positioning that sheet rather than the graphic.
    measureContent { [weak self] size in
      guard let self else { return }
      self.webView.frame = CGRect(origin: .zero, size: size)
      self.webView.layoutIfNeeded()

      let configuration = WKSnapshotConfiguration()
      configuration.rect = self.webView.bounds
      configuration.afterScreenUpdates = true

      self.webView.takeSnapshot(with: configuration) { [weak self] image, error in
        Task { @MainActor in
          guard let self else { return }
          self.finishSnapshot()
          if let image = image?.cgImage {
            self.latestImage = image
            self.latestSize = size
            self.snapshotCount &+= 1
            self.lastUpdate = Date()
            self.onSnapshot?(image, size)
          } else if let error {
            self.loadError = error.localizedDescription
          }
          if self.pendingSnapshot {
            self.pendingSnapshot = false
            self.snapshot()
          }
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
  /// costs a single missed update instead of every update after it.
  private func armWatchdog() {
    watchdog?.invalidate()
    watchdog = Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { [weak self] _ in
      Task { @MainActor in
        guard let self, self.isSnapshotting else { return }
        self.isSnapshotting = false
        self.loadError = "scorebug snapshot timed out"
      }
    }
  }

  private func finishSnapshot() {
    watchdog?.invalidate()
    watchdog = nil
    isSnapshotting = false
  }

  /// Asks the page how big it actually is, clamped to the frame it has to fit inside.
  ///
  /// Measured at full width every time, because measuring inside the previous result is circular:
  /// a page laid out in a 500-point view reports 500 points wide whatever its content needs, so the
  /// overlay could shrink but never grow back.
  private func measureContent(_ completion: @escaping @MainActor (CGSize) -> Void) {
    webView.frame = CGRect(origin: .zero, size: maximumSize)
    webView.layoutIfNeeded()

    webView.evaluateJavaScript(Self.contentSizeScript) { [weak self] value, _ in
      Task { @MainActor in
        guard let self else { return }
        let numbers = value as? [Double] ?? []
        let width = numbers.count == 2 ? numbers[0] : 0
        let height = numbers.count == 2 ? numbers[1] : 0
        guard width >= 1, height >= 1 else {
          // A page that reports nothing has not laid out yet. Keep the previous size rather than
          // collapsing the overlay to a point.
          completion(self.latestSize == .zero ? self.maximumSize : self.latestSize)
          return
        }
        completion(CGSize(
          width: min(width, self.maximumSize.width - MetalCompositor.overlayInset.x),
          height: min(height, self.maximumSize.height - MetalCompositor.overlayInset.y)
        ))
      }
    }
  }

  private static let contentSizeScript = """
  (function () {
    var b = document.body;
    if (!b) { return [0, 0]; }
    // The far edge of the laid-out content, not `scrollWidth`: a block-level element fills the
    // viewport, so the scroll extents report the width of the web view rather than of the scorebug
    // and the overlay ends up as wide as the frame with the graphic lost in one corner of it.
    var right = 0;
    var bottom = 0;
    var nodes = b.getElementsByTagName('*');
    for (var i = 0; i < nodes.length; i++) {
      var box = nodes[i].getBoundingClientRect();
      if (box.width === 0 || box.height === 0) { continue; }
      right = Math.max(right, box.right);
      bottom = Math.max(bottom, box.bottom);
    }
    // Only when nothing measurable was found, which means the page is not laid out the way this
    // expects and a whole-page capture is the safer answer.
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
        window.webkit.messageHandlers.scorebugChanged.postMessage(1);
      }, 120);
    }
    var observer = new MutationObserver(notify);
    observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true
    });
    notify();
  })();
  """
}

extension ScorebugController: WKNavigationDelegate {
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
    Task { @MainActor in self.loadError = error.localizedDescription }
  }

  public nonisolated func webView(
    _ webView: WKWebView,
    didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    Task { @MainActor in self.loadError = error.localizedDescription }
  }
}

/// Breaks the retain cycle WKUserContentController would otherwise create with its handler.
private final class ScorebugMessageProxy: NSObject, WKScriptMessageHandler {
  private weak var controller: ScorebugController?

  init(controller: ScorebugController) {
    self.controller = controller
  }

  func userContentController(
    _ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage
  ) {
    Task { @MainActor in self.controller?.handleChangeMessage() }
  }
}
