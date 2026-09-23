import CoreGraphics
import DirectorCore
import Foundation
import Testing
import WebKit

@testable import DirectorUI

/// A host that runs nothing and writes down what it was asked.
@MainActor
private final class RecordingHost: WebOverlayHosting {
  var calls: [String] = []
  var running: Set<UUID> = []

  func start(id: UUID, url: URL) {
    running.insert(id)
    calls.append("start \(url.lastPathComponent)")
  }

  func load(id: UUID, url: URL) {
    calls.append("load \(url.lastPathComponent)")
  }

  func stop(id: UUID) {
    running.remove(id)
    calls.append("stop")
  }

  func isRunning(id: UUID) -> Bool { running.contains(id) }
}

/// A clock the test moves by hand.
@MainActor
private final class FakeClock {
  var now: TimeInterval = 0
  private var due: [(at: TimeInterval, work: @MainActor () -> Void)] = []

  func schedule(_ seconds: TimeInterval, _ work: @escaping @MainActor () -> Void) {
    due.append((now + seconds, work))
  }

  func advance(_ seconds: TimeInterval) {
    now += seconds
    let ready = due.filter { $0.at <= now }
    due.removeAll { $0.at <= now }
    for item in ready { item.work() }
  }
}

private let sample = URL(string: "https://gs.example/scoreboard-sample")!
private let live = URL(string: "https://gs.example/scoreboard/g1?quiet=1")!

private func scoreboard(_ id: UUID = UUID()) -> ProgramOverlay {
  ProgramOverlay(
    id: id, kind: .scoreboard, originX: 0, originY: 0, width: 0.3, height: 0.1,
    placement: .centerQuarter
  )
}

private func context(
  live: URL? = nil,
  editorOpen: Bool = false,
  capturing: Bool = false
) -> ScoreboardContext {
  ScoreboardContext(live: live, sample: sample, editorOpen: editorOpen, capturing: capturing)
}

@MainActor
private final class Rig {
  let host = RecordingHost()
  let clock = FakeClock()
  lazy var driver = ScoreboardOverlayDriver(
    host: host,
    schedule: { [unowned self] seconds, work in self.clock.schedule(seconds, work) }
  )
}

@Suite("Scoreboard overlay driver")
@MainActor
struct ScoreboardOverlayDriverTests {
  @Test func followsTheEventTheEditorAndCapture() {
    let rig = Rig()
    let board = scoreboard()
    // Nothing resolves: no event, editor closed.
    rig.driver.update(overlays: [ board ], context: context())
    #expect(rig.host.calls.isEmpty)
    // The editor opens: the sample starts.
    rig.driver.update(overlays: [ board ], context: context(editorOpen: true))
    #expect(rig.host.calls == [ "start scoreboard-sample" ])
    // An event is chosen while it is open: still the sample, so nothing.
    rig.driver.update(overlays: [ board ], context: context(live: live, editorOpen: true))
    #expect(rig.host.calls.count == 1)
    // Recording starts: the live board replaces the sample.
    rig.driver.update(
      overlays: [ board ], context: context(live: live, editorOpen: true, capturing: true)
    )
    #expect(rig.host.calls.last == "load g1")
    // The editor closes: unchanged.
    rig.driver.update(overlays: [ board ], context: context(live: live, capturing: true))
    #expect(rig.host.calls.count == 2)
    // Capture stops with the editor closed: still live.
    rig.driver.update(overlays: [ board ], context: context(live: live))
    #expect(rig.host.calls.count == 2)
    // The event is cleared: stopped.
    rig.driver.update(overlays: [ board ], context: context())
    #expect(rig.host.calls.last == "stop")
    // Still nothing: no second stop.
    rig.driver.update(overlays: [ board ], context: context())
    #expect(rig.host.calls.count == 3)
    // An event chosen again: started with the live board.
    rig.driver.update(overlays: [ board ], context: context(live: live))
    #expect(rig.host.calls.last == "start g1")
  }

  @Test func startsABoardAddedWhileTheEditorIsOpen() {
    let rig = Rig()
    rig.driver.update(overlays: [], context: context(editorOpen: true))
    #expect(rig.host.calls.isEmpty)
    rig.driver.update(overlays: [ scoreboard() ], context: context(editorOpen: true))
    #expect(rig.host.calls == [ "start scoreboard-sample" ])
  }

