import CoreGraphics
import DirectorCore
import DirectorTestHarness
import TeamStationKit
import Foundation
import SwiftUI
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

private let sample = URL(string: "https://ts.example/scoreboard-sample")!
private let live = URL(string: "https://ts.example/scoreboard/g1?quiet=1")!

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

@Suite("Visible scoreboard monitor page")
@MainActor
struct ScoreboardMonitorPageTests {
  private func webView(in view: UIView) -> WKWebView? {
    if let web = view as? WKWebView { return web }
    return view.subviews.lazy.compactMap { self.webView(in: $0) }.first
  }

  @Test func selectedGameFollowsItsAssignedSourceWithoutSwitchingOutput() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    let pages = directory.appending(path: "scoreboard")
    try FileManager.default.createDirectory(at: pages, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let account = TeamStationAccount(serverURL: directory, deviceName: "Director", keychain: .inMemory())
    var launch = LaunchConfiguration()
    launch.isUITest = true
    launch.sourceProfile = .synthetic4
    launch.syntheticCount = 5
    launch.syntheticWidth = 320
    launch.syntheticHeight = 180
    let model = AppEnvironment(launch: launch, account: account)
    let original = model.persistedConfig
    defer { ConfigStore().save(original) }
    var config = original
    config.streamDestination = .event
    config.eventControlEnabled = false
    config.useSimulatedCameras = true
    model.update(config: config)
    model.clearCameraMemory()
    func command(_ path: String) -> Bool {
      model.handle(url: URL(string: "tsdirector://test/" + path)!)
    }
    #expect(command("configure?sourceProfile=synthetic4&sourceCount=5"))
    for _ in 0 ..< 100 where model.selections.count != 5 {
      try await Task.sleep(for: .milliseconds(50))
    }
    #expect(model.monitorURL == nil && model.cameraListRows.count == 5)
    let cameras = model.selections.map(\.id)
    let board = ScoreboardMonitorPreference.id
    for camera in cameras.prefix(4) { model.setEnabled(true, for: camera) }
    func choose(_ game: String) async throws {
      try Data("<html>Scoreboard</html>".utf8).write(to: pages.appending(path: game))
      let event = TeamStationEvent(gameId: game, startAt: Date(), venue: nil, homeTeamName: "Home",
                                   awayTeamName: "Visitors", homeLogoURL: nil, awayLogoURL: nil, liveState: "idle")
      #expect(await account.choose(event: event, claim: false))
    }
    try await choose("first.html")
    #expect(model.cameraListRows.last?.id == board)
    #expect(model.monitorURL(at: 4)?.lastPathComponent == "first.html")
    let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let window = UIWindow(windowScene: scene)
    let host = UIHostingController(rootView: AnyView(DirectorGridView().environment(model)))
    window.rootViewController = host
    window.isHidden = false
    defer { window.isHidden = true; window.rootViewController = nil }
    host.view.layoutIfNeeded()
    #expect(webView(in: host.view) != nil)
    host.rootView = AnyView(SourceSelectionView().environment(model))
    host.view.layoutIfNeeded()
    for _ in 0 ..< 100 where model.router.activePipelines.count != 4 {
      try await Task.sleep(for: .milliseconds(50))
    }
    model.selectProgram(sourceIndex: 0)
    // The scoreboard is the sixth row, after the five discovered cameras.
    #expect(command("assign-source?index=6&source=1"))
    #expect(model.monitorURL(at: 0) != nil && model.router.currentProgramSource == 4)
    model.selectProgram(sourceIndex: 0)
    model.cutSourceLive(sourceIndex: 0)
    model.startInstantReplay(sourceIndex: 0, seconds: 5, rate: 1)
    #expect(model.router.currentProgramSource == 4)
    #expect(command("enable-source?index=6&on=0"))
    #expect(model.monitorURL(at: 0) == nil)
    #expect(command("enable-source?index=6&on=1"))
    #expect(model.monitorURL(at: 0) != nil)
    let fifth = try #require(cameras.last)
    model.setEnabled(true, for: fifth)
    #expect((0 ..< 5).allSatisfy { model.monitorURL(at: $0) == nil })
    model.setEnabled(false, for: fifth)
    try await choose("second.html")
    #expect(model.monitorURL(at: 0)?.lastPathComponent == "second.html")
    config.streamDestination = .url
    model.update(config: config)
    #expect(model.monitorURL == nil && model.cameraListRows.count == 5)
    model.assignSource(slot: 1, to: cameras[0])
    account.forgetChosenEvent()
    config.streamDestination = .event
    model.update(config: config)
    #expect(model.monitorURL == nil)
    await model.shutdown()
  }

  @Test func fitsTheBoardAtTheTopAndClosesItsPageOnRemoval() async throws {
    let html = """
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <body style="margin:0"><div data-scoreboard="board" data-drawn="true" style="height:90px">
      <div id="team" style="width:700px">Visitors</div></div></body>
      """
    let url = try #require(URL(string: "data:text/html;base64," + Data(html.utf8).base64EncodedString()))
    let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 350, height: 200)
    let host = UIHostingController(rootView: ScoreboardMonitorPage(url: url))
    window.rootViewController = host
    window.isHidden = false
    defer { window.isHidden = true; window.rootViewController = nil }
    host.view.layoutIfNeeded()
    let web = try #require(webView(in: host.view))
    #expect(!web.isUserInteractionEnabled)
    #expect(web.configuration.mediaTypesRequiringUserActionForPlayback == .all)
    let fit = """
      (() => {
        const b = document.querySelector('[data-scoreboard=board]')
        if (!b || !b.style.transform) return false
        const r = b.getBoundingClientRect()
        return r.top === 0 && Math.abs(r.width-document.documentElement.clientWidth)<1 &&
          r.height < window.innerHeight && r.height > 0
      })()
      """
    func fitted() async -> Bool {
      for _ in 0 ..< 120 {
        if (try? await web.evaluateJavaScript(fit)) as? Bool == true { return true }
        try? await Task.sleep(for: .milliseconds(50))
      }
      return false
    }
    #expect(await fitted())
    _ = try await web.evaluateJavaScript("document.getElementById('team').style.width = '1100px'")
    #expect(await fitted())
    let coordinator = try #require(web.navigationDelegate as? ScoreboardMonitorPage.Coordinator)
    func response(_ status: Int) throws -> HTTPURLResponse {
      try #require(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil))
    }
    // A deploy's 502 or 503 is retried like a lost connection; the board itself, and a frame's
    // error, are not.
    #expect(ScoreboardMonitorPage.Coordinator.isErrorPage(try response(503), mainFrame: true))
    #expect(ScoreboardMonitorPage.Coordinator.isErrorPage(try response(404), mainFrame: true))
    #expect(!ScoreboardMonitorPage.Coordinator.isErrorPage(try response(200), mainFrame: true))
    #expect(!ScoreboardMonitorPage.Coordinator.isErrorPage(try response(503), mainFrame: false))
    let failure = URLError(.networkConnectionLost)
    coordinator.webView(web, didFailProvisionalNavigation: nil, withError: failure)
    let first = try #require(coordinator.retry)
    coordinator.webView(web, didFail: nil, withError: failure)
    #expect(first.isCancelled)
    coordinator.webViewWebContentProcessDidTerminate(web)
    await coordinator.retry?.value
    #expect(await fitted())
    coordinator.webViewWebContentProcessDidTerminate(web)
    let pending = try #require(coordinator.retry)
    ScoreboardMonitorPage.dismantleUIView(web, coordinator: coordinator)
    #expect(pending.isCancelled && web.navigationDelegate == nil)
  }
}
