import SwiftUI
import WebKit

/// A visible, silent web page for the monitor. It never creates a camera or an overlay.
struct ScoreboardMonitorPage: UIViewRepresentable {
  let url: URL

  func makeCoordinator() -> Coordinator { Coordinator(url: url) }

  func makeUIView(context: Context) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.mediaTypesRequiringUserActionForPlayback = .all
    config.userContentController.addUserScript(WKUserScript(
      source: Self.fitBoard, injectionTime: .atDocumentEnd, forMainFrameOnly: true
    ))
    let view = WKWebView(frame: .zero, configuration: config)
    view.isOpaque = false
    view.backgroundColor = .black
    view.underPageBackgroundColor = .black
    view.scrollView.backgroundColor = .black
    view.scrollView.isScrollEnabled = false
    view.scrollView.contentInsetAdjustmentBehavior = .never
    view.isUserInteractionEnabled = false
    view.navigationDelegate = context.coordinator
    view.load(URLRequest(url: url))
    return view
  }

  func updateUIView(_ view: WKWebView, context: Context) {}

  static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
    coordinator.retry?.cancel()
    view.navigationDelegate = nil
    view.stopLoading()
    view.loadHTMLString("", baseURL: nil)
  }

  @MainActor
  final class Coordinator: NSObject, WKNavigationDelegate {
    let url: URL
    var retry: Task<Void, Never>?

    init(url: URL) { self.url = url }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
      reload(webView)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
      reload(webView)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { reload(webView) }

    private func reload(_ webView: WKWebView) {
      retry?.cancel()
      retry = Task { [weak webView, url] in
        do { try await Task.sleep(for: .seconds(3)) } catch { return }
        webView?.load(URLRequest(url: url))
      }
    }
  }

  // Measure the natural board, even in a narrow grid slot. A CSS transform leaves its
  // layout size alone so a ResizeObserver sees team-name changes without feeding back.
  static let fitBoard = """
    document.documentElement.style.overflow = 'hidden'
    document.body.style.background = 'transparent'
    document.body.style.overflow = 'hidden'
    let board
    function fit() {
      if (!board || !board.offsetWidth) return
      board.style.transformOrigin = 'top left'
      board.style.transform = 'scale(' + document.documentElement.clientWidth / board.offsetWidth + ')'
    }
    const sizes = new ResizeObserver(fit)
    sizes.observe(document.documentElement)
    function observe() {
      if (board && board.isConnected) return
      if (board) sizes.unobserve(board)
      board = document.querySelector('[data-scoreboard="board"][data-drawn="true"]')
      if (!board) return
      board.style.width = 'max-content'
      sizes.observe(board)
      fit()
    }
    new MutationObserver(observe).observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['data-drawn']
    })
    observe()
    """
}