  @Test func startsItAgainAfterATemplateRoundTrip() {
    let rig = Rig()
    let board = scoreboard()
    rig.driver.update(overlays: [ board ], context: context(live: live))
    // Template B, without the scoreboard, whose controller is stopped by the
    // media sweep rather than by the driver.
    rig.driver.update(overlays: [], context: context(live: live))
    rig.host.running.remove(board.id)
    // Back to A: started again, although its URL never changed.
    rig.driver.update(overlays: [ board ], context: context(live: live))
    #expect(rig.host.calls == [ "start g1", "start g1" ])
  }

  @Test func startsANewBoardAfterTheOldOneIsDeleted() {
    let rig = Rig()
    let old = scoreboard()
    rig.driver.update(overlays: [ old ], context: context(live: live))
    rig.host.running.remove(old.id)
    rig.driver.update(overlays: [], context: context(live: live))
    rig.driver.update(overlays: [ scoreboard() ], context: context(live: live))
    #expect(rig.host.calls == [ "start g1", "start g1" ])
  }

  @Test func leavesEveryOtherKindAlone() {
    let rig = Rig()
    let web = ProgramOverlay(
      kind: .web, url: "https://x", originX: 0, originY: 0, width: 0.2, height: 0.2,
      placement: .centerQuarter
    )
    rig.driver.update(overlays: [ web ], context: context(live: live))
    #expect(rig.host.calls.isEmpty)
  }

  @Test func reloadsAFailedPageEveryTenSecondsUntilItLoads() {
    let rig = Rig()
    let board = scoreboard()
    rig.driver.update(overlays: [ board ], context: context(live: live))
    rig.driver.loadFailed(id: board.id)
    rig.clock.advance(9)
    #expect(rig.host.calls == [ "start g1" ])
    rig.clock.advance(1)
    #expect(rig.host.calls == [ "start g1", "load g1" ])
    // That load failed too.
    rig.driver.loadFailed(id: board.id)
    rig.clock.advance(10)
    #expect(rig.host.calls.count == 3)
    // This one loaded: nothing more.
    rig.clock.advance(60)
    #expect(rig.host.calls.count == 3)
  }

  @Test func aNewURLStopsTheRetryOfTheOldOne() {
    let rig = Rig()
    let board = scoreboard()
    rig.driver.update(overlays: [ board ], context: context(editorOpen: true))
    rig.driver.loadFailed(id: board.id)
    rig.driver.update(overlays: [ board ], context: context(live: live))
    rig.clock.advance(10)
    #expect(rig.host.calls == [ "start scoreboard-sample", "load g1" ])
  }

  @Test func forgetsAFailureOfAnOverlayItDoesNotKnow() {
    let rig = Rig()
    rig.driver.loadFailed(id: UUID())
    rig.clock.advance(10)
    #expect(rig.host.calls.isEmpty)
  }

  @Test func doesNotReloadABoardThatWasStopped() {
    let rig = Rig()
    let board = scoreboard()
    rig.driver.update(overlays: [ board ], context: context(live: live))
    rig.driver.loadFailed(id: board.id)
    rig.host.running.remove(board.id)
    rig.clock.advance(10)
    #expect(rig.host.calls == [ "start g1" ])
  }
}

@Suite("Web overlay load failures")
@MainActor
struct WebOverlayLoadFailureTests {
  @Test func aFailedLoadSaysSoEitherWay() async {
    let controller = WebOverlayController(size: ScoreboardOverlaySource.boardSize)
    var failures = 0
    controller.onLoadFailed = { failures += 1 }
    let view = WKWebView()
    // Not fetched at all, and failed part way: both are a failed load.
    controller.webView(
      view, didFailProvisionalNavigation: nil, withError: URLError(.cannotConnectToHost)
    )
    controller.webView(view, didFail: nil, withError: URLError(.networkConnectionLost))
    // The delegate hops to the main actor to say so.
    for _ in 0..<200 where failures < 2 {
      try? await Task.sleep(for: .milliseconds(10))
    }
    #expect(failures == 2)
    #expect(controller.loadError != nil)
  }

  @Test func theDriversOwnClockWaits() async {
    var fired = false
    ScoreboardOverlayDriver.afterDelay(0.01) { fired = true }
    #expect(!fired)
    for _ in 0..<200 where !fired {
      try? await Task.sleep(for: .milliseconds(10))
    }
    #expect(fired)
  }
}
