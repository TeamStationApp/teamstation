import Foundation
import DirectorCore
import Testing

@Suite("Overlay store")
struct OverlayStoreTests {
  @Test("A missing file becomes default template")
  func emptyDefault() throws {
    let root = try temporaryRoot()
    let store = OverlayStore(root: root)
    let manifest = store.loadManifest()
    #expect(manifest.templates.count == 1)
    #expect(manifest.templates[0].name == OverlayTemplate.defaultName)
    #expect(manifest.templates[0].overlays.isEmpty)
    #expect(manifest.activeTemplateID == manifest.templates[0].id)
  }

  @Test("A legacy overlay array migrates to default template")
  func migratesLegacyArray() throws {
    let root = try temporaryRoot()
    let overlay = ProgramOverlay(
      kind: .web,
      url: "https://example.com",
      originX: 0.1,
      originY: 0.2,
      width: 0.3,
      height: 0.4,
      placement: .centerQuarter
    )
    let data = try JSONEncoder().encode([overlay])
    try data.write(to: root.appendingPathComponent("overlays.json"))
    let store = OverlayStore(root: root)
    let manifest = store.loadManifest()
    #expect(manifest.templates.count == 1)
    #expect(manifest.templates[0].name == OverlayTemplate.defaultName)
    #expect(manifest.templates[0].overlays.count == 1)
    #expect(manifest.templates[0].overlays[0].url == "https://example.com")
    #expect(manifest.templates[0].overlays[0].showInRewind == false)
  }

  @Test("Duplicating a template copies image files and remaps ids")
  func duplicateCopiesImages() throws {
    let root = try temporaryRoot()
    let store = OverlayStore(root: root)
    let filename = "source.png"
    try store.writeImage(Data([0x89, 0x50, 0x4E, 0x47]), filename: filename)
    let parentID = UUID()
    let childID = UUID()
    let parent = ProgramOverlay(
      id: parentID,
      kind: .web,
      url: "https://example.com",
      originX: 0,
      originY: 0,
      width: 0.2,
      height: 0.2,
      placement: .centerQuarter
    )
    let child = ProgramOverlay(
      id: childID,
      kind: .image,
      imageFilename: filename,
      imageDisplayName: "logo",
      originX: 0.3,
      originY: 0.3,
      width: 0.1,
      height: 0.1,
      anchorID: parentID,
      anchorEdge: .right,
      placement: .centerQuarter
    )
    let sourceID = UUID()
    var manifest = OverlayManifest(
      templates: [
        OverlayTemplate(id: sourceID, name: OverlayTemplate.defaultName, overlays: [parent, child])
      ],
      activeTemplateID: sourceID
    )
    store.save(manifest)

    let copiedParentID = UUID()
    let copiedChildID = UUID()
    var copiedParent = parent
    copiedParent.id = copiedParentID
    var copiedChild = child
    copiedChild.id = copiedChildID
    let newFilename = try store.copyImage(filename: filename)
    copiedChild.imageFilename = newFilename
    copiedChild.anchorID = copiedParentID
    let duplicateID = UUID()
    manifest.templates.append(
      OverlayTemplate(id: duplicateID, name: "Saturday JV", overlays: [copiedParent, copiedChild])
    )
    store.save(manifest)

    let loaded = store.loadManifest()
    #expect(loaded.templates.count == 2)
    let source = loaded.templates.first { $0.id == sourceID }
    let duplicate = loaded.templates.first { $0.id == duplicateID }
    #expect(source?.overlays[0].id == parentID)
    #expect(duplicate?.overlays[0].id == copiedParentID)
    #expect(duplicate?.overlays[1].anchorID == copiedParentID)
    #expect(duplicate?.overlays[1].imageFilename != filename)
    #expect(FileManager.default.fileExists(atPath: store.imageURL(filename: filename).path))
    #expect(
      FileManager.default.fileExists(
        atPath: store.imageURL(filename: duplicate?.overlays[1].imageFilename ?? "").path
      )
    )
  }

  private func temporaryRoot() throws -> URL {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("overlay-store-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }
}
