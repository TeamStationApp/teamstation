import CoreGraphics
import Foundation
import DirectorCore

/// On-screen order of the five source tiles. The value at each slot is a source number, so
/// Source 1 stays in the slot the operator parked it in even when a different camera is mapped
/// onto that source.
public struct SourceLayout: Hashable, Sendable, Codable, Equatable {
  /// Visual slot 0…4 → source index 0…4. Slot 0 is top-right, 1 mid-right, 2–4 the bottom row.
  public var order: [Int]

  public static let `default` = SourceLayout(order: Array(0 ..< SourceIndex.count))

  public init(order: [Int] = Array(0 ..< SourceIndex.count)) {
    self.order = Self.sanitized(order)
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.init(order: try container.decodeIfPresent([Int].self, forKey: .order) ?? [])
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(order, forKey: .order)
  }

  /// Drops duplicates and out-of-range entries, then fills any missing source so the grid always
  /// has exactly the five sources.
  public static func sanitized(_ order: [Int]) -> [Int] {
    var result: [Int] = []
    var used = Set<Int>()
    for value in order where (0 ..< SourceIndex.count).contains(value) && !used.contains(value) {
      result.append(value)
      used.insert(value)
    }
    for value in 0 ..< SourceIndex.count where !used.contains(value) {
      result.append(value)
    }
    return result
  }

  public func sourceIndex(atSlot slot: Int) -> Int {
    guard order.indices.contains(slot) else { return slot }
    return order[slot]
  }

  public func slot(forSource sourceIndex: Int) -> Int {
    order.firstIndex(of: sourceIndex) ?? sourceIndex
  }

  /// Puts `sourceIndex` in `slot` by exchanging with whoever is already there. Dragging across
  /// several tiles is this, once per slot the finger enters.
  public mutating func moveSource(_ sourceIndex: Int, toSlot slot: Int) {
    guard (0 ..< SourceIndex.count).contains(slot) else { return }
    guard (0 ..< SourceIndex.count).contains(sourceIndex) else { return }
    let from = self.slot(forSource: sourceIndex)
    guard from != slot else { return }
    order.swapAt(from, slot)
  }

  /// 1-based source numbers in visual-slot order, for accessibility and dump-state.
  public var displayOrder: String {
    order.map { String($0 + 1) }.joined(separator: ",")
  }

  private enum CodingKeys: String, CodingKey {
    case order
  }
}

/// Frames of the 3×3 director grid. Output occupies the merged top-left 2×2; the five source
/// slots are the remaining cells.
public struct SourceGridGeometry: Equatable, Sendable {
  public var spacing: CGFloat
  public var tileWidth: CGFloat
  public var tileHeight: CGFloat
  public var programFrame: CGRect
  public var slotFrames: [CGRect]

  public init(size: CGSize, spacing: CGFloat = 8) {
    self.spacing = spacing
    let tileWidth = (size.width - spacing * 2) / 3
    let tileHeight = (size.height - spacing * 2) / 3
    self.tileWidth = tileWidth
    self.tileHeight = tileHeight
    let programWidth = tileWidth * 2 + spacing
    let programHeight = tileHeight * 2 + spacing
    self.programFrame = CGRect(x: 0, y: 0, width: programWidth, height: programHeight)
    self.slotFrames = [
      CGRect(x: programWidth + spacing, y: 0, width: tileWidth, height: tileHeight),
      CGRect(x: programWidth + spacing, y: tileHeight + spacing, width: tileWidth, height: tileHeight),
      CGRect(x: 0, y: programHeight + spacing, width: tileWidth, height: tileHeight),
      CGRect(x: tileWidth + spacing, y: programHeight + spacing, width: tileWidth, height: tileHeight),
      CGRect(x: (tileWidth + spacing) * 2, y: programHeight + spacing, width: tileWidth, height: tileHeight)
    ]
  }

  public func slot(containing point: CGPoint) -> Int? {
    slotFrames.enumerated().first { $0.element.contains(point) }?.offset
  }
}

/// `UserDefaults` persistence for the source-tile order. Independent of which camera occupies a
/// source, and of `SourceSelectionStore`.
public struct SourceLayoutStore: Sendable {
  private static let key = "co.gamestation.director.sourceLayout"
  private let store: ConfigStore

  public init(store: ConfigStore = ConfigStore()) {
    self.store = store
  }

  public func load() -> SourceLayout {
    store.codableValue(SourceLayout.self, forKey: Self.key) ?? .default
  }

  public func save(_ layout: SourceLayout) {
    store.setCodableValue(layout, forKey: Self.key)
  }

  public func clear() {
    store.removeValue(forKey: Self.key)
  }
}
