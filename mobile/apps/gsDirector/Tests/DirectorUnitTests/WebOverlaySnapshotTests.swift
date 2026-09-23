import CoreGraphics
import Foundation
import Testing

@testable import DirectorUI

/// Starts a snapshot run, failing the test when the gate refuses one.
private func start(_ gate: inout OverlaySnapshotGate) throws -> Int {
  let run = gate.request()
  return try #require(run)
}

@Suite("Overlay snapshot gate")
struct OverlaySnapshotGateTests {
  @Test func anIdleGateStartsARun() throws {
    var gate = OverlaySnapshotGate()
    let run = try start(&gate)
    #expect(gate.isRunning(run))
    #expect(!gate.isDirty)
  }

  @Test func aRunWithNoChangeOwesNothing() throws {
    var gate = OverlaySnapshotGate()
    let run = try start(&gate)
    #expect(gate.finish(run) == .done)
    #expect(!gate.isRunning(run))
  }

  @Test func aChangeDuringARunGetsExactlyOneMoreSnapshot() throws {
    var gate = OverlaySnapshotGate()
    let first = try start(&gate)
    // The page changes twice while the first snapshot is measured and captured.
    #expect(gate.request() == nil)
    #expect(gate.request() == nil)
    #expect(gate.isDirty)
    #expect(gate.finish(first) == .again)
    // The one more snapshot sees both changes, and owes nothing itself.
    let second = try start(&gate)
    #expect(second != first)
    #expect(gate.finish(second) == .done)
    #expect(gate.request() != nil)
  }

  @Test func aChangeDuringAWedgedRunIsSnapshottedWhenTheWatchdogReleasesIt() throws {
    var gate = OverlaySnapshotGate()
    let wedged = try start(&gate)
    #expect(gate.request() == nil)
    // The watchdog ends the run whose callback never came back.
    #expect(gate.finish(wedged) == .again)
    let next = try start(&gate)
    // The wedged capture returns at last: it cannot end the run that started since.
    #expect(gate.finish(wedged) == .stale)
    #expect(gate.isRunning(next))
    #expect(gate.request() == nil)
    #expect(gate.finish(next) == .again)
  }

  @Test func stoppingForgetsTheRunAndWhatItOwed() throws {
    var gate = OverlaySnapshotGate()
    let run = try start(&gate)
    #expect(gate.request() == nil)
    gate.cancel()
    #expect(!gate.isDirty)
    #expect(gate.finish(run) == .stale)
    let next = try start(&gate)
    #expect(gate.finish(next) == .done)
  }
}

@Suite("Web overlay snapshots")
@MainActor
struct WebOverlaySnapshotTests {
  /// The page's own changes reach `onSnapshot` through its `MutationObserver`,
  /// in well under a second, not at the 5 s heartbeat.
  @Test func aPageChangeIsSnapshottedLongBeforeTheHeartbeat() async throws {
    let controller = WebOverlayController(size: CGSize(width: 640, height: 176))
    var widths: [CGFloat] = []
    controller.onSnapshot = { _, size in widths.append(size.width) }
    let page = """
      <html><body style="margin:0;background:transparent">\
      <div id="b" style="width:100px;height:40px;background:#333"></div>\
      <script>
      setTimeout(function () { document.getElementById('b').style.width = '200px' }, 300);
      setTimeout(function () { document.getElementById('b').style.width = '300px' }, 600);
      </script></body></html>
      """
    let encoded = try #require(page.addingPercentEncoding(withAllowedCharacters: .alphanumerics))
    let started = Date()
    controller.load(urlString: "data:text/html;charset=utf-8,\(encoded)")
    while !widths.contains(300), Date().timeIntervalSince(started) < 4 {
      try await Task.sleep(for: .milliseconds(20))
    }
    let elapsed = Date().timeIntervalSince(started)
    controller.stop()
    #expect(widths.contains(300), "snapshots: \(widths)")
    #expect(elapsed < 3, "the second change took \(elapsed) s")
    #expect(controller.snapshotCount >= 2)
  }
}
