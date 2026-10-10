import CoreGraphics
import Foundation
import os

/// Named set of Output graphics. One is active at a time.
public struct OverlayTemplate: Sendable, Codable, Identifiable, Hashable {
  public static let defaultName = "default template"

  public var id: UUID
  public var name: String
  public var overlays: [ProgramOverlay]

  public init(
    id: UUID = UUID(),
    name: String,
    overlays: [ProgramOverlay] = []
  ) {
    self.id = id
    self.name = name
    self.overlays = overlays
  }
}

extension OverlayTemplate {
  /// This template with a scoreboard added in the centre quarter, placed as
  /// a page of board size B (`ScoreboardOverlaySource.boardSize`) would be,
  /// or nil when it already has one: a template holds one scoreboard at most.
  ///
  /// It is added already laid out from that page, scale and page size
  /// included. The page's first measure is the empty document before the
  /// board mounts, the whole web view, and an overlay not yet laid out would
  /// be placed from it and keep that scale when the board arrived, about a
  /// twenty-fifth of the programme wide. Knowing its page, the overlay holds
  /// that measure back until it settles, and it never does.
  public func addingScoreboard(canvas: CGSize) -> OverlayTemplate? {
    guard !overlays.contains(where: { $0.kind == .scoreboard }) else { return nil }
    let page = ScoreboardOverlaySource.boardSize
    let rect = OverlayLayout.centerQuarter(native: page, canvas: canvas)
    let placed = OverlayLayout.normalized(rect, canvas: canvas)
    var next = self
    next.overlays.append(ProgramOverlay(
      kind: .scoreboard,
      originX: placed.originX,
      originY: placed.originY,
      width: placed.width,
      height: placed.height,
      scale: OverlayLayout.scaleFittingQuarter(native: page, canvas: canvas),
      nativeWidth: Double(page.width),
      nativeHeight: Double(page.height),
      placement: .centerQuarter,
      hasLaidOut: true
    ))
    return next
  }
}

public struct OverlayManifest: Sendable, Codable, Hashable {
  public var templates: [OverlayTemplate]
  public var activeTemplateID: UUID

  public init(templates: [OverlayTemplate], activeTemplateID: UUID) {
    self.templates = templates
    self.activeTemplateID = activeTemplateID
  }

  public static func emptyDefault() -> OverlayManifest {
    let id = UUID()
    return OverlayManifest(
      templates: [ OverlayTemplate(id: id, name: OverlayTemplate.defaultName) ],
      activeTemplateID: id
    )
  }
}

public enum OverlayVisibility {
  /// Collapse when the current Output mode is one this overlay is not shown in.
  public static func shouldCollapse(
    showInLive: Bool,
    showInRewind: Bool,
    programIsOffLive: Bool
  ) -> Bool {
    programIsOffLive ? !showInRewind : !showInLive
  }
}

public struct OverlayStore: Sendable {
  private let root: URL

  public init(root: URL = DirectorPaths.overlays) {
    self.root = root
  }

  private var manifestURL: URL {
    root.appendingPathComponent("overlays.json")
  }

  private var writer: OverlayManifestWriter {
    OverlayManifestWriter.writer(for: root)
  }

  /// Reads the saved manifest, after any save still queued has landed.
  public func loadManifest() -> OverlayManifest {
    writer.flush()
    guard let data = try? Data(contentsOf: manifestURL) else {
      return OverlayManifest.emptyDefault()
    }
    if let manifest = try? JSONDecoder().decode(OverlayManifest.self, from: data),
       !manifest.templates.isEmpty {
      let loaded = repaired(manifest)
      writer.noteOnDisk(loaded)
      return loaded
    }
    if let overlays = try? JSONDecoder().decode([ProgramOverlay].self, from: data) {
      let id = UUID()
      return OverlayManifest(
        templates: [
          OverlayTemplate(id: id, name: OverlayTemplate.defaultName, overlays: overlays)
        ],
        activeTemplateID: id
      )
    }
    return OverlayManifest.emptyDefault()
  }

  /// Queues `manifest` to be written off the calling thread, and returns at once. A manifest equal
  /// to the last one saved is not written again. See `OverlayManifestWriter`.
  public func save(_ manifest: OverlayManifest) {
    writer.save(repaired(manifest))
  }

  /// Blocks until every save queued so far is on disk.
  public func flush() {
    writer.flush()
  }

  public func imageURL(filename: String) -> URL {
    root.appendingPathComponent(filename)
  }

  public func writeImage(_ data: Data, filename: String) throws {
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    try data.write(to: imageURL(filename: filename), options: .atomic)
  }

