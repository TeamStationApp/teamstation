import CoreGraphics
import Foundation

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

  public func loadManifest() -> OverlayManifest {
    guard let data = try? Data(contentsOf: manifestURL) else {
      return OverlayManifest.emptyDefault()
    }
    if let manifest = try? JSONDecoder().decode(OverlayManifest.self, from: data),
       !manifest.templates.isEmpty {
      return repaired(manifest)
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

  public func save(_ manifest: OverlayManifest) {
    try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    guard let data = try? JSONEncoder().encode(repaired(manifest)) else { return }
    try? data.write(to: manifestURL, options: .atomic)
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
