import CoreGraphics
import DirectorCore
import DirectorUI
import Foundation
import Testing

@Suite("Source layout")
struct SourceLayoutTests {
  @Test("Default order is Source 1 through 5 in visual slots 0 through 4")
  func defaultOrder() {
    #expect(SourceLayout.default.order == [0, 1, 2, 3, 4])
    #expect(SourceLayout.default.displayOrder == "1,2,3,4,5")
  }

  @Test("Sanitizing drops duplicates and out-of-range values then fills the rest")
  func sanitize() {
    #expect(SourceLayout.sanitized([4, 4, 9, 0]) == [4, 0, 1, 2, 3])
    #expect(SourceLayout.sanitized([]) == [0, 1, 2, 3, 4])
    #expect(SourceLayout(order: [2, 0, 1, 3, 4]).order == [2, 0, 1, 3, 4])
  }

  @Test("Moving a source into an occupied slot swaps them")
  func swapOnce() {
    var layout = SourceLayout.default
    layout.moveSource(0, toSlot: 2)
    #expect(layout.order == [2, 1, 0, 3, 4])
    #expect(layout.slot(forSource: 0) == 2)
    #expect(layout.sourceIndex(atSlot: 0) == 2)
  }

  @Test("Dragging across several slots swaps with each one in turn")
  func swapThroughSeveral() {
    var layout = SourceLayout.default
    layout.moveSource(0, toSlot: 1)
    layout.moveSource(0, toSlot: 4)
    layout.moveSource(0, toSlot: 2)
    #expect(layout.order == [1, 4, 0, 3, 2])
    #expect(layout.displayOrder == "2,5,1,4,3")
  }

  @Test("Moving a source onto its own slot is a no-op")
  func swapSelf() {
    var layout = SourceLayout.default
    layout.moveSource(3, toSlot: 3)
    #expect(layout == .default)
  }

  @Test("Layout JSON round-trips and a missing order decodes as default")
  func roundTrip() throws {
    let layout = SourceLayout(order: [4, 3, 2, 1, 0])
    let data = try JSONEncoder().encode(layout)
    let decoded = try JSONDecoder().decode(SourceLayout.self, from: data)
    #expect(decoded == layout)

    let empty = try JSONDecoder().decode(SourceLayout.self, from: Data(#"{}"#.utf8))
    #expect(empty == .default)
  }

  @Test("Store remembers the order against a source number, not a camera")
  func storeRoundTrip() {
    let defaults = UserDefaults(suiteName: "co.gamestation.director.tests.sourceLayout")!
    defaults.removePersistentDomain(forName: "co.gamestation.director.tests.sourceLayout")
    let store = SourceLayoutStore(store: ConfigStore(defaults: defaults))
    #expect(store.load() == .default)
    store.save(SourceLayout(order: [2, 0, 1, 3, 4]))
    #expect(store.load().order == [2, 0, 1, 3, 4])
    store.clear()
    #expect(store.load() == .default)
  }
}

@Suite("Source grid geometry")
struct SourceGridGeometryTests {
  @Test("Five source slots sit around the merged Output cell")
  func slotFrames() {
    let geometry = SourceGridGeometry(size: CGSize(width: 316, height: 316), spacing: 8)
    #expect(abs(geometry.tileWidth - 100) < 0.01)
    #expect(abs(geometry.tileHeight - 100) < 0.01)
    #expect(abs(geometry.programFrame.width - 208) < 0.01)
    #expect(abs(geometry.programFrame.height - 208) < 0.01)
    #expect(abs(geometry.slotFrames[0].minX - 216) < 0.01)
    #expect(abs(geometry.slotFrames[0].minY - 0) < 0.01)
    #expect(abs(geometry.slotFrames[1].minY - 108) < 0.01)
    #expect(abs(geometry.slotFrames[2].minX - 0) < 0.01)
    #expect(abs(geometry.slotFrames[2].minY - 216) < 0.01)
    #expect(abs(geometry.slotFrames[3].minX - 108) < 0.01)
    #expect(abs(geometry.slotFrames[4].minX - 216) < 0.01)
  }

  @Test("Hit-testing returns the source slot under the finger and ignores Output")
  func hitTest() {
    let geometry = SourceGridGeometry(size: CGSize(width: 316, height: 316), spacing: 8)
    #expect(geometry.slot(containing: CGPoint(x: 100, y: 100)) == nil)
    #expect(geometry.slot(containing: CGPoint(x: 266, y: 50)) == 0)
    #expect(geometry.slot(containing: CGPoint(x: 266, y: 158)) == 1)
    #expect(geometry.slot(containing: CGPoint(x: 50, y: 258)) == 2)
    #expect(geometry.slot(containing: CGPoint(x: 158, y: 258)) == 3)
    #expect(geometry.slot(containing: CGPoint(x: 266, y: 258)) == 4)
  }
}
