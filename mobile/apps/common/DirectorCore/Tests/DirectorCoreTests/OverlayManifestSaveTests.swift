import CoreGraphics
import Foundation
import Testing
@testable import DirectorCore

private func temporaryRoot() throws -> URL {
  let root = FileManager.default.temporaryDirectory
    .appendingPathComponent("DirectorCoreTests-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  return root
}

private func manifest(named name: String, id: UUID = UUID()) -> OverlayManifest {
  OverlayManifest(templates: [ OverlayTemplate(id: id, name: name) ], activeTemplateID: id)
}

private final class Gate: @unchecked Sendable {
  let started = DispatchSemaphore(value: 0)
  let proceed = DispatchSemaphore(value: 0)
  private let lock = NSLock()
  private var armed = true

  /// Holds the first write until `proceed` is signalled; later writes pass straight through.
  func hold() {
    lock.lock()
    let first = armed
    armed = false
    lock.unlock()
    guard first else { return }
    started.signal()
    proceed.wait()
  }
}

@Suite("Overlay manifest saves")
struct OverlayManifestSaveTests {
  @Test("Saves queued behind a write in progress collapse into one write of the newest")
  func coalescesQueuedSaves() throws {
    let root = try temporaryRoot()
    let store = OverlayStore(root: root)
    let writer = OverlayManifestWriter.writer(for: root)
    let gate = Gate()
    writer.beforeWrite = { gate.hold() }

    store.save(manifest(named: "first"))
    #expect(gate.started.wait(timeout: .now() + 5) == .success)
    // "first" is being written now. These arrive while it is in flight.
    store.save(manifest(named: "second"))
    store.save(manifest(named: "third"))
    let id = UUID()
    store.save(manifest(named: "fourth", id: id))
    gate.proceed.signal()
    store.flush()

    // One write for the save in flight, one for everything that queued behind it.
    #expect(writer.writes == 2)
    let loaded = store.loadManifest()
    #expect(loaded.templates.map(\.name) == [ "fourth" ])
    #expect(loaded.activeTemplateID == id)
  }

  @Test("A save arriving during a write is written after it, not lost")
  func laterSaveSurvivesInFlightWrite() throws {
    let root = try temporaryRoot()
    let store = OverlayStore(root: root)
    let writer = OverlayManifestWriter.writer(for: root)
    let gate = Gate()
    writer.beforeWrite = { gate.hold() }

    store.save(manifest(named: "in flight"))
    #expect(gate.started.wait(timeout: .now() + 5) == .success)
    store.save(manifest(named: "later"))
    gate.proceed.signal()
    #expect(store.loadManifest().templates.map(\.name) == [ "later" ])
    #expect(writer.writes == 2)
  }

  @Test("Saving an unchanged manifest writes nothing")
  func unchangedSaveIsSkipped() throws {
    let root = try temporaryRoot()
    let store = OverlayStore(root: root)
    let writer = OverlayManifestWriter.writer(for: root)
    let saved = manifest(named: "same")
    store.save(saved)
    store.flush()
    #expect(writer.writes == 1)
    for _ in 0..<5 { store.save(saved) }
    store.flush()
    #expect(writer.writes == 1)

    // Nor does saving straight back what was just read from disk.
    let reread = OverlayStore(root: root)
    reread.save(reread.loadManifest())
    reread.flush()
    #expect(writer.writes == 1)

    var changed = saved
    changed.templates[0].name = "changed"
    store.save(changed)
    store.flush()
    #expect(writer.writes == 2)
  }

  @Test("A save returns before its write runs, and the write keeps the file whole")
  func saveDoesNotBlockCaller() throws {
    let root = try temporaryRoot()
    let store = OverlayStore(root: root)
    let writer = OverlayManifestWriter.writer(for: root)
    let gate = Gate()
    writer.beforeWrite = { gate.hold() }

    store.save(manifest(named: "queued"))
    #expect(gate.started.wait(timeout: .now() + 5) == .success)
    // The caller is back while the write is still held.
    #expect(writer.writes == 0)
    #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("overlays.json").path))
    gate.proceed.signal()
    store.flush()
    let data = try Data(contentsOf: root.appendingPathComponent("overlays.json"))
    let decoded = try JSONDecoder().decode(OverlayManifest.self, from: data)
    #expect(decoded.templates.map(\.name) == [ "queued" ])
  }
}

@Suite("Web overlay heartbeat")
struct WebOverlayHeartbeatTests {
  private let canvas = CGSize(width: 1920, height: 1080)

  private func laidOut(native: CGSize) -> ProgramOverlay {
    let fresh = ProgramOverlay(
      kind: .web,
      url: "https://example.com",
      originX: 0.25,
      originY: 0.25,
      width: 0.5,
      height: 0.5,
      placement: .centerQuarter
    )
    let first = OverlayLayout.fitWebSnapshot(
      fresh, native: native, canvas: canvas, pending: nil, now: Date()
    )
    #expect(first.applied)
    return first.overlay
  }

  @Test("A snapshot at the saved page size is applied but changes nothing")
  func unchangedSizeIsNoChange() {
    let native = CGSize(width: 800, height: 450)
    let overlay = laidOut(native: native)
    for _ in 0..<3 {
      let fit = OverlayLayout.fitWebSnapshot(
        overlay, native: native, canvas: canvas, pending: nil, now: Date()
      )
      // Applied, so the new bitmap is shown; equal, so there is nothing to lay out or save.
      #expect(fit.applied)
      #expect(fit.pending == nil)
      #expect(fit.overlay == overlay)
    }
  }

  @Test("A snapshot reported in pixels at 2x or 3x changes nothing")
  func displayScaleArtifactIsNoChange() {
    let native = CGSize(width: 800, height: 450)
    let overlay = laidOut(native: native)
    for factor in [ 2.0, 3.0 ] {
      let fit = OverlayLayout.fitWebSnapshot(
        overlay,
        native: CGSize(width: native.width * factor, height: native.height * factor),
        canvas: canvas,
        pending: nil,
        now: Date()
      )
      #expect(fit.applied)
      #expect(fit.overlay == overlay)
    }
  }

  @Test("A page that really changed size, once settled, does change the overlay")
  func settledResizeChanges() {
    let overlay = laidOut(native: CGSize(width: 800, height: 450))
    let bigger = CGSize(width: 1000, height: 450)
    let start = Date()
    let held = OverlayLayout.fitWebSnapshot(
      overlay, native: bigger, canvas: canvas, pending: nil, now: start
    )
    #expect(!held.applied)
    #expect(held.overlay == overlay)
    let settled = OverlayLayout.fitWebSnapshot(
      overlay,
      native: bigger,
      canvas: canvas,
      pending: held.pending,
      now: start.addingTimeInterval(OverlayLayout.webNativeSettleSeconds + 0.1)
    )
    #expect(settled.applied)
    #expect(settled.overlay != overlay)
    #expect(settled.overlay.nativeWidth == 1000)
  }
}