  public func copyImage(filename: String) throws -> String {
    let newName = "\(UUID().uuidString).png"
    try FileManager.default.copyItem(
      at: imageURL(filename: filename),
      to: imageURL(filename: newName)
    )
    return newName
  }

  public func removeImage(filename: String) {
    guard !filename.isEmpty else { return }
    try? FileManager.default.removeItem(at: imageURL(filename: filename))
  }

  private func repaired(_ manifest: OverlayManifest) -> OverlayManifest {
    var manifest = manifest
    if manifest.templates.isEmpty {
      return OverlayManifest.emptyDefault()
    }
    if !manifest.templates.contains(where: { $0.id == manifest.activeTemplateID }) {
      manifest.activeTemplateID = manifest.templates[0].id
    }
    return manifest
  }
}

/// Writes overlay manifests on a serial background queue, one writer per overlay directory.
///
/// A save used to create the directory, encode the manifest and write it atomically on the main
/// thread, and a web overlay's 5 s heartbeat saved an unchanged manifest every time: a Time
/// Profiler trace on an iPad caught two of those writes holding the main thread 2.2 s each.
/// Saves now return at once. The newest manifest waiting replaces any older one that has not
/// started writing, so a burst of edits costs one write, and a save that arrives while another is
/// being written is written after it, never dropped. A manifest equal to the last one saved is
/// skipped.
final class OverlayManifestWriter: @unchecked Sendable {
  private static let registryLock = NSLock()
  nonisolated(unsafe) private static var writers: [String: OverlayManifestWriter] = [:]

  static func writer(for root: URL) -> OverlayManifestWriter {
    let key = root.standardizedFileURL.path
    registryLock.lock()
    defer { registryLock.unlock() }
    if let existing = writers[key] { return existing }
    let created = OverlayManifestWriter(root: root)
    writers[key] = created
    return created
  }

  let root: URL
  let queue: DispatchQueue
  private let lock = NSLock()
  /// The newest manifest not yet written.
  private var pending: OverlayManifest?
  private var drainScheduled = false
  /// The last manifest saved (written, or waiting to be) or read from disk.
  private var latest: OverlayManifest?
  private var coalesced = 0
  private var writeCount = 0
  /// Tests only: runs on the writer's queue just before each write.
  var beforeWrite: (@Sendable () -> Void)?

  private init(root: URL) {
    self.root = root
    queue = DispatchQueue(label: "app.teamstation.director.overlayManifest", qos: .utility)
  }

  private var manifestURL: URL {
    root.appendingPathComponent("overlays.json")
  }

  /// Number of manifests actually written so far.
  var writes: Int {
    lock.lock()
    defer { lock.unlock() }
    return writeCount
  }

  /// Records what is already on disk, so saving it straight back is skipped.
  func noteOnDisk(_ manifest: OverlayManifest) {
    lock.lock()
    defer { lock.unlock() }
    if pending == nil { latest = manifest }
  }

  func save(_ manifest: OverlayManifest) {
    lock.lock()
    if manifest == latest {
      lock.unlock()
      MainThreadLog.logger.info(
        "overlay manifest save skipped: unchanged (\(MainThreadLog.threadName, privacy: .public) thread)"
      )
      return
    }
    latest = manifest
    if pending != nil { coalesced += 1 }
    pending = manifest
    let schedule = !drainScheduled
    drainScheduled = true
    lock.unlock()
    MainThreadLog.logger.info(
      "overlay manifest save queued: changed (\(MainThreadLog.threadName, privacy: .public) thread)"
    )
    if schedule {
      queue.async { self.drain() }
    }
  }

  func flush() {
    queue.sync {}
  }

  private func drain() {
    lock.lock()
    let manifest = pending
    let merged = coalesced
    pending = nil
    coalesced = 0
    drainScheduled = false
    let hook = beforeWrite
    lock.unlock()
    guard let manifest else { return }
    hook?()
    let started = DispatchTime.now().uptimeNanoseconds
    var written = 0
    do {
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      let data = try JSONEncoder().encode(manifest)
      try data.write(to: manifestURL, options: .atomic)
      written = data.count
    } catch {
      // Forget it was saved, so the next save of the same manifest tries again.
      lock.lock()
      if latest == manifest { latest = nil }
      lock.unlock()
      MainThreadLog.logger.error(
        "overlay manifest write failed: \(error.localizedDescription, privacy: .public)"
      )
      return
    }
    lock.lock()
    writeCount += 1
    lock.unlock()
    let elapsed = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
    MainThreadLog.logger.info(
      "overlay manifest written: \(written, privacy: .public) bytes in \(elapsed, format: .fixed(precision: 1), privacy: .public) ms on \(MainThreadLog.threadName, privacy: .public) thread, \(merged, privacy: .public) older save(s) merged"
    )
  }
}
