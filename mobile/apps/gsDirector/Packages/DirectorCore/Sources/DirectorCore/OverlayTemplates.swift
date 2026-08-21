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
  /// Live Output never collapses. Off-live (scrub or Instant Replay) shrinks live-only overlays
  /// to zero size so attached children move with the collapsed parent.
  public static func shouldCollapse(showInRewind: Bool, programIsOffLive: Bool) -> Bool {
    programIsOffLive && !showInRewind
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
